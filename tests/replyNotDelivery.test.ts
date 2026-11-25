import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskSecretQuery } from '../server/chat/secrets';
import { TaskService } from '../server/tasks';
import type { BackgroundTask, StaffProfile, Task, TurnCapHit } from '../shared/model';
import { removeTemp } from './support/tmp';

// O card reflete o que a conversa de fato entregou (t-95cc72, casos de 20/11):
// (1) resposta a mensagem ou aviso não vira a entrega (t-8435b1: "Aviso visto…" sobrescreveu a entrega completa e abriu outra rodada de revisão);
// (2) "parou no meio" com o turno vivo: o turno que termina normal tira o card de Aguardar e grava a entrega (t-3dbd93);
// (3) o valor de `?code=` (código de pareamento) não fica em nota, histórico nem motivo de espera.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-reply-'));
});
afterAll(() => removeTemp(root));

const profile = (id: string, name: string) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, engine: 'claude' }) as StaffProfile;
const FULL = ['1. Critério de pronto', '   - 1: feito', '2. tsc: limpo', '3. Testes do tema: 12 passaram', '', '- `src/a.ts`: o que o pedido pedia', '- `tests/a.test.ts`: prova do caso'].join('\n');
const NOTICE_REPLY = 'Aviso visto: styles.css também é editado por outra tarefa. Sigo sem mexer nele.';
const PAIR = 'http://127.0.0.1:5175/api/pair?code=mwp4h60q.WisPwZXvUwJjjSGc_JMjhw.fJxo3csAb';

/** Ana trabalha, Giovana pediu a tarefa. Cada `club` precisa da sua pasta (senão herda o tasks.json do teste anterior). */
async function club(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const people: Record<string, StaffProfile> = { 'ana-1': profile('ana-1', 'Ana'), 'gio-1': profile('gio-1', 'Giovana') };
  const h = {
    notified: [] as Array<{ staffId: string; text: string }>,
    working: new Set<string>(),
    live: {} as Record<string, { busy: boolean; background: BackgroundTask[] }>,
    texts: {} as Record<string, string>,
    cap: null as TurnCapHit | null,
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId) => `${staffId}-${++h.n}`,
    branchFor: async () => null,
    isWorking: (_p, _s, except) => {
      const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
      return [...h.working].some((s) => !skip.includes(s));
    },
    sendTo: async (_p, sessionId) => sessionId,
    notify: async (_p, staffId, text) => {
      h.notified.push({ staffId, text });
    },
    lastText: (s) => h.texts[s] ?? null,
    liveWork: (s: string) => h.live[s] ?? null,
    turnCap: () => h.cap,
  });
  const all = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await all()).find((t) => t.id === id)!;
  const file = path.join(dir, '.myco', 'tasks.json');
  const patch = async (id: string, fields: Partial<Task>) => {
    const tasks = JSON.parse(await fs.readFile(file, 'utf8')) as Task[];
    Object.assign(tasks.find((t) => t.id === id)!, fields);
    await fs.writeFile(file, JSON.stringify(tasks));
  };
  return { h, svc, get, all, patch, dir };
}
type Club = Awaited<ReturnType<typeof club>>;

const live = (b: Club, work: string, busy: boolean) => {
  b.h.live[work] = { busy, background: [] };
  if (busy) b.h.working.add(work);
  else b.h.working.delete(work);
};

/** A tarefa da Ana, pedida pela Giovana, começada: a conversa de trabalho está no turno. */
async function comecar(b: Club, title = 'Tela') {
  const task = (await b.svc.create('p', { title, description: 'Ajuste a tela', staffId: 'ana-1', reviewerId: null }, 'gio-1', 'gio-s'))!;
  await b.svc.start('p', task.id);
  const work = (await b.get(task.id)).sessionId!;
  live(b, work, true);
  return { id: task.id, work };
}

/** O turno acaba com `text`: o vigia de sessões avisa. */
async function fim(b: Club, work: string, text: string) {
  b.h.texts[work] = text;
  live(b, work, false);
  await b.svc.onTurnDone(work);
}

