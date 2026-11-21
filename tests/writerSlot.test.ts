import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveCaller, SessionTokens } from '../server/callers';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { TaskError, TaskForbiddenError, TaskService } from '../server/tasks';
import type { Engine, StaffProfile, StaffQueue } from '../shared/model';
import { tempDirs } from './support/tmp';

// t-795f8d: um escritor por vez no checkout principal (`.myco/board.json`, `singleWriter`). Com a opção ligada, só um card por vez segura a vaga de escrita do projeto (fazendo, revisão, Aguardar, ou
// pronto com o commit automático ainda por sair); o outro card que vai implementar espera na fila com o motivo (`Task.resourceWait`, o dado que `queueStates` e a tela já leem) e começa sozinho quando
// a vaga abre. Worktree própria e a fase de plano não entram na conta. Repositório git de verdade (o commit automático roda), nos dois motores.

const tmp = tempDirs();
let root: string;
beforeAll(async () => {
  root = await tmp('myco-writer-');
});

const PAST = '2020-01-01T00:00:00';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST } }).toString();
const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], engine: 'claude', ...extra }) as StaffProfile;
const PLAN = 'Plano: 1) mexer em a.ts; 2) teste novo; riscos: nenhum.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Espera o que a fila faz sozinha (o commit automático roda git de verdade, e sob carga passa de 1 s). */
const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 30_000, interval: 25 });

/**
 * Gio (gestor) pede aos outros. Ana, Rui e Bia escrevem no checkout principal; `wt-1` tem worktree própria; `pla-1` é a ficha "só planeja". `engines` troca o motor de quem quiser (paridade Claude/Codex).
 * `h` guarda o que cada teste liga: o atraso do envio (para a corrida) e a conversa "de fora" que ocupa o funcionário.
 */
async function club(dirName: string, opts: { engines?: Record<string, Engine> } = {}) {
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
  const engineOf = (id: string): Engine => opts.engines?.[id] ?? 'claude';
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Gio', { role: 'Orquestrador', engine: engineOf('gio-1') }),
    'ana-1': profile('ana-1', 'Ana', { engine: engineOf('ana-1'), reportsTo: ['gio-1'] }),
    'rui-1': profile('rui-1', 'Rui', { engine: engineOf('rui-1'), reportsTo: ['gio-1'] }),
    'bia-1': profile('bia-1', 'Bia', { engine: engineOf('bia-1'), reportsTo: ['gio-1'] }),
    'wt-1': profile('wt-1', 'Wil', { engine: engineOf('wt-1'), worktree: true, reportsTo: ['gio-1'] }),
    'pla-1': profile('pla-1', 'Pla', { engine: engineOf('pla-1'), autonomy: 'plan', reportsTo: ['gio-1'] }),
  };
  const h = {
    sent: [] as Array<{ staffId: string; text: string; reviewOnly: boolean | undefined }>,
    delivered: [] as Array<{ sessionId: string; text: string }>,
    texts: {} as Record<string, string>,
    sendDelay: 0,
    outside: false,
    n: 0,
  };
  const service = () =>
    new TaskService({
      projectPath: async (id) => (id === 'p' ? dir : null),
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId, text, _force, _override, reviewOnly) => {
        if (h.sendDelay) await sleep(h.sendDelay);
        h.sent.push({ staffId, text, reviewOnly });
        return `${staffId}-${++h.n}`;
      },
      branchFor: async () => null,
      isWorking: () => h.outside,
      sendTo: async (_p, sessionId, _s, text) => {
        h.delivered.push({ sessionId, text });
        return sessionId;
      },
      notify: async () => {},
      apiUrl: 'http://127.0.0.1:4848',
      sandboxApiUrl: 'http://127.0.0.2:4848',
      lastText: (s) => h.texts[s] ?? null,
      log: () => {},
    });
  const svc = service();
  const get = async (id: string, s: TaskService = svc) => ((await s.list('p'))!).find((t) => t.id === id)!;
  const tokens = new SessionTokens();
  const as = (staffId: string, session: string) => {
    const r = resolveCaller(false, tokens.issue({ staffId, projectId: 'p', sessionId: session, engine: engineOf(staffId) }), tokens);
    return r.ok ? r.caller : null;
  };
  /** Cria o card de `staffId` (pedido por Gio, sem revisor: a revisão é sua, pela tela) e o começa pela fila/API. A conversa de trabalho é null se o card ficou esperando. */
  const create = async (staffId: string, title: string, extra: Record<string, unknown> = {}) => (await svc.create('p', { title, description: 'Faça.', staffId, reviewerId: null, ...extra }, 'gio-1', 'gio-s'))!.id;
  const begin = async (staffId: string, title: string, extra: Record<string, unknown> = {}, s: TaskService = svc) => {
    const id = await create(staffId, title, extra);
    await s.start('p', id);
    return { id, work: (await get(id, s)).sessionId ?? null };
  };
  const edit = (work: string, staffId: string) => svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId, engine: engineOf(staffId), cwd: dir, files: [path.join(dir, 'a.ts')], request: null });
  const endTurn = async (work: string, text = 'Feito.') => {
    h.texts[work] = text;
    await svc.onTurnDone(work);
  };
  /** Quantas conversas de trabalho (não de revisão) o funcionário abriu. */
  const opened = (staffId: string) => h.sent.filter((s) => s.staffId === staffId && !s.reviewOnly).length;
  const on = () => svc.setBoardWriter('p', { singleWriter: true }, true);
  const queue = async (staffId: string): Promise<StaffQueue | undefined> => ((await svc.queueStates('p'))!).find((q) => q.staffId === staffId);
  const started = (id: string) => until(async () => expect((await get(id)).sessionId).toBeTruthy());
  return { dir, h, svc, service, get, as, create, begin, edit, endTurn, opened, on, queue, started, people };
}

