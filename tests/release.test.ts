import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Task, TestRun } from '../shared/model';
import { expandScope, nextVersion, parseReleaseBody, releaseBody, releaseProgress } from '../shared/release';
import { ReleaseError, ReleaseService, type ReleaseDeps } from '../server/release';
import { installOwnership, NotOwnerError, ownsProject, ProjectOwnership } from '../server/projectOwner';
import { tempDirs } from './support/tmp';

// Versão com escopo: o dono escolhe as tarefas, as de fora esperam, a versão se prepara sozinha (testes, número, commit local) e publicar e criar a tag são
// botões dele. O histórico vem das tags. Aqui o git e o gh são falsos: o que importa é o que o serviço pede a eles e o que ele grava.

const tmp = tempDirs();

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({ id, title: `Tarefa ${id}`, status, staffId: 'ana-1', blockedBy: [], ...extra }) as Task;

describe('contas da versão (shared/release.ts)', () => {
  it('o número: a próxima correção depois da maior tag ou do package.json; sem nada, 0.1.0', () => {
    expect(nextVersion(['v1.5.1', 'v1.5.0', '1.5.0', 'v1.4.9', 'lixo'])).toBe('1.5.2');
    expect(nextVersion(['v1.10.0', 'v1.9.3'])).toBe('1.10.1');
    expect(nextVersion([])).toBe('0.1.0');
  });

  it('o escopo puxa as bloqueadoras abertas em cadeia; pronta e cancelada não entram', () => {
    const tasks = [
      task('t-aaaa01', 'todo', { blockedBy: ['t-bbbb02', 't-done03', 't-canc04'] }),
      task('t-bbbb02', 'review', { blockedBy: ['t-cccc05'] }),
      task('t-done03', 'done'),
      task('t-canc04', 'cancelled'),
      task('t-cccc05', 'waiting'),
    ];
    expect(expandScope(tasks, ['t-aaaa01'])).toEqual(['t-aaaa01', 't-bbbb02', 't-cccc05']);
  });

  it('o progresso: cancelada sai da conta, travada por cancelada impede, pronta conta; só fica pronta com tudo feito', () => {
    const st = { taskIds: ['t-aaaa01', 't-bbbb02', 't-cccc03'] };
    const p = releaseProgress([task('t-aaaa01', 'done'), task('t-bbbb02', 'cancelled'), task('t-cccc03', 'doing', { reworkRounds: 2 })], st);
    expect(p).toMatchObject({ done: 1, total: 2, ready: false });
    expect(p.tasks.map((x) => x.state)).toEqual(['done', 'cancelled', 'pending']);
    expect(p.tasks[2]!.rejections).toBe(2);
    const stuck = releaseProgress([task('t-aaaa01', 'done'), task('t-bbbb02', 'cancelled'), task('t-cccc03', 'todo', { blockedBy: ['t-bbbb02'] })], st);
    expect(stuck.tasks[2]!.state).toBe('stuck');
    expect(stuck.ready).toBe(false);
    expect(releaseProgress([task('t-aaaa01', 'done'), task('t-bbbb02', 'cancelled'), task('t-cccc03', 'done')], st).ready).toBe(true);
  });

  it('o corpo da tag leva o resumo e as tarefas, e o histórico lê de volta', () => {
    const body = releaseBody('Versão 1.5.2', [{ id: 't-aaaa01', title: 'Tela  nova\n de versão' }]);
    expect(body).toBe('Versão 1.5.2\n\nTarefas:\n- t-aaaa01 Tela nova de versão');
    expect(parseReleaseBody(body)).toEqual({ summary: 'Versão 1.5.2', tasks: [{ id: 't-aaaa01', title: 'Tela nova de versão' }] });
    expect(parseReleaseBody('notas antigas\nsem tarefas')).toEqual({ summary: 'notas antigas\nsem tarefas', tasks: [] });
  });
});

