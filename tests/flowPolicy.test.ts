import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { FlowPolicies, FlowPolicyInput, RESTRICTIVE_GATES, applyFlowInput, legacyPolicy, ownerGateOf } from '../server/flowPolicy';
import { stuckInboxItem } from '../server/inboxItems';
import { secretDenyRules } from '../server/staff/ficha';
import { TaskError, TaskForbiddenError, TaskService, ownAlerts, readTasks, stuckState } from '../server/tasks';
import { FLOW_PRESETS, type FlowPolicy, type StaffProfile, type Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// Política de fluxo por projeto (t-80d672): o modo (Automático, Supervisionado, Manual, Personalizado) e o portão de aprovação final do dono. A política mora em `~/.myco` (aqui, um arquivo
// temporário por teste), fora do projeto: o agente não a grava. Repositórios git de verdade só nos testes do commit.

// O commit e o git de verdade passam dos 5 s padrão sob carga.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// A mescla de verdade precisa de uma worktree: aqui `locateCode` e `mergeCode` podem ser trocados por um teste (como em taskCancel.test.ts).
const merging = vi.hoisted(() => ({
  place: null as null | { where: 'worktree'; path: string; branch: string },
  merge: null as null | (() => Promise<{ sha: string; base: string; branch: string; tests: null }>),
}));
vi.mock('../server/taskCode', async (original) => {
  const actual = await original<typeof import('../server/taskCode')>();
  return {
    ...actual,
    locateCode: ((...args: Parameters<typeof actual.locateCode>) => (merging.place ? Promise.resolve(merging.place) : actual.locateCode(...args))) as typeof actual.locateCode,
    mergeCode: ((...args: Parameters<typeof actual.mergeCode>) => (merging.merge ? merging.merge() : actual.mergeCode(...args))) as typeof actual.mergeCode,
  };
});

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-flow-'));
});
afterAll(() => removeTemp(root));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
const commits = (dir: string) => Number(git(dir, 'rev-list', '--count', 'HEAD').trim());
const person = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Dev', autonomy: 'acceptEdits', worktree: false, servers: [], ...extra }) as unknown as StaffProfile;

/** Ana faz a tarefa, Rui revisa. A política vem de um arquivo próprio de cada teste. `git`: o projeto é um repositório (para o commit automático). */
async function project(name: string, opts: { git?: boolean; ana?: Partial<StaffProfile> } = {}) {
  const dir = path.join(root, name);
  const policyFile = path.join(root, `${name}-flow-policies.json`);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  if (opts.git) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(dir, 'a.ts'), 'export const v = 1;\n');
    git(dir, 'add', '--', 'a.ts');
    git(dir, 'commit', '-q', '-m', 'base');
  }
  const policies = new FlowPolicies(policyFile, () => {});
  const people: Record<string, StaffProfile> = { 'ana-1': person('ana-1', 'Ana', opts.ana), 'rev-1': person('rev-1', 'Rui') };
  const texts = new Map<string, string>();
  const told: string[] = [];
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async () => `s-${++n}`,
    sendTo: async (_p, session) => session,
    branchFor: async () => null,
    lastText: (session) => texts.get(session) ?? null,
    notify: async (_p, _s, text) => {
      told.push(text);
    },
    flow: policies,
  });
  const file = path.join(dir, '.myco', 'tasks.json');
  const get = async (id: string) => (await readTasks(dir)).find((t) => t.id === id)!;
  const raw = async () => JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
  const patch = async (id: string, fields: Record<string, unknown>) => {
    const all = await raw();
    Object.assign(all.find((t) => t.id === id)!, fields);
    await fs.writeFile(file, JSON.stringify(all));
  };
  const make = async (title: string, reviewerId: string | null = 'rev-1') => (await svc.create('p', { title, staffId: 'ana-1', reviewerId }))!;
  /** Começa (conversa de trabalho s-N), entrega e, com revisor, a revisão abre sozinha (s-N+1). `fields`: o que a detecção de edição gravaria no card antes do fim do turno (`changedFiles`). */
  const deliver = async (id: string, session: string, fields?: Record<string, unknown>) => {
    if ((await get(id)).status === 'todo') await svc.start('p', id);
    if (fields) await patch(id, fields);
    await svc.onTurnDone(session);
  };
  const verdict = async (session: string, text: string) => {
    texts.set(session, text);
    await svc.onTurnDone(session);
  };
  const alerts = async () => ownAlerts((await svc.list('p'))!);
  /** O que a conversa de revisão responderia: aprova a entrega. */
  const approved = (session: string) => verdict(session, 'APROVADO\n\nTudo conferido.');
  return { dir, svc, policies, policyFile, texts, told, get, make, deliver, verdict, approved, alerts, raw, patch, file };
}

const owner = (svc: TaskService, id: string) => svc.update('p', id, { status: 'done' }, true);
const stored = (p: Awaited<ReturnType<typeof project>>) => fs.readFile(p.policyFile, 'utf8').then((s) => JSON.parse(s) as { projects: Record<string, Record<string, unknown>> });

