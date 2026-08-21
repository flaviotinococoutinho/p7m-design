/**
 * Telemetria de frame (ADR-023): a política que mantém um sinal CONTÍNUO
 * observável dentro de um diário de eventos DISCRETOS.
 *
 * O que estes testes protegem não é o formato da amostra — é a promessa do
 * `EventJournal`: o anel tem capacidade fixa, e quem o gastar com telemetria
 * empurra para fora dele os comandos que ninguém pode perder.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  decideTelemetryJournaling,
  parseFrameTelemetry,
  TELEMETRY_MIN_INTERVAL_MS,
  type FrameTelemetrySample,
} from "../src/runtime/FrameTelemetry.js";
import {
  bindFrameTelemetryJournal,
  FRAME_TELEMETRY_EVENT_KIND,
  type FrameTelemetryEventPayload,
} from "../src/runtime/FrameTelemetryJournal.js";
import { EventJournal } from "../src/transport/EventJournal.js";
import type { EngineSession } from "../src/ipc/EnginePipeServer.js";

const wire = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  frames: 60,
  windowMs: 1000,
  drawMsAvg: 1.5,
  drawMsMax: 4,
  camera: { x: 64, y: 32, zoom: 1 },
  frame: { quads: 96, quadsRequired: 96, truncated: false },
  scene: { actors: 2, lights: 1, tilemaps: 1 },
  ...overrides,
});

const sample = (overrides: Partial<FrameTelemetrySample> = {}): FrameTelemetrySample => ({
  ...parseFrameTelemetry(wire())!,
  ...overrides,
});

const fakeSession = (sessionId: string): EngineSession =>
  ({ sessionId, clientName: "Gridsmith.Engine.Host" }) as EngineSession;

test("amostra malformada é descartada — NaN não pode entrar na comparação nem no evento", () => {
  assert.ok(parseFrameTelemetry(wire()));
  assert.equal(parseFrameTelemetry(undefined), undefined);
  assert.equal(parseFrameTelemetry({ frames: 1 }), undefined);
  assert.equal(parseFrameTelemetry(wire({ frames: -1 })), undefined);
  assert.equal(parseFrameTelemetry(wire({ frames: 1.5 })), undefined);
  assert.equal(parseFrameTelemetry(wire({ windowMs: Number.NaN })), undefined);
  assert.equal(parseFrameTelemetry(wire({ camera: { x: 0, y: 0 } })), undefined);
  assert.equal(
    parseFrameTelemetry(wire({ frame: { quads: 1, quadsRequired: 1, truncated: "sim" } })),
    undefined,
  );
  // o host pode ainda não medir tempo de desenho; a janela continua válida
  const semTempos = parseFrameTelemetry(wire({ drawMsAvg: undefined, drawMsMax: undefined }));
  assert.equal(semTempos?.drawMsAvg, 0);
});

test("a primeira amostra sempre entra: sem ela o diário não diz que o host começou a desenhar", () => {
  const decision = decideTelemetryJournaling(undefined, sample(), 1_000);
  assert.deepEqual(decision, { journal: true, reason: "first_sample" });
});

test("cada tipo de mudança tem a sua razão, e desempenho não é nenhuma delas", () => {
  const previous = { sample: sample(), atMs: 1_000 };
  const depois = 1_000 + TELEMETRY_MIN_INTERVAL_MS; // janela de taxa aberta

  // a cena mudou: alguém colocou um ator, e isso é um fato do documento
  assert.deepEqual(
    decideTelemetryJournaling(
      previous,
      sample({ scene: { actors: 3, lights: 1, tilemaps: 1 } }),
      depois,
    ),
    { journal: true, reason: "scene_changed" },
  );

  // começou a truncar: a janela deixou de mostrar o nível inteiro
  assert.deepEqual(
    decideTelemetryJournaling(
      previous,
      sample({ frame: { quads: 96, quadsRequired: 200, truncated: true } }),
      depois,
    ),
    { journal: true, reason: "frame_health_changed" },
  );

  // parou de desenhar (minimizado, travado): silêncio seria indistinguível
  // de "tudo bem"
  assert.deepEqual(decideTelemetryJournaling(previous, sample({ frames: 0 }), depois), {
    journal: true,
    reason: "drawing_changed",
  });

  // o que foi desenhado mudou: o comando chegou à IMAGEM, não só ao documento
  assert.deepEqual(
    decideTelemetryJournaling(
      previous,
      sample({ frame: { quads: 120, quadsRequired: 120, truncated: false } }),
      depois,
    ),
    { journal: true, reason: "frame_changed" },
  );

  assert.deepEqual(
    decideTelemetryJournaling(previous, sample({ camera: { x: 999, y: -12, zoom: 3 } }), depois),
    { journal: true, reason: "camera_moved" },
  );

  // fps e tempo de desenho oscilam sempre e não mudam nada do que está na
  // tela: se decidissem, todo host publicaria no teto da taxa para sempre
  assert.deepEqual(
    decideTelemetryJournaling(previous, sample({ frames: 12, drawMsAvg: 40, drawMsMax: 80 }), depois),
    { journal: false },
  );
});

test("o teto de taxa vale para TODAS as razões, e a mudança represada não se perde", () => {
  const previous = { sample: sample(), atMs: 1_000 };
  const mudou = sample({ scene: { actors: 3, lights: 1, tilemaps: 1 } });

  // cedo demais: nem mudança discreta fura o teto — é o que impede que um
  // `truncated` oscilando no limite do buffer vire enxurrada
  assert.deepEqual(
    decideTelemetryJournaling(previous, mudou, 1_000 + TELEMETRY_MIN_INTERVAL_MS - 1),
    { journal: false },
  );

  // e a mudança continua lá quando a janela abre: a comparação é contra a
  // última amostra PUBLICADA, não contra a última recebida
  assert.deepEqual(decideTelemetryJournaling(previous, mudou, 1_000 + TELEMETRY_MIN_INTERVAL_MS), {
    journal: true,
    reason: "scene_changed",
  });
});

test("uma hora de host ocioso NÃO gasta um único lugar do anel", () => {
  // A regressão que este teste existe para pegar: publicar toda amostra faria
  // 3600 eventos em uma hora e expulsaria do anel (512) TODOS os comandos do
  // projeto. Um batimento periódico parecia a correção óbvia e não era — a
  // 12/min ele esvazia o mesmo anel em pouco mais de 40 minutos, pagando caro
  // para repetir "nada mudou".
  const journal = new EventJournal();
  journal.activateSession("sessao-projeto", "projeto", 0n);
  const bus = new EventEmitter();
  let clock = 0;
  bindFrameTelemetryJournal(bus, journal, { now: () => clock });

  journal.append("level/define", { levelId: "mapa" });
  const comandoSeq = journal.lastSeq;

  const session = fakeSession("host-1");
  const parado = sample();
  for (let segundo = 0; segundo < 3600; segundo++) {
    clock = segundo * 1_000;
    // o host DESENHA o tempo todo (60 fps, tempos oscilando); o que não muda
    // é a imagem
    bus.emit("frameTelemetry", session, {
      ...parado,
      drawMsAvg: 1 + (segundo % 7) / 10,
      drawMsMax: 3 + (segundo % 5),
    });
  }

  // exatamente uma: a primeira amostra do host. Nada mais aconteceu.
  assert.equal(journal.since(comandoSeq).length, 1);
  assert.ok(journal.canResumeFrom(comandoSeq - 1n));
});

test("a hora patológica — câmera em movimento contínuo — não rotaciona o anel sozinha", () => {
  // É este teste que sustenta o valor de TELEMETRY_MIN_INTERVAL_MS: ele o
  // amarra à CAPACIDADE do diário. Encurtar o intervalo ou encolher o anel
  // sem revisitar o outro põe a telemetria na frente dos comandos, e a falha
  // aparece aqui em vez de em produção, meses depois, como um resync
  // inexplicável.
  const journal = new EventJournal();
  journal.activateSession("sessao-projeto", "projeto", 0n);
  const bus = new EventEmitter();
  let clock = 0;
  bindFrameTelemetryJournal(bus, journal, { now: () => clock });

  journal.append("level/define", { levelId: "mapa" });
  const comandoSeq = journal.lastSeq;

  const session = fakeSession("host-1");
  for (let segundo = 0; segundo < 3600; segundo++) {
    clock = segundo * 1_000;
    bus.emit("frameTelemetry", session, sample({ camera: { x: segundo, y: 0, zoom: 1 } }));
  }

  const publicados = journal.since(comandoSeq).length;
  assert.equal(publicados, 1 + Math.floor((3599 * 1_000) / TELEMETRY_MIN_INTERVAL_MS));
  assert.ok(
    publicados < journal.capacity,
    `uma hora de telemetria não pode encher o anel de ${journal.capacity} (${publicados})`,
  );
  // o comando de antes da hora continua alcançável: é a promessa do diário
  assert.ok(journal.canResumeFrom(comandoSeq - 1n));
});

test("o evento diz POR QUE foi publicado e de qual host veio", () => {
  const journal = new EventJournal();
  journal.activateSession("sessao-projeto", "projeto", 0n);
  const bus = new EventEmitter();
  let clock = 0;
  bindFrameTelemetryJournal(bus, journal, { now: () => clock });

  bus.emit("frameTelemetry", fakeSession("host-1"), sample());
  const primeiro = journal.since(0n).at(-1)!;
  assert.equal(primeiro.kind, FRAME_TELEMETRY_EVENT_KIND);
  const payload = primeiro.payload as FrameTelemetryEventPayload;
  assert.equal(payload.reason, "first_sample");
  assert.equal(payload.engineSessionId, "host-1");
  assert.equal(payload.camera.x, 64);
  assert.equal(payload.scene.lights, 1);

  // Host reiniciado: comparar a primeira janela do host novo com a última do
  // anterior diria "nada mudou" no exato momento em que alguém está olhando.
  clock = 10;
  bus.emit("frameTelemetry", fakeSession("host-2"), sample());
  const segundo = journal.since(primeiro.seq).at(-1)!;
  assert.equal((segundo.payload as FrameTelemetryEventPayload).reason, "first_sample");
  assert.equal((segundo.payload as FrameTelemetryEventPayload).engineSessionId, "host-2");
});

test("desligar o fio para de publicar (a composição é simétrica)", () => {
  const journal = new EventJournal();
  journal.activateSession("sessao-projeto", "projeto", 0n);
  const bus = new EventEmitter();
  const unbind = bindFrameTelemetryJournal(bus, journal, { now: () => 0 });

  bus.emit("frameTelemetry", fakeSession("host-1"), sample());
  const depoisDaPrimeira = journal.lastSeq;
  unbind();
  bus.emit("frameTelemetry", fakeSession("host-2"), sample());

  assert.equal(journal.lastSeq, depoisDaPrimeira);
});
