import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_TELEMETRY_EVENT_KIND as MIDDLEWARE_KIND } from "@gridsmith/middleware/dist/runtime/FrameTelemetryJournal.js";
import {
  FRAME_TELEMETRY_EVENT_KIND,
  isDrawing,
  telemetryFps,
  type RuntimeTelemetry,
} from "../src/core/runtimeTelemetry.js";

const sample = (overrides: Partial<RuntimeTelemetry> = {}): RuntimeTelemetry => ({
  frames: 60,
  windowMs: 1000,
  drawMsAvg: 1.5,
  drawMsMax: 4,
  camera: { x: 0, y: 0, zoom: 1 },
  frame: { quads: 96, quadsRequired: 96, truncated: false },
  scene: { actors: 1, lights: 0, tilemaps: 1 },
  engineSessionId: "host-1",
  reason: "first_sample",
  ...overrides,
});

test("o kind é o MESMO dos dois lados do fio", () => {
  // Divergir o nome não quebraria compilação nenhuma: o app simplesmente
  // pararia de ver telemetria, e o sintoma seria "o painel não atualiza".
  assert.equal(FRAME_TELEMETRY_EVENT_KIND, MIDDLEWARE_KIND);
});

test("fps é derivado da janela medida, e janela sem duração vale zero", () => {
  assert.equal(telemetryFps(sample()), 60);
  assert.equal(telemetryFps(sample({ frames: 30, windowMs: 500 })), 60);
  // sem esta guarda a barra de status exibiria Infinity — um número
  // impossível é pior do que um zero honesto
  assert.equal(telemetryFps(sample({ windowMs: 0 })), 0);
  assert.equal(telemetryFps(sample({ frames: 0 })), 0);
});

test("janela sem frame nenhum é o host NÃO desenhando", () => {
  assert.equal(isDrawing(sample()), true);
  assert.equal(isDrawing(sample({ frames: 0 })), false);
});
