# ADR-023 — Telemetria de frame: um sinal contínuo dentro de um diário de eventos discretos

- **Status:** Accepted · **Data:** 2026-08-21
- **Código:** [`FrameTelemetryProbe.cs`](../../engine/src/Gridsmith.Engine.Host/FrameTelemetryProbe.cs), [`FrameTelemetryPublisher.cs`](../../engine/src/Gridsmith.Engine.Host/FrameTelemetryPublisher.cs), [`FrameTelemetry.ts`](../../middleware/src/runtime/FrameTelemetry.ts), [`FrameTelemetryJournal.ts`](../../middleware/src/runtime/FrameTelemetryJournal.ts), [`runtimeTelemetry.ts`](../../frontend/src/core/runtimeTelemetry.ts)
- **Contrato:** [`frame.telemetry.schema.json`](../../contracts/schemas/frame.telemetry.schema.json)
- **Testes:** [`FrameTelemetryTests.cs`](../../engine/tests/Gridsmith.Engine.Ipc.Tests/FrameTelemetryTests.cs), [`frame-telemetry.test.ts`](../../middleware/test/frame-telemetry.test.ts), [`editor-client.integration.test.ts`](../../frontend/test/editor-client.integration.test.ts)
- **Plano:** [`DEVELOPMENT-PLAN.md`](../DEVELOPMENT-PLAN.md) §9.6 (receita F1, onda A, fatia iv)

## Contexto

Até aqui o canal engine → middleware transportava **três** métodos:
`engine/handshake`, `engine/ping` e `engine/log`. É a pendência D21 da fila: o
fio de volta não carrega nada sobre o que a engine está fazendo, e por isso
nenhum overlay de runtime é possível — o editor não sabe onde a câmera parou
depois do amortecimento, quantos quads o frame desenhou nem se o host ainda
está desenhando.

A ADR-022 criou o host gráfico e provou, com o gate de paridade visual, que o
editor e a engine **compõem** o mesmo frame. Falta o outro sentido: o que o
host efetivamente desenhou, de volta ao editor.

O caminho óbvio é o `EventJournal`, que já é observado pelos dois transports
(stream no gRPC, `eventBatch` no GraphQL). E é aí que está a armadilha desta
etapa — a que, ignorada, teria transformado uma feature de observabilidade numa
regressão silenciosa em duas frentes:

1. **O diário é um anel de capacidade fixa (512) com uma promessa forte:**
   nenhum cliente perde evento dentro da janela. Telemetria é o oposto de um
   evento — é sinal **contínuo**, e perder uma amostra não custa nada. Uma
   amostra por segundo gasta a janela inteira em menos de nove minutos, e o que
   sai dela primeiro são justamente os comandos que ninguém pode perder.
2. **O app trata todo evento do diário como mutação do documento.** O `main`
   chama `commandApplied()` a cada evento entregue; telemetria entregue por
   esse canal deixaria o projeto **sujo** e dispararia **autosave** enquanto o
   usuário apenas olha a janela do host.

## Decisão

### 1. Notificação, e só de quem tem frames

`frame/telemetry` é **notification** JSON-RPC (sem `id`), engine → middleware.
Nunca request: telemetria não tem resposta e não pode fazer o desenho esperar
por um middleware lento — e nunca no caminho síncrono do dispatch.

Quem emite é o **host gráfico**, porque é quem tem frames. O
`Gridsmith.Engine.Runtime` headless não emite, e isso não depende de
disciplina: o probe e o publisher moram no assembly do Host, que o Runtime não
pode referenciar (a referência é a inversa). A regra **E6** afirma a
localização dos dois tipos, então movê-los "para reaproveitar" quebra o CI.

O laço de desenho **não faz IPC**: ele apenas acumula (`FrameTelemetryProbe`,
sem alocação por frame, tempo medido por `Stopwatch` — com `IsFixedTimeStep` o
tempo do `GameTime` é o passo nominal, e reportá-lo seria publicar uma
constante disfarçada de medição). Quem transforma acúmulo em mensagem é o laço
do plano de controle, a **1 Hz**. Sem middleware conectado, nada sai — e a
janela continua desenhando.

O payload separa **`frame`** (o que foi desenhado) de **`scene`** (o que a cena
contém). São números diferentes: a onda A não desenha luz nenhuma, e somá-los
faria a telemetria afirmar uma imagem que a janela não mostra.

### 2. O diário recebe transições, não o sinal

A cadência do fio (1 Hz) é o **tempo de detecção**. A cadência do diário é
decidida por uma política pura no middleware, com duas propriedades:

- **Silêncio é de graça.** Host aberto sem nada acontecendo publica **zero**
  eventos. Um batimento periódico parecia a correção óbvia e não era: a 12 por
  minuto ele esvazia o mesmo anel em pouco mais de 40 minutos, pagando caro
  para repetir "nada mudou".
- **Teto de taxa quando muda.** Toda publicação (menos a primeira de cada host)
  respeita o mesmo intervalo mínimo — **inclusive as mudanças discretas**. A
  uniformidade compra imunidade a oscilação: um nível parado exatamente no teto
  de quads faria `truncated` piscar a cada frame, e uma exceção "mudança
  discreta passa na hora" transformaria isso em enxurrada. Uma mudança
  represada não se perde: a comparação é sempre contra a última amostra
  **publicada**, então ela sai inteira quando a janela abre.

O intervalo é **derivado, não escolhido**: o pior caso realista é uma hora de
câmera em movimento contínuo, que publica `3600 / intervalo` eventos. Para que
a telemetria sozinha nunca rotacione o anel de 512, o intervalo precisa de ao
menos ~7 s; **10 s** dá 360 eventos nessa hora e deixa mais de 150 lugares para
o que veio antes. O teste da hora patológica amarra o número à capacidade do
diário — mudar uma sem revisitar a outra falha no CI.

Cada evento carrega **por que** foi publicado (`first_sample`, `scene_changed`,
`frame_health_changed`, `drawing_changed`, `frame_changed`, `camera_moved`).
Sem a razão, quem lê o diário veria amostras esparsas e teria de inferir,
comparando eventos, o trabalho que a política já fez.

Desempenho (fps, tempo de desenho) **não decide** publicação: oscila sempre e
não muda nada do que está na tela. Ele viaja de carona nos eventos que as
outras razões publicam.

### 3. No editor, telemetria é evento de CONTROLE

O `EditorClient` classifica `runtime/frameTelemetry` como controle, ao lado de
`project/sessionChanged`: o cursor **avança** (ignorá-la sem consumir o `seq`
viraria lacuna, e cada amostra custaria um resync completo), mas ela **não
chega** aos ouvintes de Blueprint. Vai para um canal próprio
(`onRuntimeTelemetry` + último valor em `runtimeTelemetry`), onde nada suja o
documento.

## Consequências

**Ganhos.** D21 fecha: o fio de volta carrega o estado do runtime, e um overlay
passa a ser possível — pelos dois transports, sem superfície nova. A posição
**viva** da câmera (pós-amortecimento e shake, a que o frame usou) fica
observável, e ela pode divergir da última posição comandada — é essa
divergência que a torna útil. Truncamento de frame e "o host parou de desenhar"
deixam de ser invisíveis.

**Custos aceitos.** A telemetria no diário é **grossa**: até 10 s de latência e
nada enquanto a cena está parada. Para um feed de observabilidade isso é o
correto; para um HUD a 60 Hz, não é. Quando a onda B precisar de câmera viva
quadro a quadro, o caminho é **um canal de baixa latência ao lado do diário**,
não aumentar a taxa aqui — subir a taxa devolve exatamente o problema que esta
ADR resolve.

**O que fica de fora.** Nenhuma consulta nova nas bordas: a telemetria é
observável pelo caminho de eventos que já existe. O consumo visual (painel,
overlay) pertence à onda B; até lá o valor chega ao processo principal do
editor e para ali, deliberadamente.

## Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Emitir por frame (60 Hz) | Inunda o fio e o anel para transportar um sinal que ninguém consome a essa taxa |
| Batimento periódico no diário | Custa a janela de resync para repetir "nada mudou": 12 eventos/min esvaziam o anel de 512 em ~40 min de host **ocioso** |
| Entregar telemetria como evento de Blueprint | Cada janela de desenho viraria comando aplicado: projeto sujo e autosave gravando arquivo sozinho |
| Filtrar a telemetria no cliente sem consumir o `seq` | Vira lacuna no cursor; cada amostra passaria a custar um snapshot completo |
| Aumentar a capacidade do `EventJournal` | Muda a semântica de catch-up de todos os clientes para acomodar um sinal descartável, e só adia a proporção |
| Emitir também no `Runtime` headless | Seria inventar números sobre frames que não existem — o serviço sem janela não desenha |
| Consulta nova (`runtimeTelemetry`) nas quatro bordas | Superfície nova em quatro lugares para o que o caminho de eventos já entrega; a consulta só se justifica quando houver consumidor (onda B) |
