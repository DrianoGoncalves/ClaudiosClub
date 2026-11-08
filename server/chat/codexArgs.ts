import type { Autonomy } from '../../shared/model';

// Linha de comando do Codex (CLI da OpenAI) para um funcionário com `engine: 'codex'`. Cada mensagem é uma execução
// de `codex exec --json` (a primeira) ou `codex exec resume <thread_id> --json` (as seguintes), com o prompt pelo stdin.
// Só funções puras, para testar a montagem sem abrir processo. Testado com o Codex CLI 0.156.1.

/** Sandbox do Codex. `danger-full-access` e `--dangerously-*` nunca saem daqui. */
export type CodexSandbox = 'read-only' | 'workspace-write';

/**
 * Modo de permissão do Claudio’s Club (o `--permission-mode` do Claude Code) → sandbox do Codex. O `exec` não pergunta nada:
 * quem decide o que pode é a sandbox. plan e manual só leem; acceptEdits e auto escrevem na pasta de trabalho (sem rede).
 * "Sem travas" (bypassPermissions) também fica em workspace-write: no Codex ninguém roda sem sandbox por aqui. Modo desconhecido: só leitura.
 */
export function sandboxFor(mode: string | null | undefined): CodexSandbox {
  return mode === 'acceptEdits' || mode === 'auto' || mode === 'bypassPermissions' ? 'workspace-write' : 'read-only';
}

/** Autonomia da ficha → sandbox (o mesmo que `sandboxFor`, a partir do nome da ficha). */
export function sandboxOfAutonomy(autonomy: Autonomy): CodexSandbox {
  return sandboxFor(autonomy === 'manual' ? 'default' : autonomy);
}

/** Nomes de modelo do Claude (alias ou id): numa ficha que trocou de motor, não valem para o Codex. */
const CLAUDE_MODEL = /^(claude-|opus|sonnet|haiku|fable|mythos|inherit|default)/i;

/** O modelo vale para o Codex? Alias/id do Claude não vale; o resto (slug `gpt-…` e os que vierem) segue. */
export function codexModelOrNull(model: string | null | undefined): string | null {
  return model && !CLAUDE_MODEL.test(model) ? model : null;
}

/** Texto como string básica do TOML (o valor de `-c chave=valor` é lido como TOML): aspas, barras e controles escapados. */
export function tomlString(text: string): string {
  // Metade de um par substituto (emoji cortado) não existe em TOML: vira U+FFFD. JSON.stringify não escapa o DEL (U+007F), o TOML exige.
  const whole = text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
  return JSON.stringify(whole).replace(/\u007f/g, '\\u007f');
}

export interface CodexSecretContext {
  /** Pasta onde a conversa roda (o projeto ou a worktree). */
  cwd: string;
  /** Pasta do projeto (onde fica `.vps`). */
  projectPath: string;
  /** Pasta pessoal do usuário (onde fica `.ssh`). */
  home: string;
  /** Chaves SSH das conexões do projeto (ver `secretDenyRules`). */
  keyFiles?: string[];
}

/**
 * Argumentos extras que bloqueiam a leitura de `~/.ssh` e `.vps` (o equivalente do `--disallowedTools` do Claude, ver
 * `secretDenyRules` em ficha.ts). É o ponto único dessa regra: tudo que a linha de comando do Codex precisar para isso entra aqui.
 *
 * TODO(segredos): a sintaxe certa no Codex 0.156 ainda não está confirmada, então por ora devolve só o que é certo, que é nada.
 * Sem isso, na sandbox `read-only` (e na `workspace-write`) o funcionário LÊ `~/.ssh` e `.vps`: a sandbox restringe a escrita, não a
 * leitura. Candidata a testar (vista em teste de outro agent, NÃO confirmada): perfil de permissões, como
 * `-c default_permissions="vpsdeny" -c permissions.vpsdeny.extends=":workspace"
 * -c permissions.vpsdeny.filesystem={":project_roots"={".vps"="deny"},"~/.ssh"="deny"}`. Completar aqui e ajustar o teste
 * de `codexSecretArgs` em tests/codexEngine.test.ts. Enquanto não, não ligar `engine: 'codex'` em quem acessa servidores.
 */
export function codexSecretArgs(_ctx: CodexSecretContext): string[] {
  return [];
}

/** O que o `chatSpawn` entrega para abrir uma conversa no Codex (no lugar dos argumentos do `claude`). */
export interface CodexSpawn {
  /** Autonomia da ficha: vira a sandbox (ver `sandboxFor`). */
  autonomy: Autonomy;
  model: string | null;
  effort: string | null;
  /** Identidade e ficha, para o `developer_instructions`. */
  instructions: string;
  writableRoots: string[];
  secretArgs: string[];
  /** thread_id gravado da conversa; null = a primeira mensagem abre uma thread nova. */
  threadId: string | null;
  /** Onde o thread_id é gravado (e lido ao reabrir). */
  threadFile: string;
}

export interface CodexRunOptions {
  /** Pasta de trabalho (o `cwd` do processo; na primeira execução vai também em `-C`). */
  cwd: string;
  model?: string | null;
  effort?: string | null;
  sandbox: CodexSandbox;
  /** Texto da ficha, vai em `developer_instructions` (a cada execução: a retomada usa a ficha atual). */
  instructions?: string | null;
  /** Pastas extras com escrita na `workspace-write` (a ficha, quando a conversa roda numa worktree). */
  writableRoots?: string[];
  /** Saída de `codexSecretArgs`. */
  secretArgs?: string[];
  /** thread_id da conversa: com ele, `exec resume`; sem, uma conversa nova. */
  threadId?: string | null;
}

/**
 * Argumentos depois de `codex`. O prompt vai pelo stdin (`-`). O `resume` não aceita `-s` nem `-C`: a sandbox vai por
 * `-c sandbox_mode` e a pasta é a do processo. `--ignore-user-config`: não lê o ~/.codex/config.toml (MCPs, plugins e
 * modelo padrão do usuário não entram na conversa do funcionário; a autenticação continua a mesma). A aprovação é
 * `never` (o exec não tem quem responda) e a rede da `workspace-write` fica desligada de forma explícita.
 */
export function buildCodexArgs(o: CodexRunOptions): string[] {
  const resume = !!o.threadId;
  const args = ['exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check', '--ignore-user-config'];
  if (!resume) args.push('-C', o.cwd, '-s', o.sandbox);
  else args.push('-c', `sandbox_mode=${tomlString(o.sandbox)}`);
  if (o.model) args.push('-m', o.model);
  if (o.effort) args.push('-c', `model_reasoning_effort=${tomlString(o.effort)}`);
  args.push('-c', 'approval_policy="never"');
  if (o.sandbox === 'workspace-write') {
    args.push('-c', 'sandbox_workspace_write.network_access=false');
    if (o.writableRoots?.length) args.push('-c', `sandbox_workspace_write.writable_roots=[${o.writableRoots.map(tomlString).join(',')}]`);
  }
  if (o.instructions) args.push('-c', `developer_instructions=${tomlString(o.instructions)}`);
  if (o.secretArgs?.length) args.push(...o.secretArgs);
  if (resume) args.push(o.threadId!);
  args.push('-');
  return args;
}
