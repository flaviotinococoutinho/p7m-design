/**
 * Integração do EditorClient v2 contra os TRANSPORTS REAIS do middleware
 * (gRPC quente + GraphQL baseline — ADR-016/017):
 *  - conexão prioriza gRPC (health) e recebe eventos por stream;
 *  - dispatch/query/experience/templates com a MESMA superfície canônica;
 *  - FALLBACK provado: derruba o gRPC no meio da sessão → as chamadas e os
 *    eventos continuam via GraphQL (polling incremental, sem perder seq);
 *  - RECOVERY provado: gRPC volta → sondas com histerese repromovem.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EnginePipeServer } from "@gridsmith/middleware/dist/ipc/EnginePipeServer.js";
import { BlueprintStore } from "@gridsmith/middleware/dist/domain/BlueprintStore.js";
import { CapabilityRegistry } from "@gridsmith/middleware/dist/domain/CapabilityRegistry.js";
import { EditorSurface } from "@gridsmith/middleware/dist/canonical/EditorSurface.js";
import { HookBus } from "@gridsmith/middleware/dist/canonical/HookBus.js";
import {
  ProjectSessionManager,
  type ProjectSessionChangedEvent,
  type SessionBlueprintEvent,
} from "@gridsmith/middleware/dist/canonical/ProjectSessionManager.js";
import { GraphQlGateway } from "@gridsmith/middleware/dist/graphql/GraphQlGateway.js";
import { GrpcGateway } from "@gridsmith/middleware/dist/grpc/GrpcGateway.js";
import { EventJournal } from "@gridsmith/middleware/dist/transport/EventJournal.js";
import { generateTransportAuthToken } from "@gridsmith/middleware/dist/transport/auth.js";
import { ExperienceGovernor } from "@gridsmith/middleware/dist/runtime/ExperienceGovernor.js";
import { MonoGameAdapter } from "@gridsmith/middleware/dist/runtime/MonoGameAdapter.js";
import { RuntimeProfileRegistry } from "@gridsmith/middleware/dist/runtime/RuntimeProfile.js";
import { MONOGAME_PROFILES } from "@gridsmith/middleware/dist/runtime/profiles/monogame.js";
import { createLogger as createMiddlewareLogger } from "@gridsmith/middleware/dist/util/log.js";
import {
  EditorClient,
  type ProjectionSnapshot,
  type ResynchronizationRecord,
} from "../src/main/EditorClient.js";
import { createLogger } from "../src/core/logging.js";
import { ExperienceGate } from "../src/core/experienceGate.js";
import {
  FRAME_TELEMETRY_EVENT_KIND,
  type RuntimeTelemetry,
} from "../src/core/runtimeTelemetry.js";

const silentMw = createMiddlewareLogger("test", { level: "silent" });
const silentFe = createLogger("test", { level: "silent" });

interface Rig {
  pipeName: string;
  engineServer: EnginePipeServer;
  graphql: GraphQlGateway;
  grpc: GrpcGateway;
  surface: EditorSurface;
  store: BlueprintStore;
  journal: EventJournal;
  sessions: ProjectSessionManager;
  authToken: string;
  close(): Promise<void>;
}

interface RigOptions {
  journalCapacity?: number;
  graphqlAuthToken?: string;
  grpcAuthToken?: string;
}

async function makeRig(tag: string, options: RigOptions = {}): Promise<Rig> {
  const pipeName = `gridsmith-fe-${tag}-${process.pid}-${Date.now() % 100000}`;
  const engineServer = new EnginePipeServer({ pipeName, requestTimeoutMs: 2000 });
  const capabilities = new CapabilityRegistry(engineServer);
  const adapter = new MonoGameAdapter(engineServer, capabilities);
  const hooks = new HookBus();
  const sessions = new ProjectSessionManager({ hooks, adapter });
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const surface = new EditorSurface({
    sessions,
    governor: new ExperienceGovernor(profiles, capabilities),
    adapter,
  });
  const journal = new EventJournal(options.journalCapacity);
  const authToken = generateTransportAuthToken();
  await sessions.activate(sessions.createEmptySession(`frontend-${tag}`));
  const initialStatus = sessions.status;
  journal.activateSession(
    initialStatus.projectSessionId!,
    initialStatus.projectId!,
    initialStatus.commandSequence,
  );
  sessions.on(
    "event",
    (event: SessionBlueprintEvent, projection?: { event: string; status: string; reason?: string }) => {
      journal.appendForSession(
        event.projectSessionId,
        event.projectId,
        event.commandSequence,
        event.kind,
        event,
        projection && {
          event: projection.event,
          status: projection.status as "projected" | "skipped" | "deferred",
          ...(projection.reason !== undefined ? { reason: projection.reason } : {}),
        },
      );
    },
  );
  sessions.on("sessionChanged", (event: ProjectSessionChangedEvent) => {
    if (event.action === "activated") {
      journal.activateSession(event.projectSessionId!, event.projectId!, event.commandSequence);
      journal.appendForSession(
        event.projectSessionId!,
        event.projectId!,
        event.commandSequence,
        event.kind,
        event,
      );
    } else {
      journal.deactivateSession();
    }
  });
  const store = sessions.current!.store as BlueprintStore;

  const graphql = new GraphQlGateway({
    pipeName,
    surface,
    journal,
    log: silentMw,
    authToken: options.graphqlAuthToken ?? authToken,
  });
  const grpc = new GrpcGateway({
    pipeName,
    surface,
    journal,
    log: silentMw,
    authToken: options.grpcAuthToken ?? authToken,
  });
  await engineServer.listen();
  await graphql.listen();
  await grpc.listen();
  return {
    pipeName,
    engineServer,
    graphql,
    grpc,
    surface,
    store,
    journal,
    sessions,
    authToken,
    close: async () => {
      grpc.forceShutdown();
      await graphql.close();
      await engineServer.close();
    },
  };
}

test("EditorClient v2: conecta via gRPC, despacha, consulta, recebe eventos por stream e alimenta o gate", async () => {
  const rig = await makeRig("hot");
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 2000,
    authToken: rig.authToken,
    log: silentFe,
  });
  try {
    await client.connect();
    assert.equal(client.isConnected, true);
    assert.equal(client.technicalDiagnostics.activeTransport, "gRPC");

    const received: string[] = [];
    const receivedProjections: Array<{ status: string; reason?: string } | undefined> = [];
    client.onBlueprintEvent((event, projection) => {
      received.push(event.kind);
      receivedProjections.push(projection);
    });

    // dispatch pelo caminho canônico (engine offline → deferred, AST aceita)
    const outcome = await client.dispatch("entitydef/define", {
      entityDefId: "coin",
      fields: [{ name: "value", type: "int", default: 1 }],
    });
    assert.equal(outcome.event.kind, "entityDefDefined");
    assert.equal(outcome.projection?.status, "deferred");

    const defs = await client.query<{ entityDefs: Array<{ entityDefId: string }> }>("entityDefs");
    assert.equal(defs.entityDefs[0]?.entityDefId, "coin");

    // evento chegou pelo STREAM gRPC
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(received, ["entityDefDefined"]);

    // F5: a projeção viaja NO ENVELOPE, junto do evento — sem ela o painel
    // Problemas do editor seria estruturalmente zero mesmo com a engine caída.
    assert.equal(receivedProjections[0]?.status, "deferred");
    assert.ok(
      (receivedProjections[0]?.reason ?? "").length > 0,
      "a projeção adiada precisa chegar ao editor com razão acionável",
    );

    // experiência governada (GraphQL baseline) alimenta o gate da UI
    const experience = await client.resolveExperience("monogame", "3.8.2");
    const gate = new ExperienceGate(experience);
    assert.equal(gate.panel("shader-editor").enabled, true);
    assert.equal(gate.panel("level-editor").enabled, false); // requiresSubsystem sem engine
    assert.match(gate.panel("level-editor").reason, /no engine connected/);
  } finally {
    client.close();
    await rig.close();
  }
});

test("EditorClient v2: template Plataforma 2D pela superfície GraphQL", async () => {
  const rig = await makeRig("tpl");
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 2000,
    authToken: rig.authToken,
    log: silentFe,
  });
  try {
    await client.connect();

    const { templates } = await client.listProjectTemplates();
    assert.ok(templates.some((t) => t.id === "platformer-2d"));

    const summary = await client.newProjectFromTemplate("platformer-2d");
    assert.equal(summary.templateId, "platformer-2d");
    assert.equal(summary.applied, 6);

    const levels = await client.query<{ levels: Array<{ levelId: string }> }>("levels");
    assert.equal(levels.levels[0]?.levelId, "level-1");
  } finally {
    client.close();
    await rig.close();
  }
});

test("sessão de projeto: open inválido preserva sessão, projeções e cursor de A", async () => {
  const rig = await makeRig("invalid-open");
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 2000,
    authToken: rig.authToken,
    log: silentFe,
  });
  try {
    await client.connect();
    await client.dispatch("entitydef/define", {
      entityDefId: "from-a",
      fields: [],
    });
    const before = client.latestProjectionSnapshot;
    const beforeSessionId = before?.status.projectSessionId;
    assert.ok(beforeSessionId);

    await assert.rejects(
      () => client.openProjectDocument({ schemaVersion: 999, projectId: "invalid" }),
      /schema|document|version|required|invalid/i,
    );

    const status = await client.projectStatus();
    assert.equal(status.projectSessionId, beforeSessionId);
    assert.equal(client.latestProjectionSnapshot?.status.projectSessionId, beforeSessionId);
    const definitions = await client.query<{ entityDefs: Array<{ entityDefId: string }> }>(
      "entityDefs",
    );
    assert.deepEqual(definitions.entityDefs.map((item) => item.entityDefId), ["from-a"]);
  } finally {
    client.close();
    await rig.close();
  }
});

test("sessão de projeto: dois clientes observam a troca e só recebem eventos da nova sessão", async () => {
  const rig = await makeRig("two-clients");
  const first = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 2000,
    authToken: rig.authToken,
    log: silentFe,
  });
  const second = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 2000,
    eventPollMs: 25,
    authToken: rig.authToken,
    log: silentFe,
  });
  try {
    await Promise.all([first.connect(), second.connect()]);
    const previousSessionId = second.activeProjectSessionId;
    assert.ok(previousSessionId);
    const observedSessions: string[] = [];
    const observedEvents: string[] = [];
    second.onResynchronized((snapshot, record) => {
      if (record.reason === "project_session_changed") {
        observedSessions.push(snapshot.status.projectSessionId ?? "");
      }
    });
    second.onBlueprintEvent((event) => {
      observedEvents.push(`${event.projectSessionId}:${event.kind}`);
    });

    const replacement = await first.createProject();
    const nextSessionId = replacement.status.projectSessionId;
    assert.ok(nextSessionId);
    assert.notEqual(nextSessionId, previousSessionId);
    await waitUntil(
      () => observedSessions.includes(nextSessionId),
      5000,
      "segundo cliente não ressincronizou ao trocar a sessão",
    );
    assert.equal(second.activeProjectSessionId, nextSessionId);

    await first.dispatch("entitydef/define", {
      entityDefId: "only-b",
      fields: [],
    });
    await waitUntil(
      () => observedEvents.some((entry) => entry.endsWith(":entityDefDefined")),
      5000,
      "segundo cliente não recebeu evento da nova sessão",
    );
    assert.deepEqual(observedEvents, [`${nextSessionId}:entityDefDefined`]);
  } finally {
    first.close();
    second.close();
    await rig.close();
  }
});

test("resiliência: fallback gRPC → GraphQL mantém chamadas e eventos", async () => {
  const rig = await makeRig("fb");
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 2000,
    eventPollMs: 50,
    probeTickMs: 50,
    authToken: rig.authToken,
    router: { recoveryBackoffMs: [25], promoteAfterProbes: 2 },
    log: silentFe,
  });
  try {
    await client.connect();
    assert.equal(client.technicalDiagnostics.activeTransport, "gRPC");

    const received: string[] = [];
    client.onBlueprintEvent((event) => received.push(event.kind));

    await client.dispatch("light/add", {
      lightId: "sun",
      type: "point",
      position: [0, 0],
      color: [1, 1, 1],
      intensity: 1,
      radius: 64,
    });

    // ---- derruba o gRPC no meio da sessão ----
    rig.grpc.forceShutdown();

    // a PRÓXIMA chamada quente falha no transporte e cai para o GraphQL
    const viaFallback = await client.dispatch("light/remove", { lightId: "sun" });
    assert.equal(viaFallback.event.kind, "lightRemoved");
    assert.equal(client.technicalDiagnostics.activeTransport, "GraphQL fallback");

    // eventos seguem chegando (polling incremental, sem perder o seq 2)
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(received, ["lightAdded", "lightRemoved"]);

    // erro de DOMÍNIO no fallback NÃO derruba nada e carrega o código estável
    await assert.rejects(client.query("projecao-inexistente"), /-32602|must be one of/);
    assert.equal(client.technicalDiagnostics.activeTransport, "GraphQL fallback");

  } finally {
    client.close();
    await rig.close();
  }
});

test("resiliência: repromoção GraphQL → gRPC exige sondas saudáveis consecutivas", async () => {
  const rig = await makeRig("promote");
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 1000,
    eventPollMs: 25,
    probeTickMs: 20,
    authToken: rig.authToken,
    router: { recoveryBackoffMs: [15], promoteAfterProbes: 2 },
    log: silentFe,
  });
  let revived: GrpcGateway | undefined;
  try {
    await client.connect();
    rig.grpc.forceShutdown();

    const whileDown = await client.query<{ lights: unknown[] }>("lights");
    assert.deepEqual(whileDown.lights, []);
    assert.equal(client.technicalDiagnostics.activeTransport, "GraphQL fallback");

    revived = new GrpcGateway({
      pipeName: rig.pipeName,
      surface: rig.surface,
      journal: rig.journal,
      log: silentMw,
      authToken: rig.authToken,
    });
    await revived.listen();

    await waitUntil(
      () => client.technicalDiagnostics.activeTransport === "gRPC",
      10_000,
      "gRPC não foi repromovido após duas sondas saudáveis",
    );
    assert.match(client.technicalDiagnostics.switchReason ?? "", /healthy after 2 consecutive probes/);

    const afterPromotion = await client.query<{ lights: unknown[] }>("lights");
    assert.deepEqual(afterPromotion.lights, []);
  } finally {
    revived?.forceShutdown();
    client.close();
    await rig.close();
  }
});

test("resiliência: autenticação gRPC inválida não faz fallback para GraphQL", async () => {
  const rig = await makeRig("auth", { grpcAuthToken: generateTransportAuthToken() });
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 1000,
    authToken: rig.authToken,
    log: silentFe,
  });
  try {
    await assert.rejects(() => client.connect(), /authentication failed/i);
    assert.equal(client.technicalDiagnostics.activeTransport, "gRPC");
    assert.equal(client.technicalDiagnostics.resynchronizationCount, 0);
    assert.equal(client.latestProjectionSnapshot, undefined);
  } finally {
    client.close();
    await rig.close();
  }
});

test("telemetria do host é evento de CONTROLE: não vira comando aplicado nem lacuna no cursor", async () => {
  // A armadilha que este teste fixa: a telemetria viaja pelo MESMO diário dos
  // comandos. Entregue como evento de Blueprint, ela faria o `main` chamar
  // `commandApplied()` a cada janela de desenho — o projeto ficaria sujo e o
  // autosave gravaria arquivo sozinho enquanto o usuário só olha a janela do
  // host. E ignorá-la sem consumir o seq seria pior ainda: viraria lacuna, e
  // toda amostra custaria um resync completo.
  const rig = await makeRig("tlm");
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 2000,
    // Sondagem longa DE PROPÓSITO: no trecho do fallback, é ela que separa
    // "entregue no mesmo lote" de "entregue na sondagem seguinte" sem depender
    // de margem de tempo — a próxima só viria depois do timeout do teste.
    eventPollMs: 30_000,
    probeTickMs: 30_000,
    authToken: rig.authToken,
    router: { recoveryBackoffMs: [30_000], promoteAfterProbes: 2 },
    log: silentFe,
  });
  try {
    await client.connect();
    const blueprintEvents: string[] = [];
    const telemetria: RuntimeTelemetry[] = [];
    client.onBlueprintEvent((event) => blueprintEvents.push(event.kind));
    client.onRuntimeTelemetry((sample) => telemetria.push(sample));

    rig.journal.append(FRAME_TELEMETRY_EVENT_KIND, {
      frames: 60,
      windowMs: 1000,
      drawMsAvg: 1.5,
      drawMsMax: 4,
      camera: { x: 64, y: 32, zoom: 1 },
      frame: { quads: 96, quadsRequired: 96, truncated: false },
      scene: { actors: 2, lights: 1, tilemaps: 1 },
      engineSessionId: "host-1",
      reason: "first_sample",
    });

    await waitUntil(() => telemetria.length === 1, 5000, "telemetria não chegou ao canal próprio");
    assert.deepEqual(blueprintEvents, [], "telemetria não pode chegar como mutação do documento");
    assert.equal(telemetria[0]?.camera.x, 64);
    assert.equal(client.runtimeTelemetry?.engineSessionId, "host-1");

    // O comando SEGUINTE chega normalmente: o seq da telemetria foi consumido,
    // então não houve lacuna nem resync.
    await rig.sessions.dispatch({ kind: "camera/configure", settings: { response: 7 } });
    await waitUntil(
      () => blueprintEvents.includes("cameraConfigured"),
      5000,
      "o comando após a telemetria não foi entregue — o cursor abriu lacuna",
    );
    assert.deepEqual(blueprintEvents, ["cameraConfigured"]);

    // Agora o LOTE do fallback, onde a armadilha é outra: a telemetria não
    // pode INTERROMPER o lote. Tratá-la como condição de parada — o que a
    // troca de sessão legitimamente é — deixaria os eventos seguintes do
    // mesmo lote para a próxima sondagem.
    //
    // O arranjo torna isso determinístico em vez de uma corrida de relógio: o
    // gRPC cai, os dois eventos se acumulam SEM ninguém para entregá-los, e só
    // então uma chamada força o fallback — que sonda UMA vez, imediatamente.
    // Como `eventPollMs` é longo, a segunda sondagem está a 30 s de distância:
    // se o comando não vier junto da telemetria, ele não vem a tempo.
    rig.grpc.forceShutdown();
    rig.journal.append(FRAME_TELEMETRY_EVENT_KIND, {
      frames: 0,
      windowMs: 1000,
      drawMsAvg: 0,
      drawMsMax: 0,
      camera: { x: 64, y: 32, zoom: 1 },
      frame: { quads: 96, quadsRequired: 96, truncated: false },
      scene: { actors: 2, lights: 1, tilemaps: 1 },
      engineSessionId: "host-1",
      reason: "drawing_changed",
    });
    await rig.sessions.dispatch({ kind: "camera/configure", settings: { response: 8 } });

    await client.query("camera");
    assert.equal(client.technicalDiagnostics.activeTransport, "GraphQL fallback");
    await waitUntil(
      () => blueprintEvents.length === 2,
      5000,
      "o comando no MESMO lote da telemetria não foi entregue na sondagem dela",
    );
    assert.deepEqual(blueprintEvents, ["cameraConfigured", "cameraConfigured"]);
    assert.equal(telemetria.length, 2);
    assert.equal(telemetria[1]?.reason, "drawing_changed");
  } finally {
    client.close();
    await rig.close();
  }
});

test("resiliência: gap maior que EventJournal faz resync completo sem cauda parcial", async () => {
  const rig = await makeRig("gap", { journalCapacity: 2 });
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 1000,
    eventPollMs: 20,
    probeTickMs: 1000,
    authToken: rig.authToken,
    router: { recoveryBackoffMs: [10_000], promoteAfterProbes: 2 },
    log: silentFe,
  });
  const deliveredResponses: number[] = [];
  const resyncs: Array<{
    reason: string;
    firstAvailableSeq: string;
    lastEventSeq: string;
    response?: number;
  }> = [];
  try {
    await client.connect();
    client.onBlueprintEvent((event) => {
      const settings = event["settings"] as { response?: number } | undefined;
      if (settings?.response !== undefined) deliveredResponses.push(settings.response);
    });
    client.onResynchronized((snapshot, record) => {
      const camera = snapshot.projections["camera"] as
        | { camera?: { response?: number } }
        | undefined;
      resyncs.push({
        reason: record.reason,
        firstAvailableSeq: snapshot.firstAvailableSeq,
        lastEventSeq: snapshot.lastEventSeq,
        ...(camera?.camera?.response !== undefined ? { response: camera.camera.response } : {}),
      });
    });

    rig.grpc.forceShutdown();
    // Tudo ocorre no mesmo turno: o ring de capacidade 2 perde seq 1–2 antes
    // que o cliente possa iniciar o polling de fallback.
    for (let response = 1; response <= 4; response++) {
      await rig.sessions.dispatch({ kind: "camera/configure", settings: { response } });
    }

    await client.query("camera");
    assert.equal(client.technicalDiagnostics.activeTransport, "GraphQL fallback");
    await waitUntil(
      () => resyncs.some((entry) => entry.reason === "journal_gap"),
      5000,
      "gap do journal não provocou ressincronização",
    );

    const gapResync = resyncs.find((entry) => entry.reason === "journal_gap");
    assert.deepEqual(gapResync, {
      reason: "journal_gap",
      firstAvailableSeq: "3",
      lastEventSeq: "4",
      response: 4,
    });
    assert.equal(deliveredResponses.length, 0, "seq 3–4 não podem vazar como cauda parcial");

    // Depois do snapshot, a entrega incremental retoma exatamente em seq 5.
    await rig.sessions.dispatch({ kind: "camera/configure", settings: { response: 5 } });
    await waitUntil(
      () => deliveredResponses.includes(5),
      5000,
      "evento posterior ao resync não foi entregue",
    );
    assert.deepEqual(deliveredResponses, [5]);
    assert.equal(client.technicalDiagnostics.cursor?.lastEventSeq, "5");
  } finally {
    client.close();
    await rig.close();
  }
});

test(
  "resiliência: reinício completo do middleware troca instância, refaz snapshot e aceita seq reiniciado",
  { timeout: 45_000 },
  async () => {
    const pipeName = `gridsmith-restart-${process.pid}-${Date.now() % 100000}`;
    const authToken = generateTransportAuthToken();
    const client = new EditorClient(pipeName, {
      requestTimeoutMs: 1000,
      eventPollMs: 25,
      probeTickMs: 20,
      resyncRetryMs: 25,
      authToken,
      router: { recoveryBackoffMs: [15], promoteAfterProbes: 2 },
      log: silentFe,
    });
    let middleware = startMiddlewareProcess(pipeName, authToken);
    try {
      await waitUntil(
        async () => {
          const readiness = await client.probeReadiness().catch(() => undefined);
          return readiness?.graphqlActive === true && readiness.grpcActive === true;
        },
        15_000,
        () => `primeiro middleware não ficou pronto: ${middleware.stderr()}`,
      );
      await client.connect();
      await client.createProject();
      const previousInstanceId = client.technicalDiagnostics.cursor?.middlewareInstanceId;
      assert.ok(previousInstanceId);

      await client.dispatch("entitydef/define", {
        entityDefId: "before-restart-a",
        fields: [],
      });
      await client.dispatch("entitydef/define", {
        entityDefId: "before-restart-b",
        fields: [],
      });
      await waitUntil(
        () => client.technicalDiagnostics.cursor?.lastEventSeq === "3",
        5000,
        "cliente não consumiu os eventos do processo antigo",
      );

      await stopMiddlewareProcess(middleware.child);
      await assert.rejects(() => client.query("entityDefs"));
      assert.equal(client.technicalDiagnostics.activeTransport, "GraphQL fallback");

      const restartResyncs: Array<{
        snapshot: ProjectionSnapshot;
        record: ResynchronizationRecord;
      }> = [];
      client.onResynchronized((snapshot, record) => restartResyncs.push({ snapshot, record }));

      middleware = startMiddlewareProcess(pipeName, authToken);
      await waitUntil(
        async () => {
          const readiness = await client.probeReadiness().catch(() => undefined);
          return readiness?.graphqlActive === true && readiness.grpcActive === true;
        },
        15_000,
        () => `middleware reiniciado não ficou pronto: ${middleware.stderr()}`,
      );
      await waitUntil(
        () => restartResyncs.some(({ record }) => record.reason === "instance_changed"),
        10_000,
        "mudança de middlewareInstanceId não provocou snapshot completo",
      );

      const restarted = restartResyncs.find(({ record }) => record.reason === "instance_changed");
      assert.ok(restarted);
      assert.equal(restarted.record.previousMiddlewareInstanceId, previousInstanceId);
      assert.notEqual(restarted.record.middlewareInstanceId, previousInstanceId);
      assert.equal(restarted.record.lastEventSeq, "0");
      assert.equal(restarted.snapshot.firstAvailableSeq, "1");
      // uma entrada por QUERYABLE_PROJECTIONS — cresceu com a projeção "tilesets" (v5)
      assert.equal(Object.keys(restarted.snapshot.projections).length, 10);
      assert.equal(client.latestProjectionSnapshot?.middlewareInstanceId, restarted.record.middlewareInstanceId);

      const deliveredAfterRestart: string[] = [];
      client.onBlueprintEvent((event) => deliveredAfterRestart.push(String(event["kind"] ?? "")));
      await client.createProject();
      await client.dispatch("entitydef/define", {
        entityDefId: "after-restart",
        fields: [],
      });
      await waitUntil(
        () => deliveredAfterRestart.includes("entityDefDefined"),
        5000,
        "evento seq 1 do processo novo foi descartado pelo cursor antigo",
      );
      assert.deepEqual(deliveredAfterRestart, ["entityDefDefined"]);
      assert.equal(client.technicalDiagnostics.cursor?.middlewareInstanceId, restarted.record.middlewareInstanceId);
      assert.equal(client.technicalDiagnostics.cursor?.lastEventSeq, "2");
    } finally {
      client.close();
      await stopMiddlewareProcess(middleware.child);
    }
  },
);

interface MiddlewareProcess {
  child: ChildProcess;
  stderr(): string;
}

function startMiddlewareProcess(pipeName: string, authToken: string): MiddlewareProcess {
  const entry = fileURLToPath(new URL("../../middleware/dist/index.js", import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GRIDSMITH_EDITOR_AUTH_TOKEN: authToken,
    GRIDSMITH_VERBOSITY: "silent",
  };
  delete env["GRIDSMITH_EDITOR_AUTH_TOKEN_FILE"];
  const child = spawn(process.execPath, [entry, "--pipe", pipeName, "--no-mcp"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8000);
  });
  return { child, stderr: () => diagnostics };
}

async function stopMiddlewareProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  failure: string | (() => string),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(typeof failure === "function" ? failure() : failure);
}
