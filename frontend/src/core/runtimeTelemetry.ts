/**
 * Telemetria do host gráfico no lado do editor (ADR-023).
 *
 * O host reporta o que DESENHOU; o middleware coalesce as amostras e publica
 * as que mudam alguma coisa no `EventJournal`. Aqui existe só a forma do que
 * chega e o que se deriva dela — módulo puro (regra F1), sem transporte.
 *
 * O kind é uma constante espelhada do middleware, e um teste afirma a
 * igualdade: divergir o nome faria o app parar de ver a telemetria em
 * silêncio, sem nenhuma linha vermelha em lugar nenhum.
 */

export const FRAME_TELEMETRY_EVENT_KIND = "runtime/frameTelemetry";

export type RuntimeTelemetryReason =
  | "first_sample"
  | "scene_changed"
  | "frame_health_changed"
  | "drawing_changed"
  | "frame_changed"
  | "camera_moved";

export interface RuntimeTelemetry {
  readonly frames: number;
  readonly windowMs: number;
  readonly drawMsAvg: number;
  readonly drawMsMax: number;
  readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly frame: {
    readonly quads: number;
    readonly quadsRequired: number;
    readonly truncated: boolean;
  };
  readonly scene: {
    readonly actors: number;
    readonly lights: number;
    readonly tilemaps: number;
  };
  readonly engineSessionId: string;
  readonly reason: RuntimeTelemetryReason;
}

/**
 * Quadros por segundo da janela reportada.
 *
 * Derivado aqui, e não enviado pelo fio, porque `frames` e `windowMs` são o
 * que foi MEDIDO — a divisão é interpretação, e interpretação que viaja pelo
 * fio não pode ser corrigida sem mexer nas duas pontas. Janela sem duração
 * devolve 0 em vez de infinito: um número impossível na barra de status é
 * pior do que um zero honesto.
 */
export function telemetryFps(sample: RuntimeTelemetry): number {
  if (!(sample.windowMs > 0)) return 0;
  return (sample.frames * 1000) / sample.windowMs;
}

/** O host está desenhando? Janela sem frame nenhum é a resposta "não". */
export function isDrawing(sample: RuntimeTelemetry): boolean {
  return sample.frames > 0;
}