/** Ana segura a vaga; Rui chega depois e espera. */
async function waiter(b: Awaited<ReturnType<typeof club>>, how: (b: Awaited<ReturnType<typeof club>>, hold: { id: string; work: string | null }) => Promise<void> = async () => {}) {
  await b.on();
  const hold = await b.begin('ana-1', 'Dona da vaga');
  await how(b, hold);
  const wait = await b.begin('rui-1', 'Espera a vez');
  return { hold, wait };
}

const COMBOS: Array<[Engine, Engine]> = [
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['claude', 'codex'],
  ['codex', 'claude'],
];

describe('a opção por projeto', () => {
  it('desligada (padrão): dois funcionários começam juntos, como sempre', async () => {
    const b = await club('padrao');
    expect(await b.svc.boardWriter('p')).toEqual({ singleWriter: false });
    const a = await b.begin('ana-1', 'Primeira');
    const r = await b.begin('rui-1', 'Segunda');
    expect((await b.get(a.id)).status).toBe('doing');
    expect((await b.get(r.id)).status).toBe('doing');
    expect((await b.get(r.id)).resourceWait).toBeFalsy();
    expect(b.opened('ana-1') + b.opened('rui-1')).toBe(2);
  });

  it('grava e lê `singleWriter` sem apagar as outras chaves do board.json; arquivo torto vale desligado', async () => {
    const b = await club('opcao');
    await b.svc.setBoardCommit('p', { autoCommit: true }, true);
    expect(await b.svc.setBoardWriter('p', { singleWriter: true }, true)).toEqual({ singleWriter: true });
    expect(await b.svc.boardWriter('p')).toEqual({ singleWriter: true });
    expect(await b.svc.boardCommit('p')).toEqual({ autoCommit: true });
    expect(await b.svc.boardConfig('p')).toMatchObject({ autoReview: false });
    expect(JSON.parse(await fs.readFile(path.join(b.dir, '.myco', 'board.json'), 'utf8'))).toMatchObject({ autoCommit: true, singleWriter: true });
    await b.svc.setBoardCommit('p', { autoCommit: false }, true);
    expect(await b.svc.boardWriter('p')).toEqual({ singleWriter: true });
    await fs.writeFile(path.join(b.dir, '.myco', 'board.json'), JSON.stringify({ singleWriter: 'sim' }));
    expect(await b.svc.boardWriter('p')).toEqual({ singleWriter: false });
    await fs.writeFile(path.join(b.dir, '.myco', 'board.json'), '{não é json');
    expect(await b.svc.boardWriter('p')).toEqual({ singleWriter: false });
  });

  it('só a tela liga (403 antes de qualquer leitura); corpo torto é 400; projeto que não existe é null', async () => {
    const b = await club('opcao-gate');
    await expect(b.svc.setBoardWriter('p', { singleWriter: true }, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect(await b.svc.boardWriter('p')).toEqual({ singleWriter: false });
    await expect(b.svc.setBoardWriter('p', { singleWriter: 'sim' }, true)).rejects.toBeInstanceOf(TaskError);
    await expect(b.svc.setBoardWriter('p', { singleWriter: true, autoCommit: true }, true)).rejects.toBeInstanceOf(TaskError);
    await expect(b.svc.setBoardWriter('p', {}, true)).rejects.toBeInstanceOf(TaskError);
    expect(await b.svc.setBoardWriter('nao-existe', { singleWriter: true }, true)).toBeNull();
    expect(await b.svc.boardWriter('nao-existe')).toBeNull();
  });

  it('funcionário e a sandbox do Codex não têm a rota; a tela tem GET e POST', async () => {
    expect(staffMayPost('/api/projects/p/board-writer')).toBe(false);
    expect(sandboxVerdict('POST', '/api/projects/p/board-writer', 'p')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/projects/p/board-writer', 'p')).toMatchObject({ status: 403 });
    const index = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('board-writer$`), ({ params: [id] }) => tasks.boardWriter(id!)');
    expect(index).toMatch(/board-writer\$`\),\s*\(\{ params: \[id\], body, fromBrowser \}\) => tasks\.setBoardWriter\(id!, body, fromBrowser\)/);
  });

  it('desligar acorda quem esperava a vaga', async () => {
    const b = await club('desligar');
    const { wait } = await waiter(b);
    expect((await b.get(wait.id)).sessionId).toBeNull();
    await b.svc.setBoardWriter('p', { singleWriter: false }, true);
    await b.started(wait.id);
    expect((await b.get(wait.id)).status).toBe('doing');
    expect((await b.get(wait.id)).resourceWait).toBeFalsy();
  });
});

describe.each(COMBOS)('com a opção ligada: quem segura a vaga e quem espera (dona %s, quem espera %s)', (holderEngine, waiterEngine) => {
  const engines = { 'ana-1': holderEngine, 'rui-1': waiterEngine, 'bia-1': waiterEngine };
  const holdsIn: Array<[string, (b: Awaited<ReturnType<typeof club>>, hold: { id: string; work: string | null }) => Promise<void>, string]> = [
    ['fazendo', async () => {}, 'fazendo'],
    [
      'em revisão',
      async (b, hold) => {
        await b.edit(hold.work!, 'ana-1');
        await b.endTurn(hold.work!);
      },
      'em revisão',
    ],
    [
      'em Aguardar',
      async (b, hold) => {
        await b.svc.update('p', hold.id, { status: 'waiting', waitReason: 'espero o dono' });
      },
      'em Aguardar',
    ],
    [
      'reprovada (volta a fazendo depois da revisão)',
      async (b, hold) => {
        await b.edit(hold.work!, 'ana-1');
        await b.endTurn(hold.work!);
        expect((await b.get(hold.id)).status).toBe('review');
        await b.svc.update('p', hold.id, { status: 'doing' });
      },
      'fazendo',
    ],
  ];

  it.each(holdsIn)('card %s segura a vaga: o outro não começa, fica na fila com o motivo e sem abrir conversa', async (_name, how, label) => {
    const b = await club(`segura-${holdsIn.findIndex((x) => x[0] === _name)}-${holderEngine}-${waiterEngine}`, { engines });
    const { hold, wait } = await waiter(b, how);
    const t = await b.get(wait.id);
    expect(wait.work).toBeNull();
    expect(t).toMatchObject({ status: 'todo', sessionId: null });
    expect(t.queuedAt).toBeTruthy();
    expect(t.resourceWait).toMatchObject({ holder: hold.id, since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(t.resourceWait!.reason).toBe(`a vaga de escrita deste projeto está com “Dona da vaga” (${hold.id}, ${label})`);
    expect(b.opened('rui-1')).toBe(0);
    // Sem erro e sem retry de erro: o card só espera.
    expect(t.startRetry).toBeUndefined();
    // A tela lê isto pela fila: o estado, o card que espera e o motivo.
    expect(await b.queue('rui-1')).toMatchObject({ staffId: 'rui-1', state: 'resource-wait', taskId: wait.id, detail: t.resourceWait!.reason, queued: 1 });
    // Um tick (a rede de segurança) não a solta nem muda o motivo.
    await b.svc.tick(new Date());
    expect((await b.get(wait.id)).resourceWait).toEqual(t.resourceWait);
    expect(b.opened('rui-1')).toBe(0);
  });

  it('o card pronto, cancelado ou "sem código" libera: o outro começa sozinho (conversa aberta, motivo limpo)', async () => {
    const releases: Array<[string, (b: Awaited<ReturnType<typeof club>>, hold: { id: string; work: string | null }) => Promise<void>]> = [
      ['pronto', async (b, hold) => void (await b.svc.update('p', hold.id, { status: 'done' }))],
      ['cancelado', async (b, hold) => void (await b.svc.cancel('p', hold.id, { by: 'you', reason: 'não é mais preciso' }))],
      ['sem código', async (b, hold) => b.endTurn(hold.work!, 'Respondi: não precisa editar.')],
    ];
    for (const [i, [name, release]] of releases.entries()) {
      const b = await club(`libera-${i}-${holderEngine}-${waiterEngine}`, { engines });
      const { hold, wait } = await waiter(b);
      expect((await b.get(wait.id)).sessionId, name).toBeNull();
      await release(b, hold);
      await b.started(wait.id);
      const t = await b.get(wait.id);
      expect(t.status, name).toBe('doing');
      expect(t.resourceWait, name).toBeFalsy();
      expect(b.opened('rui-1'), name).toBe(1);
    }
  });

  it('o card pronto segura a vaga até o commit automático dele sair: o outro só começa depois', async () => {
    const b = await club(`commit-${holderEngine}-${waiterEngine}`, { engines });
    await b.svc.setBoardCommit('p', { autoCommit: true }, true);
    const { hold, wait } = await waiter(b);
    await fs.writeFile(path.join(b.dir, 'a.ts'), 'export const a = 2;\n');
    await b.edit(hold.work!, 'ana-1');
    await b.svc.update('p', hold.id, { status: 'done' });
    await b.started(wait.id);
    await b.svc.commitsSettled();
    const done = await b.get(hold.id);
    const next = await b.get(wait.id);
    expect(done.commit).toMatchObject({ status: 'committed', files: ['a.ts'] });
    // A vaga só abriu depois da tentativa do commit (que grava `commit.at`), não quando o card ficou pronto.
    expect(next.history.find((x) => x.status === 'doing')!.at >= done.commit!.at).toBe(true);
  });
});

describe('o que não entra na conta', () => {
  it('worktree própria não espera pela vaga nem a ocupa', async () => {
    const b = await club('worktree');
    await b.on();
    const hold = await b.begin('ana-1', 'Dona da vaga');
    const wt = await b.begin('wt-1', 'Na cópia dele');
    expect(wt.work).toBeTruthy();
    expect((await b.get(wt.id)).status).toBe('doing');
    expect((await b.get(wt.id)).resourceWait).toBeFalsy();
    // E quem escreve na cópia dele não segura a vaga de quem escreve no principal: com Ana pronta, Rui começa mesmo com o card de Wil ainda fazendo.
    const rui = await b.begin('rui-1', 'Espera', {});
    expect(rui.work).toBeNull();
    expect((await b.get(rui.id)).resourceWait!.holder).toBe(hold.id);
    await b.svc.update('p', hold.id, { status: 'done' });
    await b.started(rui.id);
    expect((await b.get(wt.id)).status).toBe('doing');
  });

  it('worktree própria sozinha: o card dela não faz o outro esperar', async () => {
    const b = await club('worktree-sozinha');
    await b.on();
    await b.begin('wt-1', 'Na cópia dele');
    const rui = await b.begin('rui-1', 'No principal');
    expect(rui.work).toBeTruthy();
    expect((await b.get(rui.id)).status).toBe('doing');
  });

  it('fase de plano: o card de plano primeiro começa com a vaga ocupada e, planejando, não a ocupa', async () => {
    const b = await club('plano-fase');
    await b.on();
    const hold = await b.begin('ana-1', 'Dona da vaga');
    const plan = await b.begin('rui-1', 'Com plano', { planFirst: true });
    expect(plan.work).toBeTruthy();
    expect((await b.get(plan.id)).resourceWait).toBeFalsy();
    // Bia (implementação) espera Ana, não o card de plano de Rui.
    const bia = await b.begin('bia-1', 'Implementa');
    expect(bia.work).toBeNull();
    expect((await b.get(bia.id)).resourceWait).toMatchObject({ holder: hold.id });
    // O plano chega (planejando, esperando quem pediu) e segue sem ocupar: com Ana pronta, Bia começa.
    await b.endTurn(plan.work!, PLAN);
    expect((await b.get(plan.id)).status).toBe('planning');
    await b.svc.update('p', hold.id, { status: 'done' });
    await b.started(bia.id);
    expect((await b.get(plan.id)).status).toBe('planning');
  });

  it('o card de plano primeiro que ainda planeja (fazendo, sem plano nem edição) não faz o outro esperar', async () => {
    const b = await club('plano-fazendo');
    await b.on();
    const plan = await b.begin('rui-1', 'Com plano', { planFirst: true });
    expect((await b.get(plan.id)).status).toBe('doing');
    const bia = await b.begin('bia-1', 'Implementa');
    expect(bia.work).toBeTruthy();
    expect((await b.get(bia.id)).status).toBe('doing');
  });

  it('ficha "só planeja" (autonomia plan): começa em planejando com a vaga ocupada e não a ocupa', async () => {
    const b = await club('so-planeja', { engines: { 'pla-1': 'codex' } });
    await b.on();
    const hold = await b.begin('ana-1', 'Dona da vaga');
    const pla = await b.begin('pla-1', 'Só planejo');
    expect(pla.work).toBeTruthy();
    expect((await b.get(pla.id)).status).toBe('planning');
    const bia = await b.begin('bia-1', 'Implementa');
    expect((await b.get(bia.id)).resourceWait).toMatchObject({ holder: hold.id });
    await b.svc.update('p', hold.id, { status: 'done' });
    await b.started(bia.id);
  });

  it('o card de plano primeiro que editou por conta própria (changedFiles) passa a ocupar a vaga', async () => {
    const b = await club('plano-editou');
    await b.on();
    const plan = await b.begin('rui-1', 'Com plano', { planFirst: true });
    await b.edit(plan.work!, 'rui-1');
    const bia = await b.begin('bia-1', 'Implementa');
    expect(bia.work).toBeNull();
    expect((await b.get(bia.id)).resourceWait).toMatchObject({ holder: plan.id });
  });

  it('conversa direta (card automático) não entra na conta', async () => {
    const b = await club('automatico');
    await b.on();
    await b.edit('direto-1', 'ana-1');
    const autos = (await b.svc.list('p'))!.filter((t) => t.autoCreated);
    expect(autos).toHaveLength(1);
    expect(autos[0]!.status).toBe('doing');
    const rui = await b.begin('rui-1', 'No principal');
    expect(rui.work).toBeTruthy();
  });

  it('o "Começar" do dono passa por cima da vaga (como pela pausa); a API de um gestor espera', async () => {
    const b = await club('dono');
    const { hold, wait } = await waiter(b);
    expect(wait.work).toBeNull();
    const byOwner = await b.create('bia-1', 'Por mim');
    await b.svc.start('p', byOwner, false, { byOwner: true });
    expect((await b.get(byOwner)).status).toBe('doing');
    expect((await b.get(hold.id)).status).toBe('doing');
  });
});

describe('a fila', () => {
  it('a que espera a vaga pula: a próxima da fila dele, que só planeja, começa', async () => {
    const b = await club('pula');
    await b.on();
    const hold = await b.begin('ana-1', 'Dona da vaga');
    // Rui está numa conversa de fora: os dois cards entram na fila, na ordem.
    b.h.outside = true;
    const first = await b.begin('rui-1', 'Implementa');
    const second = await b.begin('rui-1', 'Planeja', { planFirst: true });
    expect((await b.get(first.id)).sessionId).toBeNull();
    expect((await b.get(second.id)).sessionId).toBeNull();
    b.h.outside = false;
    await b.svc.kickStaff('p', 'rui-1');
    await b.started(second.id);
    const t1 = await b.get(first.id);
    expect(t1).toMatchObject({ status: 'todo', sessionId: null });
    expect(t1.resourceWait).toMatchObject({ holder: hold.id });
    expect((await b.get(second.id)).status).toBe('doing');
  });

  it('o motivo acompanha quem ocupa a vaga: mudou o dono, muda o motivo (sem nota nova no histórico)', async () => {
    const b = await club('motivo');
    await b.on();
    const ana = await b.begin('ana-1', 'Dona da vaga');
    const bia = await b.begin('bia-1', 'Segunda da fila');
    const rui = await b.begin('rui-1', 'Terceira da fila');
    expect((await b.get(bia.id)).resourceWait!.holder).toBe(ana.id);
    expect((await b.get(rui.id)).resourceWait!.holder).toBe(ana.id);
    const notes = (await b.get(rui.id)).history.length;
    await b.svc.update('p', ana.id, { status: 'done' });
    await b.started(bia.id);
    await until(async () => expect((await b.get(rui.id)).resourceWait?.holder).toBe(bia.id));
    const t = await b.get(rui.id);
    expect(t.resourceWait!.reason).toContain('“Segunda da fila”');
    expect(t.history.length).toBe(notes);
    expect(b.opened('rui-1')).toBe(0);
  });

  it('duas partidas ao mesmo tempo (funcionários diferentes): só uma abre a conversa', async () => {
    const b = await club('corrida');
    await b.on();
    b.h.sendDelay = 40;
    const ids = [await b.create('ana-1', 'A'), await b.create('rui-1', 'B'), await b.create('bia-1', 'C')];
    await Promise.all(ids.map((id) => b.svc.start('p', id)));
    const all = await Promise.all(ids.map((id) => b.get(id)));
    expect(all.filter((t) => t.sessionId)).toHaveLength(1);
    expect(b.opened('ana-1') + b.opened('rui-1') + b.opened('bia-1')).toBe(1);
    const holder = all.find((t) => t.sessionId)!;
    for (const t of all.filter((x) => !x.sessionId)) expect(t.resourceWait).toMatchObject({ holder: holder.id });
  });

  it('quem já segura a vaga (voltou à fila, ou já estava fazendo quando a opção ligou) segue sem esperar por si', async () => {
    const b = await club('ja-fazendo');
    const ana = await b.begin('ana-1', 'Já fazendo');
    const rui = await b.begin('rui-1', 'Também fazendo');
    expect(rui.work).toBeTruthy();
    await b.on();
    // Duas donas (a opção ligou depois): uma terceira espera as duas, e a que já estava fazendo continua.
    const bia = await b.begin('bia-1', 'Chegou depois');
    expect(bia.work).toBeNull();
    expect((await b.get(bia.id)).resourceWait!.holder).toBe(ana.id);
    expect((await b.get(ana.id)).status).toBe('doing');
    expect((await b.get(rui.id)).status).toBe('doing');
  });

  it('o reinício não perde quem ocupa: o estado vem do tasks.json', async () => {
    const b = await club('reinicio');
    await b.on();
    const hold = await b.begin('ana-1', 'Dona da vaga');
    const novo = b.service();
    const rui = await b.begin('rui-1', 'Depois do reinício', {}, novo);
    expect(rui.work).toBeNull();
    expect((await b.get(rui.id, novo)).resourceWait).toMatchObject({ holder: hold.id });
  });
});

describe.each<[Engine, Engine]>([
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['claude', 'codex'],
])('plano aprovado com a vaga ocupada (dona %s, plano de %s)', (holderEngine, planEngine) => {
  const engines = { 'ana-1': holderEngine, 'rui-1': planEngine };

  it('o card volta à fila com o motivo e a aprovação guardada; a vaga abre e ele implementa na mesma conversa', async () => {
    const b = await club(`aprova-ocupada-${holderEngine}-${planEngine}`, { engines });
    await b.on();
    const hold = await b.begin('ana-1', 'Dona da vaga');
    const plan = await b.begin('rui-1', 'Com plano', { planFirst: true });
    await b.endTurn(plan.work!, PLAN);
    expect((await b.get(plan.id)).status).toBe('planning');
    const out = await b.svc.decidePlan('p', plan.id, b.as('gio-1', 'gio-s'), false, { decision: 'approve', note: 'Use a lib que já existe.' });
    expect(out).toMatchObject({ id: plan.id, status: 'todo', plan: PLAN, sessionId: plan.work });
    expect(out!.planWait).toBeUndefined();
    expect(out!.queuedAt).toBeTruthy();
    expect(out!.resourceWait).toMatchObject({ holder: hold.id });
    expect(out!.history.at(-1)).toMatchObject({ status: 'todo', note: expect.stringContaining('plano aprovado por Gio') });
    expect(out!.held).toHaveLength(1);
    expect(out!.held![0]!.text).toContain('O plano foi aprovado por Gio. Implemente-o agora');
    expect(out!.held![0]!.text).toContain('Observação de quem aprovou: Use a lib que já existe.');
    // Nada foi dito à conversa dele ainda, e a fila mostra o motivo.
    expect(b.h.delivered.filter((d) => d.sessionId === plan.work)).toEqual([]);
    expect(await b.queue('rui-1')).toMatchObject({ state: 'resource-wait', taskId: plan.id });
    await b.svc.tick(new Date());
    expect(b.h.delivered.filter((d) => d.sessionId === plan.work)).toEqual([]);
    // A vaga abre: a aprovação vai à conversa dele e o card volta a fazendo.
    await b.svc.update('p', hold.id, { status: 'done' });
    await until(async () => expect((await b.get(plan.id)).status).toBe('doing'));
    const t = await b.get(plan.id);
    expect(t).toMatchObject({ plan: PLAN, sessionId: plan.work });
    expect(t.held ?? []).toEqual([]);
    expect(t.resourceWait).toBeFalsy();
    const msg = b.h.delivered.filter((d) => d.sessionId === plan.work).at(-1)!.text;
    expect(msg).toContain('[Tarefa "Com plano"]');
    expect(msg).toContain('Observação de quem aprovou: Use a lib que já existe.');
    // E implementa e entrega: a revisão é a de sempre.
    await b.edit(plan.work!, 'rui-1');
    await b.endTurn(plan.work!, 'Feito.');
    expect((await b.get(plan.id)).status).toBe('review');
  });

  it('com a vaga livre a aprovação segue como sempre: o mesmo card vai a fazendo e recebe a mensagem na hora', async () => {
    const b = await club(`aprova-livre-${holderEngine}-${planEngine}`, { engines });
    await b.on();
    const plan = await b.begin('rui-1', 'Com plano', { planFirst: true });
    await b.endTurn(plan.work!, PLAN);
    const out = await b.svc.decidePlan('p', plan.id, b.as('gio-1', 'gio-s'), false, { decision: 'approve' });
    expect(out).toMatchObject({ status: 'doing', plan: PLAN });
    expect(out!.resourceWait).toBeFalsy();
    expect(b.h.delivered.filter((d) => d.sessionId === plan.work).at(-1)!.text).toContain('O plano foi aprovado por Gio');
    // Agora ele segura a vaga: o próximo espera.
    const bia = await b.begin('bia-1', 'Implementa');
    expect((await b.get(bia.id)).resourceWait).toMatchObject({ holder: plan.id });
  });

  it('recusar o plano não passa pela vaga: o card volta a fazendo (ainda planejando) mesmo com ela ocupada', async () => {
    const b = await club(`recusa-ocupada-${holderEngine}-${planEngine}`, { engines });
    await b.on();
    await b.begin('ana-1', 'Dona da vaga');
    const plan = await b.begin('rui-1', 'Com plano', { planFirst: true });
    await b.endTurn(plan.work!, PLAN);
    const out = await b.svc.decidePlan('p', plan.id, b.as('gio-1', 'gio-s'), false, { decision: 'reject', reason: 'Falta o plano de migração.' });
    expect(out).toMatchObject({ status: 'doing' });
    expect(out!.resourceWait).toBeFalsy();
    expect(b.h.delivered.filter((d) => d.sessionId === plan.work).at(-1)!.text).toContain('O plano foi recusado por Gio');
  });
});
