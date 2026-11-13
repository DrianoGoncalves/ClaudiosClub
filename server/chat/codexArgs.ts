import { statSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FTP_MCP_NAME, GPT_MCP_NAME, type Autonomy } from '../../shared/model';
import { SANDBOX_HOST } from '../callers';

// Linha de comando do Codex (CLI da OpenAI) para um funcionário com `engine: 'codex'`. Cada mensagem é uma execução
// de `codex exec --json` (a primeira) ou `codex exec resume <thread_id> --json` (as seguintes), com o prompt pelo stdin.
// Montagem pura dos argumentos (só olha o disco para saber quais pastas secretas existem), para testar sem abrir processo. Testado com o Codex CLI 0.156.1 e 0.167.0.

/** Sandbox do Codex: só leitura, ou escrita na pasta de trabalho (`:workspace`). `danger-full-access` e `--dangerously-*` nunca saem daqui. */
export type CodexSandbox = 'read-only' | 'workspace';

/**
 * Modo de permissão do Claudio’s Club (o `--permission-mode` do Claude Code) → sandbox do Codex. O `exec` não pergunta nada:
 * quem decide o que pode é a sandbox. plan e manual só leem; acceptEdits e auto escrevem na pasta de trabalho. A rede só alcança o Claudio’s Club, em 127.0.0.2.
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

/**
 * Hosts que a sandbox deixa alcançar: só o endereço do Claudio’s Club para o Codex (127.0.0.2, tarefas e despertador por curl). Nunca 127.0.0.1 nem
 * `localhost`: o servidor escuta nos dois endereços e trata quem chega por 127.0.0.2 como "da sandbox do Codex" (ver server/callers.ts), com o
 * token da conversa e só as rotas da lista (apiPolicy.ts). Pelo 127.0.0.1 a sandbox nem chega: o proxy recusa.
 */
export const CODEX_APP_HOSTS = [SANDBOX_HOST];

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
 * quebra com "Bad file descriptor"); pastas não têm limite. Por isso as chaves SSH das conexões não entram aqui: o cadastro só aceita chave
 * em ~/.ssh, no `.vps` ou no cofre (ver servers.ts), e as três pastas já são negadas. Se sobrar mais de um arquivo regular (um `.vps` que é arquivo na
 * pasta da conversa e outro no projeto), os de sobra ficariam legíveis em silêncio: falha fechada, `CodexBlockedError` e nada roda.
 *
 * Também as pastas de lançamento (`<mycoHome>/run`, com o mcp.json das sessões) e os backups do ~/.claude.json (`<mycoHome>/backups`
 * e `~/.claude/backups`). O `~/.claude.json` só entra se, depois de tudo, não sobrou arquivo: é o único arquivo da home que cabe.
 * Limite da sandbox: os `.claude.json.backup*` e `.tmp.*` da home ficam legíveis no Codex.
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
  add(path.join(ctx.mycoHome, 'run'));
  add(path.join(ctx.mycoHome, 'backups'));
  add(path.join(ctx.home, '.claude', 'backups'));
  for (const root of new Set([ctx.cwd, ctx.projectPath])) add(path.join(root, '.vps'));
  if (files.length > 1) {
    throw new CodexBlockedError(
      `Há mais de um arquivo para proteger (${files.join(', ')}) e a sandbox do Codex só consegue negar um arquivo regular por execução: os outros ficariam legíveis. Não rodo o Codex assim. Troque esses arquivos por pastas (ou apague os que não usa) e tente de novo.`,
    );
  }
  // Depois dos `.vps` (que têm prioridade): só entra se sobrou o lugar do arquivo.
  if (files.length === 0) add(path.join(ctx.home, '.claude.json'));
  return [...dirs, ...files];
}

