import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pendingChanges } from '../server/autoCommit';
import { ChatManager } from '../server/chat/manager';
import { CodexPasswordPolicy, PASSWORD_POLICY_ID, POLICY_OK_TTL_MS } from '../server/codexPasswordPolicy';
import type { RunResult, Runner } from '../server/folderPicker';
import { handleExtension, type ExtensionDeps } from '../server/extension/routes';
import { commitInboxItem, codexSandboxInboxItem, heavyGuardOffInboxItem } from '../server/inboxItems';
import { CHECK_DEADLINE_MS, COMMIT_CHECK_TTL_MS, InboxResolver, RESOLVED_KEEP_MS, resolvedLast, settleWithin } from '../server/inboxResolved';
import { TaskService, commitAlerts, readTasks } from '../server/tasks';
import { CHANGED_FILES_MAX, type InboxItem, type StaffProfile } from '../shared/model';

// Aviso de erro da caixa com o problema já resolvido (`InboxItem.resolvedAt`, t-d1a1ba): por tipo, aberto → sem marca e resolvido → com marca; prazo de 24 h; commit que fica resolvido;
// ignorar o item resolvido; `error:<sessão>` que some sozinho; a extensão e a ordem da lista. Git de verdade em pasta temporária; o resto com relógio e dependências trocados.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-resolved-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
const write = (dir: string, rel: string, text: string) => fs.writeFile(path.join(dir, rel), text);
const tick = () => new Promise((r) => setTimeout(r, 15));
const HOUR = 60 * 60_000;

/** Relógio que o teste anda (`c.t` é o "agora" de cada teste que chama `startClock`). */
const c = { t: 0 };
const startClock = () => {
  c.t = Date.parse('2026-11-19T10:00:00.000Z');
  return { now: () => c.t, advance: (ms: number) => void (c.t += ms) };
};

const place = { projectId: 'p', projectName: 'Site', sessionId: '', name: 'Ana' };
const capItem = (at = '2026-11-19T09:00:00.000Z'): InboxItem => ({ id: 'cap:s1', kind: 'error', ...place, sessionId: 's1', staffId: 'ana', summary: 'o turno parou no teto', at });
const guardItem = (file: string, at = '2026-11-19T09:00:00.000Z'): InboxItem =>
  heavyGuardOffInboxItem({ id: 'guardoff:s1', sessionId: 's1', taskId: 't-0a1b2c', taskTitle: 'Tela A', file, at }, { ...place, sessionId: 's1', staffId: 'ana' });

