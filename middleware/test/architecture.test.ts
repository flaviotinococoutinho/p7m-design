/**
 * TESTES ARQUITETURAIS (fitness functions) — docs/GOVERNANCE.md.
 *
 * Cada regra de governança do middleware é uma asserção executável sobre o
 * grafo de imports real de src/. Uma violação quebra o CI com a regra e o
 * arquivo infrator no erro — a arquitetura não depende de disciplina, depende
 * de teste.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

interface Module {
  /** Caminho relativo a src/, com "/" POSIX. */
  readonly file: string;
  /** Especificadores importados (inclui type-imports e dynamic imports). */
  readonly imports: readonly string[];
}

function listModules(): Module[] {
  const files = fs
    .readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.split(path.sep).join("/"));

  return files.map((file) => {
    const source = fs.readFileSync(path.join(SRC, file), "utf8");
    const imports: string[] = [];
    const pattern = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of source.matchAll(pattern)) {
      imports.push((match[1] ?? match[2])!);
    }
    return { file, imports };
  });
}

/** Resolve import relativo para caminho relativo a src/ ("a/b.js" sem ./..). */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  return resolved.replace(/\.js$/, ".ts");
}

const modules = listModules();

function violations(
  filter: (file: string) => boolean,
  isForbidden: (resolvedTarget: string | undefined, rawSpecifier: string) => boolean,
): string[] {
  const found: string[] = [];
  for (const module_ of modules) {
    if (!filter(module_.file)) continue;
    for (const specifier of module_.imports) {
      const target = resolveRelative(module_.file, specifier);
      if (isForbidden(target, specifier)) {
        found.push(`${module_.file} → ${specifier}`);
      }
    }
  }
  return found;
}

test("R1: SDK do MCP e zod são exclusivos da camada mcp/ (fachadas finas)", () => {
  const offenders = violations(
    (file) => !file.startsWith("mcp/"),
    (_target, raw) => raw.startsWith("@modelcontextprotocol") || raw === "zod",
  );
  assert.deepEqual(offenders, []);
});

test("R2: o modelo canônico não conhece transporte, MCP, adapters concretos nem planos de dados", () => {
  const offenders = violations(
    (file) => file.startsWith("canonical/"),
    (target) =>
      target !== undefined &&
      (target.startsWith("ipc/") ||
        target.startsWith("mcp/") ||
        target.startsWith("graphql/") ||
        target.startsWith("grpc/") ||
        target.startsWith("transport/") ||
        target.startsWith("sharedmem/") ||
        target.startsWith("assets/") ||
        target.startsWith("tools/") ||
        target === "runtime/MonoGameAdapter.ts" ||
        target === "index.ts"),
  );
  assert.deepEqual(offenders, []);
});

test("R3: o coração do domínio (BlueprintStore) só importa validadores puros e o protocolo de erros", () => {
  const store = modules.find((m) => m.file === "domain/BlueprintStore.ts")!;
  const allowed = ["node:events", "../leveldesign/AutoTiler.js", "../protocol/jsonrpc.js"];
  assert.deepEqual(
    store.imports.filter((i) => !allowed.includes(i)),
    [],
    `BlueprintStore must stay pure (allowed: ${allowed.join(", ")})`,
  );
});

test("R4: perfis de runtime são dados declarativos (só importam o contrato RuntimeProfile)", () => {
  const offenders = violations(
    (file) => file.startsWith("runtime/profiles/"),
    (target, raw) => target !== "runtime/RuntimeProfile.ts" && raw.startsWith("."),
  );
  assert.deepEqual(offenders, []);
});

test("R5: núcleos algorítmicos (AutoTiler, AsepriteImporter, fnv1a, FrameTelemetry) não importam NADA de outras camadas", () => {
  // FrameTelemetry entra aqui porque a borda (ipc/) o importa para validar a
  // notificação que chega da engine: uma política que arrastasse o diário ou
  // o adapter junto contaminaria a borda com a camada de runtime inteira.
  for (const pure of [
    "leveldesign/AutoTiler.ts",
    "assets/AsepriteImporter.ts",
    "util/fnv1a.ts",
    "runtime/FrameTelemetry.ts",
  ]) {
    const module_ = modules.find((m) => m.file === pure)!;
    assert.deepEqual(
      [...module_.imports],
      [],
      `${pure} must be a dependency-free algorithm (portable to workers)`,
    );
  }
});

