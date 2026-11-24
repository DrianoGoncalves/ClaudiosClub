import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskCode, TaskCodeFile, TestRun } from '../shared/model';
import { cleanEnv } from './auth';
import { killTree } from './chat/registry';
import { HEAVY_HELD_ENV, withHeavyLock, type HeavyWaitFn } from './heavyQueue';
import { recordSuite } from './proofBaseline';
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
  /** A worktree é a de um CARD (server/cardWorktree.ts): o branch só tem o que é do card e a junção é a de `mergeCard`. */
  card?: boolean;
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
  // Conflito aberto (o merge do principal no worktree do card, ver `mergeCard`): o `add -A` commitaria os marcadores `<<<<<<<`. Sem commit: a entrega fica sem checkpoint e a junção a recusa com o motivo.
  if ((await unresolvedFiles(place.path)).length) return null;
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
  // Worktree de card: o principal sujo só atrapalha onde é arquivo DO CARD (a junção só mexe neles, ver `mergeCard`); o resto fica como o dono deixou.
  const overlap = place.card ? await dirtyOverlap(projectPath, files.map((f) => f.path)) : [];
  const whyNot = !base
    ? 'o projeto principal está com o HEAD destacado'
    : place.card
      ? overlap.length
        ? overlapMessage(overlap)
        : !files.length && !commits.length
          ? 'não há mudanças na worktree'
          : null
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
  if (place.card) return mergeCard(projectPath, place, title, opts);
  const end = await validEnd(place, opts.upTo);
  if (!end && !opts.wholeBranch)
    throw new CodeError(
      opts.upTo ? 'o commit da entrega não é desta worktree (não é ancestral do HEAD dela): a mescla foi recusada, não vou levar o branch inteiro' : 'a entrega não tem commit gravado: a mescla foi recusada, não vou levar o branch inteiro',
      'no-delivery',
    );
  const code = await readCode(projectPath, place, end);
  if (!code.canMerge || !code.base) throw new CodeError(code.whyNot ?? 'não dá para mesclar agora', code.base && (await dirtyCount(projectPath)) ? 'main-dirty' : null);
  const test = code.test;
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
    tests = await runTests(projectPath, test, opts.testTimeoutMs);
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
  await rememberSuite(projectPath, tests);
  return { sha, base: code.base, branch: place.branch, tests };
}

/**
 * Guarda a suíte completa da junção para o baseline das provas da entrega (ver proofBaseline.ts): a árvore testada é a do commit `rev` (o HEAD depois de a junção commitar). Nunca derruba a
 * junção: a memória é só ganho de tempo.
 */
async function rememberSuite(projectPath: string, tests: TestRun | null, rev = 'HEAD'): Promise<void> {
  if (!tests) return;
  const sha = (await git(projectPath, ['rev-parse', '--verify', rev]).catch(() => '')).trim();
  if (sha) await recordSuite(projectPath, sha, tests).catch(() => {});
}

/** Quantas vezes a junção do card refaz a atualização + os testes quando o principal anda no meio (commit do dono, outro card junto). Passou disso: erro passageiro, a retentativa refaz. */
const CARD_MERGE_ROUNDS = 3;

/** Os arquivos com conflito aberto em `dir` (um merge parado no meio); vazio se não há. */
export async function unresolvedFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ['diff', '--name-only', '-z', '--diff-filter=U']).catch(() => '');
  return out.split('\0').filter(Boolean);
}

/** Dos `paths`, os que estão com mudança não commitada (alterados, no índice ou novos sem rastreio, fora `.myco/`) em `dir`. */
async function dirtyOverlap(dir: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const out = await git(dir, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', ...NOT_MYCO]).catch(() => '');
  const fields = out.split('\0').filter(Boolean);
  const dirty = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    dirty.add(entry.slice(3));
    // Renomeado ou copiado: o nome de origem vem no campo seguinte, sem o código de duas letras.
    if (/[RC]/.test(entry.slice(0, 2))) dirty.add(fields[++i] ?? '');
  }
  return [...new Set(paths)].filter((p) => dirty.has(p));
}

const overlapMessage = (files: string[]): string =>
  `o principal tem mudança não commitada em ${files.length === 1 ? 'arquivo' : 'arquivos'} do card: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` e mais ${files.length - 8}` : ''}. Commite ou guarde; a junção segue sozinha quando ficarem limpos`;

