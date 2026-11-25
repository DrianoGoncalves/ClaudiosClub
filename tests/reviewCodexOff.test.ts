import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountUsage, EngineOverride, Project, StaffProfile, Task } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { StaffService, type StaffServiceOptions } from '../server/staff/service';
import { readProfile } from '../server/staff/store';
import { TaskError, TaskService } from '../server/tasks';
import { removeTemp } from './support/tmp';

// Revisor indisponível (t-e0fae2): quem revisa roda no Codex e o Codex está desligado nas configurações. A revisão abre com o MESMO revisor no Claude, só leitura, na mesma entrega, e o card registra o
// motor usado. Revisor diferente de quem executou continua obrigatório, e o Codex ligado (ou revisor do Claude) não muda nada. Não existe forma de a ficha ou a política exigir o Codex: nada a respeitar.

// A trava de consumo e a config leem MYCO_HOME: uma pasta temporária (senão vale o ~/.myco de quem roda os testes).
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-codexoff-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codexoff-'));
});
afterAll(() => removeTemp(root, home));

const person = (id: string, name: string, over: Partial<StaffProfile> = {}) => ({ id, name, role: 'Dev', autonomy: 'acceptEdits', worktree: false, servers: [], reportsTo: [], projectId: 'p', ...over }) as unknown as StaffProfile;

interface Sent {
  staffId: string;
  session: string;
  text: string;
  override?: EngineOverride;
  reviewOnly?: boolean;
}