/** O card entregue (o turno 1 editou `src/a.ts`) e já em revisão, com a entrega completa gravada. */
async function entregue(b: Club, title: string) {
  const { id, work } = await comecar(b, title);
  await b.svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: b.dir, files: [path.join(b.dir, 'src', 'a.ts')], request: 'x' });
  await fim(b, work, FULL);
  const t = await b.get(id);
  expect(t.status).toBe('review');
  expect(t.delivery?.summary).toBe(FULL);
  return { id, work, first: t };
}

/** Chega mensagem na conversa de trabalho (você respondeu): em revisão, o card volta a "fazendo" e o turno que vem responde a ela. */
async function mensagem(b: Club, work: string) {
  await b.svc.onSent(work);
  live(b, work, true);
}

const reviewEntries = (t: Task) => t.history.filter((h) => h.status === 'review').length;

describe('(1) resposta a mensagem ou aviso não sobrescreve a entrega', () => {
  it('caso t-8435b1: a resposta "Aviso visto…" deixa a entrega anterior, sem rodada nova e sem novo aviso a quem pediu', async () => {
    const b = await club('aviso');
    const { id, work, first } = await entregue(b, 'Aviso');
    const notified = b.h.notified.length;
    const entries = reviewEntries(first);

    await mensagem(b, work);
    expect((await b.get(id)).status).toBe('doing'); // "você respondeu"
    await fim(b, work, NOTICE_REPLY);

    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery).toEqual(first.delivery); // a entrega completa segue, com o resumo, as notas e a hora de antes
    expect(t.delivery?.summary).not.toContain('Aviso visto');
    expect(t.history.at(-1)?.note).toContain('a entrega anterior segue valendo');
    expect(reviewEntries(t)).toBe(entries + 1); // só a volta para revisão desta resposta, nenhuma entrega nova
    expect(t.history.some((h) => h.note === 'turno terminou' && h.at > first.delivery!.at)).toBe(false);
    expect(t.reopened).toBeUndefined();
    expect(b.h.notified).toHaveLength(notified); // quem pediu não é avisado de uma entrega que não houve
    expect(t.reviewRounds).toBe(first.reviewRounds);
  });

  it('o aviso que a plataforma envia no meio do turno reaberto também não vira entrega (sem edição, sem formato)', async () => {
    const b = await club('aviso-meio');
    const { id, work, first } = await entregue(b, 'Aviso meio');
    await mensagem(b, work);
    // O aviso de arquivo em comum chega com o turno em andamento; o fim do turno responde só a ele.
    await fim(b, work, 'Aviso visto. Não preciso responder.');
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.at).toBe(first.delivery!.at);
  });

  it('o que a revisão guardava volta junto (espera do dono, mescla automática)', async () => {
    const b = await club('guarda');
    const { id, work, first } = await entregue(b, 'Guarda');
    const gate = { deliveryAt: first.delivery!.at, since: new Date().toISOString(), why: 'approved' as const, by: 'Dave' };
    await b.patch(id, { ownerGate: gate });
    await mensagem(b, work);
    const doing = await b.get(id);
    expect(doing.ownerGate).toBeUndefined(); // saiu de revisão: a espera era da entrega que acabou
    await fim(b, work, 'Só uma pergunta: posso ignorar o aviso?');
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.ownerGate).toEqual(gate);
  });

  it('o turno que EDITOU entrega de verdade, mesmo com o arquivo já na lista e a resposta curta', async () => {
    const b = await club('editou');
    const { id, work, first } = await entregue(b, 'Editou');
    const notified = b.h.notified.length;
    await mensagem(b, work);
    await b.svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: b.dir, files: [path.join(b.dir, 'src', 'a.ts')], request: 'x' }); // já estava em changedFiles
    await fim(b, work, 'Feito o ajuste que você pediu.');
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe('Feito o ajuste que você pediu.');
    expect(t.delivery?.at).not.toBe(first.delivery!.at);
    expect(t.history.at(-1)?.note).toBe('turno terminou'); // entrega normal: a nota do fim de turno, não a da resposta
    expect(b.h.notified.length).toBeGreaterThan(notified); // e quem pediu é avisado da entrega nova
  });

  it('resposta que traz a entrega no formato (linha por arquivo, ou "Critério de pronto") também entrega, sem edição vista', async () => {
    for (const [name, text] of [
      ['linhas', 'Refeito.\n\n- `src/a.ts`: ajustei o nome da prop'],
      ['criterio', '**Critério de pronto**\n- 1: feito'],
    ] as const) {
      const b = await club(`formato-${name}`);
      const { id, work, first } = await entregue(b, `Formato ${name}`);
      await mensagem(b, work);
      await fim(b, work, text);
      const t = await b.get(id);
      expect(t.status).toBe('review');
      expect(t.delivery?.summary).toBe(text);
      expect(t.delivery?.at).not.toBe(first.delivery!.at);
    }
  });

  it('o ajuste da reprovação (a mensagem que a leva à conversa) segue entregando a resposta, mesmo sem edição', async () => {
    const b = await club('reprovada');
    const { id, work, first } = await entregue(b, 'Reprovada');
    // A reprovação desta entrega está gravada e sem resposta: o ajuste que chega depois é o dela, e o turno que o responde é entrega.
    const rejection = { round: 1, at: new Date().toISOString(), deliveryAt: first.delivery!.at, reviewer: { staffId: 'gio-1', name: 'Giovana', sessionId: 'rev-s' }, block: 'ok', blockers: [] };
    await b.patch(id, { rejections: [rejection] } as Partial<Task>);
    await mensagem(b, work);
    expect((await b.get(id)).reopened).toBeUndefined();
    await fim(b, work, 'Discordo do ponto 2: o teste cobre o caso.');
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe('Discordo do ponto 2: o teste cobre o caso.');
    expect(t.rejections?.[0]?.reply?.text).toBe('Discordo do ponto 2: o teste cobre o caso.');
  });
});

