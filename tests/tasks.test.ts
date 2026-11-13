import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile, TurnCapHit } from '../shared/model';
import { ChatClosingError, ChatManager, PLAN_REJECTED_MESSAGE } from '../server/chat/manager';
import { parseVerdict, TaskConflictError, TaskForbiddenError, TaskService } from '../server/tasks';
import type { Reservation } from '../server/resourceGate';
import { cleanRunDir } from '../server/runCleanup';
import { UsageStopError } from '../server/usageStop';
import { REQUESTER_ASK_INTERVAL_MS, REQUESTER_ASK_MAX_BYTES, RequesterAskLimiter } from '../server/chat/requesterAsk';
import { isUnverifiedOrigin, staffOrigin } from '../server/chat/origin';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-tasks-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function service(dirName: string, autonomy: StaffProfile['autonomy'] = 'acceptEdits') {
  const dir = path.join(root, dirName);
  const sent: Array<{ staffId: string; text: string }> = [];
  const ana = { id: 'ana-1', name: 'Ana', autonomy, worktree: true } as StaffProfile;
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
    send: async (_p, staffId, text) => {
      sent.push({ staffId, text });
      return 'sess-1';
    },
    branchFor: async (_d, p) => (p.worktree ? `myco/${p.id}` : 'main'),
  });
  return { svc, sent, dir };
}

describe('limpeza de ~/.myco/run', () => {
  it('apaga só pastas de sessão antigas; arquivos e pastas com outro nome ficam', async () => {
    const run = path.join(root, 'run');
    const oldId = '11111111-2222-3333-4444-555555555555';
    const newId = '66666666-7777-8888-9999-000000000000';
    for (const d of [oldId, newId, 'outra-coisa']) {
      await fs.mkdir(path.join(run, d), { recursive: true });
      await fs.writeFile(path.join(run, d, 'mcp.json'), '{}');
    }
    await fs.writeFile(path.join(run, 'chats.json'), '{}');
    const old = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    await fs.utimes(path.join(run, oldId), old, old);
    await fs.utimes(path.join(run, 'outra-coisa'), old, old);
    expect(await cleanRunDir(run)).toBe(1);
    expect((await fs.readdir(run)).sort()).toEqual([newId, 'chats.json', 'outra-coisa'].sort());
  });
});

describe('limites da dúvida ao gestor', () => {
  it('conta bytes UTF-8, rejeita anexos, e limita por conversa a uma pergunta por minuto', () => {
    const limiter = new RequesterAskLimiter();
    expect(limiter.check('p:s1', 'pergunta', false, 1_000)).toBeNull();
    expect(limiter.reserve('p:s1', 1_000)).not.toBeNull();
    expect(limiter.check('p:s1', 'outra', false, 1_001)).toBe('rate-limited');
    expect(limiter.reserve('p:s1', 1_001)).toBeNull();
    expect(limiter.reserve('p:s2', 1_001)).not.toBeNull();
    expect(limiter.check('p:s3', 'é'.repeat(2_048), false, 2_000)).toBeNull();
    expect(limiter.check('p:s4', 'é'.repeat(2_049), false, 2_000)).toBe('too-large');
    expect(limiter.check('p:s5', 'pergunta', true, 2_000)).toBe('attachments');
    expect(limiter.check('p:s1', 'liberada após um minuto', false, 61_000)).toBeNull();
  });
});

describe('tarefas por projeto', () => {
  it('cria, começa numa conversa nova e anda sozinha: fazendo → revisão → fazendo', async () => {
    const { svc, sent, dir } = service('a');
    const t = (await svc.create('p', { title: 'Botão de exportar', description: 'CSV na tela de relatórios', staffId: 'ana-1' }))!;
    expect(t).toMatchObject({ status: 'todo', staffId: 'ana-1', sessionId: null });

    const started = (await svc.start('p', t.id))!;
    expect(started).toMatchObject({ status: 'doing', sessionId: 'sess-1', branch: 'myco/ana-1' });
    expect(sent[0]!.text).toContain('[Tarefa "Botão de exportar"]');
    expect(sent[0]!.text).toContain('CSV na tela de relatórios');
    await expect(svc.start('p', t.id)).rejects.toThrow(/já começou/);

    await svc.onTurnDone('sess-1');
    expect((await svc.list('p'))![0]!.status).toBe('review');
    await svc.onSent('sess-1');
    expect((await svc.list('p'))![0]!.status).toBe('doing');
    await svc.onTurnDone('outra-sessao'); // de outra conversa: nada muda
    expect((await svc.list('p'))![0]!.status).toBe('doing');

    // Fica no disco do projeto, com o histórico das colunas.
    const saved = JSON.parse(await fs.readFile(path.join(dir, '.myco', 'tasks.json'), 'utf8'));
    expect(saved[0].history.map((h: { status: string }) => h.status)).toEqual(['todo', 'doing', 'review', 'doing']);
  });

  it('arquiva do quadro só o Pronto parado há mais de 7 dias; mexer na tarefa tira do arquivo', async () => {
    const { svc, dir } = service('arq');
    const ids: string[] = [];
    for (const title of ['d-velha', 'l-velha', 'd-nova', 'rev-velha', 'doing-velha']) ids.push((await svc.create('p', { title }))!.id);
    const day = 86_400_000;
    const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
    const spec: Array<[string, number]> = [['done', 8], ['live', 8], ['done', 6.9], ['review', 30], ['doing', 30]];
    const file = path.join(dir, '.myco', 'tasks.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    raw.forEach((t, i) => Object.assign(t, { status: spec[i]![0], updatedAt: ago(spec[i]![1]) }));
    await fs.writeFile(file, JSON.stringify(raw));

    const by = async () => Object.fromEntries(((await svc.list('p'))!).map((t) => [t.title, t]));
    let l = await by();
    expect(l['d-velha']).toMatchObject({ archived: true });
    expect(l['d-velha']!.archivedAt).toBeTruthy();
    expect(l['l-velha']!.archived).toBe(true);
    expect(l['d-nova']!.archived).toBeUndefined();
    expect(l['rev-velha']!.archived).toBeUndefined();
    expect(l['doing-velha']!.archived).toBeUndefined();

    // Reabrir (voltar para outra coluna) atualiza updatedAt e tira do arquivo; nada foi gravado como arquivado.
    await svc.update('p', ids[0]!, { status: 'doing' });
    l = await by();
    expect(l['d-velha']).toMatchObject({ status: 'doing' });
    expect(l['d-velha']!.archived).toBeUndefined();
    expect(await fs.readFile(file, 'utf8')).not.toContain('archived');
  });

  it('com a ficha em "só planeja": planejando, e o plano aprovado leva para fazendo', async () => {
    const { svc } = service('b', 'plan');
    const t = (await svc.create('p', { title: 'Refatorar o login', staffId: 'ana-1' }))!;
    expect((await svc.start('p', t.id))!.status).toBe('planning');
    await svc.onTurnDone('sess-1'); // terminou o turno com o plano pendente: continua planejando
    expect((await svc.list('p'))![0]!.status).toBe('planning');
    await svc.onPlanApproved('sess-1', '1. Extrair o serviço\n2. Testes');
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'doing', plan: '1. Extrair o serviço\n2. Testes' });
  });

  it('pede revisão a outro funcionário e deploy ao de infra; a resposta de cada um fica no histórico', async () => {
    const dir = path.join(root, 'd');
    const sent: Array<{ staffId: string; text: string }> = [];
    const people: Record<string, StaffProfile> = {
      'ana-1': { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false, servers: [] } as unknown as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', autonomy: 'manual', worktree: false, servers: [] } as unknown as StaffProfile,
      'ops-1': { id: 'ops-1', name: 'Ícaro', autonomy: 'manual', worktree: false, servers: ['VPS'] } as unknown as StaffProfile,
    };
    let n = 0;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        sent.push({ staffId, text });
        return `s-${++n}`;
      },
      branchFor: async () => null,
    });
    const t = (await svc.create('p', { title: 'Exportar CSV', description: 'Na tela de relatórios', staffId: 'ana-1' }))!;
    await svc.start('p', t.id); // s-1
    await expect(svc.requestReview('p', t.id, 'ana-1')).rejects.toThrow(/outro funcionário/);
    const reviewed = (await svc.requestReview('p', t.id, 'rev-1'))!; // s-2
    expect(reviewed).toMatchObject({ status: 'review', review: { staffId: 'rev-1', sessionId: 's-2' } });
    expect(sent[1]!.text).toMatch(/\[Revisão da tarefa "Exportar CSV"\][\s\S]*APROVADO/);
    await svc.onTurnDone('s-2'); // o revisor respondeu: não muda de coluna, anota
    const afterReview = (await svc.list('p'))![0]!;
    expect(afterReview.status).toBe('review');
    expect(afterReview.review?.doneAt).toBeTruthy();
    expect(afterReview.history.at(-1)?.note).toBe('revisão respondida');

    await expect(svc.requestDeploy('p', t.id, 'rev-1')).rejects.toThrow(/não tem acesso a servidores/);
    await svc.update('p', t.id, { status: 'done' });
    const deploying = (await svc.requestDeploy('p', t.id, 'ops-1'))!; // s-3
    expect(deploying).toMatchObject({ status: 'done', deploy: { staffId: 'ops-1', sessionId: 's-3' } });
    expect(sent[2]!.text).toMatch(/\[Deploy da tarefa "Exportar CSV"\][\s\S]*backup[\s\S]*runbook/);
    await svc.onTurnDone('s-3');
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'done', deploy: { staffId: 'ops-1' } });
    expect(await svc.summary()).toEqual({}); // pronto não conta como aberto
  });

  it('valida, edita, move à mão e apaga; o índice sessão → tarefa sobrevive a um reinício', async () => {
    const { svc } = service('c');
    await expect(svc.create('p', { title: ' ' })).rejects.toThrow(/título/);
    await expect(svc.create('p', { title: 'x', staffId: 'ninguem' })).rejects.toThrow(/não encontrado/);
    const t = (await svc.create('p', { title: 'Sem dono' }))!;
    await expect(svc.start('p', t.id)).rejects.toThrow(/escolha quem/);
    await expect(svc.update('p', t.id, { pr: 'nao-e-link' })).rejects.toThrow(/link/);
    expect(await svc.update('p', t.id, { status: 'done', pr: 'https://github.com/x/y/pull/1' })).toMatchObject({ status: 'done', pr: 'https://github.com/x/y/pull/1' });
    expect(await svc.summary()).toEqual({});

    const u = (await svc.create('p', { title: 'Outra', staffId: 'ana-1' }))!;
    await svc.start('p', u.id);
    const { svc: fresh } = service('c'); // "reiniciou": índice vazio, achado pelo disco
    await fresh.onTurnDone('sess-1');
    expect((await fresh.list('p'))!.find((x) => x.id === u.id)!.status).toBe('review');
    expect(await fresh.summary()).toEqual({ p: { open: 1, review: 1 } });

    expect(await svc.remove('p', t.id)).toBe(true);
    expect(await svc.remove('p', t.id)).toBe(false);
    expect(await svc.list('outro')).toBeNull();
  });
});

