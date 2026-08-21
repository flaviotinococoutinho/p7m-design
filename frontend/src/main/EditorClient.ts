/**
 * Cliente transport-neutral do editor. O cursor de eventos é composto por
 * instância do middleware + sessão de projeto + sequência decimal. Uma troca
 * de projeto invalida callbacks em voo e todo resync substitui um snapshot
 * completo antes de reabrir stream/polling.
 */

import { randomUUID } from "node:crypto";
import {
  TransportRouter,
  classifyTransportError,
  type ClassifiedError,
  type TransportName,
  type TransportRouterOptions,
} from "../core/transportRouter.js";
import { createLogger, type Logger } from "../core/logging.js";
import {
  GraphQlAuthenticationError,
  GraphQlDomainError,
  GraphQlTransport,
} from "./transport/GraphQlTransport.js";
import {
  GrpcTransport,
  type EventProjection,
  type HotCursor,
  type HotEvent,
  type HotJournalStatus,
} from "./transport/GrpcTransport.js";
import type { ResolvedExperienceLike } from "../core/experienceGate.js";
import {
  FRAME_TELEMETRY_EVENT_KIND,
  type RuntimeTelemetry,
} from "../core/runtimeTelemetry.js";

export interface BlueprintEventPayload {
  readonly kind: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
  readonly [key: string]: unknown;
}

export interface DispatchOutcome {
  readonly event: BlueprintEventPayload;
  readonly projection?: { status: string; reason?: string };
}

/**
 * A projeção viaja como SEGUNDO argumento — é resultado de aplicação no
 * runtime, não parte do evento canônico de domínio.
 */
export type BlueprintEventListener = (
  event: BlueprintEventPayload,
  projection?: EventProjection,
) => void;

export interface ProjectionSnapshot extends HotCursor {
  readonly firstAvailableSeq: string;
  readonly projections: Readonly<Record<string, unknown>>;
  readonly status: ProjectStatus;
}

export interface ProjectStatus {
  readonly active: boolean;
  readonly projectSessionId?: string;
  readonly projectId?: string;
  /** Decimal unix-ms no wire (GraphQL String evita perda de precisão). */
  readonly createdAt?: string;
  readonly commandSequence: string;
  readonly runtimeState: "synchronized" | "deferred" | "failed";
  /** Identidade lógica do conteúdo; volta ao valor anterior no undo. */
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export type HistoryActor = "human" | "agent" | "pipeline";
export type HistoryAction = "apply" | "undo" | "redo";

export interface HistoryEntrySummary {
  readonly id: string;
  readonly label: string;
  readonly actor: HistoryActor;
  readonly timestamp: string;
  readonly barrier: boolean;
  readonly undone: boolean;
}

export interface HistoryStatus {
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel?: string | null;
  readonly redoLabel?: string | null;
  readonly entries: readonly HistoryEntrySummary[];
}

export interface HistoryOperationResult {
  readonly action: HistoryAction;
  readonly historyEntryId: string;
  readonly label: string;
  readonly documentStateId: string;
  readonly historyCursor: string;
}

export interface ProjectOperationSummary {
  readonly applied: number;
  readonly projected: number;
  readonly deferred: number;
  readonly skipped: number;
}

export interface ProjectOperationResult {
  readonly status: ProjectStatus;
  readonly summary: ProjectOperationSummary;
  readonly templateId?: string;
  readonly name?: string;
}

export interface ResynchronizationRecord {
  readonly reason: string;
  readonly atUnixMs: number;
  readonly previousMiddlewareInstanceId?: string;
  readonly previousProjectSessionId?: string;
  readonly middlewareInstanceId: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly lastEventSeq: string;
}

export interface TransportReadiness {
  readonly middlewareActive: boolean;
  readonly graphqlActive: boolean;
  readonly grpcActive: boolean;
  readonly authenticationFailed: boolean;
  readonly graphqlAuthenticationFailed: boolean;
  readonly grpcAuthenticationFailed: boolean;
  readonly graphqlReason?: string;
  readonly grpcReason?: string;
}

export interface TechnicalTransportDiagnostics {
  readonly activeTransport: "gRPC" | "GraphQL fallback";
  readonly switchReason?: string;
  readonly nextProbeAtUnixMs?: number;
  readonly resynchronizationExecuted: boolean;
  readonly resynchronizationCount: number;
  readonly lastResynchronization?: ResynchronizationRecord;
  readonly cursor?: HotCursor & { firstAvailableSeq?: string };
  readonly readiness?: TransportReadiness;
  readonly fatalError?: string;
}

const EXPERIENCE_QUERY = `query ($family: String, $version: String) {
  experience(family: $family, version: $version) {
    family requestedVersion profileVersion displayName capabilities constraints
    decisions { feature enabled source reason }
    liveManifestConsidered
  }
}`;

const SNAPSHOT_QUERY = `query EditorSnapshot {
  snapshot {
    projections middlewareInstanceId projectSessionId projectId commandSequence firstAvailableSeq lastEventSeq
    status { active projectSessionId projectId createdAt commandSequence runtimeState }
  }
}`;

const HEALTH_QUERY = `query EditorHealth {
  health {
    ok engineConnected middlewareInstanceId projectSessionId projectId commandSequence firstAvailableSeq lastEventSeq
  }
}`;

const EVENT_BATCH_QUERY = `query EventBatch($instance: String!, $projectSessionId: String!, $after: String!) {
  eventBatch(
    middlewareInstanceId: $instance
    projectSessionId: $projectSessionId
    afterSeq: $after
  ) {
    middlewareInstanceId projectSessionId projectId commandSequence firstAvailableSeq lastEventSeq
    resyncRequired resyncReason
    events { seq kind projectSessionId projectId commandSequence payload projection { status reason } }
  }
}`;

const PROJECT_STATUS_FIELDS = `
  active projectSessionId projectId createdAt commandSequence runtimeState
  documentStateId historyCursor canUndo canRedo
`;

const HISTORY_STATUS_FIELDS = `
  documentStateId historyCursor canUndo canRedo undoLabel redoLabel
  entries { id label actor timestamp barrier undone }
`;

export interface EditorClientOptions {
  readonly requestTimeoutMs?: number;
  readonly eventPollMs?: number;
  readonly probeTickMs?: number;
  readonly resyncRetryMs?: number;
  readonly authToken?: string;
  readonly grpcEnabled?: boolean;
  readonly router?: TransportRouterOptions;
  readonly log?: Logger;
}

interface EventBatchWire {
  middlewareInstanceId: string;
  projectSessionId: string;
  projectId: string;
  commandSequence: string;
  firstAvailableSeq: string;
  lastEventSeq: string;
  resyncRequired: boolean;
  resyncReason?: string | null;
  events: Array<{
    seq: string;
    kind: string;
    projectSessionId: string;
    projectId: string;
    commandSequence: string;
    payload: unknown;
    projection?: { status: string; reason?: string | null } | null;
  }>;
}

export class EditorClient {
  private readonly router: TransportRouter;
  private readonly log: Logger;
  private readonly grpc: GrpcTransport;
  private readonly graphql: GraphQlTransport;
  private readonly eventListeners = new Set<BlueprintEventListener>();
  private readonly telemetryListeners = new Set<(sample: RuntimeTelemetry) => void>();
  private lastTelemetry: RuntimeTelemetry | undefined;
  private readonly resyncListeners = new Set<(snapshot: ProjectionSnapshot, record: ResynchronizationRecord) => void>();
  private readonly eventPollMs: number;
  private readonly probeTickMs: number;
  private readonly resyncRetryMs: number;
  private readonly grpcEnabled: boolean;

