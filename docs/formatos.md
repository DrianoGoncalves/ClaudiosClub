# Formatos do Claude Code (Fase 0)

Levantamento feito em 2026-10-26 nesta máquina (Windows 10, Claude Code 2.1.308 no app desktop, CLI 2.1.278 no PATH).
Legenda: **✅ confirmado** (visto no disco ou testado) · **⚠️ suposição** (não verificado) · **❌ não verificado / bloqueado**.

Nenhum desses formatos é documentado oficialmente como API estável. Tudo que o Claudio's Club ler daqui passa por `server/adapters/claude/` com validação (zod) e falha graciosa.

## 1. Mapa de pastas

| Caminho | O que é | Uso no Claudio's Club | Status |
|---|---|---|---|
| `~/.claude/agents/` | Agents de nível usuário (todos os projetos) | Destino de agents "globais" | ✅ não existe ainda nesta máquina |
| `~/.claude/skills/<nome>/SKILL.md` | Skills de nível usuário | Ler/escrever | ✅ (`vps`) |
| `~/.claude/skills/synced/<id>/` | Skills sincronizadas da conta (manifest.json) | **Só leitura** — gerenciadas pela Anthropic | ✅ |
| `~/.claude/plugins/` | Plugins e marketplaces | Só leitura (listar skills/agents de plugins) | ✅ |
| `~/.claude/settings.json` | Config global (env, model, hooks, outputStyle…) | Só leitura no MVP | ✅ |
| `~/.claude/sessions/<pid>.json` | Registro de sessões **vivas** (uma por processo) | Estado ao vivo (Fase 3) | ✅ |
| `~/.claude/sessions/<pid>.<hash>.key` | Chave do processo | **Nunca ler** | ✅ |
| `~/.claude/projects/<cwd-codificado>/<sessionId>.jsonl` | Transcript da sessão | Histórico, custo, rastro | ✅ |
| `~/.claude/projects/<cwd-codificado>/<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json` | Transcripts de subagents | Hierarquia e delegações | ✅ |
| `~/.claude/projects/<cwd-codificado>/<sessionId>/custom-title.json` | Título da sessão | Rótulo no quadro | ✅ |
| `~/.claude/projects/<cwd-codificado>/<sessionId>/tool-results/` | Saídas grandes de ferramentas | Ignorar | ✅ |
| `~/.claude/projects/<cwd-codificado>/memory/` (`MEMORY.md` + 1 arquivo por fato) | Memória automática por projeto | Memória por sala (Fase 2) | ✅ |
| `~/.claude/history.jsonl` | Histórico de prompts (`display, pastedContents, timestamp, project, sessionId`) | Busca global (Fase 4); pode ter dados colados — tratar como sensível | ✅ |
| `~/.claude.json` | Estado global; `projects[<caminho>]` tem `lastCost`, tokens, `lastSessionId`, `mcpServers`… | Custo por projeto. **Contém `oauthAccount`: ler só as chaves necessárias** | ✅ |
| `~/.claude/.credentials.json` | Credenciais | **Nunca ler** | ✅ |
| `<projeto>/.claude/agents/*.md` | Agents do projeto | Ler/escrever (núcleo do MVP) | ✅ (`painel.cliente.com.br`) |
| `<projeto>/.claude/skills/<nome>/SKILL.md` | Skills do projeto | Ler/escrever | ⚠️ nenhum projeto tem ainda |
| `<projeto>/.claude/settings.local.json` | Permissões locais | Só leitura | ✅ |
| `<projeto>/.claude/worktrees/` | Worktrees do app desktop | Agrupar com o projeto-pai | ✅ |
| `<projeto>/CLAUDE.md` | Contexto do projeto | Ler/escrever | ✅ (`app.exemplo.dev`) |

### Codificação do nome da pasta em `projects/`
Todo caractere que não é letra ou dígito vira `-`: `C:\...\www\painel.cliente.com.br\.refactor-app` → `C--...-www-painel-cliente-com-br--refactor-app`. **É ambígua (não dá para decodificar).** O caminho real deve vir do campo `cwd` das linhas do JSONL ou de `sessions/<pid>.json`. ✅

## 2. Agents e skills

**Agent (`.md` com frontmatter YAML)** — chaves vistas: `name`, `description`, `tools`. ✅
Outras chaves conhecidas da documentação (`model`, `color`…): ⚠️ confirmar na doc atual antes de gerar.

**Skill (`<pasta>/SKILL.md`)** — chaves vistas: `name`, `description`, `argument-hint`. A pasta pode ter scripts ao lado (`vps.ps1`, `guard.ps1`). ✅
O identificador da skill é o **nome da pasta**; o `name` do frontmatter vira só rótulo. ✅ (seção 6)
O identificador do agent é o **`name` do frontmatter**; mesmo `name` em dois arquivos → só um é carregado. ✅ (seção 6)

## 3. Sessões vivas — `~/.claude/sessions/<pid>.json`

