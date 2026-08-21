/**
 * Diário de eventos particionado pela sessão de projeto ativa.
 *
 * O cursor seguro é `(middlewareInstanceId, projectSessionId, seq)`. Trocar a
 * sessão substitui o objeto-partição inteiro; eventos e sequências do projeto
 * anterior deixam de ser alcançáveis sem depender de limpar o Blueprint.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type EventSequence = bigint;
export type EventSequenceInput = string | number | bigint;

/**
 * Resultado da APLICAÇÃO do evento no runtime. É metadado de transporte —
 * viaja no envelope, nunca dentro do evento canônico de domínio. Declarado
 * aqui (e não em `runtime/`) porque as bordas GraphQL/gRPC só podem importar
 * `transport/` (regra R12).
 */
export interface EnvelopeProjection {
  readonly event: string;
  readonly status: "projected" | "skipped" | "deferred";
  readonly reason?: string;
}

/**
 * Trilha do histórico que viaja NO ENVELOPE, não dentro do evento canônico.
 *
 * Mesma razão de `projection`: é metadado de transporte. O evento de domínio
 * não sabe que existe um histórico, e um cliente precisa saber se o que
 * chegou foi uma edição, um desfazer ou um refazer para não duplicar estado.
 */
export interface EnvelopeHistory {
  readonly actor: string;
  readonly action: string;
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly transactionId?: string;
  readonly historyEntryId?: string;
}

export interface EventEnvelope {
  readonly seq: EventSequence;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: EventSequence;
  readonly kind: string;
  readonly payload: unknown;
  /** Ausente em eventos de controle e quando não há adapter de runtime. */
  readonly projection?: EnvelopeProjection;
  /** Ausente em eventos de controle (troca de sessão). */
  readonly history?: EnvelopeHistory;
}

export type ResyncReason =
  | "instance_changed"
  | "project_session_changed"
  | "journal_gap"
  | "cursor_ahead"
  | "invalid_cursor";

export interface JournalPosition {
  readonly middlewareInstanceId: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: EventSequence;
  readonly firstAvailableSeq: EventSequence;
  readonly lastEventSeq: EventSequence;
}

export interface JournalReadResult extends JournalPosition {
  readonly resyncRequired: boolean;
  readonly resyncReason?: ResyncReason;
  readonly events: readonly EventEnvelope[];
}

interface JournalPartition {
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly ring: EventEnvelope[];
  nextSeq: EventSequence;
  commandSequence: EventSequence;
}

const UINT64_MAX = (1n << 64n) - 1n;

