import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DeliveryProof, DeliveryProofs, ProofBaseline, ProofFailure, TestRun } from '../shared/model';
import { linkDeps, unlinkAll } from './cardWorktree';
import { HeavyAbortedError, type HeavyWaitFn } from './heavyQueue';
import { fileKey, putBaseline, readBaseline, suiteKey, tscKey, type BaselineEntry, type BaselineStore } from './proofBaseline';
import { gitReason, hasWorktree, runGit, type GitRun } from './staff/worktree';
import { detectTest, formatLimit } from './taskCode';
import { IDS_MAX, ISOLATED_MAX, importGraph, isolateFailures, testFileOf } from './testFailures';

// As provas que o Claudio’s Club gera na entrega de um card que editou código: a checagem de tipos e os testes RELACIONADOS aos arquivos alterados (nunca a suíte inteira: ela roda na junção), no mesmo checkout da
// entrega, com comando, código de saída, contagem e a lista de falhas. Cada falha é comparada com a BASE (o commit de onde a tarefa saiu, sem as mudanças dela): "nova" ou "já falhava na base". Só falha nova conta contra a
// entrega, e só a que toca os arquivos da tarefa (a que vem de fora é no máximo 🟡). Tudo é limitado no tempo e nunca derruba a entrega: prova que estourou o tempo, perdeu a fila ou quebrou fica "indisponível" (dita no
// pedido de revisão, sem reprovar), e projeto sem tsc ou sem testes tem a seção "não se aplica". Vale para qualquer projeto e para os dois motores: nada aqui olha quem executou.

export const TYPECHECK_TIMEOUT_MS = 5 * 60_000;
export const TESTS_TIMEOUT_MS = 10 * 60_000;
/** O tempo das rodadas na base (tsc ou os arquivos que falharam). */
export const BASE_TIMEOUT_MS = 5 * 60_000;
/** O orçamento de TODAS as provas de uma entrega, fila e base inclusas: passou, o que ainda esperava ou rodava é cancelado e a prova sai "indisponível". */
export const PROOFS_BUDGET_MS = 12 * 60_000;
/** Os arquivos alterados que vão ao comando dos relacionados: acima disso a linha de comando do Windows não cabe e o resultado seria quase a suíte. */
export const RELATED_MAX = 60;
/** As falhas listadas no pedido de revisão; o resto vai como contagem. */
export const FAILURES_MAX = 25;
const TAIL_MAX = 800;
/** O `git worktree add` da base baixa todos os arquivos: o mesmo teto dos outros checkouts do Club. */
const ADD_TIMEOUT_MS = 3 * 60_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// O override por projeto: `<projeto>/.myco/proofs.json`, lido do checkout PRINCIPAL (o funcionário edita a worktree dele, não esta pasta).
// ---------------------------------------------------------------------------------------------------------------------------------

/** Um comando é uma linha só, sem caracteres de controle; `false` desliga a prova. */
const Command = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(400)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f]+$/, 'o comando tem de ser uma linha, sem caracteres de controle'),
  z.literal(false),
]);

/** `typecheck`: o comando de tipos; `tests`: o dos relacionados, com `{files}` no lugar dos arquivos (sem ele, roda como está). `false` desliga. `timeoutSec`: o tempo de cada rodada. */
const ProofConfigShape = z
  .object({ typecheck: Command.optional(), tests: Command.optional(), timeoutSec: z.number().int().min(10).max(1800).optional() })
  .strict();

export type ProofConfig = z.infer<typeof ProofConfigShape>;

export async function readProofConfig(dir: string): Promise<{ ok: true; config: ProofConfig } | { ok: false; reason: string }> {
  const raw = await fs.readFile(path.join(dir, '.myco', 'proofs.json'), 'utf8').catch(() => null);
  if (raw === null) return { ok: true, config: {} };
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return { ok: false, reason: '`.myco/proofs.json` não é um JSON válido' };
  }
  const parsed = ProofConfigShape.safeParse(data);
  if (parsed.success) return { ok: true, config: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, reason: `\`.myco/proofs.json\` inválido (${issue?.path.join('.') || 'raiz'}: ${issue?.message ?? 'formato'})` };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Descoberta: o que rodar neste projeto.
// ---------------------------------------------------------------------------------------------------------------------------------

type Plan = { kind: 'run'; command: string } | { kind: 'na'; reason: string } | { kind: 'unavailable'; reason: string };

export interface TestsPlan {
  plan: Plan;
  /** O comando que roda só os `files` na base (o dos arquivos que falharam); null = não dá. */
  onlyFiles: ((files: string[]) => string) | null;
}

