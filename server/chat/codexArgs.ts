import { statSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Autonomy } from '../../shared/model';

// Linha de comando do Codex (CLI da OpenAI) para um funcionário com `engine: 'codex'`. Cada mensagem é uma execução
// de `codex exec --json` (a primeira) ou `codex exec resume <thread_id> --json` (as seguintes), com o prompt pelo stdin.
// Montagem pura dos argumentos (só olha o disco para saber quais pastas secretas existem), para testar sem abrir processo. Testado com o Codex CLI 0.156.1 e 0.167.0.

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

/** Recusa de rodar o Codex (falha fechada): a mensagem é para o usuário, em português, e acaba como erro da conversa. */
export class CodexBlockedError extends Error {}

/** Existe? `null` se não existe. Qualquer outro erro (permissão, link em laço…) recusa rodar: não dá para provar que o segredo está protegido. */
function statOf(p: string): Stats | null {
  try {
    return statSync(p, { throwIfNoEntry: false }) ?? null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new CodexBlockedError(
      `Não consegui conferir ${p} (${code ?? 'erro desconhecido'}): não rodo o Codex assim, para não deixar um segredo legível. Corrija a permissão ou o link desse caminho e tente de novo.`,
    );
  }
}

/**
 * O que o funcionário não pode ler: `~/.ssh`, o cofre `<mycoHome>/secrets` e `.vps` (conexões e ssh_config; o da pasta da conversa e o
 * do projeto, que numa worktree são pastas diferentes). Só entra o que existe: negar um caminho que não existe faz o Codex criar no lugar
 * um arquivo vazio e somente leitura (um `.vps` vazio impediria o Claudio’s Club de criar a pasta `.vps` depois). A lista é refeita a
 * cada execução, então um `.vps` criado no meio da conversa passa a valer na mensagem seguinte.
 *
 * Limite provado no Codex 0.156.1 e 0.167.0 com o bwrap do sistema (0.13.1): só UM arquivo regular pode ser negado por execução (o segundo
 * quebra com "Bad file descriptor"); pastas não têm limite. Por isso as chaves SSH das conexões não entram aqui (quem tem servidor na
 * ficha não roda no Codex, ver `codexProfileError`): ficam só pastas. Se sobrar mais de um arquivo regular (um `.vps` que é arquivo na
 * pasta da conversa e outro no projeto), os de sobra ficariam legíveis em silêncio: falha fechada, `CodexBlockedError` e nada roda.
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
  if (files.length > 1) {
    throw new CodexBlockedError(
      `Há mais de um arquivo para proteger (${files.join(', ')}) e a sandbox do Codex só consegue negar um arquivo regular por execução: os outros ficariam legíveis. Não rodo o Codex assim. Troque esses arquivos por pastas (ou apague os que não usa) e tente de novo.`,
    );
  }
  return [...dirs, ...files];
}

export interface CodexSafetyOptions extends CodexSecretContext {
  /** `read-only`: só lê. `workspace`: escreve na pasta de trabalho. */
  mode: 'read-only' | 'workspace';
  /** `off`: sem rede. `loopback`: só a própria máquina (127.0.0.1 e localhost), para a API do Claudio’s Club. */
  network: 'off' | 'loopback';
  /** Pastas extras com escrita no modo `workspace` (a pasta das fichas, quando a conversa roda numa worktree). */
  writableRoots?: string[];
  /** Arquivos e pastas que existem e ficam só para leitura no modo `workspace`, mesmo dentro da pasta de trabalho (a própria ficha do funcionário). */
  readOnlyPaths?: string[];
}

