import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatItem } from '../../shared/model';
import { findSecrets } from './secrets';

// Ação cortada pelo reinício: a ferramenta que estava rodando quando o processo da conversa caiu (sem resultado no fim da
// conversa). Se ela mexe fora do projeto (servidor, push, deploy, site, API), ninguém sabe se chegou a acontecer: a conversa
// não volta sozinha (o funcionário poderia repetir), vai para "precisa de mim" (ver TurnCapHit `restart`). O que fica no
// projeto (editar arquivo, rodar teste) se confere pelo git: retoma como sempre.
// Na dúvida, conta como efeito fora: o custo do engano é um clique seu para seguir.
// Comando: olha o programa e os argumentos de cada trecho (`&&`, `;`, `|`), não o texto inteiro: `grep deploy`, `cat
// docs/release.md` e `git commit -m "fix deploy"` não contam. O `description` da entrada não entra.
// Chamada Agent/Task: o tipo do subagent não diz o que ele fez. `externalCutWithAgents` lê o transcript dele (ver `agentStaysLocal`).

type Tok = { t: string; q: boolean };
type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** Programas que saem do projeto por si (rede, servidor, banco, nuvem, publicação). */
const ALWAYS_TOOLS = new Set([
  'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'kubectl', 'helm', 'vercel', 'netlify', 'wrangler', 'firebase', 'aws', 'gcloud', 'flyctl',
  'psql', 'mysql', 'mongosh', 'redis-cli', 'sqlcmd',
]);
/** Programa ou script com nome de publicação (`deploy`, `./deploy.sh`, `publish`, `release`). */
const DEPLOY_NAME = /^(?:deploy|publish|release)$/;
/** Prefixos que só repassam o comando (`sudo ssh…`, `npx vercel…`): o programa de verdade vem depois. */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'time', 'exec', 'command', 'npx', 'bunx', 'pnpx', 'xargs', 'nice', 'timeout', 'stdbuf', 'call']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh']);
const SHELL_FLAG = /^(?:-c|-lc|-ec|-command|\/c)$/i;
const ENV_ASSIGN = /^[A-Za-z_]\w*=/;
// Palavra (sem aspas ou entre aspas) ou separador de trecho. Aspas fecham antes de qualquer separador, então `"a;b"` é um só.
const TOKEN = /"([^"]*)"|'([^']*)'|(\$\(|&&|\|\||[;|&()`\n])|([^\s"';|&()`]+)/g;

const base = (s: string) => s.replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|ps1|sh)$/i, '').toLowerCase();

function segmentsOf(cmd: string): Tok[][] {
  const out: Tok[][] = [[]];
  for (const m of cmd.matchAll(TOKEN)) {
    const seg = out[out.length - 1]!;
    if (m[3] !== undefined) out.push([]);
    else if (m[1] !== undefined) seg.push({ t: m[1], q: true });
    else if (m[2] !== undefined) seg.push({ t: m[2], q: true });
    else seg.push({ t: m[4]!, q: false });
  }
  return out;
}

/** Host de uma URL (com esquema); null se o texto não é URL. */
function hostOf(text: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]*\]|[^/?#:\s]+)/i.exec(text);
  return m ? m[1]!.replace(/^\[|\]$/g, '').toLowerCase() : null;
}

const isLocal = (h: string) => h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);

const WRITE_VERB = /^(?:post|put|delete|patch)$/i;
const METHOD_NEXT = /^(?:-X|--request|--method|-Method)$/i;
const METHOD_INLINE = /^(?:-X|--request=|--method=)(?:post|put|delete|patch)$/i;
const WRITE_FLAG = /^(?:-d|-F|-T|-Body|-InFile|--json|--form|--upload-file|--data(?:-\w+)?(?:=.*)?|--post-(?:data|file)|--body-(?:data|file))$/i;

/** curl/wget/Invoke-WebRequest com envio (método de escrita ou corpo) para um host que não é este computador. */
function httpWrites(args: Tok[]): boolean {
  const writes = args.some((a, i) => (METHOD_NEXT.test(a.t) ? WRITE_VERB.test(args[i + 1]?.t ?? '') : METHOD_INLINE.test(a.t) || WRITE_FLAG.test(a.t)));
  if (!writes) return false;
  // Sem URL com esquema, o host não se sabe: conta como externo.
  const hosts = args.map((a) => hostOf(a.t)).filter((h): h is string => h !== null);
  return hosts.length === 0 || hosts.some((h) => !isLocal(h));
}

