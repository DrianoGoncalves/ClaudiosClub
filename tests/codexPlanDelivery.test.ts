import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Ficha `plan` no Codex (t-930086, follow-up f-527cf3 da t-218ac6): "planejando" só sai pelo cartão de plano do chat, que o Codex não tem, e a entrega do fim do
// turno só partia de "fazendo": o card ficava em planejando para sempre, sem entrega nem revisão, e segurava a fila (caso t-17e624). Agora, no Codex, o fim
// do turno em planejando entrega como em fazendo. No Claude nada muda: planejando segue até o plano ser aprovado.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codexplan-'));
});
afterAll(() => removeTemp(root));

const MIN = 60_000;
const later = (min: number) => new Date(Date.now() + min * MIN);

const people: Record<string, StaffProfile> = {
  'dan-1': { id: 'dan-1', name: 'Daniel', role: 'Analista', autonomy: 'plan', engine: 'codex', worktree: false } as StaffProfile,
  'cla-1': { id: 'cla-1', name: 'Cláudia', role: 'Analista', autonomy: 'plan', engine: 'claude', worktree: false } as StaffProfile,
  'dav-1': { id: 'dav-1', name: 'Davi', role: 'Revisor do quadro', autonomy: 'manual', engine: 'claude', worktree: false } as StaffProfile,
};

async function club(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  // Revisão automática ligada, com o Davi: a entrega do card abre a conversa de revisão dele.
  await fs.writeFile(path.join(dir, '.myco', 'board.json'), JSON.stringify({ autoReview: true, reviewerId: 'dav-1' }));
  const file = path.join(dir, '.myco', 'tasks.json');
  const h = {
    sent: [] as Array<{ staffId: string; session: string; reviewOnly: boolean | undefined }>,
    sentTo: [] as Array<{ session: string; text: string }>,
    working: new Set<string>(),
    logs: [] as string[],
    /** A leitura do disco do projeto falha (o que quebra a gravação do plano aprovado). */
    broken: false,
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => {
      if (h.broken) throw new Error('disco cheio');
      return dir;
    },
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, _text, _force, _override, reviewOnly) => {
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, session, reviewOnly });
      return session;
    },
    sendTo: async (_p, session, _staff, text) => {
      h.sentTo.push({ session, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, _staff, except) => {
      const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
      return [...h.working].some((s) => !skip.includes(s));
    },
    isSessionWorking: (session) => h.working.has(session),
    lastText: () => 'Análise pronta: três pontos de atenção.',
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.1:4849',
    log: (line) => h.logs.push(line),
  });
  const get = async (id: string) => ((await svc.list('p'))!).find((t) => t.id === id)!;
  const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  /** O card do funcionário `staffId` começa (em planejando, pela ficha `plan`). */
  const plan = async (staffId: string, title = 'Analisar o painel') => {
    const t = (await svc.create('p', { title, staffId }))!;
    await svc.start('p', t.id);
    const started = await get(t.id);
    expect(started).toMatchObject({ status: 'planning' });
    return { id: t.id, session: started.sessionId! };
  };
  return { h, svc, get, edit, plan };
}