describe('presets e corpo da política', () => {
  it('os presets moram em um lugar só (FLOW_PRESETS) e têm os valores combinados', () => {
    expect(FLOW_PRESETS).toEqual({
      auto: { plan: 'ai', completion: 'ai', commit: true },
      supervised: { plan: 'ai', completion: 'owner', commit: true },
      manual: { plan: 'owner', completion: 'owner', commit: false },
    });
    // O servidor não guarda cópia deles: o preset aplicado é o do FLOW_PRESETS.
    for (const mode of ['auto', 'supervised', 'manual'] as const) expect(applyFlowInput(legacyPolicy(false), { mode })).toMatchObject({ mode, ...FLOW_PRESETS[mode], completionChosen: true });
  });

  it('a política virtual é o que o projeto já fazia, e nenhum preset é bypassPermissions', () => {
    expect(legacyPolicy(true)).toEqual({ mode: 'custom', plan: 'owner', completion: 'ai', commit: true, source: 'default', completionChosen: false });
    expect(JSON.stringify(FLOW_PRESETS)).not.toMatch(/bypass/i);
  });

  it('mexer num portão grava custom, mescla sobre os vigentes e só conta a conclusão se ela veio no corpo', () => {
    const sup = { mode: 'supervised' as const, ...FLOW_PRESETS.supervised, source: 'stored' as const, completionChosen: true };
    expect(applyFlowInput(sup, { commit: false })).toEqual({ mode: 'custom', plan: 'ai', completion: 'owner', commit: false, completionChosen: true });
    expect(applyFlowInput(sup, { completion: 'ai' })).toMatchObject({ mode: 'custom', completion: 'ai', plan: 'ai', commit: true });
    // Projeto antigo mexendo só no commit: herda 'ai' da política virtual, mas não ESCOLHEU a conclusão.
    expect(applyFlowInput(legacyPolicy(false), { commit: true })).toEqual({ mode: 'custom', plan: 'owner', completion: 'ai', commit: true, completionChosen: false });
    expect(applyFlowInput(legacyPolicy(false), { completion: 'ai' })).toMatchObject({ completionChosen: true });
    // Nada mudou de fato num preset: continua o preset.
    expect(applyFlowInput(sup, { completion: 'owner', commit: true })).toMatchObject({ mode: 'supervised' });
  });

  it('o corpo é estrito: um preset OU portões, nunca os dois, e custom não se pede', () => {
    const bad = (body: unknown) => FlowPolicyInput.safeParse(body).success;
    expect(bad({ mode: 'auto' })).toBe(true);
    expect(bad({ plan: 'ai', completion: 'owner', commit: true })).toBe(true);
    expect(bad({ commit: false })).toBe(true);
    expect(bad({})).toBe(false);
    expect(bad({ mode: 'custom' })).toBe(false);
    expect(bad({ mode: 'auto', commit: true })).toBe(false);
    expect(bad({ completion: 'ninguem' })).toBe(false);
    expect(bad({ commit: 'sim' })).toBe(false);
    expect(bad({ mode: 'auto', extra: 1 })).toBe(false);
  });
});

describe('onde a política fica gravada', () => {
  it('sobrevive a um reinício (outro FlowPolicies no mesmo arquivo) e vive em `projects`, fora do projeto', async () => {
    const file = path.join(root, 'persist-flow-policies.json');
    const a = new FlowPolicies(file, () => {});
    expect(await a.get('p')).toBeNull();
    await a.set('p', applyFlowInput(legacyPolicy(false), { mode: 'manual' }));
    const b = new FlowPolicies(file, () => {});
    expect(await b.get('p')).toMatchObject({ mode: 'manual', plan: 'owner', completion: 'owner', commit: false, source: 'stored', completionChosen: true });
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).projects)).toEqual(['p']);
    expect(await b.get('outro')).toBeNull();
  });

  it('entrada inválida vira a política restritiva só para o projeto dela, e o log conta', async () => {
    const file = path.join(root, 'invalid-flow-policies.json');
    const ok = { mode: 'auto', ...FLOW_PRESETS.auto, completionChosen: true, at: new Date().toISOString() };
    await fs.writeFile(file, JSON.stringify({ version: 1, projects: { p: ok, torto: { mode: 'auto', completion: 'qualquer' } } }));
    const log: string[] = [];
    const policies = new FlowPolicies(file, (l) => log.push(l));
    expect(await policies.get('p')).toMatchObject({ mode: 'auto', completion: 'ai' });
    expect(await policies.get('torto')).toMatchObject({ mode: 'custom', ...RESTRICTIVE_GATES, source: 'stored' });
    expect(log.join('\n')).toContain('torto');
    expect(await policies.get('sem-entrada')).toBeNull();
  });

  it('arquivo estragado: guarda a cópia em .bad e a política de quem não tem entrada é a restritiva, nunca o padrão que amplia', async () => {
    const file = path.join(root, 'corrupt-flow-policies.json');
    await fs.writeFile(file, '{ isto não é json');
    const log: string[] = [];
    const policies = new FlowPolicies(file, (l) => log.push(l));
    expect(await policies.get('p')).toMatchObject({ mode: 'custom', ...RESTRICTIVE_GATES, source: 'stored' });
    expect(await fs.readFile(`${file}.bad`, 'utf8')).toContain('isto não é json');
    expect(log.join('\n')).toMatch(/estragado/);
    // Escolher de novo grava um arquivo bom.
    await policies.set('p', applyFlowInput(legacyPolicy(false), { mode: 'auto' }));
    expect(await new FlowPolicies(file, () => {}).get('p')).toMatchObject({ mode: 'auto' });
  });

  it('o arquivo da política fica na lista de negação de escrita do agente (Edit e Write), como o config.json', () => {
    const deny = secretDenyRules({ servers: [] } as unknown as StaffProfile);
    for (const tool of ['Edit', 'Write']) expect(deny.some((r) => r.startsWith(`${tool}(`) && /flow-policies\.json\*\)$/.test(r))).toBe(true);
  });
});

