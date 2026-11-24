import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskCode, TaskCodeFile, TestRun } from '../shared/model';
import { cleanEnv } from './auth';
import { killTree } from './chat/registry';
import { HEAVY_HELD_ENV, withHeavyLock, type HeavyWaitFn } from './heavyQueue';
import { worktreeFor } from './staff/worktree';
import { TestScan } from './testFailures';

// O código de uma tarefa: onde está (worktree do funcionário ou o próprio projeto), o que mudou,
// os testes e a mescla. A pasta `.myco/` (fichas, imagens) fica fora de tudo: não é código.
// Mesclar acontece no checkout principal, em três passos: `merge --no-commit`, testes no resultado
// (é ali que estão as dependências instaladas) e só então o commit; teste vermelho desfaz a mescla.

export class CodeError extends Error {
  constructor(
    message: string,
    /**
     * `no-tests`: não há testes; dá para mesclar confirmando. `tests-timeout`: os testes da mescla passaram do tempo-limite (não é falha de teste; tentar de novo). `no-delivery`: a entrega não tem um
     * commit desta worktree até onde mesclar (recusa, nunca o branch inteiro). `main-dirty`: o checkout principal tem arquivo sem commit. `conflict`: conflito (os arquivos em `files`; a mescla foi desfeita).
     * `tests-failed`: os testes ficaram vermelhos com a mescla (a saída em `tests`; a mescla foi desfeita).
     */
    readonly code: 'no-tests' | 'tests-timeout' | 'no-delivery' | 'main-dirty' | 'conflict' | 'tests-failed' | null = null,
    readonly tests: TestRun | null = null,
    readonly files: string[] = [],
  ) {
    super(message);
  }
}

const NOT_MYCO = [':(exclude).myco', ':(exclude).myco/**'];
const MAX_DIFF = 200_000;

export interface CodePlace {
  where: 'worktree' | 'project';
  path: string;
  branch: string | null;
}