  private sessionId: string | undefined;
  private cursor: (HotCursor & { firstAvailableSeq?: string }) | undefined;
  private projectionState: ProjectionSnapshot | undefined;
  private cancelStream: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private resyncRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private resyncPromise: Promise<void> | undefined;
  private projectOperationQueue: Promise<void> = Promise.resolve();
  private pollInFlight = false;
  /** Invalida streams, polls e callbacks assíncronos abertos para a sessão anterior. */
  private eventGeneration = 0;
  private resynchronizationCount = 0;
  private lastResynchronization: ResynchronizationRecord | undefined;
  private lastReadiness: TransportReadiness | undefined;
  private fatalTransportError: string | undefined;
  private closed = false;

  constructor(pipeName: string, options: EditorClientOptions = {}) {
    this.log = options.log ?? createLogger("editor-client");
    const timeout = options.requestTimeoutMs ?? 10_000;
    this.grpc = new GrpcTransport(pipeName, this.log.child("grpc"), timeout, options.authToken);
    this.graphql = new GraphQlTransport(pipeName, this.log.child("graphql"), timeout, options.authToken);
    this.router = new TransportRouter(options.router);
    this.eventPollMs = options.eventPollMs ?? 500;
    this.probeTickMs = options.probeTickMs ?? 1_000;
    this.resyncRetryMs = options.resyncRetryMs ?? 1_000;
    this.grpcEnabled = options.grpcEnabled ?? process.env["GRIDSMITH_GRPC_ENABLED"] !== "0";
  }

  get isConnected(): boolean {
    return this.sessionId !== undefined && !this.closed;
  }

  /** Único ponto público que expõe qual transport está ativo. */
  get technicalDiagnostics(): TechnicalTransportDiagnostics {
    const snapshot = this.router.snapshot;
    const transition = this.router.history.at(-1);
    return {
      activeTransport: snapshot.active === "grpc" ? "gRPC" : "GraphQL fallback",
      ...(transition ? { switchReason: transition.reason } : {}),
      ...(snapshot.nextProbeAtMs !== undefined ? { nextProbeAtUnixMs: snapshot.nextProbeAtMs } : {}),
      resynchronizationExecuted: this.resynchronizationCount > 0,
      resynchronizationCount: this.resynchronizationCount,
      ...(this.lastResynchronization ? { lastResynchronization: this.lastResynchronization } : {}),
      ...(this.cursor ? { cursor: { ...this.cursor } } : {}),
      ...(this.lastReadiness ? { readiness: this.lastReadiness } : {}),
      ...(this.fatalTransportError ? { fatalError: this.fatalTransportError } : {}),
    };
  }

  get latestProjectionSnapshot(): ProjectionSnapshot | undefined {
    return this.projectionState;
  }

  get activeProjectStatus(): ProjectStatus | undefined {
    return this.projectionState?.status;
  }