export interface CodexSafetyOptions extends CodexSecretContext {
  /** `read-only`: só lê. `workspace`: escreve na pasta de trabalho. */
  mode: 'read-only' | 'workspace';
  /** `off`: sem rede. `loopback`: só o endereço do Claudio’s Club para o Codex (127.0.0.2, ver `CODEX_APP_HOSTS`), para a API dele. */
  network: 'off' | 'loopback';
  /** Busca na web ("Permitir acesso à internet"): `true` = `live`; ausente ou `false` = `disabled` (falha fechada). Não mexe no terminal, que segue sem rede (`network`). */
  webSearch?: boolean;
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
 * - `-c web_search="live"` ou `"disabled"` (opção `webSearch`, a "Permitir acesso à internet" das Configurações): a busca na web é uma
 *   ferramenta hospedada (roda nos servidores da OpenAI, fora da sandbox), então pode levar dado da consulta para fora. Por isso é escolha
 *   do usuário: ligada, o modelo pesquisa; desligada, não tem a ferramenta. O terminal do funcionário continua sem rede (`network`), com
 *   ou sem ela. Provado no 0.167.0: com `disabled` o `codex exec --json` não emite o item `web_search` e o modelo diz que não tem a
 *   ferramenta. Os valores aceitos são `disabled`, `cached`, `indexed` e `live`.
 * - o perfil de permissões (`codexProfileArgs`): sandbox, negações de segredos e rede. O perfil substitui o `-s`: nunca passe `-s` junto.
 *
 * Nunca `danger-full-access` nem `--dangerously-*`. Quem chama monta o resto (`-C`, `-m`, `--json`, o prompt).
 */
export function codexSafetyArgs(o: CodexSafetyOptions): string[] {
  const webSearch = o.webSearch === true ? 'web_search="live"' : 'web_search="disabled"';
  return ['--ignore-user-config', '-c', 'features.apps=false', '-c', 'approval_policy="never"', '-c', webSearch, ...codexProfileArgs(o)];
}

/**
 * Perfil de permissões da conversa. Provado com `codex sandbox` e `codex exec` (0.156.1, sem editar o config.toml):
 *
 *   -c default_permissions="mycodeny"
 *   -c permissions.mycodeny.extends=":workspace"            (":read-only" no modo de só leitura)
 *   -c permissions.mycodeny.filesystem={"~/.ssh"="deny","/proj/.vps"="deny","/pasta/extra"="write"}
 *   -c permissions.mycodeny.network={enabled=true,domains={"127.0.0.2"="allow"}}   (`loopback`)
 *   --enable network_proxy                                                                              (`loopback`)
 *   -c permissions.mycodeny.network={enabled=false}                                                     (`off`)
 *
 * - filesystem: `deny` barra leitura e escrita (caminho exato; glob como `**\/.vps` NÃO protege o conteúdo); `write` libera escrita extra
 *   (só pasta: num arquivo o bwrap do 0.167.0 quebra com "Not a directory"); `read` deixa só para leitura, e funciona em arquivo e em pasta
 *   mesmo dentro da pasta de trabalho (várias entradas juntas, com um `deny` de arquivo, também funcionam). Por isso a ficha do próprio
 *   funcionário (`readOnlyPaths`) fica só leitura, mas a pasta das fichas inteira NÃO pode ser `read` com a memória em `write`.
 * - network `loopback`: só com o `network_proxy` ligado (recurso experimental do Codex) a lista de domínios vale. A rede passa a sair só
 *   pelo proxy dele: 127.0.0.2 responde; qualquer outro domínio, inclusive 127.0.0.1 e localhost, é recusado (403 "not on the allowlist" do proxy)
 *   e conexão direta (ssh, /dev/tcp, curl --noproxy) dá "Network is unreachable". Sem o recurso, `enabled=true` liberaria a rede inteira.
 * - A lista de domínios não tem porta: serviço local que escute em todas as interfaces (0.0.0.0) fica ao alcance por 127.0.0.2, não só o do
 *   Claudio’s Club. Os que escutam só em 127.0.0.1 (como o próprio Claudio’s Club, na tela) ficam fora.
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
          '-c', `${key}.network={enabled=true,domains={${CODEX_APP_HOSTS.map((h) => `${tomlString(h)}="allow"`).join(',')}}}`,
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
 * Por que esta ficha não pode rodar no Codex (null = pode). Conexão FTP não combina com o Codex (o MCP de FTP roda como o do Claude, sem
 * o bloqueio do Codex; quem a confere é o projeto, via `ftpServers`). Conexão SSH combina: o MCP myco-ssh roda fora da sandbox (ver
 * `codexSshMcpArgs`). O esforço `ultra` é só do Codex.
 */
export function codexProfileError(p: { engine?: string; servers: readonly string[]; effort?: string | null; ftpServers?: readonly string[] }): string | null {
  if (p.engine === 'codex' && p.ftpServers?.some((n) => p.servers.includes(n))) return 'Conexão FTP não funciona no Codex: tire as conexões FTP ou use o Claude';
  if (p.effort === 'ultra' && p.engine !== 'codex') return 'O esforço ultra só existe no Codex';
  return null;
}

/** Servidor MCP que a conversa do Codex sobe (`command` + `args`), montado fora daqui (ver server/staff/sshMcp.ts). */
export interface CodexMcpServer {
  command: string;
  args: string[];
  /** Pasta do processo do MCP (o ROOT do Claudio’s Club, fora do projeto da conversa). Sem ela, o Codex usa a pasta de trabalho. */
  cwd?: string;
  /** Ferramentas que a conversa vê (acesso da ficha, ver server/staff/mcpAccess.ts): `enabled_tools`. Ausente = todas as do MCP. */
  enabledTools?: string[];
}

/** Nome do MCP de SSH na configuração do Codex (`mcp_servers.<nome>`). É o mesmo do Claude (`SSH_MCP_NAME`, em server/staff/sshMcp.ts). */
export const CODEX_SSH_MCP_NAME = 'myco-ssh';

/** Nome do MCP do Chrome do usuário (Playwright MCP em modo extensão) na configuração do Codex. Ver `codexChromeMcpArgs`. */
export const CODEX_CHROME_MCP_NAME = 'myco-chrome';

/**
 * Os `-c mcp_servers.<nome>.*` de um MCP da conversa (command, args, cwd e aprovação). Igual para o SSH e para o Chrome. `enabled`: as
 * ferramentas que a conversa vê (allowlist, `enabled_tools`); ausente = o Codex não põe filtro.
 */
function codexMcpArgs(name: string, s: CodexMcpServer | null | undefined, enabled?: string[]): string[] {
  if (!s) return [];
  const key = `mcp_servers.${name}`;
  return [
    '-c', `${key}.command=${tomlString(s.command)}`,
    '-c', `${key}.args=[${s.args.map((a) => tomlString(a)).join(',')}]`,
    ...(s.cwd ? ['-c', `${key}.cwd=${tomlString(s.cwd.replace(/\\/g, '/'))}`] : []),
    '-c', `${key}.default_tools_approval_mode=${tomlString('approve')}`,
    ...(enabled ? ['-c', `${key}.enabled_tools=[${enabled.map((t) => tomlString(t)).join(',')}]`] : []),
  ];
}

/**
 * Os `-c mcp_servers.myco-ssh.*` da conversa. Só este MCP entra por aqui. `default_tools_approval_mode="approve"` é obrigatório no
 * `codex exec` (provado no 0.167): sem ele, com `approval_policy="never"`, o Codex recusa a chamada. Por isso a barreira é o próprio
 * MCP (conexões da ficha e `sshWrite`) e o texto da ficha, não a aprovação do Codex.
 */
export function codexSshMcpArgs(s: CodexMcpServer | null | undefined): string[] {
  return codexMcpArgs(CODEX_SSH_MCP_NAME, s, s?.enabledTools);
}

/**
 * Ferramentas do Playwright MCP que a conversa do Codex vê (`enabled_tools`, allowlist): navegar, ler (snapshot e screenshot), clicar,
 * digitar, abas e espera. Fica DE FORA, de propósito: código no processo do MCP (`browser_run_code_unsafe`), script na página
 * (`browser_evaluate`), cookies e armazenamento do navegador (`browser_cookie_*`, `browser_storage_state`, `*storage_*`), rede e rotas
 * (`browser_network_*`, `browser_route*`), upload e PDF de arquivo local (`browser_file_upload`, `browser_drop`, `browser_pdf_save`),
 * ferramentas que a página registra (`browser_webmcp_*`) e o resto (`browser_fill_form`, `browser_hover`, `browser_select_option`...).
 */
export const CHROME_MCP_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_tabs',
  'browser_wait_for',
];