Campos ✅: `pid, sessionId, cwd, startedAt, procStart, version, kind (interactive…), entrypoint (claude-desktop…), name, nameSource, status (busy…), updatedAt, statusUpdatedAt, hostSessionId, bridgeSessionId, messagingSocketPath, peerProtocol, peerFeatures`.

- `status` + `statusUpdatedAt` dão o estado ao vivo sem ler o transcript. ✅ Valores vistos: `busy` (trabalhando), `idle` (ocioso), `waiting` (aguardando o usuário → fila "precisa de mim"). Outros valores: ⚠️
- `entrypoint` diz a origem ✅: `claude-desktop` (app), `cli` (terminal), `sdk-cli` (`claude -p`). CLI e app gravam no mesmo `~/.claude`, então ambos aparecem no Claudio's Club. Sessões na nuvem (claude.ai/code) e de outras máquinas **não** aparecem.
- Arquivo de processo encerrado pode ficar órfão: checar se o `pid` existe e se `procStart` bate. ⚠️

## 4. Transcript — `projects/.../<sessionId>.jsonl`

Uma linha JSON por evento, campo `type`. Tipos vistos ✅:

| `type` | Interesse | Campos úteis |
|---|---|---|
| `user` | Prompts e resultados de ferramenta | `uuid, parentUuid, timestamp, cwd, gitBranch, permissionMode, message` |
| `assistant` | Respostas, tool_use, **custo** | `message.model`, `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`, `message.content[].type` (`text`, `tool_use`…), `requestedModel, effort` |
| `system` | Hooks, paradas | `subtype, hookInfos, hookErrors, stopReason` |
| `attachment` | Contexto injetado | `attachment` |
| `custom-title`, `agent-name` | Nome da sessão | `customTitle`, `agentName` |
| `last-prompt` | Último prompt | `lastPrompt` |
| `file-history-snapshot` / `-delta` | Arquivos tocados | `snapshot`, `trackingPath` |
| `queue-operation` | Fila de mensagens | `operation, content` |
| `api-request*`, `atis-latch`, `bridge-session` | Internos | Ignorar |

- Encadeamento por `uuid`/`parentUuid`; `isSidechain` marca ramos de subagent. ✅
- Arquivos grandes (este já tem ~1,2 MB): ler incrementalmente pelo final (tail), não reparsear tudo. ✅

## 5. Subagents

`<sessionId>/subagents/agent-<agentId>.jsonl` (mesmo formato, com `agentId` e `slug`) + `agent-<agentId>.meta.json` com `agentType, description, toolUseId, spawnDepth`. ✅
Isso dá a árvore de delegação: sessão → subagent (via `toolUseId` do `tool_use` no transcript-pai) e a profundidade (`spawnDepth`).

## 6. Vínculos entre projetos (symlink / hardlink / junction)

Teste em pasta temporária:

| Tipo | Uso | Criou sem admin? |
|---|---|---|
| Symlink de arquivo | Agent emprestado (`.claude/agents/x.md` → outro projeto) | ✅ sim (Modo de Desenvolvedor ativo: `AllowDevelopmentWithoutDevLicense=1`) |
| Hardlink | Fallback para agent (mesmo volume) | ✅ sim |
| Junction de pasta | Skill emprestada (`.claude/skills/x/` → outro projeto) | ✅ sim |

**✅ Verificado (ver rodadas abaixo): o Claude Code carrega agents via symlink e hardlink, e skills via junction.** Histórico: o teste via `claude -p` falhou porque o CLI do PATH (2.1.278) está com OAuth expirado; o app desktop usa outra instância. Efeito colateral do teste: o Claude Code criou `~/.claude/projects/C--Users-voce-AppData-Local-Temp-...-linktest-dst/` (vazio, pode ser apagado).

Segunda tentativa (após login informado pelo usuário): continua `loggedIn: false`; `~/.claude/.credentials.json` não foi atualizado desde 09:13. Limpar as variáveis herdadas do app desktop não resolveu.