  get activeProjectSessionId(): string | undefined {
    return this.projectionState?.status.projectSessionId;
  }

  async probeReadiness(): Promise<TransportReadiness> {
    const [grpcResult, graphqlResult] = await Promise.allSettled([
      this.grpc.health(),
      this.graphql.execute<{ health: { ok: boolean } }>(HEALTH_QUERY),
    ]);
    const grpcError = grpcResult.status === "rejected" ? classifyTransportError(grpcResult.reason) : undefined;
    const graphqlError = graphqlResult.status === "rejected" ? classifyTransportError(graphqlResult.reason) : undefined;
    const grpcAuthenticationFailed = grpcError?.category === "authentication";
    const graphqlAuthenticationFailed = graphqlError?.category === "authentication";
    const readiness: TransportReadiness = {
      middlewareActive:
        grpcResult.status === "fulfilled" ||
        graphqlResult.status === "fulfilled" ||
        grpcAuthenticationFailed || graphqlAuthenticationFailed,
      grpcActive: grpcResult.status === "fulfilled" && grpcResult.value.ok,
      graphqlActive: graphqlResult.status === "fulfilled" && graphqlResult.value.health.ok,
      authenticationFailed: grpcAuthenticationFailed || graphqlAuthenticationFailed,
      grpcAuthenticationFailed,
      graphqlAuthenticationFailed,
      ...(grpcError ? { grpcReason: grpcError.reason } : {}),
      ...(graphqlError ? { graphqlReason: graphqlError.reason } : {}),
    };
    this.lastReadiness = readiness;
    return readiness;
  }

  async connect(): Promise<{ sessionId: string }> {
    if (this.closed) throw new Error("EditorClient is closed");
    if (this.sessionId) return { sessionId: this.sessionId };

    if (!this.grpcEnabled) {
      this.router.onTransportFailure("grpc", Date.now(), availability("disabled by feature flag"));
    } else {
      try {
        const health = await this.grpc.health();
        if (!health.ok) throw Object.assign(new Error("gRPC health returned not ready"), { code: 14 });
        this.log.info("gRPC transport reachable", { engineConnected: health.engineConnected });
      } catch (error) {
        const classified = classifyTransportError(error);
        if (classified.category !== "availability") {
          if (classified.category === "authentication") this.recordFatalTransportError(classified);
          throw this.normalizeError(error);
        }
        this.router.onTransportFailure("grpc", Date.now(), classified);
        this.log.warn("gRPC unavailable at connect; using GraphQL fallback", {
          reason: classified.reason,
        });
      }
    }

    // GraphQL é baseline completo: a conexão só fica pronta após snapshot
    // coerente, mesmo quando o caminho quente gRPC está disponível.
    await this.resynchronize("initial_connect", false);
    this.sessionId = randomUUID();
    this.startEventPump();
    this.startProbeLoop();
    return { sessionId: this.sessionId };
  }

  onBlueprintEvent(listener: BlueprintEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Telemetria do host gráfico. Canal separado dos eventos de Blueprint de
   * propósito: nada aqui muda o documento, e um consumidor que suje o projeto
   * com isto está usando o canal errado.
   */
  onRuntimeTelemetry(listener: (sample: RuntimeTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  /** Última janela reportada pelo host; `undefined` até a primeira chegar. */
  get runtimeTelemetry(): RuntimeTelemetry | undefined {
    return this.lastTelemetry;
  }

  onResynchronized(
    listener: (snapshot: ProjectionSnapshot, record: ResynchronizationRecord) => void,
  ): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  dispatch(kind: string, payload: Record<string, unknown>): Promise<DispatchOutcome> {
    const requestId = randomUUID();
    return this.hotCall(
      async () => (await this.grpc.dispatch(kind, payload, requestId)) as DispatchOutcome,
      async () => {
        const data = await this.graphql.execute<{
          dispatch: { event: BlueprintEventPayload; projection: { status: string } | null };
        }>(
          `mutation ($kind: CommandKind!, $payload: JSON!, $requestId: String!) {
            dispatch(kind: $kind, payload: $payload, requestId: $requestId) {
              event projection { status reason detail }
            }
          }`,
          { kind: kind.replace("/", "_"), payload, requestId },
        );
        return {
          event: data.dispatch.event,
          ...(data.dispatch.projection ? { projection: data.dispatch.projection } : {}),
        } as DispatchOutcome;
      },
    );
  }

  query<T = unknown>(projection: string): Promise<T> {
    return this.hotCall(
      async () => (await this.grpc.query(projection)) as T,
      async () => {
        const data = await this.graphql.execute<{ projection: T }>(
          `query ($name: String!) { projection(name: $name) }`,
          { name: projection },
        );
        return data.projection;
      },
    );
  }

  resolveExperience(family?: string, version?: string): Promise<ResolvedExperienceLike> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{ experience: ResolvedExperienceLike }>(
        EXPERIENCE_QUERY,
        { family: family ?? null, version: version ?? null },
      );
      return data.experience;
    });
  }