describe('ficha plan no Codex: o fim do turno em planejando entrega', () => {
  it('fim de turno do Codex (onIdle) → revisão, com delivery e a revisão automática aberta', async () => {
    const b = await club('entrega');
    const { id, session } = await b.plan('dan-1');
    await b.svc.onIdle(session, 'p', 'dan-1', 'turn', 'codex');
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'review', runId: null, reviewRounds: 1, review: { staffId: 'dav-1' } });
    expect(t.delivery).toMatchObject({ summary: 'Análise pronta: três pontos de atenção.' });
    expect(t.history.map((h) => h.status)).toEqual(['todo', 'planning', 'review']);
    expect(t.history.at(-1)).toMatchObject({ by: 'auto', note: 'turno terminou' });
    // A revisão abre sem edição de arquivo (a sandbox do Codex segue só leitura: nada passa a gravar).
    expect(b.h.sent.map((s) => [s.staffId, s.reviewOnly])).toEqual([
      ['dan-1', undefined],
      ['dav-1', true],
    ]);
  });

  it('o outro aviso do mesmo fim de turno (vigia) não entrega de novo nem abre outra revisão', async () => {
    const b = await club('entrega-dupla');
    const { id, session } = await b.plan('dan-1');
    await b.svc.onIdle(session, 'p', 'dan-1', 'turn', 'codex');
    await b.svc.onTurnDone(session);
    expect((await b.get(id)).history.map((h) => h.status)).toEqual(['todo', 'planning', 'review']);
    expect(b.h.sent.filter((s) => s.staffId === 'dav-1')).toHaveLength(1);
  });

  it('a fila dele anda: o card seguinte começa quando o que planejava vai para revisão', async () => {
    const b = await club('fila');
    const first = await b.plan('dan-1', 'Primeiro');
    const second = (await b.svc.create('p', { title: 'Segundo', staffId: 'dan-1' }))!;
    await b.svc.start('p', second.id);
    expect(await b.get(second.id)).toMatchObject({ status: 'todo', sessionId: null }); // espera a vez: o primeiro ocupa o funcionário
    await b.svc.onIdle(first.session, 'p', 'dan-1', 'turn', 'codex');
    await vi.waitFor(async () => expect(await b.get(second.id)).toMatchObject({ status: 'planning', sessionId: expect.any(String) }));
  });

  it('Codex como secundário (ficha do Claude, conversa de trabalho no Codex): entrega; Claude no secundário de ficha Codex, não', async () => {
    const b = await club('secundario');
    const claudeOnCodex = await b.plan('cla-1', 'Ficha Claude, conversa Codex');
    await b.edit(claudeOnCodex.id, (t) => {
      t.sessions[0].engine = 'codex';
      t.fallback = { engine: 'codex', model: 'm', from: 'claude', at: Date.now(), fromSession: null, reason: 'limit-start' };
    });
    await b.svc.onIdle(claudeOnCodex.session, 'p', 'cla-1', 'turn', 'codex');
    expect(await b.get(claudeOnCodex.id)).toMatchObject({ status: 'review' });

    const codexOnClaude = await b.plan('dan-1', 'Ficha Codex, conversa Claude');
    await b.edit(codexOnClaude.id, (t) => {
      t.sessions[0].engine = 'claude';
      t.fallback = { engine: 'claude', model: 'm', from: 'codex', at: Date.now(), fromSession: null, reason: 'limit-start' };
    });
    await b.svc.onTurnDone(codexOnClaude.session); // no Claude o cartão de plano existe: segue planejando
    const held = await b.get(codexOnClaude.id);
    expect(held.status).toBe('planning');
    expect(held.delivery).toBeUndefined();
  });

  it('card antigo sem a conversa registrada (`sessions`): vale o motor da ficha', async () => {
    const b = await club('antigo');
    const codex = await b.plan('dan-1', 'Codex antigo');
    const claude = await b.plan('cla-1', 'Claude antigo');
    await b.edit(codex.id, (t) => delete t.sessions);
    await b.edit(claude.id, (t) => delete t.sessions);
    await b.svc.onTurnDone(codex.session);
    await b.svc.onTurnDone(claude.session);
    expect(await b.get(codex.id)).toMatchObject({ status: 'review' });
    expect(await b.get(claude.id)).toMatchObject({ status: 'planning' });
  });

  it('cancelada em planejando: o fim do turno não entrega', async () => {
    const b = await club('cancelada');
    const { id, session } = await b.plan('dan-1');
    await b.svc.cancel('p', id, { by: 'user', reason: 'não é mais preciso' });
    await b.svc.onIdle(session, 'p', 'dan-1', 'turn', 'codex');
    expect(await b.get(id)).toMatchObject({ status: 'cancelled' });
  });
});

describe('Claude em plan: planejando segue até o plano ser aprovado', () => {
  it('fim de turno sem aprovação (onIdle e vigia) não entrega e não abre revisão; a aprovação leva para fazendo', async () => {
    const b = await club('claude');
    const { id, session } = await b.plan('cla-1');
    await b.svc.onIdle(session, 'p', 'cla-1', 'turn', 'claude');
    await b.svc.onTurnDone(session);
    const waiting = await b.get(id);
    expect(waiting.status).toBe('planning');
    expect(waiting.delivery).toBeUndefined();
    expect(b.h.sent.map((s) => s.staffId)).toEqual(['cla-1']);
    await b.svc.onPlanApproved(session, '1. Ler o painel\n2. Listar os riscos');
    expect(await b.get(id)).toMatchObject({ status: 'doing', plan: '1. Ler o painel\n2. Listar os riscos' });
  });
});