describe('tarefa pedida por um gestor', () => {
  it('a regra da dúvida vai para quem pediu, em qualquer motor', async () => {
    const dir = path.join(root, 'gestor-duvida');
    const sent: Array<{ staffId: string; text: string }> = [];
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Design system', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'cx-1': { id: 'cx-1', name: 'Mick', role: 'Back-end', autonomy: 'acceptEdits', worktree: false, engine: 'codex' } as StaffProfile,
      'ou-1': { id: 'ou-1', name: 'Outra gestora', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'worker-2': { id: 'worker-2', name: 'Outra pessoa', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => (sent.push({ staffId, text }), `s-${staffId}`),
      branchFor: async () => null,
      requesterSession: () => 's-gio',
      apiUrl: 'http://127.0.0.1:4848',
    });
    const a = (await svc.create('p', { title: 'A', description: 'x', staffId: 'lu-1' }, 'gio-1'))!;
    const b = (await svc.create('p', { title: 'B', description: 'x', staffId: 'cx-1' }, 'gio-1'))!;
    const c = (await svc.create('p', { title: 'C', description: 'x', staffId: 'worker-2' }, 'ou-1', 's-ou'))!;
    await svc.start('p', a.id);
    await svc.start('p', b.id);
    await svc.start('p', c.id);
    expect(sent[0]!.text).toContain('Dúvida ou decisão desta tarefa vai para Giovana, não para o usuário');
    expect(sent[0]!.text).toContain('`DÚVIDA:`');
    expect(sent[0]!.text).not.toContain('chat/send');
    expect(sent[1]!.text).toContain('Dúvida ou decisão desta tarefa vai para Giovana, não para o usuário');
    expect(sent[1]!.text).not.toContain('chat/send');

    const caller = { staffId: 'cx-1', projectId: 'p', sessionId: 's-cx-1', engine: 'codex' as const, sandbox: true };
    const target = { sessionId: 's-gio', staffId: 'gio-1' };
    expect(await svc.mayAskRequester('p', caller, target)).toBe(true);
    expect(await svc.mayAskRequester('p', caller, { ...target, sessionId: 's-gio-outra' })).toBe(false);
    expect(await svc.mayAskRequester('p', caller, { sessionId: 's-ou', staffId: 'ou-1' })).toBe(false);
    expect(await svc.mayAskRequester('p', { ...caller, engine: 'claude', sandbox: false }, target)).toBe(false);

    await svc.update('p', b.id, { status: 'done' });
    expect(await svc.mayAskRequester('p', caller, target)).toBe(false);
  });

  it('a dúvida ao gestor só passa com a tarefa em planejamento ou execução, da mesma sessão e do mesmo funcionário, no mesmo projeto', async () => {
    const dir = path.join(root, 'duvida-status');
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'cx-1': { id: 'cx-1', name: 'Cássio', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'worker-2': { id: 'worker-2', name: 'Outra pessoa', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId) => `s-${staffId}`,
      branchFor: async () => null,
      requesterSession: () => 's-gio',
      apiUrl: 'http://127.0.0.1:4848',
    });
    const b = (await svc.create('p', { title: 'B', description: 'x', staffId: 'cx-1' }, 'gio-1'))!;
    await svc.start('p', b.id);

    const caller = { staffId: 'cx-1', projectId: 'p', sessionId: 's-cx-1', engine: 'codex' as const, sandbox: true };
    const target = { sessionId: 's-gio', staffId: 'gio-1' };
    await svc.update('p', b.id, { status: 'planning' });
    expect(await svc.mayAskRequester('p', caller, target)).toBe(true);

    // Fora de planejamento e execução (a sessão da tarefa não muda), a dúvida não passa.
    for (const status of ['review', 'waiting', 'todo'] as const) {
      await svc.update('p', b.id, { status });
      expect(await svc.mayAskRequester('p', caller, target)).toBe(false);
    }
    await svc.update('p', b.id, { status: 'doing' });
    expect(await svc.mayAskRequester('p', caller, target)).toBe(true);

    // Mesma sessão, mas outro funcionário que chama: não passa.
    expect(await svc.mayAskRequester('p', { ...caller, staffId: 'worker-2' }, target)).toBe(false);
    // Chamada com outro projeto: não passa.
    expect(await svc.mayAskRequester('outro', caller, target)).toBe(false);
    expect(await svc.mayAskRequester('p', { ...caller, projectId: 'outro' }, target)).toBe(false);
  });

  it('dúvida ao gestor: um slot por minuto para cada par de conversas; o slot volta se o envio falha', () => {
    const limiter = new RequesterAskLimiter();
    const key = 'p:s-cx-1:s-gio';
    const t0 = 1_000_000;
    expect(limiter.check(key, 'oi', false, t0)).toBeNull();
    expect(limiter.check(key, 'oi', false, t0)).toBeNull(); // check não grava o slot
    expect(limiter.check(key, 'x'.repeat(REQUESTER_ASK_MAX_BYTES + 1), false, t0)).toBe('too-large');
    expect(limiter.check(key, 'oi', true, t0)).toBe('attachments');

    const undo = limiter.reserve(key, t0);
    expect(undo).not.toBeNull();
    expect(limiter.check(key, 'oi', false, t0 + 1)).toBe('rate-limited');
    expect(limiter.reserve(key, t0 + 1)).toBeNull();
    // Outro funcionário, com a sua sessão, tem o seu slot.
    expect(limiter.reserve('p:s-lu-1:s-gio', t0 + 1)).not.toBeNull();

    // Envio falhou: o slot volta e a próxima tentativa passa.
    undo!();
    expect(limiter.reserve(key, t0 + 2)).not.toBeNull();
    expect(limiter.check(key, 'oi', false, t0 + 2 + REQUESTER_ASK_INTERVAL_MS)).toBeNull();
  });

  it('sem a ficha de quem pergunta, o carimbo sai como não verificado; o título da tarefa não quebra a marca', async () => {
    const people: Record<string, StaffProfile> = {
      'cx-1': { id: 'cx-1', name: 'Cássio', role: 'Back-end' } as StaffProfile,
    };
    const deps = {
      projectPath: async () => root,
      readProfile: async (_p: string, id: string) => people[id] ?? null,
      taskOfWork: async () => ({ id: 't-1', title: 'Abre\n"x" “y”' }),
      mycoUrl: 'http://127.0.0.1:4848',
      codexUrl: 'http://127.0.0.2:4848',
    };
    const caller = { staffId: 'cx-1', projectId: 'p', sessionId: 's-cx-1', engine: 'codex' as const, sandbox: true };
    const ok = await staffOrigin(deps, 'p', caller, 'gio-1');
    expect(isUnverifiedOrigin(ok)).toBe(false);
    expect(ok).toContain('da tarefa t-1 “Abre x y”, na conversa s-cx-1');

    const semFicha = await staffOrigin({ ...deps, readProfile: async () => null }, 'p', caller, 'gio-1');
    expect(isUnverifiedOrigin(semFicha)).toBe(true);
  });

  it('a pessoa sabe quem pediu; na entrega, o gestor recebe o resumo para conferir', async () => {
    const dir = path.join(root, 'gestor');
    const sent: Array<{ staffId: string; text: string }> = [];
    const notified: Array<{ staffId: string; text: string }> = [];
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Design system', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => (sent.push({ staffId, text }), 's-lu'),
      branchFor: async () => null,
      notify: async (_p, staffId, text) => void notified.push({ staffId, text }),
      lastText: () => 'Troquei os tokens de cor do botão.',
    });
    const t = (await svc.create('p', { title: 'Botão no DS', description: 'Usar os tokens novos', staffId: 'lu-1', reviewerId: null }, 'gio-1'))!;
    expect(t).toMatchObject({ requestedBy: 'gio-1', history: [{ by: 'auto', note: 'pedida por Giovana' }] });
    await svc.start('p', t.id);
    expect(sent[0]).toMatchObject({ staffId: 'lu-1', text: expect.stringContaining('Pedida por Giovana (Orquestradora)') });

    await svc.onTurnDone('s-lu'); // Luana entregou
    expect(notified).toEqual([{ staffId: 'gio-1', text: expect.stringMatching(/Luana entregou a tarefa “Botão no DS”[\s\S]*Troquei os tokens de cor do botão/) }]);
    await svc.onIdle('s-lu', 'p', 'lu-1'); // o segundo aviso do mesmo fim não repete
    expect(notified).toHaveLength(1);
  });

  it('a entrega volta para a conversa em que o gestor pediu, já com os testes rodados pelo Claudio’s Club', async () => {
    const dir = path.join(root, 'gestor-testes');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const notified: Array<{ text: string; sessionId: string | null | undefined }> = [];
    const ran: string[] = [];
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Front-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async () => 's-lu2',
      branchFor: async () => null,
      notify: async (_p, _s, text, sessionId) => void notified.push({ text, sessionId }),
      lastText: () => 'Pronto.',
      // Giovana está no turno em que chamou a API: é para essa conversa que a entrega volta.
      requesterSession: (_p, staffId) => (staffId === 'gio-1' ? 's-gio-pediu' : null),
      runTests: async (cwd, command) => (ran.push(`${cwd}|${command}`), { command, ok: false, output: 'FAIL botao.test.ts', ms: 4200, at: '2026-10-28T12:00:00Z' }),
    });
    const t = (await svc.create('p', { title: 'Botão', description: '', staffId: 'lu-1', reviewerId: null }, 'gio-1'))!;
    expect(t.requestedSession).toBe('s-gio-pediu');
    await svc.start('p', t.id);
    await svc.onTurnDone('s-lu2');
    expect(ran).toEqual([`${dir}|npm test`]);
    expect(notified).toEqual([{ sessionId: 's-gio-pediu', text: expect.stringContaining('FALHARAM. Fim da saída:\nFAIL botao.test.ts') }]);
    expect((await svc.list('p'))![0]!.tests).toMatchObject({ ok: false, command: 'npm test' });
  });

  it('pedida pela API com o token do gestor: a entrega volta para a conversa do token, não para a do turno', async () => {
    const dir = path.join(root, 'pedido-token');
    await fs.mkdir(dir, { recursive: true });
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Front-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async () => 's-lu',
      branchFor: async () => null,
      requesterSession: () => 's-turno-outro',
    });
    const body = { title: 'Botão', description: '', staffId: 'lu-1', reviewerId: null };
    expect((await svc.create('p', body, 'gio-1', 's-do-token'))!.requestedSession).toBe('s-do-token');
    expect((await svc.create('p', body, 'gio-1'))!.requestedSession).toBe('s-turno-outro');
  });

  it('taskOfWork: só a conversa de trabalho de uma tarefa, e só neste projeto', async () => {
    const { svc } = service('tow');
    const t = (await svc.create('p', { title: 'A', staffId: 'ana-1' }))!;
    await svc.start('p', t.id); // sess-1
    expect((await svc.taskOfWork('p', 'sess-1'))?.id).toBe(t.id);
    expect(await svc.taskOfWork('p', 'outra-conversa')).toBeNull();
    expect(await svc.taskOfWork('outro', 'sess-1')).toBeNull();
  });
});

