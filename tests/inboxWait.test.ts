import { readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitInboxItem, deniedInboxItem, followUpInboxItem, heavyGuardOffInboxItem, notStartedInboxItem } from '../server/inboxItems';
import { inboxWaits, taskInboxItems, withInboxWait, type PendingChats } from '../server/inboxWait';
import { TaskService } from '../server/tasks';
import type { ChatItem, Engine, InboxItem, StaffProfile, Task, TaskCommit } from '../shared/model';
import { removeTemp } from './support/tmp';

// `Task.inboxWait` (t-28543e): o card parado esperando alguém agir num item da caixa de entrada, derivado dos itens que a caixa já monta (nada gravado). Marca o que TRAVA o card
// (plano, permissão, dúvida, revisão ou ajuste que não anda, card sem código, dependência empacada) e deixa de fora o que só avisa. Some sozinho quando o item sai.

const at = '2026-11-20T10:00:00.000Z';
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MIN = 60_000;
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();

const mk = (over: Partial<Task> & { id: string }): Task =>
  ({ title: over.id, description: '', status: 'doing', staffId: 'ana-1', sessionId: null, plan: null, branch: null, pr: null, createdAt: at, updatedAt: at, history: [], ...over }) as Task;

type Card = Extract<ChatItem, { kind: 'permission' }>;
/** Um pedido pendente na conversa (o cartão que `ChatManager.attention()` devolve). */
const card = (id: string, over: Partial<Card> = {}): Card =>
  ({ kind: 'permission', id: `p:${id}`, tool: 'Bash', summary: 'npm test', description: null, input: 'npm test', status: 'pending', at: ago(5), ...over }) as Card;
const chat = (sessionId: string, ...pending: Card[]): PendingChats[number] => ({ sessionId, pending });

const escalated = { id: 'q1', source: 'text', text: 'DÚVIDA: qual banco?', status: 'escalated', askedAt: ago(90), escalatedAt: ago(40) } as const;
const asked = (status: 'open' | 'escalated') =>
  ({ id: 'q2', source: 'ask', questions: [{ question: 'Qual banco?', options: ['A', 'B'] }], status, askedAt: ago(90), managerSession: 'm-1', ...(status === 'escalated' && { escalatedAt: ago(40) }) }) as Task['question'];

/** O que o quadro mostra: os itens da caixa para estes cards, e o selo por card. */
const waits = (tasks: Task[], pending: PendingChats = []) => inboxWaits(taskInboxItems(tasks, pending, 'p', NOW), tasks);