describe('(2) "parou no meio" com o turno vivo', () => {
  const cut: TurnCapHit = { kind: 'restart', action: `mcp__myco-navegador__browser_navigate: ${PAIR}` };

  it('o turno termina normal com o card em Aguardar por parada presumida: sai de Aguardar para revisão, com a entrega gravada', async () => {
    const b = await club('presumida');
    const { id, work } = await comecar(b, 'Presumida');
    await b.svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: b.dir, files: [path.join(b.dir, 'src', 'a.ts')], request: 'x' });
    // A conferência marcou "parou no meio" (a conversa estava viva, ou voltou logo depois): o card foi para Aguardar.
    b.h.cap = cut;
    live(b, work, false);
    await b.svc.onTurnDone(work);
    const waiting = await b.get(id);
    expect(waiting).toMatchObject({ status: 'waiting', waitCut: { at: expect.any(String) } });
    expect(waiting.delivery).toBeUndefined();

    // O turno da conversa segue e termina normal (a parada guardada já saiu, como na mensagem ou no fim de turno `ok`).
    b.h.cap = null;
    live(b, work, true);
    await fim(b, work, FULL);
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.delivery?.summary).toBe(FULL);
    expect(t.waitReason).toBeNull();
    expect(t.waitCut).toBeUndefined();
    expect(t.history.some((h) => h.status === 'doing' && /parada presumida/.test(h.note ?? ''))).toBe(true);
    expect(b.h.notified.some((n) => n.staffId === 'gio-1' && n.text.includes('entregou a tarefa'))).toBe(true);
  });

  it('a saída do processo (`exit`: você fechou a conversa, ou ela caiu) não desfaz a parada presumida', async () => {
    const b = await club('presumida-exit');
    const { id, work } = await comecar(b, 'Exit');
    b.h.cap = cut;
    live(b, work, false);
    await b.svc.onTurnDone(work);
    b.h.cap = null;
    b.h.texts[work] = FULL;
    await b.svc.onIdle(work, 'p', 'ana-1', 'exit', 'claude');
    const t = await b.get(id);
    expect(t.status).toBe('waiting');
    expect(t.delivery).toBeUndefined();
  });

  it('Aguardar por outro motivo (você pôs lá) não sai sozinho com o fim do turno', async () => {
    const b = await club('aguardar-manual');
    const { id, work } = await comecar(b, 'Manual');
    await b.svc.update('p', id, { status: 'waiting', waitReason: 'esperando o cliente' });
    b.h.texts[work] = FULL;
    live(b, work, false);
    await b.svc.onTurnDone(work);
    expect(await b.get(id)).toMatchObject({ status: 'waiting', waitReason: 'esperando o cliente' });
  });

  it('com a parada ainda guardada (teto, ação cortada de fato) o card segue em Aguardar', async () => {
    const b = await club('parada-guardada');
    const { id, work } = await comecar(b, 'Guardada');
    b.h.cap = cut;
    live(b, work, false);
    await b.svc.onTurnDone(work);
    b.h.texts[work] = FULL; // outro fim de turno, mas a parada ainda vale
    await b.svc.onTurnDone(work);
    const t = await b.get(id);
    expect(t.status).toBe('waiting');
    expect(t.delivery).toBeUndefined();
  });
});