/**
 * Os `-c mcp_servers.myco-chrome.*` da conversa: o Chrome do usuário (abas e logins) pelo Playwright MCP em modo extensão. Mesma regra de
 * aprovação do SSH (`approve`, ver `codexSshMcpArgs`): sem ela o Codex recusa a chamada. Por isso a barreira é a allowlist
 * (`CHROME_MCP_TOOLS`, o Codex não expõe as outras), a ficha (pedir o ok antes de enviar, publicar, comprar, apagar ou enviar formulário)
 * e a extensão, que pede a aprovação do usuário ao conectar (sem token). Só entra com "Permitir que o GPT use meu Chrome" ligada, ficha
 * com Navegador e sem o MCP de SSH (ver launch.ts).
 */
export function codexChromeMcpArgs(s: CodexMcpServer | null | undefined): string[] {
  if (!s) return [];
  // Com lista da ficha, só as que estão na allowlist do Chrome (interseção: a ficha tira, não põe).
  const only = s.enabledTools;
  const enabled = only ? CHROME_MCP_TOOLS.filter((t) => only.includes(t)) : CHROME_MCP_TOOLS;
  return codexMcpArgs(CODEX_CHROME_MCP_NAME, s, enabled);
}

/** Nome do navegador limpo (Playwright MCP com perfil em memória, sem logins) na configuração do Codex e no mcp.json do Claude. */
export const CLEAN_BROWSER_MCP_NAME = 'myco-navegador';