describe('fila por funcionário', () => {
  function queued(dirName: string) {
    const dir = path.join(root, dirName);
    const sent: Array<{ text: string; session: string }> = [];
    const delivered: Array<{ sessionId: string; text: string; images: string[]; origin?: string }> = [];
    /** Conversas trabalhando agora (o que o ChatManager sabe). */
    const working = new Set<string>();
    let n = 0;
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async (_p, _staffId, text) => {
        const session = `s-${++n}`;
        sent.push({ text, session });
        working.add(session);
        return session;
      },
      branchFor: async () => null,
      isWorking: (_p, _staffId, except) => [...working].some((s) => s !== except),
      sendTo: async (_p, sessionId, _staffId, text, images, origin) => {
        delivered.push({ sessionId, text, images, origin });
        working.add(sessionId);
        return sessionId;
      },
    });
    // O turno acabou: o processo da conversa avisa (onIdle) e o vigia de sessões também (onTurnDone);
    // turno curto o vigia perde, então o processo vem primeiro e o segundo aviso não muda nada.
    const finish = async (session: string) => {
      working.delete(session);
      await svc.onIdle(session, 'p', 'ana-1');
      await svc.onTurnDone(session);
    };
    const make = async (title: string) => (await svc.create('p', { title, staffId: 'ana-1' }))!;
    return { svc, sent, delivered, working, finish, make };
  }

  it('uma por vez: as outras entram na fila e a próxima começa quando a atual vai para revisão', async () => {
    const { svc, sent, finish, make } = queued('q1');
    const [a, b, c] = [await make('A'), await make('B'), await make('C')];
    expect((await svc.start('p', a.id))!.status).toBe('doing');
    const qb = (await svc.start('p', b.id))!;
    expect(qb).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect(qb.history.at(-1)?.note).toBe('na fila de Ana, depois de “A”');
    await svc.start('p', c.id);
    expect(sent).toHaveLength(1);

    await finish('s-1');
    const list = (await svc.list('p'))!;
    expect(list.map((t) => [t.title, t.status])).toEqual([
      ['A', 'review'],
      ['B', 'doing'],
      ['C', 'todo'],
    ]);
    expect(sent[1]!.text).toContain('[Tarefa "B"]');
    expect(list[1]!.queuedAt).toBeNull();

    // Tirou da fila: quando B entregar, C não começa.
    await svc.update('p', c.id, { queued: false });
    await finish('s-2');
    expect(sent).toHaveLength(2);
  });

  it('turno curto que o vigia de sessões não viu: o aviso do processo basta', async () => {
    const { svc, sent, working, make } = queued('q3');
    const [a, b] = [await make('A'), await make('B')];
    await svc.start('p', a.id); // s-1
    await svc.start('p', b.id); // fila
    working.delete('s-1');
    await svc.onIdle('s-1', 'p', 'ana-1'); // só o processo avisou
    expect((await svc.list('p'))!.map((t) => t.status)).toEqual(['review', 'doing']);
    expect(sent.at(-1)!.text).toContain('[Tarefa "B"]');
  });

  it('ajuste numa tarefa anterior espera a vez e vai antes da próxima da fila', async () => {
    const { svc, sent, delivered, finish, make } = queued('q2');
    const [a, b, c] = [await make('A'), await make('B'), await make('C')];
    await svc.start('p', a.id); // s-1
    await finish('s-1'); // A em revisão
    await svc.start('p', b.id); // livre: começa já (s-2)
    await svc.start('p', c.id); // fila, depois de B

    expect(await svc.hold('s-1', { text: 'faltou o cabeçalho' })).toBe('espera Ana terminar “B”');
    expect(await svc.heldItems('s-1')).toEqual([expect.objectContaining({ kind: 'user', text: 'faltou o cabeçalho', held: 'espera Ana terminar “B”' })]);
    expect(await svc.hold('s-2', { text: 'na B mesmo' })).toBeNull(); // a conversa em que ela está: vai já

    await finish('s-2');
    expect(delivered).toEqual([{ sessionId: 's-1', text: 'faltou o cabeçalho', images: [] }]);
    expect(sent).toHaveLength(2); // C ainda espera: ela está no ajuste da A
    expect(await svc.heldItems('s-1')).toEqual([]);

    await svc.onSent('s-1'); // o que o ChatManager faz ao mandar: A volta para "fazendo"
    await finish('s-1');
    expect(sent.at(-1)!.text).toContain('[Tarefa "C"]');
    expect((await svc.list('p'))!.find((t) => t.id === a.id)!.history.map((h) => h.note)).toContain('ajuste guardado enviado');
  });

  it('o carimbo de outro funcionário fica com a mensagem guardada e vai junto quando ela sai', async () => {
    const { svc, delivered, finish, make } = queued('q4');
    const [a, b] = [await make('A'), await make('B')];
    await svc.start('p', a.id); // s-1
    await finish('s-1'); // A em revisão
    await svc.start('p', b.id); // s-2

    const origin = '[MyCo] Mensagem de outro funcionário. Quem mandou: Tupac (Analista de segurança, id tupac-91e7), na conversa s-x.';
    expect(await svc.hold('s-1', { text: 'faltou o cabeçalho', origin })).toBe('espera Ana terminar “B”');
    expect((await svc.list('p'))!.find((t) => t.id === a.id)!.held).toEqual([expect.objectContaining({ text: 'faltou o cabeçalho', origin })]);

    await finish('s-2');
    expect(delivered.at(-1)).toEqual({ sessionId: 's-1', text: 'faltou o cabeçalho', images: [], origin });
  });
});

describe('conversa da tarefa que morreu no meio do turno', () => {
  /** Ana com A fazendo (s-1) e B na fila. `working`: o que o ChatManager sabe; tirar dali sem onIdle = o processo morreu. */
  async function orphaned(
    dirName: string,
    awaitingLimit?: () => Promise<boolean>,
    closing?: { on: boolean },
    restartCut?: (projectId: string, sessionId: string) => Promise<TurnCapHit | null>,
  ) {
    const dir = path.join(root, dirName);
    const sent: string[] = [];
    const delivered: Array<{ sessionId: string; text: string }> = [];
    const working = new Set<string>();
    let n = 0;
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async (_p, _s, text) => {
        const session = `s-${++n}`;
        sent.push(text);
        working.add(session);
        return session;
      },
      branchFor: async () => null,
      isWorking: (_p, _s, except) => [...working].some((s) => s !== except),
      sendTo: async (_p, sessionId, _s, text) => {
        if (closing?.on) throw new ChatClosingError();
        delivered.push({ sessionId, text });
        working.add(sessionId);
        return sessionId;
      },
      ...(awaitingLimit && { awaitingLimit }),
      ...(restartCut && { restartCut }),
    });
    const a = (await svc.create('p', { title: 'A', staffId: 'ana-1' }))!;
    const b = (await svc.create('p', { title: 'B', staffId: 'ana-1' }))!;
    await svc.start('p', a.id); // s-1
    await svc.start('p', b.id); // fila
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    const task = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
    return { svc, sent, delivered, working, a, b, later, task };
  }

  it('cortada numa ação com efeito fora do projeto: não retoma sozinha, vai para Aguardar com o motivo', async () => {
    const asked: string[] = [];
    const cut = async (_p: string, sid: string): Promise<TurnCapHit | null> => (asked.push(sid), { kind: 'restart', action: 'git push origin main' });
    const { svc, delivered, working, a, later, task } = await orphaned('orfa-corte', undefined, undefined, cut);
    working.delete('s-1');
    await svc.tick(later(3));
    expect(asked).toEqual(['s-1']);
    expect(delivered).toEqual([]);
    const t = await task(a.id);
    expect(t).toMatchObject({ status: 'waiting', waitReason: expect.stringContaining('git push origin main') });
    await svc.tick(later(6)); // já em Aguardar: nada de novo
    expect(delivered).toEqual([]);
  });

  it('conferir o corte falhou: retoma como sempre', async () => {
    const { svc, delivered, working, later } = await orphaned('orfa-corte-erro', undefined, undefined, async () => {
      throw new Error('sem transcript');
    });
    working.delete('s-1');
    await svc.tick(later(3));
    expect(delivered).toEqual([{ sessionId: 's-1', text: expect.stringContaining('confira se a última ação terminou') }]);
  });

  it('parada sem onIdle: retoma a conversa uma vez, e segue em fazendo', async () => {
    const { svc, delivered, working, a, later, task } = await orphaned('orfa-1');
    working.delete('s-1'); // o servidor caiu no meio do turno
    await svc.tick(later(3));
    expect(delivered).toEqual([{ sessionId: 's-1', text: expect.stringContaining('Continue de onde parou') }]);
    const t = await task(a.id);
    expect(t).toMatchObject({ status: 'doing', resumedAt: expect.any(String) });
    expect(t.history.at(-1)?.note).toBe('conversa parou sem terminar: retomada');
    await svc.tick(later(3)); // trabalhando de novo: nada
    expect(delivered).toHaveLength(1);
    // O turno retomado termina: entrega normal (a sessão é conhecida).
    working.delete('s-1');
    await svc.onIdle('s-1', 'p', 'ana-1');
    expect((await task(a.id)).status).toBe('review');
  });

  it('retomada de conversa que morreu com comando em segundo plano: o aviso do claude não entrega a tarefa', async () => {
    // ChatManager de verdade, com um claude falso que emite o que o 2.1.310 emite ao retomar (capturado sem
    // chamada à API): o aviso de que o comando parou vira um "turno" só de histórico (init e result com
    // num_turns 0) antes do turno da nossa mensagem.
    const dir = path.join(root, 'orfa-aviso');
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 4242, kill: () => {} });
    const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
    const idle: Array<Promise<void>> = [];
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 20));
      await Promise.all(idle);
    };
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    let svc: TaskService | null = null;
    const chats = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage-aviso.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid!, cwd: '.', args: ['--resume', sid!] }),
      spawnImpl: () => proc as never,
      onIdle: (sid, pid, staffId) => void idle.push(svc!.onIdle(sid, pid, staffId)),
    });
    svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => 's-1', // a conversa da tarefa começou antes do reinício
      branchFor: async () => null,
      isWorking: (p, s, except) => chats.staffWorking(p, s, except),
      sendTo: (p, sid, s, text, images) => chats.send(p, sid, s, text, 'next', images),
    });
    const a = (await svc.create('p', { title: 'A', staffId: 'ana-1' }))!;
    await svc.start('p', a.id);
    const status = async () => (await svc!.list('p'))!.find((t) => t.id === a.id)!.status;

    await svc.tick(new Date(Date.now() + 3 * 60_000)); // o servidor subiu e a conversa não está aberta: retoma
    emit({ type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_1', status: 'stopped', summary: "Background shell command didn't finish before the previous session ended" });
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', origin: { kind: 'task-notification' } });
    emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Retomando: o Vite parou com o reinício.' }] } });
    await settle();
    expect(await status()).toBe('doing');
    expect(chats.isWorking('s-1')).toBe(true);
    expect(idle).toHaveLength(0);

    // O turno da retomada termina de verdade: aí sim é entrega.
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: 'Pronto.' });
    await settle();
    expect(await status()).toBe('review');
  });

  it('retomada e morreu de novo: vai para revisão e a próxima da fila começa', async () => {
    const { svc, sent, delivered, working, a, b, later, task } = await orphaned('orfa-2');
    working.delete('s-1');
    await svc.tick(later(3)); // retoma
    working.delete('s-1'); // morreu de novo
    await svc.tick(later(4)); // ainda dentro da janela desde a retomada
    expect((await task(a.id)).status).toBe('doing');
    await svc.tick(later(6));
    expect(delivered).toHaveLength(1); // não retoma de novo
    const t = await task(a.id);
    expect(t.status).toBe('review');
    expect(t.history.at(-1)?.note).toBe('conversa parou sem terminar');
    expect((await task(b.id)).status).toBe('doing');
    expect(sent.at(-1)).toContain('[Tarefa "B"]');
  });

  it('retomada de órfã com o servidor fechando: não conta como tentativa; o boot tenta de novo', async () => {
    const closing = { on: true };
    const { svc, delivered, working, a, later, task } = await orphaned('orfa-closing', undefined, closing);
    working.delete('s-1'); // o servidor caiu no meio do turno
    await svc.tick(later(3));
    expect(delivered).toEqual([]);
    expect((await task(a.id)).resumedAt ?? null).toBeNull();
    expect((await task(a.id)).status).toBe('doing');
    closing.on = false; // o boot
    await svc.tick(later(3));
    expect(delivered).toEqual([{ sessionId: 's-1', text: expect.stringContaining('Continue de onde parou') }]);
  });

  it('morreu de novo, pedida por um gestor: ele é avisado da interrupção, sem testes nem revisão automática', async () => {
    const dir = path.join(root, 'orfa-gestor');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const sent: Array<{ staffId: string; text: string }> = [];
    const notified: Array<{ staffId: string; text: string }> = [];
    const ran: string[] = [];
    const working = new Set<string>();
    let n = 0;
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'ana-1': { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', autonomy: 'manual', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        const session = `s-${++n}`;
        sent.push({ staffId, text });
        working.add(session);
        return session;
      },
      branchFor: async () => null,
      isWorking: (_p, _s, except) => [...working].some((s) => s !== except),
      sendTo: async (_p, sessionId) => (working.add(sessionId), sessionId),
      notify: async (_p, staffId, text) => void notified.push({ staffId, text }),
      lastText: () => 'Fiz metade do formulário.',
      runTests: async (_cwd, command) => (ran.push(command), { command, ok: true, output: '', ms: 1, at: '2026-11-04T12:00:00Z' }),
    });
    const a = (await svc.create('p', { title: 'Formulário', staffId: 'ana-1', reviewerId: 'rev-1' }, 'gio-1'))!;
    await svc.start('p', a.id); // s-1
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    working.delete('s-1');
    await svc.tick(later(3)); // retoma
    working.delete('s-1'); // morreu de novo
    await svc.tick(later(6));

    expect((await svc.list('p'))![0]!.status).toBe('review');
    expect(notified).toEqual([{ staffId: 'gio-1', text: expect.stringContaining(`parou duas vezes sem terminar`) }]);
    expect(notified[0]!.text).toContain(`(id ${a.id})`);
    expect(notified[0]!.text).toContain('Fiz metade do formulário.');
    expect(ran).toEqual([]); // sem testes
    expect(sent.map((s) => s.staffId)).toEqual(['ana-1']); // o revisor não foi chamado
  });

  it('conversa trabalhando não é tocada', async () => {
    const { svc, delivered, a, later, task } = await orphaned('orfa-3');
    await svc.tick(later(30));
    expect(delivered).toEqual([]);
    expect(await task(a.id)).toMatchObject({ status: 'doing' });
    expect((await task(a.id)).resumedAt).toBeUndefined();
  });

  it('parada no limite de uso (ou com despertador), ou erro ao perguntar: não é tocada', async () => {
    for (const [dirName, ask] of [
      ['orfa-4', async () => true],
      ['orfa-4b', async () => Promise.reject(new Error('sem resposta'))],
    ] as const) {
      const { svc, delivered, working, a, later, task } = await orphaned(dirName, ask);
      working.delete('s-1');
      await svc.tick(later(30));
      expect(delivered).toEqual([]);
      expect((await task(a.id)).status).toBe('doing');
    }
  });

  it('recém-começada (dentro da janela) não é tocada; depois dela, sim', async () => {
    const { svc, delivered, working, later } = await orphaned('orfa-5');
    working.delete('s-1');
    await svc.tick(); // agora
    await svc.tick(later(1));
    expect(delivered).toEqual([]);
    await svc.tick(later(3));
    expect(delivered).toHaveLength(1);
  });
});