describe('a varredura de órfã vale para planejando no Codex', () => {
  it('card que ficou em planejando com o turno acabado: o tick retoma uma vez e, se a conversa não volta, entrega', async () => {
    const b = await club('orfa-codex');
    const { id, session } = await b.plan('dan-1');
    // Relógio real: a nota da retomada entra no histórico com a hora de agora, depois do `resumedAt` (com relógio simulado à frente, essa ordem não aparece).
    const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();
    await b.edit(id, (t) => {
      t.history.forEach((h: { at: string }) => (h.at = ago(5)));
      t.updatedAt = ago(3);
    });
    await b.svc.tick();
    expect(b.h.sentTo).toHaveLength(1);
    expect(b.h.sentTo[0]!.session).toBe(session);
    const resumed = await b.get(id);
    expect(resumed).toMatchObject({ status: 'planning' });
    expect(resumed.resumedAt).toBeTruthy();
    // A nota da retomada é do histórico em "planejando" (não em "fazendo"): ela não desfaz a retomada, e o que vem depois conta como a segunda.
    await b.edit(id, (t) => {
      t.resumedAt = ago(3);
      t.updatedAt = ago(3);
    });
    await b.svc.tick();
    expect(b.h.sentTo).toHaveLength(1);
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'review' });
    expect(t.history.at(-1)).toMatchObject({ status: 'review', note: 'conversa parou sem terminar' });
  });

  it('a retomada que termina o turno entrega pelo fim de turno de sempre', async () => {
    const b = await club('orfa-codex-volta');
    const { id, session } = await b.plan('dan-1');
    await b.svc.tick(later(3)); // "continue"
    await b.svc.onIdle(session, 'p', 'dan-1', 'turn', 'codex');
    expect(await b.get(id)).toMatchObject({ status: 'review', review: { staffId: 'dav-1' } });
  });

  it('conversa trabalhando: nada acontece', async () => {
    const b = await club('orfa-trabalhando');
    const { id, session } = await b.plan('dan-1');
    b.h.working.add(session);
    await b.svc.tick(later(3));
    await b.svc.tick(later(7));
    expect(b.h.sentTo).toHaveLength(0);
    expect(await b.get(id)).toMatchObject({ status: 'planning' });
  });

  it('Claude em planejando parado (esperando o plano): o tick não mexe', async () => {
    const b = await club('orfa-claude');
    const { id } = await b.plan('cla-1');
    await b.svc.tick(later(3));
    await b.svc.tick(later(7));
    expect(b.h.sentTo).toHaveLength(0);
    const t = await b.get(id);
    expect(t.status).toBe('planning');
    expect(t.resumedAt).toBeUndefined();
  });
});

describe('onPlanApproved: a falha vai para o log', () => {
  it('erro ao gravar o plano aprovado: não estoura, e o log traz a tarefa e a conversa', async () => {
    const b = await club('plano-falha');
    const { id, session } = await b.plan('cla-1');
    b.h.broken = true;
    await expect(b.svc.onPlanApproved(session, '1. Passo')).resolves.toBeUndefined();
    expect(b.h.logs).toHaveLength(1);
    expect(b.h.logs[0]).toContain(`tarefa ${id}`);
    expect(b.h.logs[0]).toContain(`sessão ${session}`);
    expect(b.h.logs[0]).toContain('disco cheio');
    b.h.broken = false;
    expect(await b.get(id)).toMatchObject({ status: 'planning', plan: null }); // nada foi gravado
  });

  it('aprovação que dá certo não escreve no log', async () => {
    const b = await club('plano-ok');
    const { id, session } = await b.plan('cla-1');
    await b.svc.onPlanApproved(session, '1. Passo');
    expect(b.h.logs).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'doing', plan: '1. Passo' });
  });
});
