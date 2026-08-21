/**
 * Liga a telemetria do host gráfico ao `EventJournal` (ADR-023).
 *
 * É a única peça que conhece as duas pontas: recebe as amostras do plano de
 * controle e aplica a política pura de `FrameTelemetry.ts` para decidir quais
 * viram evento. Fica em um módulo próprio para que a política continue sem
 * dependência nenhuma — é ela que o `ipc/` importa, e uma política que
 * arrastasse o diário junto contaminaria a borda.
 */

import type { EngineSession } from "../ipc/EnginePipeServer.js";
import type { EventEnvelope, EventJournal } from "../transport/EventJournal.js";
import {
  decideTelemetryJournaling,
  TELEMETRY_MIN_INTERVAL_MS,
  type FrameTelemetryReason,
  type FrameTelemetrySample,
  type JournaledTelemetry,
} from "./FrameTelemetry.js";

/** Kind do evento no diário; a notificação do fio chama-se `frame/telemetry`. */
export const FRAME_TELEMETRY_EVENT_KIND = "runtime/frameTelemetry";

export interface FrameTelemetryEventPayload extends FrameTelemetrySample {
  /** Sessão da engine que desenhou; muda quando o host reinicia. */
  readonly engineSessionId: string;
  /** Por que ESTA amostra entrou no diário (a política não fica implícita). */
  readonly reason: FrameTelemetryReason;
}

/** Emissor mínimo — o binder não precisa do servidor de pipe inteiro. */
export interface FrameTelemetrySource {
  on(
    event: "frameTelemetry",
    listener: (session: EngineSession, sample: FrameTelemetrySample) => void,
  ): unknown;
  off?(
    event: "frameTelemetry",
    listener: (session: EngineSession, sample: FrameTelemetrySample) => void,
  ): unknown;
}

export interface FrameTelemetryJournalOptions {
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  /** Chamado com o envelope publicado; usado por testes e por logs. */
  readonly onJournaled?: (envelope: EventEnvelope, payload: FrameTelemetryEventPayload) => void;
}

/**
 * @returns função que desliga a escuta (simétrica ao restante da composição).
 */
export function bindFrameTelemetryJournal(
  source: FrameTelemetrySource,
  journal: EventJournal,
  options: FrameTelemetryJournalOptions = {},
): () => void {
  const minIntervalMs = options.minIntervalMs ?? TELEMETRY_MIN_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let lastEngineSessionId: string | undefined;
  let lastJournaled: JournaledTelemetry | undefined;

  const listener = (session: EngineSession, sample: FrameTelemetrySample): void => {
    // Host novo é histórico novo: comparar a primeira janela de um host com a
    // última do anterior produziria "nada mudou" logo depois de um reinício,
    // que é exatamente o momento em que alguém está olhando.
    if (session.sessionId !== lastEngineSessionId) {
      lastEngineSessionId = session.sessionId;
      lastJournaled = undefined;
    }

    const atMs = now();
    const decision = decideTelemetryJournaling(lastJournaled, sample, atMs, minIntervalMs);
    if (!decision.journal) return;

    const payload: FrameTelemetryEventPayload = Object.freeze({
      ...sample,
      engineSessionId: session.sessionId,
      reason: decision.reason!,
    });
    const envelope = journal.append(FRAME_TELEMETRY_EVENT_KIND, payload);
    // Guarda a amostra PUBLICADA, não a última recebida: é o que faz uma
    // mudança represada pelo teto de taxa sair inteira quando a janela abre,
    // em vez de ser esquecida por já ter "passado".
    lastJournaled = { sample, atMs };
    options.onJournaled?.(envelope, payload);
  };

  source.on("frameTelemetry", listener);
  return () => {
    source.off?.("frameTelemetry", listener);
  };
}
