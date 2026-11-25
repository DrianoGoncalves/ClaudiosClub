# Arquitetura: mapa do Claudio's Club

Mapa curto para achar onde fica cada parte. Visão e regras de produto: `SPEC.md`. Regras de desempenho (quadro, git, polling, gravação atômica): "Desempenho: regras que não podem voltar atrás" no `SPEC.md`, não repetidas aqui. Comandos e travas: `AGENTS.md`.

Stack: Node >= 22, servidor TypeScript (`tsx`), tela React + Vite. Uma porta (4848) serve a API e o build da tela. Em desenvolvimento o Vite (5173) repassa a API ao servidor.

## Três pastas

| Pasta | O que é |
|---|---|
| `server/` | Servidor: API, conversas com os motores, tarefas, git, equipe. Ponto de entrada: `server/index.ts` (rotas e subida). |
| `client/` | Tela. `client/src/` (React) e `client/public/` (estáticos, `manual.html`). |
| `shared/` | Tipos e regras usados pelos dois lados. O contrato central é `shared/model.ts` (inclui `TASK_STATUSES`). |

Testes ficam em `tests/` (vitest, sem DOM). Manual do usuário em `docs/uso/`; outros docs em `docs/`.

### `server/`

| Módulo | Papel |
|---|---|
| `server/index.ts` | Sobe o servidor, monta as rotas, serve estáticos (`server/staticFiles.ts`). |
| `server/tasks.ts` | Serviço de tarefas: fila, início, revisão, mescla, commit, arquivo morto. |
| `server/board.ts`, `server/boardConfig.ts` | Quais projetos entram no quadro; configuração por projeto. |
| `server/chat/` | Conversas com o motor: processo (`process.ts`, `manager.ts`), eventos, histórico, retomada, limites de uso. |
| `server/staff/` | Funcionários: fichas (`store.ts`, `ficha.ts`), worktree própria (`worktree.ts`), MCPs, servidores SSH/FTP. |
| `server/adapters/` | Motores e fontes externas (ver "Motores"). |
| `server/consult/` | Consultas entre funcionários. |
| `server/titles/` | Títulos das conversas. |
| `server/health/` | Verificações de saúde do projeto. |
| `server/extension/` | Extensão do Chrome (identidade, tokens, rotas). |
| `server/git.ts`, `server/autoCommit.ts`, `server/release.ts` | Git do projeto, commit automático, versionamento. |
| `server/auth.ts`, `server/pairing.ts`, `server/apiPolicy.ts`, `server/callers.ts` | Pareamento, quem chama a API e o que pode. |
| `server/heavyQueue.ts` | Fila de validação pesada (testes) por máquina. |
| `server/atomicWrite.ts` | Gravação atômica usada por quem grava estado. |
| `server/config.ts` | `MYCO_HOME` e a configuração do Club. |

### `client/src/`

Entrada: `main.tsx` → `App.tsx`. Chamadas à API: `api.ts`. Estilo e tokens `--*`: `styles.css` (guia: `docs/design-system.md`). Textos pt/en/es: `i18n/`. Cada pasta é uma tela ou área:

| Pasta | Área |
|---|---|
| `board/` | Quadro de projetos. |
| `office/` | Projeto: painel, novo projeto, MCPs. |
| `tasks/` | Tarefas: cards, revisão, versionamento. |
| `chat/`, `detail/` | Conversa com o funcionário e o detalhe aberto. |
| `inbox/` | Caixa de entrada (alertas, pendências). |
| `staff/` | Fichas, contratação, cargos. |
| `files/`, `skills/`, `schedules/`, `consult/`, `toolbar/` | Arquivos, skills, rotinas, consultas, barra superior. |
| `lib/` | Componentes compartilhados (`ActionBar.tsx`, diálogos, skeleton). |

### `shared/`

Sem dependência de server nem client. `model.ts` (tipos e constantes), `roles.ts`, `agentPresets.ts`, `teamTemplates.ts`, `cron.ts`/`recurrence.ts`, `release.ts`, `deploy.ts`, `ci.ts`.

## Onde ficam os dados

Sem banco: arquivos JSON/Markdown.