describe('limite de uso no meio da tarefa', () => {
  /** Giovana pede, Luana faz. `limit.waiting` diz se a conversa da Luana parou no limite com o "continue" agendado. */
  function limited(dirName: string, opts: { awaitingLimit?: (sessionId: string) => Promise<boolean> } = {}) {
    const dir = path.join(root, dirName);
    const notified: string[] = [];
    const reviewed: string[] = [];
    const sent: string[] = [];
    const limit = { waiting: true, asked: [] as string[] };
    let n = 0;
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Front-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', autonomy: 'manual', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        const session = `s-${++n}`;
        (staffId === 'rev-1' ? reviewed : sent).push(text);
        return session;
      },
      branchFor: async () => null,
      notify: async (_p, _s, text) => void notified.push(text),
      lastText: () => 'Fiz até aqui.',
      awaitingLimit:
        opts.awaitingLimit ??
        (async (sid) => {
          limit.asked.push(sid);
          return limit.waiting;
        }),
    });
    const make = async (title: string, reviewerId: string | null = null) => (await svc.create('p', { title, staffId: 'lu-1', reviewerId }, 'gio-1'))!;
    const status = async () => (await svc.list('p'))!.map((t) => [t.title, t.status]);
    return { svc, notified, reviewed, sent, limit, make, status };
  }

  it('turno parado pelo limite com "continue" agendado: não entrega, não avisa o gestor e a fila não anda', async () => {
    const { svc, notified, sent, limit, make, status } = limited('limite-1');
    const [a, b] = [await make('A'), await make('B')];
    await svc.start('p', a.id); // s-1
    await svc.start('p', b.id); // fila da Luana
    expect(sent).toHaveLength(1);

    // As duas origens do fim de turno: o processo da conversa (onIdle) e o vigia de sessões (onTurnDone).
    await svc.onIdle('s-1', 'p', 'lu-1');
    await svc.onTurnDone('s-1');
    expect(limit.asked).toEqual(['s-1', 's-1']);
    expect(await status()).toEqual([['A', 'doing'], ['B', 'todo']]);
    expect(notified).toEqual([]);
    expect(sent).toHaveLength(1);
    const list = (await svc.list('p'))!;
    expect(list[0]!.history.map((h) => h.note)).not.toContain('turno terminou');
    expect(list[1]!.queuedAt).toEqual(expect.any(String)); // B segue na fila

    // O "continue" rodou e o turno terminou de verdade: a entrega segue normal.
    limit.waiting = false;
    await svc.onIdle('s-1', 'p', 'lu-1');
    expect(await status()).toEqual([['A', 'review'], ['B', 'doing']]);
    expect(notified).toEqual([expect.stringContaining('Luana entregou a tarefa “A”')]);
    expect(sent).toHaveLength(2);
  });

  it('só o vigia de sessões vendo o fim (com atraso): a pendência também segura a entrega', async () => {
    const { svc, notified, make, status } = limited('limite-2');
    const t = await make('A');
    await svc.start('p', t.id);
    await svc.onTurnDone('s-1');
    expect(await status()).toEqual([['A', 'doing']]);
    expect(notified).toEqual([]);
  });

  it('sem pendência (opção desligada ou cancelada): entrega como antes', async () => {
    const { svc, notified, limit, make, status } = limited('limite-3');
    limit.waiting = false;
    const t = await make('A');
    await svc.start('p', t.id);
    await svc.onIdle('s-1', 'p', 'lu-1');
    expect(await status()).toEqual([['A', 'review']]);
    expect(notified).toHaveLength(1);
  });

  it('sem a dependência, ou com erro ao perguntar: entrega como antes', async () => {
    const plain = service('limite-4');
    const t = (await plain.svc.create('p', { title: 'A', staffId: 'ana-1' }))!;
    await plain.svc.start('p', t.id);
    await plain.svc.onTurnDone('sess-1');
    expect((await plain.svc.list('p'))![0]!.status).toBe('review');

    const broken = limited('limite-5', {
      awaitingLimit: async () => {
        throw new Error('sem resposta');
      },
    });
    const b = await broken.make('B');
    await broken.svc.start('p', b.id);
    await broken.svc.onIdle('s-1', 'p', 'lu-1');
    expect(await broken.status()).toEqual([['B', 'review']]);
    expect(broken.notified).toHaveLength(1);
  });

  it('a pendência vale só para a conversa de trabalho: a revisão automática segue o seu caminho', async () => {
    const { svc, reviewed, limit, make, status } = limited('limite-6');
    const t = await make('A', 'rev-1');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // parou no limite: não entrega, o revisor não é chamado
    expect(reviewed).toEqual([]);
    limit.waiting = false;
    await svc.onTurnDone('s-1');
    expect(await status()).toEqual([['A', 'review']]);
    expect(reviewed).toHaveLength(1);
  });
});

