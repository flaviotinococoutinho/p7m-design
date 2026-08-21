import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import {
  EnginePipeServer,
  type CurrentEngineSessionChangedEvent,
  type EngineLogEntry,
  type EngineSession,
} from "../src/ipc/EnginePipeServer.js";
import { EngineBridge } from "../src/domain/EngineBridge.js";
import { BlueprintStore } from "../src/domain/BlueprintStore.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { ProjectSessionManager } from "../src/canonical/ProjectSessionManager.js";
import { CapabilityRegistry } from "../src/domain/CapabilityRegistry.js";
import { MonoGameAdapter } from "../src/runtime/MonoGameAdapter.js";
import { bindEngineProjectSessionLifecycle } from "../src/runtime/EngineProjectSessionLifecycle.js";
import type { FrameTelemetrySample } from "../src/runtime/FrameTelemetry.js";
import type {
  ProjectionResult,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeSessionResetResult,
} from "../src/runtime/RuntimeAdapter.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../src/protocol/jsonrpc.js";

let pipeCounter = 0;
function uniquePipeName(): string {
  return `gridsmith-test-${process.pid}-${pipeCounter++}`;
}

/** Cliente TS que se comporta como o host da engine (mesmo contrato do lado C#). */
async function connectFakeEngine(server: EnginePipeServer): Promise<JsonRpcPeer> {
  const socket = net.connect(server.pipePath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const peer = new JsonRpcPeer(socket, { label: "fake-engine", requestTimeoutMs: 2000 });
  peer.registerMethod("engine/ping", (params) => {
    const { payload } = params as { payload: string };
    return { echo: payload, receivedAtUnixMs: Date.now() };
  });
  peer.registerMethod("skeleton/initialize", (params) => {
    const { skeletonId, bones } = params as { skeletonId: string; bones: unknown[] };
    return { skeletonId, boneCount: bones.length, status: "initialized" };
  });
  peer.registerMethod("mesh/bind_shared_memory", (params) => {
    const { meshId, vertexCount, strideInBytes } = params as {
      meshId: string;
      vertexCount: number;
      strideInBytes: number;
    };
    return { meshId, mappedBytes: vertexCount * strideInBytes, status: "bound" };
  });
  return peer;
}

interface Stack {
  server: EnginePipeServer;
  bridge: EngineBridge;
  store: BlueprintStore;
  orchestrator: CanonicalOrchestrator;
  adapter: MonoGameAdapter;
}

async function withServer(fn: (stack: Stack) => Promise<void>): Promise<void> {
  const server = new EnginePipeServer({
    pipeName: uniquePipeName(),
    supportedCapabilities: ["skeleton", "mesh", "shared-memory"],
    requestTimeoutMs: 2000,
  });
  const store = new BlueprintStore();
  const bridge = new EngineBridge(server, store);
  const adapter = new MonoGameAdapter(server, new CapabilityRegistry(server));
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), adapter);
  await server.listen();
  try {
    await fn({ server, bridge, store, orchestrator, adapter });
  } finally {
    await server.close();
  }
}

test("handshake válido estabelece sessão e devolve identidade", async () => {
  await withServer(async ({ server }) => {
    const engine = await connectFakeEngine(server);
    const result = await engine.request<{
      sessionId: string;
      serverName: string;
      protocolVersion: string;
      acceptedCapabilities: string[];
    }>("engine/handshake", {
      clientName: "Gridsmith.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ["skeleton", "raytracing"],
    });
    assert.equal(result.serverName, "gridsmith-middleware");
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.ok(result.sessionId.length > 0);
    // capacidades não suportadas pelo middleware são filtradas
    assert.deepEqual(result.acceptedCapabilities, ["skeleton"]);
    assert.equal(server.currentSession?.clientName, "Gridsmith.Engine.Runtime");
    engine.close();
  });
});

