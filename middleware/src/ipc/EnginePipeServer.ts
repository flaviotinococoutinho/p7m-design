import { EventEmitter } from "node:events";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { JsonRpcPeer } from "./JsonRpcPeer.js";
import { resolvePipePath } from "./PipeEndpoint.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../protocol/jsonrpc.js";
import {
  prepareUnixSocketPath,
  removeOwnedUnixSocketPath,
  restrictUnixSocketPathPermissions,
} from "./UnixSocketLifecycle.js";
import { parseFrameTelemetry } from "../runtime/FrameTelemetry.js";

export interface HandshakeParams {
  clientName: string;
  clientVersion: string;
  protocolVersion: string;
  capabilities?: string[];
}

export interface EngineSession {
  sessionId: string;
  /** Geração monotônica do destino de runtime corrente. */
  readonly runtimeSessionEpoch: number;
  clientName: string;
  clientVersion: string;
  capabilities: string[];
  peer: JsonRpcPeer;
  connectedAtUnixMs: number;
}

export type EngineSessionChangeReason = "connected" | "superseded" | "disconnected";

/**
 * Troca efetiva do runtime que recebe projeções. Diferente de `sessionClosed`,
 * o fechamento de uma conexão já supersedida não produz este evento.
 */
export interface CurrentEngineSessionChangedEvent {
  readonly reason: EngineSessionChangeReason;
  /** Epoch corrente depois da troca (também muda ao entrar em disconnected). */
  readonly runtimeSessionEpoch: number;
  readonly current?: EngineSession;
  readonly previous?: EngineSession;
}

export interface EngineLogEntry {
  level: "trace" | "debug" | "info" | "warn" | "error";
  message: string;
  category?: string;
  unixMs?: number;
}

export interface EnginePipeServerOptions {
  pipeName?: string;
  /** Capacidades que o middleware aceita anunciar de volta no handshake. */
  supportedCapabilities?: string[];
  requestTimeoutMs?: number;
}

const SERVER_NAME = "gridsmith-middleware";

/**
 * Endpoint do plano de controle: aceita conexões da engine via Named Pipe
 * (Windows) ou Unix Domain Socket (Linux/macOS), executa o handshake de
 * protocolo e mantém o registro de sessões ativas.
 *
 * Eventos:
 * - "session"      (session: EngineSession)  — handshake concluído
 * - "sessionClosed"(session: EngineSession, reason: Error)
 * - "currentSessionChanged" (change: CurrentEngineSessionChangedEvent)
 *                    — somente quando muda a engine que recebe projeções
 * - "engineLog"    (session: EngineSession, entry: EngineLogEntry)
 * - "frameTelemetry" (session: EngineSession, sample: FrameTelemetrySample)
 *                    — só o host gráfico emite; o Runtime headless não tem frames
 */
export class EnginePipeServer extends EventEmitter {
  private readonly server: net.Server;
  private activeSession: EngineSession | undefined;
  private sessionEpoch = 0;
  private readonly options: EnginePipeServerOptions;
  readonly pipePath: string;

