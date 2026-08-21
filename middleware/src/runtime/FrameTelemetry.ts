/**
 * Telemetria de frame: o fio de volta do host gráfico (ADR-023).
 *
 * Este módulo é PURO — valida a amostra que chega pelo fio e decide se ela
 * merece virar evento no `EventJournal`. Não conhece transporte, não conhece o
 * diário e não guarda relógio próprio: quem chama informa o instante.
 *
 * **O problema que a política resolve.** O diário é um anel de capacidade fixa
 * com uma promessa forte: nenhum cliente perde evento dentro da janela. A
 * telemetria é o oposto de um evento — é um sinal CONTÍNUO, e perder uma
 * amostra não custa nada. Despejar uma amostra por segundo num anel de 512
 * gastaria a janela inteira em menos de nove minutos, e o que sairia dela
 * primeiro seriam justamente os comandos que ninguém pode perder.
 *
 * **As duas propriedades que a política garante:**
 *
 * 1. **Silêncio é de graça.** Host aberto sem nada acontecendo não publica
 *    NADA. Um batimento periódico parecia inofensivo e não é: 12 eventos por
 *    minuto esvaziam um anel de 512 em pouco mais de 40 minutos de ociosidade
 *    — o anel pagaria caro para repetir "nada mudou".
 * 2. **Teto de taxa quando muda.** Toda publicação (menos a primeira de cada
 *    host) respeita o mesmo intervalo mínimo. Uma mudança represada não se
 *    perde: a comparação é sempre contra a última amostra PUBLICADA, então ela
 *    sai assim que a janela abre.
 *
 * Quando a onda B precisar da câmera viva a 60 Hz, o caminho é um canal de
 * baixa latência ao lado do diário — não aumentar a taxa aqui.
 */

export interface FrameTelemetryCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface FrameTelemetryFrame {
  readonly quads: number;
  readonly quadsRequired: number;
  readonly truncated: boolean;
}

export interface FrameTelemetryScene {
  readonly actors: number;
  readonly lights: number;
  readonly tilemaps: number;
}

/** Uma janela de desenho reportada pelo host. */
export interface FrameTelemetrySample {
  readonly frames: number;
  readonly windowMs: number;
  readonly drawMsAvg: number;
  readonly drawMsMax: number;
  readonly camera: FrameTelemetryCamera;
  readonly frame: FrameTelemetryFrame;
  readonly scene: FrameTelemetryScene;
}

/**
 * Por que a amostra virou evento. Viaja NO evento: sem isso, quem lê o diário
 * vê amostras esparsas e não sabe se está olhando uma mudança real ou o
 * batimento — e passaria a inferir isso comparando eventos, que é exatamente
 * o trabalho que a política já fez.
 */
export type FrameTelemetryReason =
  | "first_sample"
  | "scene_changed"
  | "frame_health_changed"
  | "drawing_changed"
  | "frame_changed"
  | "camera_moved";

export interface FrameTelemetryDecision {
  readonly journal: boolean;
  readonly reason?: FrameTelemetryReason;
}

/**
 * Teto de taxa: distância mínima entre dois eventos de telemetria no diário.
 *
 * NÃO é um batimento — nada é publicado só porque o tempo passou. É o quanto
 * uma mudança pode esperar para aparecer, e o que limita o gasto do anel
 * quando a cena está viva.
 *
 * **O valor é derivado, não escolhido:** o pior caso realista é uma hora
 * inteira de câmera em movimento contínuo, que publica `3600 / intervalo`
 * eventos. Para que a telemetria sozinha nunca rotacione o anel do
 * `EventJournal` (512), o intervalo precisa ser de pelo menos ~7 s; 10 s dá
 * 360 eventos nessa hora e deixa mais de 150 lugares para o que veio antes.
 * Mudar a capacidade do diário sem revisitar este número volta a colocar a
 * telemetria na frente dos comandos — o teste da hora patológica falha se
 * isso acontecer.
 */
export const TELEMETRY_MIN_INTERVAL_MS = 10_000;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Valida a notificação vinda do fio (`contracts/schemas/frame.telemetry.schema.json`).
 *
 * A engine é um processo separado, possivelmente de outra versão: uma amostra
 * malformada é DESCARTADA, nunca propagada nem lançada. Deixar `NaN` entrar
 * aqui contaminaria a comparação da política e o evento publicado aos dois
 * transports.
 */
