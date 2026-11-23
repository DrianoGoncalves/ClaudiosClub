import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveCaller, SessionTokens } from '../server/callers';
import { commitTaskFiles, EXTRA_MAX } from '../server/autoCommit';
import { writeOwnerFile } from '../server/ownerEdits';
import { changedSince, readSnapshots, SNAPSHOT_MAX, takeSnapshot } from '../server/slotSnapshot';
import { TaskService } from '../server/tasks';
import type { Engine, StaffProfile } from '../shared/model';
import { tempDirs } from './support/tmp';

// t-80893a: com a vaga de escrita (`singleWriter`), o commit automático leva, além de `Task.changedFiles`, tudo o que mudou no projeto desde que o card ocupou a vaga (edição por shell ou script que o
// Club não vê). A foto do que já estava sujo é tirada ao ocupar a vaga e guardada em `.myco/write-slot.json`; o que estava sujo e não mudou fica de fora. Repositório git de verdade, nos dois motores.

// Dezenas de chamadas ao git por teste: sob carga passam dos 5 s padrão.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const tmp = tempDirs();
let root: string;
beforeAll(async () => {
  root = await tmp('myco-slotsnap-');
});

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
/** `git status` sem a pasta do Club (tasks.json e afins ficam sem rastreio em todo teste). */
const dirty = (dir: string) => git(dir, 'status', '--porcelain', '--', '.', ':(exclude).myco').split(/\r?\n/).filter(Boolean).sort();
const filesOf = (dir: string, rev = 'HEAD') => git(dir, 'show', '--name-only', '--format=', rev).split(/\r?\n/).filter(Boolean).sort();
const write = async (dir: string, rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
};
const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], engine: 'claude', ...extra }) as StaffProfile;
const PLAN = 'Plano: 1) mexer em a.ts; 2) teste novo; riscos: nenhum.';
const until = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 30_000, interval: 25 });
const snapFile = (dir: string) => path.join(dir, '.myco', 'write-slot.json');