describe('pendingChanges: o sinal do commit automático, só leitura', () => {
  it('conta os arquivos da tarefa que ainda têm mudança; zero depois de commitados; null quando não dá para dizer', async () => {
    const dir = path.join(root, 'pc');
    await fs.mkdir(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    await write(dir, 'a.ts', '1\n');
    await write(dir, 'b.ts', '1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    expect(await pendingChanges(dir, ['a.ts', 'b.ts'])).toBe(0);
    await write(dir, 'a.ts', '2\n');
    expect(await pendingChanges(dir, ['a.ts', 'b.ts'])).toBe(1);
    await write(dir, 'novo.ts', 'x\n'); // arquivo novo sem rastreio também é mudança pendente
    expect(await pendingChanges(dir, ['a.ts', 'novo.ts'])).toBe(2);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'depois');
    expect(await pendingChanges(dir, ['a.ts', 'novo.ts'])).toBe(0);

    // Sem lista, lista no teto (pode estar cortada), caminho fora do projeto e pasta que não é repositório: sem sinal.
    expect(await pendingChanges(dir, undefined)).toBeNull();
    expect(await pendingChanges(dir, [])).toBeNull();
    expect(await pendingChanges(dir, Array.from({ length: CHANGED_FILES_MAX }, (_, i) => `f${i}.ts`))).toBeNull();
    expect(await pendingChanges(dir, ['a.ts', '../fora.ts'])).toBeNull();
    const plain = path.join(root, 'sem-git');
    await fs.mkdir(plain);
    expect(await pendingChanges(plain, ['a.ts'])).toBeNull();
  });
});

describe('commit automático (commit:): aberto → sem marca; resolvido → com marca', () => {
  /** Repositório com a.ts e .env commitados + TaskService (como em autoCommit.test.ts). */
  async function project(name: string) {
    const dir = path.join(root, name);
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    for (const f of ['a.ts', '.env']) await write(dir, f, `v1 ${f}\n`);
    git(dir, 'add', '-f', '--', 'a.ts', '.env');
    git(dir, 'commit', '-q', '-m', 'base');
    const people: Record<string, StaffProfile> = { 'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile };
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async () => 's-1',
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
    await svc.setBoardCommit('p', { autoCommit: true }, true);
    const file = path.join(dir, '.myco', 'tasks.json');
    const task = async (title: string, patch: Record<string, unknown>) => {
      const t = (await svc.create('p', { title, description: `Pedido de ${title}`, staffId: 'ana-1' }))!;
      const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
      Object.assign(all.find((x) => x.id === t.id)!, patch);
      await fs.writeFile(file, JSON.stringify(all));
      return t.id;
    };
    return { dir, svc, task, get: async (id: string) => (await readTasks(dir)).find((t) => t.id === id)! };
  }

  it('commit parcial: com arquivo de fora pendente fica sem marca; commitado à mão, marca; fica marcado mesmo se o arquivo mudar de novo; ignorar funciona; prazo de 24 h', async () => {
    const p = await project('commit-e2e');
    await write(p.dir, 'a.ts', 'v2 a.ts\n'); // da tarefa: entra no commit
    await write(p.dir, '.env', 'v2 .env\n'); // barrado (segredo): fica de fora
    const id = await p.task('Tela A', { changedFiles: ['a.ts', '.env'], status: 'review' });
    await p.svc.update('p', id, { status: 'done' }, true);
    await p.svc.commitsSettled();
    const t = await p.get(id);
    const [alert] = commitAlerts([t]);
    expect(alert!.commit).toMatchObject({ status: 'partial' });

    const k = startClock();
    const r = new InboxResolver({ now: k.now });
    const item = () => commitInboxItem(commitAlerts([t])[0]!, place);

    // Aberto: o .env segue com mudança no git → sem marca.
    expect((await r.commit(item(), p.dir, t))!.resolvedAt).toBeUndefined();

    // Cache: dentro de 30 s o git nem é consultado (nem a mudança feita agora aparece ainda).
    git(p.dir, 'add', '-f', '--', '.env');
    git(p.dir, 'commit', '-q', '-m', 'à mão');
    k.advance(COMMIT_CHECK_TTL_MS - 1);
    expect((await r.commit(item(), p.dir, t))!.resolvedAt).toBeUndefined();

    // Resolvido: com os arquivos limpos no git, a leitura seguinte marca, com a hora da primeira vez que viu.
    k.advance(2);
    const seen = new Date(c.t).toISOString();
    expect((await r.commit(item(), p.dir, t))!.resolvedAt).toBe(seen);

    // Fica resolvido: outra tarefa mexe nos mesmos arquivos e o aviso não volta a pendente (nem muda a hora).
    await write(p.dir, 'a.ts', 'v3 de outra tarefa\n');
    k.advance(COMMIT_CHECK_TTL_MS + 1);
    expect((await r.commit(item(), p.dir, t))!.resolvedAt).toBe(seen);

    // Outra ocorrência (outro commit automático, `at` diferente) começa pendente de novo.
    const again = { ...item(), at: '2026-11-20T00:00:00.000Z' };
    expect((await r.commit(again, p.dir, t))!.resolvedAt).toBeUndefined();

    // Prazo: 24 h depois de visto, o item sai da caixa.
    k.advance(RESOLVED_KEEP_MS);
    expect(await r.commit(item(), p.dir, t)).toBeNull();

    // Ignorar o item resolvido é o mesmo `ackCommit` de sempre: o aviso some e não volta.
    expect(await p.svc.ackCommit(`commit:p:${id}`)).toBe(true);
    expect(commitAlerts([await p.get(id)])).toEqual([]);
  });

  it('sem sinal confiável o item segue pendente: git sem resposta, lista que não vale, git lento', async () => {
    const k = startClock();
    const item = commitInboxItem({ task: { id: 't-0a1b2c', title: 'Tela A' } as never, commit: { for: 'x', at: '2026-11-19T09:00:00.000Z', status: 'failed', sha: null, files: [], left: [], note: 'hook falhou', alert: true } }, place);
    const calls: number[] = [];
    const r = new InboxResolver({ now: k.now, pending: async () => (calls.push(1), null) });
    expect((await r.commit(item, '/x', { changedFiles: undefined }))!.resolvedAt).toBeUndefined();
    k.advance(COMMIT_CHECK_TTL_MS + 1);
    expect((await r.commit(item, '/x', { changedFiles: [] }))!.resolvedAt).toBeUndefined();
    expect(calls).toHaveLength(2);

    // Git lento: passou do prazo, o item não espera por ele.
    vi.useFakeTimers();
    try {
      const slow = new InboxResolver({ now: k.now, pending: () => new Promise<number>(() => {}) });
      const out = slow.commit(item, '/x', { changedFiles: ['a.ts'] });
      await vi.advanceTimersByTimeAsync(CHECK_DEADLINE_MS + 1);
      expect((await out)!.resolvedAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fila desligada (guardoff:): aberto → sem marca; resolvido → com marca', () => {
  it('o hooks.json existe: sem marca; sumiu: marca; voltou: volta a pendente; 24 h depois sai', async () => {
    const hooks = path.join(root, 'hooks.json');
    await fs.writeFile(hooks, '{}');
    const k = startClock();
    const r = new InboxResolver({ now: k.now });
    expect((await r.guardOff(guardItem(hooks)))!.resolvedAt).toBeUndefined();

    await fs.rm(hooks);
    k.advance(1_000);
    const seen = new Date(c.t).toISOString();
    const gone = await r.guardOff(guardItem(hooks));
    expect(gone).toMatchObject({ kind: 'error', resolvedAt: seen, heavyGuardOff: { file: hooks } });
    k.advance(HOUR);
    expect((await r.guardOff(guardItem(hooks)))!.resolvedAt).toBe(seen); // a hora é a da primeira vez

    await fs.writeFile(hooks, '{}'); // o arquivo voltou: é problema de novo
    expect((await r.guardOff(guardItem(hooks)))!.resolvedAt).toBeUndefined();

    await fs.rm(hooks);
    expect((await r.guardOff(guardItem(hooks)))!.resolvedAt).toBeDefined();
    k.advance(RESOLVED_KEEP_MS + 1);
    expect(await r.guardOff(guardItem(hooks))).toBeNull();
  });

  it('item sem caminho do arquivo não tem sinal', async () => {
    const r = new InboxResolver();
    expect((await r.guardOff({ ...guardItem('x'), heavyGuardOff: undefined }))!.resolvedAt).toBeUndefined();
  });
});

describe('teto do turno (cap:): aberto → sem marca; resolvido → com marca', () => {
  it('tarefa da conversa aberta ou sem tarefa ligada: sem marca; pronta ou cancelada: marca; 24 h depois sai', () => {
    const k = startClock();
    const r = new InboxResolver({ now: k.now });
    expect(r.cap(capItem(), undefined)!.resolvedAt).toBeUndefined();
    for (const status of ['todo', 'doing', 'review'] as const) expect(r.cap(capItem(), { status })!.resolvedAt).toBeUndefined();

    const seen = new Date(c.t).toISOString();
    expect(r.cap(capItem(), { status: 'done' })).toMatchObject({ kind: 'error', id: 'cap:s1', resolvedAt: seen });
    k.advance(HOUR);
    expect(r.cap(capItem(), { status: 'cancelled' })!.resolvedAt).toBe(seen);
    // A tarefa voltou a andar: pendente.
    expect(r.cap(capItem(), { status: 'doing' })!.resolvedAt).toBeUndefined();
    r.cap(capItem(), { status: 'done' });
    k.advance(RESOLVED_KEEP_MS + 1);
    expect(r.cap(capItem(), { status: 'done' })).toBeNull();
  });
});

describe('sandbox do Codex (codexsandbox:): aberto → sem marca; resolvido → com marca', () => {
  const rows = (minAge: string) => [`Força logoff:    Nunca`, `Duração mínima da senha (dias):    ${minAge}`, ...Array.from({ length: 7 }, (_, i) => `rótulo ${i}:    ${i}`)].join('\n');
  function policy(first: string) {
    let out = first;
    const run: Runner = async () => ({ code: 0, stdout: out, stderr: '', timedOut: false, missing: false }) as RunResult;
    const k = startClock();
    const p = new CodexPasswordPolicy({ platform: 'win32', run, now: k.now, env: { SystemRoot: 'C:\\Windows' }, log: () => {} });
    return { p, k, set: (v: string) => void (out = v) };
  }

  it('política > 0: o item sai sem marca; passou a 0: o mesmo aviso fica, com a hora; vence o prazo e sai', async () => {
    const t = policy(rows('1'));
    await t.p.check();
    const open = codexSandboxInboxItem(t.p.current()!);
    expect(open).toMatchObject({ id: PASSWORD_POLICY_ID, kind: 'error' });
    expect(open).not.toHaveProperty('resolvedAt');

    t.set(rows('0'));
    t.k.advance(POLICY_OK_TTL_MS + 1);
    await t.p.check();
    const resolved = t.p.current()!;
    expect(resolved.resolvedAt).toBe(new Date(c.t).toISOString());
    const item = codexSandboxInboxItem(resolved);
    expect(item.resolvedAt).toBe(resolved.resolvedAt);
    expect(item.summary).toBe(open.summary); // o texto do problema não muda

    const r = new InboxResolver({ now: t.k.now });
    expect(r.codexSandbox(item)).toBe(item);
    t.k.advance(RESOLVED_KEEP_MS - 1);
    expect(r.codexSandbox(item)).toBe(item);
    t.k.advance(2);
    expect(r.codexSandbox(item)).toBeNull();
    expect(r.codexSandbox(open)).toBe(open); // sem marca, o prazo não se aplica
  });

  it('só a política que passou conta: leitura 0 na origem (outra regra de senha) não ganha marca', async () => {
    const t = policy(rows('0'));
    await t.p.noteFailure();
    t.k.advance(POLICY_OK_TTL_MS + 1);
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 0 });
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
  });

  it('aviso nascido de leitura que falhou (null) também ganha a marca quando a leitura dá 0', async () => {
    const t = policy('lixo');
    await t.p.noteFailure();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: null });
    t.set(rows('0'));
    t.k.advance(POLICY_OK_TTL_MS + 1);
    await t.p.check();
    expect(t.p.current()!.resolvedAt).toBeDefined();
  });

  it('ignorar o aviso resolvido sai e NÃO silencia o problema de novo; falhou de novo, volta pendente e com hora nova', async () => {
    const t = policy(rows('1'));
    await t.p.check();
    t.set(rows('0'));
    t.k.advance(POLICY_OK_TTL_MS + 1);
    await t.p.check();
    expect(t.p.dismiss(PASSWORD_POLICY_ID)).toBe(true);
    expect(t.p.current()).toBeNull();
    expect(t.p.dismiss(PASSWORD_POLICY_ID)).toBe(false);

    t.set(rows('2'));
    t.k.advance(POLICY_OK_TTL_MS + 1);
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 2, source: 'check' });
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
  });

  it('o aviso resolvido não se reabre sozinho: erro do turno depois levanta um aviso novo, sem a marca', async () => {
    const t = policy(rows('1'));
    await t.p.check();
    t.set(rows('0'));
    t.k.advance(POLICY_OK_TTL_MS + 1);
    await t.p.check();
    const before = t.p.current()!.at;
    t.k.advance(5_000);
    await t.p.noteFailure(); // o erro seguiu: agora é outra regra de senha (0)
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 0, source: 'turn' });
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
    expect(t.p.current()!.at).not.toBe(before);
  });
});

