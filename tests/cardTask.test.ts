import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cardWorktreeFor, MIN_FREE_BYTES, rescueRefFor } from '../server/cardWorktree';
import { FlowPolicies } from '../server/flowPolicy';
import { CodeError } from '../server/taskCode';
import { TaskConflictError, TaskForbiddenError, TaskService, readTasks } from '../server/tasks';
import type { StaffProfile, Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// t-250de1 (etapa 1): o card começa numa worktree só dele (padrão LIGADO), a conversa abre nela, o que não dá cai no principal COM o motivo, cancelar e juntar apagam a pasta e o branch, e
// "pronto" nunca sai com o código fora do principal. Git e `npm test` de verdade; só as conversas são falsas.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 });
// O padrão da bateria dos outros assuntos é "sem worktree por card" (tests/support/cardOff.ts); aqui vale o de produção: projeto sem configuração = LIGADO.
delete process.env.MYCO_CARD_WORKTREE_DEFAULT;

let root: string;
const homeBefore = process.env.MYCO_HOME;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cardtask-'));
  process.env.MYCO_HOME = path.join(root, 'myco-home');
});
afterAll(async () => {
  if (homeBefore === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = homeBefore;
  await removeTemp(root);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
const person = (id: string, name: string, worktree = false) => ({ id, name, role: 'Dev', autonomy: 'acceptEdits', worktree, servers: [] }) as unknown as StaffProfile;
const until = async (fn: () => Promise<unknown>, ms = 240_000) => {
  for (let i = 0; i * 50 < ms; i++) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('a condição não chegou a tempo');
};

interface Sent {
  staffId: string;
  text: string;
  place?: { path: string; branch: string };
}

/** Projeto git com testes que passam ou falham conforme `ok.txt` (ou sem git, se `git: false`). Ana e Bia, com ou sem worktree própria na ficha, Rui revisa. */
async function proj(name: string, opts: { git?: boolean; ownWorktree?: boolean; free?: () => Promise<number | null> } = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const test = "node -e \"process.exit(require('fs').readFileSync('ok.txt','utf8').trim()==='sim'?0:1)\"";
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test } }));
  await fs.writeFile(path.join(dir, 'ok.txt'), 'sim');
  await fs.writeFile(path.join(dir, 'app.txt'), 'v1\n');
  await fs.writeFile(path.join(dir, '.gitignore'), '.claude/\n');
  if (opts.git !== false) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Teste');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'início');
  }
  const own = opts.ownWorktree ?? false;
  const people: Record<string, StaffProfile> = { 'ana-1': person('ana-1', 'Ana', own), 'bia-1': person('bia-1', 'Bia', own), 'rev-1': person('rev-1', 'Rui') };
  const policies = new FlowPolicies(path.join(root, `${name}-flow.json`), () => {});
  const sent: Sent[] = [];
  let n = 0;
  const mk = () =>
    new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text, _force, _override, _reviewOnly, place) => {
        sent.push({ staffId, text, ...(place && { place }) });
        return `s-${++n}`;
      },
      sendTo: async (_p, session) => session,
      branchFor: async (_d, p) => `myco/${p.id}`,
      lastText: () => null,
      notify: async () => {},
      flow: policies,
      ...(opts.free && { cardFree: opts.free }),
    });
  const svc = mk();
  const get = async (id: string) => (await readTasks(dir)).find((t) => t.id === id)!;
  const patch = async (id: string, fields: Record<string, unknown>) => {
    const file = path.join(dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    Object.assign(all.find((t) => t.id === id)!, fields);
    await fs.writeFile(file, JSON.stringify(all));
  };
  const start = async (staffId: string, title: string) => {
    const t = (await svc.create('p', { title, staffId, reviewerId: 'rev-1' }))!;
    await svc.start('p', t.id);
    return get(t.id);
  };
  const notes = (t: Task) => t.history.map((h) => h.note ?? '');
  return { dir, svc, mk, sent, get, patch, start, notes };
}