  async saveDocument(expectedProjectSessionId?: string): Promise<unknown> {
    // Documento e identidade vêm do MESMO snapshot GraphQL. Assim uma troca
    // concorrente nunca faz o conteúdo de B ser escrito no caminho de A.
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{ snapshot: ProjectionSnapshot }>(SNAPSHOT_QUERY);
      const snapshot = validateSnapshot(data.snapshot);
      if (
        expectedProjectSessionId !== undefined &&
        snapshot.status.projectSessionId !== expectedProjectSessionId
      ) {
        throw new Error(
          `project session changed while saving (expected ${expectedProjectSessionId}, got ${snapshot.status.projectSessionId ?? "none"})`,
        );
      }
      const projection = snapshot.projections["document"] as { document?: unknown } | undefined;
      if (!snapshot.status.active || !projection || !("document" in projection)) {
        throw new Error("cannot save without an active project document");
      }
      return projection.document;
    });
  }

  createProject(templateId?: string): Promise<ProjectOperationResult> {
    const expectedProjectSessionId = this.activeProjectSessionId;
    return this.runProjectOperation(async () => {
      const data = await this.graphql.execute<{ projectCreate: ProjectOperationResult }>(
        `mutation ProjectCreate($templateId: String, $expectedProjectSessionId: String) {
          projectCreate(
            templateId: $templateId
            expectedProjectSessionId: $expectedProjectSessionId
          ) {
            status { ${PROJECT_STATUS_FIELDS} }
            summary { applied projected deferred skipped }
            templateId name
          }
        }`,
        {
          templateId: templateId ?? null,
          expectedProjectSessionId: expectedProjectSessionId ?? null,
        },
      );
      return validateProjectOperationResult(data.projectCreate);
    });
  }

  openProjectDocument(document: unknown): Promise<ProjectOperationResult> {
    const expectedProjectSessionId = this.activeProjectSessionId;
    return this.runProjectOperation(async () => {
      const data = await this.graphql.execute<{ projectOpenDocument: ProjectOperationResult }>(
        `mutation ProjectOpenDocument($document: JSON!, $expectedProjectSessionId: String) {
          projectOpenDocument(
            document: $document
            expectedProjectSessionId: $expectedProjectSessionId
          ) {
            status { ${PROJECT_STATUS_FIELDS} }
            summary { applied projected deferred skipped }
          }
        }`,
        { document, expectedProjectSessionId: expectedProjectSessionId ?? null },
      );
      return validateProjectOperationResult(data.projectOpenDocument);
    });
  }

  closeProject(expectedProjectSessionId?: string): Promise<ProjectStatus> {
    return this.runProjectOperation(async () => {
      const data = await this.graphql.execute<{ projectClose: ProjectStatus }>(
        `mutation ProjectClose($expectedProjectSessionId: String) {
          projectClose(expectedProjectSessionId: $expectedProjectSessionId) {
            ${PROJECT_STATUS_FIELDS}
          }
        }`,
        { expectedProjectSessionId: expectedProjectSessionId ?? null },
      );
      return validateProjectStatus(data.projectClose);
    });
  }

  /**
   * Estado do histórico para a aba Histórico e os botões de desfazer.
   *
   * Caminho FRIO de propósito: é leitura de UI, não caminho quente de
   * edição — mandá-la pelo gRPC só somaria superfície a manter em paridade.
   */
  historyStatus(limit?: number): Promise<HistoryStatus> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{ historyStatus: HistoryStatus }>(
        `query HistoryStatus($limit: Int) { historyStatus(limit: $limit) { ${HISTORY_STATUS_FIELDS} } }`,
        { limit: limit ?? null },
      );
      return data.historyStatus;
    });
  }

  /**
   * Desfaz o último gesto.
   *
   * A idempotência no failover vem do `historyCursor`, não de um `requestId`:
   * se o pedido chegou e o transporte caiu antes da resposta, o retry manda o
   * MESMO cursor — que já não é o corrente — e é recusado como conflito em vez
   * de desfazer duas ações. O compare-and-swap é mais forte que a dedupe por
   * id, porque protege também contra dois clientes concorrentes.
   */
  undo(historyCursor?: string): Promise<HistoryOperationResult> {
    return this.historyMutation("undo", historyCursor);
  }

  redo(historyCursor?: string): Promise<HistoryOperationResult> {
    return this.historyMutation("redo", historyCursor);
  }

  private historyMutation(
    operation: "undo" | "redo",
    historyCursor?: string,
  ): Promise<HistoryOperationResult> {
    return this.coldCall(async () => {
      const name = operation === "undo" ? "Undo" : "Redo";
      const data = await this.graphql.execute<Record<string, HistoryOperationResult>>(
        `mutation ${name}($historyCursor: String, $expectedProjectSessionId: String) {
          ${operation}(historyCursor: $historyCursor, expectedProjectSessionId: $expectedProjectSessionId) {
            action historyEntryId label documentStateId historyCursor
          }
        }`,
        {
          historyCursor: historyCursor ?? null,
          expectedProjectSessionId: this.projectionState?.status.projectSessionId ?? null,
        },
      );
      return data[operation]!;
    });
  }

  projectStatus(): Promise<ProjectStatus> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{ projectStatus: ProjectStatus }>(
        `query ProjectStatus { projectStatus { ${PROJECT_STATUS_FIELDS} } }`,
      );
      const status = validateProjectStatus(data.projectStatus);
      const observed = this.projectionState?.status;
      if (
        observed !== undefined &&
        (status.active !== observed.active ||
          (status.active && status.projectSessionId !== observed.projectSessionId))
      ) {
        this.requestResync("project_session_changed");
      }
      return status;
    });
  }

  /** Compatibilidade temporária: todo load usa a operação transacional nova. */
  async loadDocument(document: unknown): Promise<ProjectOperationSummary> {
    return (await this.openProjectDocument(document)).summary;
  }

  listProjectTemplates(): Promise<{
    templates: Array<{ id: string; label: string; description: string }>;
  }> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{
        templates: Array<{ id: string; label: string; description: string }>;
      }>("{ templates { id label description } }");
      return { templates: data.templates };
    });
  }

  async newProjectFromTemplate(templateId: string): Promise<{
    templateId: string;
    name: string;
    applied: number;
    projected: number;
    deferred: number;
    skipped: number;
  }> {
    const result = await this.createProject(templateId);
    return {
      templateId: result.templateId ?? templateId,
      name: result.name ?? templateId,
      ...result.summary,
    };
  }

  close(): void {
    this.closed = true;
    this.sessionId = undefined;
    this.stopEventPump();
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.resyncRetryTimer) clearTimeout(this.resyncRetryTimer);
    this.probeTimer = undefined;
    this.resyncRetryTimer = undefined;
    this.grpc.close();
  }

  /**
   * Serializa substituições dentro deste cliente e encerra a geração antiga
   * antes de chamar o middleware. Se a preparação remota falhar, o cursor e o
   * pump anteriores são retomados. Depois do commit remoto, o snapshot antigo
   * é descartado imediatamente e a projeção completa da nova sessão é aplicada.
   */
  private runProjectOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.projectOperationQueue.then(async () => {
      const shouldRestart = this.isConnected;
      this.stopEventPump();
      if (this.resyncPromise) {
        await this.resyncPromise.catch(() => undefined);
      }

      let committed = false;
      try {
        const result = await this.coldCall(operation);
        committed = true;
        this.projectionState = undefined;
        this.cursor = undefined;
        try {
          await this.resynchronize("project_session_changed", false);
        } catch (error) {
          // O commit remoto já aconteceu: não reportamos uma falsa falha de
          // open/create ao ciclo de vida. A projeção segue indisponível até o
          // retry completo concluir; nenhum cursor antigo é reutilizado.
          this.log.warn("project committed; snapshot retry scheduled", {
            message: String(error),
          });
          this.requestResync("project_session_changed");
        }
        if (shouldRestart && this.cursor && !this.closed) this.startEventPump();
        return result;
      } catch (error) {
        if (!committed && shouldRestart && !this.closed) this.startEventPump();
        throw error;
      }
    });
    this.projectOperationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async hotCall<T>(viaGrpc: () => Promise<T>, viaGraphql: () => Promise<T>): Promise<T> {
    if (this.router.active === "grpc") {
      try {
        const result = await viaGrpc();
        this.router.onCallSuccess("grpc");
        return result;
      } catch (error) {
        const classified = classifyTransportError(error);
        if (classified.category !== "availability") {
          if (classified.category === "authentication") this.recordFatalTransportError(classified);
          throw this.normalizeError(error);
        }
        const decision = this.router.onTransportFailure("grpc", Date.now(), classified);
        const fallbackActive =
          decision === "fellBack" || this.router.snapshot.active === "graphql";
        this.log.warn("gRPC call failed", {
          reason: classified.reason,
          fellBack: fallbackActive,
        });
        if (decision === "fellBack") {
          this.onFellBack();
        } else if (!fallbackActive) {
          throw this.normalizeError(error);
        }
        // O stream pode ter feito a transição enquanto esta chamada gRPC
        // ainda estava em voo. Nesse caso `onTransportFailure` retorna
        // `stay` porque o router já está em fallback; a chamada corrente
        // ainda precisa continuar pelo baseline GraphQL.
      }
    }
    try {
      return await viaGraphql();
    } catch (error) {
      const classified = classifyTransportError(error);
      if (classified.category === "authentication") this.recordFatalTransportError(classified);
      throw this.normalizeError(error);
    }
  }

  private async coldCall<T>(viaGraphql: () => Promise<T>): Promise<T> {
    try {
      return await viaGraphql();
    } catch (error) {
      const classified = classifyTransportError(error);
      if (classified.category === "authentication") this.recordFatalTransportError(classified);
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof GraphQlAuthenticationError) return error;
    if (error instanceof GraphQlDomainError) {
      return new Error(error.code !== undefined ? `${error.message} (code ${error.code})` : error.message);
    }
    const candidate = error as { details?: string; message?: string };
    if (typeof candidate?.details === "string" && candidate.details.length > 0) {
      return new Error(candidate.details);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private startEventPump(): void {
    if (this.closed || !this.sessionId) return;
    if (this.router.active === "grpc") this.openStream();
    else this.startPolling();
  }

  private stopEventPump(): void {
    this.eventGeneration++;
    this.cancelStream?.();
    this.cancelStream = undefined;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private openStream(): void {
    const generation = this.eventGeneration;
    const cursor = this.cursor;
    if (!cursor) {
      this.requestResync("missing_cursor");
      return;
    }
    this.cancelStream = this.grpc.streamEvents(
      cursor,
      (status) => {
        if (generation === this.eventGeneration) this.handleStreamStatus(status);
      },
      (event) => {
        if (generation === this.eventGeneration) this.deliver(event);
      },
      (error) => {
        if (generation !== this.eventGeneration) return;
        const classified = classifyTransportError(error);
        if (classified.category !== "availability") {
          this.recordFatalTransportError(classified);
          return;
        }
        const decision = this.router.onTransportFailure("grpc", Date.now(), classified);
        this.log.warn("gRPC event stream lost", { reason: classified.reason });
        if (decision === "fellBack") this.onFellBack();
      },
    );
  }

  private handleStreamStatus(status: HotJournalStatus): void {
    const cursor = this.cursor;
    if (!cursor) {
      this.requestResync("missing_cursor");
      return;
    }
    if (status.resyncRequired) {
      this.requestResync(status.resyncReason ?? "server_resync_required");
      return;
    }
    if (status.middlewareInstanceId !== cursor.middlewareInstanceId) {
      this.requestResync("instance_changed");
      return;
    }
    if (
      status.projectSessionId !== cursor.projectSessionId ||
      status.projectId !== cursor.projectId
    ) {
      this.requestResync("project_session_changed");
      return;
    }
    const after = parseSequence(cursor.lastEventSeq);
    const first = parseSequence(status.firstAvailableSeq);
    const last = parseSequence(status.lastEventSeq);
    if (after === undefined || first === undefined || last === undefined || after > last || after + 1n < first) {
      this.requestResync("invalid_stream_window");
      return;
    }
    this.cursor = { ...cursor, firstAvailableSeq: status.firstAvailableSeq };
  }

  private startPolling(): void {
    this.schedulePoll(0);
  }

  private schedulePoll(delayMs: number): void {
    if (this.closed || this.router.active !== "graphql" || this.pollTimer) return;
    const generation = this.eventGeneration;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (generation === this.eventGeneration) void this.pollEvents(generation);
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private async pollEvents(generation: number): Promise<void> {
    if (
      generation !== this.eventGeneration ||
      this.pollInFlight ||
      this.closed ||
      this.router.active !== "graphql"
    ) return;
    this.pollInFlight = true;
    try {
      if (this.resyncPromise) await this.resyncPromise;
      const cursor = this.cursor;
      if (!cursor) {
        await this.resynchronize("missing_cursor");
        return;
      }
      const data = await this.graphql.execute<{ eventBatch: EventBatchWire }>(EVENT_BATCH_QUERY, {
        instance: cursor.middlewareInstanceId,
        projectSessionId: cursor.projectSessionId,
        after: cursor.lastEventSeq,
      });
      if (generation !== this.eventGeneration) return;
      const batch = data.eventBatch;
      if (batch.resyncRequired) {
        await this.resynchronize(batch.resyncReason ?? "server_resync_required");
        return;
      }
      if (batch.middlewareInstanceId !== cursor.middlewareInstanceId) {
        await this.resynchronize("instance_changed");
        return;
      }
      if (
        batch.projectSessionId !== cursor.projectSessionId ||
        batch.projectId !== cursor.projectId
      ) {
        await this.resynchronize("project_session_changed");
        return;
      }
      for (const event of batch.events) {
        // GraphQL devolve null onde o gRPC omite: normaliza para o mesmo shape.
        const { projection, ...rest } = event;
        const delivered: HotEvent = projection
          ? {
              ...rest,
              projection: {
                status: projection.status,
                ...(projection.reason ? { reason: projection.reason } : {}),
              },
            }
          : rest;
        if (!this.deliver(delivered)) return;
      }
      if (this.cursor?.lastEventSeq !== batch.lastEventSeq) {
        await this.resynchronize("poll_window_mismatch");
      } else if (this.cursor) {
        this.cursor = { ...this.cursor, firstAvailableSeq: batch.firstAvailableSeq };
      }
    } catch (error) {
      const classified = classifyTransportError(error);
      if (classified.category === "authentication") this.recordFatalTransportError(classified);
      else this.log.debug("event poll failed", { reason: classified.reason });
    } finally {
      this.pollInFlight = false;
      if (generation === this.eventGeneration && !this.fatalTransportError) {
        this.schedulePoll(this.eventPollMs);
      }
    }
  }

  /**
   * Processa um evento do fio.
   *
   * @returns `true` quando o lote pode continuar; `false` SÓ quando parar é a
   * decisão certa — houve pedido de ressincronização e os eventos seguintes
   * deixaram de fazer sentido. Não é "entreguei ao consumidor": eventos de
   * controle (troca de sessão, telemetria do host) não chegam aos ouvintes de
   * Blueprint e mesmo assim têm respostas opostas aqui.
   */
  private deliver(event: HotEvent): boolean {
    const cursor = this.cursor;
    const sequence = parseSequence(event.seq);
    const commandSequence = parseSequence(event.commandSequence);
    const last = cursor ? parseSequence(cursor.lastEventSeq) : undefined;
    if (!cursor || sequence === undefined || commandSequence === undefined || last === undefined) {
      this.requestResync("invalid_event_cursor");
      return false;
    }
    if (
      event.projectSessionId !== cursor.projectSessionId ||
      event.projectId !== cursor.projectId
    ) {
      this.requestResync("project_session_changed");
      return false;
    }
    if (sequence <= last) return true;
    if (sequence !== last + 1n) {
      this.requestResync("client_gap");
      return false;
    }
    this.cursor = {
      ...cursor,
      commandSequence: event.commandSequence,
      lastEventSeq: event.seq,
    };
    // Trocas/fechamentos de sessão são eventos de controle, não mutações do
    // Blueprint. Eles invalidam a projeção inteira e nunca devem sujar o
    // documento nem chegar aos consumidores como um comando editável.
    if (event.kind === "project/sessionChanged") {
      this.requestResync("project_session_changed");
      return false;
    }
    // Telemetria do host gráfico (ADR-023) também é evento de CONTROLE: ela
    // descreve o que a engine desenhou, não o que o documento passou a ser.
    // Entregá-la aos ouvintes de Blueprint faria o app contar cada janela de
    // desenho como comando aplicado — sujando o projeto e disparando autosave
    // enquanto o usuário apenas olha a janela do host. O cursor já avançou
    // acima, então nada disso vira lacuna nem resync.
    if (event.kind === FRAME_TELEMETRY_EVENT_KIND) {
      const sample = event.payload as RuntimeTelemetry;
      this.lastTelemetry = sample;
      for (const listener of this.telemetryListeners) {
        try {
          listener(sample);
        } catch (error) {
          this.log.warn("runtime telemetry listener failed", { message: String(error) });
        }
      }
      // `true` = SIGA com o lote. Diferente de `project/sessionChanged`, que
      // pede resync e por isso interrompe, a telemetria foi processada com
      // sucesso: devolver `false` aqui abortaria os eventos seguintes do
      // mesmo lote de polling, que só chegariam na próxima sondagem.
      return true;
    }
    const rawPayload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : { value: event.payload };
    const payload: BlueprintEventPayload = {
      ...rawPayload,
      kind: event.kind,
      projectSessionId: event.projectSessionId,
      projectId: event.projectId,
      commandSequence: event.commandSequence,
    };
    for (const listener of this.eventListeners) {
      try {
        listener(payload, event.projection);
      } catch (error) {
        this.log.warn("blueprint event listener failed", { message: String(error) });
      }
    }
    return true;
  }

  private onFellBack(): void {
    this.stopEventPump();
    this.startPolling();
  }

  private startProbeLoop(): void {
    if (this.probeTimer || !this.grpcEnabled) return;
    this.probeTimer = setInterval(() => void this.probeGrpc(), this.probeTickMs);
    this.probeTimer.unref?.();
  }

  private async probeGrpc(): Promise<void> {
    const now = Date.now();
    if (!this.router.shouldProbe(now) || this.resyncPromise) return;
    try {
      const health = await this.grpc.health();
      if (!health.ok) {
        this.router.onProbeResult(false, Date.now());
        return;
      }
      if (!this.cursor || health.middlewareInstanceId !== this.cursor.middlewareInstanceId) {
        await this.resynchronize("instance_changed");
      } else if (
        health.projectSessionId !== this.cursor.projectSessionId ||
        health.projectId !== this.cursor.projectId
      ) {
        await this.resynchronize("project_session_changed");
      }
      if (this.router.onProbeResult(true, Date.now()) === "promoted") {
        this.log.info("gRPC recovered; promoting", { lastEventSeq: this.cursor?.lastEventSeq });
        this.stopEventPump();
        this.openStream();
      }
    } catch (error) {
      const classified = classifyTransportError(error);
      if (classified.category === "availability") {
        this.router.onProbeResult(false, Date.now());
      } else {
        this.recordFatalTransportError(classified);
      }
    }
  }

  private requestResync(reason: string): void {
    void this.resynchronize(reason).catch((error) => {
      this.log.warn("projection resynchronization failed", { reason, message: String(error) });
      if (this.closed || this.resyncRetryTimer) return;
      this.resyncRetryTimer = setTimeout(() => {
        this.resyncRetryTimer = undefined;
        this.requestResync(reason);
      }, this.resyncRetryMs);
      this.resyncRetryTimer.unref?.();
    });
  }

  private resynchronize(reason: string, restartPump = true): Promise<void> {
    if (this.resyncPromise) return this.resyncPromise;
    const promise = this.performResynchronization(reason, restartPump).finally(() => {
      if (this.resyncPromise === promise) this.resyncPromise = undefined;
    });
    this.resyncPromise = promise;
    return promise;
  }

  private async performResynchronization(reason: string, restartPump: boolean): Promise<void> {
    const shouldRestart = restartPump && this.isConnected;
    if (shouldRestart) this.stopEventPump();
    const previousMiddlewareInstanceId = this.cursor?.middlewareInstanceId;
    const previousProjectSessionId = this.cursor?.projectSessionId;
    const data = await this.graphql.execute<{ snapshot: ProjectionSnapshot }>(SNAPSHOT_QUERY);
    const snapshot = validateSnapshot(data.snapshot);
    this.projectionState = snapshot;
    this.cursor = {
      middlewareInstanceId: snapshot.middlewareInstanceId,
      projectSessionId: snapshot.projectSessionId,
      projectId: snapshot.projectId,
      commandSequence: snapshot.commandSequence,
      firstAvailableSeq: snapshot.firstAvailableSeq,
      lastEventSeq: snapshot.lastEventSeq,
    };
    const record: ResynchronizationRecord = {
      reason,
      atUnixMs: Date.now(),
      ...(previousMiddlewareInstanceId ? { previousMiddlewareInstanceId } : {}),
      ...(previousProjectSessionId ? { previousProjectSessionId } : {}),
      middlewareInstanceId: snapshot.middlewareInstanceId,
      projectSessionId: snapshot.projectSessionId,
      projectId: snapshot.projectId,
      lastEventSeq: snapshot.lastEventSeq,
    };
    this.resynchronizationCount++;
    this.lastResynchronization = record;
    this.log.info("projection snapshot applied", {
      reason,
      middlewareInstanceId: snapshot.middlewareInstanceId,
      projectSessionId: snapshot.projectSessionId,
      projectId: snapshot.projectId,
      lastEventSeq: snapshot.lastEventSeq,
    });
    for (const listener of this.resyncListeners) {
      try {
        listener(snapshot, record);
      } catch (error) {
        this.log.warn("resynchronization listener failed", { message: String(error) });
      }
    }
    if (shouldRestart && !this.closed) this.startEventPump();
  }

  private recordFatalTransportError(classified: ClassifiedError): void {
    this.fatalTransportError = classified.reason;
    this.stopEventPump();
    this.log.error("non-retryable transport failure", {
      category: classified.category,
      reason: classified.reason,
    });
  }
}

function availability(reason: string): ClassifiedError {
  return { category: "availability", transport: true, reason };
}

function parseSequence(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= (1n << 64n) - 1n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validateSnapshot(snapshot: ProjectionSnapshot): ProjectionSnapshot {
  if (
    !snapshot ||
    typeof snapshot.middlewareInstanceId !== "string" ||
    snapshot.middlewareInstanceId.length === 0 ||
    typeof snapshot.projectSessionId !== "string" ||
    typeof snapshot.projectId !== "string" ||
    typeof snapshot.projections !== "object" ||
    snapshot.projections === null
  ) {
    throw new Error("invalid editor projection snapshot");
  }
  const first = parseSequence(snapshot.firstAvailableSeq);
  const last = parseSequence(snapshot.lastEventSeq);
  if (first === undefined || last === undefined || first > last + 1n) {
    throw new Error("invalid editor snapshot cursor bounds");
  }
  const status = validateProjectStatus(snapshot.status);
  if (
    status.active &&
    (status.projectSessionId !== snapshot.projectSessionId || status.projectId !== snapshot.projectId)
  ) {
    throw new Error("editor snapshot status does not match its project cursor");
  }
  return Object.freeze({
    ...snapshot,
    status,
    projections: Object.freeze({ ...snapshot.projections }),
  });
}

function validateProjectStatus(status: ProjectStatus): ProjectStatus {
  if (
    !status ||
    typeof status.active !== "boolean" ||
    parseSequence(status.commandSequence) === undefined ||
    (status.runtimeState !== "synchronized" &&
      status.runtimeState !== "deferred" &&
      status.runtimeState !== "failed")
  ) {
    throw new Error("invalid project status");
  }
  if (
    status.active &&
    (typeof status.projectSessionId !== "string" ||
      status.projectSessionId.length === 0 ||
      typeof status.projectId !== "string" ||
      status.projectId.length === 0 ||
      typeof status.createdAt !== "string" ||
      parseSequence(status.createdAt) === undefined)
  ) {
    throw new Error("active project status is missing session identity");
  }
  return Object.freeze({
    active: status.active,
    commandSequence: status.commandSequence,
    runtimeState: status.runtimeState,
    // Defaults tolerantes: um middleware anterior à v4 não publica estes
    // campos, e recusar o status inteiro por causa deles transformaria uma
    // incompatibilidade menor em "não consigo abrir projeto".
    documentStateId: status.documentStateId ?? "baseline",
    historyCursor: status.historyCursor ?? "0",
    canUndo: status.canUndo ?? false,
    canRedo: status.canRedo ?? false,
    ...(typeof status.projectSessionId === "string" && status.projectSessionId.length > 0
      ? { projectSessionId: status.projectSessionId }
      : {}),
    ...(typeof status.projectId === "string" && status.projectId.length > 0
      ? { projectId: status.projectId }
      : {}),
    ...(typeof status.createdAt === "string" && status.createdAt.length > 0
      ? { createdAt: status.createdAt }
      : {}),
  });
}

function validateProjectOperationResult(result: ProjectOperationResult): ProjectOperationResult {
  if (!result || typeof result.summary !== "object" || result.summary === null) {
    throw new Error("invalid project operation result");
  }
  const summary = result.summary;
  for (const value of [summary.applied, summary.projected, summary.deferred, summary.skipped]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("invalid project operation summary");
    }
  }
  return Object.freeze({
    status: validateProjectStatus(result.status),
    summary: Object.freeze({ ...summary }),
    ...(typeof result.templateId === "string" && result.templateId.length > 0
      ? { templateId: result.templateId }
      : {}),
    ...(typeof result.name === "string" && result.name.length > 0
      ? { name: result.name }
      : {}),
  });
}
