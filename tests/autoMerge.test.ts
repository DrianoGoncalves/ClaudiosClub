import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FlowPolicies } from '../server/flowPolicy';
import { ensureWorktree } from '../server/staff/worktree';
import { CodeError, locateCode, mergeCode } from '../server/taskCode';
import { TaskService, ownAlerts, readTasks } from '../server/tasks';
import type { StaffProfile, Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// Mescla automática na aprovação (t-98d683): com a conclusão por IA ESCOLHIDA pelo dono, a aprovação mescla a worktree do funcionário até o commit da entrega, sem o clique, e leva a "pronto".
// Git, worktree e `npm test` de verdade; só as conversas são falsas. O `mergeCode` passa por uma sonda (conta quantas mesclas rodam ao mesmo tempo e quantas vezes é chamado).
// Cada teste começa cards (a worktree avança à base, git de verdade) e roda `npm test` na mescla: na máquina cheia passa de 3 min.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });

const probe = vi.hoisted(() => ({ active: 0, max: 0, calls: 0, pause: 0 }));
vi.mock('../server/taskCode', async (original) => {
  const actual = await original<typeof import('../server/taskCode')>();
  return {
    ...actual,
    mergeCode: (async (...args: Parameters<typeof actual.mergeCode>) => {
      probe.calls++;
      probe.active++;
      probe.max = Math.max(probe.max, probe.active);
      try {
        if (probe.pause) await new Promise((r) => setTimeout(r, probe.pause));
        return await actual.mergeCode(...args);
      } finally {
        probe.active--;
      }
    }) as typeof actual.mergeCode,
  };
});

let root: string;
const homeBefore = process.env.MYCO_HOME;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-automerge-'));
  // A mescla roda `npm test` pelo runTests, que entra na fila de validação pesada da máquina (server/heavyQueue.ts): aqui, uma fila só deste arquivo.
  process.env.MYCO_HOME = path.join(root, 'myco-home');
});
afterAll(async () => {
  if (homeBefore === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = homeBefore;
  await removeTemp(root);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
const person = (id: string, name: string, worktree: boolean) => ({ id, name, role: 'Dev', autonomy: 'acceptEdits', worktree, servers: [] }) as unknown as StaffProfile;
const until = async (fn: () => Promise<unknown>, ms = 240_000) => {
  for (let i = 0; i * 50 < ms; i++) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('a condição não chegou a tempo');
};

type Policy = 'auto' | 'unchosen' | 'none';

/** Projeto git com testes que passam ou falham conforme `ok.txt`; Ana e Bia têm worktree, Rui revisa. `policy`: 'auto' = preset Automático (conclusão por IA escolhida); 'unchosen' = só o commit mexido (conclusão 'ai' herdada); 'none' = sem política gravada. */
async function proj(name: string, opts: { policy?: Policy; tests?: boolean } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Teste');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'core.autocrlf', 'false');
  if (opts.tests !== false) {
    const test = "node -e \"process.exit(require('fs').readFileSync('ok.txt','utf8').trim()==='sim'?0:1)\"";
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test } }));
    await fs.writeFile(path.join(dir, 'ok.txt'), 'sim');
  }
  await fs.writeFile(path.join(dir, 'app.txt'), 'v1\n');
  await fs.writeFile(path.join(dir, '.gitignore'), '.claude/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'início');

  const policies = new FlowPolicies(path.join(root, `${name}-flow.json`), () => {});
  const people: Record<string, StaffProfile> = { 'ana-1': person('ana-1', 'Ana', true), 'bia-1': person('bia-1', 'Bia', true), 'rev-1': person('rev-1', 'Rui', false) };
  const texts = new Map<string, string>();
  const sent: Array<{ staffId: string; session: string; text: string }> = [];
  const told: string[] = [];
  let n = 0;
  const mk = () =>
    new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async () => `s-${++n}`,
      sendTo: async (_p, session, staffId, text) => {
        sent.push({ staffId, session, text });
        return session;
      },
      branchFor: async (_d, p) => `myco/${p.id}`,
      lastText: (session) => texts.get(session) ?? null,
      notify: async (_p, _s, text) => {
        told.push(text);
      },
      flow: policies,
    });
  const svc = mk();
  if (opts.policy === 'auto') await svc.setFlowPolicy('p', { mode: 'auto' }, true);
  if (opts.policy === 'unchosen') await svc.setFlowPolicy('p', { commit: true }, true);

  const get = async (id: string) => (await readTasks(dir)).find((t) => t.id === id)!;
  const file = path.join(dir, '.myco', 'tasks.json');
  const patch = async (id: string, fields: Record<string, unknown>) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    Object.assign(all.find((t) => t.id === id)!, fields);
    await fs.writeFile(file, JSON.stringify(all));
  };
  const wts = new Map<string, string>();
  /** O funcionário faz um card na worktree dele: escreve `files` e entrega; a revisão do Rui abre sozinha. */
  const deliver = async (staffId: string, title: string, files: Record<string, string>, afterStart?: () => Promise<void>) => {
    if (!wts.has(staffId)) wts.set(staffId, (await ensureWorktree(dir, staffId)).path);
    const t = (await svc.create('p', { title, staffId, reviewerId: 'rev-1' }))!;
    await svc.start('p', t.id); // o começo do card avança a worktree ao HEAD do principal (ver `syncWorktree`)
    // A prova de "sem código" (`codeTouchedSince`) compara o mtime do arquivo com a hora do início: sem folga, o arquivo escrito poucos ms depois cai "antes" pela granularidade do relógio de arquivo no Windows.
    await sleep(1100);
    await afterStart?.(); // o que o principal faz depois disso
    const work = (await get(t.id)).sessionId!;
    for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(wts.get(staffId)!, f), text);
    await svc.onTurnDone(work);
    await until(async () => (await get(t.id)).review?.sessionId).catch(async (e: Error) => {
      const c = await get(t.id);
      throw new Error(`${e.message}: a revisão não abriu (card em ${c.status}): ${JSON.stringify(c.history.map((h) => `${h.status}: ${h.note ?? ''}`))}`);
    });
    const card = await get(t.id);
    return { id: t.id, work, review: card.review!.sessionId, sha: card.checkpoint?.sha ?? null };
  };
  /** O Rui responde APROVADO na conversa de revisão do card. */
  const approve = async (c: { review: string }, service: TaskService = svc) => {
    texts.set(c.review, 'APROVADO\n\nTudo conferido.');
    await service.onTurnDone(c.review);
  };
  const settle = async (service: TaskService = svc) => {
    await sleep(20);
    await service.mergesSettled();
  };
  const head = () => git(dir, 'rev-parse', 'HEAD');
  const merges = () => Number(git(dir, 'rev-list', '--merges', '--count', 'HEAD'));
  const clean = () => git(dir, 'status', '--porcelain', '--', '.', ':(exclude).myco');
  /** O que `tick`/aprovação fariam na hora `at` (o relógio do teste): varre as mesclas pendentes. */
  const sweep = async (at: Date) => {
    (svc as unknown as { mergeSoon(p: string, now: Date): void }).mergeSoon('p', at);
    await svc.mergesSettled();
  };
  return { dir, svc, mk, policies, texts, sent, told, get, patch, deliver, approve, settle, head, merges, clean, sweep, wts };
}