/** Repositório com a.ts, b.ts, c.ts e pre.ts commitados. Ana, Rui e Bia escrevem no checkout principal; `wt-1` tem worktree própria. */
async function club(dirName: string, opts: { engines?: Record<string, Engine>; writer?: boolean; commit?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const f of ['a.ts', 'b.ts', 'c.ts', 'pre.ts']) await write(dir, f, `export const v = 1; // ${f}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const engineOf = (id: string): Engine => opts.engines?.[id] ?? 'claude';
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Gio', { role: 'Orquestrador', engine: engineOf('gio-1') }),
    'ana-1': profile('ana-1', 'Ana', { engine: engineOf('ana-1'), reportsTo: ['gio-1'] }),
    'rui-1': profile('rui-1', 'Rui', { engine: engineOf('rui-1'), reportsTo: ['gio-1'] }),
    'bia-1': profile('bia-1', 'Bia', { engine: engineOf('bia-1'), reportsTo: ['gio-1'] }),
    'wt-1': profile('wt-1', 'Wil', { engine: engineOf('wt-1'), worktree: true, reportsTo: ['gio-1'] }),
  };
  const h = { n: 0, texts: {} as Record<string, string>, delivered: [] as Array<{ sessionId: string; text: string }> };
  const service = () =>
    new TaskService({
      projectPath: async (id) => (id === 'p' ? dir : null),
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId) => `${staffId}-${++h.n}`,
      branchFor: async () => null,
      isWorking: () => false,
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
  if (opts.writer !== false) await svc.setBoardWriter('p', { singleWriter: true }, true);
  if (opts.commit !== false) await svc.setBoardCommit('p', { autoCommit: true }, true);
  const get = async (id: string, s: TaskService = svc) => ((await s.list('p'))!).find((t) => t.id === id)!;
  const tokens = new SessionTokens();
  const as = (staffId: string, session: string) => {
    const r = resolveCaller(false, tokens.issue({ staffId, projectId: 'p', sessionId: session, engine: engineOf(staffId) }), tokens);
    return r.ok ? r.caller : null;
  };
  const begin = async (staffId: string, title: string, extra: Record<string, unknown> = {}) => {
    const id = (await svc.create('p', { title, description: 'Faça.', staffId, reviewerId: null, ...extra }, 'gio-1', 'gio-s'))!.id;
    await svc.start('p', id);
    return { id, work: (await get(id)).sessionId ?? null };
  };
  /** O Club vê a edição do arquivo (as ferramentas de edição, nos dois motores): entra em `changedFiles`. */
  const edit = (work: string, staffId: string, ...files: string[]) =>
    svc.onCodeEdit({ sessionId: work, projectId: 'p', staffId, engine: engineOf(staffId), cwd: dir, files: files.map((f) => path.join(dir, f)), request: null });
  const finish = async (id: string, s: TaskService = svc) => {
    await s.update('p', id, { status: 'done' });
    await s.commitsSettled();
    return get(id, s);
  };
  /** Muda campos do card no tasks.json, sem passar pelo serviço (põe o card onde o teste precisa). */
  const patch = async (id: string, fields: Record<string, unknown>) => {
    const file = path.join(dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    Object.assign(all.find((x) => x.id === id)!, fields);
    await fs.writeFile(file, JSON.stringify(all));
  };
  return { dir, svc, service, get, as, begin, edit, finish, patch, h };
}

const COMBOS: Engine[] = ['claude', 'codex'];

describe.each(COMBOS)('o que entra no commit com a vaga (motor %s)', (engine) => {
  const engines = { 'ana-1': engine };

  it('o que o card mudou por script, fora de changedFiles, entra no commit automático', async () => {
    const b = await club(`script-${engine}`, { engines });
    const ana = await b.begin('ana-1', 'Troca por script');
    // A foto foi tirada ao ocupar a vaga: repositório limpo, nada sujo (o `.myco/` do Club não conta).
    expect((await readSnapshots(b.dir))[ana.id]).toMatchObject({ files: {} });
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    await b.edit(ana.work!, 'ana-1', 'a.ts'); // o único que o Club viu
    await write(b.dir, 'b.ts', 'export const v = 22;\n'); // por script: rastreado, alterado
    await write(b.dir, 'tests/t1.test.ts', 'it("a", () => {});\n'); // por script: novos, em pasta nova
    await write(b.dir, 'tests/t2.test.ts', 'it("b", () => {});\n');
    expect((await b.get(ana.id)).changedFiles).toEqual(['a.ts']);
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['a.ts', 'b.ts', 'tests/t1.test.ts', 'tests/t2.test.ts'], left: [], extra: 3, alert: false });
    expect(t.commit!.note).toContain('3 arquivos por fora da lista da tarefa');
    expect(t.history.at(-1)!.note).toContain('3 arquivos por fora da lista da tarefa');
    expect(filesOf(b.dir)).toEqual(['a.ts', 'b.ts', 'tests/t1.test.ts', 'tests/t2.test.ts']);
    expect(dirty(b.dir)).toEqual([]);
    // A foto serviu a esta entrega: não sobra para a próxima (o arquivo some quando não há mais nenhuma).
    await expect(fs.stat(snapFile(b.dir))).rejects.toThrow();
  });

  it('sem nada por fora, a foto vale e o commit diz 0 (extra: 0); só a lista da tarefa entra', async () => {
    const b = await club(`so-lista-${engine}`, { engines });
    const ana = await b.begin('ana-1', 'Só pelo editor');
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    await b.edit(ana.work!, 'ana-1', 'a.ts');
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['a.ts'], extra: 0, note: null });
  });

  it('o arquivo sujo antes da vaga e não alterado fica de fora; o alterado durante a vaga entra', async () => {
    const b = await club(`antes-${engine}`, { engines });
    await write(b.dir, 'b.ts', 'export const v = "do dono";\n'); // rastreado, sujo antes da vaga
    await write(b.dir, 'c.ts', 'export const v = "do dono, antes";\n'); // sujo antes, e a tarefa mexe de novo
    await write(b.dir, 'antes.ts', 'export const antes = 1;\n'); // novo, sujo antes
    const ana = await b.begin('ana-1', 'Chega com o projeto sujo');
    const snap = (await readSnapshots(b.dir))[ana.id]!;
    expect(Object.keys(snap.files!).sort()).toEqual(['antes.ts', 'b.ts', 'c.ts']);
    await write(b.dir, 'c.ts', 'export const v = "da tarefa";\n');
    await write(b.dir, 'novo.ts', 'export const novo = 1;\n');
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['c.ts', 'novo.ts'], extra: 2 });
    expect(dirty(b.dir)).toEqual([' M b.ts', '?? antes.ts']);
  });

  it('o arquivo sujo antes que a tarefa desfez (voltou ao HEAD) não gera commit nem erro', async () => {
    const b = await club(`desfeito-${engine}`, { engines });
    await write(b.dir, 'b.ts', 'export const v = "sujo";\n');
    const ana = await b.begin('ana-1', 'Desfaz');
    await write(b.dir, 'b.ts', 'export const v = 1; // b.ts\n'); // igual ao HEAD de novo
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    await b.edit(ana.work!, 'ana-1', 'a.ts');
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['a.ts'], extra: 0 });
    expect(dirty(b.dir)).toEqual([]);
  });

  it('segredo novo criado durante a vaga NÃO entra no commit: fica de fora como barrado, com aviso', async () => {
    const b = await club(`segredo-${engine}`, { engines });
    const ana = await b.begin('ana-1', 'Gera chaves por script');
    await write(b.dir, 'secrets/prod.key', '-----BEGIN PRIVATE KEY-----\nxxx\n');
    await write(b.dir, '.env.local', 'TOKEN=abc\n');
    await write(b.dir, 'ok.ts', 'export const ok = 1;\n');
    const t = await b.finish(ana.id);
    expect(filesOf(b.dir)).toEqual(['ok.ts']);
    expect(git(b.dir, 'ls-files').split(/\r?\n/)).not.toContain('secrets/prod.key');
    expect(t.commit).toMatchObject({ status: 'partial', files: ['ok.ts'], extra: 1, alert: true });
    expect([...t.commit!.left].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: '.env.local', why: 'blocked' },
      { path: 'secrets/prod.key', why: 'blocked' },
    ]);
    expect(dirty(b.dir)).toEqual(['?? .env.local', '?? secrets/']);
  });

  it('as outras exclusões seguem: conflito, staged (qualquer staged no que veio da foto), editado pelo dono no editor do Club', async () => {
    const b = await club(`exclusoes-${engine}`, { engines });
    const ana = await b.begin('ana-1', 'Mexe em tudo');
    // Conflito sem MERGE_HEAD (stash pop), criado durante a vaga.
    await write(b.dir, 'c.ts', 'export const v = "Y";\n');
    git(b.dir, 'stash');
    await write(b.dir, 'c.ts', 'export const v = "Z";\n');
    git(b.dir, 'commit', '-qam', 'z');
    expect(() => git(b.dir, 'stash', 'pop')).toThrow();
    // Staged por você: só stage (novo), e staged com mudança nova por cima (MM).
    await write(b.dir, 'staged.ts', 'export const s = 1;\n');
    git(b.dir, 'add', 'staged.ts');
    await write(b.dir, 'b.ts', 'export const v = 2;\n');
    git(b.dir, 'add', 'b.ts');
    await write(b.dir, 'b.ts', 'export const v = 3;\n');
    // Gravado por você no editor do Club depois da última mão da tarefa.
    await write(b.dir, 'pre.ts', 'export const v = "tarefa";\n');
    await new Promise((r) => setTimeout(r, 30));
    const st = await fs.stat(path.join(b.dir, 'pre.ts'));
    await writeOwnerFile(b.dir, { path: 'pre.ts', content: 'export const v = "dono";\n', baseMtimeMs: st.mtimeMs });
    // E o que entra: um arquivo novo por script, e o que o Club viu mesmo staged (só stage, sem mudança por cima: a regra de sempre).
    await write(b.dir, 'ok.ts', 'export const ok = 1;\n');
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    git(b.dir, 'add', 'a.ts');
    await b.edit(ana.work!, 'ana-1', 'a.ts');
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ status: 'partial', files: ['a.ts', 'ok.ts'], extra: 1, alert: true });
    expect([...t.commit!.left].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'b.ts', why: 'staged' },
      { path: 'c.ts', why: 'conflict' },
      { path: 'pre.ts', why: 'owner' },
      { path: 'staged.ts', why: 'staged' },
    ]);
    expect(dirty(b.dir)).toEqual(['MM b.ts', ' M pre.ts', 'A  staged.ts', 'UU c.ts'].sort());
  });

  it('o que estava em `.myco/` e o que o .gitignore cobre não entram', async () => {
    const b = await club(`ignorados-${engine}`, { engines });
    await write(b.dir, '.gitignore', 'build/\n');
    git(b.dir, 'add', '.gitignore');
    git(b.dir, 'commit', '-qm', 'ignore');
    const ana = await b.begin('ana-1', 'Gera build');
    await write(b.dir, 'build/out.js', 'x\n');
    await write(b.dir, '.myco/staff/memoria.md', 'nota\n');
    await write(b.dir, 'ok.ts', 'export const ok = 1;\n');
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['ok.ts'], extra: 1 });
  });

  it('plano aprovado com a vaga livre: a foto é tirada na aprovação (o que foi feito antes dela fica de fora)', async () => {
    const b = await club(`plano-${engine}`, { engines });
    const rui = await b.begin('ana-1', 'Com plano', { planFirst: true });
    h_text(b, rui.work!, PLAN);
    await b.svc.onTurnDone(rui.work!);
    expect((await b.get(rui.id)).status).toBe('planning');
    expect((await readSnapshots(b.dir))[rui.id]).toBeUndefined(); // planejando não ocupa a vaga: sem foto
    await write(b.dir, 'durante-o-plano.ts', 'export const p = 1;\n'); // sujo antes de aprovar: é de antes da vaga
    const out = await b.svc.decidePlan('p', rui.id, b.as('gio-1', 'gio-s'), false, { decision: 'approve' });
    expect(out).toMatchObject({ status: 'doing' });
    expect(Object.keys((await readSnapshots(b.dir))[rui.id]!.files!)).toEqual(['durante-o-plano.ts']);
    await write(b.dir, 'implementado.ts', 'export const i = 1;\n');
    const t = await b.finish(rui.id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['implementado.ts'], extra: 1 });
    expect(dirty(b.dir)).toEqual(['?? durante-o-plano.ts']);
  });
});

/** O texto que a conversa de trabalho deixou no fim do turno (o plano). */
function h_text(b: Awaited<ReturnType<typeof club>>, work: string, text: string): void {
  b.h.texts[work] = text;
}

describe('sem a vaga, ou card que não a ocupou: o commit de sempre', () => {
  it('sem singleWriter: só `changedFiles` entra, `extra` não existe e nada é gravado em .myco/write-slot.json', async () => {
    const b = await club('sem-vaga', { writer: false });
    const ana = await b.begin('ana-1', 'Sem vaga');
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    await b.edit(ana.work!, 'ana-1', 'a.ts');
    await write(b.dir, 'por-script.ts', 'export const s = 1;\n');
    await expect(fs.stat(snapFile(b.dir))).rejects.toThrow();
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['a.ts'], note: null });
    expect(t.commit).not.toHaveProperty('extra');
    expect(dirty(b.dir)).toEqual(['?? por-script.ts']);
  });

  it('desligar a vaga no meio apaga as fotos: o commit volta a só `changedFiles`', async () => {
    const b = await club('desliga');
    const ana = await b.begin('ana-1', 'Vaga desligada no meio');
    expect((await readSnapshots(b.dir))[ana.id]).toBeTruthy();
    await b.svc.setBoardWriter('p', { singleWriter: false }, true);
    await expect(fs.stat(snapFile(b.dir))).rejects.toThrow();
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    await b.edit(ana.work!, 'ana-1', 'a.ts');
    await write(b.dir, 'por-script.ts', 'export const s = 1;\n');
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ files: ['a.ts'] });
    expect(t.commit).not.toHaveProperty('extra');
  });

  it('worktree própria não tira foto', async () => {
    const b = await club('worktree');
    const wil = await b.begin('wt-1', 'Na cópia dele');
    expect(wil.work).toBeTruthy();
    await expect(fs.stat(snapFile(b.dir))).rejects.toThrow();
  });

  it('quem espera a vaga na fila não tem foto; ao começar, a tem', async () => {
    const b = await club('espera');
    const ana = await b.begin('ana-1', 'Dona');
    const rui = await b.begin('rui-1', 'Espera');
    expect(rui.work).toBeNull();
    expect(Object.keys(await readSnapshots(b.dir))).toEqual([ana.id]);
    await b.finish(ana.id);
    await until(async () => expect((await b.get(rui.id)).sessionId).toBeTruthy());
    await until(async () => expect(Object.keys(await readSnapshots(b.dir))).toEqual([rui.id]));
  });

  it('o "Começar" do dono por cima da vaga: o card dele não tem foto, e a do dono da vaga sai (há dois escritores)', async () => {
    const b = await club('por-cima');
    const ana = await b.begin('ana-1', 'Dona da vaga');
    const bia = (await b.svc.create('p', { title: 'Por mim', description: 'Faça.', staffId: 'bia-1', reviewerId: null }, 'gio-1', 'gio-s'))!.id;
    expect(Object.keys(await readSnapshots(b.dir))).toEqual([ana.id]);
    await b.svc.start('p', bia, false, { byOwner: true });
    expect((await b.get(bia)).status).toBe('doing');
    await expect(fs.stat(snapFile(b.dir))).rejects.toThrow();
    // A mudança dos dois ficou misturada: o commit da dona volta a só o que o Club viu dela.
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    await b.edit(ana.work!, 'ana-1', 'a.ts');
    await write(b.dir, 'da-bia.ts', 'export const b = 1;\n');
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ files: ['a.ts'] });
    expect(t.commit).not.toHaveProperty('extra');
    expect(dirty(b.dir)).toEqual(['?? da-bia.ts']);
  });
});

describe('a foto sobrevive e é reaproveitada', () => {
  it('reinício do servidor no meio da vaga: um serviço novo, sobre o mesmo projeto, ainda tem a foto e commita o que veio por fora', async () => {
    const b = await club('reinicio');
    await write(b.dir, 'b.ts', 'export const v = "do dono";\n');
    const ana = await b.begin('ana-1', 'Atravessa o reinício');
    const at = (await readSnapshots(b.dir))[ana.id]!.at;
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    await b.edit(ana.work!, 'ana-1', 'a.ts');
    await write(b.dir, 'por-script.ts', 'export const s = 1;\n');
    const novo = b.service(); // o processo reiniciou: nada em memória
    expect((await readSnapshots(b.dir))[ana.id]!.at).toBe(at);
    const t = await b.finish(ana.id, novo);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['a.ts', 'por-script.ts'], extra: 1 });
    expect(dirty(b.dir)).toEqual([' M b.ts']); // o sujo de antes da vaga segue de fora
  });

  it('o card que volta à fila e retoma, sem outro escritor no meio, reaproveita a foto (o que ele fez por script antes da volta entra)', async () => {
    const b = await club('reaproveita');
    const ana = await b.begin('ana-1', 'Vai e volta');
    const at = (await readSnapshots(b.dir))[ana.id]!.at;
    await write(b.dir, 'antes-da-volta.ts', 'export const x = 1;\n');
    // De volta a "a fazer", na fila: a vez dele retoma a mesma conversa.
    await b.patch(ana.id, { status: 'todo', queuedAt: new Date().toISOString() });
    await b.svc.kickStaff('p', 'ana-1');
    await until(async () => expect((await b.get(ana.id)).status).toBe('doing'));
    expect((await readSnapshots(b.dir))[ana.id]!.at).toBe(at);
    const t = await b.finish(ana.id);
    expect(t.commit).toMatchObject({ files: ['antes-da-volta.ts'], extra: 1 });
  });

  it('se outro card ocupou a vaga depois, a foto velha sai e o retorno tira uma nova', async () => {
    const b = await club('nao-reaproveita');
    const ana = await b.begin('ana-1', 'Vai');
    const at = (await readSnapshots(b.dir))[ana.id]!.at;
    await write(b.dir, 'dela.ts', 'export const x = 1;\n');
    await b.patch(ana.id, { status: 'todo', queuedAt: new Date().toISOString(), sessionId: ana.work });
    const rui = await b.begin('rui-1', 'Ocupa a vaga');
    expect(rui.work).toBeTruthy();
    // Quem ocupa a vaga apaga as fotos dos que não a seguram mais: o checkout teve outro escritor depois da dela (a conferência roda logo depois da partida, fora do pedido dela).
    await until(async () => expect(Object.keys(await readSnapshots(b.dir))).toEqual([rui.id]));
    await b.finish(rui.id);
    await b.svc.kickStaff('p', 'ana-1');
    await until(async () => expect((await b.get(ana.id)).status).toBe('doing'));
    const again = (await readSnapshots(b.dir))[ana.id]!;
    expect(again.at).not.toBe(at);
    expect(Object.keys(again.files!)).toEqual(['dela.ts']); // do ponto de vista da nova foto, é de antes
  });
});

describe('limites', () => {
  /** Um `git` de mentira: `status` devolve `n` arquivos novos; o resto responde como se o projeto fosse a raiz do repositório. */
  const fakeGit = (n: number) => async (_cwd: string, args: string[]) => (args[0] === 'status' ? Array.from({ length: n }, (_, i) => `?? f${i}.ts\0`).join('') : '\n');

  it('foto com sujeira demais não guarda arquivos (cap): o commit segue só com `changedFiles` e a nota diz', async () => {
    const dir = path.join(root, 'cap');
    await fs.mkdir(dir, { recursive: true });
    const snap = await takeSnapshot(dir, fakeGit(SNAPSHOT_MAX + 1));
    expect(snap).toMatchObject({ files: null, why: 'cap' });
    expect(await changedSince(dir, snap, fakeGit(3))).toEqual({ skipped: 'cap' });
    // Dentro do teto, vale.
    expect((await takeSnapshot(dir, fakeGit(SNAPSHOT_MAX))).files).not.toBeNull();
  });

  it('git que falha ou estoura o prazo: a foto vira `git`, sem lançar', async () => {
    const dir = path.join(root, 'git-falha');
    await fs.mkdir(dir, { recursive: true });
    const snap = await takeSnapshot(dir, async () => {
      throw new Error('fatal: not a git repository');
    });
    expect(snap).toMatchObject({ files: null, why: 'git' });
    expect(await changedSince(dir, { at: 'x', files: {} }, async () => Promise.reject(new Error('timeout')))).toEqual({ skipped: 'git' });
  });

  it('mais de EXTRA_MAX arquivos por fora: nenhum entra (limit), só a lista da tarefa, e vira aviso', async () => {
    const dir = path.join(root, 'limite');
    await fs.mkdir(dir, { recursive: true });
    expect(await changedSince(dir, { at: 'x', files: {} }, fakeGit(EXTRA_MAX + 1))).toEqual({ skipped: 'limit', found: EXTRA_MAX + 1 });
    expect(await changedSince(dir, { at: 'x', files: {} }, fakeGit(EXTRA_MAX))).toMatchObject({ extra: expect.any(Array) });
    // No commit: só `changedFiles` entra, com alerta e o número na nota.
    const b = await club('limite-commit', { writer: false });
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    await write(b.dir, 'por-script.ts', 'x\n');
    const out = await commitTaskFiles({ dir: b.dir, taskId: 't-000001', title: 'Muito', files: ['a.ts'], shared: new Map(), ownerWrites: {}, slot: { skipped: 'limit', found: 1500 } });
    expect(out).toMatchObject({ status: 'committed', files: ['a.ts'], alert: true });
    expect(out.note).toContain(`1500 arquivos mudaram desde que a tarefa ocupou a vaga (limite ${EXTRA_MAX})`);
    expect(out).not.toHaveProperty('extra');
    expect(dirty(b.dir)).toEqual(['?? por-script.ts']);
  });

  it('foto que não valeu (cap, git): a nota diz, sem alerta, e a tarefa sem lista também não vira "nada a fazer" mudo', async () => {
    const b = await club('nota-cap', { writer: false });
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    const ok = await commitTaskFiles({ dir: b.dir, taskId: 't-000002', title: 'Cap', files: ['a.ts'], shared: new Map(), ownerWrites: {}, slot: { skipped: 'cap' } });
    expect(ok).toMatchObject({ status: 'committed', alert: false });
    expect(ok.note).toContain('a foto da vaga não coube');
    const none = await commitTaskFiles({ dir: b.dir, taskId: 't-000003', title: 'Sem lista', files: undefined, shared: new Map(), ownerWrites: {}, slot: { skipped: 'git' } });
    expect(none).toMatchObject({ status: 'none', alert: false });
    expect(none.note).toContain('a tarefa não tem lista de arquivos');
    expect(none.note).toContain('a foto da vaga não pôde ser conferida (git)');
  });

  it('lista de changedFiles no teto (cortada) não barra o commit quando a foto vale: ela olha o projeto todo', async () => {
    const b = await club('lista-cortada', { writer: false });
    await write(b.dir, 'a.ts', 'export const v = 2;\n');
    const files = Array.from({ length: 300 }, (_, i) => `nao-existe-${i}.ts`);
    const cut = await commitTaskFiles({ dir: b.dir, taskId: 't-000004', title: 'Cortada', files: ['a.ts', ...files], shared: new Map(), ownerWrites: {} });
    expect(cut).toMatchObject({ status: 'none', alert: true }); // sem foto: o comportamento de sempre
    const ok = await commitTaskFiles({ dir: b.dir, taskId: 't-000005', title: 'Cortada', files: ['a.ts', ...files], shared: new Map(), ownerWrites: {}, slot: { extra: [] } });
    expect(ok).toMatchObject({ status: 'committed', files: ['a.ts'], extra: 0 });
  });

  it('arquivo grande: comparado por tamanho e mtime (sem ler o conteúdo); mudou, entra; igual, não', async () => {
    const b = await club('grande', { writer: false });
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    await fs.writeFile(path.join(b.dir, 'grande.bin'), big);
    await fs.writeFile(path.join(b.dir, 'pequeno.ts'), 'a\n');
    const snap = await takeSnapshot(b.dir);
    expect(snap.files!['grande.bin']).toMatch(/^s:\d+:\d+$/); // assinatura, não hash
    expect(snap.files!['pequeno.ts']).toMatch(/^h:[0-9a-f]{40}$/);
    expect(await changedSince(b.dir, snap)).toEqual({ extra: [] });
    await new Promise((r) => setTimeout(r, 30));
    await fs.writeFile(path.join(b.dir, 'grande.bin'), Buffer.alloc(9 * 1024 * 1024, 2));
    await fs.writeFile(path.join(b.dir, 'pequeno.ts'), 'b\n');
    expect(await changedSince(b.dir, snap)).toEqual({ extra: ['grande.bin', 'pequeno.ts'] });
  });

  it('arquivo apagado antes e depois da foto: marcado como apagado; o que a tarefa apagou entra como exclusão no commit', async () => {
    const b = await club('apagado', { writer: false });
    await fs.rm(path.join(b.dir, 'b.ts')); // apagado antes da vaga
    const snap = await takeSnapshot(b.dir);
    expect(snap.files).toEqual({ 'b.ts': '-' });
    await fs.rm(path.join(b.dir, 'c.ts')); // apagado pela tarefa
    const found = await changedSince(b.dir, snap);
    expect(found).toEqual({ extra: ['c.ts'] });
    const out = await commitTaskFiles({ dir: b.dir, taskId: 't-000006', title: 'Apaga', files: undefined, shared: new Map(), ownerWrites: {}, slot: found });
    expect(out).toMatchObject({ status: 'committed', files: ['c.ts'], extra: 1 });
    expect(dirty(b.dir)).toEqual([' D b.ts']);
  });

  it('o arquivo da foto é tolerante: ausente, torto ou com hash que não é texto vale vazio', async () => {
    const dir = path.join(root, 'torto');
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    expect(await readSnapshots(dir)).toEqual({});
    await fs.writeFile(snapFile(dir), '{ não é json');
    expect(await readSnapshots(dir)).toEqual({});
    await fs.writeFile(snapFile(dir), JSON.stringify({ 't-1': { at: 'x', files: { 'a.ts': 3 } }, 't-2': { at: 'y', files: null, why: 'git' }, 't-3': { at: 'z', files: { 'a.ts': 'h:1' } }, 't-4': 5 }));
    expect(await readSnapshots(dir)).toEqual({ 't-2': { at: 'y', files: null, why: 'git' }, 't-3': { at: 'z', files: { 'a.ts': 'h:1' } } });
  });
});

describe('o projeto é uma subpasta do repositório', () => {
  it('a foto e o commit usam os caminhos do projeto; o sujo do resto do repositório não entra', async () => {
    const repo = path.join(root, 'sub');
    const dir = path.join(repo, 'proj');
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'core.autocrlf', 'false');
    await write(dir, 'a.ts', 'x\n');
    await write(repo, 'raiz.ts', 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    await write(repo, 'raiz.ts', 'sujo\n'); // fora do projeto: nunca entra
    await write(dir, 'antes.ts', 'a\n');
    const snap = await takeSnapshot(dir);
    expect(Object.keys(snap.files!)).toEqual(['antes.ts']);
    await write(dir, 'a.ts', 'y\n');
    const found = await changedSince(dir, snap);
    expect(found).toEqual({ extra: ['a.ts'] });
    const out = await commitTaskFiles({ dir, taskId: 't-000007', title: 'Sub', files: undefined, shared: new Map(), ownerWrites: {}, slot: found });
    expect(out).toMatchObject({ status: 'committed', files: ['a.ts'], extra: 1 });
    expect(filesOf(repo)).toEqual(['proj/a.ts']);
  });
});
