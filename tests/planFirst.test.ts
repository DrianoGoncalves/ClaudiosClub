import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveCaller, SANDBOX_HOST, SessionTokens } from '../server/callers';
import { gate } from '../server/gate';
import { Pairing } from '../server/pairing';
import { stuckInboxItem } from '../server/inboxItems';
import { TaskConflictError, TaskError, TaskForbiddenError, TaskService, ownAlerts, stuckState, wantsPlan } from '../server/tasks';
import type { Engine, StaffProfile } from '../shared/model';

// Plano não é entrega (t-bb54bc): o card que pede o plano primeiro (`Task.planFirst`, ou a descrição o pede) e termina o turno sem editar nada entregou o plano. Ele fica em "planejando"
// com o plano pendente de quem pediu (`Task.planWait`): sem revisão, sem rodada, sem reprovação. Aprovar leva o MESMO card a "fazendo" com o plano gravado; recusar devolve ao responsável
// com o motivo. Card que não pediu plano segue o fluxo de sempre (entrega, ou "sem código"). Repositórios git de verdade, nos dois motores.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-planfirst-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const PAST = '2020-01-01T00:00:00';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST } }).toString();
const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], ...extra }) as StaffProfile;
const PLAN = 'Plano: 1) mexer em a.ts; 2) teste novo; riscos: nenhum.';

/** Gio (gestor) pede a Ana. Gio é o revisor por padrão (quem pede e não manda `reviewerId`): se o plano abrisse revisão, `h.sent` teria uma conversa de revisão dele. */
async function club(dirName: string, opts: { engine?: Engine } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', 'a.ts');
  git(dir, 'commit', '-q', '-m', 'base');
  const engine = opts.engine ?? 'claude';
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Gio', { role: 'Orquestrador', engine }),
    'ana-1': profile('ana-1', 'Ana', { engine, reportsTo: ['gio-1'] }),
    'rui-1': profile('rui-1', 'Rui', { engine }),
    'pla-1': profile('pla-1', 'Pla', { engine: 'codex', autonomy: 'plan', reportsTo: ['gio-1'] }),
  };
  const h = {
    sent: [] as Array<{ staffId: string; text: string; reviewOnly: boolean | undefined }>,
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
    send: async (_p, staffId, text, _force, _override, reviewOnly) => {
      h.sent.push({ staffId, text, reviewOnly });
      return `${staffId}-${++h.n}`;
    },
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
  /** O card de `staffId`, pedido por `by` (null = o dono pela tela), já começado; devolve a conversa de trabalho. Sem `reviewerId` no corpo, o gestor que pediu é o revisor. */
  const begin = async (extra: Record<string, unknown> = {}, by: string | null = 'gio-1', staffId = 'ana-1') => {
    const body = { title: 'Exportar CSV', description: 'Faça a exportação', staffId, ...(by === null && { reviewerId: null }), ...extra };
    const t = (await svc.create('p', body, by, by ? 'gio-s' : undefined))!;
    await svc.start('p', t.id);
    return { id: t.id, work: (await get(t.id)).sessionId! };
  };
  /** O turno da conversa acaba, com a última mensagem `text`. */
  const endTurn = async (work: string, text = PLAN) => {
    h.texts[work] = text;
    await svc.onTurnDone(work);
    await svc.kickStaff('p', 'ana-1');
  };
  const edit = (work: string) => svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId: 'ana-1', engine, cwd: dir, files: [path.join(dir, 'a.ts')], request: null });
  /** As conversas de revisão abertas (o `send` com `reviewOnly`). */
  const reviewsOpened = () => h.sent.filter((s) => s.reviewOnly);
  /** O token de `staffId` (o do motor do rig), para chamar a API pelo gate de verdade. */
  const tokenOf = (staffId: string, session: string, projectId = 'p') => tokens.issue({ staffId, projectId, sessionId: session, engine });
  return { dir, h, svc, list, get, as, begin, endTurn, edit, people, reviewsOpened, tokens, tokenOf };
}
const place = { projectId: 'p', projectName: 'Painel', sessionId: '', staffId: 'ana-1', name: 'Ana' };