describe('revisão automática', () => {
  /** Ana faz a tarefa, Rui revisa. `texts` diz o que cada conversa respondeu por último. */
  function reviewFlow(dirName: string, extra: Partial<StaffProfile> = {}) {
    const dir = path.join(root, dirName);
    const sent: Array<{ staffId: string; text: string; session: string }> = [];
    const delivered: Array<{ sessionId: string; text: string }> = [];
    const texts = new Map<string, string>();
    let n = 0;
    const people: Record<string, StaffProfile> = {
      'ana-1': { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false, servers: [], ...extra } as unknown as StaffProfile,
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
      branchFor: async () => null,
      lastText: (sessionId) => texts.get(sessionId) ?? null,
      sendTo: async (_p, sessionId, _staffId, text) => {
        delivered.push({ sessionId, text });
        return sessionId;
      },
    });
    const make = async (title: string, reviewerId: string | null = 'rev-1') => (await svc.create('p', { title, staffId: 'ana-1', reviewerId }))!;
    const current = async () => (await svc.list('p'))![0]!;
    return { svc, dir, sent, delivered, texts, make, current };
  }

  it('aprovada pelo revisor vai para pronto sozinha; ao entregar, ele é chamado com o veredito na primeira linha', async () => {
    const { svc, sent, texts, make, current } = reviewFlow('auto-ok');
    const t = await make('Tabela paginada');
    expect(t).toMatchObject({ reviewerId: 'rev-1' });
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // entregou: o Rui revisa sozinho (s-2)
    expect(await current()).toMatchObject({ status: 'review', reviewRounds: 1, review: { staffId: 'rev-1', sessionId: 's-2' } });
    expect(sent.at(-1)).toMatchObject({ staffId: 'rev-1', session: 's-2' });
    expect(sent.at(-1)!.text).toContain('APROVADO ou REPROVADO na primeira linha');

    texts.set('s-2', '**APROVADO**\n\nPaginação e testes conferidos.');
    await svc.onTurnDone('s-2');
    const done = await current();
    expect(done).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(done.history.at(-1)).toMatchObject({ status: 'done', by: 'auto', note: 'aprovada por Rui' });
  });

  it('aprovada, mas o código ainda está numa worktree por mesclar: fica em revisão, com a nota', async () => {
    const { svc, dir, texts, make, current } = reviewFlow('auto-wt', { worktree: true });
    // A worktree dela: a pasta com o arquivo `.git` (é assim que o Claudio’s Club acha a worktree).
    const wt = path.join(dir, '.claude', 'worktrees', 'myco-ana-1');
    await fs.mkdir(wt, { recursive: true });
    await fs.writeFile(path.join(wt, '.git'), 'gitdir: nao-existe\n');
    const t = await make('Filtro de datas');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // s-2
    texts.set('s-2', 'APROVADO\n\nok');
    await svc.onTurnDone('s-2');
    expect(await current()).toMatchObject({ status: 'review', review: { verdict: 'approved' } });
    expect((await current()).history.at(-1)?.note).toBe('aprovada por Rui; falta mesclar');
  });

  it('reprovada: a tarefa volta para fazendo, a resposta do revisor vai para a conversa de trabalho, e a próxima rodada é pedida quando ela terminar', async () => {
    const { svc, texts, delivered, make, current } = reviewFlow('auto-no');
    const t = await make('Botão de exportar');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // s-2: revisão automática
    texts.set('s-2', 'REPROVADO\n\nbotao.tsx:12 falta o aria-label');
    await svc.onTurnDone('s-2');
    const back = await current();
    expect(back).toMatchObject({ status: 'doing', review: { verdict: 'rejected' } });
    expect(back.history.map((h) => h.note)).toContain('reprovada por Rui');
    expect(delivered).toEqual([{ sessionId: 's-1', text: expect.stringContaining('botao.tsx:12 falta o aria-label') }]);

    await svc.onTurnDone('s-1'); // ajustou e terminou: volta para revisão, e o Rui revisa de novo (s-3)
    expect(await current()).toMatchObject({ status: 'review', reviewRounds: 2, review: { sessionId: 's-3' } });
  });

  it('reprovada com ela ocupada com outra tarefa: o ajuste espera na conversa dela, e a tarefa segue em revisão', async () => {
    const { svc, texts, delivered, make } = reviewFlow('auto-busy');
    const a = await make('A');
    const b = await make('B', null);
    await svc.start('p', a.id); // s-1
    await svc.onTurnDone('s-1'); // A em revisão; o Rui revisa (s-2)
    await svc.start('p', b.id); // a Ana está livre (A em revisão não ocupa): B começa (s-3)
    texts.set('s-2', 'REPROVADO\n\nfalta o teste da paginação');
    await svc.onTurnDone('s-2');
    const held = (await svc.list('p'))!.find((x) => x.id === a.id)!;
    expect(held).toMatchObject({ status: 'review', held: [expect.objectContaining({ text: expect.stringContaining('falta o teste da paginação') })] });
    expect(held.held![0]!.reason).toBe('espera Ana terminar “B”');
    expect(delivered).toEqual([]);

    await svc.onTurnDone('s-3'); // B termina: a fila da Ana anda, e o ajuste da A vai primeiro
    await svc.tick();
    expect(delivered).toEqual([{ sessionId: 's-1', text: expect.stringContaining('falta o teste da paginação') }]);
  });

  it('no máximo 2 rodadas automáticas (a entrega e uma reauditoria): depois, a tarefa fica com você e a entrega não pede mais revisão', async () => {
    const { svc, sent, texts, delivered, make, current } = reviewFlow('auto-limit');
    const t = await make('Relatório');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // rodada 1 (s-2)
    for (const round of [1, 2]) {
      texts.set(`s-${round + 1}`, `REPROVADO\n\najuste ${round}`);
      await svc.onTurnDone(`s-${round + 1}`); // reprovou: volta para fazendo
      await svc.onTurnDone('s-1'); // ajustou e terminou: vai para revisão (a rodada 2 é a última, s-3)
    }
    const end = await current();
    expect(sent.filter((m) => m.staffId === 'rev-1')).toHaveLength(2);
    expect(delivered).toHaveLength(2);
    expect(end).toMatchObject({ status: 'review', reviewRounds: 2 });
    expect(end.history.at(-1)?.note).toBe(
      'limite de 2 revisões automáticas; o que sobrou fica com você: aceitar como trade-off (anotar em "Decisões" no SPEC.md) ou pedir ajuste',
    );
  });

  it('o pedido de revisão diz o que vale: com SPEC.md, manda ler o guia; a severidade só reprova com 🔴', async () => {
    const { svc, dir, sent, make } = reviewFlow('auto-guide');
    const t = await make('Ajuste de tela');
    await svc.start('p', t.id); // s-1
    await svc.requestReview('p', t.id, 'rev-1'); // s-2, sem SPEC.md
    expect(sent.at(-1)!.text).not.toContain('Leia `SPEC.md`');
    expect(sent.at(-1)!.text).toContain('REPROVADO só se houver algum 🔴');
    await fs.writeFile(path.join(dir, 'SPEC.md'), '# Guia\n', 'utf8');
    await svc.requestReview('p', t.id, 'rev-1'); // s-3, com SPEC.md
    expect(sent.at(-1)!.text).toContain('Leia `SPEC.md`: o que contrariar o guia é 🔴.');
    expect(sent.at(-1)!.text).toContain('APROVADO ou REPROVADO na primeira linha');
  });

  it('revisor: outro funcionário do projeto, que não é quem faz a tarefa, nem na troca', async () => {
    const { svc, make } = reviewFlow('auto-val');
    await expect(svc.create('p', { title: 'x', staffId: 'ana-1', reviewerId: 'ana-1' })).rejects.toThrow(/outro funcionário/);
    await expect(svc.create('p', { title: 'x', staffId: 'ana-1', reviewerId: 'ninguem' })).rejects.toThrow(/revisor não encontrado/);
    const t = await make('y');
    await expect(svc.update('p', t.id, { staffId: 'rev-1' })).rejects.toThrow(/outro funcionário/);
    await expect(svc.update('p', t.id, { reviewerId: 'ana-1' })).rejects.toThrow(/outro funcionário/);
    expect(await svc.update('p', t.id, { reviewerId: null })).toMatchObject({ reviewerId: null });
  });

  it('sem revisor marcado, nada muda: entregue fica em revisão; um veredito de revisão pedida à mão só é anotado', async () => {
    const { svc, sent, texts, make, current } = reviewFlow('auto-none');
    const t = await make('Sem revisor', null);
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1');
    expect(sent).toHaveLength(1);
    expect(await current()).toMatchObject({ status: 'review' });
    expect((await current()).reviewRounds).toBeUndefined();

    await svc.requestReview('p', t.id, 'rev-1'); // s-2, pedida à mão
    texts.set('s-2', 'APROVADO');
    await svc.onTurnDone('s-2');
    expect(await current()).toMatchObject({ status: 'review', review: { verdict: 'approved' } });
    expect((await current()).reviewerId).toBeNull();
  });

  it('pedido à mão com assign marca o revisor: APROVADO vai para pronto, sem contar rodada', async () => {
    const { svc, texts, make, current } = reviewFlow('manual-ok');
    const t = await make('Pedido do quadro', null);
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // entregue, sem revisor: fica em revisão
    await svc.requestReview('p', t.id, 'rev-1', false, { assign: true }); // s-2
    expect(await current()).toMatchObject({ status: 'review', reviewerId: 'rev-1', review: { staffId: 'rev-1', sessionId: 's-2' } });
    expect((await current()).reviewRounds).toBeUndefined();
    texts.set('s-2', 'APROVADO\n\nok');
    await svc.onTurnDone('s-2');
    expect(await current()).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
  });

  it('pedido à mão com assign: REPROVADO manda o ajuste para a conversa de trabalho (fazendo)', async () => {
    const { svc, delivered, texts, make, current } = reviewFlow('manual-no');
    const t = await make('Pedido reprovado', null);
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1');
    await svc.requestReview('p', t.id, 'rev-1', false, { assign: true }); // s-2
    texts.set('s-2', 'REPROVADO\n\n- 🔴 a.ts:1 quebra o login');
    await svc.onTurnDone('s-2');
    expect(await current()).toMatchObject({ status: 'doing', reviewerId: 'rev-1' });
    expect(delivered.at(-1)).toMatchObject({ sessionId: 's-1' });
    expect(delivered.at(-1)!.text).toContain('quebra o login');
  });

  it('pedido à mão com assign numa tarefa sem executor: não quebra, e a reprovação fica com você', async () => {
    const { svc, texts, current } = reviewFlow('manual-noexec');
    const t = (await svc.create('p', { title: 'Sem executor' }))!;
    expect(await svc.requestReview('p', t.id, 'rev-1', false, { assign: true })).toMatchObject({ status: 'review', reviewerId: 'rev-1' });
    texts.set('s-1', 'REPROVADO\n\n- 🔴 x');
    await svc.onTurnDone('s-1');
    expect(await current()).toMatchObject({ status: 'review', reviewerId: 'rev-1', review: { verdict: 'rejected' } });
    expect((await current()).history.at(-1)?.note).toBe('reprovada por Rui, mas não tem conversa de trabalho: fica com você');
  });

  it('o veredito é a primeira linha, sem markdown e em maiúsculas; o resto não decide', () => {
    expect(parseVerdict('**APROVADO**\n\nok')).toBe('approved');
    expect(parseVerdict('\n  # REPROVADO\n- x')).toBe('rejected');
    expect(parseVerdict('APROVADO.')).toBe('approved');
    expect(parseVerdict('APROVADO com ressalvas')).toBeNull();
    expect(parseVerdict('APROVADO, mas o teste X falha')).toBeNull();
    expect(parseVerdict('Aprovado')).toBeNull();
    expect(parseVerdict('Acho que está APROVADO')).toBeNull();
    expect(parseVerdict('APROVADOS os dois')).toBeNull();
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
});

describe('limite de consumo ao começar', () => {
  /** Ana com o consumo acima da linha: `state.capped` diz se o envio é recusado. */
  function capped(dirName: string) {
    const dir = path.join(root, dirName);
    const state = { capped: true, n: 0 };
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => {
        if (state.capped) throw new UsageStopError({ kind: 'five_hour', percentUsed: 91, limit: 85, resetsAt: null });
        return `s-${++state.n}`;
      },
      branchFor: async () => null,
    });
    const task = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
    return { svc, state, task };
  }
  const STOP = 'não começou: o consumo 5h está em 91% (linha de parada: 85%)';

  it('start com o consumo no limite: não lança, fica na fila com queuedAt e sem conversa', async () => {
    const { svc, task } = capped('stop-1');
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    const got = (await svc.start('p', t.id, true))!;
    expect(got).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String), queuedForce: true });
    expect(got.history.at(-1)?.note).toBe(`${STOP}; na fila de Ana, começa quando o consumo baixar`);
    expect(await task(t.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
  });

  it('depois que o consumo baixa, o tick começa a tarefa da fila', async () => {
    const { svc, state, task } = capped('stop-2');
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    await svc.start('p', t.id);
    await svc.tick(); // ainda no limite: segue na fila
    expect(await task(t.id)).toMatchObject({ status: 'todo', sessionId: null });
    state.capped = false;
    await svc.tick();
    expect(await task(t.id)).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null, queuedForce: false });
  });

  it('o tick repete a recusa sem duplicar a nota no histórico', async () => {
    const { svc, task } = capped('stop-3');
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    await svc.start('p', t.id);
    await svc.tick();
    const once = (await task(t.id)).history.length;
    expect((await task(t.id)).history.filter((h) => h.note === STOP)).toHaveLength(1);
    await svc.tick();
    await svc.tick();
    const after = await task(t.id);
    expect(after.history).toHaveLength(once);
    expect(after.history.filter((h) => h.note === STOP)).toHaveLength(1);
  });
});

describe('reinício: a fila não perde a vez', () => {
  /** Ana com o servidor fechando (`state.closing`): o envio é recusado como no ChatManager.closing(). */
  function closingSvc(dirName: string) {
    const dir = path.join(root, dirName);
    const state = { closing: true, n: 0 };
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => {
        if (state.closing) throw new ChatClosingError();
        return `s-${++state.n}`;
      },
      branchFor: async () => null,
    });
    const task = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
    return { svc, state, task };
  }
  const CLOSING_NOTE = 'não começou: o Claudio’s Club está reiniciando; na fila de Ana, começa quando o servidor voltar';

  it('começar com o servidor fechando: fica na fila, sem falha, e o tick do boot começa', async () => {
    const { svc, state, task } = closingSvc('closing-1');
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    const got = (await svc.start('p', t.id))!;
    expect(got).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect(got.history.at(-1)?.note).toBe(CLOSING_NOTE);
    await svc.tick(); // ainda fechando: segue na fila, e a nota não se repete
    expect(await task(t.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect((await task(t.id)).history.filter((h) => h.note === CLOSING_NOTE)).toHaveLength(1);
    state.closing = false; // o servidor subiu: o tick do boot pega a tarefa
    await svc.tick();
    expect(await task(t.id)).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null });
  });

  it('fim de turno com o servidor fechando (onIdle e onTurnDone): a tarefa segue em fazendo; depois do boot, o turno conclui', async () => {
    const dir = path.join(root, 'closing-turn');
    const state = { closing: false };
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => 's-1',
      branchFor: async () => null,
      closing: () => state.closing,
    });
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    await svc.start('p', t.id);
    const task = async () => (await svc.list('p'))!.find((x) => x.id === t.id)!;
    state.closing = true; // o turno termina durante o build
    await svc.onIdle('s-1', 'p', 'ana-1');
    await svc.onTurnDone('s-1');
    expect(await task()).toMatchObject({ status: 'doing', sessionId: 's-1' });
    state.closing = false; // o boot: a conversa retomada termina o turno de verdade
    await svc.onTurnDone('s-1');
    expect((await task()).status).toBe('review');
  });
});

describe('gate de recursos na fila', () => {
  const REASON = 'RAM disponível 1,2 GB (reserva 1,5 GB)';
  const NOTE = `aguardando recursos: ${REASON}`;
  /**
   * Ana ocupada (`state.busy`) põe a tarefa na fila. O gate (`state.free`) deixa passar ou segura, e conta as chamadas e as
   * partidas devolvidas (`state.released`). `state.failSend`: a conversa não abre.
   */
  function gated(dirName: string) {
    const dir = path.join(root, dirName);
    const state = { busy: true, free: false, calls: 0, released: 0, failSend: false };
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    let n = 0;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => {
        if (state.failSend) throw new Error('conversa não abriu');
        return `s-${++n}`;
      },
      branchFor: async () => null,
      isWorking: () => state.busy,
      resourceGate: async (): Promise<Reservation> => {
        state.calls++;
        return state.free ? { ok: true, release: () => void state.released++ } : { ok: false, reason: REASON };
      },
    });
    const task = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
    return { svc, state, task };
  }

  it('bloqueada: fica na fila com o motivo; a nota entra uma vez, mesmo com ticks seguidos', async () => {
    const { svc, state, task } = gated('gate-1');
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    await svc.start('p', t.id); // Ana ocupada: entra na fila
    state.busy = false;
    await svc.tick();
    const first = await task(t.id);
    expect(first).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String), resourceWait: { reason: REASON, since: expect.any(String) } });
    expect(first.history.filter((h) => h.note === NOTE)).toHaveLength(1);
    await svc.tick();
    await svc.tick();
    const later = await task(t.id);
    expect(later).toMatchObject({ status: 'todo', sessionId: null, resourceWait: { reason: REASON, since: first.resourceWait!.since } });
    expect(later.history.filter((h) => h.note === NOTE)).toHaveLength(1);
    expect(state.calls).toBe(3);
    expect(state.released).toBe(0);
  });

  it('liberada: começa, tira o motivo e devolve a reserva', async () => {
    const { svc, state, task } = gated('gate-2');
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    await svc.start('p', t.id);
    state.busy = false;
    await svc.tick();
    expect((await task(t.id)).resourceWait).not.toBeNull();
    state.free = true;
    await svc.tick();
    expect(await task(t.id)).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null, resourceWait: null });
    expect(state.released).toBe(1);
  });

  it('erro ao começar: a reserva volta mesmo assim, e a tarefa segue na fila', async () => {
    const { svc, state, task } = gated('gate-3');
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    await svc.start('p', t.id);
    state.busy = false;
    state.free = true;
    state.failSend = true;
    await svc.tick();
    expect(state.released).toBe(1);
    const got = await task(t.id);
    expect(got).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect(got.history.at(-1)?.note).toBe('não começou: conversa não abriu');
  });

  it('começar à mão ignora o gate, e tira o motivo que a fila tinha', async () => {
    const { svc, state, task } = gated('gate-4');
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1' }))!;
    await svc.start('p', t.id);
    state.busy = false;
    await svc.tick(); // segurada pelo gate
    expect((await task(t.id)).resourceWait).not.toBeNull();
    const calls = state.calls;
    expect(await svc.start('p', t.id)).toMatchObject({ status: 'doing', sessionId: 's-1', resourceWait: null });
    expect(state.calls).toBe(calls);
    expect(state.released).toBe(0);
  });
});