/**
 * Ferramentas do navegador limpo: as do Chrome do usuário, mais as que testam sem login (redimensionar, para ver o celular; console; passar o
 * mouse; selecionar). Perfil isolado, então nada do dono aparece nele. Continua de fora: código no processo do MCP, script na página, upload e
 * arrastar arquivo, PDF, cookies e armazenamento, rede e rotas, e as ferramentas que a página registra (webmcp).
 */
export const CLEAN_BROWSER_TOOLS = [...CHROME_MCP_TOOLS, 'browser_resize', 'browser_console_messages', 'browser_hover', 'browser_select_option'];

/**
 * Ferramentas do navegador limpo que o Claude não usa (`--disallowedTools`). No Claude não há allowlist de ferramenta de MCP, então se nega o que
 * roda código no processo do MCP ou mexe em arquivo local (um upload de `.env` passaria por cima das regras de segredo). É denylist: vale para a
 * versão do Playwright MCP fixada no package.json; uma ferramenta nova dele precisa ser revista aqui.
 */
export const CLEAN_BROWSER_DENIED = [
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
  'browser_pdf_save',
  'browser_storage_state',
  'browser_set_storage_state',
  'browser_route',
  'browser_network_state_set',
];

/** Os `-c mcp_servers.myco-navegador.*` da conversa do Codex (ver `codexMcpArgs`). Sem o MCP, nada. */
export function codexCleanBrowserMcpArgs(s: CodexMcpServer | null | undefined): string[] {
  return codexMcpArgs(CLEAN_BROWSER_MCP_NAME, s, CLEAN_BROWSER_TOOLS);
}