export function parseFrameTelemetry(params: unknown): FrameTelemetrySample | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const camera = p["camera"] as Record<string, unknown> | undefined;
  const frame = p["frame"] as Record<string, unknown> | undefined;
  const scene = p["scene"] as Record<string, unknown> | undefined;
  if (!camera || !frame || !scene) return undefined;

  if (
    !isCount(p["frames"]) ||
    !isFiniteNumber(p["windowMs"]) ||
    !isFiniteNumber(camera["x"]) ||
    !isFiniteNumber(camera["y"]) ||
    !isFiniteNumber(camera["zoom"]) ||
    !isCount(frame["quads"]) ||
    !isCount(frame["quadsRequired"]) ||
    typeof frame["truncated"] !== "boolean" ||
    !isCount(scene["actors"]) ||
    !isCount(scene["lights"]) ||
    !isCount(scene["tilemaps"])
  ) {
    return undefined;
  }

  return Object.freeze({
    frames: p["frames"],
    windowMs: p["windowMs"],
    // Opcionais no schema: um host que ainda não meça o tempo de desenho
    // reporta a janela sem eles em vez de mentir um zero medido.
    drawMsAvg: isFiniteNumber(p["drawMsAvg"]) ? p["drawMsAvg"] : 0,
    drawMsMax: isFiniteNumber(p["drawMsMax"]) ? p["drawMsMax"] : 0,
    camera: Object.freeze({ x: camera["x"], y: camera["y"], zoom: camera["zoom"] }),
    frame: Object.freeze({
      quads: frame["quads"],
      quadsRequired: frame["quadsRequired"],
      truncated: frame["truncated"],
    }),
    scene: Object.freeze({
      actors: scene["actors"],
      lights: scene["lights"],
      tilemaps: scene["tilemaps"],
    }),
  });
}

export interface JournaledTelemetry {
  readonly sample: FrameTelemetrySample;
  readonly atMs: number;
}

/**
 * Decide se a amostra entra no diário.
 *
 * O teto de taxa vale para TODAS as razões (menos a primeira amostra de cada
 * host), inclusive as discretas. Parece severo e não é: a mudança represada
 * continua visível na comparação — que é sempre contra a última amostra
 * PUBLICADA — e sai inteira assim que a janela abre. O que a uniformidade
 * compra é imunidade a oscilação: um nível parado exatamente no teto de quads
 * faria `truncated` piscar a cada frame, e uma exceção "mudança discreta passa
 * na hora" transformaria essa oscilação em enxurrada.
 *
 * Desempenho (fps, tempo de desenho) não decide nada: oscila sempre, e nenhuma
 * oscilação dele muda o que está na tela. Ele viaja de carona nos eventos que
 * as outras razões publicam.
 */
export function decideTelemetryJournaling(
  previous: JournaledTelemetry | undefined,
  next: FrameTelemetrySample,
  nowMs: number,
  minIntervalMs: number = TELEMETRY_MIN_INTERVAL_MS,
): FrameTelemetryDecision {
  if (!previous) return { journal: true, reason: "first_sample" };
  if (nowMs - previous.atMs < minIntervalMs) return { journal: false };

  const before = previous.sample;
  if (
    before.scene.actors !== next.scene.actors ||
    before.scene.lights !== next.scene.lights ||
    before.scene.tilemaps !== next.scene.tilemaps
  ) {
    return { journal: true, reason: "scene_changed" };
  }

  // Começar (ou parar) de truncar é a diferença entre ver o nível inteiro e
  // ver um pedaço dele: é mudança de imagem, não de desempenho.
  if (before.frame.truncated !== next.frame.truncated) {
    return { journal: true, reason: "frame_health_changed" };
  }

  // Desenhar × não desenhar. `frames === 0` é a janela em que o host existiu e
  // não desenhou — minimizado, sem foco ou travado.
  if ((before.frames === 0) !== (next.frames === 0)) {
    return { journal: true, reason: "drawing_changed" };
  }

  // O que o host DESENHOU mudou: é a confirmação de que o comando chegou à
  // imagem, e não só ao documento.
  if (
    before.frame.quads !== next.frame.quads ||
    before.frame.quadsRequired !== next.frame.quadsRequired
  ) {
    return { journal: true, reason: "frame_changed" };
  }

  if (
    before.camera.x !== next.camera.x ||
    before.camera.y !== next.camera.y ||
    before.camera.zoom !== next.camera.zoom
  ) {
    return { journal: true, reason: "camera_moved" };
  }

  // Nada mudou: o anel não paga por silêncio.
  return { journal: false };
}