describe('prende o card: o selo traz o tipo, de quem é a ação e o item da caixa', () => {
  it('dúvida escalada ao dono: question, owner, id do item doubt:', () => {
    const t = mk({ id: 't-1', sessionId: 's-1', question: escalated });
    expect(waits([t]).get('t-1')).toEqual({ kind: 'question', by: 'owner', itemId: 'doubt:t-1:q1', since: escalated.escalatedAt });
  });

  it('plano pronto na conversa de trabalho: plan, owner', () => {
    const t = mk({ id: 't-1', status: 'planning', sessionId: 's-1' });
    const w = waits([t], [chat('s-1', card('r1', { tool: 'ExitPlanMode', summary: 'plano pronto para aprovar', plan: '# Plano' }))]);
    expect(w.get('t-1')).toEqual({ kind: 'plan', by: 'owner', itemId: 'perm:p:r1', since: ago(5) });
  });

  it('pedido de permissão de ferramenta: permission, owner (na hora, sem esperar os 15 min da parada)', () => {
    const t = mk({ id: 't-1', sessionId: 's-1' });
    expect(waits([t], [chat('s-1', card('r1', { at: ago(1) }))]).get('t-1')).toEqual({ kind: 'permission', by: 'owner', itemId: 'perm:p:r1', since: ago(1) });
  });

  it('a conversa da revisão também prende o card que está em revisão', () => {
    const t = mk({ id: 't-1', status: 'review', sessionId: 's-1', review: { sessionId: 'rv-1', staffId: 'rev-1', at: ago(10) } as Task['review'] });
    expect(waits([t], [chat('rv-1', card('r1'))]).get('t-1')).toMatchObject({ kind: 'permission', by: 'owner' });
  });

  it('pergunta por opções pendente: com o gestor (manager) até escalar, com o dono depois; sem dúvida na tarefa é permissão do dono', () => {
    const open = mk({ id: 't-1', sessionId: 's-1', question: asked('open') });
    expect(waits([open], [chat('s-1', card('a1', { tool: 'AskUserQuestion' }))]).get('t-1')).toMatchObject({ kind: 'question', by: 'manager', itemId: 'perm:p:a1' });
    const up = mk({ id: 't-1', sessionId: 's-1', question: asked('escalated') });
    expect(waits([up], [chat('s-1', card('a1', { tool: 'AskUserQuestion' }))]).get('t-1')).toMatchObject({ kind: 'question', by: 'owner' });
    const alone = mk({ id: 't-1', sessionId: 's-1' });
    expect(waits([alone], [chat('s-1', card('a1', { tool: 'AskUserQuestion' }))]).get('t-1')).toMatchObject({ kind: 'permission', by: 'owner' });
  });

  it('revisão automática que não começou: review, owner', () => {
    const t = mk({ id: 't-1', status: 'review', reviewerId: 'rev-1', reviewRetry: { attempts: 4, firstAt: ago(45), nextAt: ago(1), lastError: 'sem conversa', deliveryAt: null } });
    expect(waits([t]).get('t-1')).toEqual({ kind: 'review', by: 'owner', itemId: 'stuck:t-1:review', since: ago(45) });
  });

  it('ajuste guardado que não chega ao funcionário: resend, owner', () => {
    const t = mk({ id: 't-1', held: [{ id: 'h1', text: 'ajuste', at: ago(30), attempts: 5 }] as Task['held'] });
    expect(waits([t]).get('t-1')).toMatchObject({ kind: 'resend', by: 'owner', itemId: 'stuck:t-1:resend', since: ago(30) });
  });

  it('card sem código esperando o dono: noCode, owner; se quem decide é o gestor, o dono não tem item e nada é marcado', () => {
    const owner = mk({ id: 't-1', sessionId: 's-1', noCode: { since: ago(20), to: 'owner', summary: 'Respondi.' } });
    expect(waits([owner]).get('t-1')).toEqual({ kind: 'noCode', by: 'owner', itemId: 'stuck:t-1:decide', since: ago(20) });
    const manager = mk({ id: 't-2', sessionId: 's-2', noCode: { since: ago(20), to: 'manager', summary: 'Respondi.' } });
    expect(waits([manager]).has('t-2')).toBe(false);
  });

  it('dependência empacada: quem espera é marcado com a bloqueadora; a bloqueadora tem o selo dela', () => {
    const blocker = mk({ id: 't-1', sessionId: 's-1', question: escalated });
    const dep = mk({ id: 't-2', status: 'todo', sessionId: null, blockedBy: ['t-1'] });
    const w = waits([blocker, dep]);
    expect(w.get('t-2')).toMatchObject({ kind: 'blocked', by: 'owner', blockerId: 't-1', itemId: 'blocked:t-2:t-1' });
    expect(w.get('t-1')).toMatchObject({ kind: 'question' });
  });

  it('bloqueadora cancelada: quem espera é marcado (a decisão é do dono); depois de "continuar esperando", não', () => {
    const blocker = mk({ id: 't-1', status: 'cancelled', cancelReason: 'mudou o plano', cancelledAt: ago(60) });
    const dep = mk({ id: 't-2', status: 'todo', blockedBy: ['t-1'] });
    expect(waits([blocker, dep]).get('t-2')).toMatchObject({ kind: 'blocked', blockerId: 't-1' });
    const decided = { ...dep, ackCancelled: [{ id: 't-1', at: ago(5) }] } as Task;
    expect(waits([blocker, decided]).has('t-2')).toBe(false);
    expect(waits([blocker]).size).toBe(0); // a cancelada em si está fechada
  });
});

