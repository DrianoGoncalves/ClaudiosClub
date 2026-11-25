# Segurança do Claudio's Club

Este documento diz o que o Club protege, de quem, onde cada proteção mora e o que ainda não cobre.

## O que protegemos

- Segredos do dono: chaves de acesso remoto, `.env`, senhas de FTP, tokens de MCP e `~/.claude.json`.
- Os projetos do dono: código e git.
- Quadro, fichas e políticas (`~/.myco`).
- A sessão do navegador do dono.

## De quem

1. Site malicioso aberto no navegador do dono (CSRF, DNS rebinding).
2. Outro usuário ou processo da mesma máquina.
3. O próprio funcionário (agente) errando ou sob prompt injection (página, arquivo, mensagem de outro funcionário).
4. Funcionário de um projeto alcançando outro projeto.

**Fora do escopo:** malware rodando como o próprio usuário e máquina já comprometida.

## Como e onde protegemos

**Rede**
- O servidor escuta só em 127.0.0.1 (`server/index.ts`). O sandbox do Codex usa 127.0.0.2 (`server/callers.ts`).

**Porta de entrada única: `server/gate.ts`**
- Só aceita Host local (anti DNS rebinding) e só GET/POST.
- POST exige o cabeçalho `x-myco`.
- Rota de funcionário exige `x-myco-token` da conversa e fica presa ao projeto dela (`server/apiPolicy.ts`).
- Recusas vão para o log.

**Tela do dono**
- Pareamento por cookie HMAC. A chave fica em `~/.myco/secrets/pairing.key`.
- Código de uso único, válido por 2 minutos, confirmado no terminal (`server/pairing.ts`).

**Extensão do navegador**
- Só o Origin dela é aceito, só rotas permitidas e Bearer revogável (`server/gate.ts`, `server/extension/tokens.ts`).

**Bloqueios por ficha** (`server/staff/ficha.ts`, `secretDenyRules` e `REMOTE_TOOLS`)
- Negam pastas de chaves, `.vps`, `~/.myco/secrets`, memória pessoal, `~/.claude.json`, backups, `.env` reais e `*.pem`/`*.key`.
- Negam programas de acesso remoto no terminal.

**Hooks** (`scripts/hooks/`, lista em `server/staff/launch.ts`)
- `remote-guard.mjs`, `git-guard.mjs`, `mcp-write-guard.mjs`, `memory-guard.mjs`, `club-guard.mjs`.

**Servidor remoto**
- Só pelos MCPs `myco-ssh` e `myco-ftp`, e só nas conexões marcadas na ficha.
- Escrita exige permissão de escrita e autonomia (`server/staff/launch.ts`, `server/staff/sshMcp.ts`, `server/staff/ftpMcp.ts`).

**Cofre de segredos** (`~/.myco/secrets`, `server/secretVault.ts`)
- DPAPI no Windows, permissões 0600/0700 no Linux e macOS. O valor entra só por stdin.
- MCPs da biblioteca: env e cabeçalhos saem do cofre na subida (`server/staff/mcpLaunch.ts`).
- Segredo na saída de comando: a origem é rastreada por HMAC, sem expor o valor (`server/chat/secretOrigin.ts`).

**Git**
- `.gitignore` exclui `.env*`, `.vps/`, `.myco/`, `faces/`, `PLANO.md`, `.claude/worktrees`, `.claude/settings.local.json` e `.claude/agents`.
- O MCP `myco-git` commita só os caminhos informados, nunca dá push em main/master nem force. O merge é do dono.

**Navegador**
- Navegador do dono (Claude in Chrome): regras só no prompt da ficha (veja lacuna 3).
- Navegador limpo (`myco-navegador`, sem cookies) para todo o resto.

## Lacunas conhecidas (riscos residuais)

1. **Terminal fura os bloqueios.** Eles valem para Read/Edit, não para Bash/PowerShell: quem tem terminal lê arquivo bloqueado por outro comando. Mitigação: chave com senha ou agente e usuário sem root no servidor.
2. **O cofre não protege de processo do próprio usuário.**
3. **Navegador do dono sem barreira técnica.** São só instruções ao modelo. Prompt injection em página com sessão logada é o maior risco residual.
4. **Regra com espaço no caminho não vale.** Sobra só o bloqueio por nome. Correção em outro card.
5. **Falsos negativos dos hooks `git-guard` e `remote-guard`:** comando montado, binário renomeado, socket aberto por Node ou Python.

## Reportar vulnerabilidade

- Use o GitHub Security Advisories do repositório ("Report a vulnerability"). **Nunca** abra issue pública.
- Versão suportada: só a última publicada.
- Resposta por melhor esforço, sem prazo garantido.