describe('error:<sessão>: sem marca, o item some sozinho', () => {
  function manager() {
    const procs: Array<EventEmitter & { stdin: PassThrough }> = [];
    const spawnImpl = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242 + procs.length, kill: () => proc.emit('exit', 0) });
      stdin.on('data', () => {});
      procs.push(proc);
      return proc as never;
    };
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: '.', args: [] }),
      spawnImpl,
    });
    return { m, procs };
  }

  it('a conversa parou com erro e voltou (mensagem nova zera chat.error): o item sai da caixa, sem passar por "resolvido"', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    procs[0]!.emit('exit', 1);
    await tick();
    expect(m.attention()).toEqual([{ sessionId: 'sx', pending: [], error: 'o claude saiu com código 1' }]);

    await m.send('p', 'sx', 'ana', 'tente de novo');
    expect(procs).toHaveLength(2);
    expect(m.attention()).toEqual([]);
  });

  it('conversa parada com erro e esquecida: o ChatManager a larga (reap) e o item sai sozinho', async () => {
    const { m, procs } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    procs[0]!.emit('exit', 1);
    await tick();
    expect(m.attention()).toHaveLength(1);
    (m as unknown as { reap(): void }).reap();
    expect(m.attention()).toEqual([]);
  });

  it('o item de erro de conversa nasce sem a marca (index.ts não passa `error:` pelo resolvedor)', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(src).toContain("out.push({ id: `error:${sessionId}`, kind: 'error', ...w, summary: error, at: null })");
  });
});