describe('só avisa: não marca o card', () => {
  const place = { projectId: 'p', projectName: 'P', sessionId: 's-1', staffId: 'ana-1', name: 'Ana' };
  const noStaff = { projectId: 'p', projectName: 'P', sessionId: '', name: 'Ana' };

  it('follow-up esperando o dono, cartão esquecido em "a fazer", commit automático barrado, ação barrada e fila desligada não prendem', () => {
    const t = mk({ id: 't-1', sessionId: 's-1' });
    const followUp = { id: 'f-1', by: 'rev-1', at: ago(30), text: 'Melhorar o log.', status: 'open', to: 'owner' } as NonNullable<Task['followUps']>[number];
    const commit = { for: at, at: ago(5), status: 'failed', sha: null, files: [], left: [], note: 'sem permissão', alert: true } as TaskCommit;
    const items: InboxItem[] = [
      followUpInboxItem({ task: t, followUp }, noStaff, 'Tupac'),
      notStartedInboxItem({ task: mk({ id: 't-2', status: 'todo' }), days: 3 }, noStaff),
      commitInboxItem({ task: t, commit }, noStaff),
      deniedInboxItem({ id: 'denied:s-1:1', sessionId: 's-1', taskId: 't-1', taskTitle: 't-1', shown: { tool: 'Bash', layer: 'settings', hint: null, text: 'barrado' } as never, count: 1, tools: ['Bash'], at: ago(3) }, place),
      heavyGuardOffInboxItem({ id: 'guardoff:s-1', sessionId: 's-1', taskId: 't-1', taskTitle: 't-1', file: 'hooks.json', at: ago(3) }, place),
    ];
    expect(items.map((i) => i.kind)).toEqual(['followUp', 'notStarted', 'error', 'denied', 'error']);
    expect(inboxWaits(items, [t, mk({ id: 't-2', status: 'todo' })]).size).toBe(0);
  });

  it('o que se resolve sozinho não prende: espera do limite do motor, e quem depende dela', () => {
    const blocker = mk({ id: 't-1', status: 'todo', fallbackBlocked: { reason: 'sandbox', detail: 'x', engine: 'codex', from: 'claude', since: ago(10), until: null } as Task['fallbackBlocked'] });
    const dep = mk({ id: 't-2', status: 'todo', blockedBy: ['t-1'] });
    const items = taskInboxItems([blocker, dep], [], 'p', NOW);
    expect(items.map((i) => i.id).sort()).toEqual(['blocked:t-2:t-1', 'stuck:t-1:fallback']); // a caixa mostra os dois
    expect(inboxWaits(items, [blocker, dep]).size).toBe(0); // e nenhum trava
  });

  it('dúvida com o gestor (ainda não escalada) e card sem pendência: nada', () => {
    const t = mk({ id: 't-1', sessionId: 's-1', question: asked('open') });
    expect(waits([t]).size).toBe(0);
  });

  it('permissão pendente fora do alcance do card: card automático, conversa de trabalho de card em revisão, conversa que não é de card', () => {
    const auto = mk({ id: 't-1', sessionId: 's-1', autoCreated: true });
    const inReview = mk({ id: 't-2', status: 'review', sessionId: 's-2' });
    expect(waits([auto, inReview], [chat('s-1', card('r1')), chat('s-2', card('r2')), chat('solta', card('r3'))]).size).toBe(0);
  });

  it('item já resolvido (resolvedAt) não conta', () => {
    const t = mk({ id: 't-1', sessionId: 's-1', question: escalated });
    const items = taskInboxItems([t], [], 'p', NOW).map((i) => ({ ...i, resolvedAt: ago(1) }));
    expect(items).toHaveLength(1);
    expect(inboxWaits(items, [t]).size).toBe(0);
  });
});