test("handshake repetido é recusado sem criar sessão órfã nem trocar a engine corrente", async () => {
  await withServer(async ({ server }) => {
    const changes: CurrentEngineSessionChangedEvent[] = [];
    server.on("currentSessionChanged", (change: CurrentEngineSessionChangedEvent) => {
      changes.push(change);
    });
    const engine = await connectFakeEngine(server);
    const first = await engine.request<{ sessionId: string }>("engine/handshake", {
      clientName: "engine-once",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    await assert.rejects(
      engine.request("engine/handshake", {
        clientName: "engine-twice",
        clientVersion: "0.2.0",
        protocolVersion: PROTOCOL_VERSION,
      }),
      (error: unknown) =>
        error instanceof JsonRpcError &&
        error.code === RpcErrorCode.InvalidRequest &&
        /already completed/.test(error.message),
    );

    assert.equal(server.currentSession?.sessionId, first.sessionId);
    assert.equal(server.currentSession?.clientName, "engine-once");
    assert.equal(server.activeSessions.length, 1);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.reason, "connected");
    assert.equal(changes[0]?.runtimeSessionEpoch, 1);
    assert.equal(server.currentSession?.runtimeSessionEpoch, 1);
    engine.close();
  });
});

test("engine nova supersede a anterior e seu fechamento nunca faz fallback para a obsoleta", async () => {
  await withServer(async ({ server }) => {
    const changes: CurrentEngineSessionChangedEvent[] = [];
    server.on("currentSessionChanged", (change: CurrentEngineSessionChangedEvent) => {
      changes.push(change);
    });

    const engineA = await connectFakeEngine(server);
    const a = await engineA.request<{ sessionId: string }>("engine/handshake", {
      clientName: "engine-a",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });
    const engineAClosed = new Promise<void>((resolve) => engineA.once("close", () => resolve()));

    const engineB = await connectFakeEngine(server);
    const b = await engineB.request<{ sessionId: string }>("engine/handshake", {
      clientName: "engine-b",
      clientVersion: "0.2.0",
      protocolVersion: PROTOCOL_VERSION,
    });
    await engineAClosed;

    assert.notEqual(b.sessionId, a.sessionId);
    assert.equal(engineA.isClosed, true);
    assert.equal(server.currentSession?.sessionId, b.sessionId);
    assert.deepEqual(server.activeSessions.map((session) => session.sessionId), [b.sessionId]);
    assert.deepEqual(changes.map((change) => change.reason), ["connected", "superseded"]);
    assert.deepEqual(changes.map((change) => change.runtimeSessionEpoch), [1, 2]);
    assert.equal(server.currentRuntimeSessionEpoch, 2);
    assert.equal(server.currentSession?.runtimeSessionEpoch, 2);
    assert.equal(changes[1]?.previous?.sessionId, a.sessionId);
    assert.equal(changes[1]?.current?.sessionId, b.sessionId);

    const disconnected = new Promise<void>((resolve) => {
      const observe = (change: CurrentEngineSessionChangedEvent): void => {
        if (change.reason !== "disconnected") return;
        server.removeListener("currentSessionChanged", observe);
        resolve();
      };
      server.on("currentSessionChanged", observe);
    });
    engineB.close();
    await disconnected;

    assert.equal(server.currentSession, undefined);
    assert.deepEqual(server.activeSessions, []);
    assert.deepEqual(changes.map((change) => change.reason), [
      "connected",
      "superseded",
      "disconnected",
    ]);
    assert.deepEqual(changes.map((change) => change.runtimeSessionEpoch), [1, 2, 3]);
    assert.equal(server.currentRuntimeSessionEpoch, 3);
    assert.equal(changes[2]?.previous?.sessionId, b.sessionId);
  });
});

test("troca efetiva da engine reseta e reidrata somente a sessão de projeto ativa", async () => {
  await withServer(async ({ server }) => {
    const cycles: Array<{
      phase: "reset" | "rehydrate";
      engineSessionId?: string;
      store?: BlueprintStore;
    }> = [];
    const runtime: RuntimeAdapter = {
      family: "test",
      get isConnected() {
        return server.currentSession !== undefined;
      },
      identify(): RuntimeIdentity | undefined {
        return undefined;
      },
      async project(event): Promise<ProjectionResult> {
        return { event: event.kind, status: "projected" };
      },
      async resetSession(): Promise<RuntimeSessionResetResult> {
        const engineSessionId = server.currentSession?.sessionId;
        const runtimeSessionEpoch = server.currentRuntimeSessionEpoch;
        cycles.push({ phase: "reset", ...(engineSessionId ? { engineSessionId } : {}) });
        return engineSessionId
          ? { status: "reset", runtimeSessionEpoch }
          : { status: "deferred", runtimeSessionEpoch, reason: "engine disconnected" };
      },
      async rehydrateFrom(store, expectedRuntimeSessionEpoch): Promise<readonly ProjectionResult[]> {
        assert.equal(expectedRuntimeSessionEpoch, server.currentRuntimeSessionEpoch);
        const engineSessionId = server.currentSession?.sessionId;
        cycles.push({
          phase: "rehydrate",
          ...(engineSessionId ? { engineSessionId } : {}),
          store,
        });
        return [];
      },
    };
    const sessions = new ProjectSessionManager({ hooks: new HookBus(), adapter: runtime });
    await sessions.replaceAtomically(sessions.createEmptySession("project-a"));
    const obsoleteStore = sessions.current!.store;
    await sessions.replaceAtomically(sessions.createEmptySession("project-b"));
    const activeSession = sessions.current!;
    cycles.length = 0;

    const unbind = bindEngineProjectSessionLifecycle(server, sessions);
    try {
      const engineA = await connectFakeEngine(server);
      const a = await engineA.request<{ sessionId: string }>("engine/handshake", {
        clientName: "engine-a",
        clientVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      });
      await waitUntil(() => cycles.length === 2);

      const engineB = await connectFakeEngine(server);
      const b = await engineB.request<{ sessionId: string }>("engine/handshake", {
        clientName: "engine-b",
        clientVersion: "0.2.0",
        protocolVersion: PROTOCOL_VERSION,
      });
      await waitUntil(() => cycles.length === 4);

      engineB.close();
      await waitUntil(() => cycles.length === 6);

      assert.deepEqual(
        cycles.map(({ phase, engineSessionId }) => ({ phase, engineSessionId })),
        [
          { phase: "reset", engineSessionId: a.sessionId },
          { phase: "rehydrate", engineSessionId: a.sessionId },
          { phase: "reset", engineSessionId: b.sessionId },
          { phase: "rehydrate", engineSessionId: b.sessionId },
          { phase: "reset", engineSessionId: undefined },
          { phase: "rehydrate", engineSessionId: undefined },
        ],
      );
      assert.equal(server.currentSession, undefined, "engine A não pode voltar após B fechar");
      assert.equal(sessions.current, activeSession);
      assert.ok(
        cycles.filter((cycle) => cycle.phase === "rehydrate").every(
          (cycle) => cycle.store === activeSession.store && cycle.store !== obsoleteStore,
        ),
      );
      engineA.close();
    } finally {
      unbind();
    }
  });
});

test("versão MAJOR incompatível é recusada com PROTOCOL_MISMATCH", async () => {
  await withServer(async ({ server }) => {
    const engine = await connectFakeEngine(server);
    await assert.rejects(
      engine.request("engine/handshake", {
        clientName: "Gridsmith.Engine.Runtime",
        clientVersion: "0.1.0",
        protocolVersion: "2.0",
      }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.ProtocolMismatch,
    );
    assert.equal(server.currentSession, undefined);
    engine.close();
  });
});

test("fluxo bidirecional: middleware pinga a engine e recebe logs dela", async () => {
  await withServer(async ({ server, bridge }) => {
    const logReceived = new Promise<EngineLogEntry>((resolve) => {
      server.once("engineLog", (_s: EngineSession, entry: EngineLogEntry) => resolve(entry));
    });
    const engine = await connectFakeEngine(server);
    await engine.request("engine/handshake", {
      clientName: "Gridsmith.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    // direção middleware → engine (request)
    const pong = await bridge.pingEngine("marco");
    assert.equal(pong.echo, "marco");

    // direção engine → middleware (notification)
    engine.notify("engine/log", { level: "info", message: "frame pacing ok", category: "runtime" });
    const entry = await logReceived;
    assert.equal(entry.message, "frame pacing ok");
    engine.close();
  });
});

test("o host gráfico notifica telemetria de frame pelo mesmo fio de volta", async () => {
  await withServer(async ({ server }) => {
    const telemetryReceived = new Promise<FrameTelemetrySample>((resolve) => {
      server.once("frameTelemetry", (_s: EngineSession, sample: FrameTelemetrySample) =>
        resolve(sample),
      );
    });
    const engine = await connectFakeEngine(server);
    await engine.request("engine/handshake", {
      clientName: "Gridsmith.Engine.Host",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    // Malformada primeiro: tem de ser DESCARTADA sem derrubar a conexão — é
    // notificação, não há a quem devolver erro, e fechar o plano de controle
    // por causa do acessório seria trocar o barato pelo caro.
    engine.notify("frame/telemetry", { frames: "muitos" });

    engine.notify("frame/telemetry", {
      frames: 60,
      windowMs: 1000,
      drawMsAvg: 1.5,
      drawMsMax: 4,
      camera: { x: 64, y: 32, zoom: 1 },
      frame: { quads: 96, quadsRequired: 96, truncated: false },
      scene: { actors: 2, lights: 1, tilemaps: 1 },
    });

    const sample = await telemetryReceived;
    assert.equal(sample.frames, 60);
    assert.equal(sample.camera.x, 64);
    assert.equal(sample.frame.quads, 96);
    assert.equal(sample.scene.lights, 1);

    // a conexão sobreviveu à amostra inválida
    const pong = await engine.request("engine/ping", { payload: "ainda-vivo" });
    assert.equal((pong as { echo: string }).echo, "ainda-vivo");
    engine.close();
  });
});

test("skeleton/define e mesh/bind percorrem o caminho canônico até a engine", async () => {
  await withServer(async ({ server, store, orchestrator }) => {
    const engine = await connectFakeEngine(server);
    await engine.request("engine/handshake", {
      clientName: "Gridsmith.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    const identity = [1, 0, 0, 1, 0, 0];
    const skeleton = await orchestrator.dispatch({
      kind: "skeleton/define",
      skeleton: {
        skeletonId: "hero-rig",
        bones: [
          { id: 0, parentId: -1, inverseBindMatrix: identity },
          { id: 1, parentId: 0, inverseBindMatrix: identity },
        ],
      },
    });
    assert.equal(skeleton.projection?.status, "projected");
    assert.deepEqual(skeleton.projection?.detail, {
      skeletonId: "hero-rig",
      boneCount: 2,
      status: "initialized",
    });

    const mesh = await orchestrator.dispatch({
      kind: "mesh/bind",
      binding: {
        meshId: "hero-mesh",
        skeletonId: "hero-rig",
        sharedMemoryMapName: "gridsmith-mesh-hero",
        vertexCount: 128,
        strideInBytes: 32,
      },
    });
    assert.deepEqual(mesh.projection?.detail, { meshId: "hero-mesh", mappedBytes: 4096, status: "bound" });

    // Projeções do AST refletem os comandos aplicados
    assert.equal(store.getSkeleton("hero-rig")?.bones.length, 2);
    assert.equal(store.getMesh("hero-mesh")?.vertexCount, 128);
    engine.close();
  });
});

test("comandos sem engine conectada ficam no AST e são reidratados na conexão", async () => {
  await withServer(async ({ server, bridge, store, orchestrator, adapter }) => {
    // Reidratação canônica: o adapter projeta o Blueprint em cada sessão nova
    // (mesma fiação do composition root em src/index.ts).
    let rehydration: Promise<readonly ProjectionResult[]> | undefined;
    server.on("session", (session: EngineSession) => {
      rehydration = adapter.rehydrateFrom(store, session.runtimeSessionEpoch);
    });

    const identity = [1, 0, 0, 1, 0, 0];
    // Comando aplicado com a engine offline: fica registrado no blueprint.
    const offline = await orchestrator.dispatch({
      kind: "skeleton/define",
      skeleton: {
        skeletonId: "npc-rig",
        bones: [{ id: 0, parentId: -1, inverseBindMatrix: identity }],
      },
    });
    assert.equal(offline.projection?.status, "deferred");
    assert.ok(store.getSkeleton("npc-rig"));

    // A engine conecta depois; o adapter deve reenviar skeleton/initialize.
    const socket = net.connect(server.pipePath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const engine = new JsonRpcPeer(socket, { label: "late-engine", requestTimeoutMs: 2000 });
    engine.registerMethod("engine/ping", (params) => ({ echo: (params as { payload: string }).payload }));
    const rehydrated = new Promise<string>((resolve) => {
      engine.registerMethod("skeleton/initialize", (params) => {
        const { skeletonId, bones } = params as { skeletonId: string; bones: unknown[] };
        resolve(skeletonId);
        return { skeletonId, boneCount: bones.length, status: "initialized" };
      });
    });
    await engine.request("engine/handshake", {
      clientName: "Gridsmith.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    assert.equal(await rehydrated, "npc-rig");
    // O handler remoto observa o request antes de o adapter receber o ACK.
    // Aguarda a operação inteira antes de desconectar para não fabricar uma
    // supersession tardia/unhandled depois do fim do teste.
    assert.ok(rehydration);
    await rehydration;
    const pong = await bridge.pingEngine("pós-reidratação");
    assert.equal(pong.echo, "pós-reidratação");
    engine.close();
  });
});

test("comandos inválidos são rejeitados pelo AST antes de chegar à engine", async () => {
  await withServer(async ({ orchestrator }) => {
    const identity = [1, 0, 0, 1, 0, 0];
    await assert.rejects(
      orchestrator.dispatch({
        kind: "mesh/bind",
        binding: {
          meshId: "orphan",
          skeletonId: "inexistente",
          sharedMemoryMapName: "map",
          vertexCount: 1,
          strideInBytes: 4,
        },
      }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.UnknownSkeleton,
    );
    const defineDup = () =>
      orchestrator.dispatch({
        kind: "skeleton/define",
        skeleton: { skeletonId: "dup", bones: [{ id: 0, parentId: -1, inverseBindMatrix: identity }] },
      });
    await defineDup();
    await assert.rejects(
      defineDup(),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.DuplicateId,
    );
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not satisfied before timeout");
}