describe('InboxResolver: a leitura da caixa', () => {
  it('sweep: esquece o que a leitura não viu (a próxima ocorrência recomeça), sem derrubar o que outra leitura viu', () => {
    const k = startClock();
    const r = new InboxResolver({ now: k.now });
    const a = r.begin();
    r.cap(capItem(), { status: 'done' });
    k.advance(HOUR);
    // Uma leitura que não viu o aviso (ignorado, ou outra ocorrência) o esquece; ele volta como pendente (a tarefa aberta) e depois resolvido com hora nova.
    const b = r.begin();
    r.sweep(b);
    k.advance(HOUR);
    const again = r.cap(capItem(), { status: 'done' });
    expect(again!.resolvedAt).toBe(new Date(Date.parse('2026-11-19T10:00:00.000Z') + 2 * HOUR).toISOString());

    // Leituras que se cruzam: a que começou antes termina depois da que viu o aviso e não o esquece.
    const early = r.begin();
    k.advance(1_000);
    r.cap(capItem(), { status: 'done' });
    r.sweep(early);
    expect(r.cap(capItem(), { status: 'done' })!.resolvedAt).toBe(again!.resolvedAt);
    void a;
  });

  it('resolvedLast: os resolvidos vão depois dos pendentes, e a ordem de antes vale dentro de cada grupo', () => {
    const open = capItem();
    const done = { ...capItem(), id: 'cap:s2', resolvedAt: '2026-11-19T10:00:00.000Z' };
    const order = [done, open].sort((x, y) => resolvedLast(x, y));
    expect(order.map((i) => i.id)).toEqual(['cap:s1', 'cap:s2']);
    expect(resolvedLast(open, { ...open })).toBe(0);
  });

  it('settleWithin: devolve o fallback no prazo e nunca lança', async () => {
    expect(await settleWithin(Promise.resolve(3), 50, 0)).toBe(3);
    expect(await settleWithin(Promise.reject(new Error('x')), 50, 0)).toBe(0);
    expect(await settleWithin(new Promise<number>(() => {}), 20, -1)).toBe(-1);
  });

  it('index.ts: cada tipo passa pelo resolvedor, o sandbox relê a política enquanto pendente, e o fim da leitura varre e ordena os resolvidos por último', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(src).toContain('resolver.cap(');
    expect(src).toContain('resolver.commit(');
    expect(src).toContain('resolver.guardOff(');
    expect(src).toContain('resolver.codexSandbox(codexSandboxInboxItem(sandbox))');
    expect(src).toContain('settleWithin(codexPolicy.check()');
    expect(src).toContain('resolver.sweep(readAt)');
    expect(src).toContain('resolvedLast(a, b) || INBOX_ORDER');
    // O ignorar é o de sempre: a mesma rota, sem caminho novo.
    expect(src).toMatch(/regex\(\/\^\(error\|cap\|commit\|guardoff\|codexsandbox\):/);
  });
});

describe('extensão do Chrome: item resolvido não conta no ícone', () => {
  it('GET /api/ext/v1/inbox deixa de fora os itens com resolvedAt e leva os pendentes', async () => {
    const items: InboxItem[] = [capItem(), { ...capItem(), id: 'cap:s2', resolvedAt: '2026-11-19T10:00:00.000Z' }, { ...guardItem('x'), resolvedAt: '2026-11-19T10:00:00.000Z' }];
    const deps = { inbox: async () => items, log: () => {} } as unknown as ExtensionDeps;
    let status = 0;
    let body = '';
    const res = {
      writeHead: (s: number) => void (status = s),
      end: (b: string) => void (body = b),
    };
    await handleExtension({ method: 'GET' } as never, res as never, { url: new URL('http://127.0.0.1:4848/api/ext/v1/inbox'), extension: { pairingId: 'pair-1' } } as never, deps);
    expect(status).toBe(200);
    const got = (JSON.parse(body) as { items: Array<{ kind: string }> }).items;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'error' });
    expect(body).not.toContain('resolvedAt');
  });
});