const TS_FILE = /\.(?:ts|tsx|mts|cts)$/i;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'tsc', 'check:types', 'types'];

const isFile = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);

/** Os arquivos da entrega como caminho relativo e com `/` (o que a lista da tarefa traz pode vir com `\` ou `./`). */
export function normalizeChanged(cwd: string, changed: string[]): string[] {
  const out = new Set<string>();
  for (const raw of changed) {
    let f = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (path.isAbsolute(raw)) {
      const rel = path.relative(cwd, raw).replace(/\\/g, '/');
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      f = rel;
    }
    if (f) out.add(f);
  }
  return [...out];
}

async function scriptsOf(dir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null);
  try {
    const scripts = (JSON.parse((raw ?? '').replace(/^﻿/, '')) as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function typecheckPlan(cwd: string, changed: string[], cfg: ProofConfig): Promise<Plan> {
  if (cfg.typecheck === false) return { kind: 'na', reason: 'desligado em `.myco/proofs.json`' };
  if (typeof cfg.typecheck === 'string') return { kind: 'run', command: cfg.typecheck };
  if (!changed.some((f) => TS_FILE.test(f))) return { kind: 'na', reason: changed.length ? 'nenhum arquivo TypeScript foi alterado' : 'a tarefa não tem lista de arquivos alterados' };
  const scripts = await scriptsOf(cwd);
  const name = TYPECHECK_SCRIPTS.find((n) => typeof scripts[n] === 'string' && (scripts[n] as string).trim());
  if (name) return { kind: 'run', command: `npm run ${name}` };
  const tsc = ['tsc', 'tsc.cmd'].map((n) => path.join(cwd, 'node_modules', '.bin', n));
  if ((await isFile(path.join(cwd, 'tsconfig.json'))) && (await Promise.all(tsc.map(isFile))).some(Boolean)) return { kind: 'run', command: 'npx tsc --noEmit' };
  return { kind: 'na', reason: 'o projeto não tem script de tipos (typecheck, type-check, tsc) nem tsconfig com o tsc instalado' };
}

export async function testsPlan(cwd: string, changed: string[], cfg: ProofConfig): Promise<TestsPlan> {
  const na = (reason: string): TestsPlan => ({ plan: { kind: 'na', reason }, onlyFiles: null });
  if (cfg.tests === false) return na('desligado em `.myco/proofs.json`');
  const custom = typeof cfg.tests === 'string' ? cfg.tests : null;
  if (custom && !custom.includes('{files}')) return { plan: { kind: 'run', command: custom }, onlyFiles: null };
  // Quem roda: o comando do projeto, se for um que sabe rodar só os relacionados (o vitest e o jest simples); outro executor (phpunit, `&&`, flags) só roda a suíte inteira, na junção.
  const script = (await scriptsOf(cwd)).test;
  const test = typeof script === 'string' ? script.trim() : '';
  let related: ((list: string) => string) | null = null;
  let only: ((files: string[]) => string) | null = null;
  if (custom) {
    related = (list) => custom.replace(/\{files\}/g, list);
    only = (files) => custom.replace(/\{files\}/g, files.join(' '));
  } else if (/^vitest(\s+run)?$/.test(test)) {
    related = (list) => `npx vitest related --run --passWithNoTests ${list}`;
    only = (files) => `npx vitest run ${files.join(' ')}`;
  } else if (/^jest$/.test(test)) {
    related = (list) => `npx jest --findRelatedTests --passWithNoTests ${list}`;
    only = (files) => `npx jest --passWithNoTests ${files.join(' ')}`;
  } else {
    const project = await detectTest(cwd);
    return na(project ? `o comando de testes do projeto (\`${project}\`) não é o vitest nem o jest simples, que sabem rodar só os relacionados: a suíte inteira não roda na entrega (só na junção da worktree, quando há)` : 'o projeto não tem comando de testes');
  }
  // Só caminho que cabe na linha de comando sem aspas (ver `testFileOf`) e que existe na entrega (apagado não tem o que testar).
  const files: string[] = [];
  for (const f of changed) if (CODE_FILE.test(f) && testFileOf(f) && (await isFile(path.join(cwd, f)))) files.push(f);
  if (!files.length) return na(changed.length ? 'nenhum arquivo de código existente foi alterado' : 'a tarefa não tem lista de arquivos alterados');
  if (files.length > RELATED_MAX) return { plan: { kind: 'unavailable', reason: `${files.length} arquivos alterados: lista grande demais para rodar só os relacionados (a suíte inteira não roda na entrega, só na junção da worktree, quando há)` }, onlyFiles: null };
  return { plan: { kind: 'run', command: related(files.join(' ')) }, onlyFiles: only };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A base: o commit de onde a tarefa saiu e um checkout dele (só quando o cache não responde).
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * O commit de onde a tarefa saiu, sem as mudanças dela: na worktree, o ponto em que ela se separa do HEAD do principal; no próprio projeto (a entrega ainda não commitada), o HEAD dele. Null se não deu
 * para saber (sem git, sem commit): as falhas ficam "base indisponível".
 */
export async function proofBaseSha(projectDir: string, place: { where: 'worktree' | 'project'; path: string } | null, git: GitRun = runGit): Promise<string | null> {
  const parse = async (dir: string, args: string[]) => (await git(dir, args).catch(() => '')).trim() || null;
  const main = await parse(projectDir, ['rev-parse', '--verify', 'HEAD']);
  if (!main) return null;
  if (!place || place.where === 'project') return main;
  return parse(place.path, ['merge-base', main, 'HEAD']);
}

/** Uma de cada vez por pasta: dois pedidos da mesma base não criam, usam e apagam o mesmo checkout um por cima do outro. */
const exclusive = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = exclusive.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  exclusive.set(key, tail);
  void tail.then(() => {
    if (exclusive.get(key) === tail) exclusive.delete(key);
  });
  return run;
}

/** Tira o checkout da base: as junções saem ANTES (no Windows o git segue a junção ao apagar e levou o conteúdo de `node_modules` do projeto uma vez). Devolve o motivo se não saiu (e nada é apagado). */
async function dropBase(projectDir: string, dir: string, git: GitRun): Promise<string | null> {
  const gone = await unlinkAll(dir);
  if (!gone.ok) return gone.reason;
  try {
    await git(projectDir, ['worktree', 'remove', '--force', dir], ADD_TIMEOUT_MS);
  } catch (err) {
    return gitReason((err as Error).message);
  }
  if (await fs.stat(dir).then(() => true, () => false)) return 'a pasta do checkout da base continua lá (algo a mantém aberta)';
  await git(projectDir, ['worktree', 'prune']).catch(() => '');
  return null;
}

/** Pasta que sobrou de uma criação cortada no meio (não é worktree): as junções saem antes, e só então ela é apagada. Devolve o motivo se não deu. */
async function removeLeftover(dir: string): Promise<string | null> {
  const gone = await unlinkAll(dir);
  if (!gone.ok) return gone.reason;
  return fs.rm(dir, { recursive: true, force: true }).then(() => null, (err: Error) => err.message);
}

/**
 * Roda `fn` num checkout destacado de `sha` (`<projeto>/.claude/worktrees/myco-base-<sha>`, com `node_modules` e `vendor` por junção, só se o git os ignora) e o tira depois, sempre com as junções fora primeiro.
 * Não conseguiu criar ou tirar: o motivo sai como erro (quem chama marca a base como indisponível); o que sobrou fica para a próxima vez, que o reaproveita se for do mesmo commit.
 */
async function withBase<T>(projectDir: string, sha: string, git: GitRun, timeoutMs: number, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(projectDir, '.claude', 'worktrees', `myco-base-${sha.slice(0, 12)}`);
  return oneAtATime(dir, async () => {
    const same = (await hasWorktree(dir)) && (await git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim() === sha;
    if (!same) {
      if (await fs.stat(dir).then(() => true, () => false)) {
        const why = (await hasWorktree(dir)) ? await dropBase(projectDir, dir, git) : await removeLeftover(dir);
        if (why) throw new Error(`sobrou um checkout antigo da base e não deu para limpá-lo: ${why}`);
      }
      await git(projectDir, ['worktree', 'prune']).catch(() => '');
      await fs.mkdir(path.dirname(dir), { recursive: true });
      try {
        await git(projectDir, ['worktree', 'add', '--detach', dir, sha], timeoutMs);
      } catch (err) {
        throw new Error(`não deu para criar o checkout da base: ${gitReason((err as Error).message)}`);
      }
    }
    await linkDeps(projectDir, dir, git);
    try {
      return await fn(dir);
    } finally {
      const why = await dropBase(projectDir, dir, git).catch((e: Error) => e.message);
      if (why) console.warn(`[provas] checkout da base ${sha.slice(0, 12)} não saiu: ${why}`);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A execução.
// ---------------------------------------------------------------------------------------------------------------------------------

/** O `runTests` do servidor (a fila de validação pesada, o limite de saída e o corte no tempo são os dele); `signal` cancela a espera e a rodada em andamento. */
export type RunFn = (cwd: string, command: string, timeoutMs: number, queueAs: string, onWait?: HeavyWaitFn, signal?: AbortSignal) => Promise<TestRun>;

export interface ProofInput {
  /** O checkout principal do projeto (onde `.myco/` mora). */
  projectDir: string;
  /** Onde está o código da entrega (a worktree do card ou do funcionário, ou o próprio projeto). */
  cwd: string;
  /** Os arquivos que a tarefa alterou (`Task.changedFiles`). */
  changed: string[];
  /** O commit da base (ver `proofBaseSha`); null = sem base. */
  baseSha: string | null;
  /** A fase de espera da fila de validação pesada: quem pediu mostra "esperando a vez" (só a rodada da entrega espera). */
  onWait?: HeavyWaitFn;
}

export interface ProofDeps {
  run: RunFn;
  git?: GitRun;
  budgetMs?: number;
}

const tail = (run: TestRun) => run.output.trim().slice(-TAIL_MAX);

/** O arquivo de uma falha: o do teste (`arquivo > suíte > teste`, `arquivo [carga]`) ou o do erro do tsc (`arquivo: TS1234 mensagem`). */
function fileOfId(id: string, kind: 'tests' | 'typecheck'): string {
  if (kind === 'typecheck') return /^(.*?): TS\d+ /.exec(id)?.[1] ?? '(projeto)';
  return id.split(' > ')[0]!.replace(/ \[carga\]$/, '');
}

/** Um comando que não chegou a rodar (fila cancelada pelo orçamento, erro de sistema). */
type Fault = { unavailable: string };

/** Uma prova com as falhas que ela leu (`ids`, vazio sem falha) e a rodada que a gerou (null se nada rodou). */
interface Outcome {
  proof: DeliveryProof;
  ids: string[];
  run: TestRun | null;
}

/** O que uma rodada diz da prova, sem o baseline: rodou (passou ou falhou, com as falhas lidas) ou não deu para provar (tempo, orçamento, comando que quebrou). */
function judge(kind: 'tests' | 'typecheck', command: string, run: TestRun, budgetMs: number): Outcome {
  const exitCode = run.exitCode ?? (run.ok ? 0 : undefined);
  const base = { command, ms: run.ms, ...(exitCode !== undefined && { exitCode }) };
  const gone = (reason: string): Outcome => ({ proof: { status: 'unavailable', ...base, reason, tail: tail(run) }, ids: [], run });
  if (run.spawnFailed) return gone(`o comando não abriu: ${run.output.slice(0, 200)}`);
  if (run.aborted) return gone(`o orçamento das provas (${formatLimit(budgetMs)}) acabou com o comando rodando`);
  if (run.timedOut) return gone(`tempo esgotado: cortado aos ${formatLimit(run.limitMs ?? run.ms)}; não diz nada sobre o código`);
  if (run.ok) return { proof: { status: 'ran', ...base, ...(run.counts && { counts: run.counts }) }, ids: [], run };
  const ids = (kind === 'tests' ? run.failureIds : run.typeErrors) ?? [];
  if (!ids.length) {
    return gone(
      kind === 'tests'
        ? `o comando terminou com código ${run.exitCode ?? '?'} sem nenhuma falha de teste lida na saída (não é a saída do vitest ou o comando quebrou antes de rodar os testes)`
        : `o comando terminou com código ${run.exitCode ?? '?'} sem nenhum erro de tipos lido na saída (o comando quebrou antes de checar)`,
    );
  }
  const total = kind === 'tests' ? ids.length : (run.typeErrorsTotal ?? ids.length);
  return { proof: { status: 'ran', ...base, ...(run.counts && { counts: run.counts }), ...(kind === 'typecheck' && { errors: total }), failuresTotal: total }, ids, run };
}

/** Roda um comando pela fila; o que não deu (fila cancelada, erro de sistema) vira `Fault`. */
async function exec(run: RunFn, cwd: string, command: string, timeoutMs: number, queueAs: string, onWait: HeavyWaitFn | undefined, signal: AbortSignal, budgetMs: number): Promise<TestRun | Fault> {
  try {
    return await run(cwd, command, timeoutMs, queueAs, onWait, signal);
  } catch (err) {
    if (err instanceof HeavyAbortedError || signal.aborted) return { unavailable: `a fila de validação da máquina não andou dentro do orçamento das provas (${formatLimit(budgetMs)})` };
    return { unavailable: `o comando não rodou: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}` };
  }
}

const isFault = (x: unknown): x is Fault => !!x && typeof x === 'object' && 'unavailable' in x;

export function unavailableProofs(reason: string, at = new Date().toISOString()): DeliveryProofs {
  return { at, typecheck: { status: 'unavailable', reason }, tests: { status: 'unavailable', reason } };
}

/**
 * Gera as provas da entrega. Nunca lança: o que quebra vira prova "indisponível". Devolve também a rodada dos testes relacionados (`Task.tests`: a tela e o resto do quadro a leem como o último teste do card).
 */
export async function generateProofs(input: ProofInput, deps: ProofDeps): Promise<{ proofs: DeliveryProofs; testRun: TestRun | null }> {
  const budgetMs = deps.budgetMs ?? PROOFS_BUDGET_MS;
  const git = deps.git ?? runGit;
  const cfg = await readProofConfig(input.projectDir);
  if (!cfg.ok) return { proofs: unavailableProofs(cfg.reason), testRun: null };
  const config = cfg.config;
  const changed = normalizeChanged(input.cwd, input.changed);
  const scale = config.timeoutSec ? config.timeoutSec * 1000 : null;
  const tscMs = scale ?? TYPECHECK_TIMEOUT_MS;
  const testsMs = scale ?? TESTS_TIMEOUT_MS;
  const baseMs = scale ?? BASE_TIMEOUT_MS;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetMs);
  timer.unref?.();
  const startedAt = Date.now();
  const left = () => Math.max(1000, budgetMs - (Date.now() - startedAt));
  try {
    const [tscPlan, tests] = await Promise.all([typecheckPlan(input.cwd, changed, config), testsPlan(input.cwd, changed, config)]);
    const first = async (plan: Plan, kind: 'tests' | 'typecheck', timeoutMs: number, onWait?: HeavyWaitFn): Promise<Outcome> => {
      if (plan.kind !== 'run') return { proof: { status: plan.kind, reason: plan.reason }, ids: [], run: null };
      const ran = await exec(deps.run, input.cwd, plan.command, timeoutMs, plan.command, onWait, ac.signal, budgetMs);
      if (isFault(ran)) return { proof: { status: 'unavailable', command: plan.command, reason: ran.unavailable }, ids: [], run: null };
      return judge(kind, plan.command, ran, budgetMs);
    };
    // Os dois ao mesmo tempo: o tsc espera a vez da fila pesada, os relacionados são leves e rodam já.
    const [tsc, tst] = await Promise.all([first(tscPlan, 'typecheck', tscMs, input.onWait), first(tests.plan, 'tests', testsMs, input.onWait)]);

    // Falhas: compara com a base e separa a instável (passa sozinha).
    if (tsc.ids.length || tst.ids.length) {
      const verdicts = await compareWithBase(
        { input, changed, git, signal: ac.signal, baseMs, left, run: deps.run, budgetMs },
        { typecheck: { ids: tsc.ids, command: tscPlan.kind === 'run' ? tscPlan.command : null }, tests: { ids: tst.ids, run: tst.run, plan: tests } },
      );
      applyVerdicts(tsc.proof, 'typecheck', tsc.ids, verdicts.typecheck, verdicts.baseSha, verdicts.baseFrom.typecheck);
      applyVerdicts(tst.proof, 'tests', tst.ids, verdicts.tests, verdicts.baseSha, verdicts.baseFrom.tests);
    }
    return { proofs: { at: new Date().toISOString(), typecheck: tsc.proof, tests: tst.proof }, testRun: tst.run };
  } catch (err) {
    return { proofs: unavailableProofs(`erro ao gerar as provas: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`), testRun: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// O baseline por falha.
// ---------------------------------------------------------------------------------------------------------------------------------

interface Verdict {
  baseline: ProofBaseline;
  flaky?: true;
  touches?: string;
}

interface CompareCtx {
  input: ProofInput;
  changed: string[];
  git: GitRun;
  signal: AbortSignal;
  baseMs: number;
  left: () => number;
  run: RunFn;
  budgetMs: number;
}

interface Compared {
  baseSha: string | null;
  baseFrom: { typecheck?: DeliveryProof['baseFrom']; tests?: DeliveryProof['baseFrom'] };
  typecheck: Map<string, Verdict>;
  tests: Map<string, Verdict>;
}

/**
 * Marca cada falha como `new` (só nesta entrega), `base` (já falhava no commit de onde a tarefa saiu) ou `unknown` (a base não ficou disponível). A resposta vem, nesta ordem, da última suíte completa naquele
 * commit (a junção a guarda), de uma rodada anterior na base (cache) e, só para o que faltar, de UM checkout destacado da base onde rodam só o tsc e/ou os arquivos de teste que falharam. As que não são `base` e a
 * entrega não toca ainda passam por uma nova rodada isolada (a que passa sozinha é instável sob carga). `touches`: o arquivo da entrega que o arquivo da falha é ou importa.
 */
async function compareWithBase(ctx: CompareCtx, work: { typecheck: { ids: string[]; command: string | null }; tests: { ids: string[]; run: TestRun | null; plan: TestsPlan } }): Promise<Compared> {
  const { input, git } = ctx;
  const out: Compared = { baseSha: input.baseSha, baseFrom: {}, typecheck: new Map(), tests: new Map() };
  const unknown = (ids: string[], kind: 'tests' | 'typecheck') => ids.forEach((id) => out[kind].set(id, { baseline: 'unknown' }));

  if (!input.baseSha) {
    unknown(work.typecheck.ids, 'typecheck');
    unknown(work.tests.ids, 'tests');
  } else {
    const sha = input.baseSha;
    const cache = await readBaseline(input.projectDir);
    const fresh: BaselineStore = {};
    const testFiles = [...new Set(work.tests.ids.map((id) => fileOfId(id, 'tests')))];

    // O que o cache já responde.
    const knownTests = new Map<string, BaselineEntry>();
    const suite = cache[suiteKey(sha)];
    const needFiles: string[] = [];
    for (const f of testFiles) {
      const entry = suite?.complete ? suite : cache[fileKey(sha, f)];
      if (entry) {
        knownTests.set(f, entry);
        out.baseFrom.tests = suite?.complete ? 'suite' : (out.baseFrom.tests ?? 'cache');
      } else needFiles.push(f);
    }
    const knownTsc = work.typecheck.ids.length ? cache[tscKey(sha)] : undefined;
    const needTsc = work.typecheck.ids.length > 0 && !knownTsc && !!work.typecheck.command;
    if (knownTsc) out.baseFrom.typecheck = 'cache';

    // O que falta: um checkout só.
    const rest = needFiles.slice(0, ISOLATED_MAX);
    const runnable = work.tests.plan.onlyFiles;
    if (needTsc || (rest.length && runnable)) {
      try {
        await withBase(input.projectDir, sha, git, Math.min(ADD_TIMEOUT_MS, ctx.left()), async (dir) => {
          if (needTsc) {
            const cmd = work.typecheck.command!;
            const ran = await exec(ctx.run, dir, cmd, ctx.baseMs, cmd, undefined, ctx.signal, ctx.budgetMs);
            if (!isFault(ran) && !ran.timedOut && !ran.aborted && !ran.spawnFailed && (ran.ok || ran.typeErrors?.length)) {
              fresh[tscKey(sha)] = { at: new Date().toISOString(), ids: ran.typeErrors ?? [], complete: (ran.typeErrorsTotal ?? 0) <= IDS_MAX };
              out.baseFrom.typecheck = 'checkout';
            }
          }
          if (rest.length && runnable) {
            const present: string[] = [];
            for (const f of rest) {
              if (await isFile(path.join(dir, f))) present.push(f);
              else fresh[fileKey(sha, f)] = { at: new Date().toISOString(), ids: [], complete: true, present: false };
            }
            if (present.length) {
              const cmd = runnable(present);
              const ran = await exec(ctx.run, dir, cmd, ctx.baseMs, cmd, undefined, ctx.signal, ctx.budgetMs);
              // Rodada completa: terminou limpa ou com falhas lidas. Cortada, cancelada ou quebrada não prova nada.
              if (!isFault(ran) && !ran.timedOut && !ran.aborted && !ran.spawnFailed && (ran.ok || ran.failureIds?.length)) {
                const ids = ran.failureIds ?? [];
                for (const f of present) fresh[fileKey(sha, f)] = { at: new Date().toISOString(), ids: ids.filter((id) => fileOfId(id, 'tests') === f), complete: ids.length < IDS_MAX, present: true };
                out.baseFrom.tests = out.baseFrom.tests ?? 'checkout';
              }
            }
          }
        });
      } catch (err) {
        console.warn(`[provas] base ${sha.slice(0, 12)} indisponível: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (Object.keys(fresh).length) await putBaseline(input.projectDir, fresh);
    }

    // Sem a entrada, ou com uma lista que passou do teto sem o id, não se sabe; arquivo que não existia na base é todo desta entrega.
    const answer = (entry: BaselineEntry | undefined, id: string): Verdict => {
      if (!entry) return { baseline: 'unknown' };
      if (entry.present === false) return { baseline: 'new' };
      if (entry.ids.includes(id)) return { baseline: 'base' };
      return { baseline: entry.complete ? 'new' : 'unknown' };
    };
    for (const id of work.tests.ids) {
      const f = fileOfId(id, 'tests');
      out.tests.set(id, answer(knownTests.get(f) ?? fresh[fileKey(sha, f)], id));
    }
    for (const id of work.typecheck.ids) out.typecheck.set(id, answer(knownTsc ?? fresh[tscKey(sha)], id));
  }

  // Onde a falha toca a entrega, e a instável: só para o que não é "já falhava na base".
  const graph = importGraph(input.cwd);
  for (const kind of ['tests', 'typecheck'] as const) {
    for (const [id, v] of out[kind]) {
      if (v.baseline === 'base') continue;
      const file = fileOfId(id, kind);
      const touches = file === '(projeto)' || path.isAbsolute(file) ? null : await graph.reaches(file, ctx.changed).catch(() => null);
      if (touches) v.touches = touches;
    }
  }
  await markFlaky(ctx, work.tests, out.tests);
  return out;
}

/** A falha de teste que a entrega pode ter trazido e que passa quando só o arquivo dela roda de novo: instável sob carga ou por ordem, não prova nada contra a entrega. */
async function markFlaky(ctx: CompareCtx, tests: { ids: string[]; run: TestRun | null; plan: TestsPlan }, verdicts: Map<string, Verdict>): Promise<void> {
  const run = tests.run;
  if (!run || ctx.signal.aborted) return;
  const candidates = (run.failedFiles ?? []).filter((f) => [...verdicts].some(([id, v]) => v.baseline !== 'base' && fileOfId(id, 'tests') === f.file));
  if (!candidates.length) return;
  const rerun = (cwd: string, command: string, timeoutMs: number, queueAs: string) => ctx.run(cwd, command, timeoutMs, queueAs, undefined, ctx.signal);
  const isolation = await isolateFailures(ctx.input.cwd, { ...run, failedFiles: candidates }, ctx.changed, rerun, 'npm test').catch(() => undefined);
  const passed = new Set((isolation?.files ?? []).filter((f) => f.status === 'pass').map((f) => f.file));
  for (const [id, v] of verdicts) if (v.baseline !== 'base' && passed.has(fileOfId(id, 'tests'))) v.flaky = true;
}

/** Grava as falhas marcadas na prova: primeiro as que contam, e a lista tem teto (`failuresTotal` diz quantas eram). */
function applyVerdicts(proof: DeliveryProof, kind: 'tests' | 'typecheck', ids: string[], verdicts: Map<string, Verdict>, baseSha: string | null, baseFrom: DeliveryProof['baseFrom']): void {
  if (!ids.length || proof.status !== 'ran') return;
  const rank = (f: ProofFailure) => (f.flaky ? 4 : f.baseline === 'new' ? (f.touches ? 0 : 1) : f.baseline === 'unknown' ? (f.touches ? 2 : 3) : 5);
  const all = ids.map((id): ProofFailure => {
    const v = verdicts.get(id) ?? { baseline: 'unknown' as const };
    return { id, file: fileOfId(id, kind), baseline: v.baseline, ...(v.touches && { touches: v.touches }), ...(v.flaky && { flaky: true }) };
  });
  all.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  proof.failures = all.slice(0, FAILURES_MAX);
  proof.failuresTotal = Math.max(proof.failuresTotal ?? 0, all.length);
  if (baseSha && all.some((f) => f.baseline !== 'unknown')) {
    proof.baseSha = baseSha;
    if (baseFrom) proof.baseFrom = baseFrom;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// O texto do pedido de revisão.
// ---------------------------------------------------------------------------------------------------------------------------------

/** O que a falha vale para a entrega, na ordem em que a lista a mostra: `counts` conta contra ela; os outros são no máximo 🟡. */
export type FailureWeight = 'counts' | 'outside' | 'preexisting' | 'flaky' | 'unknown-touches' | 'unknown-outside';

export function failureWeight(f: ProofFailure): FailureWeight {
  if (f.flaky) return 'flaky';
  if (f.baseline === 'base') return 'preexisting';
  if (f.baseline === 'new') return f.touches ? 'counts' : 'outside';
  return f.touches ? 'unknown-touches' : 'unknown-outside';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const secs = (ms: number | undefined) => `${Math.max(1, Math.round((ms ?? 0) / 1000))} s`;

/**
 * As provas para o pedido de revisão e o aviso a quem pediu: uma linha por prova, e as falhas marcadas. `clean` passa todo texto que veio do código da tarefa (nome de teste, mensagem do tsc: é dado de funcionário,
 * ver `untrustedLine`) antes de entrar na conversa de quem lê.
 */
export function proofsBlock(p: DeliveryProofs, clean: (text: string, max?: number) => string): string {
  const lines = ['Provas geradas pelo Claudio’s Club para esta entrega (o executor não as redigita: não as cobre dele). Não rode o tsc nem os testes relacionados de novo; só falha NOVA que toca os arquivos da tarefa conta contra a entrega, o resto é no máximo 🟡:'];
  lines.push(...proofLines('Tipos (tsc)', 'typecheck', p.typecheck, clean));
  lines.push(...proofLines('Testes relacionados aos arquivos alterados', 'tests', p.tests, clean));
  return lines.join('\n');
}

function proofLines(title: string, kind: 'tests' | 'typecheck', p: DeliveryProof, clean: (text: string, max?: number) => string): string[] {
  if (p.status === 'na') return [`- ${title}: não se aplica (${p.reason ?? 'sem motivo'}).`];
  const cmd = p.command ? `\`${clean(p.command, 200)}\`` : '';
  if (p.status === 'unavailable') {
    return [`- ${title}: INDISPONÍVEL${cmd ? ` (${cmd})` : ''}: ${clean(p.reason ?? 'sem motivo', 300)}. Prova indisponível NÃO é motivo de reprovação e não consome rodada: confira só o que for essencial.`];
  }
  const head = `- ${title} (${cmd}, código de saída ${p.exitCode ?? '?'}, ${secs(p.ms)})`;
  const counts = p.counts ? `${plural(p.counts.passed, 'passou', 'passaram')}, ${plural(p.counts.failed, 'falhou', 'falharam')} (de ${p.counts.total})` : '';
  if (!p.failuresTotal) return [`${head}: ${kind === 'typecheck' ? 'limpo, sem erro' : counts || 'passaram'}.`];
  const total = p.failuresTotal;
  const weights = (p.failures ?? []).map(failureWeight);
  const count = (w: FailureWeight) => weights.filter((x) => x === w).length;
  const unknown = count('unknown-touches') + count('unknown-outside');
  const summary = [
    `Nova que toca a tarefa: ${count('counts')} (conta contra a entrega)`,
    count('outside') && `Nova fora dos arquivos da tarefa: ${count('outside')} (no máximo 🟡)`,
    count('preexisting') && `Já falhava na base: ${count('preexisting')} (não conta)`,
    count('flaky') && `Passa sozinha (instável): ${count('flaky')} (não conta)`,
    unknown && `Sem base para comparar: ${unknown} (${count('unknown-touches') ? `${count('unknown-touches')} com ligação à tarefa: confira` : 'fora dos arquivos da tarefa: no máximo 🟡'})`,
  ].filter(Boolean);
  const what = kind === 'typecheck' ? plural(p.errors ?? total, 'erro de tipos', 'erros de tipos') : `${counts || plural(total, 'falha', 'falhas')}`;
  const origin = p.baseFrom === 'suite' ? ', a última suíte completa nesse commit' : p.baseFrom === 'cache' ? ', rodada anterior nesse commit' : p.baseFrom === 'checkout' ? ', rodada nesse commit' : '';
  const from = p.baseSha ? `\`${p.baseSha.slice(0, 7)}\`${origin}` : 'sem base para comparar';
  const out = [`${head}: ${what}. Contra a base (${from}): ${summary.join('; ')}.`];
  const shown = p.failures ?? [];
  for (const f of shown) out.push(`  - \`${clean(f.id, 160)}\`: ${weightText(f)}`);
  if (total > shown.length) out.push(`  - … e mais ${plural(total - shown.length, 'falha', 'falhas')}`);
  return out;
}

function weightText(f: ProofFailure): string {
  switch (failureWeight(f)) {
    case 'counts':
      return `NOVA, toca a entrega (${f.touches === f.file ? 'é um arquivo dela' : `importa \`${f.touches}\`, que é dela`}): conta contra a entrega`;
    case 'outside':
      return 'nova, mas fora dos arquivos da tarefa: não reprova, no máximo 🟡';
    case 'preexisting':
      return 'já falhava na base: não conta';
    case 'flaky':
      return 'passa sozinha (instável sob carga ou por ordem): não conta';
    case 'unknown-touches':
      return `sem base para comparar, mas toca a entrega (${f.touches === f.file ? 'é um arquivo dela' : `importa \`${f.touches}\``}): confira`;
    default:
      return 'sem base para comparar e fora dos arquivos da tarefa: no máximo 🟡';
  }
}