/** Onde está o código da tarefa; null quando o projeto não é um repositório git. */
export async function locateCode(projectPath: string, staffId: string | null, ownWorktree: boolean): Promise<CodePlace | null> {
  if (staffId && ownWorktree) {
    const wt = worktreeFor(projectPath, staffId);
    if (await fs.stat(path.join(wt.path, '.git')).then((s) => s.isFile(), () => false)) return { where: 'worktree', path: wt.path, branch: wt.branch };
  }
  if (!(await isRepo(projectPath))) return null;
  return { where: 'project', path: projectPath, branch: (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null };
}

/**
 * Fecha a entrega numa worktree: commita o que estiver pendente (com o título da tarefa) e devolve o
 * commit. Fora de worktree, null: no projeto principal o Claudio’s Club não commita por você.
 */
export async function checkpoint(place: CodePlace, title: string): Promise<string | null> {
  if (place.where !== 'worktree') return null;
  if (await dirtyCount(place.path)) {
    await git(place.path, ['add', '-A', '--', '.', ...NOT_MYCO]);
    await git(place.path, ['commit', '-m', `${title} (Claudio’s Club)`]).catch(() => {});
  }
  return (await git(place.path, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
}

/** `upTo` só vale se for um commit desta worktree (ancestral do HEAD dela). */
async function validEnd(place: CodePlace, upTo: string | null | undefined): Promise<string | null> {
  if (!upTo || place.where !== 'worktree') return null;
  return (await git(place.path, ['merge-base', '--is-ancestor', upTo, 'HEAD']).then(() => true, () => false)) ? upTo : null;
}

/**
 * O que mudou: na worktree, tudo desde onde ela saiu da base (commits + o que ainda não foi
 * commitado). Com `upTo` (o commit da entrega), só até ele: o resto é da tarefa seguinte.
 */
export async function readCode(projectPath: string, place: CodePlace, upTo?: string | null, only?: string[]): Promise<TaskCode> {
  const base = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null;
  const test = await detectTest(projectPath);
  const mainDirty = await dirtyCount(projectPath);
  if (place.where === 'project') {
    // `only`: só estes arquivos (os que um funcionário editou numa conversa).
    const keep = only ? new Set(only) : null;
    const files = (await changedFiles(projectPath, 'HEAD')).filter((f) => !keep || keep.has(f.path));
    const diff = keep && !keep.size ? '' : await git(projectPath, ['diff', 'HEAD', '--', ...(keep ? [...keep] : ['.', ...NOT_MYCO])]).catch(() => '');
    return {
      where: 'project',
      path: place.path,
      branch: place.branch,
      base,
      files,
      commits: [],
      uncommitted: files.length,
      ...clip(diff),
      test,
      canMerge: false,
      whyNot: 'as mudanças já estão no próprio projeto (o card foi feito fora de worktree): não há o que mesclar',
    };
  }
  const end = await validEnd(place, upTo);
  const mb = base ? (await git(place.path, ['merge-base', base, 'HEAD']).catch(() => '')).trim() : '';
  const from = mb || 'HEAD';
  const files = await changedFiles(place.path, from, end);
  const uncommitted = end ? 0 : (await changedFiles(place.path, 'HEAD')).length;
  const log = mb ? await git(place.path, ['log', '--format=%h%x09%s', `${mb}..${end ?? 'HEAD'}`]).catch(() => '') : '';
  const commits = log
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split('\t');
      return { sha: sha!, subject: rest.join('\t') };
    });
  const diff = await git(place.path, ['diff', from, ...(end ? [end] : []), '--', '.', ...NOT_MYCO]).catch(() => '');
  const whyNot = !base
    ? 'o projeto principal está com o HEAD destacado'
    : mainDirty
      ? `o projeto principal tem ${mainDirty} ${mainDirty === 1 ? 'arquivo alterado' : 'arquivos alterados'} sem commit: commite ou guarde antes de mesclar`
      : !files.length && !commits.length
        ? 'não há mudanças na worktree'
        : null;
  return { where: 'worktree', path: place.path, branch: place.branch, base, files, commits, uncommitted, ...clip(diff), test, canMerge: !whyNot, whyNot };
}

/**
 * Mescla a worktree no branch atual do projeto, até `upTo` (o commit da entrega, que tem de ser desta worktree: ancestral do HEAD dela). Sem ele, ou com um que não vale, RECUSA
 * (`CodeError` com `code: 'no-delivery'`): mesclar sem saber até onde levaria o branch inteiro, com o que a tarefa seguinte já começou. Só `wholeBranch` (a mescla do dono da pasta de
 * trabalho inteira, sem tarefa: ver a rota de chat) mescla tudo, e aí o que não foi commitado na worktree é commitado antes (com a mensagem dada). Sem testes, só com `skipTests`
 * (confirmado no Claudio’s Club). `testTimeoutMs`: o tempo-limite dos testes da mescla (padrão `TEST_TIMEOUT_MS`; os testes trocam). Testes cortados no tempo-limite não são falha:
 * `CodeError` com `code: 'tests-timeout'`.
 */
export async function mergeCode(
  projectPath: string,
  place: CodePlace,
  title: string,
  opts: { skipTests?: boolean; upTo?: string | null; wholeBranch?: boolean; testTimeoutMs?: number } = {},
): Promise<{ sha: string; base: string; branch: string; tests: TestRun | null }> {
  if (place.where !== 'worktree' || !place.branch) throw new CodeError('só dá para mesclar o trabalho de uma worktree');
  const end = await validEnd(place, opts.upTo);
  if (!end && !opts.wholeBranch)
    throw new CodeError(
      opts.upTo ? 'o commit da entrega não é desta worktree (não é ancestral do HEAD dela): a mescla foi recusada, não vou levar o branch inteiro' : 'a entrega não tem commit gravado: a mescla foi recusada, não vou levar o branch inteiro',
      'no-delivery',
    );
  const code = await readCode(projectPath, place, end);
  if (!code.canMerge || !code.base) throw new CodeError(code.whyNot ?? 'não dá para mesclar agora', code.base && (await dirtyCount(projectPath)) ? 'main-dirty' : null);
  // Os testes ligados ao que a mescla traz (ver `scopedTestCommand`); a suíte inteira fica no CI do PR.
  const test = code.test ? await scopedTestCommand(projectPath, code.files.map((f) => f.path)) : null;
  if (!test && !opts.skipTests) throw new CodeError('não achei testes neste projeto (npm test, composer test ou phpunit)', 'no-tests');

  if (code.uncommitted && !end) {
    await git(place.path, ['add', '-A', '--', '.', ...NOT_MYCO]);
    await git(place.path, ['commit', '-m', `${title} (Claudio’s Club)`]).catch((err: Error) => {
      throw new CodeError(`não deu para commitar na worktree: ${firstLine(err.message)}`);
    });
  }
  const message = `Merge ${place.branch}: ${title}`;
  try {
    await git(projectPath, ['merge', '--no-ff', '--no-commit', end ?? place.branch]);
  } catch (err) {
    const conflicts = (await git(projectPath, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
    await git(projectPath, ['merge', '--abort']).catch(() => {});
    const files = conflicts.split(/\r?\n/).filter(Boolean);
    throw new CodeError(files.length ? `conflito ao mesclar em: ${files.join(', ')}` : `não deu para mesclar: ${firstLine((err as Error).message)}`, files.length ? 'conflict' : null, null, files);
  }
  let tests: TestRun | null = null;
  if (test) {
    // Na fila pesada como a suíte, mesmo escopado: um arquivo muito importado faz o `related` rodar quase tudo.
    tests = await runTests(projectPath, test, opts.testTimeoutMs, 'npm test');
    if (!tests.ok) {
      await git(projectPath, ['merge', '--abort']).catch(() => {});
      if (tests.timedOut) throw new CodeError(`os testes passaram do tempo-limite de ${formatLimit(tests.limitMs ?? TEST_TIMEOUT_MS)} com a mescla: nada foi mesclado (não é falha de teste: confira se a máquina está cheia e tente de novo)`, 'tests-timeout', tests);
      throw new CodeError('os testes falharam com a mescla: nada foi mesclado', 'tests-failed', tests);
    }
  }
  // Mescla sem mudança nenhuma (a base já tinha tudo): não há o que commitar.
  await git(projectPath, ['commit', '--no-edit', '-m', message]).catch(async (err: Error) => {
    if (!/nothing to commit|nada a submeter/i.test(err.message)) {
      await git(projectPath, ['merge', '--abort']).catch(() => {});
      throw new CodeError(`não deu para concluir a mescla: ${firstLine(err.message)}`);
    }
  });
  const sha = (await git(projectPath, ['rev-parse', '--short', 'HEAD'])).trim();
  return { sha, base: code.base, branch: place.branch, tests };
}

/**
 * O commit `end` já está no HEAD do checkout principal? Devolve o commit curto da mescla que o trouxe (ou o dele mesmo, se entrou por fast-forward), ou null se não está. É o que torna a
 * mescla automática idempotente: o processo que caiu depois de commitar a mescla e antes de gravar o card não mescla de novo.
 */
export async function integratedSha(projectPath: string, end: string): Promise<string | null> {
  if (!(await git(projectPath, ['merge-base', '--is-ancestor', end, 'HEAD']).then(() => true, () => false))) return null;
  const merges = (await git(projectPath, ['log', '--merges', '--first-parent', '--ancestry-path', '--format=%h', `${end}..HEAD`]).catch(() => '')).split(/\r?\n/).filter(Boolean);
  return merges.at(-1) ?? (await git(projectPath, ['rev-parse', '--short', end])).trim();
}

/** Os commits que mesclar até `end` traz ao principal (do mais novo ao mais antigo, `end` entre eles): o que está em `end` e não no HEAD do principal. */
export async function commitsToMerge(projectPath: string, end: string): Promise<string[]> {
  return (await git(projectPath, ['rev-list', `HEAD..${end}`])).split(/\r?\n/).filter(Boolean);
}

/**
 * Uma mescla que o processo deixou pela metade no checkout principal (`merge --no-commit` com os testes rodando quando o Club caiu): só se é a deste `end` (MERGE_HEAD igual) ela é desfeita.
 * Mescla em andamento de outra coisa (do dono, na mão) não é tocada. Devolve se desfez.
 */
export async function abortStaleMerge(projectPath: string, end: string): Promise<boolean> {
  const head = (await git(projectPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).trim();
  if (!head || head !== (await git(projectPath, ['rev-parse', '--verify', end]).catch(() => '')).trim()) return false;
  await git(projectPath, ['merge', '--abort']);
  return true;
}

/** Nome de arquivo que vai na linha de comando sem nada para o shell interpretar (o `runTests` roda com shell). */
const SAFE_TEST_ARG = /^[\w@./-]+$/;
/** Teto da linha de comando dos testes relacionados (o cmd do Windows aceita ~8 mil caracteres): passou disso, a suíte do projeto. */
export const RELATED_MAX_CHARS = 6_000;

/**
 * O comando de testes da entrega e da mescla. Com vitest e a lista dos arquivos mudados, só os testes ligados a eles (`vitest related`), com no máximo 2 processos de teste:
 * a suíte inteira levava de 10 a 30 min nesta máquina (HDD, 4 núcleos, 8 GB) e roda em 3 min no CI do PR, que segue com ela (assim como o botão "rodar testes" do cartão).
 * Sem vitest, sem lista, com nome estranho ou lista grande demais: o comando de testes do projeto, como antes. `MYCO_FULL_TESTS=1` força a suíte inteira (SPEC "Desempenho" 9).
 */
export async function scopedTestCommand(dir: string, files: readonly string[] | null | undefined): Promise<string | null> {
  const full = await detectTest(dir);
  if (full !== 'npm test' || !files?.length || process.env.MYCO_FULL_TESTS === '1') return full;
  const pkg = await readJson(path.join(dir, 'package.json'));
  const deps = { ...(pkg?.dependencies as Record<string, unknown> | undefined), ...(pkg?.devDependencies as Record<string, unknown> | undefined) };
  if (!deps.vitest) return full;
  const rel = [...new Set(files.map((f) => f.replaceAll('\\', '/')))];
  if (!rel.every((f) => SAFE_TEST_ARG.test(f) && !f.startsWith('-') && !f.split('/').includes('..'))) return full;
  // Mudança na configuração (dependências, tsconfig, config do vitest/vite, .env) mexe em todos os testes: a suíte inteira.
  if (rel.some((f) => TEST_CONFIG_FILE.test(f))) return full;
  // O `related` só acha teste pelo grafo de imports do código: sem nenhum arquivo de código que exista aqui (só docs/CSS, só remoções, caminho de outro pacote do
  // monorepo), ele passaria sem rodar nada. Aí, a suíte inteira.
  const code = rel.filter((f) => CODE_FILE.test(f));
  const present = await Promise.all(code.map((f) => fs.access(path.join(dir, f)).then(() => true, () => false)));
  if (!present.some(Boolean)) return full;
  const command = `npx vitest related ${rel.join(' ')} --run --passWithNoTests --maxWorkers=2`;
  return command.length > RELATED_MAX_CHARS ? full : command;
}

const TEST_CONFIG_FILE = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|(vite|vitest)\.config\.[cm]?[jt]s|\.env[^/]*)$/;
const CODE_FILE = /\.([cm]?[jt]sx?|vue|svelte)$/;

/** O comando de testes do projeto, se houver um claro. */
export async function detectTest(dir: string): Promise<string | null> {
  const pkg = await readJson(path.join(dir, 'package.json'));
  const npmTest = (pkg?.scripts as Record<string, unknown> | undefined)?.test;
  if (typeof npmTest === 'string' && npmTest.trim() && !/no test specified/i.test(npmTest)) return 'npm test';
  const composer = await readJson(path.join(dir, 'composer.json'));
  if ((composer?.scripts as Record<string, unknown> | undefined)?.test) return 'composer test';
  if (await fs.stat(path.join(dir, 'vendor', 'bin', 'phpunit')).then(() => true, () => false)) return process.platform === 'win32' ? 'vendor\\bin\\phpunit' : 'vendor/bin/phpunit';
  return null;
}

/**
 * O tempo que os testes têm (ver `runTests`). A suíte completa (6,8 mil testes) passava dos 10 min de antes: 26 de 49 rodadas de entrega desde 20/11 foram cortadas e saíram
 * como "falhou", e a mescla (`mergeCode`, que aborta se os testes não passam) nunca passava. 30 min dá folga acima da duração medida da suíte, com a máquina cheia. A trava
 * da fila pesada acompanha este valor (`leaseMs` de `runTests`).
 */
export const TEST_TIMEOUT_MS = 30 * 60_000;

/** A margem do prazo da trava da fila pesada sobre o tempo-limite: o dono solta a trava logo depois do corte, e a trava não pode valer como órfã antes disso. */
const LEASE_MARGIN_MS = 60_000;

/** O tempo-limite em texto: "30 min" (de 1 min para cima) ou "3 s". */
export function formatLimit(limitMs: number): string {
  return limitMs >= 60_000 ? `${Math.round(limitMs / 60_000)} min` : `${Math.max(1, Math.round(limitMs / 1000))} s`;
}

/** O texto que a saída leva no fim de uma rodada cortada no tempo: quem só lê `output` (a tela, o revisor) vê que não foi falha de teste. */
export function timeoutNote(limitMs: number): string {
  return `[tempo esgotado: a rodada foi cortada aos ${formatLimit(limitMs)} sem terminar. Isto não é falha de teste: não diz nada sobre o código.]`;
}

/**
 * Roda os testes (até `TEST_TIMEOUT_MS`); guarda só o fim da saída. O comando vem de detectTest, nunca do pedido. A suíte completa entra na fila
 * da máquina (uma validação pesada por vez, a mesma do terminal dos funcionários; ver `withHeavyLock`): o tempo de espera não conta
 * no tempo-limite nem no `ms` do resultado. Rodada cortada no tempo-limite volta com `timedOut` (e `ok: false`): é "tempo esgotado", não "falhou".
 * `queueAs`: o comando que decide a fila (padrão: o próprio); a nova rodada só dos arquivos que falharam (ver `isolateFailures`) é leve
 * por si, mas espera a vez como a suíte, para não rodar por cima de outra validação pesada e piorar a carga que causou a falha. `onWait`: avisa quando a suíte começa e quando deixa
 * de esperar a vez (ver `HeavyWaitFn`), para o estado da fila do funcionário mostrar a espera.
 */
export function runTests(dir: string, command: string, timeoutMs = TEST_TIMEOUT_MS, queueAs = command, onWait?: HeavyWaitFn): Promise<TestRun> {
  return withHeavyLock(queueAs, (held) => spawnTests(dir, command, timeoutMs, held), { label: `testes de ${path.basename(dir)}`, leaseMs: timeoutMs + LEASE_MARGIN_MS, onWait });
}

/** `held`: a chave da trava da fila que esta execução segura; vai no ambiente dela (ver `HEAVY_HELD_ENV`). */
function spawnTests(dir: string, command: string, timeoutMs: number, held: string | null): Promise<TestRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    // No Unix o `sh -c` vira líder do próprio grupo; no Windows o `cmd /c` é só o pai do npm/vitest. No tempo esgotado a árvore inteira sai
    // (`killTree`: grupo, ou `taskkill /T /F`): `child.kill()` mataria só o shell, o vitest seguiria e o `close` esperaria o fim dele nos pipes.
    const unix = process.platform !== 'win32';
    const child = spawn(command, { cwd: dir, shell: true, env: { ...cleanEnv(), CI: '1', ...(held && { [HEAVY_HELD_ENV]: held }) }, windowsHide: true, detached: unix });
    // O fim da saída (6 mil caracteres) perde o começo: a lista dos arquivos com falha vem da leitura da saída inteira, à medida que chega.
    const scan = new TestScan();
    const keep = (stream: 0 | 1) => (d: Buffer) => {
      const text = d.toString('utf8');
      out = (out + text).slice(-6000);
      scan.feed(text, stream);
    };
    child.stdout.on('data', keep(0));
    child.stderr.on('data', keep(1));
    let cut = false;
    const timer = setTimeout(() => {
      cut = true;
      if (child.pid) void killTree(child.pid);
      else child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      scan.end();
      const read = scan.result();
      // Cortada só se o corte valeu: a suíte que acabou limpa (código 0) no instante do corte passou.
      const timedOut = cut && code !== 0;
      const output = timedOut ? `${out.trim()}\n${timeoutNote(timeoutMs)}`.trim() : out.trim();
      resolve({
        command,
        ok: code === 0,
        output,
        ms: Date.now() - started,
        at: new Date().toISOString(),
        ...(read.files !== undefined && { files: read.files }),
        ...(code !== 0 && read.failedFiles && { failedFiles: read.failedFiles }),
        ...(timedOut && { timedOut: true, limitMs: timeoutMs }),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ command, ok: false, output: err.message, ms: Date.now() - started, at: new Date().toISOString() });
    });
  });
}

