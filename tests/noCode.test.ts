import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveCaller, SessionTokens } from '../server/callers';
import { stuckInboxItem } from '../server/inboxItems';
import { TaskConflictError, TaskForbiddenError, TaskService, ownAlerts, stuckState } from '../server/tasks';
import { codeTouchedSince } from '../server/taskCode';
import type { Engine, StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Card = código (t-dd7e82, parte 5): o turno que termina sem nenhuma edição (changedFiles vazio e nada mudado no repositório desde que o card começou) não é entrega: o card fica
// em "fazendo", marcado "sem código", sem ocupar o funcionário, e quem pediu (gestor na conversa em que pediu, ou o dono pela caixa) cancela com motivo ou devolve ao responsável.
// Repositórios git de verdade (a prova de "sem diff" é o que o git e o disco dizem); só a prova de ausência trava, o resto segue como entrega.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-nocode-'));
});
afterAll(() => removeTemp(root));

const PAST = '2020-01-01T00:00:00';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST } }).toString();
const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], ...extra }) as StaffProfile;

/** Gio (gestor) pede a Ana. `repo: false` deixa a pasta fora do git. O commit-base é de 2020: o "commit depois do começo" só vale para o que o teste fizer. */
async function club(dirName: string, opts: { engine?: Engine; repo?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  if (opts.repo !== false) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', 'a.ts');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  const engine = opts.engine ?? 'claude';
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Gio', { role: 'Orquestrador', engine }),
    'ana-1': profile('ana-1', 'Ana', { engine, reportsTo: ['gio-1'] }),
    'rui-1': profile('rui-1', 'Rui', { engine }),
  };
  const h = {
    delivered: [] as Array<{ sessionId: string; text: string }>,
    notified: [] as Array<{ staffId: string; text: string; sessionId: string | null | undefined }>,
    texts: {} as Record<string, string>,
    notifyFails: false,
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId) => `${staffId}-${++h.n}`,
    branchFor: async () => null,
    isWorking: () => false,
    sendTo: async (_p, sessionId, _s, text) => {
      h.delivered.push({ sessionId, text });
      return sessionId;
    },
    notify: async (_p, staffId, text, sessionId) => {
      if (h.notifyFails) throw new Error('conversa dele não abriu');
      h.notified.push({ staffId, text, sessionId });
    },
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    lastText: (s) => h.texts[s] ?? null,
    log: () => {},
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const tokens = new SessionTokens();
  const as = (staffId: string, session: string) => {
    const r = resolveCaller(false, tokens.issue({ staffId, projectId: 'p', sessionId: session, engine }), tokens);
    return r.ok ? r.caller : null;
  };
  /** O card de Ana, pedido por `by` (null = o dono pela tela), já começado; devolve a conversa de trabalho. */
  const begin = async (title = 'Exportar CSV', by: string | null = 'gio-1', staffId = 'ana-1') => {
    const t = (await svc.create('p', { title, description: 'Faça a exportação', staffId, reviewerId: null }, by, by ? 'gio-s' : undefined))!;
    await svc.start('p', t.id);
    return { id: t.id, work: (await get(t.id)).sessionId! };
  };
  /** O turno da conversa acaba, com a última mensagem `text`. */
  const endTurn = async (work: string, text = 'Respondi: a análise está aqui.') => {
    h.texts[work] = text;
    await svc.onTurnDone(work);
    await svc.kickStaff('p', 'ana-1');
  };
  const edit = (work: string) => svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId: 'ana-1', engine, cwd: dir, files: [path.join(dir, 'a.ts')], request: null });
  return { dir, h, svc, list, get, as, begin, endTurn, edit, people };
}
const place = { projectId: 'p', projectName: 'Painel', sessionId: '', staffId: 'ana-1', name: 'Ana' };