export function parseEventSequence(value: unknown): EventSequence | undefined {
  if (typeof value === "bigint") {
    return value >= 0n && value <= UINT64_MAX ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed <= UINT64_MAX ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Eventos: `event` (EventEnvelope) a cada append da partição ativa. */
export class EventJournal extends EventEmitter {
  private partition: JournalPartition;

  constructor(
    /** Tamanho do anel — é a janela de catch-up antes de exigir resync. */
    readonly capacity = 512,
    readonly middlewareInstanceId: string = randomUUID(),
  ) {
    super();
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`EventJournal capacity must be a positive integer (got ${capacity})`);
    }
    if (typeof middlewareInstanceId !== "string" || middlewareInstanceId.trim().length === 0) {
      throw new TypeError("middlewareInstanceId must be a non-empty string");
    }
    this.partition = this.newPartition(`no-project-${randomUUID()}`, "", 0n);
  }

  get lastSeq(): EventSequence {
    return this.partition.nextSeq - 1n;
  }

  get firstAvailableSeq(): EventSequence {
    return this.partition.ring[0]?.seq ?? this.partition.nextSeq;
  }

  get position(): JournalPosition {
    return Object.freeze({
      middlewareInstanceId: this.middlewareInstanceId,
      projectSessionId: this.partition.projectSessionId,
      projectId: this.partition.projectId,
      commandSequence: this.partition.commandSequence,
      firstAvailableSeq: this.firstAvailableSeq,
      lastEventSeq: this.lastSeq,
    });
  }

  /** Inicia uma nova partição; nenhum evento da anterior é copiado. */
  activateSession(
    projectSessionId: string,
    projectId: string,
    commandSequence: EventSequenceInput = 0n,
  ): JournalPosition {
    const sequence = parseEventSequence(commandSequence);
    if (!projectSessionId || !projectId || sequence === undefined) {
      throw new TypeError("activateSession requires valid project/session ids and commandSequence");
    }
    this.partition = this.newPartition(projectSessionId, projectId, sequence);
    this.emit("partitionChanged", this.position);
    return this.position;
  }

  /** Partição explícita para o estado sem projeto após close. */
  deactivateSession(): JournalPosition {
    this.partition = this.newPartition(`no-project-${randomUUID()}`, "", 0n);
    this.emit("partitionChanged", this.position);
    return this.position;
  }

  append(kind: string, payload: unknown, projection?: EnvelopeProjection): EventEnvelope {
    return this.appendForSession(
      this.partition.projectSessionId,
      this.partition.projectId,
      inferCommandSequence(payload) ?? this.partition.commandSequence,
      kind,
      payload,
      projection,
    )!;
  }

  /**
   * Anexa apenas se o produtor ainda pertence à partição ativa. Um callback
   * tardio de A após ativar B é descartado antes de alcançar qualquer cliente.
   */
  appendForSession(
    projectSessionId: string,
    projectId: string,
    commandSequence: EventSequenceInput,
    kind: string,
    payload: unknown,
    projection?: EnvelopeProjection,
    history?: EnvelopeHistory,
  ): EventEnvelope | undefined {
    const sequence = parseEventSequence(commandSequence);
    if (
      projectSessionId !== this.partition.projectSessionId ||
      projectId !== this.partition.projectId ||
      sequence === undefined
    ) {
      return undefined;
    }
    if (this.partition.nextSeq > UINT64_MAX) {
      throw new RangeError("EventJournal exhausted the uint64 sequence space");
    }
    if (sequence > this.partition.commandSequence) this.partition.commandSequence = sequence;
    const envelope: EventEnvelope = Object.freeze({
      seq: this.partition.nextSeq++,
      projectSessionId,
      projectId,
      commandSequence: sequence,
      kind,
      payload,
      // congela a CÓPIA: broadcast JSON-RPC e stream gRPC compartilham a mesma
      // referência do ring — o freeze do envelope é raso.
      ...(projection ? { projection: Object.freeze({ ...projection }) } : {}),
      ...(history ? { history: Object.freeze({ ...history }) } : {}),
    });
    this.partition.ring.push(envelope);
    if (this.partition.ring.length > this.capacity) this.partition.ring.shift();
    this.emit("event", envelope);
    return envelope;
  }

  since(afterSeq: EventSequenceInput): readonly EventEnvelope[] {
    const seq = parseEventSequence(afterSeq);
    if (seq === undefined) return [];
    return this.partition.ring.filter((event) => event.seq > seq);
  }

  readSince(
    middlewareInstanceId: unknown,
    projectSessionId: unknown,
    afterSeq?: unknown,
  ): JournalReadResult {
    const position = this.position;
    const seq = parseEventSequence(afterSeq);
    if (
      typeof middlewareInstanceId !== "string" ||
      middlewareInstanceId.length === 0 ||
      typeof projectSessionId !== "string" ||
      projectSessionId.length === 0 ||
      seq === undefined
    ) {
      return this.resync(position, "invalid_cursor");
    }
    if (middlewareInstanceId !== this.middlewareInstanceId) {
      return this.resync(position, "instance_changed");
    }
    if (projectSessionId !== this.partition.projectSessionId) {
      return this.resync(position, "project_session_changed");
    }
    if (seq > this.lastSeq) return this.resync(position, "cursor_ahead");
    if (seq + 1n < this.firstAvailableSeq) return this.resync(position, "journal_gap");
    return Object.freeze({
      ...position,
      resyncRequired: false,
      events: Object.freeze([
        ...this.partition.ring.filter((event) => event.seq > seq),
      ]),
    });
  }

  canResumeFrom(afterSeq: EventSequenceInput): boolean {
    return !this.readSince(
      this.middlewareInstanceId,
      this.partition.projectSessionId,
      afterSeq,
    ).resyncRequired;
  }

  private newPartition(
    projectSessionId: string,
    projectId: string,
    commandSequence: EventSequence,
  ): JournalPartition {
    if (commandSequence >= UINT64_MAX) {
      throw new RangeError("commandSequence leaves no space for journal events");
    }
    return {
      projectSessionId,
      projectId,
      commandSequence,
      nextSeq: commandSequence + 1n,
      ring: [],
    };
  }

  private resync(position: JournalPosition, reason: ResyncReason): JournalReadResult {
    return Object.freeze({
      ...position,
      resyncRequired: true,
      resyncReason: reason,
      events: Object.freeze([]),
    });
  }
}

function inferCommandSequence(payload: unknown): EventSequence | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  return parseEventSequence((payload as Record<string, unknown>)["commandSequence"]);
}
