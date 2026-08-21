#!/usr/bin/env node
/**
 * Verificação automática da documentação (Gridsmith).
 *
 * Reduz o drift entre docs e repositório validando, sem julgamento humano:
 *  - links Markdown internos e arquivos relativos citados existem;
 *  - documentos e scripts obrigatórios existem (inclui verify-phase1..4,
 *    verify-transports.sh, docs/COMPATIBILITY.md, ADRs e os contratos
 *    GraphQL/gRPC do app);
 *  - referências a schemas `contracts/schemas/*.json` existem;
 *  - os JSON Schemas de `contracts/` são sintaticamente válidos, sem `$ref`
 *    pendurado e sem `required` citando propriedade não declarada;
 *  - o conjunto de comandos canônicos é IDÊNTICO nas três fontes
 *    declarativas: `COMMAND_KINDS`, o enum `CommandKind` do SDL e os `$defs`
 *    de `contracts/schemas/blueprint.commands.schema.json`;
 *  - NÃO há referências transitórias a branches/sessões de geração;
 *  - todo comando `npm run <x>` documentado existe em algum package.json;
 *  - o workflow de CI executa os gates de transports e de documentação;
 *  - NÃO há contagens de teste fixadas manualmente (devem vir do CI).
 *
 * Uso: `npm run docs:verify` (ou `node scripts/verify-docs.mjs`) na raiz.
 * Sai com código 1 se houver qualquer violação.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const IGNORE = new Set(["node_modules", ".git", "obj", "bin", "dist", ".gridsmith-build"]);

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

const REQUIRED = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/ARCHITECTURE-SPEC.md",
  "docs/GOVERNANCE.md",
  "docs/REQUIREMENTS.md",
  "docs/ALPHA-0.1.md",
  "docs/COMPATIBILITY.md",
  "docs/CANONICAL-MODEL.md",
  "docs/OPPORTUNITIES.md",
  "docs/PRODUCT.md",
  "docs/PRODUCT-STRATEGY.md",
  "docs/RESEARCH-EDITOR-LANDSCAPE.md",
  "docs/adr/README.md",
  "docs/adr/ADR-019-freeze-medido-dos-transports.md",
  "docs/adr/ADR-020-sessao-de-projeto-transacional.md",
  "docs/adr/ADR-022-host-grafico-como-composicao.md",
  "docs/adr/ADR-023-telemetria-de-frame-no-diario-de-eventos.md",
  "contracts/README.md",
  "contracts/schemas/frame.telemetry.schema.json",
  "contracts/shared-memory-layout.md",
  "contracts/schemas/error-codes.md",
  "contracts/schemas/engine.reset_session.schema.json",
  "contracts/schemas/blueprint.commands.schema.json",
  "contracts/graphql/editor.schema.graphql",
  "contracts/grpc/gridsmith_editor.proto",
  ".github/workflows/ci.yml",
  "scripts/verify-phase1.sh",
  "scripts/verify-phase2.sh",
  "scripts/verify-phase3.sh",
  "scripts/verify-phase4.sh",
  "scripts/verify-transports.sh",
  "scripts/verify-visual-parity.sh",
  "scripts/benchmark-transports.sh",
  "benchmarks/README.md",
  "benchmarks/transport-benchmark.schema.json",
  "benchmarks/results/2026-07-19-github-ubuntu.json",
];

function packageScripts() {
  const set = new Set();
  for (const p of ["package.json", "middleware/package.json", "frontend/package.json"]) {
    const fp = path.join(root, p);
    if (!fs.existsSync(fp)) continue;
    try {
      const scripts = JSON.parse(fs.readFileSync(fp, "utf8")).scripts ?? {};
      for (const k of Object.keys(scripts)) set.add(k);
    } catch {
      /* ignore malformed package.json here */
    }
  }
  return set;
}

/** Remove blocos cercados (```...```) para não confundir o scanner de links. */
function stripFencedCode(text) {
  return text.replace(/```[\s\S]*?```/g, "");
}

const errors = [];
const scripts = packageScripts();

for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(root, rel))) {
    errors.push(`arquivo obrigatório ausente: ${rel}`);
  }
}