const NET_CODE = /\b(?:fetch|requests|urllib|httpx|axios|got|undici|XMLHttpRequest|http|https|socket|net)\b|https?:\/\//i;
const CODE_FLAG = /^(?:-e|-c|-p|--eval|--print)$/;

/** node -e / python -c com rede: externo se o código fala com um host que não é este computador (ou não dá para ver o host). */
function codeReaches(args: Tok[]): boolean {
  return args.some((a, i) => {
    if (!CODE_FLAG.test(a.t)) return false;
    const code = args[i + 1]?.t ?? '';
    if (!NET_CODE.test(code)) return false;
    const hosts = [...code.matchAll(/https?:\/\/([^\s'"`/?#)]+)/gi)].map((m) => m[1]!.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase());
    return hosts.length === 0 || hosts.some((h) => !isLocal(h));
  });
}

/** O subcomando do git, depois das opções globais (`git -C pasta push`). */
function gitSub(args: Tok[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.t;
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') i++;
    else if (!t.startsWith('-')) return t;
  }
  return undefined;
}

const GH_READ = new Set(['list', 'view', 'status', 'diff', 'checks']);
/** `gh <grupo> <ação>`: só listar/ver/checar é leitura; o resto (create, merge, api…) conta como externo. */
const ghWrites = (plain: string[]) => plain[1] !== undefined && !GH_READ.has(plain[1]);

const DOCKER_WRITE = new Set(['push', 'login', 'run', 'stop', 'rm']);
const COMPOSE_WRITE = new Set(['up', 'down', 'push', 'stop', 'rm']);

function dockerWrites(name: string, words: string[]): boolean {
  if (name === 'docker-compose') return words.some((w) => COMPOSE_WRITE.has(w));
  return words.some((w) => DOCKER_WRITE.has(w)) || (words.includes('compose') && words.some((w) => COMPOSE_WRITE.has(w)));
}

/** npm/pnpm/yarn/bun: publicar, fazer deploy, ou rodar um script com nome de deploy/publicação. */
function packageWrites(words: string[]): boolean {
  if (words.includes('publish') || words.includes('deploy')) return true;
  return (words.includes('run') || words.includes('run-script')) && words.some((w) => /deploy|publish|release/i.test(w));
}

function programExternal(name: string, args: Tok[], depth: number): boolean {
  const words = args.map((a) => a.t);
  const plain = words.filter((w) => !w.startsWith('-'));
  if (ALWAYS_TOOLS.has(name) || DEPLOY_NAME.test(name)) return true;
  switch (name) {
    case 'git':
      return gitSub(args) === 'push';
    case 'gh':
      return ghWrites(plain);
    case 'docker':
    case 'docker-compose':
      return dockerWrites(name, words);
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return packageWrites(words);
    case 'terraform':
      return words.some((w) => w === 'apply' || w === 'destroy' || w === 'import');
    case 'pulumi':
      return plain[0] === 'up';
    case 'fly':
      return plain[0] === 'deploy';
    case 'curl':
    case 'wget':
    case 'invoke-webrequest':
    case 'invoke-restmethod':
    case 'iwr':
    case 'irm':
      return httpWrites(args);
    case 'node':
    case 'nodejs':
    case 'python':
    case 'python3':
    case 'py':
    case 'ruby':
    case 'perl':
      return codeReaches(args);
    default: {
      // `bash -c "git push"`: o script que o shell roda também conta.
      if (!SHELLS.has(name)) return false;
      const k = args.findIndex((a) => SHELL_FLAG.test(a.t));
      return k >= 0 && externalCommand(words.slice(k + 1).join(' '), depth + 1);
    }
  }
}

function segmentExternal(seg: Tok[], depth: number): boolean {
  let i = 0;
  let wrapped = false;
  while (i < seg.length && !seg[i]!.q) {
    const t = seg[i]!.t;
    if (ENV_ASSIGN.test(t)) i++;
    else if (WRAPPERS.has(base(t))) {
      wrapped = true;
      i++;
    } else if (wrapped && /^[-\d]/.test(t)) i++;
    else break;
  }
  const prog = seg[i];
  if (!prog) return false;
  // Depois de um prefixo, as opções dele podem vir com um valor (`sudo -u root ssh…`): ali, procura os programas de rede.
  if (wrapped && seg.slice(i).some((x) => !x.q && ALWAYS_TOOLS.has(base(x.t)))) return true;
  return programExternal(base(prog.t), seg.slice(i + 1), depth);
}

/** O comando (texto de uma ferramenta de terminal) mexe fora do projeto? */
export function externalCommand(cmd: string, depth = 0): boolean {
  if (depth > 3) return true;
  return segmentsOf(cmd).some((seg) => segmentExternal(seg, depth));
}

/**
 * Um campo de texto da entrada da ferramenta. A entrada chega cortada (`clip`), então pode não ser JSON: aí tira o campo
 * por regex; se não achar, devolve o texto cru (`raw`, só para a detecção) ou null.
 */
function fieldOf(input: string, key: string, raw = false): string | null {
  try {
    const v = (JSON.parse(input) as Record<string, unknown> | null)?.[key];
    return typeof v === 'string' ? v : null;
  } catch {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(input);
    return m ? m[1]! : raw ? input : null;
  }
}

/** Subagentes que só leem (não mudam nada fora do projeto). O resto, incluindo o padrão (sem tipo), conta como externo. */
const READ_ONLY_AGENTS = new Set(['explore', 'plan', 'pesquisador', 'revisor', 'statusline-setup']);

const isAgentCall = (name: string) => name === 'Agent' || name === 'Task';

/**
 * Ferramenta de MCP que só lê (pelo nome, sem o prefixo do serviço: `ssh_ler` → `ler`, `browser_snapshot` → `snapshot`).
 * O resto conta como efeito fora: clicar, digitar, enviar, executar, subir arquivo, consultar SQL (`query` sai daqui: pode apagar).
 * A palavra tem que acabar ali ou seguir de `_` (`readme_update` não é leitura).
 */
const READ_ONLY_MCP =
  /^(?:get|list|listar|read|ler|search|find|describe|view|show|fetch|count|status|snapshot|take_screenshot|screenshot|console|network|processos|docker_(?:ps|logs|stats)|journal|servico|download|tabs_context|page_text|wait|consult|ask|perguntar)(?:_|$)/i;

/** A ferramenta, com esta entrada, mexe fora do projeto? */
export function hasExternalEffect(name: string, input: string): boolean {
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = fieldOf(input, 'command', true);
    return cmd !== null && externalCommand(cmd);
  }
  if (isAgentCall(name)) return !READ_ONLY_AGENTS.has((fieldOf(input, 'subagent_type') ?? '').toLowerCase());
  if (name.startsWith('mcp__')) {
    const tool = name.slice(name.lastIndexOf('__') + 2).replace(/^(?:ssh|ftp|gpt|browser)_/i, '');
    return !READ_ONLY_MCP.test(tool);
  }
  return false;
}

const MAX_ACTION = 80;

/** Troca cada segredo do texto por `[segredo]` (findSecrets acha todos, com posição). */
function maskSecrets(text: string): string {
  let out = '';
  let at = 0;
  for (const f of findSecrets(text)) {
    if (f.index < at) continue; // sobreposto a um já trocado
    out += `${text.slice(at, f.index)}[segredo]`;
    at = f.index + f.length;
  }
  return out + text.slice(at);
}

/** O resumo da ação que vai para a caixa, o histórico e o resume.json: sem segredo, em uma linha, curto. */
function actionOf(it: ToolItem): string {
  // Comando: o texto inteiro é mascarado antes de cortar (corte no meio de um segredo deixaria a parte que sobra).
  const cmd = it.name === 'Bash' || it.name === 'PowerShell' ? fieldOf(it.input, 'command') : null;
  const text = maskSecrets(cmd || it.summary || it.name).replace(/\s+/g, ' ').trim();
  return text.length > MAX_ACTION ? `${text.slice(0, MAX_ACTION - 1)}…` : text;
}

/**
 * As ferramentas sem resultado no fim da conversa (o turno foi cortado nelas), da mais nova para a mais antiga. Só olha depois da
 * última mensagem do usuário: o que veio antes já terminou.
 * `awaitingAnswer`: há pedido de permissão sem resposta. Se a única ferramenta sem resultado é a que espera a permissão, ela
 * não rodou (não conta como corte). Com mais de uma sem resultado, não dá para saber qual é: conta como antes.
 */
function openTools(items: readonly ChatItem[], awaitingAnswer: boolean): ToolItem[] {
  const open: ToolItem[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'user') break;
    if (it.kind === 'tool' && it.result === null) open.push(it);
  }
  return awaitingAnswer && open.length === 1 ? [] : open;
}

/** A ação com efeito fora do projeto que ficou sem resultado no fim da conversa (ver `openTools`), em resumo curto; senão, null. */
export function externalCut(items: readonly ChatItem[], awaitingAnswer = false): string | null {
  const hit = openTools(items, awaitingAnswer).find((it) => hasExternalEffect(it.name, it.input));
  return hit ? actionOf(hit) : null;
}

/** Pasta dos transcripts dos subagents de uma conversa do Claude: `<sessão>/subagents`, ao lado do `<sessão>.jsonl`. */
export const subagentsDirOf = (transcript: string): string => path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');

const AGENT_META = /^(agent-[\w-]+)\.meta\.json$/;
/** Quantos níveis de subagent dentro de subagent a leitura acompanha; além disso, conta como externo. */
const MAX_AGENT_DEPTH = 3;

/** `toolUseId` da chamada Agent/Task do pai (no `.meta.json`) → transcript do subagent, de toda a pasta. */
async function subagentFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const m = AGENT_META.exec(name);
      if (!m) return;
      try {
        const id = (JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as { toolUseId?: unknown } | null)?.toolUseId;
        if (typeof id === 'string') out.set(id, path.join(dir, `${m[1]}.jsonl`));
      } catch {
        // `.meta.json` ilegível: a chamada que dependia dele não acha o transcript e segue como externa
      }
    }),
  );
  return out;
}