describe.each<Engine>(['claude', 'codex'])('o turno sem edição: %s', (engine) => {
  it('não vai para revisão: fica em "fazendo" marcado "sem código" e o gestor é avisado na conversa em que pediu, com os dois caminhos', async () => {
    const b = await club(`gestor-${engine}`, { engine });
    const { id, work } = await b.begin();
    await b.endTurn(work);
    const t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.delivery).toBeUndefined();
    expect(t.history.map((h) => h.status)).not.toContain('review');
    expect(t.noCode).toMatchObject({ to: 'manager', summary: 'Respondi: a análise está aqui.' });
    expect(t.noCode!.deliveredAt).toBeTruthy();
    expect(t.noCode!.notifyRetry).toBeUndefined();
    expect(t.history.at(-1)!.note).toContain('sem editar código');
    // O aviso: na conversa em que o gestor pediu, com o que o responsável disse como dado, e o endereço do motor do gestor.
    expect(b.h.notified).toHaveLength(1);
    const n = b.h.notified[0]!;
    expect(n).toMatchObject({ staffId: 'gio-1', sessionId: 'gio-s' });
    const api = `${engine === 'codex' ? 'http://127.0.0.2:4848' : 'http://127.0.0.1:4848'}/api/projects/p`;
    expect(n.text).toContain('Ana terminou o turno da tarefa “Exportar CSV”');
    expect(n.text).toContain('card = código');
    expect(n.text).toContain('```text\nRespondi: a análise está aqui.\n```');
    expect(n.text).toContain(`${api}/tasks/${id}/cancel`);
    expect(n.text).toContain(`${api}/chat/send`);
    expect(n.text).toContain(`"sessionId": "${work}", "staffId": "ana-1"`);
    // Quem decide é o gestor: não vai para a caixa do dono, mas a parada é a regra única.
    expect(ownAlerts([t])).toEqual([]);
    expect(stuckState(t)).toMatchObject({ humanAction: 'decide', selfHeals: false, reason: expect.stringContaining('sem editar código') });
  });

  it('pedida pelo dono (sem gestor): o aviso é o item "stuck" da caixa, com a marca e o que o responsável disse', async () => {
    const b = await club(`dono-${engine}`, { engine });
    const { id, work } = await b.begin('Exportar CSV', null);
    await b.endTurn(work);
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'doing', noCode: { to: 'owner', summary: 'Respondi: a análise está aqui.' } });
    expect(b.h.notified).toHaveLength(0);
    const [alert] = ownAlerts([t]);
    expect(alert).toBeDefined();
    const item = stuckInboxItem(alert!, place);
    expect(item).toMatchObject({ kind: 'stuck', id: `stuck:${id}:decide`, sessionId: '', stuck: { taskId: id, humanAction: 'decide', selfHeals: false, noCode: true, summary: 'Respondi: a análise está aqui.' } });
  });

  it('com edição vista (changedFiles) vai para revisão como sempre', async () => {
    const b = await club(`editou-${engine}`, { engine });
    const { id, work } = await b.begin();
    await b.edit(work);
    await b.endTurn(work, 'Feito.');
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.noCode).toBeUndefined();
    expect(t.delivery?.summary).toBe('Feito.');
  });
});