// O arquivo existir não basta: a documentação declara estes comandos como
// quality gates, portanto o workflow precisa realmente invocá-los. Comentários
// são removidos para que uma menção inerte não satisfaça a verificação.
const ciPath = path.join(root, ".github/workflows/ci.yml");
if (fs.existsSync(ciPath)) {
  const executableCi = fs
    .readFileSync(ciPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const requiredCiInvocations = [
    {
      label: "./scripts/verify-transports.sh",
      pattern: /^\s*-\s*run:\s+\.\/scripts\/verify-transports\.sh\s*$/m,
    },
    {
      label: "./scripts/verify-visual-parity.sh",
      pattern: /^\s*-\s*run:\s+\.\/scripts\/verify-visual-parity\.sh\s*$/m,
    },
    {
      label: "npm run docs:verify",
      pattern: /^\s*-\s*run:\s+npm run docs:verify\s*$/m,
    },
    {
      label: "npm run test:transport-fallback",
      pattern: /^\s*run:\s+cd frontend && npm run test:transport-fallback\s*$/m,
    },
    {
      label: "npm run test:transport-repromotion",
      pattern: /^\s*run:\s+cd frontend && npm run test:transport-repromotion\s*$/m,
    },
    {
      label: "npm run test:transport-auth",
      pattern: /^\s*run:\s+cd frontend && npm run test:transport-auth\s*$/m,
    },
    {
      label: "npm run test:transport-journal-gap",
      pattern: /^\s*run:\s+cd frontend && npm run test:transport-journal-gap\s*$/m,
    },
    {
      label: "npm run test:transport-middleware-restart",
      pattern: /^\s*run:\s+cd frontend && npm run test:transport-middleware-restart\s*$/m,
    },
    {
      label: "middleware npm run test:project-session",
      pattern: /^\s*run:\s+npm run test:project-session\s*$/m,
    },
    {
      label: "middleware npm run test:project-session-transports",
      pattern: /^\s*run:\s+npm run test:project-session-transports\s*$/m,
    },
    {
      label: "frontend npm run test:project-session",
      pattern: /^\s*run:\s+cd frontend && npm run test:project-session\s*$/m,
    },
    {
      label: "EngineSessionResetTests",
      pattern: /^\s*run:\s+dotnet test --no-build --nologo --filter FullyQualifiedName~EngineSessionResetTests\s*$/m,
    },
  ];
  for (const invocation of requiredCiInvocations) {
    if (!invocation.pattern.test(executableCi)) {
      errors.push(
        `.github/workflows/ci.yml: quality gate não invocado -> ${invocation.label}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lint de contratos (etapa E4 do docs/DEVELOPMENT-PLAN.md)
//
// Um comando canônico só existe de verdade quando TODAS as pernas do DoD estão
// no lugar. Duas delas são declarativas e podem ser conferidas sem executar
// nada: o schema do payload em contracts/schemas/ e o membro do enum no SDL.
// Antes disto, acrescentar um kind e esquecer o enum passava no CI em silêncio
// — e o buraco só aparecia no cliente, em runtime.
//
// Os três conjuntos são lidos como TEXTO. O script roda na raiz e não pode
// depender do build do middleware: importar do dist/ o tornaria refém da ordem
// dos gates do CI.
// ---------------------------------------------------------------------------

/** Valida sintaxe, refs locais e coerência required ⊆ properties. */
function lintJsonSchemas() {
  const dir = path.join(root, "contracts", "schemas");
  if (!fs.existsSync(dir)) return;

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const rel = `contracts/schemas/${name}`;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch (error) {
      errors.push(`${rel}: JSON inválido -> ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    // Percorre o documento inteiro: as regras valem em qualquer profundidade,
    // porque os schemas do projeto aninham params/result/payload em $defs.
    const visit = (node, pointer) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${pointer}/${index}`));
        return;
      }
      if (node === null || typeof node !== "object") return;

      const ref = node["$ref"];
      if (typeof ref === "string" && ref.startsWith("#")) {
        if (resolveJsonPointer(doc, ref.slice(1)) === undefined) {
          errors.push(`${rel}: $ref pendurado em ${pointer || "/"} -> ${ref}`);
        }
      }

      // `required` sem a propriedade declarada é sempre um erro de digitação:
      // o campo passa a ser exigido e impossível de satisfazer.
      if (Array.isArray(node["required"]) && node["properties"] && node["additionalProperties"] !== true) {
        for (const key of node["required"]) {
          if (!Object.prototype.hasOwnProperty.call(node["properties"], key)) {
            errors.push(`${rel}: "required" cita propriedade não declarada em ${pointer || "/"} -> ${key}`);
          }
        }
      }

      for (const [key, value] of Object.entries(node)) {
        visit(value, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      }
    };
    visit(doc, "");
  }
}

/**
 * Todo schema de contrato aparece na tabela de métodos de `contracts/README.md`.
 *
 * A regra nasceu de um esquecimento real: `tileset.methods.schema.json` entrou
 * com a fatia do atlas e a linha da tabela não — o contrato existia e a página
 * que o anuncia dizia que não. Sem esta verificação, "o schema está no
 * diretório" e "o contrato está publicado" são coisas diferentes que ninguém
 * confere.
 */
function lintSchemaIndex() {
  const dir = path.join(root, "contracts", "schemas");
  const readmePath = path.join(root, "contracts", "README.md");
  if (!fs.existsSync(dir) || !fs.existsSync(readmePath)) return;

  const readme = fs.readFileSync(readmePath, "utf8");
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    if (!readme.includes(`schemas/${name}`)) {
      errors.push(
        `contracts/README.md: schema publicado sem linha na tabela de métodos -> schemas/${name}`,
      );
    }
  }
}

function resolveJsonPointer(doc, pointer) {
  if (pointer === "" || pointer === "/") return doc;
  let node = doc;
  for (const rawSegment of pointer.replace(/^\//, "").split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = node[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Paridade do conjunto de kinds entre as três fontes declarativas.
 *
 * A convenção do enum GraphQL é o kind com `/` trocado por `_` (nomes de
 * membro de enum não aceitam barra). Um kind que não a siga é reportado
 * explicitamente em vez de aceito em silêncio.
 */
function lintCommandKindParity() {
  const shapePath = path.join(root, "middleware/src/canonical/commandShape.ts");
  const sdlPath = path.join(root, "contracts/graphql/editor.schema.graphql");
  const schemaPath = path.join(root, "contracts/schemas/blueprint.commands.schema.json");
  for (const [label, target] of [
    ["middleware/src/canonical/commandShape.ts", shapePath],
    ["contracts/graphql/editor.schema.graphql", sdlPath],
    ["contracts/schemas/blueprint.commands.schema.json", schemaPath],
  ]) {
    if (!fs.existsSync(target)) {
      errors.push(`lint de contratos: fonte de kinds ausente -> ${label}`);
      return;
    }
  }

  const shapeSource = fs.readFileSync(shapePath, "utf8");
  const kindsBlock = shapeSource.match(/export const COMMAND_KINDS = \[([\s\S]*?)\] as const/);
  if (!kindsBlock) {
    errors.push("lint de contratos: COMMAND_KINDS não encontrado em middleware/src/canonical/commandShape.ts");
    return;
  }
  const codeKinds = new Set([...kindsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  const sdlSource = fs.readFileSync(sdlPath, "utf8");
  const enumBlock = sdlSource.match(/enum CommandKind \{([\s\S]*?)\}/);
  if (!enumBlock) {
    errors.push("lint de contratos: enum CommandKind não encontrado em contracts/graphql/editor.schema.graphql");
    return;
  }
  const enumMembers = new Set(
    enumBlock[1]
      .split("\n")
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter((line) => line.length > 0),
  );

  let schemaDoc;
  try {
    schemaDoc = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return; // o lint de sintaxe acima já reportou
  }
  // `shared` hospeda fragmentos reutilizados, não é um kind.
  const schemaKinds = new Set(Object.keys(schemaDoc["$defs"] ?? {}).filter((key) => key !== "shared"));

  const enumNameOf = (kind) => kind.replace(/\//g, "_");
  const difference = (a, b) => [...a].filter((item) => !b.has(item)).sort();

  for (const kind of difference(codeKinds, schemaKinds)) {
    errors.push(`lint de contratos: kind "${kind}" em COMMAND_KINDS sem entrada em contracts/schemas/blueprint.commands.schema.json`);
  }
  for (const kind of difference(schemaKinds, codeKinds)) {
    errors.push(`lint de contratos: kind "${kind}" no schema de comandos sem entrada em COMMAND_KINDS`);
  }

  const expectedEnum = new Set([...codeKinds].map(enumNameOf));
  for (const member of difference(expectedEnum, enumMembers)) {
    errors.push(`lint de contratos: kind sem membro no enum CommandKind do SDL -> ${member}`);
  }
  for (const member of difference(enumMembers, expectedEnum)) {
    errors.push(`lint de contratos: membro do enum CommandKind do SDL sem kind correspondente -> ${member}`);
  }

  for (const kind of codeKinds) {
    if (!/^[a-z0-9]+\/[a-z0-9_]+$/.test(kind)) {
      errors.push(`lint de contratos: kind fora da convenção "dominio/verbo" -> ${kind}`);
    }
  }

  // Um $def de kind sem payload descreve nada: o lint existiria só para
  // conferir a existência da chave, e a chave vazia passaria.
  for (const kind of schemaKinds) {
    if (!schemaDoc["$defs"][kind] || typeof schemaDoc["$defs"][kind]["payload"] !== "object") {
      errors.push(`lint de contratos: kind "${kind}" sem "payload" no schema de comandos`);
    }
  }
}

lintJsonSchemas();
lintSchemaIndex();
lintCommandKindParity();

// O baseline versionado é uma evidência executável, não uma tabela copiada à
// mão: exige a matriz 3 transports × 2 payloads × 4 operações, percentis
// finitos, fluxo de 1.000 eventos e zero erro/perda/resync no run oficial.
const benchmarkPath = path.join(
  root,
  "benchmarks/results/2026-07-19-github-ubuntu.json",
);
if (fs.existsSync(benchmarkPath)) {
  try {
    const report = JSON.parse(fs.readFileSync(benchmarkPath, "utf8"));
    const transports = ["grpc", "graphql", "legacy-jsonrpc"];
    const payloads = ["small", "medium"];
    const operations = ["dispatch", "query-small", "query-document", "event-flow"];
    const expected = new Set(
      transports.flatMap((transport) =>
        payloads.flatMap((payload) =>
          operations.map((operation) => `${transport}|${payload}|${operation}`),
        ),
      ),
    );
    const measurements = Array.isArray(report.measurements) ? report.measurements : [];
    for (const measurement of measurements) {
      expected.delete(
        `${measurement.transport}|${measurement.payloadClass}|${measurement.operation}`,
      );
      for (const percentile of ["p50", "p95", "p99"]) {
        if (!Number.isFinite(measurement.latencyMs?.[percentile])) {
          errors.push(
            `benchmark oficial: ${percentile} ausente/inválido em ` +
              `${measurement.transport}/${measurement.payloadClass}/${measurement.operation}`,
          );
        }
      }
      if (
        measurement.operation === "event-flow" &&
        (measurement.targetEvents !== 3_000 || measurement.receivedEvents !== 3_000)
      ) {
        errors.push(
          `benchmark oficial: fluxo agregado deve provar 3 forks × 1.000 eventos em ${measurement.transport}/${measurement.payloadClass}`,
        );
      }
    }
    if (expected.size > 0 || measurements.length !== 24) {
      errors.push(
        `benchmark oficial: matriz incompleta (` +
          `${[...expected].join(", ") || `${measurements.length} medições`})`,
      );
    }
    if (
      report.schemaVersion !== "p7m.transport-benchmark/v1" ||
      report.valid !== true ||
      report.config?.eventCount !== 1_000 ||
      report.config?.forks !== 3 ||
      report.totals?.failedSamples !== 0 ||
      report.totals?.errorCount !== 0 ||
      report.totals?.resyncs !== 0
    ) {
      errors.push("benchmark oficial: proveniência/configuração/validade não satisfazem o baseline");
    }
    const byCell = new Map(
      measurements.map((measurement) => [
        `${measurement.transport}|${measurement.payloadClass}|${measurement.operation}`,
        measurement,
      ]),
    );
    for (const payload of payloads) {
      const grpcDispatch = byCell.get(`grpc|${payload}|dispatch`);
      const graphqlDispatch = byCell.get(`graphql|${payload}|dispatch`);
      const grpcEvents = byCell.get(`grpc|${payload}|event-flow`);
      const graphqlEvents = byCell.get(`graphql|${payload}|event-flow`);
      if (
        !Number.isFinite(grpcDispatch?.latencyMs?.p95) ||
        !Number.isFinite(graphqlDispatch?.latencyMs?.p95) ||
        grpcDispatch.latencyMs.p95 > graphqlDispatch.latencyMs.p95 * 0.8
      ) {
        errors.push(
          `ADR-019: gRPC default sem ganho mínimo de 20% no p95 de dispatch/${payload}`,
        );
      }
      if (
        !Number.isFinite(grpcEvents?.latencyMs?.p95) ||
        !Number.isFinite(graphqlEvents?.latencyMs?.p95) ||
        grpcEvents.latencyMs.p95 > graphqlEvents.latencyMs.p95 * 1.1
      ) {
        errors.push(
          `ADR-019: gRPC default com regressão acima de 10% no p95 de event-flow/${payload}`,
        );
      }
    }
  } catch (error) {
    errors.push(
      `benchmark oficial inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
const npmRunRe = /npm run ([a-z0-9:_-]+)/gi;
const testCountRe = /\b\d{1,4}[ \t]*(?:testes|tests)\b/gi;
// `project_session_changed` é um valor estável do contrato de resync, não o id
// transitório de uma sessão de geração. A negative lookahead preserva essa
// allowlist sem enfraquecer a detecção de ids `session_<token>` acidentais.
const transitionalRe = /(claude\/[a-z0-9][a-z0-9-]*|session_(?!changed\b)[0-9A-Za-z]{6,}|eaas-2d-ecosystem-[a-z0-9]+)/g;
const schemaRefRe = /contracts\/schemas\/([a-z0-9._-]+\.json)/gi;
const verifyPhaseRe = /verify-phase([1-9][0-9]?)\.sh/g;

for (const file of walk(root)) {
  const rel = path.relative(root, file);
  const raw = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const noCode = stripFencedCode(raw);

  // 1. links Markdown internos (fora de blocos de código)
  for (const m of noCode.matchAll(linkRe)) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|tel:|#)/i.test(target)) continue;
    target = target.split("#")[0];
    if (!target) continue;
    if (!fs.existsSync(path.resolve(dir, target))) {
      errors.push(`${rel}: link/arquivo inexistente -> ${m[1]}`);
    }
  }

  // 2. referências a schemas contracts/schemas/*.json (texto inteiro)
  for (const m of raw.matchAll(schemaRefRe)) {
    if (!fs.existsSync(path.join(root, "contracts", "schemas", m[1]))) {
      errors.push(`${rel}: schema inexistente referenciado -> contracts/schemas/${m[1]}`);
    }
  }

  // 3. scripts verify-phaseN.sh citados existem
  for (const m of raw.matchAll(verifyPhaseRe)) {
    const sp = `scripts/verify-phase${m[1]}.sh`;
    if (!fs.existsSync(path.join(root, sp))) {
      errors.push(`${rel}: script citado inexistente -> ${sp}`);
    }
  }

  // 4. comandos npm run documentados existem em algum package.json
  for (const m of raw.matchAll(npmRunRe)) {
    if (!scripts.has(m[1])) {
      errors.push(`${rel}: comando 'npm run ${m[1]}' não existe em nenhum package.json`);
    }
  }

  // 5. referências transitórias a branches/sessões de geração
  for (const m of raw.matchAll(transitionalRe)) {
    errors.push(`${rel}: referência transitória (branch/sessão) -> ${m[1]}`);
  }

  // 6. contagens de teste fixadas manualmente (devem vir do CI)
  for (const m of raw.matchAll(testCountRe)) {
    errors.push(`${rel}: contagem de testes fixada manualmente -> "${m[0].trim()}" (derive do CI)`);
  }
}

if (errors.length === 0) {
  console.log("docs:verify OK — nenhuma violação encontrada.");
  process.exit(0);
}
console.error(`docs:verify FALHOU — ${errors.length} violação(ões):`);
for (const e of errors.sort()) console.error(`  - ${e}`);
process.exit(1);