describe('só o dono muda a política', () => {
  it('sem fromBrowser é 403, antes de ler o corpo, e nada é gravado', async () => {
    const p = await project('f-403');
    await expect(p.svc.setFlowPolicy('p', { mode: 'auto' }, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(p.svc.setFlowPolicy('p', 'lixo que nem é objeto', false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(fs.readFile(p.policyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await p.svc.flowPolicy('p')).toMatchObject({ source: 'default' });
    // Pela tela, vale; corpo inválido é 400.
    await expect(p.svc.setFlowPolicy('p', { mode: 'custom' }, true)).rejects.toBeInstanceOf(TaskError);
    await expect(p.svc.setFlowPolicy('p', { mode: 'auto', commit: true }, true)).rejects.toBeInstanceOf(TaskError);
    expect(await p.svc.setFlowPolicy('p', { mode: 'auto' }, true)).toMatchObject({ mode: 'auto', source: 'stored' });
  });

  it('o funcionário nem tem a rota, a sandbox do Codex a barra, e a rota do servidor passa fromBrowser ao serviço', async () => {
    expect(staffMayPost('/api/projects/p/flow-policy')).toBe(false);
    expect(sandboxVerdict('POST', '/api/projects/p/flow-policy', 'p')).toMatchObject({ status: 403 });
    const index = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toMatch(/flow-policy\$`\),\s*\(\{ params: \[id\], body, fromBrowser \}\) => tasks\.setFlowPolicy\(id!, body, fromBrowser\)/);
    expect(index).toContain('flow: flowPolicies');
    expect(index).toContain("path.join(MYCO_HOME, 'flow-policies.json')");
    // A mescla da rota é a do dono (`fromBrowser` conferido na rota).
    expect(index).toContain('tasks.merge(id!, taskId!, b.skipTests, true)');
  });

  it('a política não vem do board.json: escrever lá (o agente consegue) não muda nada com a política gravada', async () => {
    const p = await project('f-boardjson');
    await p.svc.setFlowPolicy('p', { mode: 'manual' }, true); // commit desligado
    await fs.writeFile(path.join(p.dir, '.myco', 'board.json'), JSON.stringify({ autoCommit: true, autoReview: true, reviewerId: 'rev-1', flow: { completion: 'ai' }, completion: 'ai' }));
    expect(await p.svc.flowPolicy('p')).toMatchObject({ mode: 'manual', completion: 'owner', commit: false });
    expect(await p.svc.boardCommit('p')).toEqual({ autoCommit: false });
  });
});

describe('projeto sem política gravada: comporta-se como hoje', () => {
  it('aprovar leva a pronto, sem nota nem item novo; sem revisor continua calado', async () => {
    const p = await project('f-legacy');
    expect(await p.svc.flowPolicy('p')).toEqual({ mode: 'custom', plan: 'owner', completion: 'ai', commit: false, source: 'default', completionChosen: false });
    const t = await p.make('Com revisor');
    await p.deliver(t.id, 's-1');
    await p.approved('s-2');
    const done = await p.get(t.id);
    expect(done).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
    expect(done.history.at(-1)).toMatchObject({ status: 'done', note: 'aprovada por Rui' });
    expect(done.ownerGate).toBeUndefined();

    const u = await p.make('Sem revisor', null);
    await p.deliver(u.id, 's-3');
    const waiting = await p.get(u.id);
    expect(waiting.status).toBe('review');
    expect(waiting.ownerGate).toBeUndefined();
    expect(waiting.history.map((h) => h.note ?? '').join('|')).not.toMatch(/sem revisor/);
    expect(await p.alerts()).toEqual([]);
    await expect(fs.readFile(p.policyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('o toggle de commit da tela grava só o board.json: não cria entrada de política nem alerta, e o GET segue o board.json', async () => {
    const p = await project('f-toggle-legacy');
    expect(await p.svc.boardCommit('p')).toEqual({ autoCommit: false });
    await p.svc.setBoardCommit('p', { autoCommit: true }, true);
    expect(JSON.parse(await fs.readFile(path.join(p.dir, '.myco', 'board.json'), 'utf8'))).toMatchObject({ autoCommit: true });
    await expect(fs.readFile(p.policyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await p.svc.flowPolicy('p')).toEqual({ mode: 'custom', plan: 'owner', completion: 'ai', commit: true, source: 'default', completionChosen: false });
    expect(await p.svc.boardCommit('p')).toEqual({ autoCommit: true });
    // Nenhum alerta novo: entregar sem revisor segue calado.
    const u = await p.make('Sem revisor', null);
    await p.deliver(u.id, 's-1');
    expect((await p.get(u.id)).ownerGate).toBeUndefined();
    expect(await p.alerts()).toEqual([]);
    await p.svc.setBoardCommit('p', { autoCommit: false }, true);
    expect(await p.svc.boardCommit('p')).toEqual({ autoCommit: false });
    await expect(fs.readFile(p.policyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('com a política gravada o toggle escreve o portão commit (grava custom se mudou) e espelha no board.json', async () => {
    const p = await project('f-toggle-stored');
    await p.svc.setFlowPolicy('p', { mode: 'supervised' }, true);
    expect(JSON.parse(await fs.readFile(path.join(p.dir, '.myco', 'board.json'), 'utf8'))).toMatchObject({ autoCommit: true }); // o espelho: apagar a política devolve o projeto ao que ele fazia
    // Mesmo valor: continua supervised.
    await p.svc.setBoardCommit('p', { autoCommit: true }, true);
    expect(await p.svc.flowPolicy('p')).toMatchObject({ mode: 'supervised', commit: true });
    await p.svc.setBoardCommit('p', { autoCommit: false }, true);
    expect(await p.svc.flowPolicy('p')).toMatchObject({ mode: 'custom', plan: 'ai', completion: 'owner', commit: false, source: 'stored' });
    expect(await p.svc.boardCommit('p')).toEqual({ autoCommit: false });
    expect(JSON.parse(await fs.readFile(path.join(p.dir, '.myco', 'board.json'), 'utf8'))).toMatchObject({ autoCommit: false });
    expect((await stored(p)).projects.p).toMatchObject({ mode: 'custom', commit: false });
    // Sem a rota de 403 do dono, o toggle também é só da tela.
    await expect(p.svc.setBoardCommit('p', { autoCommit: true }, false)).rejects.toBeInstanceOf(TaskForbiddenError);
  });
});

describe('conclusão do dono: o revisor IA aprova e a tarefa espera', () => {
  it('approve(): fica em revisão com a nota "aprovada por X; falta sua aprovação" e um item na caixa; a tela leva a pronto', async () => {
    const p = await project('f-owner');
    await p.svc.setFlowPolicy('p', { mode: 'supervised' }, true);
    const t = await p.make('Tabela');
    await p.deliver(t.id, 's-1');
    await p.approved('s-2');
    const held = await p.get(t.id);
    expect(held).toMatchObject({ status: 'review', review: { verdict: 'approved' }, ownerGate: { why: 'approved', by: 'Rui' } });
    expect(held.history.at(-1)).toMatchObject({ status: 'review', note: 'aprovada por Rui; falta sua aprovação' });
    expect(held.history.map((h) => h.status)).not.toContain('done');

    // O item na caixa: a parada que só o dono destrava, com o motivo e a marca para a tela.
    const [alert, ...others] = await p.alerts();
    expect(others).toEqual([]);
    expect(alert!.task.id).toBe(t.id);
    expect(alert!.state).toMatchObject({ reason: 'aprovada por Rui; falta sua aprovação', humanAction: 'decide', selfHeals: false });
    const item = stuckInboxItem(alert!, { projectId: 'p', projectName: 'P', sessionId: 's-1', staffId: 'ana-1', name: 'Ana' });
    expect(item).toMatchObject({ kind: 'stuck', stuck: { taskId: t.id, humanAction: 'decide', ownerGate: 'approved' } });

    // A aprovação do dono, pela tela, leva a pronto e tira a espera.
    const done = (await owner(p.svc, t.id))!;
    expect(done).toMatchObject({ status: 'done' });
    expect((await p.get(t.id)).ownerGate).toBeUndefined();
    expect(await p.alerts()).toEqual([]);
  });

  it('o que não é o dono pela tela não leva a pronto: 403 em update e em merge, e a API do funcionário não muda a coluna', async () => {
    const p = await project('f-owner-403');
    await p.svc.setFlowPolicy('p', { mode: 'manual' }, true);
    const t = await p.make('Tabela');
    await p.deliver(t.id, 's-1');
    await expect(p.svc.update('p', t.id, { status: 'done' })).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(p.svc.update('p', t.id, { status: 'done' }, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(p.svc.merge('p', t.id)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect((await p.get(t.id)).status).toBe('review');
    const caller = { staffId: 'ana-1', projectId: 'p', sessionId: 's-1', engine: 'claude' as const, sandbox: false };
    await expect(p.svc.editFrom('p', t.id, caller, { status: 'done' })).rejects.toThrow();
    expect((await p.get(t.id)).status).toBe('review');
    // Outras mudanças de coluna (não "pronto") seguem como sempre.
    expect(await p.svc.update('p', t.id, { status: 'doing' })).toMatchObject({ status: 'doing' });
  });

  it('com reviewerId no card e a revisão do quadro desligada, o portão vale do mesmo jeito (o reviewerId não passa por cima dele)', async () => {
    const p = await project('f-owner-reviewerid');
    await p.svc.setFlowPolicy('p', { completion: 'owner' }, true);
    expect(await fs.readFile(path.join(p.dir, '.myco', 'board.json'), 'utf8').catch(() => '')).not.toMatch(/autoReview": true/);
    const t = await p.make('Com revisor no card', 'rev-1');
    expect(t.reviewerId).toBe('rev-1');
    await p.deliver(t.id, 's-1');
    await p.approved('s-2');
    expect(await p.get(t.id)).toMatchObject({ status: 'review', review: { verdict: 'approved' } });
    expect((await p.get(t.id)).status).not.toBe('done');
  });

  it('a autorização não depende do ownerGate do tasks.json: apagado à mão, o approve() com o portão owner continua sem levar a pronto', async () => {
    const p = await project('f-owner-erased');
    await p.svc.setFlowPolicy('p', { mode: 'supervised' }, true);
    const t = await p.make('Tabela');
    await p.deliver(t.id, 's-1');
    await p.approved('s-2');
    expect((await p.get(t.id)).ownerGate).toBeDefined();
    // Um agente (ou um erro) apaga a marca do card.
    await p.patch(t.id, { ownerGate: undefined });
    expect((await p.get(t.id)).ownerGate).toBeUndefined();
    // O veredito de aprovação chega de novo para a mesma revisão: o portão vem da política, não do card.
    await p.approved('s-2');
    expect(await p.get(t.id)).toMatchObject({ status: 'review', ownerGate: { why: 'approved' } });
    expect((await p.get(t.id)).status).not.toBe('done');
    // E quem não é o dono continua sem levá-la a pronto, com ou sem a marca.
    await expect(p.svc.update('p', t.id, { status: 'done' })).rejects.toBeInstanceOf(TaskForbiddenError);
    await p.patch(t.id, { ownerGate: undefined });
    await expect(p.svc.update('p', t.id, { status: 'done' })).rejects.toBeInstanceOf(TaskForbiddenError);
    expect((await p.get(t.id)).status).toBe('review');
  });

  it('a marca forjada no card não segura a conclusão por IA: com o portão ai a aprovação leva a pronto mesmo assim', async () => {
    const p = await project('f-ai-forged');
    await p.svc.setFlowPolicy('p', { mode: 'auto' }, true);
    const t = await p.make('Tabela');
    await p.deliver(t.id, 's-1');
    await p.patch(t.id, { ownerGate: { deliveryAt: (await p.get(t.id)).delivery!.at, since: new Date().toISOString(), why: 'approved', by: 'Fulano' } });
    await p.approved('s-2');
    expect((await p.get(t.id)).status).toBe('done');
  });

  it('merge: o dono mescla e a tarefa vai a pronto (a marca some); sem ser o dono, 403 antes de o código entrar', async () => {
    const p = await project('f-owner-merge', { ana: { worktree: true } });
    await p.svc.setFlowPolicy('p', { mode: 'supervised' }, true);
    const t = await p.make('Filtro');
    await p.deliver(t.id, 's-1');
    merging.place = { where: 'worktree', path: '/tmp/wt', branch: 'myco/ana-1' };
    let merged = 0;
    merging.merge = async () => {
      merged++;
      return { sha: 'abc1234', base: 'main', branch: 'myco/ana-1', tests: null };
    };
    try {
      await p.approved('s-2');
      // Código numa worktree por mesclar e conclusão do dono: as duas faltas ficam na nota.
      expect(await p.get(t.id)).toMatchObject({ status: 'review', ownerGate: { why: 'approved' } });
      expect((await p.get(t.id)).history.at(-1)?.note).toBe('aprovada por Rui; falta mesclar (e a sua aprovação)');
      await expect(p.svc.merge('p', t.id, true)).rejects.toBeInstanceOf(TaskForbiddenError);
      expect(merged).toBe(0);
      expect((await p.get(t.id)).status).toBe('review');
      const out = await p.svc.merge('p', t.id, true, true);
      expect(out).toMatchObject({ status: 'done', merged: { sha: 'abc1234' } });
      expect(merged).toBe(1);
      expect((await p.get(t.id)).ownerGate).toBeUndefined();
    } finally {
      merging.place = null;
      merging.merge = null;
    }
  });

  it('com a conclusão por IA que o dono não escolheu (herdada) a mescla segue pedindo o clique, como sempre (e a tela, sem byOwner, não precisava dele)', async () => {
    const p = await project('f-ai-merge', { ana: { worktree: true } });
    // Só o commit foi mexido: a conclusão 'ai' vem da política virtual e `completionChosen` fica desligado. Com o preset Automático a aprovação mescla sozinha (tests/autoMerge.test.ts).
    await p.svc.setFlowPolicy('p', { commit: true }, true);
    expect(await p.svc.flowPolicy('p')).toMatchObject({ completion: 'ai', completionChosen: false, source: 'stored' });
    const t = await p.make('Filtro');
    await p.deliver(t.id, 's-1');
    merging.place = { where: 'worktree', path: '/tmp/wt', branch: 'myco/ana-1' };
    merging.merge = async () => ({ sha: 'def5678', base: 'main', branch: 'myco/ana-1', tests: null });
    try {
      await p.approved('s-2');
      expect((await p.get(t.id)).history.at(-1)?.note).toBe('aprovada por Rui; falta mesclar');
      expect((await p.get(t.id)).ownerGate).toBeUndefined();
      expect(await p.svc.merge('p', t.id, true)).toMatchObject({ status: 'done' });
    } finally {
      merging.place = null;
      merging.merge = null;
    }
  });

  it('só os pontos que levam a pronto em tasks.ts conferem o portão (alguém acrescentou um? decida o portão dele)', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'tasks.ts'), 'utf8');
    const lines = src.split(/\r?\n/);
    const toDone = lines.filter((l) => /\bmoved\(/.test(l) && /'done'/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    // approve() e merge(): os dois conferem a política (approve com `completion`, merge com `needOwnerToFinish`). A tela passa por update() (patch.status).
    expect(toDone).toHaveLength(2);
    expect(lines.filter((l) => /await this\.needOwnerToFinish\(projectId\)/.test(l))).toHaveLength(2); // update() e merge()
    expect(src).toContain("const owner = (await this.flowOf(projectId)).completion === 'owner';"); // approve()
  });
});

describe('aprovação presa à entrega', () => {
  it('entrega nova depois da aprovação pendente a invalida: a marca e o item somem, a revisão é pedida de novo e o veredito velho não decide', async () => {
    const p = await project('f-redeliver');
    await p.svc.setFlowPolicy('p', { mode: 'supervised' }, true);
    const t = await p.make('Tabela');
    await p.deliver(t.id, 's-1');
    await p.approved('s-2');
    const first = await p.get(t.id);
    expect(first.ownerGate).toMatchObject({ deliveryAt: first.delivery!.at });
    expect((await p.alerts()).map((a) => a.task.id)).toEqual([t.id]);

    // Você manda um ajuste e ele entrega de novo: é outra entrega.
    await p.svc.onSent('s-1');
    expect((await p.get(t.id)).ownerGate).toBeUndefined();
    // O ajuste edita o código: só o turno que edita (ou traz a entrega no formato) é entrega nova; a resposta seca à mensagem deixa a entrega de antes (ver `holdReply`).
    await p.svc.onCodeEdit({ sessionId: 's-1', projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: p.dir, files: [path.join(p.dir, 'a.ts')], request: 'ajuste' });
    await sleep(5);
    await p.svc.onTurnDone('s-1');
    const again = await p.get(t.id);
    expect(again.status).toBe('review');
    expect(again.delivery!.at).not.toBe(first.delivery!.at);
    expect(again.ownerGate).toBeUndefined();
    expect(await p.alerts()).toEqual([]);
    expect(again.review).toMatchObject({ sessionId: 's-3' });

    // O veredito atrasado da revisão antiga não decide nada (nem põe a espera de volta).
    await p.approved('s-2');
    expect((await p.get(t.id)).ownerGate).toBeUndefined();
    expect((await p.get(t.id)).status).toBe('review');
    // A revisão da entrega nova aprova: a espera volta, presa à entrega nova.
    await p.approved('s-3');
    const pending = await p.get(t.id);
    expect(pending.ownerGate).toMatchObject({ deliveryAt: again.delivery!.at, why: 'approved' });
    expect(pending.status).toBe('review');
  });

  it('marca de outra entrega, mesmo que gravada, não vale: nem alerta nem parada (só exibição)', async () => {
    const p = await project('f-stale-gate');
    await p.svc.setFlowPolicy('p', { mode: 'supervised' }, true);
    const t = await p.make('Tabela');
    await p.deliver(t.id, 's-1');
    await p.approved('s-2');
    const task = await p.get(t.id);
    expect(ownerGateOf(task)).toBeDefined();
    const stale: Task = { ...task, delivery: { ...task.delivery!, at: new Date(Date.parse(task.delivery!.at) + 1000).toISOString() } };
    expect(ownerGateOf(stale)).toBeUndefined();
    expect(ownAlerts([stale])).toEqual([]);
    expect(stuckState(stale)?.humanAction ?? null).not.toBe('decide');
    expect(ownerGateOf({ ...task, status: 'doing' })).toBeUndefined();
  });

  it('o veredito de uma entrega que já passou não leva a pronto nem no projeto sem política (approve fixa a entrega que o revisor julgou)', async () => {
    const p = await project('f-pin');
    const t = await p.make('Tabela');
    await p.deliver(t.id, 's-1');
    const task = await p.get(t.id);
    const approve = (verdict: { sessionId: string; deliveryAt: string | null }) => (p.svc as unknown as { approve(p: string, id: string, who: string, v: typeof verdict): Promise<void> }).approve('p', t.id, 'Rui', verdict);
    await approve({ sessionId: task.review!.sessionId, deliveryAt: '2000-01-01T00:00:00.000Z' }); // entrega velha
    await approve({ sessionId: 's-velha', deliveryAt: task.delivery!.at }); // outra revisão
    expect((await p.get(t.id)).status).toBe('review');
    await approve({ sessionId: task.review!.sessionId, deliveryAt: task.delivery!.at });
    expect((await p.get(t.id)).status).toBe('done');
  });
});

describe('Automático sem revisor não vai a pronto sozinho', () => {
  it('preset Automático: entrega sem revisor fica em revisão com a nota e o item na caixa, uma vez só', async () => {
    const p = await project('f-auto-norev');
    await p.svc.setFlowPolicy('p', { mode: 'auto' }, true);
    const t = await p.make('Sem revisor', null);
    await p.deliver(t.id, 's-1');
    const held = await p.get(t.id);
    expect(held).toMatchObject({ status: 'review', ownerGate: { why: 'no-reviewer' } });
    expect(held.history.filter((h) => h.note === 'sem revisor configurado: espera sua aprovação')).toHaveLength(1);
    expect(held.history.map((h) => h.status)).not.toContain('done');
    const [alert, ...others] = await p.alerts();
    expect(others).toEqual([]);
    expect(alert!.state).toMatchObject({ reason: 'sem revisor configurado: falta sua aprovação', humanAction: 'decide' });
    expect(stuckInboxItem(alert!, { projectId: 'p', projectName: 'P', sessionId: 's-1', staffId: 'ana-1', name: 'Ana' })).toMatchObject({ stuck: { ownerGate: 'no-reviewer' } });
    // Nada a leva a pronto sozinha; o dono, pela tela, sim.
    expect((await p.get(t.id)).status).toBe('review');
    expect(await owner(p.svc, t.id)).toMatchObject({ status: 'done' });
    expect(await p.alerts()).toEqual([]);
  });

  it('com revisor configurado (no card ou no quadro) o Automático revisa e aprova até pronto, sem alerta', async () => {
    const p = await project('f-auto-rev');
    await p.svc.setFlowPolicy('p', { mode: 'auto' }, true);
    const t = await p.make('Com revisor no card');
    await p.deliver(t.id, 's-1');
    await p.approved('s-2');
    expect(await p.get(t.id)).toMatchObject({ status: 'done' });
    // O revisor do quadro (autoReview + reviewerId) também vale.
    await fs.writeFile(path.join(p.dir, '.myco', 'board.json'), JSON.stringify({ autoReview: true, reviewerId: 'rev-1' }));
    const u = await p.make('Com revisor do quadro', null);
    await p.deliver(u.id, 's-3');
    expect((await p.get(u.id)).ownerGate).toBeUndefined();
    await p.approved('s-4');
    expect((await p.get(u.id)).status).toBe('done');
  });

  it('o aviso só sai quando o dono ESCOLHEU a conclusão por IA: custom com completion gravado por ele sim; custom que só herdou, não; Supervisionado e Manual, não', async () => {
    const chosen = await project('f-chosen');
    await chosen.svc.setFlowPolicy('p', { completion: 'ai' }, true); // custom, com a conclusão escolhida
    const a = await chosen.make('A', null);
    await chosen.deliver(a.id, 's-1');
    expect((await chosen.get(a.id)).ownerGate).toMatchObject({ why: 'no-reviewer' });

    const inherited = await project('f-inherited');
    await inherited.svc.setFlowPolicy('p', { commit: true }, true); // custom que herdou 'ai' da política virtual
    expect(await inherited.svc.flowPolicy('p')).toMatchObject({ mode: 'custom', completion: 'ai', completionChosen: false, source: 'stored' });
    const b = await inherited.make('B', null);
    await inherited.deliver(b.id, 's-1');
    expect((await inherited.get(b.id)).ownerGate).toBeUndefined();
    expect(await inherited.alerts()).toEqual([]);
    // Escolher a conclusão depois liga o aviso para as entregas seguintes.
    await inherited.svc.setFlowPolicy('p', { completion: 'ai' }, true);
    expect(await inherited.svc.flowPolicy('p')).toMatchObject({ completionChosen: true });

    for (const mode of ['supervised', 'manual'] as const) {
      const q = await project(`f-owner-gate-${mode}`);
      await q.svc.setFlowPolicy('p', { mode }, true);
      const c = await q.make('C', null);
      await q.deliver(c.id, 's-1');
      // Conclusão do dono sem revisor: o card já é do dono por desenho, sem nota nem item novo.
      expect((await q.get(c.id)).ownerGate).toBeUndefined();
      expect((await q.get(c.id)).status).toBe('review');
    }
  });
});

describe('o portão de commit é o da política', () => {
  it('Supervisionado: o revisor aprova e nada é commitado; só depois da aprovação do dono sai o commit', async () => {
    const p = await project('f-commit-supervised', { git: true });
    await p.svc.setFlowPolicy('p', { mode: 'supervised' }, true);
    await fs.writeFile(path.join(p.dir, 'a.ts'), 'export const v = 2;\n');
    const t = await p.make('Tela A');
    await p.deliver(t.id, 's-1', { changedFiles: ['a.ts'] });
    const before = commits(p.dir);
    await p.approved('s-2');
    await p.svc.commitsSettled();
    expect((await p.get(t.id)).status).toBe('review');
    expect(commits(p.dir)).toBe(before);
    expect((await p.get(t.id)).commit).toBeUndefined();

    await owner(p.svc, t.id);
    await p.svc.commitsSettled();
    const done = await p.get(t.id);
    expect(done.status).toBe('done');
    expect(commits(p.dir)).toBe(before + 1);
    expect(done.commit).toMatchObject({ status: 'committed', files: ['a.ts'] });
  });

  it('Manual não commita; a política gravada manda mesmo que o board.json diga autoCommit (o agente edita o board.json, não a política)', async () => {
    const p = await project('f-commit-manual', { git: true });
    await p.svc.setFlowPolicy('p', { mode: 'manual' }, true);
    await fs.writeFile(path.join(p.dir, '.myco', 'board.json'), JSON.stringify({ autoCommit: true }));
    await fs.writeFile(path.join(p.dir, 'a.ts'), 'export const v = 3;\n');
    const t = await p.make('Tela B');
    await p.deliver(t.id, 's-1', { changedFiles: ['a.ts'] });
    const before = commits(p.dir);
    await p.approved('s-2'); // fica em revisão (conclusão do dono)
    await owner(p.svc, t.id);
    await p.svc.commitsSettled();
    expect((await p.get(t.id)).status).toBe('done');
    expect(commits(p.dir)).toBe(before);
    expect((await p.get(t.id)).commit).toBeUndefined();
  });

  it('Automático: a aprovação do revisor leva a pronto e já commita', async () => {
    const p = await project('f-commit-auto', { git: true });
    await p.svc.setFlowPolicy('p', { mode: 'auto' }, true);
    await fs.writeFile(path.join(p.dir, 'a.ts'), 'export const v = 4;\n');
    const t = await p.make('Tela C');
    await p.deliver(t.id, 's-1', { changedFiles: ['a.ts'] });
    const before = commits(p.dir);
    await p.approved('s-2');
    await p.svc.commitsSettled();
    expect((await p.get(t.id)).status).toBe('done');
    expect(commits(p.dir)).toBe(before + 1);
  });

  it('projeto sem política: o commit segue o autoCommit do board.json, como sempre', async () => {
    const p = await project('f-commit-legacy', { git: true });
    await p.svc.setBoardCommit('p', { autoCommit: true }, true);
    await fs.writeFile(path.join(p.dir, 'a.ts'), 'export const v = 5;\n');
    const t = await p.make('Tela D');
    await p.deliver(t.id, 's-1', { changedFiles: ['a.ts'] });
    const before = commits(p.dir);
    await p.approved('s-2');
    await p.svc.commitsSettled();
    expect((await p.get(t.id)).status).toBe('done');
    expect(commits(p.dir)).toBe(before + 1);
    await expect(fs.readFile(p.policyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('GET da política', () => {
  it('devolve a política vigente (virtual ou gravada) e null para projeto que não existe', async () => {
    const p = await project('f-get');
    const virtual: FlowPolicy = (await p.svc.flowPolicy('p'))!;
    expect(virtual).toMatchObject({ source: 'default', mode: 'custom', plan: 'owner', completion: 'ai' });
    await p.svc.setFlowPolicy('p', { plan: 'ai' }, true);
    expect(await p.svc.flowPolicy('p')).toEqual({ mode: 'custom', plan: 'ai', completion: 'ai', commit: false, source: 'stored', completionChosen: false });
    const none = new TaskService({ projectPath: async () => null, projectIds: async () => [], readProfile: async () => null, send: async () => 's', branchFor: async () => null });
    expect(await none.flowPolicy('x')).toBeNull();
  });

  it('sem o serviço de política (os testes de antes), a rota não grava e o resto segue como hoje', async () => {
    const dir = path.join(root, 'f-nodeps');
    const svc = new TaskService({ projectPath: async () => dir, projectIds: async () => ['p'], readProfile: async () => null, send: async () => 's', branchFor: async () => null });
    expect(await svc.flowPolicy('p')).toMatchObject({ source: 'default', completion: 'ai' });
    await expect(svc.setFlowPolicy('p', { mode: 'auto' }, true)).rejects.toBeInstanceOf(TaskError);
    await expect(svc.setFlowPolicy('p', { mode: 'auto' }, false)).rejects.toBeInstanceOf(TaskForbiddenError);
  });
});