type AgentLine = { type?: unknown; message?: { content?: unknown } } | null;

/**
 * O subagent chamado por `toolUseId` só mexeu no projeto? Vale toda `tool_use` do transcript dele, terminada ou não (a retomada pode
 * repetir a delegação inteira), e as dos subagents que ele chamou. Sem transcript, transcript ilegível ou fundo demais: false.
 */
async function agentStaysLocal(files: Map<string, string>, toolUseId: string, depth = 0, seen = new Set<string>()): Promise<boolean> {
  const file = files.get(toolUseId);
  if (!file || depth >= MAX_AGENT_DEPTH || seen.has(file)) return false;
  seen.add(file);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split('\n')) {
    // Só as linhas que podem ter chamada de ferramenta são lidas; uma delas cortada no meio (JSON inválido) deixa a dúvida.
    if (!line.includes('"tool_use"')) continue;
    let ev: AgentLine;
    try {
      ev = JSON.parse(line) as AgentLine;
    } catch {
      return false;
    }
    if (ev?.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
    for (const b of ev.message.content as Array<Record<string, unknown> | null>) {
      if (b?.type !== 'tool_use') continue;
      if (typeof b.name !== 'string') return false;
      if (!hasExternalEffect(b.name, JSON.stringify(b.input ?? {}))) continue;
      if (!isAgentCall(b.name) || typeof b.id !== 'string' || !(await agentStaysLocal(files, b.id, depth + 1, seen))) return false;
    }
  }
  return true;
}

/**
 * Como `externalCut`, mas uma chamada Agent/Task que `hasExternalEffect` marca como externa (tipo que não é só leitura) é conferida no
 * transcript do subagent (`subagentsDir`, ver `subagentsDirOf`): se nenhuma ferramenta dele mexe fora do projeto, o corte é local.
 * Sem a pasta (null), é `externalCut`. Codex: os subagents ainda não aparecem nos eventos, então não há transcript e segue conservador.
 */
export async function externalCutWithAgents(items: readonly ChatItem[], awaitingAnswer: boolean, subagentsDir: string | null): Promise<string | null> {
  let files: Map<string, string> | null = null;
  for (const it of openTools(items, awaitingAnswer)) {
    if (!hasExternalEffect(it.name, it.input)) continue;
    if (subagentsDir && isAgentCall(it.name) && it.id.startsWith('t:')) {
      if (!files) files = await subagentFiles(subagentsDir);
      if (await agentStaysLocal(files, it.id.slice(2))) continue;
    }
    return actionOf(it);
  }
  return null;
}