/** Um projeto numa pasta temporária, com as tarefas na memória e o git e o gh falsos que anotam cada chamada. */
async function setup(opts: { tasks?: Task[]; tests?: TestRun | null; tags?: string[]; merged?: boolean } = {}) {
  const dir = await tmp('myco-release-');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.5.0' }, null, 2) + '\n');
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.5.0', packages: { '': { name: 'x', version: '1.5.0' } } }, null, 2) + '\n');
  const h = {
    tasks: opts.tasks ?? [task('t-aaaa01', 'todo', { blockedBy: ['t-bbbb02'] }), task('t-bbbb02', 'doing'), task('t-out003', 'todo')],
    git: [] as string[][],
    gh: [] as string[][],
    created: [] as unknown[],
    started: [] as string[],
    lifted: [] as string[],
    tests: 0,
  };
  const tags = new Set(opts.tags ?? []);
  const git: ReleaseDeps['tools']['git'] = async (_cwd, args) => {
    h.git.push(args);
    const [cmd] = args;
    if (cmd === 'rev-parse' && args.includes('--verify')) {
      const ref = args.at(-1)!;
      if (tags.has(ref.replace(/^refs\/tags\//, '').replace(/\^\{commit\}$/, ''))) return 'f'.repeat(40);
      throw new Error('não existe');
    }
    if (cmd === 'rev-parse' && args[1] === 'HEAD') return 'a'.repeat(40) + '\n';
    if (cmd === 'rev-parse' && args[1] === '--abbrev-ref') return 'release/1.5.0\n';
    if (cmd === 'status') return '';
    if (cmd === 'remote') return 'https://github.com/dono/club.git\n';
    if (cmd === 'config') return '';
    if (cmd === 'symbolic-ref') return 'origin/main\n';
    if (cmd === 'for-each-ref')
      return [
        ['v1.5.2', '2026-11-23T10:00:00-03:00', 'b'.repeat(40), 'c'.repeat(40), 'Versão 1.5.2', releaseBody('PR: x', [{ id: 't-aaaa01', title: 'A' }])].join('\0'),
        ['v1.5.1', '2026-11-19T10:00:00-03:00', 'd'.repeat(40), 'e'.repeat(40), "Claudio's Club v1.5.1", 'notas'].join('\0'),
        ['nao-semver', '2026-11-01T10:00:00-03:00', '1'.repeat(40), '', 'x', ''].join('\0'),
      ]
        .map((r) => `\n${r}\x1e`)
        .join('');
    return '';
  };
  const gh: ReleaseDeps['tools']['gh'] = async (args) => {
    h.gh.push(args);
    if (args[1] === 'create') return 'https://github.com/dono/club/pull/99\n';
    if (args[1] === 'view') return JSON.stringify(opts.merged === false ? { state: 'OPEN', mergeCommit: null } : { state: 'MERGED', mergeCommit: { oid: '9'.repeat(40) } });
    return '';
  };
  const deps: ReleaseDeps = {
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readTasks: async () => h.tasks,
    createTask: async (_p, body) => {
      h.created.push(body);
      const id = 't-docs09';
      h.tasks = [...h.tasks, task(id, 'waiting', { title: body.title, staffId: body.staffId })];
      return { id };
    },
    startTask: async (_p, id) => {
      h.started.push(id);
      h.tasks = h.tasks.map((x) => (x.id === id ? { ...x, status: 'todo', queuedAt: 'agora' } : x));
    },
    runTests: async () => {
      h.tests++;
      return opts.tests === undefined ? ({ command: 'npm test', ok: true, output: 'ok', ms: 1, at: '' } as TestRun) : opts.tests;
    },
    tools: { git, gh },
    onScopeLifted: (id) => h.lifted.push(id),
    log: () => {},
    now: () => new Date('2026-11-23T12:00:00.000Z'),
  };
  const svc = new ReleaseService(deps);
  const set = (id: string, status: Task['status']) => (h.tasks = h.tasks.map((x) => (x.id === id ? { ...x, status } : x)));
  const file = path.join(dir, '.myco', 'release.json');
  return { svc, deps, h, dir, set, file };
}

describe('ReleaseService', () => {
  it('abrir: só pela tela, número livre, só pendentes; puxa a bloqueadora, cria o card de manual em Aguardar e grava', async () => {
    const c = await setup({ tags: ['v1.5.1'] });
    await expect(c.svc.open('p', { version: '1.5.2', taskIds: ['t-aaaa01'] }, false)).rejects.toMatchObject({ status: 403 });
    await expect(c.svc.open('p', { version: '1.5.1', taskIds: ['t-aaaa01'] }, true)).rejects.toThrow(/já existe/);
    await expect(c.svc.open('p', { version: 'um', taskIds: ['t-aaaa01'] }, true)).rejects.toMatchObject({ status: 400 });
    c.set('t-out003', 'done');
    await expect(c.svc.open('p', { version: '1.5.2', taskIds: ['t-out003'] }, true)).rejects.toThrow(/pendente/);
    const v = (await c.svc.open('p', { version: '1.5.2', taskIds: ['t-aaaa01'], docsStaffId: 'luana-1' }, true))!;
    expect(v.release).toMatchObject({ version: '1.5.2', taskIds: ['t-aaaa01', 't-bbbb02', 't-docs09'], docsTaskId: 't-docs09', prepared: null });
    expect(c.h.created).toEqual([expect.objectContaining({ title: 'Manual e doc da versão 1.5.2', staffId: 'luana-1', start: false })]);
    expect(v).toMatchObject({ done: 0, total: 3, ready: false });
    expect([...(await c.svc.scope('p'))!.ids]).toEqual(['t-aaaa01', 't-bbbb02', 't-docs09']);
    // Gravado: outra instância (o reinício) lê o mesmo.
    const again = new ReleaseService(c.deps);
    expect((await again.state('p'))?.taskIds).toEqual(['t-aaaa01', 't-bbbb02', 't-docs09']);
    await expect(c.svc.open('p', { version: '1.5.3', taskIds: ['t-aaaa01'] }, true)).rejects.toThrow(/já há uma versão aberta/);
  });

  it('mudar o escopo: tirar a bloqueadora de quem ainda anda é recusado; pôr puxa as dependências', async () => {
    const c = await setup({ tasks: [task('t-aaaa01', 'todo', { blockedBy: ['t-bbbb02'] }), task('t-bbbb02', 'doing'), task('t-cccc03', 'todo', { blockedBy: ['t-dddd04'] }), task('t-dddd04', 'todo')] });
    await c.svc.open('p', { version: '1.5.2', taskIds: ['t-aaaa01'] }, true);
    await expect(c.svc.changeScope('p', { remove: ['t-bbbb02'] }, true)).rejects.toThrow(/depende de t-bbbb02/);
    const v = (await c.svc.changeScope('p', { add: ['t-cccc03'], remove: [] }, true))!;
    expect(v.release!.taskIds).toEqual(['t-aaaa01', 't-bbbb02', 't-cccc03', 't-dddd04']);
    const w = (await c.svc.changeScope('p', { remove: ['t-aaaa01', 't-bbbb02'] }, true))!;
    expect(w.release!.taskIds).toEqual(['t-cccc03', 't-dddd04']);
  });

  it('preparar: só com tudo pronto; roda os testes, sobe o número no package.json e no lock e faz o commit só deles; a trava sai', async () => {
    const c = await setup();
    await c.svc.open('p', { version: '1.5.2', taskIds: ['t-aaaa01'] }, true);
    await expect(c.svc.prepare('p', {}, true)).rejects.toThrow(/faltam 2 de 2/);
    c.set('t-aaaa01', 'done');
    c.set('t-bbbb02', 'done');
    // Por trás: a resposta volta na hora com `preparing`, e a tela acompanha pela leitura.
    expect((await c.svc.prepare('p', {}, true))!.preparing).toBe(true);
    await c.svc.settled('p');
    const v = (await c.svc.view('p'))!;
    expect(v.preparing).toBe(false);
    expect(c.h.tests).toBe(1);
    expect(JSON.parse(await fs.readFile(path.join(c.dir, 'package.json'), 'utf8')).version).toBe('1.5.2');
    const lock = JSON.parse(await fs.readFile(path.join(c.dir, 'package-lock.json'), 'utf8'));
    expect([lock.version, lock.packages[''].version]).toEqual(['1.5.2', '1.5.2']);
    const commit = c.h.git.find((a) => a[0] === 'commit')!;
    expect(commit.slice(0, 4)).toEqual(['commit', '--only', '--allow-empty', '-m']);
    expect(commit).toContain('Versão 1.5.2');
    expect(commit.slice(-3)).toEqual(['--', 'package.json', 'package-lock.json']);
    expect(commit.find((x) => x.includes('- t-aaaa01 Tarefa t-aaaa01'))).toBeTruthy();
    expect(v.release!.prepared).toEqual({ at: '2026-11-23T12:00:00.000Z', sha: 'a'.repeat(40), branch: 'release/1.5.0' });
    expect(await c.svc.scope('p')).toBeNull();
    expect(c.h.lifted).toEqual(['p']);
    await expect(c.svc.changeScope('p', { add: ['t-out003'] }, true)).rejects.toThrow(/já foi preparada/);
  });

  it('testes vermelhos: nada é commitado, a falha fica gravada e a rotina não tenta de novo; "sem os testes" passa', async () => {
    const c = await setup({ tests: { command: 'npm test', ok: false, output: 'FAIL x.test.ts', ms: 1, at: '' } as TestRun });
    await c.svc.open('p', { version: '1.5.2', taskIds: ['t-bbbb02'] }, true);
    c.set('t-bbbb02', 'done');
    await c.svc.sweep();
    await c.svc.settled('p');
    const st = (await c.svc.state('p'))!;
    expect(st.prepareError).toMatchObject({ message: 'os testes falharam: nada foi commitado', testsOutput: 'FAIL x.test.ts' });
    expect(c.h.git.some((a) => a[0] === 'commit')).toBe(false);
    await c.svc.sweep();
    await c.svc.settled('p');
    expect(c.h.tests).toBe(1);
    await c.svc.prepare('p', { skipTests: true }, true);
    await c.svc.settled('p');
    expect((await c.svc.state('p'))!.prepared).not.toBeNull();
    expect(c.h.tests).toBe(1);
  });

  it('package.json mexido sem commit: recusa antes dos testes; erro imprevisto (disco, git) também fica gravado', async () => {
    const c = await setup();
    const git = c.deps.tools.git;
    c.deps.tools.git = async (cwd, args, o) => (args[0] === 'status' ? ' M package.json\n' : git(cwd, args, o));
    await c.svc.open('p', { version: '1.5.2', taskIds: ['t-bbbb02'] }, true);
    c.set('t-bbbb02', 'done');
    await c.svc.prepare('p', {}, true);
    await c.svc.settled('p');
    expect((await c.svc.state('p'))!.prepareError?.message).toMatch(/package.json e package-lock.json tem mudança/);
    expect(c.h.tests).toBe(0);
    // Imprevisto: o package.json não é JSON.
    c.deps.tools.git = git;
    await fs.writeFile(path.join(c.dir, 'package.json'), '{ quebrado');
    await c.svc.prepare('p', {}, true);
    await c.svc.settled('p');
    expect((await c.svc.state('p'))!).toMatchObject({ prepared: null, prepareError: { message: expect.stringMatching(/^a preparação falhou: /) } });
  });

  it('a rotina: o card de manual entra na fila quando as outras ficam prontas; com ele pronto, prepara sozinha', async () => {
    const c = await setup();
    await c.svc.open('p', { version: '1.5.2', taskIds: ['t-bbbb02'], docsStaffId: 'luana-1' }, true);
    await c.svc.sweep();
    expect(c.h.started).toEqual([]);
    c.set('t-bbbb02', 'done');
    await c.svc.sweep();
    expect(c.h.started).toEqual(['t-docs09']);
    expect((await c.svc.state('p'))!.prepared).toBeNull();
    c.set('t-docs09', 'done');
    await c.svc.sweep();
    await c.svc.settled('p');
    expect((await c.svc.state('p'))!.prepared?.sha).toBe('a'.repeat(40));
  });

  it('posse do projeto (t-f50944): a rotina de uma versão aberta num projeto de outro servidor não põe card na fila nem prepara; no dono, sim', async () => {
    const c = await setup();
    const alive = new Set([8101, 8102]);
    const mk = (home: string, pid: number) => {
      const o = new ProjectOwnership({ home: path.join(c.dir, '..', `home-${home}`), defaultHome: path.join(c.dir, '..', 'home-main'), pid, isAlive: (p) => alive.has(p), log: () => {} });
      o.open();
      return o;
    };
    const main = mk('main', 8101);
    const teste = mk('teste', 8102);
    try {
      await c.svc.open('p', { version: '1.5.2', taskIds: ['t-bbbb02'], docsStaffId: 'luana-1' }, true);
      c.set('t-bbbb02', 'done');
      expect((await main.claim(c.dir)).owner).toBe(true); // o principal registrou o projeto
      c.deps.owns = async () => ownsProject(c.dir);
      const before = await fs.readFile(c.file, 'utf8');
      const gitBefore = c.h.git.length;

      installOwnership(teste);
      await c.svc.sweep();
      expect(c.h.started).toEqual([]);
      expect(c.h.git).toHaveLength(gitBefore);
      expect(c.h.tests).toBe(0);
      expect(await fs.readFile(c.file, 'utf8')).toBe(before);
      // gravar o estado da versão também é do dono (a rota já recusa antes, com 423)
      await expect(c.svc.changeScope('p', { add: ['t-out003'] }, true)).rejects.toBeInstanceOf(NotOwnerError);
      expect(await fs.readFile(c.file, 'utf8')).toBe(before);

      installOwnership(main);
      await c.svc.sweep();
      expect(c.h.started).toEqual(['t-docs09']);
    } finally {
      installOwnership(null);
      main.releaseSync();
      teste.releaseSync();
    }
  });

  it('publicar: push do commit da versão para release/<versão> (sem force, sem tags) e o PR para a branch padrão; tag depois da mescla fecha a versão', async () => {
    const c = await setup({ merged: false });
    await c.svc.open('p', { version: '1.5.2', taskIds: ['t-bbbb02'] }, true);
    await expect(c.svc.publish('p', true)).rejects.toThrow(/prepare a versão/);
    c.set('t-bbbb02', 'done');
    await c.svc.prepare('p', {}, true);
    await c.svc.settled('p');
    await expect(c.svc.publish('p', false)).rejects.toMatchObject({ status: 403 });
    const v = (await c.svc.publish('p', true))!;
    const push = c.h.git.find((a) => a[0] === 'push')!;
    expect(push).toEqual(['push', '--no-verify', '--no-recurse-submodules', '--no-follow-tags', 'origin', `${'a'.repeat(40)}:refs/heads/release/1.5.2`]);
    expect(c.h.gh[0]!.slice(0, 6)).toEqual(['pr', 'create', '-R', 'github.com/dono/club', '--head=release/1.5.2', '--base=main']);
    expect(v.release!.published).toMatchObject({ branch: 'release/1.5.2', pr: 'https://github.com/dono/club/pull/99' });
    // PR ainda aberto: a tag espera.
    await expect(c.svc.tag('p', true)).rejects.toThrow(/ainda não foi mesclado/);
  });

  it('tag: no commit da mescla do PR, anotada com as tarefas, e o push dela; a versão fecha e o histórico a mostra', async () => {
    const c = await setup();
    await c.svc.open('p', { version: '1.5.2', taskIds: ['t-bbbb02'] }, true);
    c.set('t-bbbb02', 'done');
    await c.svc.prepare('p', {}, true);
    await c.svc.settled('p');
    await c.svc.publish('p', true);
    const v = (await c.svc.tag('p', true))!;
    const tag = c.h.git.find((a) => a[0] === 'tag')!;
    expect(tag).toEqual(['tag', '-a', 'v1.5.2', '9'.repeat(40), '-F', '-']);
    expect(c.h.git.find((a) => a[0] === 'fetch')).toEqual(['fetch', '--no-tags', 'origin', 'main']);
    expect(c.h.git.filter((a) => a[0] === 'push').at(-1)).toEqual(['push', '--no-verify', 'origin', 'refs/tags/v1.5.2']);
    expect(v.release).toBeNull();
    await expect(fs.access(c.file)).rejects.toThrow();
    const hist = (await c.svc.history('p'))!;
    expect(hist.entries.map((e) => e.tag)).toEqual(['v1.5.2', 'v1.5.1']);
    expect(hist.entries[0]).toMatchObject({ sha: 'c'.repeat(40), subject: 'Versão 1.5.2', summary: 'PR: x', tasks: [{ id: 't-aaaa01', title: 'A' }] });
    expect(hist.entries[1]).toMatchObject({ summary: 'notas', tasks: [] });
    expect(hist.suggested).toBe('1.5.3');
  });

  it('cancelar: a trava sai e a fila anda; arquivo estragado vira "nenhuma versão" com cópia .bad', async () => {
    const c = await setup();
    await c.svc.open('p', { version: '1.5.2', taskIds: ['t-bbbb02'] }, true);
    expect((await c.svc.cancel('p', true))!.release).toBeNull();
    expect(await c.svc.scope('p')).toBeNull();
    expect(c.h.lifted).toEqual(['p']);
    await fs.mkdir(path.dirname(c.file), { recursive: true });
    await fs.writeFile(c.file, '{ estragado');
    const fresh = new ReleaseService(c.deps);
    expect(await fresh.state('p')).toBeNull();
    await expect(fs.access(`${c.file}.bad`)).resolves.toBeUndefined();
  });

  it('projeto que não existe: 404 nas escritas, null nas leituras', async () => {
    const c = await setup();
    expect(await c.svc.view('x')).toBeNull();
    expect(await c.svc.history('x')).toBeNull();
    await expect(c.svc.open('x', { version: '1.0.0', taskIds: ['t-aaaa01'] }, true)).rejects.toBeInstanceOf(ReleaseError);
    vi.restoreAllMocks();
  });
});