describe('(3) o valor de ?code= não fica gravado', () => {
  it('maskSecretQuery: troca o valor dos parâmetros de segredo e deixa o resto', () => {
    expect(maskSecretQuery(PAIR)).toBe('http://127.0.0.1:5175/api/pair?code=[segredo]');
    expect(maskSecretQuery('GET /cb?state=ok&access_token=abc.def-1&x=2#frag')).toBe('GET /cb?state=ok&access_token=[segredo]&x=2#frag');
    expect(maskSecretQuery('https://a.b/c?api_key=k1&client_secret=s2 e "https://a.b/d?password=p3"')).toBe('https://a.b/c?api_key=[segredo]&client_secret=[segredo] e "https://a.b/d?password=[segredo]"');
    expect(maskSecretQuery('http://a.b/c?page=2&sort=asc')).toBe('http://a.b/c?page=2&sort=asc');
    expect(maskSecretQuery('sem url, só texto: code review pronto')).toBe('sem url, só texto: code review pronto');
    expect(maskSecretQuery(maskSecretQuery(PAIR))).toBe(maskSecretQuery(PAIR)); // idempotente
    expect(maskSecretQuery('?code=mwp4h60q.WisPw…')).toBe('?code=[segredo]'); // texto cortado no meio do código
  });

  it('a parada por ação cortada com o código na URL: nota, histórico e motivo de espera saem sem o código', async () => {
    const b = await club('mascara');
    const { id, work } = await comecar(b, 'Máscara');
    // A ação vem como foi guardada antes desta correção (o resumo da ação ainda com o código inteiro).
    b.h.cap = { kind: 'restart', action: `mcp__myco-navegador__browser_navigate: ${PAIR}` };
    live(b, work, false);
    await b.svc.onTurnDone(work);
    const t = await b.get(id);
    expect(t.status).toBe('waiting');
    expect(t.waitReason).toContain('?code=[segredo]');
    const stored = JSON.stringify(await fs.readFile(path.join(b.dir, '.myco', 'tasks.json'), 'utf8'));
    expect(stored).not.toContain('mwp4h60q');
    expect(stored).not.toContain('WisPwZXvUwJjjSGc');
    for (const h of t.history) expect(h.note ?? '').not.toContain('mwp4h60q');
  });

  it('motivo de espera escrito à mão e notas do histórico também passam pela máscara', async () => {
    const b = await club('mascara-mao');
    const { id } = await comecar(b, 'Mão');
    const out = await b.svc.update('p', id, { status: 'waiting', waitReason: `confira ${PAIR}` });
    expect(out?.waitReason).toBe('confira http://127.0.0.1:5175/api/pair?code=[segredo]');
    const stored = await fs.readFile(path.join(b.dir, '.myco', 'tasks.json'), 'utf8');
    expect(stored).not.toContain('mwp4h60q');
  });
});