/**
 * Argumentos de segurança de TODA execução do Codex dentro do Claudio’s Club: os do motor dos funcionários e os de qualquer ferramenta que
 * abra o `codex exec` (ex.: "perguntar ao GPT", só leitura). Não dependem de ficha. Devolve, para pôr depois de `exec`:
 *
 * - `--ignore-user-config`: não lê o ~/.codex/config.toml (MCPs, plugins e modelo padrão do usuário ficam de fora; o login continua).
 * - `-c features.apps=false`: sem os conectores da conta do ChatGPT (GitHub, e-mail, Notion, deploy…), que rodam FORA da sandbox.
 * - `-c approval_policy="never"`: o exec não tem quem responda; a sandbox decide.
 * - `-c web_search="disabled"`: a busca na web é uma ferramenta hospedada (roda nos servidores da OpenAI, fora da sandbox) e serviria de
 *   canal para vazar dados na consulta. Provado no 0.167.0: sem isso o `codex exec --json` emite o item `web_search`; com isso o modelo
 *   responde que não tem a ferramenta. Os valores aceitos são `disabled`, `cached`, `indexed` e `live`.
 * - o perfil de permissões (`codexProfileArgs`): sandbox, negações de segredos e rede. O perfil substitui o `-s`: nunca passe `-s` junto.
 *
 * Nunca `danger-full-access` nem `--dangerously-*`. Quem chama monta o resto (`-C`, `-m`, `--json`, o prompt).
 */