describe('quadro: Aguardar', () => {
  /** Ana com o que o ChatManager sabe: `working` diz quais conversas estão trabalhando agora. */
  function parked(dirName: string) {
    const dir = path.join(root, dirName);
    const sent: string[] = [];
    const working = new Set<string>();
    let n = 0;
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async (_p, _s, text) => {
        const session = `s-${++n}`;
        sent.push(text);
        working.add(session);
        return session;
      },
      branchFor: async () => null,
      isWorking: (_p, _s, except) => [...working].some((s) => s !== except),
    });
    /** O turno acabou: o processo avisa (onIdle) e o vigia também (onTurnDone). */
    const finish = async (session: string) => {
      working.delete(session);
      await svc.onIdle(session, 'p', 'ana-1');
      await svc.onTurnDone(session);
    };
    const tasksFile = path.join(dir, '.myco', 'tasks.json');
    return { svc, sent, finish, tasksFile };
  }

  it('criar sem começar (start false) vai para Aguardar, que conta como aberta; começar leva para fazendo', async () => {
    const { svc, sent } = parked('aguardar-1');
    const w = (await svc.create('p', { title: 'Espera', staffId: 'ana-1', start: false }))!;
    expect(w).toMatchObject({ status: 'waiting', sessionId: null });
    expect(w.history).toMatchObject([{ status: 'waiting' }]);
    expect((await svc.create('p', { title: 'Com start', staffId: 'ana-1' }))!.status).toBe('todo');
    expect(await svc.summary()).toEqual({ p: { open: 2, review: 0 } });

    expect(await svc.start('p', w.id)).toMatchObject({ status: 'doing', sessionId: 's-1' });
    expect(sent[0]).toContain('[Tarefa "Espera"]');
  });

  it('a fila nunca pega Aguardar: quando a da frente entrega, a próxima da fila começa e a de Aguardar fica', async () => {
    const { svc, sent, finish } = parked('aguardar-2');
    const [a, w, b] = [
      (await svc.create('p', { title: 'A', staffId: 'ana-1' }))!,
      (await svc.create('p', { title: 'W', staffId: 'ana-1', start: false }))!,
      (await svc.create('p', { title: 'B', staffId: 'ana-1' }))!,
    ];
    await svc.start('p', a.id); // s-1
    await svc.start('p', b.id); // fila
    await finish('s-1');
    expect((await svc.list('p'))!.map((t) => [t.title, t.status])).toEqual([
      ['A', 'review'],
      ['W', 'waiting'],
      ['B', 'doing'],
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('[Tarefa "B"]');
    const waiting = (await svc.list('p'))!.find((t) => t.id === w.id)!;
    expect(waiting.status).toBe('waiting');
    expect(waiting.queuedAt ?? null).toBeNull();
  });

  it('começar uma de Aguardar com ele ocupado põe na fila como A fazer; mover para Aguardar tira da fila', async () => {
    const { svc, sent, finish } = parked('aguardar-3');
    const [a, w, b] = [
      (await svc.create('p', { title: 'A', staffId: 'ana-1' }))!,
      (await svc.create('p', { title: 'W', staffId: 'ana-1', start: false }))!,
      (await svc.create('p', { title: 'B', staffId: 'ana-1' }))!,
    ];
    await svc.start('p', a.id); // s-1
    await svc.start('p', b.id); // fila
    expect(await svc.start('p', w.id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String) });
    expect(await svc.update('p', b.id, { status: 'waiting' })).toMatchObject({ status: 'waiting', queuedAt: null, queuedForce: false });

    await finish('s-1');
    expect((await svc.list('p'))!.map((t) => [t.title, t.status])).toEqual([
      ['A', 'review'],
      ['W', 'doing'],
      ['B', 'waiting'],
    ]);
    expect(sent[1]).toContain('[Tarefa "W"]');
    expect(sent).toHaveLength(2);
  });

  it('Aguardar não arquiva: só Pronto parado há mais de 7 dias sai do quadro', async () => {
    const { svc, tasksFile } = parked('aguardar-4');
    await svc.create('p', { title: 'W', staffId: 'ana-1', start: false });
    const raw = JSON.parse(await fs.readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>;
    raw[0]!.updatedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await fs.writeFile(tasksFile, JSON.stringify(raw));
    const [l] = (await svc.list('p'))!;
    expect(l).toMatchObject({ status: 'waiting' });
    expect(l!.archived).toBeUndefined();
  });

  it('"no ar" gravado antes carrega como pronto (tarefa e histórico), e não conta como aberto', async () => {
    const { svc, tasksFile } = parked('aguardar-5');
    await fs.mkdir(path.dirname(tasksFile), { recursive: true });
    const now = new Date().toISOString();
    const old = { id: 't-antiga', title: 'Antiga', description: '', status: 'live', staffId: null, sessionId: null, plan: null, branch: null, pr: null, createdAt: now, updatedAt: now, history: [{ at: now, status: 'live', by: 'you' }] };
    await fs.writeFile(tasksFile, JSON.stringify([old]));
    const [t] = (await svc.list('p'))!;
    expect(t).toMatchObject({ status: 'done', history: [{ status: 'done' }] });
    expect(await svc.summary()).toEqual({});
  });

  it('motivo: opcional, no máximo 200 caracteres, sem espaço nas bordas; sai junto com a coluna', async () => {
    const { svc } = parked('aguardar-6');
    const w = (await svc.create('p', { title: 'W', staffId: 'ana-1', start: false }))!;
    expect(await svc.update('p', w.id, { waitReason: '  Esperando o cliente  ' })).toMatchObject({ status: 'waiting', waitReason: 'Esperando o cliente' });
    await expect(svc.update('p', w.id, { waitReason: 'x'.repeat(201) })).rejects.toThrow(/máx. 200/);
    expect(await svc.update('p', w.id, { waitReason: '' })).toMatchObject({ waitReason: null });
    await svc.update('p', w.id, { waitReason: 'Cliente' });
    expect(await svc.update('p', w.id, { status: 'todo' })).toMatchObject({ status: 'todo', waitReason: null });
  });

  it('apagar o responsável: a tarefa em Aguardar continua em Aguardar, só solta o responsável', async () => {
    const { svc } = parked('aguardar-7');
    await svc.create('p', { title: 'W', staffId: 'ana-1', start: false });
    expect(await svc.releaseStaff('p', 'ana-1')).toBe(1);
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'waiting', staffId: null });
  });
});

describe('gestor como revisor (tarefa que ele passou)', () => {
  /** Giovana pede a Luana: sem `reviewerId` no pedido, Giovana revisa (conversa nova dela). `failReview`: a revisão não começa. */
  async function selfFlow(dirName: string, opts: { failReview?: boolean } = {}) {
    const dir = path.join(root, dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const sent: Array<{ staffId: string; text: string; session: string }> = [];
    const notified: Array<{ staffId: string; text: string; sessionId: string | null | undefined }> = [];
    const texts = new Map<string, string>();
    let n = 0;
    const people: Record<string, StaffProfile> = {
      'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'lu-1': { id: 'lu-1', name: 'Luana', role: 'Front-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'manual', worktree: false } as StaffProfile,
    };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text) => {
        if (opts.failReview && staffId === 'gio-1') throw new Error('sem conversa');
        const session = `s-${++n}`;
        sent.push({ staffId, text, session });
        return session;
      },
      branchFor: async () => null,
      notify: async (_p, staffId, text, sessionId) => void notified.push({ staffId, text, sessionId }),
      lastText: (sid) => texts.get(sid) ?? 'Pronto.',
      requesterSession: (_p, staffId) => (staffId === 'gio-1' ? 's-gio' : null),
      runTests: async (_c, command) => ({ command, ok: true, output: '', ms: 2000, at: '2026-11-09T12:00:00Z' }),
      sendTo: async (_p, sessionId) => sessionId,
    });
    const make = async (title: string) => (await svc.create('p', { title, staffId: 'lu-1' }, 'gio-1'))!;
    const current = async () => (await svc.list('p'))![0]!;
    return { svc, sent, notified, texts, make, current };
  }

  it('create: sem reviewerId no pedido, o gestor revisa; reviewerId mandado (null inclusive) vale; gestor = executor não revisa', async () => {
    const { svc } = await selfFlow('self-create');
    expect(await svc.create('p', { title: 'A', staffId: 'lu-1' }, 'gio-1')).toMatchObject({ reviewerId: 'gio-1' });
    expect(await svc.create('p', { title: 'B', staffId: 'lu-1', reviewerId: null }, 'gio-1')).toMatchObject({ reviewerId: null });
    expect(await svc.create('p', { title: 'C', staffId: 'lu-1', reviewerId: 'rev-1' }, 'gio-1')).toMatchObject({ reviewerId: 'rev-1' });
    expect(await svc.create('p', { title: 'D', staffId: 'gio-1' }, 'gio-1')).toMatchObject({ reviewerId: null });
    expect(await svc.create('p', { title: 'E', staffId: 'lu-1' })).toMatchObject({ reviewerId: null });
  });

  it('na entrega não avisa o gestor; a revisão vai para a conversa nova dele, com os testes já rodados', async () => {
    const { svc, sent, notified, make, current } = await selfFlow('self-entrega');
    const t = await make('Botão');
    expect(t).toMatchObject({ requestedBy: 'gio-1', reviewerId: 'gio-1' });
    await svc.start('p', t.id); // s-1 (Luana)
    await svc.onTurnDone('s-1');
    expect(notified).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ staffId: 'gio-1', session: 's-2' });
    expect(sent.at(-1)!.text).toContain('passaram em 2 s. Não rode de novo.');
    expect(await current()).toMatchObject({ status: 'review', tests: { ok: true }, review: { staffId: 'gio-1', sessionId: 's-2' } });
  });

  it('aprovada na revisão dele: ele é avisado na conversa em que pediu, com título e id', async () => {
    const { svc, notified, texts, make } = await selfFlow('self-aprova');
    const t = await make('Formulário');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // s-2: revisão dela
    texts.set('s-2', 'APROVADO\n\nok');
    await svc.onTurnDone('s-2');
    expect((await svc.list('p'))![0]!.status).toBe('done');
    expect(notified).toEqual([{ staffId: 'gio-1', sessionId: 's-gio', text: `[MyCo] Tarefa “Formulário” (id ${t.id}): aprovada na sua revisão, foi para pronto.` }]);
  });

  it('reprovada: não avisa o gestor; o ajuste volta para a conversa da Luana e a próxima rodada é pedida sozinha', async () => {
    const { svc, notified, texts, make, current } = await selfFlow('self-reprova');
    const t = await make('Tabela');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // s-2
    texts.set('s-2', 'REPROVADO\n\ntabela.tsx:3 falta o aria-label');
    await svc.onTurnDone('s-2');
    expect(notified).toEqual([]);
    expect(await current()).toMatchObject({ status: 'doing' });
    await svc.onTurnDone('s-1'); // ajustou: a rodada 2 é pedida à Giovana (s-3)
    expect(await current()).toMatchObject({ status: 'review', reviewRounds: 2, review: { sessionId: 's-3' } });
    expect(notified).toEqual([]);
  });

  it('no limite de revisões, o que sobrou fica com ele: avisa a conversa em que pediu', async () => {
    const { svc, notified, texts, make } = await selfFlow('self-limite');
    const t = await make('Relatório');
    await svc.start('p', t.id); // s-1
    await svc.onTurnDone('s-1'); // rodada 1 (s-2)
    for (const s of ['s-2', 's-3']) {
      texts.set(s, 'REPROVADO\n\najuste');
      await svc.onTurnDone(s); // reprovou: volta para fazendo
      await svc.onTurnDone('s-1'); // ajustou e terminou: a rodada 2 (s-3) é a última
    }
    expect(notified).toEqual([{ staffId: 'gio-1', sessionId: 's-gio', text: expect.stringContaining(`(id ${t.id}): o limite de 2 revisões automáticas foi atingido; o que sobrou fica com você.`) }]);
  });

  it('revisão dele não começou: ele recebe o aviso da entrega, como antes', async () => {
    const { svc, notified, make, current } = await selfFlow('self-falha', { failReview: true });
    const t = await make('Cabeçalho');
    await svc.start('p', t.id);
    await svc.onTurnDone('s-1');
    expect(notified).toEqual([{ staffId: 'gio-1', sessionId: 's-gio', text: expect.stringContaining('Luana entregou a tarefa “Cabeçalho”') }]);
    expect((await current()).history.at(-1)?.note).toBe('revisão automática não começou: sem conversa');
  });

  it('revisor diferente do gestor: a entrega avisa o gestor como antes, e a revisão vai para o revisor', async () => {
    const { svc, sent, notified } = await selfFlow('self-outro');
    const t = (await svc.create('p', { title: 'Lista', staffId: 'lu-1', reviewerId: 'rev-1' }, 'gio-1'))!;
    await svc.start('p', t.id);
    await svc.onTurnDone('s-1');
    expect(notified).toEqual([{ staffId: 'gio-1', sessionId: 's-gio', text: expect.stringContaining('Luana entregou a tarefa “Lista”') }]);
    expect(sent.at(-1)).toMatchObject({ staffId: 'rev-1' });
  });
});

