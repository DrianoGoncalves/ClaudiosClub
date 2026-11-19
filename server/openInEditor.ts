import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { cleanRel, isSecretRel, parseOpenBody, ProjectFileError, resolveProjectFile } from './projectFiles';

// "Corrigir" no alerta de segredo e o arquivo de segredo da aba Arquivos: o servidor local abre o arquivo num editor de TEXTO da máquina do dono, e o
// conteúdo nunca passa pelo Club nem pelo navegador (esta função não lê o arquivo; só confere que ele existe, é regular e fica dentro do projeto).
//
// Não é um lançador: o programa é fixo por sistema (nunca o app associado à extensão, que pode ser um executável ou o navegador) e o único dado de
// fora é o caminho, resolvido pelo mesmo caminho do projeto (`resolveProjectFile`: contenção + realpath, links e junções para fora recusados).
// Só abre arquivo de segredo (a classificação da leitura: `isSecretRel`): o comum abre na aba Arquivos. E o caminho é conferido de novo logo antes
// do `spawn` (`resolveSecretFile` duas vezes), porque um agente pode trocar o arquivo por um link entre a primeira checagem e a abertura.
//   Windows: <SystemRoot>\System32\notepad.exe <caminho absoluto>   (caminho completo: o Windows procura primeiro na pasta atual)
//   macOS:   /usr/bin/open -t <caminho absoluto>                     (-t = o editor de texto padrão)
//   Linux:   só o editor gráfico configurado no ambiente do servidor (VISUAL ou EDITOR); sem ele, recusa com mensagem.
// `spawn` com argumentos separados e `shell: false`; o ambiente do editor sai sem os tokens do Club/CLI e sem chaves.

/** O que a rota devolve: só o caminho (como a tela pediu, normalizado) e qual editor abriu. Nunca o conteúdo. */
export interface OpenEditorResult {
  opened: true;
  path: string;
  editor: 'notepad' | 'textedit' | 'custom';
}

/**
 * Códigos de recusa que a tela entende (`code` no corpo do erro, junto de `error` com a mensagem). `not-secret` (403): o arquivo não é de segredo, então
 * abre na aba Arquivos, não por esta rota. `changed` (409): o caminho passou a apontar para outro arquivo entre a conferência e a abertura; nada foi aberto.
 */
export type OpenEditorCode = 'no-display' | 'no-editor' | 'open-failed' | 'not-secret' | 'changed';

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface OpenEditorOptions {
  /** Os testes trocam (para cobrir os três sistemas sem abrir janela). */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnFn;
  /** Quanto esperar por uma saída com erro logo depois de abrir (o `open` do macOS volta na hora quando falha). */
  settleMs?: number;
  /** Prazo para o sistema confirmar que o processo subiu. */
  startMs?: number;
  log?: (line: string) => void;
}

const refuse = (code: OpenEditorCode, message: string, status = 409) => new ProjectFileError(status, message, { code });

/** Editores de terminal: sem terminal eles não abrem nada, então não valem como "editor configurado". */
const TERMINAL_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'pico', 'ed', 'ex', 'joe', 'micro', 'hx', 'helix', 'kak', 'jed', 'mcedit', 'less', 'more']);

/**
 * Há uma sessão gráfica onde o editor aparece? Linux: DISPLAY ou WAYLAND_DISPLAY. Windows: `SESSIONNAME` (vazio num serviço, que roda na sessão 0,
 * onde o Bloco de Notas subiria invisível). `MYCO_HEADLESS=1` força "não" em qualquer sistema (servidor sem tela).
 */
export function hasGraphicalSession(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (/^(?:1|true|yes)$/i.test(env.MYCO_HEADLESS ?? '')) return false;
  if (platform === 'linux') return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (platform === 'win32') return !!env.SESSIONNAME;
  return true;
}

const SENSITIVE_PREFIX = /^(?:MYCO_|CLAUDE|ANTHROPIC|CODEX|OPENAI|GITHUB_|GH_|NPM_|AWS_|AZURE_|GOOGLE_|GCP_|SSH_)/i;
const SENSITIVE_WORD = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|KEY|APIKEY|PAT)(?:_|$)/i;

/** O ambiente do editor: o do servidor sem os tokens do Club/CLI (MYCO_*, CLAUDE*, ANTHROPIC*, CODEX*…) e sem nada com cara de chave ou senha. */
export function editorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SENSITIVE_PREFIX.test(k) && !SENSITIVE_WORD.test(k)));
}

interface Editor {
  cmd: string;
  args: string[];
  label: OpenEditorResult['editor'];
}

/** O editor deste sistema para o arquivo (`abs`, absoluto e real); recusa quando não há um que valha. */
export function editorFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, abs: string): Editor {
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
    return { cmd: path.win32.join(root, 'System32', 'notepad.exe'), args: [abs], label: 'notepad' };
  }
  if (platform === 'darwin') return { cmd: '/usr/bin/open', args: ['-t', abs], label: 'textedit' };
  const [cmd, ...args] = (env.VISUAL || env.EDITOR || '').trim().split(/\s+/).filter(Boolean);
  if (!cmd) throw refuse('no-editor', 'nenhum editor configurado neste computador: defina VISUAL ou EDITOR com um editor gráfico (ex.: gedit) e reinicie o Claudio’s Club');
  const name = path.posix.basename(cmd.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (TERMINAL_EDITORS.has(name)) throw refuse('no-editor', `"${name}" é um editor de terminal e não abre sem terminal: defina VISUAL ou EDITOR com um editor gráfico (ex.: gedit)`);
  return { cmd, args: [...args, abs], label: 'custom' };
}