/**
 * MCP extra da conversa do Codex: os da biblioteca do Club e os da ficha (projeto, usuário ou local), montados em `codexMcpServers`
 * (server/staff/mcp.ts). Stdio: o comando e os argumentos (o lançador). http: a `url` e, com cabeçalho, `headersHelper` (o comando que imprime
 * o JSON dos cabeçalhos; é o mesmo formato do `headersHelper` do Claude Code, ver `quotedCommand`). Nunca valor de env ou cabeçalho aqui:
 * eles ficam no cofre ou no arquivo de lançamento da conversa, que a sandbox nega.
 */
export type CodexExtraMcp = { name: string; enabledTools?: string[] } & ({ command: string; args: string[] } | { url: string; headersHelper?: string });

/** Nome de MCP que o Codex aceita em `mcp_servers.<nome>`. Sem ponto: o ponto vira tabela aninhada no TOML. */
export const CODEX_EXTRA_MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Nomes que um MCP da biblioteca ou da ficha não pode usar no Codex: os internos (SSH, Chrome do usuário, navegador limpo, FTP e GPT) e o
 * "claude-in-chrome" (a chave do Chrome do Claude, ver mcpAccess.ts). Se um MCP do projeto tivesse um desses nomes, sobrescreveria o interno.
 */
export const CODEX_RESERVED_MCP_NAMES: ReadonlySet<string> = new Set([
  CODEX_SSH_MCP_NAME,
  CODEX_CHROME_MCP_NAME,
  CLEAN_BROWSER_MCP_NAME,
  FTP_MCP_NAME,
  GPT_MCP_NAME,
  'claude-in-chrome',
]);

/**
 * Os `-c mcp_servers.<nome>.*` dos MCPs extras da conversa. Mesma regra de aprovação dos internos (`approve`, sem ela o `codex exec` recusa a
 * chamada), e `enabled_tools` só quando a ficha limita as ferramentas (`readonly`/`ask` com teste). Nome fora do padrão ou reservado é pulado
 * aqui também, por segurança: quem monta a lista já recusou, mas a linha de comando não depende disso.
 */