describe('recusar o plano pelo Claudio’s Club', () => {
  /** Ana (ficha "só planeja") com um claude falso por conversa; o ChatManager de verdade. Sem plano pendente, nada muda. */
  function rejectHarness(dirName: string) {
    const dir = path.join(root, dirName);
    const procs: Array<{ emit: (ev: object) => void; written: string[] }> = [];
    const idle: Array<Promise<void>> = [];
    const rejected: Array<Promise<void>> = [];
    const notified: Array<{ staffId: string; text: string; sessionId: string | null }> = [];
    let n = 0;
    const settle = async () => {
      for (let i = 0; i < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await Promise.all([...idle, ...rejected]);
      }
    };
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'plan', worktree: false } as StaffProfile;
    const gio = { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    let svc: TaskService | null = null;
    const chats = new ChatManager({
      transcriptsDir: dir,
      usageFile: path.join(dir, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? `s-${++n}`, cwd: '.', args: [] }),
      spawnImpl: () => {
        const stdout = new PassThrough();
        const stdin = new PassThrough();
        const written: string[] = [];
        stdin.on('data', (c) => written.push(String(c)));
        const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 6000 + procs.length, kill: () => {} });
        procs.push({ emit: (ev) => stdout.write(JSON.stringify(ev) + '\n'), written });
        return proc as never;
      },
      onIdle: (sid, pid, staffId) => void idle.push(svc!.onIdle(sid, pid, staffId)),
      onPlanRejected: (sid) => void rejected.push(svc!.onPlanRejected(sid)),
    });
    svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : id === 'gio-1' ? gio : null),
      send: async (_p, staffId, text) => chats.send('p', null, staffId, text, 'next'),
      branchFor: async () => null,
      isWorking: (p, s, except) => chats.staffWorking(p, s, except),
      sendTo: (p, sid, s, text, images) => chats.send(p, sid, s, text, 'next', images),
      notify: async (_p, staffId, text, sessionId) => void notified.push({ staffId, text, sessionId: sessionId ?? null }),
      requesterSession: () => 's-gio',
    });
    const task = async (id: string) => (await svc!.list('p'))!.find((t) => t.id === id)!;
    return { svc, chats, procs, notified, rejected, settle, task };
  }

  it('recusa: vai para Aguardar sem executar, o gestor é avisado, a fila anda quando a conversa termina o turno', async () => {
    const { svc, chats, procs, notified, settle, task } = rejectHarness('rejeita-1');
    const a = (await svc.create('p', { title: 'A', description: 'refazer o login', staffId: 'ana-1' }, 'gio-1'))!;
    const b = (await svc.create('p', { title: 'B', staffId: 'ana-1' }))!;
    expect((await svc.start('p', a.id))!).toMatchObject({ status: 'planning', sessionId: 's-1' });
    await svc.start('p', b.id); // fila: A ocupa o funcionário enquanto planeja
    procs[0]!.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '1. Trocar a senha' } } });
    await settle();

    expect(chats.answer('s-1', 'r1', false, { reject: true, message: 'quero mudar tudo' })).toBe(true);
    await settle();
    // O texto que a conversa recebe é o fixo do servidor, não o que foi digitado.
    const denied = procs[0]!.written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(denied.at(-1)).toMatchObject({ response: { response: { behavior: 'deny', message: PLAN_REJECTED_MESSAGE } } });
    expect(await task(a.id)).toMatchObject({ status: 'waiting' });
    expect((await task(a.id)).history.at(-1)?.note).toBe('plano recusado pelo usuário');
    expect(notified).toEqual([
      { staffId: 'gio-1', sessionId: 's-gio', text: `[MyCo] O usuário recusou o plano da tarefa “A” (id ${a.id}); ela foi para Aguardar e não será executada.` },
    ]);
    // A conversa ainda termina o turno (o "entendi"): B só começa quando ela fica livre.
    expect((await task(b.id)).status).toBe('todo');

    procs[0]!.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Entendi, parei.' }] } });
    procs[0]!.emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'Entendi, parei.' });
    await settle();
    expect(await task(b.id)).toMatchObject({ status: 'planning', sessionId: 's-2' });
    // O fim do turno (processo e vigia) não move A para revisão nem entrega: ela segue em Aguardar.
    await svc.onTurnDone('s-1');
    await svc.onIdle('s-1', 'p', 'ana-1');
    expect(await task(a.id)).toMatchObject({ status: 'waiting' });
    expect(notified).toHaveLength(1);
    expect(chats.isWorking('s-1')).toBe(false);
  });

  it('sem plano pendente, recusar é negar normal: a mensagem digitada vai, nada muda na tarefa', async () => {
    const { svc, chats, procs, rejected, settle, task } = rejectHarness('rejeita-2');
    const t = (await svc.create('p', { title: 'C', staffId: 'ana-1' }))!;
    await svc.start('p', t.id); // s-1, planejando
    procs[0]!.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    await settle();
    expect(chats.answer('s-1', 'r1', false, { reject: true, message: 'agora não' })).toBe(true);
    await settle();
    const denied = procs[0]!.written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(denied.at(-1)).toMatchObject({ response: { response: { behavior: 'deny', message: 'agora não' } } });
    expect(rejected).toHaveLength(0);
    expect(await task(t.id)).toMatchObject({ status: 'planning' });
  });

  it('pedido de permissão que não é de plano, recusado com reject, não chama a recusa de plano', async () => {
    const { svc, chats, procs, rejected, settle, task } = rejectHarness('rejeita-3');
    const t = (await svc.create('p', { title: 'D', staffId: 'ana-1' }))!;
    await svc.start('p', t.id); // s-1
    procs[0]!.emit({ type: 'control_request', request_id: 'r9', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {} } });
    await settle();
    expect(chats.answer('s-1', 'r9', false, { reject: true })).toBe(true);
    expect(rejected).toHaveLength(0);
    expect(await task(t.id)).toMatchObject({ status: 'planning' });
  });

  it('recusa sem a tarefa em planejando (já aprovada) não mexe nela', async () => {
    const dir = path.join(root, 'rejeita-4');
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const notified: string[] = [];
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
      send: async () => 'sess-1',
      branchFor: async () => null,
      notify: async (_p, _s, text) => void notified.push(text),
    });
    const t = (await svc.create('p', { title: 'E', staffId: 'ana-1' }))!;
    await svc.start('p', t.id); // doing
    await svc.onPlanRejected('sess-1');
    expect((await svc.list('p'))![0]).toMatchObject({ status: 'doing' });
    expect(notified).toEqual([]);
  });
});

