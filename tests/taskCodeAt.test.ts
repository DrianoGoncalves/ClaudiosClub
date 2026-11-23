import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { ensureWorktree } from '../server/staff/worktree';
import { TaskService } from '../server/tasks';
import type { SyncWorktree } from '../server/worktreeBase';
import { removeTemp } from './support/tmp';

// Onde o código do card é escrito, gravado ao começar (`Task.codeAt`), e a base da worktree nesse começo. Git e worktree de verdade; só as conversas são falsas.
vi.setConfig({ testTimeout: 30_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codeat-'));
});
afterAll(() => removeTemp(root));

/** Projeto git com um commit; Ana faz o card, Rui revisa. `people.ana.worktree` pode mudar no meio do teste (a ficha ganha ou perde a worktree). */
async function flow(name: string, opts: { worktree: boolean; sync?: SyncWorktree }) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Teste');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(dir, 'app.txt'), 'v1\n');
  await fs.writeFile(path.join(dir, '.gitignore'), '.claude/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'início');
  const sent: Array<{ staffId: string; text: string; session: string }> = [];
  const texts = new Map<string, string>();
  let n = 0;
  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: opts.worktree, servers: [] } as unknown as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', autonomy: 'manual', worktree: false, servers: [] } as unknown as StaffProfile,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text) => {
      const session = `s-${++n}`;
      sent.push({ staffId, text, session });
      return session;
    },
    branchFor: async (_d, p) => (p.worktree ? `myco/${p.id}` : 'main'),
    lastText: (sessionId) => texts.get(sessionId) ?? null,
    sendTo: async (_p, sessionId) => sessionId,
    ...(opts.sync && { syncWorktree: opts.sync }),
  });
  const make = async (title = 'Filtro de datas') => (await svc.create('p', { title, staffId: 'ana-1', reviewerId: 'rev-1' }))!;
  const card = async () => (await svc.list('p'))![0]!;
  /** O card mexeu em código em where (sem isso a entrega seria sem código, ver holdNoCode); entrega, o Rui revisa (s-2) e aprova. */
  const approve = async (where: string) => {
    await fs.writeFile(path.join(where, 'feito-pelo-card.txt'), 'mudança do card\n');
    await svc.onTurnDone('s-1');
    // O pedido de revisão sai fora da vez do funcionário: espera a conversa do Rui (s-2) estar gravada no card antes de ele responder.
    for (let i = 0; i < 400 && (await card()).review?.sessionId !== 's-2'; i++) await new Promise((r) => setTimeout(r, 25));
    texts.set('s-2', 'APROVADO\n\nok');
    await svc.onTurnDone('s-2');
  };
  return { dir, git, svc, people, sent, make, card, approve };
}