describe('resolvido ou dispensado: o selo some sozinho', () => {
  it('permissão respondida (permitir ou negar): o cartão sai de pendente', () => {
    const t = mk({ id: 't-1', sessionId: 's-1' });
    expect(waits([t], [chat('s-1', card('r1'))]).has('t-1')).toBe(true);
    expect(waits([t], [chat('s-1')]).has('t-1')).toBe(false);
    expect(waits([t], []).has('t-1')).toBe(false); // conversa fechada: o pedido caiu junto
  });

  it('dúvida respondida: a tarefa deixa de ter dúvida escalada', () => {
    const t = mk({ id: 't-1', sessionId: 's-1', question: escalated });
    expect(waits([t]).has('t-1')).toBe(true);
    const answered = { ...t, question: { ...escalated, status: 'answered', answeredBy: 'user', answeredAt: ago(1) } } as Task;
    expect(waits([answered]).has('t-1')).toBe(false);
  });

  it('card sem código: devolvido ao responsável (marca desfeita) ou cancelado', () => {
    const t = mk({ id: 't-1', sessionId: 's-1', noCode: { since: ago(20), to: 'owner' } });
    expect(waits([t]).has('t-1')).toBe(true);
    expect(waits([{ ...t, noCode: undefined }]).has('t-1')).toBe(false);
    expect(waits([{ ...t, status: 'cancelled' } as Task]).has('t-1')).toBe(false);
  });

  it('revisão que andou (a revisão abriu): o item de parada sai', () => {
    const t = mk({ id: 't-1', status: 'review', reviewerId: 'rev-1', reviewRetry: { attempts: 4, firstAt: ago(45), nextAt: ago(1), deliveryAt: null } });
    expect(waits([t]).has('t-1')).toBe(true);
    // Sem o retry e SEM revisão aberta, a regra "ninguém revisou" (`stuckState`) segura o card parado: andar de verdade é a revisão abrir (`liveReview`).
    const opened = { ...t, reviewRetry: undefined, review: { sessionId: 'rv-1', staffId: 'rev-1', at: ago(1) } } as Task;
    expect(waits([opened]).has('t-1')).toBe(false);
    expect(waits([{ ...t, status: 'done' } as Task]).has('t-1')).toBe(false);
  });

  it('revisão que nunca começou (sem retry nem revisão aberta): prende depois de 30 min em revisão, antes não', () => {
    const late = mk({ id: 't-1', status: 'review', reviewerId: 'rev-1', updatedAt: ago(120) });
    expect(waits([late]).get('t-1')).toMatchObject({ kind: 'review', by: 'owner', itemId: 'stuck:t-1:review' });
    expect(waits([{ ...late, updatedAt: ago(5) }]).has('t-1')).toBe(false);
  });

  it('bloqueadora pronta, ou dependência retirada: quem esperava sai do selo', () => {
    const blocker = mk({ id: 't-1', sessionId: 's-1', question: escalated });
    const dep = mk({ id: 't-2', status: 'todo', blockedBy: ['t-1'] });
    expect(waits([blocker, dep]).has('t-2')).toBe(true);
    expect(waits([{ ...blocker, status: 'done' } as Task, dep]).has('t-2')).toBe(false);
    expect(waits([blocker, { ...dep, blockedBy: [] }]).has('t-2')).toBe(false);
  });

  it('card encerrado não leva selo, mesmo com o item ainda na lista', () => {
    const t = mk({ id: 't-1', sessionId: 's-1', question: escalated });
    const items = taskInboxItems([t], [], 'p', NOW);
    expect(items).toHaveLength(1);
    expect(inboxWaits(items, [{ ...t, status: 'done' } as Task]).size).toBe(0);
  });
});

describe('mais de um item no mesmo card', () => {
  it('vale o de maior prioridade: plano antes de dúvida, dúvida antes de dependência', () => {
    const t = mk({ id: 't-1', status: 'planning', sessionId: 's-1', question: escalated });
    expect(waits([t], [chat('s-1', card('r1', { tool: 'ExitPlanMode', plan: '# Plano' }))]).get('t-1')).toMatchObject({ kind: 'plan', itemId: 'perm:p:r1' });
    expect(waits([t]).get('t-1')).toMatchObject({ kind: 'question' });
  });

  it('empate de tipo: o item mais antigo', () => {
    const t = mk({ id: 't-1', sessionId: 's-1' });
    expect(waits([t], [chat('s-1', card('novo', { at: ago(2) }), card('velho', { at: ago(20) }))]).get('t-1')).toMatchObject({ itemId: 'perm:p:velho', since: ago(20) });
  });
});