/**
 * Sobe o editor sem esperar ele fechar. Vale como aberto quando o sistema confirma o processo (`spawn`) e ele não sai com erro logo em seguida; programa que
 * não existe (ENOENT) ou que sai com código diferente de 0 dentro de `settleMs` é `open-failed`.
 */
function launch(spawnImpl: SpawnFn, editor: Editor, opts: SpawnOptions, settleMs: number, startMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(editor.cmd, editor.args, opts);
    } catch (err) {
      return reject(err);
    }
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    timer = setTimeout(() => finish(new Error('o sistema não confirmou que o editor abriu')), startMs);
    child.once('error', (err) => finish(err));
    child.once('exit', (code) => finish(code ? new Error(`o editor saiu na hora com o código ${code}`) : undefined));
    child.once('spawn', () => {
      child.unref();
      setTimeout(finish, settleMs);
    });
  });
}

/**
 * O que a rota `POST /api/projects/:id/files/open-editor` faz: só o navegador pareado (`fromBrowser`; ferramenta, funcionário e sandbox: 403), corpo
 * `{ path }` (tipo errado: 400) e o projeto conhecido (`projectDir` null devolve null, o 404 da rota).
 */
export async function openEditorRoute(req: { fromBrowser: boolean; body: unknown; projectDir: string | null }, o: OpenEditorOptions = {}): Promise<OpenEditorResult | null> {
  if (!req.fromBrowser) throw new ProjectFileError(403, 'arquivos só são abertos no editor pelo Claudio’s Club');
  const input = parseOpenBody(req.body);
  return req.projectDir ? openInEditor(req.projectDir, input.path, o) : null;
}

/**
 * O caminho real de um arquivo regular de SEGREDO do projeto (sem ler o conteúdo). A classificação é a da leitura de arquivos (`isSecretRel`, a mesma de
 * `isBlockedRel`) e vale para o caminho REAL: é ele que abre, então um link para dentro do projeto que aponta para um `.env` conta como segredo, e um
 * `a.env` que aponta para um arquivo comum, não. `realRel` vem de `toRel` (já limpo), por isso `isSecretRel` direto: `isBlockedRel` devolve true para
 * caminho inválido, o que aqui abriria em vez de recusar.
 */
async function resolveSecretFile(root: string, rel: string): Promise<string> {
  const { abs, realRel } = await resolveProjectFile(root, rel);
  if (!isSecretRel(realRel)) throw refuse('not-secret', 'esta rota só abre arquivo de segredo no editor: o arquivo comum abre na aba Arquivos', 403);
  return abs;
}

/**
 * Abre um arquivo de segredo do projeto no editor de texto da máquina e devolve só o caminho. Recusas (todas sem ler o arquivo): caminho inválido ou fora do
 * projeto, link/junção que sai dele (403); arquivo que não é de segredo (403, `code` 'not-secret'); inexistente ou pasta (404); sem sessão gráfica ou sem
 * editor (409, `code` 'no-display' / 'no-editor'); o caminho mudou para outro arquivo entre a conferência e a abertura (409, 'changed'); o sistema não
 * conseguiu abrir (502, 'open-failed').
 *
 * O editor recebe o caminho real conferido pela SEGUNDA vez, imediatamente antes do `spawn` (sem nenhum `await` entre a conferência e a subida): fecha a janela
 * em que um agente trocaria o arquivo por link ou junção para fora do projeto depois da primeira checagem. Sobra só o intervalo entre o `spawn` e o editor
 * abrir o arquivo, que não dá para fechar (o Bloco de Notas, o `open` e o editor do Linux recebem um caminho, não um descritor já aberto).
 */
export async function openInEditor(root: string, rawPath: string, o: OpenEditorOptions = {}): Promise<OpenEditorResult> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const rel = cleanRel(rawPath);
  const first = await resolveSecretFile(root, rel);
  if (!hasGraphicalSession(platform, env)) throw refuse('no-display', 'este computador não tem sessão gráfica para abrir o editor (o Claudio’s Club roda sem tela): abra o arquivo no seu editor');
  const abs = await resolveSecretFile(root, rel);
  if (abs !== first) throw refuse('changed', 'o arquivo mudou enquanto o editor era aberto (o caminho passou a apontar para outro lugar): nada foi aberto');
  const editor = editorFor(platform, env, abs);
  try {
    await launch(o.spawnImpl ?? spawn, editor, { cwd: path.dirname(abs), env: editorEnv(env), shell: false, detached: true, stdio: 'ignore', windowsHide: false }, o.settleMs ?? 400, o.startMs ?? 5_000);
  } catch (err) {
    // A mensagem do sistema pode trazer o caminho do usuário: vai só ao log do servidor, e a tela recebe o texto fixo.
    o.log?.(`[arquivos] o editor não abriu ${JSON.stringify(rel)}: ${err instanceof Error ? err.message.slice(0, 200) : 'erro'}`);
    throw refuse('open-failed', 'não deu para abrir o editor neste computador: abra o arquivo no seu editor', 502);
  }
  // Só o caminho no log, nunca o conteúdo.
  o.log?.(`[arquivos] aberto no editor (${editor.label}): ${JSON.stringify(rel)}`);
  return { opened: true, path: rel, editor: editor.label };
}
