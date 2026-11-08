import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Autonomy } from '../../shared/model';

// Linha de comando do Codex (CLI da OpenAI) para um funcionário com `engine: 'codex'`. Cada mensagem é uma execução
// de `codex exec --json` (a primeira) ou `codex exec resume <thread_id> --json` (as seguintes), com o prompt pelo stdin.
// Montagem pura dos argumentos (só olha o disco para saber quais pastas secretas existem), para testar sem abrir processo. Testado com o Codex CLI 0.156.1.

/** Sandbox do Codex: só leitura, ou escrita na pasta de trabalho (`:workspace`). `danger-full-access` e `--dangerously-*` nunca saem daqui. */
export type CodexSandbox = 'read-only' | 'workspace';

/**
 * Modo de permissão do Claudio’s Club (o `--permission-mode` do Claude Code) → sandbox do Codex. O `exec` não pergunta nada:
 * quem decide o que pode é a sandbox. plan e manual só leem; acceptEdits e auto escrevem na pasta de trabalho. A rede só alcança a própria máquina.
 * "Sem travas" (bypassPermissions) também fica na escrita da pasta de trabalho (`workspace`): no Codex ninguém roda sem sandbox por aqui. Modo desconhecido: só leitura.
 */
export function sandboxFor(mode: string | null | undefined): CodexSandbox {
  return mode === 'acceptEdits' || mode === 'auto' || mode === 'bypassPermissions' ? 'workspace' : 'read-only';
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

/** Nome do perfil de permissões que a conversa usa (`default_permissions`). */
export const CODEX_PROFILE = 'mycodeny';

/** Hosts da própria máquina que a sandbox deixa alcançar (a API do Claudio’s Club, para tarefas e despertador por curl). */
export const CODEX_LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

export interface CodexSecretContext {
  /** Pasta onde a conversa roda (o projeto ou a worktree). */
  cwd: string;
  /** Pasta do projeto (onde fica `.vps`; numa worktree é outra pasta que `cwd`). */
  projectPath: string;
  /** Pasta pessoal do usuário (onde fica `.ssh`). */
  home: string;
  /** Pasta de dados do Claudio’s Club (`~/.myco`): o cofre de senhas, que guarda também a chave do pareamento, fica em `secrets`. */
  mycoHome: string;
}

const statOf = (p: string) => statSync(p, { throwIfNoEntry: false });

/**
 * O que o funcionário não pode ler: `~/.ssh`, o cofre `<mycoHome>/secrets` e `.vps` (conexões e ssh_config; o da pasta da conversa e o
 * do projeto, que numa worktree são pastas diferentes). Só entra o que existe: negar um caminho que não existe faz o Codex criar no lugar
 * um arquivo vazio e somente leitura (um `.vps` vazio impediria o Claudio’s Club de criar a pasta `.vps` depois). A lista é refeita a
 * cada execução, então um `.vps` criado no meio da conversa passa a valer na mensagem seguinte.
 *
 * Limite provado no Codex 0.156.1 com o bwrap do sistema (0.13.1): só UM arquivo regular pode ser negado por execução (o segundo quebra
 * com "Bad file descriptor", falha segura); pastas não têm limite. Por isso as chaves SSH das conexões não entram aqui (quem tem
 * servidor na ficha não roda no Codex, ver `codexProfileError`): ficam só pastas, e se um `.vps` for arquivo, entra o primeiro.
 */
export function codexDenyPaths(ctx: CodexSecretContext): string[] {
  const dirs: string[] = [];
  const files: string[] = [];
  const add = (shown: string, real = shown) => {
    const st = statOf(real);
    if (!st || dirs.includes(shown) || files.includes(shown)) return;
    (st.isDirectory() ? dirs : files).push(shown);
  };
  // `~/.ssh` vai com o til (o Codex expande); os outros, com o caminho completo.
  add('~/.ssh', path.join(ctx.home, '.ssh'));
  add(path.join(ctx.mycoHome, 'secrets'));
  for (const root of new Set([ctx.cwd, ctx.projectPath])) add(path.join(root, '.vps'));
  return [...dirs, ...files.slice(0, 1)];
}

export interface CodexSafetyOptions extends CodexSecretContext {
  /** `read-only`: só lê. `workspace`: escreve na pasta de trabalho. */
  mode: 'read-only' | 'workspace';
  /** `off`: sem rede. `loopback`: só a própria máquina (127.0.0.1 e localhost), para a API do Claudio’s Club. */
  network: 'off' | 'loopback';
  /** Pastas extras com escrita no modo `workspace` (a ficha, quando a conversa roda numa worktree). */
  writableRoots?: string[];
}

/**
 * Argumentos de segurança de TODA execução do Codex dentro do Claudio’s Club: os do motor dos funcionários e os de qualquer ferramenta que
 * abra o `codex exec` (ex.: "perguntar ao GPT", só leitura). Não dependem de ficha. Devolve, para pôr depois de `exec`:
 *
 * - `--ignore-user-config`: não lê o ~/.codex/config.toml (MCPs, plugins e modelo padrão do usuário ficam de fora; o login continua).
 * - `-c features.apps=false`: sem os conectores da conta do ChatGPT (GitHub, e-mail, Notion, deploy…), que rodam FORA da sandbox.
 * - `-c approval_policy="never"`: o exec não tem quem responda; a sandbox decide.
 * - o perfil de permissões (`codexProfileArgs`): sandbox, negações de segredos e rede. O perfil substitui o `-s`: nunca passe `-s` junto.
 *
 * Nunca `danger-full-access` nem `--dangerously-*`. Quem chama monta o resto (`-C`, `-m`, `--json`, o prompt).
 */
export function codexSafetyArgs(o: CodexSafetyOptions): string[] {
  return ['--ignore-user-config', '-c', 'features.apps=false', '-c', 'approval_policy="never"', ...codexProfileArgs(o)];
}

/**
 * Perfil de permissões da conversa. Provado com `codex sandbox` e `codex exec` (0.156.1, sem editar o config.toml):
 *
 *   -c default_permissions="mycodeny"
 *   -c permissions.mycodeny.extends=":workspace"            (":read-only" no modo de só leitura)
 *   -c permissions.mycodeny.filesystem={"~/.ssh"="deny","/proj/.vps"="deny","/pasta/extra"="write"}
 *   -c permissions.mycodeny.network={enabled=true,domains={"127.0.0.1"="allow","localhost"="allow"}}   (`loopback`)
 *   --enable network_proxy                                                                              (`loopback`)
 *   -c permissions.mycodeny.network={enabled=false}                                                     (`off`)
 *
 * - filesystem: `deny` barra leitura e escrita (caminho exato; glob como `**\/.vps` NÃO protege o conteúdo); `write` libera escrita extra.
 * - network `loopback`: só com o `network_proxy` ligado (recurso experimental do Codex) a lista de domínios vale. A rede passa a sair só
 *   pelo proxy dele: 127.0.0.1 e localhost respondem; qualquer outro domínio é recusado ("not on the allowlist") e conexão direta (ssh,
 *   /dev/tcp, curl --noproxy) dá "Network is unreachable". Sem o recurso, `enabled=true` liberaria a rede inteira.
 * - A lista de domínios não tem porta: qualquer serviço local da máquina fica ao alcance, não só o do Claudio’s Club.
 */
export function codexProfileArgs(o: CodexSafetyOptions): string[] {
  const entries = [
    ...codexDenyPaths(o).map((p) => `${tomlString(p)}="deny"`),
    // A escrita extra só faz sentido no modo de escrita (o de leitura nunca escreve).
    ...(o.mode === 'workspace' ? (o.writableRoots ?? []).map((p) => `${tomlString(p)}="write"`) : []),
  ];
  const key = `permissions.${CODEX_PROFILE}`;
  const network =
    o.network === 'loopback'
      ? [
          '-c', `${key}.network={enabled=true,domains={${CODEX_LOOPBACK_HOSTS.map((h) => `${tomlString(h)}="allow"`).join(',')}}}`,
          '--enable', 'network_proxy',
        ]
      : ['-c', `${key}.network={enabled=false}`];
  return [
    '-c', `default_permissions=${tomlString(CODEX_PROFILE)}`,
    '-c', `${key}.extends=${tomlString(o.mode === 'workspace' ? ':workspace' : ':read-only')}`,
    '-c', `${key}.filesystem={${entries.join(',')}}`,
    ...network,
  ];
}

/**
 * Por que esta ficha não pode rodar no Codex (null = pode). Servidor na ficha não combina: a sandbox não tem rede para eles, e as
 * chaves SSH das conexões não cabem no bloqueio (o bwrap só nega um arquivo por execução). O esforço `ultra` é só do Codex.
 */
export function codexProfileError(p: { engine?: string; servers: readonly string[]; effort?: string | null }): string | null {
  if (p.engine === 'codex' && p.servers.length) return 'Quem tem servidores na ficha não pode rodar no Codex: tire os servidores ou use o Claude';
  if (p.effort === 'ultra' && p.engine !== 'codex') return 'O esforço ultra só existe no Codex';
  return null;
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
  /** O que o bloqueio de segredos precisa saber (a pasta da conversa vem do `cwd` do spawn). */
  secrets: Omit<CodexSecretContext, 'cwd'>;
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
  /** Pastas extras com escrita no modo de escrita (a ficha, quando a conversa roda numa worktree). */
  writableRoots?: string[];
  /** Para o bloqueio de segredos (ver `codexSafetyArgs`); sem isso, vale a pasta de trabalho e a pasta pessoal desta máquina. */
  secrets?: Partial<Omit<CodexSecretContext, 'cwd'>>;
  /** thread_id da conversa: com ele, `exec resume`; sem, uma conversa nova. */
  threadId?: string | null;
}

/**
 * Argumentos depois de `codex`. O prompt vai pelo stdin (`-`). Segurança (config do usuário, conectores, aprovação, sandbox, segredos e
 * rede) vem toda de `codexSafetyArgs`, igual na primeira execução e no `resume` (que não aceita `-s` nem `-C`: a pasta é a do processo);
 * a rede é a `loopback`, para o curl da API do Claudio’s Club (tarefas e despertador).
 */
export function buildCodexArgs(o: CodexRunOptions): string[] {
  const resume = !!o.threadId;
  const home = o.secrets?.home ?? os.homedir();
  const args = ['exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check'];
  if (!resume) args.push('-C', o.cwd);
  if (o.model) args.push('-m', o.model);
  if (o.effort) args.push('-c', `model_reasoning_effort=${tomlString(o.effort)}`);
  args.push(
    ...codexSafetyArgs({
      mode: o.sandbox,
      cwd: o.cwd,
      projectPath: o.secrets?.projectPath ?? o.cwd,
      home,
      mycoHome: o.secrets?.mycoHome ?? path.join(home, '.myco'),
      network: 'loopback',
      writableRoots: o.writableRoots,
    }),
  );
  if (o.instructions) args.push('-c', `developer_instructions=${tomlString(o.instructions)}`);
  if (resume) args.push(o.threadId!);
  args.push('-');
  return args;
}