describe.each<Engine>(['claude', 'codex'])('card de plano primeiro entrega o plano: %s', (engine) => {
  it('fica em "planejando" com o plano pendente do gestor: sem revisão, sem rodada, sem reprovação', async () => {
    const b = await club(`plano-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    const t = await b.get(id);
    expect(t.status).toBe('planning');
    expect(t.planWait).toMatchObject({ to: 'manager', text: PLAN });
    expect(t.planWait!.deliveredAt).toBeTruthy();
    expect(t.planWait!.notifyRetry).toBeUndefined();
    // Nada de entrega: sem revisão pedida, sem rodada, sem reprovação, sem resumo de entrega, sem passagem por "revisão".
    expect(t.review).toBeUndefined();
    expect(t.delivery).toBeUndefined();
    expect(t.reviewRounds).toBeUndefined();
    expect(t.reworkRounds).toBeUndefined();
    expect(t.rejections).toBeUndefined();
    expect(t.plan).toBeNull();
    expect(t.history.map((x) => x.status)).not.toContain('review');
    expect(b.reviewsOpened()).toEqual([]);
    expect(t.history.at(-1)).toMatchObject({ status: 'planning', note: expect.stringContaining('entregou o plano') });
    // O aviso: na conversa em que o gestor pediu, com o plano como dado dele, no endereço do motor do gestor e com os dois caminhos.
    expect(b.h.notified).toHaveLength(1);
    const n = b.h.notified[0]!;
    expect(n).toMatchObject({ staffId: 'gio-1', sessionId: 'gio-s' });
    const api = `${engine === 'codex' ? 'http://127.0.0.2:4848' : 'http://127.0.0.1:4848'}/api/projects/p`;
    expect(n.text).toContain('Ana entregou o PLANO da tarefa “Exportar CSV”');
    expect(n.text).toContain('Plano não é entrega');
    expect(n.text).toContain(PLAN);
    expect(n.text).toContain(`${api}/tasks/${id}/plan`);
    expect(n.text).toContain('{"decision": "approve"}');
    expect(n.text).toContain('{"decision": "reject", "reason": "<o que ajustar no plano>"}');
    // Quem decide é o gestor (não vai para a caixa do dono); a parada é a regra única.
    expect(ownAlerts([t])).toEqual([]);
    expect(stuckState(t)).toMatchObject({ humanAction: 'decide', selfHeals: false, reason: expect.stringContaining('plano') });
  });

  it('o card segue ocupando o funcionário (como o cartão de plano): a próxima da fila só começa com a decisão', async () => {
    const b = await club(`ocupa-${engine}`, { engine });
    const first = await b.begin({ planFirst: true, title: 'Com plano' });
    await b.endTurn(first.work);
    const next = (await b.svc.create('p', { title: 'Próxima', description: 'x', staffId: 'ana-1', reviewerId: null }, 'gio-1', 'gio-s'))!;
    await b.svc.start('p', next.id);
    expect((await b.get(next.id)).sessionId).toBeNull();
    await b.svc.decidePlan('p', first.id, b.as('gio-1', 'gio-s'), false, { decision: 'approve' });
    expect((await b.get(first.id)).status).toBe('doing');
  });

  it('o mesmo fim de turno duas vezes (o vigia e o processo) marca e avisa uma vez só', async () => {
    const b = await club(`duas-vezes-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    b.h.texts[work] = PLAN;
    await Promise.all([b.svc.onTurnDone(work), b.svc.onTurnDone(work)]);
    await b.svc.onTurnDone(work);
    const t = await b.get(id);
    expect(t.history.filter((x) => x.note?.includes('entregou o plano'))).toHaveLength(1);
    expect(t.status).toBe('planning');
    expect(b.h.notified).toHaveLength(1);
    expect(b.reviewsOpened()).toEqual([]);
  });

  it('a descrição pede ("Comece pelo plano... espere aprovação"), sem o campo: vale do mesmo jeito', async () => {
    const b = await club(`descricao-${engine}`, { engine });
    const { id, work } = await b.begin({ description: 'Parte do servidor.\nComece pelo plano (fase planejando) e espere aprovação antes de editar.' });
    await b.endTurn(work);
    expect((await b.get(id)).status).toBe('planning');
    expect((await b.get(id)).planWait).toBeDefined();
    expect(b.reviewsOpened()).toEqual([]);
  });

  it('projeto compartilhado (outra tarefa mexeu em arquivo): o plano continua não sendo entrega, e o mesmo card sem plano primeiro vai para revisão como antes', async () => {
    const b = await club(`compartilhado-${engine}`, { engine });
    const plan = await b.begin({ planFirst: true, title: 'Com plano' });
    const plain = await b.begin({ title: 'Sem plano' }, 'gio-1', 'rui-1');
    await new Promise((r) => setTimeout(r, 25));
    // O que esconde o "sem código": arquivo mexido no projeto depois do começo (por outra tarefa ou por shell).
    await fs.writeFile(path.join(b.dir, 'outra-tarefa.ts'), 'export const o = 1;\n');
    await b.endTurn(plan.work);
    expect((await b.get(plan.id)).status).toBe('planning');
    expect(b.reviewsOpened()).toEqual([]);
    // Controle: sem plano primeiro, o mesmo cenário entrega (a regra de antes, que não muda).
    b.h.texts[plain.work] = 'Concluí.';
    await b.svc.onTurnDone(plain.work);
    expect((await b.get(plain.id)).status).toBe('review');
    expect(b.reviewsOpened()).toHaveLength(1);
  });

  it('plano primeiro, mas o turno editou (changedFiles): é entrega, vai para revisão como sempre', async () => {
    const b = await club(`editou-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.edit(work);
    await b.endTurn(work, 'Implementei direto.');
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.planWait).toBeUndefined();
    expect(t.delivery?.summary).toBe('Implementei direto.');
  });
});

describe.each<Engine>(['claude', 'codex'])('a decisão do plano: %s', (engine) => {
  it('aprovar: o MESMO card segue a "fazendo" com o plano gravado e a mensagem de implementar; a entrega depois é a de sempre', async () => {
    const b = await club(`aprovar-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    const out = await b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'approve', note: 'Use a lib que já existe.' });
    expect(out).toMatchObject({ id, status: 'doing', plan: PLAN, sessionId: work });
    expect(out!.planWait).toBeUndefined();
    expect(out!.history.at(-1)).toMatchObject({ status: 'doing', note: 'plano aprovado por Gio' });
    expect(out!.reworkRounds).toBeUndefined();
    expect(out!.rejections).toBeUndefined();
    expect(b.reviewsOpened()).toEqual([]);
    const msg = b.h.delivered.filter((d) => d.sessionId === work).at(-1)!.text;
    expect(msg).toContain('[Tarefa "Exportar CSV"]');
    expect(msg).toContain('O plano foi aprovado por Gio. Implemente-o agora, neste mesmo card');
    expect(msg).toContain('Observação de quem aprovou: Use a lib que já existe.');
    // Implementa e entrega: revisão normal, a primeira rodada.
    await b.edit(work);
    await b.endTurn(work, 'Feito.');
    const done = await b.get(id);
    expect(done.status).toBe('review');
    expect(done.plan).toBe(PLAN);
    expect(done.delivery?.summary).toBe('Feito.');
    expect(done.reviewRounds).toBe(1);
    expect(b.reviewsOpened()).toHaveLength(1);
  });

  it('aprovado e o turno seguinte sem edição: o plano já foi decidido, vale o "sem código" de sempre (não pede plano de novo)', async () => {
    const b = await club(`aprovado-sem-edicao-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    await b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'approve' });
    await b.endTurn(work, 'Nada a mudar.');
    const t = await b.get(id);
    expect(t.status).toBe('doing');
    expect(t.planWait).toBeUndefined();
    expect(t.noCode).toBeDefined();
  });

  it('recusar: volta ao responsável com o motivo, em "fazendo", sem reprovação; o plano novo espera de novo', async () => {
    const b = await club(`recusar-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    const first = (await b.get(id)).planWait!.since;
    // Sem motivo: 400, nada muda.
    await expect(b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'reject' })).rejects.toBeInstanceOf(TaskError);
    expect((await b.get(id)).status).toBe('planning');
    const out = await b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'reject', reason: 'Falta o plano de migração.' });
    expect(out).toMatchObject({ status: 'doing', plan: null });
    expect(out!.planWait).toBeUndefined();
    expect(out!.history.at(-1)).toMatchObject({ status: 'doing', note: 'plano recusado por Gio: Falta o plano de migração.' });
    expect(out!.reworkRounds).toBeUndefined();
    expect(out!.rejections).toBeUndefined();
    expect(b.reviewsOpened()).toEqual([]);
    const msg = b.h.delivered.filter((d) => d.sessionId === work).at(-1)!.text;
    expect(msg).toContain('O plano foi recusado por Gio. Motivo: Falta o plano de migração.');
    expect(msg).toContain('ainda sem editar arquivos');
    // O responsável ajusta e entrega o plano novo: espera de novo, e o gestor é avisado de novo.
    await b.endTurn(work, 'Plano v2, com migração.');
    const again = await b.get(id);
    expect(again.status).toBe('planning');
    expect(again.planWait).toMatchObject({ text: 'Plano v2, com migração.', to: 'manager' });
    expect(again.planWait!.since).not.toBe(first);
    expect(b.h.notified).toHaveLength(2);
    expect(b.reviewsOpened()).toEqual([]);
  });

  it('quem decide: o usuário (pela tela) e o gestor que pediu; o responsável e outro gestor levam 403; o que já foi decidido, 409', async () => {
    const b = await club(`quem-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    await expect(b.svc.decidePlan('p', id, b.as('ana-1', work), false, { decision: 'approve' })).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(b.svc.decidePlan('p', id, b.as('rui-1', 'rui-s'), false, { decision: 'approve' })).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(b.svc.decidePlan('p', id, null, false, { decision: 'approve' })).rejects.toBeInstanceOf(TaskForbiddenError);
    expect((await b.get(id)).status).toBe('planning');
    // Corpo inválido: 400.
    await expect(b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'talvez' })).rejects.toBeInstanceOf(TaskError);
    await expect(b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'approve', reason: 'x' })).rejects.toBeInstanceOf(TaskError);
    const out = await b.svc.decidePlan('p', id, null, true, { decision: 'approve' });
    expect(out!.history.at(-1)!.note).toBe('plano aprovado por o usuário');
    await expect(b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'approve' })).rejects.toBeInstanceOf(TaskConflictError);
    expect(await b.svc.decidePlan('p', 't-naoexiste', b.as('gio-1', 'gio-s'), false, { decision: 'approve' })).toBeNull();
  });

  it('mensagem na conversa do card (a de quem pediu, ou a do dono) devolve o card a "fazendo", sem gravar o plano', async () => {
    const b = await club(`mensagem-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    await b.svc.onSent(work);
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'doing', plan: null });
    expect(t.planWait).toBeUndefined();
    expect(t.history.at(-1)!.note).toContain('o plano deixou de esperar a decisão');
    // Ele não está mais esperando decisão: a rota responde 409.
    await expect(b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'approve' })).rejects.toBeInstanceOf(TaskConflictError);
    expect(b.reviewsOpened()).toEqual([]);
  });

  it('cancelar o card que espera o plano tira a marca e nada vai para revisão', async () => {
    const b = await club(`cancelar-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    await b.svc.cancel('p', id, { by: 'user' });
    const t = await b.get(id);
    expect(t.status).toBe('cancelled');
    expect(t.planWait).toBeUndefined();
    expect(b.reviewsOpened()).toEqual([]);
  });
});

describe('plano pedido pelo dono, aviso que falha e a rede de segurança', () => {
  it('pedido pelo dono (sem gestor): o plano é o item "stuck" da caixa, com a marca e o começo do plano; o dono aprova pela tela', async () => {
    const b = await club('dono');
    const { id, work } = await b.begin({ planFirst: true }, null);
    await b.endTurn(work);
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'planning', planWait: { to: 'owner', text: PLAN } });
    expect(b.h.notified).toHaveLength(0);
    const [alert] = ownAlerts([t]);
    expect(alert).toBeDefined();
    expect(stuckInboxItem(alert!, place)).toMatchObject({ kind: 'stuck', id: `stuck:${id}:decide`, stuck: { taskId: id, humanAction: 'decide', selfHeals: false, planWait: true, summary: PLAN } });
    // Só o dono, pela tela: um gestor sem ter pedido o card leva 403.
    await expect(b.svc.decidePlan('p', id, b.as('gio-1', 'gio-s'), false, { decision: 'approve' })).rejects.toBeInstanceOf(TaskForbiddenError);
    const out = await b.svc.decidePlan('p', id, null, true, { decision: 'approve' });
    expect(out).toMatchObject({ status: 'doing', plan: PLAN });
    expect(ownAlerts([out!])).toEqual([]);
  });

  it('o aviso ao gestor falha: o card fica esperando, o tick refaz com backoff, e passados 30 min o item vai para a caixa do dono', async () => {
    const b = await club('aviso-falha');
    b.h.notifyFails = true;
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    const failed = (await b.get(id)).planWait!;
    expect(failed).toMatchObject({ to: 'manager', notifyRetry: { attempts: 1, lastError: expect.stringContaining('conversa dele não abriu') } });
    expect(failed.deliveredAt).toBeUndefined();
    expect((await b.get(id)).status).toBe('planning');
    expect(ownAlerts([await b.get(id)])).toEqual([]);
    b.h.notifyFails = false;
    await b.svc.tick(new Date(Date.parse(failed.notifyRetry!.nextAt) + 1000));
    expect(b.h.notified).toHaveLength(1);
    expect((await b.get(id)).planWait).toMatchObject({ to: 'manager', deliveredAt: expect.any(String) });
    expect((await b.get(id)).planWait!.notifyRetry).toBeUndefined();
    // Outro card: o aviso nunca chega, e depois de 30 min vai para o dono.
    b.h.notifyFails = true;
    const slow = await b.begin({ planFirst: true, title: 'Outro' }, 'gio-1', 'rui-1');
    b.h.texts[slow.work] = PLAN;
    await b.svc.onTurnDone(slow.work);
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    all.find((x) => x.id === slow.id)!.planWait.notifyRetry = { attempts: 4, nextAt: new Date(Date.now() - 1000).toISOString(), firstAt: new Date(Date.now() - 40 * 60_000).toISOString() };
    await fs.writeFile(file, JSON.stringify(all, null, 2));
    await b.svc.tick(new Date());
    const t = await b.get(slow.id);
    expect(t.planWait).toMatchObject({ to: 'owner', escalatedAt: expect.any(String) });
    expect(t.planWait!.notifyRetry).toBeUndefined();
    expect(t.history.at(-1)!.note).toContain('foi para você');
    expect(ownAlerts([t]).map((a) => a.task.id)).toEqual([slow.id]);
  });

  it.each<Engine>(['claude', 'codex'])('a órfã não leva o card que espera o plano para a revisão (no Codex "planejando" entrega no fim do turno): %s', async (engine) => {
    const b = await club(`orfa-${engine}`, { engine });
    const { id, work } = await b.begin({ planFirst: true });
    await b.endTurn(work);
    await b.svc.tick(new Date(Date.now() + 60 * 60_000));
    const t = await b.get(id);
    expect(t.status).toBe('planning');
    expect(t.planWait).toBeDefined();
    expect(t.review).toBeUndefined();
    expect(b.reviewsOpened()).toEqual([]);
    expect(b.h.delivered.filter((d) => d.sessionId === work)).toEqual([]);
  });
});

describe('o que não muda', () => {
  it.each<Engine>(['claude', 'codex'])('card sem pedido de plano: o turno sem edição segue o "sem código" de sempre, e com edição vai para revisão: %s', async (engine) => {
    const b = await club(`sem-pedido-${engine}`, { engine });
    const plain = await b.begin({ title: 'Análise' });
    await b.endTurn(plain.work, 'Respondi: a análise está aqui.');
    const t = await b.get(plain.id);
    expect(t.status).toBe('doing');
    expect(t.planWait).toBeUndefined();
    expect(t.noCode).toMatchObject({ summary: 'Respondi: a análise está aqui.' });
    const coded = await b.begin({ title: 'Código' }, 'gio-1', 'rui-1');
    await b.svc.onCodeEdit({ sessionId: coded.work, projectId: 'p', staffId: 'rui-1', engine, cwd: b.dir, files: [path.join(b.dir, 'a.ts')], request: null });
    b.h.texts[coded.work] = 'Feito.';
    await b.svc.onTurnDone(coded.work);
    expect((await b.get(coded.id)).status).toBe('review');
    expect((await b.get(coded.id)).planWait).toBeUndefined();
  });

  it('planFirst: false dispensa o plano mesmo com a descrição pedindo: segue o "sem código"', async () => {
    const b = await club('dispensado');
    const { id, work } = await b.begin({ planFirst: false, description: 'Comece pelo plano e espere aprovação antes de editar.' });
    await b.endTurn(work);
    const t = await b.get(id);
    expect(t.planWait).toBeUndefined();
    expect(t.noCode).toBeDefined();
    expect(t.status).toBe('doing');
  });

  it('ficha "só planeja" (autonomia plan) segue como antes: no Codex o fim do turno em planejando entrega (codexPlanDelivery); nada de plano pendente por aqui', async () => {
    const b = await club('so-planeja');
    const { id, work } = await b.begin({ planFirst: true, reviewerId: null }, 'gio-1', 'pla-1');
    expect((await b.get(id)).status).toBe('planning');
    b.h.texts[work] = PLAN;
    await b.svc.onTurnDone(work);
    const t = await b.get(id);
    expect(t.planWait).toBeUndefined();
    expect(t.status).toBe('review');
  });
});

describe('a abertura do card e a API de tarefa', () => {
  it('o card de plano primeiro abre com a regra do plano (os dois motores); o comum e o da ficha "só planeja" não a levam', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const b = await club(`abertura-${engine}`, { engine });
      await b.begin({ planFirst: true, title: 'Com plano' });
      await b.begin({ title: 'Comum' }, 'gio-1', 'rui-1');
      await b.begin({ planFirst: true, title: 'Só planeja', reviewerId: null }, 'gio-1', 'pla-1');
      const text = (title: string) => b.h.sent.find((s) => s.text.includes(`[Tarefa "${title}"]`))!.text;
      expect(text('Com plano')).toContain('Esta tarefa pede o plano primeiro: nesta rodada NÃO edite arquivos');
      expect(text('Comum')).not.toContain('pede o plano primeiro');
      expect(text('Só planeja')).not.toContain('pede o plano primeiro');
    }
  });

  it('criar e editar aceitam planFirst (booleano); outro tipo é 400; a chave de idempotência o confere', async () => {
    const b = await club('api');
    const made = (await b.svc.create('p', { title: 'A', description: 'x', staffId: 'ana-1', planFirst: true, start: false, idempotencyKey: 'plano-chave-0001' }, 'gio-1', 'gio-s'))!;
    expect(made.planFirst).toBe(true);
    expect((await b.svc.create('p', { title: 'B', description: 'x', staffId: 'ana-1', start: false }, 'gio-1', 'gio-s'))!.planFirst).toBeUndefined();
    await expect(b.svc.create('p', { title: 'C', description: 'x', staffId: 'ana-1', planFirst: 'sim' }, 'gio-1', 'gio-s')).rejects.toBeInstanceOf(TaskError);
    // Retry igual: a mesma tarefa; mesma chave com outro planFirst: 409.
    const again = (await b.svc.create('p', { title: 'A', description: 'x', staffId: 'ana-1', planFirst: true, start: false, idempotencyKey: 'plano-chave-0001' }, 'gio-1', 'gio-s'))!;
    expect(again).toMatchObject({ id: made.id, idempotentReplay: true });
    await expect(b.svc.create('p', { title: 'A', description: 'x', staffId: 'ana-1', planFirst: false, start: false, idempotencyKey: 'plano-chave-0001' }, 'gio-1', 'gio-s')).rejects.toBeInstanceOf(TaskConflictError);
    // Edição: pela tela (update) e pelo gestor (editFrom), antes de a tarefa começar.
    expect((await b.svc.update('p', made.id, { planFirst: false }))!.planFirst).toBe(false);
    const edited = await b.svc.editFrom('p', made.id, b.as('gio-1', 'gio-s'), { planFirst: true });
    expect(edited!.planFirst).toBe(true);
    expect(edited!.history.at(-1)!.note).toContain('planFirst');
    await expect(b.svc.editFrom('p', made.id, b.as('gio-1', 'gio-s'), { planFirst: 'sim' })).rejects.toBeInstanceOf(TaskError);
  });
});

describe('wantsPlan: o campo manda; sem ele, a descrição pede por frase, e a que dispensa vence', () => {
  const t = (description: string, extra: { planFirst?: boolean; goal?: string | null } = {}) => ({ description, goal: extra.goal ?? null, ...(extra.planFirst !== undefined && { planFirst: extra.planFirst }) });

  it('os pedidos reais do quadro (t-d1a1ba, t-7e85fa, t-2a8ee8)', () => {
    expect(wantsPlan(t('Parte do servidor.\nComece pelo plano (fase planejando) e espere aprovação antes de editar.\n\nO que o plano precisa responder: 1.'))).toBe(true);
    expect(wantsPlan(t('Comece pelo plano (fase planejando). É complexidade alta e mexe em autenticação: mande o plano antes de implementar.'))).toBe(true);
    expect(wantsPlan(t('PLANO PRIMEIRO: entregue o plano na fase planejando antes de editar.\n\nCaso real (19/11): t-0c0699...'))).toBe(true);
    expect(wantsPlan(t('Planeje primeiro, depois implemente.'))).toBe(true);
    expect(wantsPlan(t('Faça X.', { goal: 'plan first: aprovar antes' }))).toBe(true);
  });

  it('descrição comum, ou que dispensa o plano, não pede (inclusive a desta própria tarefa)', () => {
    expect(wantsPlan(t(''))).toBe(false);
    expect(wantsPlan(t('Exportar o CSV com os pedidos do mês.'))).toBe(false);
    expect(wantsPlan(t('O plano de saúde aparece na tela de benefícios; ajuste o rótulo.'))).toBe(false);
    expect(wantsPlan(t('Planeje e implemente direto neste card (sem parar para aprovação de plano: é justamente o bug).'))).toBe(false);
    expect(wantsPlan(t('Plano primeiro? Não: sem plano, implemente direto.'))).toBe(false);
    expect(wantsPlan(t('Comece pelo plano, mas não precisa esperar aprovação.'))).toBe(false);
  });

  it('o campo vence a descrição, nos dois sentidos', () => {
    expect(wantsPlan(t('Exportar o CSV.', { planFirst: true }))).toBe(true);
    expect(wantsPlan(t('Comece pelo plano e espere aprovação.', { planFirst: false }))).toBe(false);
  });
});

// A rota do plano pelo gate de verdade (t-5a9ef6): `POST tasks/<id>/plan` ficou fora de `STAFF_POSTS` (server/apiPolicy.ts) e o gestor, com x-myco e o token da conversa dele, levava 400
// "só pelo Claudio’s Club" antes de chegar a `decidePlan`: todo card com `planFirst` travava em "planejando". Aqui o pedido passa pelo `gate` (127.0.0.1 e a sandbox do Codex) e só então por `decidePlan`,
// como em server/index.ts: o que o gate deixa passar o serviço ainda confere (quem pediu o card), e o que o gate barra nem chega a ele.
describe('a rota do plano pelo gate de verdade', () => {
  const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', 'claudio.localhost']);
  const isLocalOrigin = (o: string | undefined) => !o || LOCAL.has(new URL(o).hostname);
  const STAFF = { 'x-myco': '1' };
  let rig: Awaited<ReturnType<typeof club>>;
  let pairing: Pairing;
  const servers: http.Server[] = [];
  let local: string;
  let sandbox: string | null = null;

  const listen = (srv: http.Server, host: string) =>
    new Promise<string | null>((resolve) => {
      srv.once('error', () => resolve(null));
      srv.listen(0, host, () => resolve(`http://${host}:${(srv.address() as AddressInfo).port}`));
    });
  const PLAN_ROUTE = /^\/api\/projects\/p\/tasks\/([A-Za-z0-9-]+)\/plan$/;
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const g = gate(req, res, { pairing, tokens: rig.tokens, localHostnames: LOCAL, isLocalOrigin, log: () => {} });
    if (!g) return;
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const m = PLAN_ROUTE.exec(g.url.pathname);
    if (!m) return reply(404, { error: 'rota fora do teste' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const t = await rig.svc.decidePlan('p', m[1]!, g.caller, g.fromBrowser, JSON.parse(raw || '{}'));
      reply(t ? 200 : 404, t ? { status: t.status } : { error: 'sem a tarefa' });
    } catch (err) {
      // Os mesmos códigos de server/index.ts.
      if (err instanceof TaskConflictError) return reply(409, { error: (err as Error).message });
      if (err instanceof TaskForbiddenError) return reply(403, { error: (err as Error).message });
      if (err instanceof TaskError) return reply(400, { error: (err as Error).message });
      throw err;
    }
  };

  beforeAll(async () => {
    pairing = new Pairing(path.join(root, 'gate-secrets', 'pairing.key'));
    const a = http.createServer((req, res) => void handler(req, res));
    const b = http.createServer((req, res) => void handler(req, res));
    servers.push(a, b);
    local = (await listen(a, '127.0.0.1'))!;
    sandbox = await listen(b, SANDBOX_HOST);
  });
  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
  });

  interface Reply {
    status: number;
    body: { status?: string; error?: string };
  }
  const post = (base: string, pathname: string, body: unknown, headers: Record<string, string>): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request(`${base}${pathname}`, { method: 'POST', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (d: string) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  const withToken = (t: string) => ({ ...STAFF, 'x-myco-token': t });
  const route = (id: string, project = 'p') => `/api/projects/${project}/tasks/${id}/plan`;
  const SO_PELO_CLUB = 'só pelo Claudio’s Club';

  it('o gestor que pediu o card aprova o plano com o token: passa do gate (não é 400 "só pelo Claudio’s Club") e o card segue em fazendo', async () => {
    rig = await club('gate-aprova');
    const { id, work } = await rig.begin({ planFirst: true });
    await rig.endTurn(work);
    expect((await rig.get(id)).status).toBe('planning');
    const r = await post(local, route(id), { decision: 'approve' }, withToken(rig.tokenOf('gio-1', 'gio-s')));
    expect(r.body.error).toBeUndefined();
    expect(r).toMatchObject({ status: 200, body: { status: 'doing' } });
    expect((await rig.get(id)).planWait).toBeUndefined();
  });

  it('a recusa com o motivo também passa do gate e devolve o card ao responsável', async () => {
    rig = await club('gate-recusa');
    const { id, work } = await rig.begin({ planFirst: true });
    await rig.endTurn(work);
    const r = await post(local, route(id), { decision: 'reject', reason: 'Falta o plano de migração.' }, withToken(rig.tokenOf('gio-1', 'gio-s')));
    expect(r).toMatchObject({ status: 200, body: { status: 'doing' } });
  });

  it('quem não pediu o card passa do gate e leva 403 do `decidePlan` (o responsável e outro funcionário); o card segue esperando a decisão', async () => {
    rig = await club('gate-403');
    const { id, work } = await rig.begin({ planFirst: true });
    await rig.endTurn(work);
    for (const [staffId, session] of [['ana-1', work], ['rui-1', 'rui-s']] as const) {
      const r = await post(local, route(id), { decision: 'approve' }, withToken(rig.tokenOf(staffId, session)));
      expect(r.status, staffId).toBe(403);
      expect(r.body.error, staffId).not.toBe(SO_PELO_CLUB);
    }
    expect(await rig.get(id)).toMatchObject({ status: 'planning', planWait: { to: 'manager' } });
  });

  it('o gate segue barrando: sem token 401, token inventado 401, token de outro projeto 403, e sem o `x-myco` nem chega (o card segue esperando)', async () => {
    rig = await club('gate-barra');
    const { id, work } = await rig.begin({ planFirst: true });
    await rig.endTurn(work);
    expect((await post(local, route(id), { decision: 'approve' }, STAFF)).status).toBe(401);
    expect((await post(local, route(id), { decision: 'approve' }, withToken('f'.repeat(64)))).status).toBe(401);
    expect((await post(local, route(id), { decision: 'approve' }, withToken(rig.tokenOf('gio-1', 'gio-s', 'p2')))).status).toBe(403);
    expect((await post(local, route(id), { decision: 'approve' }, { 'x-myco-token': rig.tokenOf('gio-1', 'gio-s') })).status).toBeGreaterThanOrEqual(400);
    expect((await rig.get(id)).status).toBe('planning');
  });

  it.skipIf(process.platform === 'darwin')('pela sandbox do Codex (127.0.0.2): o gestor aprova no projeto da própria conversa; em outro projeto, 403', async () => {
    if (!sandbox) return; // sem o alias 127.0.0.2, nada a provar aqui
    rig = await club('gate-sandbox', { engine: 'codex' });
    const { id, work } = await rig.begin({ planFirst: true });
    await rig.endTurn(work);
    expect((await post(sandbox, route(id, 'p2'), { decision: 'approve' }, withToken(rig.tokenOf('gio-1', 'gio-s')))).status).toBe(403);
    expect((await rig.get(id)).status).toBe('planning');
    const r = await post(sandbox, route(id), { decision: 'approve' }, withToken(rig.tokenOf('gio-1', 'gio-s')));
    expect(r.body.error).toBeUndefined();
    expect(r).toMatchObject({ status: 200, body: { status: 'doing' } });
  });
});