/** De `from` até o que está no disco, ou até o commit `to` (aí sem os arquivos novos não commitados). */
export async function changedFiles(dir: string, from: string, to?: string | null): Promise<TaskCodeFile[]> {
  const range = to ? [from, to] : [from];
  const numstat = await git(dir, ['diff', '--numstat', ...range, '--', '.', ...NOT_MYCO]).catch(() => '');
  const status = await git(dir, ['diff', '--name-status', ...range, '--', '.', ...NOT_MYCO]).catch(() => '');
  const kinds = new Map(
    status
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const parts = l.split('\t');
        return [parts.at(-1)!, parts[0]!.charAt(0)] as const;
      }),
  );
  const files: TaskCodeFile[] = numstat
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split('\t');
      const file = p.join('\t').replace(/^.*=> /, '').replace(/[{}]/g, '');
      return { path: file, status: kinds.get(file) ?? 'M', add: a === '-' ? 0 : Number(a), del: d === '-' ? 0 : Number(d) };
    });
  if (to) return files;
  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', '--', '.', ...NOT_MYCO]).catch(() => '');
  for (const f of untracked.split(/\r?\n/).filter(Boolean)) files.push({ path: f, status: '?', add: 0, del: 0 });
  return files;
}

async function dirtyCount(dir: string): Promise<number> {
  const out = await git(dir, ['status', '--porcelain', '--', '.', ...NOT_MYCO]).catch(() => '');
  return out.split(/\r?\n/).filter(Boolean).length;
}