/**
 * A junção de um card (worktree própria, ver server/cardWorktree.ts): o branch do card só tem o que é dele, então nada de outro card entra. Ordem: confere a entrega (commit `upTo`, worktree limpa
 * e sem merge parado), os arquivos do card que o principal tem sujos (barato, antes de gastar testes), traz o HEAD do principal para o branch do card POR MERGE (rebase reescreveria os commits
 * que `Task.checkpoint(s)` e `integratedSha` conhecem), roda os testes no worktree do card (já com o principal dentro), confere de novo e só então move o principal: `commit-tree` (pais: o HEAD do
 * principal e a ponta do card, árvore da ponta: é o `--no-ff` de sempre, um commit de merge por card) e `merge --ff-only`. O principal só muda no ff, de uma vez: nunca fica meio mesclado, e o
 * git recusa sozinho se algum arquivo que o ff muda tem mudança não commitada; o resto que o dono deixou sujo (inclusive no índice) não é tocado.
 * Conflito ao trazer o principal: NÃO desfaz. O worktree do card fica com o merge em andamento e os marcadores (`CodeError` `conflict` com os arquivos), para o responsável resolver nele.
 */
async function mergeCard(
  projectPath: string,
  place: CodePlace,
  title: string,
  opts: { skipTests?: boolean; upTo?: string | null; testTimeoutMs?: number },
): Promise<{ sha: string; base: string; branch: string; tests: TestRun | null }> {
  const branch = place.branch!;
  const end = await validEnd(place, opts.upTo);
  if (!end)
    throw new CodeError(
      opts.upTo ? 'o commit da entrega não é desta worktree (não é ancestral do HEAD dela): a mescla foi recusada, não vou levar o branch inteiro' : 'a entrega não tem commit gravado: a mescla foi recusada, não vou levar o branch inteiro',
      'no-delivery',
    );
  const base = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  if (!base || base === 'HEAD') throw new CodeError('o projeto principal está com o HEAD destacado');
  const test = await detectTest(projectPath);
  if (!test && !opts.skipTests) throw new CodeError('não achei testes neste projeto (npm test, composer test ou phpunit)', 'no-tests');

  const parse = async (dir: string, rev: string) => (await git(dir, ['rev-parse', '--verify', rev])).trim();
  const stuck = await unresolvedFiles(place.path);
  if (stuck.length) throw new CodeError(`conflito ainda não resolvido na worktree do card: ${stuck.join(', ')}`, 'conflict', null, stuck);
  if (await git(place.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false)) {
    throw new CodeError('a worktree do card está com um merge em andamento: termine o commit dele (git commit) e entregue de novo', 'no-delivery');
  }
  if ((await dirtyCount(place.path)) || (await parse(place.path, 'HEAD')) !== (await parse(place.path, end))) {
    throw new CodeError('a worktree do card mudou depois da entrega: entregue de novo antes de mesclar', 'no-delivery');
  }

  let tests: TestRun | null = null;
  for (let round = 0; round < CARD_MERGE_ROUNDS; round++) {
    const mainHead = await parse(projectPath, 'HEAD');
    // Barato e antes dos testes: o que o card muda desde onde saiu, e o dono deixou sujo no principal.
    const mine = (await git(place.path, ['diff', '--name-only', '-z', `${mainHead}...HEAD`]).catch(() => '')).split('\0').filter(Boolean);
    const early = await dirtyOverlap(projectPath, mine);
    if (early.length) throw new CodeError(overlapMessage(early), 'main-dirty', null, early);

    // Traz o principal para o branch do card (a junção do card nunca toca o principal antes do ff).
    const behind = !(await git(place.path, ['merge-base', '--is-ancestor', mainHead, 'HEAD']).then(() => true, () => false));
    if (behind) {
      try {
        await git(place.path, ['merge', '--no-edit', '-m', `Merge ${base} em ${branch}`, mainHead]);
      } catch (err) {
        const files = await unresolvedFiles(place.path);
        if (!files.length) {
          await git(place.path, ['merge', '--abort']).catch(() => {});
          throw new CodeError(`não deu para trazer o principal para a worktree do card: ${firstLine((err as Error).message)}`);
        }
        throw new CodeError(`conflito ao trazer o principal para a worktree do card em: ${files.join(', ')}`, 'conflict', null, files);
      }
    }

    if (test) {
      tests = await runTests(place.path, test, opts.testTimeoutMs);
      if (!tests.ok) {
        if (tests.timedOut) throw new CodeError(`os testes passaram do tempo-limite de ${formatLimit(tests.limitMs ?? TEST_TIMEOUT_MS)} no worktree do card: nada foi mesclado (não é falha de teste: confira se a máquina está cheia e tente de novo)`, 'tests-timeout', tests);
        throw new CodeError('os testes falharam no worktree do card com o principal dentro: nada foi mesclado', 'tests-failed', tests);
      }
    }

    // O principal andou durante os testes (commit do dono, outro card): o que foi testado não é mais "o principal + o card". Atualiza e testa de novo.
    if ((await parse(projectPath, 'HEAD')) !== mainHead) continue;

    const tip = await parse(place.path, 'HEAD');
    // Authoritativo: tudo o que o ff muda no principal (o card + o que o merge de sincronização trouxe), contra o que o dono tem sujo.
    const changing = (await git(projectPath, ['diff', '--name-only', '-z', mainHead, tip]).catch(() => '')).split('\0').filter(Boolean);
    const late = await dirtyOverlap(projectPath, changing);
    if (late.length) throw new CodeError(overlapMessage(late), 'main-dirty', null, late);

    // Já está no principal (nada a juntar): não há commit a criar.
    const inMain = await git(projectPath, ['merge-base', '--is-ancestor', tip, mainHead]).then(() => true, () => false);
    if (inMain) {
      await rememberSuite(projectPath, tests, tip);
      return { sha: (await git(projectPath, ['rev-parse', '--short', mainHead])).trim(), base, branch, tests };
    }
    const tree = await parse(place.path, `${tip}^{tree}`);
    let joined: string;
    try {
      joined = (await git(projectPath, ['commit-tree', tree, '-p', mainHead, '-p', tip, '-m', `Merge ${branch}: ${title}`])).trim();
      await git(projectPath, ['merge', '--ff-only', joined]);
    } catch (err) {
      const text = (err as Error).message;
      // O git recusou o ff por mudança não commitada num arquivo que ele muda (o principal andou entre a conferência e o ff): espera, como a conferência.
      if (/would be overwritten|seriam sobrescritas|sobrescrit/i.test(text)) {
        const named = text.split(/\r?\n/).filter((l) => /^\s+\S/.test(l)).map((l) => l.trim());
        throw new CodeError(overlapMessage(named.length ? named : changing.slice(0, 8)), 'main-dirty', null, named);
      }
      throw new CodeError(`não deu para juntar o card no principal: ${firstLine(text)}`);
    }
    // A árvore do commit de junção é a da ponta do card (a que os testes viram).
    await rememberSuite(projectPath, tests, joined);
    return { sha: (await git(projectPath, ['rev-parse', '--short', 'HEAD'])).trim(), base, branch, tests };
  }
  throw new CodeError('o principal andou durante os testes várias vezes seguidas: a junção tenta de novo');
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
export function runTests(dir: string, command: string, timeoutMs = TEST_TIMEOUT_MS, queueAs = command, onWait?: HeavyWaitFn, signal?: AbortSignal): Promise<TestRun> {
  return withHeavyLock(queueAs, (held) => spawnTests(dir, command, timeoutMs, held, signal), { label: `testes de ${path.basename(dir)}`, leaseMs: timeoutMs + LEASE_MARGIN_MS, onWait, signal });
}

/**
 * `held`: a chave da trava da fila que esta execução segura; vai no ambiente dela (ver `HEAVY_HELD_ENV`). `signal`: abortado com a rodada em andamento, a árvore de processos sai e a rodada volta com
 * `aborted` (e `ok: false`); abortado antes de rodar, não roda (ver `withHeavyLock`).
 */
function spawnTests(dir: string, command: string, timeoutMs: number, held: string | null, signal?: AbortSignal): Promise<TestRun> {
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
    let aborted = false;
    const stop = () => {
      if (child.pid) void killTree(child.pid);
      else child.kill();
    };
    const timer = setTimeout(() => {
      cut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      scan.end();
      const read = scan.result();
      // Cortada só se o corte valeu: a suíte que acabou limpa (código 0) no instante do corte passou.
      const timedOut = cut && !aborted && code !== 0;
      const abortedRun = aborted && code !== 0;
      const output = timedOut ? `${out.trim()}\n${timeoutNote(timeoutMs)}`.trim() : out.trim();
      resolve({
        command,
        ok: code === 0,
        output,
        ms: Date.now() - started,
        at: new Date().toISOString(),
        ...(code !== null && { exitCode: code }),
        ...(read.files !== undefined && { files: read.files }),
        ...(read.counts && { counts: read.counts }),
        ...(read.failureIds && { failureIds: read.failureIds }),
        ...(read.typeErrors && { typeErrors: read.typeErrors, typeErrorsTotal: read.typeErrorsTotal }),
        ...(code !== 0 && read.failedFiles && { failedFiles: read.failedFiles }),
        ...(timedOut && { timedOut: true, limitMs: timeoutMs }),
        ...(abortedRun && { aborted: true }),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ command, ok: false, output: err.message, ms: Date.now() - started, at: new Date().toISOString(), spawnFailed: true });
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