/** Ana faz; Rui revisa (`reviewer` dá o motor e a ficha dele). `codexOn`: o Codex ligado nas configurações (padrão: desligado; 'absent': sem a dependência, o servidor não sabe e segue o motor da ficha). */
async function board(dirName: string, o: { reviewer?: Partial<StaffProfile>; codexOn?: boolean | 'absent'; sendFails?: string } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const people: Record<string, StaffProfile> = {
    'ana-1': person('ana-1', 'Ana'),
    'rev-1': person('rev-1', 'Rui', { role: 'Revisor', engine: 'codex', model: 'gpt-6-sol', ...o.reviewer }),
  };
  const sent: Sent[] = [];
  /** As conversas que o servidor pôs no motor secundário na memória (ver `restoreFallbacks`). */
  const overrides: Array<[string, EngineOverride]> = [];
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text, _force, override, reviewOnly) => {
      if (o.sendFails && staffId === 'rev-1') throw new Error(o.sendFails);
      const session = `${staffId}-${++n}`;
      sent.push({ staffId, session, text, ...(override && { override }), ...(reviewOnly !== undefined && { reviewOnly }) });
      return session;
    },
    sendTo: async (_p, session) => session,
    branchFor: async () => null,
    isWorking: () => false,
    isSessionWorking: () => false,
    lastText: () => null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
    setOverride: (session, override) => void overrides.push([session, override]),
    ...(o.codexOn !== 'absent' && { codexOn: async () => o.codexOn === true }),
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  /** A Ana entrega a tarefa (o Rui é o revisor marcado): a revisão automática abre pelo caminho de sempre. */
  const delivered = async (title = 'Relatório') => {
    const t = (await svc.create('p', { title, description: `desc de ${title}`, acceptance: `critério de ${title}`, staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await svc.start('p', t.id);
    await svc.onTurnDone((await get(t.id)).sessionId!);
    return t.id;
  };
  const reviewsOf = () => sent.filter((s) => s.staffId === 'rev-1');
  return { dir, svc, sent, get, delivered, reviewsOf, people, overrides };
}

describe('revisor do Codex com o Codex desligado: a revisão abre com ele no Claude, só leitura', () => {
  it('revisão automática: o pedido sai com o override Claude e `reviewOnly`, o card guarda a sessão e o motor, e não há nota de "não começou"', async () => {
    const b = await board('desligado');
    const id = await b.delivered();
    expect(b.reviewsOf()).toHaveLength(1);
    const req = b.reviewsOf()[0]!;
    expect(req.override).toEqual({ engine: 'claude', model: '' });
    expect(req.reviewOnly).toBe(true);
    // O mesmo pedido da revisão (a entrega, o critério e a rubrica): só o motor muda.
    expect(req.text).toMatch(/\[Revisão da tarefa "Relatório"\][\s\S]*critério de Relatório[\s\S]*APROVADO ou REPROVADO/);

    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'review', reviewRounds: 1, review: { staffId: 'rev-1', sessionId: req.session, ranOn: { engine: 'claude', why: 'codex-off', sha: null } } });
    expect(t.reviewRetry).toBeUndefined();
    expect(t.sessions!.find((s) => s.id === req.session)).toMatchObject({ role: 'review', staffId: 'rev-1', engine: 'claude' });
    const notes = t.history.map((h) => h.note ?? '');
    expect(notes).toContain('revisão pedida a Rui no Claude (o Codex está desligado nas configurações)');
    expect(notes.some((x) => x.startsWith('revisão automática não começou'))).toBe(false);
  });

  it('o commit da entrega vai no registro: o mesmo SHA que a revisão julga (pedido manual da tela, com a entrega já commitada)', async () => {
    const b = await board('desligado-sha');
    const id = await b.delivered();
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    all[0]!.checkpoint = { sha: 'abcdef1234567890abcdef1234567890abcdef12', at: new Date().toISOString() };
    await fs.writeFile(file, JSON.stringify(all));
    await b.svc.requestReview('p', id, 'rev-1', true);
    const t = (await b.get(id)) as Task;
    expect(t.review!.ranOn).toEqual({ engine: 'claude', why: 'codex-off', sha: 'abcdef1234567890abcdef1234567890abcdef12' });
    expect(t.history.at(-1)?.note).toBe('revisão pedida a Rui no Claude (o Codex está desligado nas configurações), entrega abcdef1');
    expect(b.reviewsOf().at(-1)!.override).toEqual({ engine: 'claude', model: '' });
  });

  it('o secundário Claude da ficha vale: o modelo e o esforço dele', async () => {
    const b = await board('desligado-secundario', { reviewer: { fallback: { engine: 'claude', model: 'sonnet', effort: 'high' } } });
    await b.delivered();
    expect(b.reviewsOf()[0]!.override).toEqual({ engine: 'claude', model: 'sonnet', effort: 'high' });
  });

  it('Codex ligado, revisor do Claude, ou o servidor sem saber do Codex: nada muda (sem override, sem marca, o motor da ficha)', async () => {
    for (const [name, o] of [
      ['ligado', { codexOn: true }],
      ['revisor-claude', { codexOn: false, reviewer: { engine: 'claude' as const, model: 'sonnet' } }],
      ['sem-dependencia', { codexOn: 'absent' as const }],
    ] as const) {
      const b = await board(`inalterado-${name}`, o);
      const id = await b.delivered();
      const req = b.reviewsOf()[0]!;
      expect(req.override, name).toBeUndefined();
      expect(req.reviewOnly, name).toBe(true);
      const t = await b.get(id);
      expect(t.review!.ranOn, name).toBeUndefined();
      expect(t.sessions!.find((s) => s.id === req.session)!.engine, name).toBe(o.reviewer?.engine ?? 'codex');
      expect(t.history.some((h) => h.note?.includes('no Claude')), name).toBe(false);
    }
  });

  it('o revisor continua tendo de ser outro: quem executou não revisa a própria tarefa, com o Codex desligado também', async () => {
    const b = await board('mesmo-revisor', { reviewer: { engine: 'codex' } });
    b.people['ana-1'] = person('ana-1', 'Ana', { engine: 'codex' });
    const id = await b.delivered();
    const before = b.reviewsOf().length;
    await expect(b.svc.requestReview('p', id, 'ana-1', true)).rejects.toBeInstanceOf(TaskError);
    await expect(b.svc.requestReview('p', id, 'ana-1', true)).rejects.toThrow('a revisão precisa ser de outro funcionário');
    expect(b.reviewsOf()).toHaveLength(before);
    expect(b.sent.filter((s) => s.staffId === 'ana-1' && s.override)).toEqual([]);
  });

  it('o reinício devolve a conversa da revisão ao Claude (o override vive só na memória): com o Codex ligado de novo também, e só enquanto espera o veredito', async () => {
    const b = await board('reinicio');
    const id = await b.delivered();
    const session = (await b.get(id)).review!.sessionId;
    expect(await b.svc.restoreFallbacks()).toBe(1);
    expect(b.overrides).toEqual([[session, { engine: 'claude', model: '' }]]);

    // Revisão feita no Codex (sem `ranOn`): nada a devolver.
    const c = await board('reinicio-codex', { codexOn: true });
    await c.delivered();
    expect(await c.svc.restoreFallbacks()).toBe(0);
    expect(c.overrides).toEqual([]);

    // Com o veredito dado, a conversa não volta a ser aberta por conta da tarefa.
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    all[0]!.review.verdict = 'approved';
    await fs.writeFile(file, JSON.stringify(all));
    b.overrides.length = 0;
    expect(await b.svc.restoreFallbacks()).toBe(0);
  });

  it('sem a dependência do Codex o erro "desligado" segue parando a revisão, como antes (a nota e o retry de sempre)', async () => {
    const b = await board('sem-dep-erro', { codexOn: 'absent', sendFails: 'O Codex está desligado nas configurações: ligue "Usar o Codex (GPT)"' });
    const id = await b.delivered();
    const t = await b.get(id);
    expect(t.history.map((h) => h.note ?? '').some((x) => x.startsWith('revisão automática não começou: O Codex está desligado'))).toBe(true);
    expect(t.review?.ranOn).toBeUndefined();
  });
});