export function codexExtraMcpArgs(list: readonly CodexExtraMcp[] | undefined): string[] {
  return (list ?? [])
    .filter((m) => CODEX_EXTRA_MCP_NAME.test(m.name) && !CODEX_RESERVED_MCP_NAMES.has(m.name))
    .flatMap((m) => {
      const key = `mcp_servers.${m.name}`;
      const transport =
        'url' in m
          ? ['-c', `${key}.url=${tomlString(m.url)}`, ...(m.headersHelper ? ['-c', `${key}.http_headers_helper=${tomlString(m.headersHelper)}`] : [])]
          : ['-c', `${key}.command=${tomlString(m.command)}`, '-c', `${key}.args=[${m.args.map((a) => tomlString(a)).join(',')}]`];
      return [
        ...transport,
        '-c', `${key}.default_tools_approval_mode=${tomlString('approve')}`,
        ...(m.enabledTools ? ['-c', `${key}.enabled_tools=[${m.enabledTools.map((t) => tomlString(t)).join(',')}]`] : []),
      ];
    });
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
  /** Endereço do Claudio’s Club para esta conversa (http://127.0.0.2:<porta>): vai em `MYCO_URL` no ambiente da execução. */
  mycoUrl: string;
  /** Onde o thread_id é gravado (e lido ao reabrir). */
  threadFile: string;
  /** Chamado quando o Codex dá o thread_id desta conversa (o registro de conversas do Club anota; ver sessionsRegistry.ts). */
  onThread?: (threadId: string) => void;
  /** "Permitir acesso à internet", lida a cada execução (ver `CodexProcess`). Ausente = desligada. */
  internetAccess?: () => Promise<boolean>;
  /** MCP de SSH da ficha (conexões SSH), ou null: sem ele. Ver `codexSshMcpArgs`. */
  sshMcp?: CodexMcpServer | null;
  /** MCP do Chrome do usuário (só sem SSH na conversa), ou null: sem ele. Ver `codexChromeMcpArgs`. */
  chromeMcp?: CodexMcpServer | null;
  /** MCP do navegador limpo (sem logins; ver `codexCleanBrowserMcpArgs`), ou null: sem ele. */
  cleanMcp?: CodexMcpServer | null;
  /** MCPs da biblioteca e da ficha (projeto, usuário, local), já montados em `codexMcpServers`. Ver `codexExtraMcpArgs`. */
  extraMcps?: CodexExtraMcp[];
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
  /** `loopback`: a API do Claudio’s Club por curl, só em 127.0.0.2 (só com o `network_proxy` conferido, ver codexEnv.ts). `off`: sem rede nenhuma. */
  network: 'off' | 'loopback';
  /** "Permitir acesso à internet" (busca na web do Codex). Sem ele, desligada: falha fechada. O terminal segue sem rede (`network`). */
  internetAccess?: boolean;
  /** thread_id da conversa: com ele, `exec resume`; sem, uma conversa nova. */
  threadId?: string | null;
  /** Sistema (os testes trocam): no Windows as instruções nunca vão na linha de comando. */
  platform?: NodeJS.Platform;
  /** MCP de SSH da ficha (só conexões SSH; null = sem ele). Ver `codexSshMcpArgs`. */
  sshMcp?: CodexMcpServer | null;
  /** MCP do Chrome do usuário (null = sem ele). Ver `codexChromeMcpArgs`. */
  chromeMcp?: CodexMcpServer | null;
  /** MCP do navegador limpo (null = sem ele). Ver `codexCleanBrowserMcpArgs`. */
  cleanMcp?: CodexMcpServer | null;
  /** MCPs da biblioteca e da ficha (projeto, usuário, local); ausente = nenhum. Ver `codexExtraMcpArgs`. */
  extraMcps?: CodexExtraMcp[];
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
 * No Windows a sandbox padrão do Codex (restrita, sem admin) recusa rodar com negações de segredo. A elevada impõe o bloqueio pelo Windows;
 * ela precisa de uma preparação única com administrador (o app do Codex para Windows já faz). Sem ela o Codex falha com a mensagem dele,
 * e a conversa mostra o erro: falha fechada, nunca roda sem sandbox. Vale para o motor e para o myco-gpt (gptMcp.ts).
 */
export function codexWindowsSandboxArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['-c', `windows.sandbox=${tomlString('elevated')}`] : [];
}

/**
 * Argumentos depois de `codex`. O prompt vai pelo stdin (`-`). Segurança (config do usuário, conectores, busca na web, aprovação, sandbox,
 * segredos e rede) vem toda de `codexSafetyArgs`, igual na primeira execução e no `resume` (que não aceita `-s` nem `-C`: a pasta é a do
 * processo). A rede é a que quem chama manda (`network`): `loopback` só depois de conferir o `network_proxy` (ver codexEnv.ts).
 * Com o MCP de SSH anexado, a busca na web fica DESLIGADA mesmo com "Permitir acesso à internet": por ela o conteúdo dos servidores
 * podia sair para fora (canal de vazamento). A ficha diz isso (ver ficha.ts).
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
      webSearch: o.internetAccess === true && !o.sshMcp,
      writableRoots: o.writableRoots,
      readOnlyPaths: o.readOnlyPaths,
    }),
  );
  args.push(...codexWindowsSandboxArgs(o.platform));
  args.push(...codexSshMcpArgs(o.sshMcp));
  args.push(...codexChromeMcpArgs(o.chromeMcp));
  args.push(...codexCleanBrowserMcpArgs(o.cleanMcp));
  args.push(...codexExtraMcpArgs(o.extraMcps));
  if (o.instructions && instructionsInArgv(o.instructions, o.platform)) args.push('-c', `developer_instructions=${tomlString(o.instructions)}`);
  if (resume) args.push(o.threadId!);
  args.push('-');
  return args;
}