| Onde | O que |
|---|---|
| `<projeto>/.myco/` (fora do git do Club) | Estado do projeto: `tasks.json` (quadro), `tasks-arquivo.json` (fechadas antigas), `board.json` (config do quadro), `task-runs.jsonl` (execuções, só acrescenta), `backups/`, `prints/`. |
| `<projeto>/.myco/staff/` | Fichas: `<id>.json`, `<id>.md` gerado, `<id>.memory.md` e `<id>.memory/`. |
| `<projeto>/.claude/worktrees/myco-<ficha>` | Worktree própria do funcionário (`server/staff/worktree.ts`). |
| `MYCO_HOME` (padrão `~/.myco`) | Estado da máquina, fora do projeto: `config.json`, `sessions-registry.json`, `flow-policies.json`, `releases/<projeto>.json`, `secrets/pairing.key`. O que o agente não pode editar fica aqui de propósito. |
| `~/.claude/` | Dados do Claude Code (transcripts, agents, skills), lidos pelo adaptador. Formatos: `docs/formatos.md`. |

## Motores

O Club não implementa o modelo: dirige o CLI do motor que a ficha escolhe (Claude ou Codex).

- Contrato: `server/adapters/types.ts`.
- Claude: `server/adapters/claude/` (projetos, sessões, agents, skills, custos). Processo da conversa: `server/chat/process.ts`.
- Codex: `server/adapters/codex.ts`, `server/adapters/codex/` (projetos, rollout, uso). Processo e eventos: `server/chat/codexProcess.ts`, `server/chat/codexEvents.ts`, `server/chat/codexArgs.ts`. Preparo: `server/codexSetup.ts`.
- Capacidades que diferem entre motores: `server/engineCapability.ts`.
- GitHub (skills): `server/adapters/github/client.ts`.
- Retentativa e limites: `server/retryPolicy.ts`, `server/chat/turnRetry.ts`, `server/chat/usageLimit.ts`.

## Ciclo da tarefa

Status em `shared/model.ts` (`TASK_STATUSES`): `waiting` (Aguardar, parado), `todo` (a fazer), `planning`, `doing`, `review`, `done` (finalizado), `cancelled`. Tudo é `TaskService` em `server/tasks.ts` (o cabeçalho do arquivo descreve as transições).

| Etapa | O que acontece | Arquivos |
|---|---|---|
| Fila (`todo`) | Com responsável e sem dependência pendente, entra na fila do funcionário (uma tarefa por vez por pessoa); a vez dele inicia. Uma rotina periódica do servidor não deixa nada esquecido. | `server/tasks.ts`, `.myco/tasks.json`, `.myco/staff/` |
| Planejando (`planning`) | Opcional: o plano é aprovado no cartão antes de fazer. | `server/tasks.ts`, `client/src/tasks/` |
| Fazendo (`doing`) | Abre conversa nova com a descrição, na worktree do funcionário. Fila de testes pesados compartilhada. | `server/chat/manager.ts`, `server/staff/worktree.ts`, `server/worktreeBase.ts`, `server/heavyQueue.ts`, `.myco/task-runs.jsonl` |
| Revisão (`review`) | Turno termina → entrega. Com revisor marcado, revisão automática (até `AUTO_REVIEW_ROUNDS`): aprovada segue, reprovada volta a `doing`. Esgotadas as rodadas, fica com o dono. | `server/tasks.ts`, `server/reviewBlockers.ts`, `server/testFailures.ts`, `shared/model.ts` |
| Mescla / commit | Tarefa de worktree: a mescla junta no projeto com testes verdes. Tarefa sem worktree: commit automático, local. Sobra e falha viram item na caixa. | `server/tasks.ts`, `server/autoCommit.ts`, `server/commitLeft.ts`, `server/slotSnapshot.ts`, `server/git.ts` |
| Finalizado (`done`) | Fecha a tarefa e libera quem depende dela. Fechadas antigas vão para o arquivo morto. | `.myco/tasks.json`, `.myco/tasks-arquivo.json` |
| Cancelada (`cancelled`) | Fecha sem entrega; não libera dependentes. Reabrir volta a `todo`. | `server/tasks.ts` |

O nível de automação (concluir sozinho, commit, publicar) é a política de fluxo do projeto: `server/flowPolicy.ts`, gravada em `~/.myco/flow-policies.json`.