describe('dúvida da tarefa ao gestor', () => {
  const people: Record<string, StaffProfile> = {
    'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  };

  /** Tarefa da Ana pedida pela Giovana (sem revisor), já começada: a sessão de trabalho é `task().sessionId`. */
  async function pedida(dirName: string, perfilGestor: Partial<StaffProfile> = {}) {
    const dir = path.join(root, dirName);
    const gio = { ...people['gio-1'], ...perfilGestor } as StaffProfile; // ficha do gestor (ex.: `engine: 'codex'`)
    const sent: Array<{ staffId: string; text: string; force: boolean }> = [];
    const delivered: Array<{ sessionId: string; text: string }> = [];
    const asks = new Set<string>(); // perguntas por opções abertas na conversa de trabalho
    const answeredAsks: Array<{ sessionId: string; requestId: string; answers: Record<string, string | string[]> }> = [];
    const lastTexts: Record<string, string> = {};
    const working = new Set<string>();
    const gestor = { falha: false };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'gio-1' ? gio : people[id] ?? null),
      send: async (_p, staffId, text, force) => {
        sent.push({ staffId, text, force });
        if (staffId === 'gio-1' && gestor.falha) throw new Error('sem conversa');
        return `${staffId}-${sent.length}`;
      },
      branchFor: async () => null,
      isWorking: (_p, _s, except) => [...working].some((s) => s !== except),
      sendTo: async (_p, sessionId, _s, text) => {
        delivered.push({ sessionId, text });
        return sessionId;
      },
      lastText: (s) => lastTexts[s] ?? null,
      hasAsk: (_s, id) => asks.has(id),
      answerAsk: (sessionId, requestId, answers) => {
        if (!asks.has(requestId)) return false;
        asks.delete(requestId);
        answeredAsks.push({ sessionId, requestId, answers });
        return true;
      },
      apiUrl: 'http://127.0.0.1:4848',
      sandboxApiUrl: 'http://127.0.0.2:4848',
    });
    const t = (await svc.create('p', { title: 'Relatório', description: 'Exportar CSV', staffId: 'ana-1', reviewerId: null }, 'gio-1', 'gio-s'))!;
    await svc.start('p', t.id);
    const task = async () => (await svc.list('p'))![0]!;
    return { svc, sent, delivered, asks, answeredAsks, lastTexts, working, gestor, task };
  }

  it('onAsk leva a pergunta com opções ao gestor, numa conversa nova dele; a tarefa segue', async () => {
    const h = await pedida('d-ask');
    const antes = await h.task();
    h.asks.add('req-1');
    expect(await h.svc.onAsk(antes.sessionId!, 'req-1', [{ question: 'Qual banco?', options: ['Postgres', 'MySQL'] }])).toBe(true);

    const msg = h.sent.at(-1)!;
    expect(msg).toMatchObject({ staffId: 'gio-1', force: false });
    expect(msg.text).toContain('Qual banco?');
    expect(msg.text).toContain('Postgres | MySQL');
    expect(msg.text).toContain(`POST http://127.0.0.1:4848/api/projects/p/tasks/${antes.id}/answer`);
    expect(msg.text).toContain('{"questionId": "req-1", "answers": {"<pergunta>": "<opção>"}}');
    expect(msg.text).toContain('"escalate": true');

    const depois = await h.task();
    expect(depois).toMatchObject({ status: 'doing', questionCount: 1, question: { id: 'req-1', source: 'ask', status: 'open', managerSession: expect.stringMatching(/^gio-1-/) } });
    // A conversa do gestor não é da tarefa: a resposta dele ao fim do turno não muda nada.
    await h.svc.onTurnDone(depois.question!.managerSession!);
    expect(await h.task()).toMatchObject({ status: 'doing', question: { status: 'open' } });
  });

  it('a 4ª dúvida não vai ao gestor: fica escalada, com você', async () => {
    const h = await pedida('d-limite');
    const work = (await h.task()).sessionId!;
    for (const id of ['req-1', 'req-2', 'req-3']) {
      h.asks.add(id);
      expect(await h.svc.onAsk(work, id, [{ question: id, options: ['sim', 'não'] }])).toBe(true);
      const t = await h.task();
      await h.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: t.question!.managerSession! }, { questionId: id, answers: { [id]: 'sim' } });
    }
    const enviados = h.sent.length;
    h.asks.add('req-4');
    expect(await h.svc.onAsk(work, 'req-4', [{ question: 'Quarta?', options: ['a'] }])).toBe(false);
    expect(h.sent.length).toBe(enviados);
    expect(await h.task()).toMatchObject({ questionCount: 3, question: { id: 'req-4', status: 'escalated' } });
  });

  it('se o envio ao gestor falha, a dúvida escala para você', async () => {
    const h = await pedida('d-falha');
    const work = (await h.task()).sessionId!;
    h.gestor.falha = true;
    h.asks.add('req-1');
    expect(await h.svc.onAsk(work, 'req-1', [{ question: 'Qual?', options: ['a'] }])).toBe(false);
    const t = await h.task();
    expect(t).toMatchObject({ questionCount: 1, question: { id: 'req-1', status: 'escalated' } });
    expect(t.question!.managerSession).toBeUndefined();
  });

  it('answerQuestion: quem não pediu, ou fala de outra conversa, leva 403; id errado, 400', async () => {
    const h = await pedida('d-403');
    const work = (await h.task()).sessionId!;
    h.asks.add('req-1');
    await h.svc.onAsk(work, 'req-1', [{ question: 'Qual?', options: ['a', 'b'] }]);
    const t = await h.task();
    const body = { questionId: 'req-1', answers: { 'Qual?': 'a' } };
    await expect(h.svc.answerQuestion('p', t.id, null, body)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(h.svc.answerQuestion('p', t.id, { staffId: 'ana-1', sessionId: t.question!.managerSession! }, body)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(h.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: 'outra' }, body)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(h.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: t.question!.managerSession! }, { ...body, questionId: 'outra' })).rejects.toThrow('não há essa dúvida');
    expect(h.answeredAsks).toEqual([]);
  });

  it('answerQuestion numa pergunta por opções chama answerAsk e fecha como resposta do gestor', async () => {
    const h = await pedida('d-ok-ask');
    const work = (await h.task()).sessionId!;
    h.asks.add('req-1');
    await h.svc.onAsk(work, 'req-1', [{ question: 'Qual?', options: ['a', 'b'] }]);
    const t = await h.task();
    const answers = { 'Qual?': 'a' };
    const out = await h.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: t.question!.managerSession! }, { questionId: 'req-1', answers });
    expect(h.answeredAsks).toEqual([{ sessionId: work, requestId: 'req-1', answers }]);
    expect(out?.question).toMatchObject({ status: 'answered', answeredBy: 'manager', answer: 'Qual?: a' });
  });

  it('pergunta por opções que já não está aberta na conversa: 409', async () => {
    const h = await pedida('d-409');
    const work = (await h.task()).sessionId!;
    h.asks.add('req-1');
    await h.svc.onAsk(work, 'req-1', [{ question: 'Qual?', options: ['a'] }]);
    const t = await h.task();
    h.asks.delete('req-1'); // sumiu da conversa (já respondida ali, ou o processo caiu)
    await expect(
      h.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: t.question!.managerSession! }, { questionId: 'req-1', answers: { 'Qual?': 'a' } }),
    ).rejects.toBeInstanceOf(TaskConflictError);
  });

  it('dúvida escrita: a resposta do gestor vai ao funcionário como mensagem', async () => {
    const h = await pedida('d-texto');
    const before = await h.task();
    const work = before.sessionId!;
    h.lastTexts[work] = 'Até aqui ok.\nDÚVIDA: devo mexer no SPEC?';
    await h.svc.onTurnDone(work);
    const q = (await h.task()).question!;
    expect(q).toMatchObject({ source: 'text', status: 'open', text: 'DÚVIDA: devo mexer no SPEC?' });

    const out = await h.svc.answerQuestion('p', before.id, { staffId: 'gio-1', sessionId: q.managerSession! }, { questionId: q.id, text: 'Não, só o código.' });
    expect(h.delivered).toEqual([{ sessionId: work, text: 'Resposta de Giovana à sua dúvida: Não, só o código.' }]);
    expect(out?.question).toMatchObject({ status: 'answered', answeredBy: 'manager' });
  });

  it('escalate: a dúvida passa para você, e nada vai à conversa do funcionário', async () => {
    const h = await pedida('d-escala');
    const work = (await h.task()).sessionId!;
    h.asks.add('req-1');
    await h.svc.onAsk(work, 'req-1', [{ question: 'Apagar a base?', options: ['sim', 'não'] }]);
    const t = await h.task();
    const out = await h.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: t.question!.managerSession! }, { questionId: 'req-1', escalate: true });
    expect(out?.question).toMatchObject({ status: 'escalated' });
    expect(h.answeredAsks).toEqual([]);
    expect(h.delivered).toEqual([]);
  });

  it('respondida pelo usuário no chat: o gestor que tentar depois leva 409 com o resumo', async () => {
    const h = await pedida('d-usuario');
    const work = (await h.task()).sessionId!;
    h.asks.add('req-1');
    await h.svc.onAsk(work, 'req-1', [{ question: 'Qual?', options: ['a'] }]);
    const t = await h.task();
    await h.svc.onAskAnswered(work, 'req-1', 'user', 'Postgres');
    const fechada = (await h.task()).question!;
    expect(fechada).toMatchObject({ status: 'answered', answeredBy: 'user', answer: 'Postgres' });

    // Repetida (ou de outro lado), não muda nada.
    await h.svc.onAskAnswered(work, 'req-1', 'manager', 'MySQL');
    expect((await h.task()).question).toMatchObject({ answeredBy: 'user', answer: 'Postgres', answeredAt: fechada.answeredAt });

    const body = { questionId: 'req-1', answers: { 'Qual?': 'a' } };
    const gestor = { staffId: 'gio-1', sessionId: t.question!.managerSession! };
    await expect(h.svc.answerQuestion('p', t.id, gestor, body)).rejects.toBeInstanceOf(TaskConflictError);
    await expect(h.svc.answerQuestion('p', t.id, gestor, body)).rejects.toThrow('o usuário já respondeu: Postgres');
    expect(h.answeredAsks).toEqual([]);
  });

  it('DÚVIDA: no fim do turno segura a entrega; o turno seguinte sem marcador fecha a dúvida e entrega', async () => {
    const h = await pedida('d-segura');
    const work = (await h.task()).sessionId!;
    h.lastTexts[work] = '**Dúvida:** o endpoint é público?\nAté lá, sigo.';
    await h.svc.onTurnDone(work);
    await h.svc.onTurnDone(work); // o mesmo turno de novo: não abre outra dúvida
    expect(await h.task()).toMatchObject({ status: 'doing', questionCount: 1, question: { source: 'text', status: 'open' } });
    expect((await h.task()).question!.text).toBe('**Dúvida:** o endpoint é público?\nAté lá, sigo.');

    h.lastTexts[work] = 'Segui com o SPEC.';
    await h.svc.onTurnDone(work);
    expect(await h.task()).toMatchObject({ status: 'review', question: { status: 'answered', answeredBy: 'user' } });
  });

  it('tarefa com dúvida ao gestor não é órfã: a conversa parada de propósito não é retomada', async () => {
    const h = await pedida('d-orfa');
    const work = (await h.task()).sessionId!;
    h.asks.add('req-1');
    await h.svc.onAsk(work, 'req-1', [{ question: 'Qual?', options: ['a'] }]);
    await h.svc.tick(new Date(Date.now() + 5 * 60_000)); // passou do ORPHAN_MS, mas não do prazo da dúvida
    expect(h.delivered).toEqual([]);
    const t = await h.task();
    expect(t).toMatchObject({ status: 'doing', question: { status: 'open' } });
    expect(t.resumedAt).toBeFalsy();
  });

  it('dúvida sem resposta do gestor em 15 min escala para você; a demora não conta como resposta', async () => {
    const h = await pedida('d-prazo');
    const work = (await h.task()).sessionId!;
    h.asks.add('req-1');
    await h.svc.onAsk(work, 'req-1', [{ question: 'Qual?', options: ['a'] }]);
    await h.svc.tick(new Date(Date.now() + 16 * 60_000));
    const t = await h.task();
    expect(t.question).toMatchObject({ status: 'escalated' });
    expect(t.question!.answeredBy).toBeUndefined();
    expect(t.history.at(-1)?.note).toBe('dúvida sem resposta do gestor no prazo: vai para você');
    expect(h.delivered).toEqual([]);
  });

  it('no reinício, a pergunta por opções que ficou aberta vira dúvida escrita; a resposta do gestor chega como mensagem', async () => {
    const dir = path.join(root, 'd-reinicio');
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    const antes = new Date(Date.now() - 60_000).toISOString();
    const tarefa = {
      id: 't-old', title: 'Antiga', description: '', status: 'doing', staffId: 'ana-1', sessionId: 'ana-sess', plan: null, branch: null, pr: null,
      createdAt: antes, updatedAt: antes, history: [], requestedBy: 'gio-1', requestedSession: 'gio-s', questionCount: 1,
      question: { id: 'req-old', source: 'ask', questions: [{ question: 'Qual?', options: ['a'] }], status: 'open', askedAt: antes, managerSession: 'gio-old' },
    };
    await fs.writeFile(path.join(dir, '.myco', 'tasks.json'), JSON.stringify([tarefa]));
    const delivered: Array<{ sessionId: string; text: string }> = [];
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async () => 'nova',
      branchFor: async () => null,
      sendTo: async (_p, sessionId, _s, text) => {
        delivered.push({ sessionId, text });
        return sessionId;
      },
      hasAsk: () => false,
      apiUrl: 'http://127.0.0.1:4848',
    });
    const t = (await svc.list('p'))![0]!;
    expect(t.question).toMatchObject({ id: 'req-old', source: 'text', status: 'open' });
    expect(t.history.at(-1)?.note).toBe('dúvida de antes do reinício: a resposta do gestor chega como mensagem');

    await expect(
      svc.answerQuestion('p', 't-old', { staffId: 'gio-1', sessionId: 'gio-old' }, { questionId: 'req-old', text: 'Use a' }),
    ).resolves.toMatchObject({ question: { status: 'answered', answeredBy: 'manager' } });
    expect(delivered).toEqual([{ sessionId: 'ana-sess', text: 'Resposta de Giovana à sua dúvida: Use a' }]);
  });

  it('a URL da dúvida segue o motor da ficha do gestor: Codex, a da sandbox; Claude, a da API local', async () => {
    const codex = await pedida('d-url-codex', { engine: 'codex' });
    codex.asks.add('req-1');
    await codex.svc.onAsk((await codex.task()).sessionId!, 'req-1', [{ question: 'Qual?', options: ['a'] }]);
    expect(codex.sent.at(-1)!.text).toContain('POST http://127.0.0.2:4848/api/projects/p/tasks/');
    expect(codex.sent.at(-1)!.text).not.toContain('127.0.0.1');

    const claude = await pedida('d-url-claude');
    claude.asks.add('req-1');
    await claude.svc.onAsk((await claude.task()).sessionId!, 'req-1', [{ question: 'Qual?', options: ['a'] }]);
    expect(claude.sent.at(-1)!.text).toContain('POST http://127.0.0.1:4848/api/projects/p/tasks/');
    expect(claude.sent.at(-1)!.text).not.toContain('127.0.0.2');
  });
});