/** Arquivos que o `git status` pode listar para `codeTouchedSince` conferir um a um: acima disso não há como provar nada e vale "mexeu". */
const TOUCHED_FILES_MAX = 2000;

/**
 * Algo do código foi mexido desde `sinceMs` (epoch ms)? É a prova de "nenhuma edição" do card sem código (ver `TaskService.holdNoCode`), e só `false` prova: vale `true` se algum arquivo
 * que o `git status` lista (alterado, apagado ou novo, fora `.myco/`) foi modificado depois de `sinceMs` (apagado não tem data: conta), se o commit do HEAD é de depois (alguém commitou) ou
 * se não deu para saber (git falhou, lista grande demais). No projeto compartilhado a mexida de outra tarefa também conta: é conservador, nunca acusa quem editou. Sem acesso ao
 * repositório (`place` já veio dele), o chamador não chega aqui.
 */
export async function codeTouchedSince(place: CodePlace, sinceMs: number): Promise<boolean> {
  try {
    // `%ct` é em segundos: o commit do mesmo segundo do início conta como depois.
    const committed = Number((await git(place.path, ['log', '-1', '--format=%ct']).catch(() => '')).trim()) * 1000;
    if (committed + 999 >= sinceMs) return true;
    const root = (await git(place.path, ['rev-parse', '--show-toplevel'])).trim();
    const fields = (await git(place.path, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', ...NOT_MYCO])).split('\0').filter(Boolean);
    if (fields.length > TOUCHED_FILES_MAX) return true;
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i]!;
      // Renomeado ou copiado: o nome de origem vem no campo seguinte, sem o código de duas letras.
      if (/[RC]/.test(entry.slice(0, 2))) i++;
      const stat = await fs.lstat(path.join(root, entry.slice(3))).catch(() => null);
      if (!stat || stat.mtimeMs >= sinceMs) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', '--is-inside-work-tree']).catch(() => '')).trim() === 'true';
}

function clip(diff: string): { diff: string; truncated: boolean } {
  return diff.length > MAX_DIFF ? { diff: diff.slice(0, MAX_DIFF), truncated: true } : { diff, truncated: false };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  try {
    return raw ? (JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? s;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: cleanEnv(), windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}