describe('onde o código do card é escrito', () => {
  it('card feito no principal e worktree criada DEPOIS (para outro card): aprovado vai a Finalizado, sem "falta mesclar"', async () => {
    const f = await flow('principal-depois', { worktree: false });
    const t = await f.make();
    await f.svc.start('p', t.id); // a ficha ainda não pedia worktree: a conversa abre no checkout principal
    expect(await f.card()).toMatchObject({ status: 'doing', branch: 'main', codeAt: { where: 'project', branch: 'main' } });

    f.people['ana-1']!.worktree = true; // a ficha passa a pedir worktree e ela é criada (para outro card)
    await ensureWorktree(f.dir, 'ana-1');
    await f.approve(f.dir); // o código do card está no principal

    const done = await f.card();
    expect(done).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(done.history.at(-1)).toMatchObject({ status: 'done', by: 'auto', note: 'aprovada por Rui' });
    expect(done.history.some((h) => /falta mesclar/.test(h.note ?? ''))).toBe(false);
    // Mesclar a worktree dele não é o caminho deste card: a leitura do código aponta o principal, e a mescla não é oferecida.
    expect(await f.svc.code('p', t.id)).toMatchObject({ where: 'project', path: f.dir, canMerge: false });
  });

  it('o mesmo card SEM o campo (feito antes dele existir) segue a worktree atual do funcionário: fica em revisão, "falta mesclar"', async () => {
    const f = await flow('legado', { worktree: false });
    const t = await f.make();
    await f.svc.start('p', t.id);
    f.people['ana-1']!.worktree = true;
    const wt = await ensureWorktree(f.dir, 'ana-1');
    const file = path.join(f.dir, '.myco', 'tasks.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    for (const x of raw) delete x.codeAt;
    await fs.writeFile(file, JSON.stringify(raw));

    await f.approve(wt.path); // sem o campo, o código vai ser procurado na worktree de agora
    const stuck = await f.card();
    expect(stuck.status).toBe('review');
    expect(stuck.history.at(-1)?.note).toBe('aprovada por Rui; falta mesclar');
  });

  it('card feito na worktree continua pedindo a mescla; mesclar leva o trabalho dele e vai a Finalizado', async () => {
    const f = await flow('worktree-merge', { worktree: true });
    const wt = await ensureWorktree(f.dir, 'ana-1');
    const t = await f.make();
    await f.svc.start('p', t.id);
    expect(await f.card()).toMatchObject({ codeAt: { where: 'worktree', branch: 'myco/ana-1' } });
    await fs.writeFile(path.join(wt.path, 'feito.txt'), 'trabalho do card\n');

    await f.approve(wt.path);
    const waiting = await f.card();
    expect(waiting.status).toBe('review');
    expect(waiting.history.at(-1)?.note).toBe('aprovada por Rui; falta mesclar');

    const merged = (await f.svc.merge('p', t.id, true))!;
    expect(merged).toMatchObject({ status: 'done', merged: { branch: 'myco/ana-1', base: 'main' } });
    expect(await fs.readFile(path.join(f.dir, 'feito.txt'), 'utf8')).toBe('trabalho do card\n');
  });

  it('a ficha deixa de pedir worktree depois que o card começou nela: o código do card continua na worktree e a mescla continua sendo pedida', async () => {
    const f = await flow('worktree-ficha-mudou', { worktree: true });
    const wt = await ensureWorktree(f.dir, 'ana-1');
    const t = await f.make();
    await f.svc.start('p', t.id);
    f.people['ana-1']!.worktree = false;

    await f.approve(wt.path);
    const waiting = await f.card();
    expect(waiting).toMatchObject({ status: 'review', codeAt: { where: 'worktree' } });
    expect(waiting.history.at(-1)?.note).toBe('aprovada por Rui; falta mesclar');
  });

  it('ficha sem worktree e projeto git: o card grava `project` com o branch atual; fora de um repositório, nada é gravado e a aprovação segue como sempre', async () => {
    const f = await flow('sem-worktree', { worktree: false });
    const t = await f.make();
    await f.svc.start('p', t.id);
    expect((await f.card()).codeAt).toEqual({ where: 'project', branch: 'main' });
    await f.approve(f.dir);
    expect((await f.card()).status).toBe('done');

    const plain = await flow('sem-git', { worktree: false });
    await fs.rm(path.join(plain.dir, '.git'), { recursive: true, force: true });
    const p = await plain.make();
    await plain.svc.start('p', p.id);
    expect((await plain.card()).codeAt).toBeUndefined();
    await plain.approve(plain.dir);
    expect((await plain.card()).status).toBe('done');
  });
});

describe('base da worktree ao começar o card', () => {
  it('worktree atrás do principal e limpa: avança antes de abrir a conversa, e o card ganha a nota', async () => {
    const f = await flow('base-avanca', { worktree: true });
    const wt = await ensureWorktree(f.dir, 'ana-1');
    await fs.writeFile(path.join(f.dir, 'do-outro-card.txt'), 'aprovado e commitado\n');
    f.git(f.dir, 'add', '.');
    f.git(f.dir, 'commit', '-qm', 'trabalho do outro card');
    const mainHead = f.git(f.dir, 'rev-parse', 'HEAD');

    const t = await f.make();
    await f.svc.start('p', t.id);
    expect(f.git(wt.path, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(await fs.readFile(path.join(wt.path, 'do-outro-card.txt'), 'utf8')).toBe('aprovado e commitado\n');
    const card = await f.card();
    expect(card.status).toBe('doing');
    expect(card.history.some((h) => h.note?.startsWith('worktree avançada para o HEAD do principal'))).toBe(true);
    expect(f.sent[0]!.text).not.toContain('Aviso da base');
  });

  it('principal com mudança não commitada em arquivo rastreado: nota no card e aviso na conversa, com os arquivos; o início não é bloqueado', async () => {
    const f = await flow('base-suja', { worktree: true });
    const wt = await ensureWorktree(f.dir, 'ana-1');
    await fs.writeFile(path.join(f.dir, 'app.txt'), 'v-aprovado-sem-commit\n');

    const t = await f.make();
    await f.svc.start('p', t.id);
    const card = await f.card();
    expect(card.status).toBe('doing');
    expect(card.sessionId).toBe('s-1');
    const note = card.history.find((h) => /não inclui mudança não commitada do principal/.test(h.note ?? ''));
    expect(note?.note).toBe('a base não inclui mudança não commitada do principal em 1 arquivo: `app.txt`');
    const sent = f.sent[0]!.text;
    expect(sent).toContain('Aviso da base');
    expect(sent).toContain('`app.txt`');
    expect(sent).toContain('NÃO a inclui');
    // A worktree não herdou a mudança (ela é do principal) e segue com o arquivo velho.
    expect(await fs.readFile(path.join(wt.path, 'app.txt'), 'utf8')).toBe('v1\n');
    // O aviso vem depois da descrição do card e antes das regras, na mesma mensagem de partida.
    expect(sent.indexOf('[Tarefa "Filtro de datas"]')).toBeLessThan(sent.indexOf('Aviso da base'));
  });

  it('worktree que não pôde avançar (mudança dela por commitar): a nota e o aviso dizem que ela segue na base antiga', async () => {
    const f = await flow('base-mantida', { worktree: true });
    const wt = await ensureWorktree(f.dir, 'ana-1');
    await fs.writeFile(path.join(wt.path, 'rascunho.txt'), 'meu rascunho\n');
    await fs.writeFile(path.join(f.dir, 'novo.txt'), 'x\n');
    f.git(f.dir, 'add', '.');
    f.git(f.dir, 'commit', '-qm', 'avança o principal');

    const t = await f.make();
    await f.svc.start('p', t.id);
    const card = await f.card();
    expect(card.history.some((h) => /worktree fica na base antiga.*tem mudança não commitada/.test(h.note ?? ''))).toBe(true);
    expect(f.sent[0]!.text).toContain('Sua worktree não avançou para o HEAD do principal');
  });

  it('a leitura da base que falha não bloqueia o início: o card começa, sem nota e sem aviso', async () => {
    const sync = vi.fn<SyncWorktree>(async () => {
      throw new Error('git sumiu');
    });
    const f = await flow('base-erro', { worktree: true, sync });
    await ensureWorktree(f.dir, 'ana-1');
    const t = await f.make();
    await f.svc.start('p', t.id);
    expect(sync).toHaveBeenCalledTimes(1);
    const card = await f.card();
    expect(card).toMatchObject({ status: 'doing', sessionId: 's-1', codeAt: { where: 'worktree' } });
    expect(card.history.some((h) => /worktree|base/.test(h.note ?? ''))).toBe(false);
    expect(f.sent[0]!.text).not.toContain('Aviso da base');
  });

  it('ficha sem worktree: a base nem é consultada', async () => {
    const sync = vi.fn<SyncWorktree>(async () => ({ sync: { state: 'none' }, mainDirty: [] }));
    const f = await flow('base-sem-worktree', { worktree: false, sync });
    const t = await f.make();
    await f.svc.start('p', t.id);
    expect(sync).not.toHaveBeenCalled();
    expect((await f.card()).status).toBe('doing');
  });
});