describe('o Claude que abre no lugar do Codex (chatSpawn): só leitura, sem tocar no Codex', () => {
  const projectPath = () => path.join(root, 'staff-proj');
  const project = (): Project => ({ id: 'proj-id', path: projectPath(), name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null });
  const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
  const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
  const service = (over: Partial<StaffServiceOptions> = {}) =>
    new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage, codexEnabled: async () => false, ...over });
  const optionOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('com o override do pedido de revisão, a ficha do Codex abre como Claude, sem edição, sem modelo do Codex e sem pedir o Codex; sem override, o Codex desligado recusa', async () => {
    await fs.mkdir(projectPath(), { recursive: true });
    // A ficha do Codex nasce com o Codex ligado; depois o dono o desliga nas configurações.
    const p = (await service({ codexEnabled: async () => true }).hire('proj-id', { name: 'Revisor Codex', role: 'Revisor', mission: 'Revisar', autonomy: 'acceptEdits', launch: false, engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    const svc = service();
    const spawn = (await svc.chatSpawn('proj-id', null, p.id, undefined, { engine: 'claude', model: '' }, true))!;
    expect(spawn.engine).toBeUndefined(); // Claude
    expect(spawn.codex).toBeUndefined();
    expect(spawn.args).not.toContain('--model'); // o padrão do Claude, não o `gpt-6-sol` da ficha
    expect(optionOf(spawn.args, '--permission-mode')).toBe('acceptEdits');
    const denied = optionOf(spawn.args, '--disallowedTools')!.split(',');
    expect(denied).toEqual(expect.arrayContaining(['Edit', 'Write']));
    expect(denied).toContain('mcp__myco-tarefa'); // o revisor não cancela
    // A conversa guarda que é só leitura (reabrir mantém) e a ficha segue no Codex. O override vive na memória do servidor (o modelo vazio não cabe na entrada da sessão: ver `restoreFallbacks`).
    const saved = await readProfile(projectPath(), p.id);
    expect(saved).toMatchObject({ engine: 'codex', model: 'gpt-6-sol' });
    expect(saved!.sessions.find((s) => s.id === spawn.sessionId)).toMatchObject({ readOnly: true });

    // O mesmo revisor sem o override: com o Codex desligado, não abre.
    await expect(svc.chatSpawn('proj-id', null, p.id, undefined, undefined, true)).rejects.toThrow('O Codex está desligado nas configurações');
  });
});
