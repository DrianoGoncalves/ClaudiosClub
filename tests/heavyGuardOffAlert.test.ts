import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodexHeavyGuard } from '../server/chat/codexArgs';
import { CodexProcess } from '../server/chat/codexProcess';
import { ChatManager } from '../server/chat/manager';
import { heavyGuardOffInboxItem } from '../server/inboxItems';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Follow-up f-22703c da t-3503b0: o aviso de que a fila de validação pesada ficou desligada (hooks.json na conta do Codex) não pode ficar só no chat, que ninguém lê numa conversa autônoma.
// Conversa de TAREFA leva o aviso à nota da tarefa e à caixa (kind 'error', `InboxItem.heavyGuardOff`), uma vez por conversa e não a cada execução.

const guard: CodexHeavyGuard = { hook: 'C:\\Users\\x\\.myco\\run\\c1\\hooks\\heavy-guard.mjs', lockDir: 'C:\\Users\\x\\.myco\\run\\heavy', ownerPid: 4242 };
const tick = () => new Promise((r) => setTimeout(r, 20));

let root: string;
let n = 0;
/** Uma pasta de dados do Codex só deste teste (CODEX_HOME). */
const codexHome = async () => {
  const dir = path.join(root, `home-${n++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-guardoff-'));
});
afterAll(() => removeTemp(root));
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Cada `spawn` devolve um processo falso do codex (uma execução): `finish` termina o turno e fecha. */
function fakeCodex() {
  const runs: Array<{ finish: () => void }> = [];
  const spawnImpl = () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 7000 + runs.length });
    runs.push({
      finish: () => {
        stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
        child.emit('close', 0);
      },
    });
    return child as never;
  };
  return { runs, spawnImpl: spawnImpl as never, last: () => runs[runs.length - 1]! };
}

describe('CodexProcess: onHeavyGuard avisa a mudança, não a execução', () => {
  const profile = { cwd: '/proj', sessionId: 'sess-g', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' }, heavyGuard: guard };

  it('com hooks.json: o caminho UMA vez em várias mensagens; o arquivo some (null) e volta (de novo)', async () => {
    const dir = await codexHome();
    const file = path.join(dir, 'hooks.json');
    await fs.writeFile(file, '{}');
    vi.stubEnv('CODEX_HOME', dir);
    const seen: Array<string | null> = [];
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onHeavyGuard: (off) => void seen.push(off) });
    chat.start();
    for (const text of ['um', 'dois', 'três']) {
      chat.send(text);
      f.last().finish();
      await tick();
    }
    expect(f.runs).toHaveLength(3);
    expect(seen).toEqual([file]);
    await fs.rm(file);
    chat.send('quatro');
    f.last().finish();
    await tick();
    expect(seen).toEqual([file, null]);
    chat.send('cinco'); // sem o arquivo de novo: nada a avisar
    f.last().finish();
    await tick();
    expect(seen).toEqual([file, null]);
    await fs.writeFile(file, '{}');
    chat.send('seis');
    f.last().finish();
    await tick();
    expect(seen).toEqual([file, null, file]);
  });

  it('sem hooks.json: nunca chama; callback que lança não derruba a execução', async () => {
    const clean = await codexHome();
    vi.stubEnv('CODEX_HOME', clean);
    const seen: Array<string | null> = [];
    const f = fakeCodex();
    const ok = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onHeavyGuard: (off) => void seen.push(off) });
    ok.start();
    ok.send('oi');
    f.last().finish();
    await tick();
    expect(seen).toEqual([]);

    const dir = await codexHome();
    await fs.writeFile(path.join(dir, 'hooks.json'), '{}');
    vi.stubEnv('CODEX_HOME', dir);
    const g = fakeCodex();
    const boom = new CodexProcess({
      ...profile,
      spawnImpl: g.spawnImpl,
      onHeavyGuard: () => {
        throw new Error('quem recebe falhou');
      },
    });
    boom.start();
    boom.send('oi');
    expect(g.runs).toHaveLength(1); // a execução abriu mesmo assim
    g.last().finish();
    await tick();
    expect(boom.snapshot().items.some((i) => i.kind === 'notice' && /hooks\.json/.test(i.text))).toBe(true);
  });
});

describe('ChatManager: conversa de tarefa do Codex sem a fila vira item na caixa', () => {
  function manager(extra: Partial<ConstructorParameters<typeof ChatManager>[0]> = {}) {
    const f = fakeCodex();
    const asked: string[] = [];
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      heavyGuardOff: async (sid) => {
        asked.push(sid);
        return sid === 'sess-task' ? { taskId: 't-a1b2c3', title: 'Tela' } : null;
      },
      resolve: async (_p, sid) => ({
        sessionId: sid ?? 'sess-task',
        cwd: root,
        args: [],
        engine: 'codex' as const,
        codex: {
          autonomy: 'manual' as const,
          model: null,
          effort: null,
          instructions: 'Ficha',
          writableRoots: [],
          readOnlyPaths: [],
          agents: [],
          heavyGuard: guard,
          secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') },
          threadId: null,
          threadFile: path.join(root, `thread-${n++}.json`),
          mycoUrl: 'http://127.0.0.2:4848',
        },
      }),
      spawnImpl: f.spawnImpl,
      log: () => {},
      ...extra,
    });
    return { m, f, asked };
  }

  /** O Codex abre depois de preparar a execução: espera o processo falso aparecer. */
  const opened = async (f: ReturnType<typeof fakeCodex>, count: number) => {
    for (let i = 0; i < 100 && f.runs.length < count; i++) await tick();
    expect(f.runs).toHaveLength(count);
  };

  it('um item por conversa, uma vez (mensagens seguintes não repetem), com a tarefa e o arquivo; ignorar tira', async () => {
    const dir = await codexHome();
    const file = path.join(dir, 'hooks.json');
    await fs.writeFile(file, '{}');
    vi.stubEnv('CODEX_HOME', dir);
    const { m, f, asked } = manager();
    await m.send('p', null, 'cris', 'faça a tela');
    await opened(f, 1);
    await tick();
    expect(m.guardOffHits()).toEqual([expect.objectContaining({ id: 'guardoff:sess-task', sessionId: 'sess-task', taskId: 't-a1b2c3', taskTitle: 'Tela', file })]);
    f.last().finish();
    await tick();
    await m.send('p', 'sess-task', 'cris', 'continue');
    await opened(f, 2);
    f.last().finish();
    await tick();
    expect(asked).toEqual(['sess-task']); // a nota da tarefa e o item saem uma vez só: a segunda execução não repete
    expect(m.guardOffHits()).toHaveLength(1);

    expect(m.dismissGuardOff('guardoff:sess-task')).toBe(true);
    expect(m.guardOffHits()).toEqual([]);
    expect(m.dismissGuardOff('guardoff:sess-task')).toBe(false); // a tela velha não acha nada a ignorar
    expect(m.dismissGuardOff('guardoff:outra')).toBe(false);
  });

  it('o arquivo some: o item sai sozinho; volta se o arquivo voltar', async () => {
    const dir = await codexHome();
    const file = path.join(dir, 'hooks.json');
    await fs.writeFile(file, '{}');
    vi.stubEnv('CODEX_HOME', dir);
    const { m, f } = manager();
    await m.send('p', null, 'cris', 'faça a tela');
    await opened(f, 1);
    await tick();
    expect(m.guardOffHits()).toHaveLength(1);
    f.last().finish();
    await tick();
    await fs.rm(file);
    await m.send('p', 'sess-task', 'cris', 'continue');
    await opened(f, 2);
    f.last().finish();
    await tick();
    expect(m.guardOffHits()).toEqual([]);
    await fs.writeFile(file, '{}');
    await m.send('p', 'sess-task', 'cris', 'mais uma');
    await opened(f, 3);
    await tick();
    expect(m.guardOffHits()).toHaveLength(1);
    f.last().finish();
    await tick();
  });

  it('conversa que não é de tarefa (a dep devolve null) e manager sem a dep: nenhum item', async () => {
    const dir = await codexHome();
    await fs.writeFile(path.join(dir, 'hooks.json'), '{}');
    vi.stubEnv('CODEX_HOME', dir);
    const free = manager({ heavyGuardOff: async () => null });
    await free.m.send('p', null, 'cris', 'oi');
    await opened(free.f, 1);
    await tick();
    expect(free.m.guardOffHits()).toEqual([]);
    free.f.last().finish();

    const bare = manager({ heavyGuardOff: undefined });
    await bare.m.send('p', null, 'cris', 'oi');
    await opened(bare.f, 1);
    await tick();
    expect(bare.m.guardOffHits()).toEqual([]);
    bare.f.last().finish();
    await tick();
  });

  it('sem hooks.json: nenhum item e a dep nem é chamada', async () => {
    vi.stubEnv('CODEX_HOME', await codexHome());
    const { m, f, asked } = manager();
    await m.send('p', null, 'cris', 'oi');
    await opened(f, 1);
    await tick();
    expect(m.guardOffHits()).toEqual([]);
    expect(asked).toEqual([]);
    f.last().finish();
    await tick();
  });
});

describe('TaskService.noteHeavyGuardOff: uma nota por conversa de trabalho', () => {
  async function board(dirName: string) {
    const dir = path.join(root, dirName);
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    const people: Record<string, StaffProfile> = {
      'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    let k = 0;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId) => `${staffId}-${++k}`,
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
    });
    return { dir, svc, get: async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)! };
  }
  const notes = (t: { history: Array<{ note?: string }> }) => t.history.filter((h) => /fila de validação pesada/.test(h.note ?? ''));

  it('a nota vai ao histórico uma vez (chamar de novo, como depois de um reinício, não repete); a tarefa volta para o item; sem o caminho do arquivo', async () => {
    const b = await board('guardoff-note');
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await b.svc.start('p', t.id);
    const work = (await b.get(t.id)).sessionId!;
    const before = (await b.get(t.id)).history.length;
    expect(await b.svc.noteHeavyGuardOff(work)).toEqual({ taskId: t.id, title: 'Tela' });
    expect(await b.svc.noteHeavyGuardOff(work)).toEqual({ taskId: t.id, title: 'Tela' });
    const after = await b.get(t.id);
    expect(notes(after)).toHaveLength(1);
    expect(after.history).toHaveLength(before + 1);
    expect(notes(after)[0]!.note).toMatch(/hooks\.json/);
    expect(notes(after)[0]!.note).toMatch(/bloqueio de git destrutivo/); // t-0ccbff
    expect(notes(after)[0]!.note).not.toMatch(/[\\/]/); // só o nome do arquivo: o histórico aparece em mais telas que o chat
  });

  it('conversa de revisão, conversa livre e card automático: null e nenhuma nota', async () => {
    const b = await board('guardoff-null');
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await b.svc.start('p', t.id);
    const work = (await b.get(t.id)).sessionId!;
    await b.svc.onTurnDone(work);
    const review = (await b.get(t.id)).review!.sessionId;
    expect(review).toBeTruthy();
    expect(await b.svc.noteHeavyGuardOff(review)).toBeNull();
    expect(await b.svc.noteHeavyGuardOff('conversa-livre')).toBeNull();
    await b.svc.onCodeEdit({ sessionId: 'direta-1', projectId: 'p', staffId: 'ana-1', engine: 'codex', cwd: b.dir, files: [path.join(b.dir, 'src', 'a.ts')], request: 'conserte' });
    expect((await b.svc.list('p'))!.some((x) => x.autoCreated && x.sessionId === 'direta-1')).toBe(true);
    expect(await b.svc.noteHeavyGuardOff('direta-1')).toBeNull();
    for (const x of (await b.svc.list('p'))!) expect(notes(x)).toHaveLength(0);
  });
});

describe('heavyGuardOffInboxItem e a fiação do servidor', () => {
  const hit = { id: 'guardoff:sess-1', sessionId: 'sess-1', taskId: 't-a1b2c3', taskTitle: 'Tela', file: 'C:\\Users\\x\\.codex\\hooks.json', at: '2026-11-18T10:00:00.000Z' };
  const place = { projectId: 'p', projectName: 'Site', sessionId: 'sess-1', staffId: 'cris', name: 'Cris' };

  it('item de conversa, kind error (a tela já o ignora por /api/errors/dismiss), com o arquivo só no payload', () => {
    const item = heavyGuardOffInboxItem(hit, place);
    expect(item).toMatchObject({ id: 'guardoff:sess-1', kind: 'error', sessionId: 'sess-1', staffId: 'cris', at: hit.at, heavyGuardOff: { taskId: 't-a1b2c3', taskTitle: 'Tela', file: hit.file } });
    expect(item.summary).toContain('Tela');
    expect(item.summary).toContain('hooks.json');
    expect(item.summary).toContain('bloqueio de git destrutivo'); // t-0ccbff
    expect(item.summary).not.toContain('C:\\'); // o caminho não vai no texto
  });

  it('index.ts: o item entra no GET /api/inbox, a dep vem do TaskService e o ignorar (só pela tela) chega ao manager', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(src).toContain('heavyGuardOff: (sessionId) => tasks.noteHeavyGuardOff(sessionId),');
    expect(src).toContain('for (const g of chats.guardOffHits())');
    expect(src).toContain('resolver.guardOff(heavyGuardOffInboxItem(g, w))'); // passa pelo resolvedor (hooks.json que sumiu = resolvido) antes de entrar na lista
    const start = src.indexOf('/^\\/api\\/errors\\/dismiss$/');
    expect(start).toBeGreaterThan(0);
    const route = src.slice(start, src.indexOf('\n  ],', start));
    expect(route.indexOf('if (!fromBrowser) throw new BadRequest')).toBeGreaterThan(0);
    expect(route.indexOf('if (!fromBrowser)')).toBeLessThan(route.indexOf('parse('));
    expect(route).toMatch(/regex\(\/\^\(error\|cap\|commit\|guardoff\|codexsandbox\|board\):/);
    expect(route).toContain('chats.dismissGuardOff(b.id)');
  });

  it('manager e processo: o callback do Codex liga o aviso ao item', async () => {
    const manager = await fs.readFile(path.join(__dirname, '..', 'server', 'chat', 'manager.ts'), 'utf8');
    expect(manager).toContain('onHeavyGuard: (off) => void this.noteGuardOff(spawn.sessionId, off).catch(() => {}),');
  });
});