describe('começar o card: padrão LIGADO', () => {
  it('projeto sem configuração: o card ganha a worktree dele, a conversa abre nela e o card grava onde está', async () => {
    const p = await proj('padrao');
    const t = await p.start('ana-1', 'Primeira');
    const wt = cardWorktreeFor(p.dir, t.id);
    expect(existsSync(path.join(wt.path, '.git'))).toBe(true);
    expect(t.codeAt).toMatchObject({ where: 'worktree', card: true, path: wt.path, branch: wt.branch });
    expect(t.codeAt?.base).toBe(git(p.dir, 'rev-parse', 'HEAD'));
    expect(t.branch).toBe(wt.branch);
    // A conversa NOVA abriu nessa pasta (o 7º argumento de `send`), e o texto de partida diz onde trabalhar e a porta.
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.place).toEqual({ path: wt.path, branch: wt.branch });
    expect(p.sent[0]!.text).toContain(wt.path);
    expect(p.sent[0]!.text).toMatch(/use a porta 43\d\d\d /);
    expect(t.codeAt?.port).toBeGreaterThanOrEqual(43000);
    expect(p.notes(t).some((x) => x.startsWith('worktree do card em .claude/worktrees/myco-card-'))).toBe(true);
    // O card não ocupa a pasta do principal: nada sujo lá.
    expect(git(p.dir, 'status', '--porcelain', '--', '.', ':(exclude).myco')).toBe('');
  });

  it('dois cards do mesmo funcionário, uma pasta para cada, com portas diferentes', async () => {
    const p = await proj('dois-cards');
    const a = await p.start('ana-1', 'A');
    const b = await p.start('bia-1', 'B');
    expect(a.codeAt?.path).not.toBe(b.codeAt?.path);
    expect(a.codeAt?.port).not.toBe(b.codeAt?.port);
  });

  it('a worktree própria da ficha não é criada para o card (o card usa a dele)', async () => {
    const p = await proj('ficha-com-worktree', { ownWorktree: true });
    const t = await p.start('ana-1', 'Com worktree na ficha');
    expect(t.codeAt?.card).toBe(true);
    expect(existsSync(path.join(p.dir, '.claude', 'worktrees', 'myco-ana-1'))).toBe(false);
  });
});