  constructor(options: EnginePipeServerOptions = {}) {
    super();
    this.options = options;
    this.pipePath = resolvePipePath(options.pipeName);
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  async listen(): Promise<void> {
    if (process.platform !== "win32") await prepareUnixSocketPath(this.pipePath);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.pipePath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") restrictUnixSocketPathPermissions(this.pipePath);
  }

  async close(): Promise<void> {
    this.activeSession?.peer.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (process.platform !== "win32") removeOwnedUnixSocketPath(this.pipePath);
  }

  get activeSessions(): readonly EngineSession[] {
    return this.activeSession ? [this.activeSession] : [];
  }

  /** Única engine autorizada a receber a projeção materializada corrente. */
  get currentSession(): EngineSession | undefined {
    return this.activeSession;
  }

  /**
   * Geração do destino efetivo. Diferentemente de `sessionId`, existe também
   * quando nenhuma engine está conectada e muda ao desconectar a corrente.
   */
  get currentRuntimeSessionEpoch(): number {
    return this.sessionEpoch;
  }

  private onConnection(socket: net.Socket): void {
    socket.setNoDelay?.(true);
    const peer = new JsonRpcPeer(socket, {
      label: "engine-connection",
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
    });
    let session: EngineSession | undefined;

    peer.registerMethod("engine/handshake", (params) => {
      if (session) {
        throw new JsonRpcError(
          RpcErrorCode.InvalidRequest,
          "engine/handshake already completed for this connection",
        );
      }
      const p = validateHandshake(params);
      const [major] = p.protocolVersion.split(".");
      const [serverMajor] = PROTOCOL_VERSION.split(".");
      if (major !== serverMajor) {
        throw new JsonRpcError(
          RpcErrorCode.ProtocolMismatch,
          `Protocol major version mismatch: engine=${p.protocolVersion}, middleware=${PROTOCOL_VERSION}`,
        );
      }
      const supported = new Set(this.options.supportedCapabilities ?? []);
      const accepted = (p.capabilities ?? []).filter((c) => supported.has(c));
      const runtimeSessionEpoch = this.advanceRuntimeSessionEpoch();
      const nextSession: EngineSession = {
        sessionId: randomUUID(),
        runtimeSessionEpoch,
        clientName: p.clientName,
        clientVersion: p.clientVersion,
        capabilities: accepted,
        peer,
        connectedAtUnixMs: Date.now(),
      };
      const previous = this.activeSession;
      session = nextSession;
      // Publica a nova referência antes de encerrar A: o callback de close de
      // A jamais pode fazê-la voltar a ser current nem disparar reidratação.
      this.activeSession = nextSession;
      previous?.peer.close();
      this.emit("session", nextSession);
      this.emitCurrentSessionChanged({
        reason: previous ? "superseded" : "connected",
        runtimeSessionEpoch,
        current: nextSession,
        ...(previous ? { previous } : {}),
      });
      return {
        sessionId: nextSession.sessionId,
        serverName: SERVER_NAME,
        protocolVersion: PROTOCOL_VERSION,
        acceptedCapabilities: accepted,
      };
    });

    peer.registerMethod("engine/ping", (params) => {
      const p = (params ?? {}) as { payload?: unknown };
      if (typeof p.payload !== "string") {
        throw new JsonRpcError(RpcErrorCode.InvalidParams, `"payload" must be a string`);
      }
      return { echo: p.payload, receivedAtUnixMs: Date.now() };
    });

    peer.registerMethod("engine/log", (params) => {
      if (!session) return; // logs antes do handshake são descartados
      const entry = params as EngineLogEntry;
      if (typeof entry?.message === "string" && typeof entry?.level === "string") {
        this.emit("engineLog", session, entry);
      }
    });

    peer.registerMethod("frame/telemetry", (params) => {
      if (!session) return; // idem: sem sessão não há a quem atribuir a janela
      const sample = parseFrameTelemetry(params);
      // Amostra malformada é descartada em silêncio: é notificação, não há a
      // quem devolver erro, e derrubar a conexão por causa de telemetria
      // fecharia o plano de controle inteiro por causa do acessório.
      if (sample) this.emit("frameTelemetry", session, sample);
    });

    peer.on("close", (reason: Error) => {
      if (session) {
        const wasCurrent = this.activeSession === session;
        if (wasCurrent) {
          this.activeSession = undefined;
          this.advanceRuntimeSessionEpoch();
        }
        this.emit("sessionClosed", session, reason);
        if (wasCurrent) {
          this.emitCurrentSessionChanged({
            reason: "disconnected",
            runtimeSessionEpoch: this.sessionEpoch,
            previous: session,
          });
        }
      }
    });
  }

  private emitCurrentSessionChanged(change: CurrentEngineSessionChangedEvent): void {
    this.emit("currentSessionChanged", Object.freeze(change));
  }

  private advanceRuntimeSessionEpoch(): number {
    if (this.sessionEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Engine runtime session epoch exhausted the safe integer range");
    }
    return ++this.sessionEpoch;
  }
}

function validateHandshake(params: unknown): HandshakeParams {
  const p = params as Partial<HandshakeParams> | undefined;
  if (
    !p ||
    typeof p.clientName !== "string" ||
    p.clientName.length === 0 ||
    typeof p.clientVersion !== "string" ||
    typeof p.protocolVersion !== "string" ||
    !/^\d+\.\d+$/.test(p.protocolVersion)
  ) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `engine/handshake requires "clientName", "clientVersion" and "protocolVersion" (MAJOR.MINOR)`,
    );
  }
  if (p.capabilities !== undefined && !Array.isArray(p.capabilities)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"capabilities" must be an array of strings`);
  }
  return p as HandshakeParams;
}