// ---- a listagem (GET /tasks): TaskService.list + withInboxWait, com ficha Claude e Codex ----

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-inboxwait-'));
});
afterAll(() => removeTemp(root));

async function project(name: string, engine: Engine, tasks: Array<Partial<Task> & { id: string }>) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const full = tasks.map((t) => ({ title: t.id, description: '', status: 'todo', staffId: 'ana-1', sessionId: null, plan: null, branch: null, pr: null, createdAt: at, updatedAt: at, history: [], ...t }));
  await fs.writeFile(path.join(dir, '.myco', 'tasks.json'), JSON.stringify(full));
  const ana = { id: 'ana-1', name: 'Ana', engine, autonomy: 'acceptEdits', worktree: false } as StaffProfile;
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
    apiUrl: 'http://127.0.0.1:4848',
    send: async () => 's-novo',
    branchFor: async () => 'main',
    log: () => {},
  });
  return { svc, dir };
}

describe.each<Engine>(['claude', 'codex'])('GET /tasks com ficha %s', (engine) => {
  const board = [
    { id: 't-1', status: 'doing', sessionId: 's-1', question: escalated },
    { id: 't-2', status: 'todo', blockedBy: ['t-1'] },
    { id: 't-3', status: 'doing', sessionId: 's-3' },
    { id: 't-4', status: 'done', followUps: [{ id: 'f-1', by: 'rev-1', at: ago(30), text: 'Melhorar o log.', status: 'open', to: 'owner' }] },
  ] as Array<Partial<Task> & { id: string }>;

  it('o card parado leva `inboxWait`; o que só tem aviso (follow-up) e o livre, não', async () => {
    const { svc } = await project(`list-${engine}`, engine, board);
    const list = withInboxWait(await svc.list('p'), 'p', [])!;
    const by = (id: string) => list.find((t) => t.id === id)!;
    expect(by('t-1').inboxWait).toMatchObject({ kind: 'question', by: 'owner', itemId: 'doubt:t-1:q1' });
    expect(by('t-2').inboxWait).toMatchObject({ kind: 'blocked', blockerId: 't-1' });
    expect(by('t-3').inboxWait).toBeUndefined();
    expect('inboxWait' in by('t-3')).toBe(false); // ausente, não nulo
    expect(by('t-4').inboxWait).toBeUndefined();
    expect(Object.keys(by('t-1').inboxWait!).sort()).toEqual(['by', 'itemId', 'kind', 'since']);
  });

  it('permissão pendente na conversa de trabalho entra pelo que a caixa lê (`attention`)', async () => {
    const { svc } = await project(`perm-${engine}`, engine, board);
    const list = withInboxWait(await svc.list('p'), 'p', [chat('s-3', card('r9'))])!;
    expect(list.find((t) => t.id === 't-3')!.inboxWait).toMatchObject({ kind: 'permission', by: 'owner', itemId: 'perm:p:r9' });
  });

  it('não é gravado: o arquivo das tarefas não ganha o campo, e responder tira o selo na leitura seguinte', async () => {
    const { svc, dir } = await project(`file-${engine}`, engine, board);
    withInboxWait(await svc.list('p'), 'p', [chat('s-3', card('r9'))]);
    expect(readFileSync(path.join(dir, '.myco', 'tasks.json'), 'utf8')).not.toContain('inboxWait');
    const after = withInboxWait(await svc.list('p'), 'p', [])!;
    expect(after.find((t) => t.id === 't-3')!.inboxWait).toBeUndefined();
  });
});

describe('a rota e a falha', () => {
  it('projeto desconhecido (lista nula) passa direto', () => {
    expect(withInboxWait(null, 'x', [])).toBeNull();
  });

  it('erro ao calcular não derruba o quadro: a lista sai como estava', () => {
    const list = [mk({ id: 't-1', sessionId: 's-1', question: escalated })];
    expect(withInboxWait(list, 'p', [{ sessionId: 's-1', pending: null } as never])).toBe(list);
  });

  it('o GET das tarefas passa pela derivação, com os pedidos pendentes que a caixa lê', () => {
    const index = readFileSync(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('withInboxWait(await tasks.list(id!), id!, chats.attention())');
  });
});