describe('a opção do projeto', () => {
  it('lê ligada por padrão; só a tela grava (403 para a API), e o corpo é conferido', async () => {
    const p = await proj('opcao');
    expect(await p.svc.boardCardWorktree('p')).toEqual({ cardWorktree: true });
    await expect(p.svc.setBoardCardWorktree('p', { cardWorktree: false }, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(p.svc.setBoardCardWorktree('p', { cardWorktree: 'sim' }, true)).rejects.toThrow();
    await expect(p.svc.setBoardCardWorktree('p', { cardWorktree: false, extra: 1 }, true)).rejects.toThrow();
    expect(await p.svc.boardCardWorktree('p')).toEqual({ cardWorktree: true });
  });

  it('desligada: o card edita no principal, como antes, sem pasta de card e sem motivo (foi escolha do dono)', async () => {
    const p = await proj('desligada');
    expect(await p.svc.setBoardCardWorktree('p', { cardWorktree: false }, true)).toEqual({ cardWorktree: false });
    expect(JSON.parse(await fs.readFile(path.join(p.dir, '.myco', 'board.json'), 'utf8'))).toMatchObject({ cardWorktree: false });
    const t = await p.start('ana-1', 'No principal');
    expect(p.sent[0]!.place).toBeUndefined();
    expect(t.codeAt).toMatchObject({ where: 'project' });
    expect(t.codeAt?.card).toBeUndefined();
    expect(t.codeAt?.why).toBeUndefined();
    expect(existsSync(path.join(p.dir, '.claude', 'worktrees'))).toBe(false);
  });

  it('religada: o card seguinte volta a ganhar a worktree', async () => {
    const p = await proj('religada');
    await p.svc.setBoardCardWorktree('p', { cardWorktree: false }, true);
    await p.svc.setBoardCardWorktree('p', { cardWorktree: true }, true);
    expect((await p.start('ana-1', 'Volta')).codeAt?.card).toBe(true);
  });
});

describe('quando a worktree não dá: edita no principal e MOSTRA o motivo', () => {
  it('projeto que não é repositório git', async () => {
    const p = await proj('sem-git', { git: false });
    const t = await p.start('ana-1', 'Sem git');
    expect(p.sent[0]!.place).toBeUndefined();
    expect(t.codeAt).toMatchObject({ where: 'project', why: 'o projeto não é um repositório git' });
    expect(p.notes(t)).toContain('worktree do card não usada: o projeto não é um repositório git; o card edita no checkout principal');
    expect(p.sent[0]!.text).toContain('este card não ganhou uma worktree própria (o projeto não é um repositório git)');
  });

  it('repositório sem commit inicial', async () => {
    const p = await proj('sem-commit', { git: false });
    git(p.dir, 'init', '-q', '-b', 'main');
    const t = await p.start('ana-1', 'Sem commit');
    expect(t.codeAt?.why).toBe('o repositório ainda não tem nenhum commit');
  });

  it('pouco espaço em disco', async () => {
    const p = await proj('sem-disco', { free: async () => MIN_FREE_BYTES - 1 });
    const t = await p.start('ana-1', 'Sem disco');
    expect(t.codeAt?.why).toMatch(/pouco espaço em disco/);
    expect(p.sent[0]!.place).toBeUndefined();
    expect(existsSync(path.join(p.dir, '.claude', 'worktrees'))).toBe(false);
  });

  it('o card que já começou fora de worktree de card não muda de lugar no meio do trabalho', async () => {
    const p = await proj('legado');
    const t = await p.start('ana-1', 'Já começou');
    // Marca como se tivesse começado no principal (antes desta função existir) e começa de novo (conversa nova).
    await p.patch(t.id, { codeAt: { where: 'project', branch: 'main' }, sessionId: null, status: 'todo' });
    await p.svc.start('p', t.id);
    const again = await p.get(t.id);
    expect(again.codeAt?.card).toBeUndefined();
    expect(p.sent.at(-1)!.place).toBeUndefined();
  });
});

describe('a vaga de escrita não se aplica ao card com worktree', () => {
  it('singleWriter ligado + card com worktree: dois cards de pessoas diferentes começam juntos', async () => {
    const p = await proj('vaga');
    await p.svc.setBoardWriter('p', { singleWriter: true }, true);
    const a = await p.start('ana-1', 'A');
    const b = await p.start('bia-1', 'B');
    expect(a.status).toBe('doing');
    expect(b.status).toBe('doing');
    expect(b.resourceWait).toBeFalsy();
  });

  it('singleWriter ligado + opção desligada: a vaga segue valendo (o segundo espera)', async () => {
    const p = await proj('vaga-sem-card');
    await p.svc.setBoardWriter('p', { singleWriter: true }, true);
    await p.svc.setBoardCardWorktree('p', { cardWorktree: false }, true);
    const a = await p.start('ana-1', 'A');
    await p.patch(a.id, { changedFiles: ['app.txt'] });
    const b = await p.start('bia-1', 'B');
    expect(b.status).toBe('todo');
    expect(b.resourceWait?.reason).toMatch(/vaga de escrita/);
  });
});

describe('cancelar', () => {
  it('a pasta e o branch somem, e o que havia (commitado ou não) fica em refs/myco/cancelled/<id>', async () => {
    const p = await proj('cancelado');
    const t = await p.start('ana-1', 'Vai cancelar');
    const wt = cardWorktreeFor(p.dir, t.id);
    await fs.writeFile(path.join(wt.path, 'meio.txt'), 'sem commit\n');
    await p.svc.cancel('p', t.id, { by: 'user', reason: 'desistiu' });
    await until(async () => !existsSync(wt.path));
    expect(git(p.dir, 'branch', '--list', wt.branch)).toBe('');
    expect(git(p.dir, 'show', `${rescueRefFor(t.id)}:meio.txt`)).toBe('sem commit');
    expect((await p.get(t.id)).status).toBe('cancelled');
    expect((await p.get(t.id)).codeAt?.cleanup).toBeUndefined();
  });
});

describe('"pronto" nunca sai com o código fora do principal', () => {
  /** O card escreve `files` na worktree dele e entrega (o checkpoint commita): fica em Revisão com o commit da entrega. */
  const deliver = async (p: Awaited<ReturnType<typeof proj>>, staffId: string, title: string, files: Record<string, string>) => {
    const t = await p.start(staffId, title);
    await sleep(1100); // a prova de "sem código" compara o mtime com a hora do início
    for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(t.codeAt!.path!, f), text);
    await p.svc.onTurnDone(t.sessionId!);
    await until(async () => (await p.get(t.id)).checkpoint);
    return p.get(t.id);
  };

  it('o dono aprova (coluna "pronto"): o código é juntado, o card vai a Finalizado e a worktree e o branch saem', async () => {
    const p = await proj('aprovar');
    const t = await deliver(p, 'ana-1', 'Entrega', { 'a.txt': 'do A\n' });
    expect(t.status).toBe('review');
    const out = await p.svc.update('p', t.id, { status: 'done' }, true);
    expect(out).toMatchObject({ status: 'done', merged: { branch: t.codeAt!.branch, base: 'main' } });
    expect(await fs.readFile(path.join(p.dir, 'a.txt'), 'utf8')).toBe('do A\n');
    expect(git(p.dir, 'status', '--porcelain', '--', '.', ':(exclude).myco')).toBe('');
    await until(async () => !existsSync(t.codeAt!.path!));
    expect(git(p.dir, 'branch', '--list', t.codeAt!.branch!)).toBe('');
  });

  it('principal sujo: a junção não roda, o card FICA em Revisão (não vai a Finalizado) e o arquivo do dono não é tocado', async () => {
    const p = await proj('sujo');
    const t = await deliver(p, 'ana-1', 'Entrega', { 'a.txt': 'do A\n' });
    await fs.writeFile(path.join(p.dir, 'app.txt'), 'edição do dono, sem commit\n');
    await expect(p.svc.update('p', t.id, { status: 'done' }, true)).rejects.toBeInstanceOf(CodeError);
    const after = await p.get(t.id);
    expect(after.status).toBe('review');
    expect(after.merged).toBeFalsy();
    expect(existsSync(path.join(p.dir, 'a.txt'))).toBe(false);
    expect(await fs.readFile(path.join(p.dir, 'app.txt'), 'utf8')).toBe('edição do dono, sem commit\n');
    expect(existsSync(t.codeAt!.path!)).toBe(true);
  });

  it('a pasta do card sumiu: não dá para conferir nem juntar, o card fica em Revisão', async () => {
    const p = await proj('sumiu');
    const t = await deliver(p, 'ana-1', 'Entrega', { 'a.txt': 'x\n' });
    await fs.rm(t.codeAt!.path!, { recursive: true, force: true });
    await expect(p.svc.update('p', t.id, { status: 'done' }, true)).rejects.toBeInstanceOf(TaskConflictError);
    expect((await p.get(t.id)).status).toBe('review');
  });

  it('card sem nenhuma mudança de código (análise): vai a Finalizado sem juntar nada, e a worktree sai', async () => {
    const p = await proj('vazio');
    const t = await p.start('ana-1', 'Só análise');
    await p.patch(t.id, { status: 'review' });
    const before = git(p.dir, 'rev-parse', 'HEAD');
    const out = await p.svc.update('p', t.id, { status: 'done' }, true);
    expect(out?.status).toBe('done');
    expect(out?.merged).toBeFalsy();
    expect(git(p.dir, 'rev-parse', 'HEAD')).toBe(before);
    await until(async () => !existsSync(t.codeAt!.path!));
  });
});

describe('reinício do servidor no meio', () => {
  it('uma instância nova do serviço reencontra a worktree, o que ela tem e o card; começar de novo não recria nem perde o que não foi commitado', async () => {
    const p = await proj('reinicio');
    const t = await p.start('ana-1', 'Longa');
    await fs.writeFile(path.join(t.codeAt!.path!, 'rascunho.txt'), 'sem commit\n');
    const restarted = p.mk();
    const code = await restarted.code('p', t.id);
    expect(code).toMatchObject({ where: 'worktree', path: t.codeAt!.path, branch: t.codeAt!.branch });
    expect(code?.files.map((f) => f.path)).toContain('rascunho.txt');
    // A conversa cai e a fila abre outra para o mesmo card: mesma pasta, mesma porta, rascunho intacto.
    await p.patch(t.id, { sessionId: null, status: 'todo' });
    await restarted.start('p', t.id);
    const again = await p.get(t.id);
    expect(again.codeAt).toMatchObject({ path: t.codeAt!.path, port: t.codeAt!.port });
    expect(await fs.readFile(path.join(t.codeAt!.path!, 'rascunho.txt'), 'utf8')).toBe('sem commit\n');
    expect(p.sent.at(-1)!.place?.path).toBe(t.codeAt!.path);
  });
});
