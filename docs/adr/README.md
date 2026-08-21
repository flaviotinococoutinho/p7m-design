# ADRs — Architecture Decision Records

Decisões arquiteturais com contexto, alternativas e consequências. As
decisões estruturais **anteriores** a este diretório (ADR-001..015 — modelo
canônico, JSON-RPC no plano de controle, framing, shared memory, DOD/Zero-GC,
HookBus, perfis, adapters, replay, isolamento Electron, JSON Schema, fitness
functions) estão registradas retroativamente em
[`../ARCHITECTURE-SPEC.md`](../ARCHITECTURE-SPEC.md) §32, com evidência.

| ADR | Decisão | Status |
|---|---|---|
| [ADR-016](ADR-016-graphql-baseline-do-app.md) | GraphQL como superfície COMPLETA (baseline) do app | Accepted |
| [ADR-017](ADR-017-grpc-caminho-quente-com-fallback.md) | gRPC no caminho quente, prioritário, com fallback para GraphQL | Accepted |
| [ADR-018](ADR-018-endpoints-e-verbosidade-dos-transports.md) | Endpoints locais dos transports e controle de verbosidade | Accepted |
| [ADR-019](ADR-019-freeze-medido-dos-transports.md) | Freeze medido: gRPC default em dispatch/eventos, GraphQL baseline completo, legado só compatibilidade | Accepted |
| [ADR-020](ADR-020-sessao-de-projeto-transacional.md) | Sessão de projeto explícita, replay isolado e substituição atômica | Accepted |
| [ADR-022](ADR-022-host-grafico-como-composicao.md) | Host gráfico como composição; paridade visual verificada na DESCRIÇÃO do frame, sem GPU | Accepted |
| [ADR-023](ADR-023-telemetria-de-frame-no-diario-de-eventos.md) | Telemetria de frame como notificação, coalescida antes do diário e tratada como evento de controle no editor | Accepted |

> **ADR-021 está reservada, não perdida:** é o regime de curadoria descrito em
> [`../DEVELOPMENT-PLAN.md`](../DEVELOPMENT-PLAN.md) §10, ainda por escrever. O
> número foi tomado quando a decisão foi identificada, para que a numeração não
> mudasse depois.