const notes = (t: Task) => t.history.map((h) => h.note ?? '');

describe('mescla automática na aprovação', () => {
  it('conclusão por IA escolhida: a aprovação mescla sozinha até o commit da entrega (sem levar o que a próxima já começou) e vai a Finalizado', async () => {
    const p = await proj('ai-escolhida', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    // A próxima tarefa dele já começou na mesma worktree, sem commit: não pode entrar.
    await fs.writeFile(path.join(p.wts.get('ana-1')!, 'meio-da-b.txt'), 'meio\n');
    const before = p.head();

    await p.approve(a);
    await p.settle();

    const done = await p.get(a.id);
    expect(done).toMatchObject({ status: 'done', merged: { branch: 'myco/ana-1', base: 'main' }, tests: { ok: true } });
    expect(done.autoMerge).toBeUndefined();
    expect(notes(done)).toContain('aprovada por Rui; a mescla automática vem a seguir');
    expect(done.history.some((h) => /^mesclado em main \(/.test(h.note ?? ''))).toBe(true);
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
    expect(existsSync(path.join(p.dir, 'meio-da-b.txt'))).toBe(false);
    expect(p.head()).not.toBe(before);
    expect(p.merges()).toBe(1);
    expect(p.clean()).toBe('');
    expect(probe.max).toBe(1);
  });

  it.each(['unchosen', 'none'] as const)('sem escolha explícita (política %s): a aprovação continua pedindo o clique e nada é mesclado', async (policy) => {
    const p = await proj(`sem-escolha-${policy}`, { policy });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    const before = p.head();
    const calls = probe.calls;
    await p.approve(a);
    await p.settle();
    const card = await p.get(a.id);
    expect(card.status).toBe('review');
    expect(card.autoMerge).toBeUndefined();
    expect(card.history.at(-1)?.note).toBe('aprovada por Rui; falta mesclar');
    expect(p.head()).toBe(before);
    expect(probe.calls).toBe(calls);
    // O clique do dono segue funcionando (a mescla do dono, com testes).
    expect(await p.svc.merge('p', a.id, false)).toMatchObject({ status: 'done', merged: { branch: 'myco/ana-1' } });
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
  });

  it('entrega sem SHA, ou com SHA que não é desta worktree: recusa e nunca mescla o branch inteiro (mergeCode, mescla do dono e mescla automática)', async () => {
    const p = await proj('sha-recusa', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    const before = p.head();
    const place = (await locateCode(p.dir, 'ana-1', true))!;
    // Um commit que existe mas não é desta worktree (de outro branch).
    git(p.dir, 'checkout', '-q', '-b', 'outro');
    await fs.writeFile(path.join(p.dir, 'outro.txt'), 'x\n');
    git(p.dir, 'add', 'outro.txt');
    git(p.dir, 'commit', '-qm', 'outro');
    const foreign = git(p.dir, 'rev-parse', 'HEAD');
    git(p.dir, 'checkout', '-q', 'main');

    for (const upTo of [undefined, null, 'f'.repeat(40), foreign]) {
      const err = await mergeCode(p.dir, place, 'x', { upTo }).catch((e: CodeError) => e);
      expect(err).toBeInstanceOf(CodeError);
      expect(err).toMatchObject({ code: 'no-delivery' });
    }
    expect(p.head()).toBe(before);
    expect(existsSync(path.join(p.dir, 'a.txt'))).toBe(false);

    // A mescla do dono (clique): o card sem commit de entrega recusa, em vez de levar o branch todo.
    await p.patch(a.id, { checkpoint: null });
    await expect(p.svc.merge('p', a.id, true, true)).rejects.toMatchObject({ code: 'no-delivery' });
    expect(p.head()).toBe(before);
    expect((await p.get(a.id)).status).toBe('review');

    // A automática: a aprovação sem SHA para na hora, vai para a caixa do dono e não toca o principal.
    await p.approve(a);
    await p.settle();
    const card = await p.get(a.id);
    expect(card).toMatchObject({ status: 'review', autoMerge: { sha: null, stopped: { detail: expect.stringMatching(/não tem commit gravado/) } } });
    const alert = ownAlerts((await p.svc.list('p'))!).find((x) => x.task.id === a.id);
    expect(alert?.state).toMatchObject({ humanAction: 'decide', selfHeals: false, reason: expect.stringMatching(/mescla automática parou/) });
    expect(p.head()).toBe(before);
    expect(existsSync(path.join(p.dir, 'a.txt'))).toBe(false);
  });

  it('SHA da entrega que não é desta worktree na aprovação automática: para, sem mesclar', async () => {
    const p = await proj('sha-estranho', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    const before = p.head();
    await p.patch(a.id, { checkpoint: { sha: 'f'.repeat(40), at: new Date().toISOString() } });
    await p.approve(a);
    await p.settle();
    expect(await p.get(a.id)).toMatchObject({ status: 'review', autoMerge: { stopped: { detail: expect.stringMatching(/não é desta worktree/) } } });
    expect(p.head()).toBe(before);
    expect(existsSync(path.join(p.dir, 'a.txt'))).toBe(false);
  });

  it('commit de card ainda aberto no meio: não mescla, espera com nota (sem contar tentativa) e mescla depois que o anterior é aprovado', async () => {
    const p = await proj('card-aberto', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    const b = await p.deliver('ana-1', 'Tarefa B', { 'b.txt': 'do B\n' });
    const before = p.head();

    // A B é aprovada primeiro, e o commit da A (ainda em revisão) está no caminho dela.
    await p.approve(b);
    await p.settle();
    let card = await p.get(b.id);
    expect(card).toMatchObject({ status: 'review', autoMerge: { wait: { why: 'open-card' } } });
    expect(card.autoMerge?.retry).toBeUndefined();
    expect(card.history.at(-1)?.note).toMatch(new RegExp(`mescla automática em espera: espera o card ainda não aprovado.*${a.id}`));
    expect(p.head()).toBe(before);
    expect(existsSync(path.join(p.dir, 'b.txt'))).toBe(false);

    // Conferir de novo (o tick) não repete a nota nem gasta tentativa.
    await p.sweep(new Date(Date.now() + 3_600_000));
    card = await p.get(b.id);
    expect(card.history.filter((h) => /em espera/.test(h.note ?? ''))).toHaveLength(1);
    expect(card.autoMerge?.retry).toBeUndefined();
    expect(p.head()).toBe(before);

    // A A é aprovada: as duas entram e vão a Finalizado.
    await p.approve(a);
    await p.settle();
    await until(async () => (await p.get(a.id)).status === 'done' && (await p.get(b.id)).status === 'done');
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
    expect(await fs.readFile(path.join(p.dir, 'b.txt'), 'utf8')).toBe('do B\n');
    expect(p.clean()).toBe('');
  });

  it('o card do meio do caminho foi cancelado: fail closed, a mescla para para o dono decidir (esperar não resolveria)', async () => {
    const p = await proj('card-cancelado', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    const b = await p.deliver('ana-1', 'Tarefa B', { 'b.txt': 'do B\n' });
    await p.patch(a.id, { status: 'cancelled' });
    const before = p.head();
    await p.approve(b);
    await p.settle();
    expect(await p.get(b.id)).toMatchObject({ status: 'review', autoMerge: { stopped: { detail: expect.stringMatching(/card cancelado.*cancelada/) } } });
    expect(p.head()).toBe(before);
  });

  it('conflito: merge --abort, o principal fica limpo e o card volta ao responsável com os arquivos em conflito', async () => {
    const p = await proj('conflito', { policy: 'auto' });
    // O principal anda DEPOIS de o card começar (o começo já avançou a worktree à base de então): os dois mudam app.txt a partir da mesma base.
    const a = await p.deliver('ana-1', 'Tarefa A', { 'app.txt': 'a worktree mudou\n' }, async () => {
      await fs.writeFile(path.join(p.dir, 'app.txt'), 'principal mudou\n');
      git(p.dir, 'commit', '-qam', 'o principal andou');
    });
    const before = p.head();

    await p.approve(a);
    await p.settle();

    const card = await p.get(a.id);
    expect(card.status).toBe('doing');
    expect(card.autoMerge).toBeUndefined();
    expect(notes(card).at(-1)).toMatch(/^mescla automática falhou: conflito com o principal em app\.txt; devolvida ao responsável/);
    const msg = p.sent.find((s) => s.session === a.work && /conflito/.test(s.text));
    expect(msg?.text).toContain('app.txt');
    expect(p.head()).toBe(before);
    expect(p.clean()).toBe('');
    expect(existsSync(path.join(p.dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(await fs.readFile(path.join(p.dir, 'app.txt'), 'utf8')).toBe('principal mudou\n');
  });

  it('teste vermelho: a mescla é desfeita e o card volta ao responsável com a saída', async () => {
    const p = await proj('vermelho', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'ok.txt': 'nao' });
    const before = p.head();

    await p.approve(a);
    await p.settle();

    const card = await p.get(a.id);
    expect(card).toMatchObject({ status: 'doing', tests: { ok: false } });
    expect(card.autoMerge).toBeUndefined();
    expect(notes(card).at(-1)).toMatch(/^mescla automática falhou: os testes ficaram vermelhos com a mescla; devolvida ao responsável/);
    expect(p.sent.some((s) => s.session === a.work && /testes ficaram vermelhos/.test(s.text))).toBe(true);
    expect(p.head()).toBe(before);
    expect(p.clean()).toBe('');
    expect(await fs.readFile(path.join(p.dir, 'ok.txt'), 'utf8')).toBe('sim');
  });

  it('principal sujo: espera com nota e tenta de novo com backoff; no teto de tentativas para e vira item na caixa, sem laço', async () => {
    const p = await proj('sujo', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    await fs.writeFile(path.join(p.dir, 'sujo.txt'), 'alguém mexeu\n');
    const before = p.head();
    const t0 = Date.now();

    await p.approve(a);
    await p.settle();
    let card = await p.get(a.id);
    expect(card).toMatchObject({ status: 'review', autoMerge: { wait: { why: 'main-dirty' }, retry: { attempts: 1 } } });
    expect(notes(card).at(-1)).toMatch(/^mescla automática em espera \(nova tentativa em instantes\): .*1 arquivo alterado sem commit/);
    expect(await p.svc.list('p').then((l) => ownAlerts(l!))).toEqual([]);

    // Antes da hora marcada, a varredura não tenta.
    const calls = probe.calls;
    await p.sweep(new Date(t0 + 10_000));
    expect(probe.calls).toBe(calls);

    // Cada vencimento, uma tentativa; a quinta falha para.
    for (let i = 1; i <= 4; i++) await p.sweep(new Date(t0 + i * 30 * 60_000));
    card = await p.get(a.id);
    expect(probe.calls).toBe(calls + 4);
    expect(card.autoMerge).toMatchObject({ retry: { attempts: 5 }, stopped: { detail: expect.stringMatching(/desisti depois de 5 tentativas/) } });
    expect(card.autoMerge?.wait).toBeUndefined();
    const alert = ownAlerts((await p.svc.list('p'))!).find((x) => x.task.id === a.id);
    expect(alert?.state).toMatchObject({ humanAction: 'decide', selfHeals: false });

    // Parou: nada mais tenta, nem com o principal já limpo.
    await fs.rm(path.join(p.dir, 'sujo.txt'));
    await p.sweep(new Date(t0 + 10 * 3_600_000));
    expect(probe.calls).toBe(calls + 4);
    expect(p.head()).toBe(before);
    expect((await p.get(a.id)).status).toBe('review');

    // O clique do dono segue valendo (com testes, sem pular).
    expect((await p.svc.merge('p', a.id, false, true))?.status).toBe('done');
    expect((await p.get(a.id)).autoMerge).toBeUndefined();
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
  });

  it('projeto sem testes: a mescla automática nunca pula os testes, para na hora e o dono decide', async () => {
    const p = await proj('sem-testes', { policy: 'auto', tests: false });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    const before = p.head();
    await p.approve(a);
    await p.settle();
    expect(await p.get(a.id)).toMatchObject({ status: 'review', autoMerge: { stopped: { detail: expect.stringMatching(/nunca os pula/) } } });
    expect(p.head()).toBe(before);
  });

  it('a aprovação vale para a mesma entrega: entrega nova invalida a marca e nada é mesclado', async () => {
    const p = await proj('entrega-nova', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    await fs.writeFile(path.join(p.dir, 'sujo.txt'), 'x\n'); // segura a mescla na espera
    await p.approve(a);
    await p.settle();
    expect((await p.get(a.id)).autoMerge).toBeDefined();
    const before = p.head();

    // A entrega mudou desde a aprovação (outro `delivery.at`): a marca é descartada, mesmo com o principal limpo depois.
    await p.patch(a.id, { delivery: { at: new Date().toISOString(), summary: 'entrega nova' } });
    await fs.rm(path.join(p.dir, 'sujo.txt'));
    await p.sweep(new Date(Date.now() + 3_600_000));
    const card = await p.get(a.id);
    expect(card.status).toBe('review');
    expect(card.autoMerge).toBeUndefined();
    expect(notes(card).at(-1)).toBe('mescla automática descartada: a entrega mudou desde a aprovação');
    expect(p.head()).toBe(before);

    // Sair de "revisão" também a desfaz.
    const b = await p.deliver('ana-1', 'Tarefa B', { 'b.txt': 'do B\n' });
    await fs.writeFile(path.join(p.dir, 'sujo.txt'), 'x\n');
    await p.approve(b);
    await p.settle();
    expect((await p.get(b.id)).autoMerge).toBeDefined();
    expect((await p.svc.update('p', b.id, { status: 'doing' }))?.status).toBe('doing');
    expect((await p.get(b.id)).autoMerge).toBeUndefined();
  });

  it('duas aprovações ao mesmo tempo: mesclam uma por vez (uma escrita no principal por vez)', async () => {
    const p = await proj('simultaneas', { policy: 'auto' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    const b = await p.deliver('bia-1', 'Tarefa B', { 'b.txt': 'do B\n' });
    probe.pause = 400; // sem a fila, as duas estariam dentro do mergeCode juntas
    probe.max = 0;
    try {
      await Promise.all([p.approve(a), p.approve(b)]);
      await p.settle();
      await until(async () => (await p.get(a.id)).status === 'done' && (await p.get(b.id)).status === 'done');
    } finally {
      probe.pause = 0;
    }
    expect(probe.max).toBe(1);
    expect(p.merges()).toBe(2);
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
    expect(await fs.readFile(path.join(p.dir, 'b.txt'), 'utf8')).toBe('do B\n');
    expect(p.clean()).toBe('');
  });

  it('reinício depois de commitar a mescla e antes de gravar o card: só finaliza, não mescla de novo', async () => {
    const p = await proj('reinicio-commitou', { policy: 'unchosen' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    await p.approve(a);
    await p.settle();
    const approved = await p.get(a.id);
    expect(approved.status).toBe('review');
    // O processo mesclou e caiu antes de gravar: a mescla está no principal, o card segue em revisão com a marca e o marcador de "mesclando".
    git(p.dir, 'merge', '--no-ff', '-q', '-m', 'Merge myco/ana-1: Tarefa A', a.sha!);
    await p.patch(a.id, { autoMerge: { verdict: { sessionId: approved.review!.sessionId, deliveryAt: approved.delivery!.at }, sha: a.sha, by: 'Rui', since: new Date().toISOString(), merging: new Date().toISOString() } });
    await p.svc.setFlowPolicy('p', { mode: 'auto' }, true);
    const merged = p.head();
    const calls = probe.calls;

    const restarted = p.mk();
    await restarted.tick(new Date());
    await restarted.mergesSettled();
    await until(async () => (await p.get(a.id)).status === 'done');

    expect(await p.get(a.id)).toMatchObject({ status: 'done', merged: { base: 'main', branch: 'myco/ana-1' } });
    expect((await p.get(a.id)).autoMerge).toBeUndefined();
    expect(p.head()).toBe(merged);
    expect(p.merges()).toBe(1);
    expect(probe.calls).toBe(calls);
    // Outro tick não faz nada de novo.
    await restarted.tick(new Date());
    await restarted.mergesSettled();
    expect(p.merges()).toBe(1);
  });

  it('reinício no meio da mescla (merge --no-commit e testes): o resto é desfeito e a mescla acontece uma vez só', async () => {
    const p = await proj('reinicio-meio', { policy: 'unchosen' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    await p.approve(a);
    await p.settle();
    const approved = await p.get(a.id);
    const before = p.head();
    // O Club caiu com o principal no meio da mescla: MERGE_HEAD aponta para o commit da entrega, e o card tem o marcador.
    git(p.dir, 'merge', '--no-ff', '--no-commit', a.sha!);
    expect(existsSync(path.join(p.dir, '.git', 'MERGE_HEAD'))).toBe(true);
    await p.patch(a.id, { autoMerge: { verdict: { sessionId: approved.review!.sessionId, deliveryAt: approved.delivery!.at }, sha: a.sha, by: 'Rui', since: new Date().toISOString(), merging: new Date().toISOString() } });
    await p.svc.setFlowPolicy('p', { mode: 'auto' }, true);
    const calls = probe.calls;

    const restarted = p.mk();
    await restarted.tick(new Date());
    await restarted.mergesSettled();
    await until(async () => (await p.get(a.id)).status === 'done');

    expect(existsSync(path.join(p.dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(p.merges()).toBe(1);
    expect(p.head()).not.toBe(before);
    expect(probe.calls).toBe(calls + 1);
    expect(p.clean()).toBe('');
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
  });

  it('uma mescla em andamento do dono (MERGE_HEAD de outro commit) não é desfeita pelo reinício', async () => {
    const p = await proj('merge-alheio', { policy: 'unchosen' });
    const a = await p.deliver('ana-1', 'Tarefa A', { 'a.txt': 'do A\n' });
    // Outro commit do mesmo branch, que não é o da entrega: o dono mescla à mão.
    await fs.writeFile(path.join(p.wts.get('ana-1')!, 'x.txt'), 'x\n');
    git(p.wts.get('ana-1')!, 'add', 'x.txt');
    git(p.wts.get('ana-1')!, 'commit', '-qm', 'x');
    const other = git(p.wts.get('ana-1')!, 'rev-parse', 'HEAD');
    git(p.dir, 'merge', '--no-ff', '--no-commit', other);
    const { abortStaleMerge } = await import('../server/taskCode');
    expect(await abortStaleMerge(p.dir, a.sha!)).toBe(false);
    expect(existsSync(path.join(p.dir, '.git', 'MERGE_HEAD'))).toBe(true);
    git(p.dir, 'merge', '--abort');
  });
});
