## Lições da revisão

- 2026-11-23: ao mudar o que toda conversa recebe por padrão (mcp.json, `--allowedTools`, ficha), rode TODOS os testes que leem `mcp.json`/`chatSpawn`/`prepareRun` (`grep` em `tests/`), não só os que citam a função alterada: o `codexConsultor.test.ts` esperava "sem MCP = null" e ficou velho.