export function codexSafetyArgs(o: CodexSafetyOptions): string[] {
  return ['--ignore-user-config', '-c', 'features.apps=false', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', ...codexProfileArgs(o)];
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
 * - filesystem: `deny` barra leitura e escrita (caminho exato; glob como `**\/.vps` NÃO protege o conteúdo); `write` libera escrita extra
 *   (só pasta: num arquivo o bwrap do 0.167.0 quebra com "Not a directory"); `read` deixa só para leitura, e funciona em arquivo e em pasta
 *   mesmo dentro da pasta de trabalho (várias entradas juntas, com um `deny` de arquivo, também funcionam). Por isso a ficha do próprio
 *   funcionário (`readOnlyPaths`) fica só leitura, mas a pasta das fichas inteira NÃO pode ser `read` com a memória em `write`.
 * - network `loopback`: só com o `network_proxy` ligado (recurso experimental do Codex) a lista de domínios vale. A rede passa a sair só
 *   pelo proxy dele: 127.0.0.1 e localhost respondem; qualquer outro domínio é recusado ("not on the allowlist") e conexão direta (ssh,
 *   /dev/tcp, curl --noproxy) dá "Network is unreachable". Sem o recurso, `enabled=true` liberaria a rede inteira.
 * - A lista de domínios não tem porta: qualquer serviço local da máquina fica ao alcance, não só o do Claudio’s Club.
 */
export function codexProfileArgs(o: CodexSafetyOptions): string[] {
  /** Só o que existe: `read` num caminho que não existe faz o Codex criar um arquivo vazio no lugar (o mesmo cuidado do `deny`). */
  const existing = (paths: string[]) => paths.filter((p) => statOf(p));
  const entries = [
    ...codexDenyPaths(o).map((p) => `${tomlString(p)}="deny"`),
    // A escrita extra e o "só leitura" dentro da pasta de trabalho só fazem sentido no modo de escrita (o de leitura nunca escreve).
    ...(o.mode === 'workspace' ? (o.writableRoots ?? []).map((p) => `${tomlString(p)}="write"`) : []),
    ...(o.mode === 'workspace' ? existing(o.readOnlyPaths ?? []).map((p) => `${tomlString(p)}="read"`) : []),
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
  /** Identidade e ficha, para o `developer_instructions` (ou para o começo do prompt, se for grande: ver `instructionsInArgv`). */
  instructions: string;
  writableRoots: string[];
  /** A ficha do próprio funcionário (JSON, Markdown, histórico): fica só leitura na sandbox (ver `codexProfileArgs`). */
  readOnlyPaths: string[];
  /** O que o bloqueio de segredos precisa saber (a pasta da conversa vem do `cwd` do spawn). */
  secrets: Omit<CodexSecretContext, 'cwd'>;
  /** thread_id gravado da conversa; null = a primeira mensagem abre uma thread nova. */
  threadId: string | null;
  /** Onde o thread_id é gravado (e lido ao reabrir). */
  threadFile: string;
}

/**
 * O bloqueio de segredos: a pasta do projeto e a pasta pessoal valem as da pasta de trabalho e desta máquina quando faltam, mas a pasta de
 * dados do Claudio’s Club (`mycoHome`, que respeita o MYCO_HOME) é obrigatória: um padrão `~/.myco` ignoraria o MYCO_HOME em silêncio.
 */
export type CodexSecrets = Partial<Omit<CodexSecretContext, 'cwd' | 'mycoHome'>> & Pick<CodexSecretContext, 'mycoHome'>;

export interface CodexRunOptions {
  /** Pasta de trabalho (o `cwd` do processo; na primeira execução vai também em `-C`). */
  cwd: string;
  model?: string | null;
  effort?: string | null;
  sandbox: CodexSandbox;
  /**
   * Texto da ficha, vai em `developer_instructions` (a cada execução: a retomada usa a ficha atual) enquanto couber na linha de comando
   * (ver `instructionsInArgv`); passando do limite, não vai aqui: quem chama manda no começo do prompt da primeira mensagem.
   */
  instructions?: string | null;
  /** Pastas extras com escrita no modo de escrita (a pasta das fichas, quando a conversa roda numa worktree). */
  writableRoots?: string[];
  /** Arquivos e pastas da ficha do funcionário que ficam só leitura no modo de escrita (os que existem). */
  readOnlyPaths?: string[];
  /** Para o bloqueio de segredos (ver `codexSafetyArgs`). */
  secrets: CodexSecrets;
  /** `loopback`: a API do Claudio’s Club por curl (só com o `network_proxy` conferido, ver codexEnv.ts). `off`: sem rede nenhuma. */
  network: 'off' | 'loopback';
  /** thread_id da conversa: com ele, `exec resume`; sem, uma conversa nova. */
  threadId?: string | null;
  /** Sistema (os testes trocam): no Windows as instruções nunca vão na linha de comando. */
  platform?: NodeJS.Platform;
}

/**
 * Limite do `developer_instructions` na linha de comando. O Linux recusa um argumento acima de 128 KB (`MAX_ARG_STRLEN`) e o Windows, a
 * linha inteira acima de ~32 KB: o texto passa de 24 KB, vai no começo do prompt. Não há arquivo para isso no Codex (0.167.0): só
 * `model_instructions_file`, que TROCA as instruções base do Codex em vez de somar, e `AGENTS.md`, que mora na pasta do projeto.
 */
export const CODEX_ARGV_INSTRUCTIONS_MAX = 24 * 1024;

/** As instruções cabem na linha de comando? Nunca no Windows (a linha toda tem ~32 KB e leva também o perfil e o resto). */
export function instructionsInArgv(text: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && Buffer.byteLength(tomlString(text), 'utf8') <= CODEX_ARGV_INSTRUCTIONS_MAX;
}

/** A ficha no começo do prompt da primeira mensagem (o histórico da conversa a guarda; as seguintes não a repetem). */
export function promptWithInstructions(instructions: string, prompt: string): string {
  return [
    '[Instruções desta conversa: a identidade e a ficha do funcionário. Valem para todas as mensagens, não só para esta.]',
    instructions.trim(),
    '[Fim das instruções. A mensagem começa abaixo.]',
    prompt,
  ].join('\n\n');
}

/**
 * Argumentos depois de `codex`. O prompt vai pelo stdin (`-`). Segurança (config do usuário, conectores, busca na web, aprovação, sandbox,
 * segredos e rede) vem toda de `codexSafetyArgs`, igual na primeira execução e no `resume` (que não aceita `-s` nem `-C`: a pasta é a do
 * processo). A rede é a que quem chama manda (`network`): `loopback` só depois de conferir o `network_proxy` (ver codexEnv.ts).
 */
export function buildCodexArgs(o: CodexRunOptions): string[] {
  const resume = !!o.threadId;
  const args = ['exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check'];
  if (!resume) args.push('-C', o.cwd);
  if (o.model) args.push('-m', o.model);
  if (o.effort) args.push('-c', `model_reasoning_effort=${tomlString(o.effort)}`);
  args.push(
    ...codexSafetyArgs({
      mode: o.sandbox,
      cwd: o.cwd,
      projectPath: o.secrets.projectPath ?? o.cwd,
      home: o.secrets.home ?? os.homedir(),
      mycoHome: o.secrets.mycoHome,
      network: o.network,
      writableRoots: o.writableRoots,
      readOnlyPaths: o.readOnlyPaths,
    }),
  );
  if (o.instructions && instructionsInArgv(o.instructions, o.platform)) args.push('-c', `developer_instructions=${tomlString(o.instructions)}`);
  if (resume) args.push(o.threadId!);
  args.push('-');
  return args;
}