test("R6: sockets (node:net) só existem na borda de transporte (ipc/, tools/)", () => {
  const offenders = violations(
    (file) => !file.startsWith("ipc/") && !file.startsWith("tools/") && file !== "index.ts",
    (_target, raw) => raw === "node:net" || raw === "net",
  );
  assert.deepEqual(offenders, []);
});

test("R7: adapters concretos só são referenciados pela composição (index, tools) — nunca por domínio/canônico/gateway", () => {
  const offenders = violations(
    (file) =>
      file !== "index.ts" &&
      !file.startsWith("tools/") &&
      !file.startsWith("runtime/") &&
      !file.startsWith("mcp/"),
    (target) => target === "runtime/MonoGameAdapter.ts",
  );
  assert.deepEqual(offenders, []);
});

test("R8: todo kind de comando do Blueprint é despachável pelas bordas (COMMAND_KINDS completo)", async () => {
  const { COMMAND_KINDS } = await import("../src/canonical/commandShape.js");
  const storeSource = fs.readFileSync(path.join(SRC, "domain/BlueprintStore.ts"), "utf8");
  const declaredKinds = [...storeSource.matchAll(/readonly kind: "([^"]+)"/g)]
    .map((m) => m[1]!)
    // eventos usam camelCase; comandos usam namespace/verbo
    .filter((kind) => kind.includes("/"));
  const unique = [...new Set(declaredKinds)].sort();
  assert.deepEqual(
    unique,
    [...COMMAND_KINDS].sort(),
    "every BlueprintCommand kind must be exposed in COMMAND_KINDS (MCP + editor gateway)",
  );
});

test("R9: constantes de framing casam com o contrato publicado", async () => {
  const framing = await import("../src/protocol/framing.js");
  assert.equal(framing.HEADER_BYTES, 4);
  assert.equal(framing.MAX_FRAME_BYTES, 16 * 1024 * 1024);
  const { MAX_LEVEL_CELLS } = await import("../src/domain/BlueprintStore.js");
  assert.equal(MAX_LEVEL_CELLS, 256 * 256, "must match engine TilemapStore.MaxCells");
});

test("R10: a lib graphql é exclusiva da borda graphql/ (fachada fina, zero domínio)", () => {
  const offenders = violations(
    (file) => !file.startsWith("graphql/"),
    (_target, raw) => raw === "graphql" || raw.startsWith("graphql/"),
  );
  assert.deepEqual(offenders, []);
});

test("R11: as libs gRPC são exclusivas da borda grpc/ (fachada fina, zero domínio)", () => {
  const offenders = violations(
    (file) => !file.startsWith("grpc/"),
    (_target, raw) => raw.startsWith("@grpc/"),
  );
  assert.deepEqual(offenders, []);
});

test("R12: as bordas de transporte do app (graphql/, grpc/) não importam domínio interno além da superfície", () => {
  // fachadas finas: só EditorSurface, EventJournal/endpoints, protocolo de
  // erros e o logger — nunca BlueprintStore/orquestrador/adapters diretos
  const allowedPrefixes = [
    "canonical/EditorSurface.ts",
    "transport/",
    "protocol/jsonrpc.ts",
    "util/log.ts",
  ];
  const offenders = violations(
    (file) => file.startsWith("graphql/") || file.startsWith("grpc/"),
    (target) =>
      target !== undefined && !allowedPrefixes.some((p) => target === p || target.startsWith(p)),
  );
  assert.deepEqual(offenders, []);
});

test("R13: EditorSurface e as quatro bordas resolvem a sessão por uma única porta substituível", () => {
  const surface = fs.readFileSync(path.join(SRC, "canonical/EditorSurface.ts"), "utf8");
  const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf8");
  const legacy = fs.readFileSync(path.join(SRC, "ipc/EditorGateway.ts"), "utf8");
  const mcp = fs.readFileSync(path.join(SRC, "mcp/McpFacade.ts"), "utf8");

  assert.doesNotMatch(surface, /interface EditorSurfaceOptions\s*{[^}]*\bstore\s*:/);
  assert.doesNotMatch(surface, /interface EditorSurfaceOptions\s*{[^}]*\borchestrator\s*:/);
  assert.equal((index.match(/new EditorSurface\(/g) ?? []).length, 1, "composition owns one surface");
  assert.match(legacy, /surface:\s*EditorSurface/);
  assert.doesNotMatch(legacy, /new EditorSurface\(/);
  assert.doesNotMatch(mcp, /canonical\.orchestrator/);
  assert.match(mcp, /canonical\.surface\.dispatchByKind/);
});