Pasta de teste montada (pronta para o teste manual): `%TEMP%\claude\...\scratchpad\linktest\dst\.claude\` com
`agents/controle.md` (comum), `agents/emprestado.md` (symlink), `agents/emprestado-hl.md` (hardlink),
`skills/controle-myco/` (comum) e `skills/demo/` (junction → skill `demo-myco`).

Como fechar: autenticar o CLI fora do app (`claude auth login` num terminal comum) ou abrir uma sessão nova no app desktop na pasta de teste e perguntar quais subagents/skills aparecem.

**Teste manual no app desktop (2026-10-26), 1ª rodada:**
`AGENTS: …, controle, emprestado, … | SKILLS: controle-myco, demo`

- ✅ **Junction de pasta funciona para skills** (`skills/demo/` é junction e foi carregada).
- ✅ **Nome da skill = nome da pasta**, não o `name` do frontmatter (o frontmatter dizia `demo-myco`; listada como `demo`, com o `name` só como rótulo).
- ✅ **Nome do agent = `name` do frontmatter**, não o nome do arquivo; agents com o mesmo `name` são deduplicados (só um aparece). O Claudio's Club precisa detectar e avisar colisões de nome.
- ⚠️ Symlink de agent **inconclusivo**: `emprestado.md` (symlink) e `emprestado-hl.md` (hardlink) tinham o mesmo `name`, então não dá para saber qual foi carregado.

**2ª rodada** (nomes únicos, sessão nova no app desktop):
`AGENTS: …, controle, …, so-hardlink, so-symlink, …`

- ✅ **Symlink de arquivo funciona para agents.**
- ✅ **Hardlink funciona para agents.**

### Conclusão: estratégia de vínculo

| Item emprestado | 1ª opção | Fallback (máquina sem Modo de Desenvolvedor) |
|---|---|---|
| Agent (arquivo) | Symlink | Hardlink (só no mesmo volume; editores que salvam "substituindo" o arquivo quebram o vínculo, então o Claudio's Club deve verificar e refazer) |
| Skill (pasta) | Junction (não exige admin) | Symlink de pasta |
| Qualquer um, entre volumes sem symlink | Cópia gerenciada com marcador de origem e hash | — |

Ressalvas: testado só no app desktop (o CLI usa o mesmo motor, mas não foi testado); o nome que vale é o `name` do agent e a pasta da skill, então o Claudio's Club deve impedir colisões ao emprestar.

> Achado útil para o Claudio's Club: um processo filho iniciado de dentro do app desktop herda `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, `CLAUDE_CODE_CHILD_SESSION` etc. Se o Claudio's Club lançar sessões (Fase 4), deve iniciar o `claude` com ambiente limpo.

Alternativa sem vínculo (não recomendada): publicar o agent em `~/.claude/agents/`, que o deixa visível para todos os projetos e perde o controle por agente.

## 7. Regras de segurança derivadas

- Nunca ler `.credentials.json`, `sessions/*.key`, nem `oauthAccount` de `~/.claude.json`.
- Tratar `history.jsonl` e transcripts como sensíveis (podem conter segredos colados); mascarar antes de mandar ao navegador.
- Só escrever em `<projeto>/.claude/agents|skills`, `<projeto>/CLAUDE.md`, `~/.claude/agents|skills` (fora de `synced/`) e `.myco/`. Backup antes de cada escrita.

## 8. Consumo (5h/7d) e custo

**Assinatura, não API.** O Claudio's Club nunca chama a API: ele inicia o `claude` (CLI), que usa o login da assinatura e consome os limites de 5h/7d. Para não cair na cobrança da API, o Claudio's Club inicia o CLI **sem `ANTHROPIC_API_KEY`** no ambiente e confere `claude auth status` (`loggedIn`, `authMethod`). ✅ (flags e status vistos no CLI 2.1.278)

**Limites de 5h/7d** ✅ — não ficam em nenhum arquivo do `~/.claude` (`stats-cache.json` só tem atividade diária; `policy-limits.json` é política da organização). Só a API de mods os expõe: `$.session.usage().rateLimits` e o evento `session.measure` trazem `{ kind: 'five_hour' | 'seven_day' | 'spend_limit', percentUsed, resetsAt }` (vazio fora de assinatura). É o que o mod `usage-bars` do usuário já usa.
→ Implementado: mod `myco-tap` (`mod/myco-tap`, instalado com `npm run mod:install` em `~/.claude/mods/myco-tap` + `CLAUDE_CODE_PLUGIN_DIRS`). Em `session.start`/`session.measure` grava `~/.myco/usage.json` (limites da conta; nunca sobrescreve com lista vazia) e `~/.myco/sessions/<sessionId>.json` (custo da sessão segundo o `/cost`). O servidor do Claudio's Club só lê. Vale para sessões iniciadas depois da instalação. ⚠️ ainda não visto gravando numa sessão real (confirmar se `$.fs.write` fora da pasta do projeto pede permissão).

**Custo por sessão/agent/projeto** ✅ — calculado dos transcripts: `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` × preço de `message.model`.
- **Deduplicar por `message.id`**: cada bloco de conteúdo de uma resposta vira uma linha `assistant` com o mesmo `usage` repetido (sessão de teste: 299 linhas, 104 respostas).
- Subagents: somar `subagents/agent-*.jsonl` e agrupar por `agentType` do `.meta.json` → custo por agent (ex.: `meta-business-chrome`).
- É **equivalente em API** (estimativa para comparar), não cobrança. Precisa de tabela de preços por modelo.

## 9. Pendências para fechar a Fase 0

- [x] Confirmar se agent/skill via symlink/junction é carregado (seção 6): sim.
- [x] Flags do CLI para iniciar sessões: `--append-system-prompt`, `--session-id <uuid>`, `-n/--name`, `--agent`, `--allowedTools`/`--disallowedTools`, `--permission-mode`, `--model`, `-r/--resume`.
- [ ] Confirmar a lista completa de chaves de frontmatter de agents/skills na doc atual.
- [x] Levantar os valores possíveis de `status` em `sessions/<pid>.json` (`busy`, `idle`, `waiting`; pode haver outros).
- [ ] Ver onde ficam agents/skills de plugins (`~/.claude/plugins/...`) para o inspetor de contexto.