describe('só a prova de ausência trava', () => {
  it('edição por shell que a conversa não viu (arquivo mexido no repositório depois do começo) vai para revisão', async () => {
    const b = await club('shell');
    const { id, work } = await b.begin();
    await new Promise((r) => setTimeout(r, 25));
    await fs.writeFile(path.join(b.dir, 'gerado.ts'), 'export const g = 1;\n');
    await b.endTurn(work);
    expect((await b.get(id)).status).toBe('review');
    expect((await b.get(id)).noCode).toBeUndefined();
  });

  it('arquivo sujo que já estava lá antes de o card começar não prova edição: o card é marcado', async () => {
    const b = await club('antigo');
    const velho = path.join(b.dir, 'velho.ts');
    await fs.writeFile(velho, 'x\n');
    const past = new Date('2020-02-01T00:00:00Z');
    await fs.utimes(velho, past, past);
    const { id, work } = await b.begin();
    await b.endTurn(work);
    expect((await b.get(id)).noCode).toBeDefined();
    expect((await b.get(id)).status).toBe('doing');
  });

  it('commit feito durante o card (a edição já foi guardada) vai para revisão', async () => {
    const b = await club('commit');
    const { id, work } = await b.begin();
    await new Promise((r) => setTimeout(r, 25));
    await fs.writeFile(path.join(b.dir, 'novo.ts'), 'export const n = 1;\n');
    execFileSync('git', ['-C', b.dir, 'add', 'novo.ts']);
    execFileSync('git', ['-C', b.dir, 'commit', '-q', '-m', 'feito pelo funcionário']);
    await b.endTurn(work);
    expect((await b.get(id)).status).toBe('review');
  });

  it('projeto fora do git: não há como provar, segue como entrega (o que já valia)', async () => {
    const b = await club('sem-git', { repo: false });
    const { id, work } = await b.begin();
    await b.endTurn(work);
    expect((await b.get(id)).status).toBe('review');
    expect((await b.get(id)).noCode).toBeUndefined();
  });

  it('card que delegou subtarefa não é marcado: o código está nelas', async () => {
    const b = await club('subtarefa');
    // O card de Gio (orquestrador), pedido por Ana; Gio delega a ela pelo token da conversa de trabalho dele.
    const card = (await b.svc.create('p', { title: 'Orquestrar', description: 'Delegue', staffId: 'gio-1', reviewerId: null }, 'ana-1', 'ana-s'))!;
    await b.svc.start('p', card.id);
    const work = (await b.get(card.id)).sessionId!;
    const sub = (await b.svc.create('p', { title: 'Parte A', description: 'x', staffId: 'ana-1', reviewerId: null }, 'gio-1', work))!;
    b.h.texts[work] = 'Delegado.';
    await b.svc.onTurnDone(work);
    expect((await b.get(card.id)).awaitingSubtasks).toBeDefined();
    await b.svc.cancel('p', sub.id, { by: 'user' });
    b.h.texts[work] = 'Concluído.';
    await b.svc.onTurnDone(work);
    const t = await b.get(card.id);
    expect(t.noCode).toBeUndefined();
    expect(t.status).toBe('review');
  });

  it('codeTouchedSince: só `false` prova; arquivo apagado, lista grande e git quebrado contam como "mexeu"', async () => {
    const b = await club('touched');
    const place2 = { where: 'project' as const, path: b.dir, branch: 'main' };
    const now = Date.now();
    expect(await codeTouchedSince(place2, now)).toBe(false);
    // Apagado (sem data): não dá para provar.
    await fs.rm(path.join(b.dir, 'a.ts'));
    expect(await codeTouchedSince(place2, now)).toBe(true);
    git(b.dir, 'checkout', '--', 'a.ts');
    expect(await codeTouchedSince(place2, now)).toBe(false);
    // A pasta que não é repositório: o git falha, e falhar é "mexeu".
    expect(await codeTouchedSince({ where: 'project', path: path.join(root, 'nao-existe'), branch: null }, now)).toBe(true);
    // O commit do mesmo segundo do começo conta como depois.
    expect(await codeTouchedSince(place2, Date.parse('2020-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('o que acontece com o card marcado', () => {
  it('não ocupa o funcionário: a próxima tarefa dele começa na hora', async () => {
    const b = await club('fila');
    const first = await b.begin('Análise');
    await b.endTurn(first.work);
    expect((await b.get(first.id)).noCode).toBeDefined();
    const second = await b.begin('Código de verdade');
    const t = await b.get(second.id);
    expect(t.status).toBe('doing');
    expect(t.sessionId).toBe(second.work);
  });

  it('devolver (mensagem na conversa de trabalho) tira a marca; o fim de turno seguinte confere de novo e avisa de novo', async () => {
    const b = await club('devolver');
    const { id, work } = await b.begin();
    await b.endTurn(work);
    expect(b.h.notified).toHaveLength(1);
    await b.svc.onSent(work);
    const back = await b.get(id);
    expect(back.noCode).toBeUndefined();
    expect(back.status).toBe('doing');
    expect(back.history.at(-1)!.note).toContain('devolvida ao responsável');
    await b.endTurn(work, 'De novo sem código.');
    expect((await b.get(id)).noCode).toMatchObject({ summary: 'De novo sem código.' });
    expect(b.h.notified).toHaveLength(2);
    // Agora com edição: vai para revisão e a marca não volta.
    await b.svc.onSent(work);
    await b.edit(work);
    await b.endTurn(work, 'Agora sim.');
    const done = await b.get(id);
    expect(done.status).toBe('review');
    expect(done.noCode).toBeUndefined();
  });

  it('o mesmo fim de turno duas vezes (o vigia e o processo) marca e avisa uma vez só', async () => {
    const b = await club('duas-vezes');
    const { id, work } = await b.begin();
    b.h.texts[work] = 'Resposta.';
    await Promise.all([b.svc.onTurnDone(work), b.svc.onTurnDone(work)]);
    await b.svc.onTurnDone(work);
    expect((await b.get(id)).history.filter((h) => h.note?.includes('sem editar código'))).toHaveLength(1);
    expect(b.h.notified).toHaveLength(1);
  });

  it('a órfã não reabre o card marcado com "continue" (o turno acabou de propósito)', async () => {
    const b = await club('orfa');
    const { work } = await b.begin();
    await b.endTurn(work);
    await b.svc.tick(new Date(Date.now() + 10 * 60_000));
    expect(b.h.delivered.filter((d) => d.sessionId === work)).toEqual([]);
  });

  it('mover o card de coluna tira a marca (o dono decidiu por conta própria)', async () => {
    const b = await club('mover');
    const { id, work } = await b.begin();
    await b.endTurn(work);
    await b.svc.update('p', id, { status: 'review' });
    const moved = await b.get(id);
    expect(moved.status).toBe('review');
    expect(moved.noCode).toBeUndefined();
  });

  it('o gestor que pediu cancela o card marcado, com motivo; o que não está marcado e já começou segue 409', async () => {
    const b = await club('cancelar');
    const marked = await b.begin('Análise');
    await b.endTurn(marked.work);
    // Sem motivo: 400 (o motivo é obrigatório); outro funcionário: 403.
    await expect(b.svc.cancelFrom('p', marked.id, b.as('gio-1', 'gio-s'), '  ')).rejects.toThrow(/motivo/);
    await expect(b.svc.cancelFrom('p', marked.id, b.as('rui-1', 'rui-s'), 'não é meu')).rejects.toBeInstanceOf(TaskForbiddenError);
    const done = await b.svc.cancelFrom('p', marked.id, b.as('gio-1', 'gio-s'), 'era uma pergunta, não código');
    expect(done).toMatchObject({ status: 'cancelled', cancelReason: 'era uma pergunta, não código', cancelledBy: 'gio-1', noCode: undefined });
    // Uma tarefa que já começou e trabalha (sem marca): o caminho continua sendo o pedido de cancelamento.
    const working = await b.begin('Em andamento', 'gio-1', 'rui-1');
    await expect(b.svc.cancelFrom('p', working.id, b.as('gio-1', 'gio-s'), 'desisti')).rejects.toBeInstanceOf(TaskConflictError);
  });

  it('o aviso ao gestor falha: o card fica marcado, o tick refaz com backoff, e passados 30 min o item vai para a caixa do dono', async () => {
    const b = await club('aviso-falha');
    b.h.notifyFails = true;
    const { id, work } = await b.begin();
    await b.endTurn(work);
    const failed = (await b.get(id)).noCode!;
    expect(failed).toMatchObject({ to: 'manager', notifyRetry: { attempts: 1, lastError: expect.stringContaining('conversa dele não abriu') } });
    expect(failed.deliveredAt).toBeUndefined();
    expect(ownAlerts([await b.get(id)])).toEqual([]);
    // Passada a hora marcada, com o gestor de volta: entrega e tira a marca de tentativa.
    b.h.notifyFails = false;
    await b.svc.tick(new Date(Date.parse(failed.notifyRetry!.nextAt) + 1000));
    expect(b.h.notified).toHaveLength(1);
    const delivered = (await b.get(id)).noCode!;
    expect(delivered).toMatchObject({ to: 'manager', deliveredAt: expect.any(String) });
    expect(delivered.notifyRetry).toBeUndefined();
    // Outro card: o aviso nunca chega, e depois de 30 min vai para o dono.
    b.h.notifyFails = true;
    const slow = await b.begin('Outro', 'gio-1', 'rui-1');
    await b.endTurn(slow.work);
    // A primeira tentativa foi há 40 min (o servidor decide pelo relógio de agora, como no follow-up).
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    all.find((x) => x.id === slow.id)!.noCode.notifyRetry = { attempts: 4, nextAt: new Date(Date.now() - 1000).toISOString(), firstAt: new Date(Date.now() - 40 * 60_000).toISOString() };
    await fs.writeFile(file, JSON.stringify(all, null, 2));
    await b.svc.tick(new Date());
    const t = await b.get(slow.id);
    expect(t.noCode).toMatchObject({ to: 'owner', escalatedAt: expect.any(String) });
    expect(t.noCode!.notifyRetry).toBeUndefined();
    expect(t.history.at(-1)!.note).toContain('foi para você');
    expect(ownAlerts([t]).map((a) => a.task.id)).toEqual([slow.id]);
  });

  it('o gestor que saiu do projeto: o aviso vai direto para a caixa do dono', async () => {
    const b = await club('sem-gestor');
    const { id, work } = await b.begin();
    delete b.people['gio-1'];
    await b.endTurn(work);
    expect((await b.get(id)).noCode).toMatchObject({ to: 'owner' });
    expect(b.h.notified).toHaveLength(0);
    expect(ownAlerts([await b.get(id)])).toHaveLength(1);
  });
});

describe('criar card não é bloqueado', () => {
  it('a criação segue igual: a trava é só no fim do turno', async () => {
    const b = await club('criar');
    const t = await b.svc.create('p', { title: 'Só uma pergunta', description: 'Como está o deploy?', staffId: 'ana-1', start: false, reviewerId: null }, 'gio-1');
    expect(t).toMatchObject({ status: 'waiting', title: 'Só uma pergunta' });
  });
});
