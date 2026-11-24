import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { BoardCorruptError, boardIncidents, resetBoardGuard, tasksBackupDir } from '../server/boardGuard';
import type { CodeEdit } from '../server/chat/codeEdits';
import { COLD_ADMIT_EVERY_MS, coldAfterMs, readActiveTasks, readTasks, readTasksStrict, resetColdState, splitCold, TaskService } from '../server/tasks';
import { tempDirs } from './support/tmp';

// O arquivo morto do quadro (`.myco/tasks-arquivo.json`, server/tasks.ts `writeBoard`): a tarefa fechada antiga sai do `tasks.json` (que é regravado inteiro a cada
// mudança, com fsync) e quem lê com `readTasks` vê os dois juntos, como antes. Reaberta, volta ao ativo. Nenhuma queda entre as gravações deixa a tarefa fora dos dois.

const tmp = tempDirs();
const HOUR = 3_600_000;

beforeEach(() => {
  resetBoardGuard();
  resetColdState();
});
afterEach(() => vi.restoreAllMocks());

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
function task(id: string, status: Task['status'], updatedAt: string, extra: Partial<Task> = {}): Task {
  return { id, title: id, description: '', status, staffId: 'ana-1', sessionId: null, plan: null, branch: null, pr: null, history: [], createdAt: updatedAt, updatedAt, ...extra } as Task;
}
const OLD = 2 * 24 * HOUR; // fechada há 2 dias: passa do limiar padrão (6 h)
const board = () => [
  task('t-aberta', 'todo', ago(3 * 24 * HOUR)), // aberta e antiga: nunca vai para o morto
  task('t-pronta-velha', 'done', ago(OLD)),
  task('t-cancelada-velha', 'cancelled', ago(OLD)),
  task('t-pronta-nova', 'done', ago(HOUR)), // fechada há 1 h: fica no ativo
];

async function project(name: string, tasks: Task[] = board()) {
  const dir = await tmp(`myco-cold-${name}-`);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const active = path.join(dir, '.myco', 'tasks.json');
  const cold = path.join(dir, '.myco', 'tasks-arquivo.json');
  await fs.writeFile(active, JSON.stringify(tasks, null, 2) + '\n');
  const ids = async (file: string) => ((JSON.parse(await fs.readFile(file, 'utf8')) as Task[]).map((t) => t.id)).sort();
  return { dir, active, cold, ids };
}

const profile = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false, servers: [], engine: 'claude' } as unknown as StaffProfile;
function service(dir: string) {
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async () => profile,
    send: async () => 's-x',
    branchFor: async () => 'main',
    lastText: () => null,
    sendTo: async (_p, sessionId) => sessionId,
    conversationTitle: async () => null,
    interruptSession: () => undefined,
    isWorking: () => false,
  });
  let n = 0;
  return {
    svc,
    /** Uma gravação qualquer do quadro: a edição de código numa conversa direta abre (ou atualiza) um card automático. */
    edit: (): Promise<void> =>
      svc.onCodeEdit({ sessionId: 's-ana', projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: dir, files: [path.join(dir, 'src', `a${n++}.ts`)], request: 'Corrija o botão' } as CodeEdit),
  };
}
const ids = (tasks: Task[]) => tasks.map((t) => t.id).sort();

describe('limiar do arquivo morto', () => {
  it('padrão de 6 h; MYCO_COLD_AFTER_HOURS troca, e valor inválido ou zero volta ao padrão', () => {
    expect(coldAfterMs(undefined)).toBe(6 * HOUR);
    expect(coldAfterMs('24')).toBe(24 * HOUR);
    expect(coldAfterMs('0.5')).toBe(HOUR / 2);
    for (const bad of ['', ' ', '0', '-3', 'abc']) expect(coldAfterMs(bad)).toBe(6 * HOUR);
  });

  it('só fechada (pronta ou cancelada) sem mudança há mais do limiar entra; aberta antiga e fechada recente ficam', () => {
    const next = board();
    const split = splitCold(next, { active: next, cold: [] }, Date.now(), true, 6 * HOUR);
    expect(ids(split.cold)).toEqual(['t-cancelada-velha', 't-pronta-velha']);
    expect(ids(split.active)).toEqual(['t-aberta', 't-pronta-nova']);
    // Entrada fechada (no máximo uma por hora): nada entra.
    expect(splitCold(next, { active: next, cold: [] }, Date.now(), false, 6 * HOUR).cold).toEqual([]);
  });
});

describe('mover para o arquivo morto', () => {
  it('a primeira gravação migra: as fechadas antigas saem do tasks.json, e a leitura inteira segue vendo todas', async () => {
    const p = await project('migra');
    const before = ids(await readTasks(p.dir));
    await service(p.dir).edit();
    expect(await p.ids(p.cold)).toEqual(['t-cancelada-velha', 't-pronta-velha']);
    const active = await p.ids(p.active);
    expect(active).not.toContain('t-pronta-velha');
    expect(active).toEqual(expect.arrayContaining(['t-aberta', 't-pronta-nova']));
    // Nada sumiu nem repetiu: o card automático novo e as de antes.
    const all = await readTasks(p.dir);
    expect(ids(all).filter((id) => !before.includes(id))).toHaveLength(1);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    // A entrada deixa uma cópia do morto, antes de tirar as tarefas do ativo.
    const copies = await fs.readdir(tasksBackupDir(p.dir, 'tasks-arquivo'));
    expect(copies.filter((n) => /^tasks-arquivo-\d{8}-\d{6}\.json$/.test(n))).toHaveLength(1);
  });

  it('a entrada é no máximo uma por hora: a que fechou depois espera a próxima', async () => {
    const p = await project('hora');
    const s = service(p.dir);
    await s.edit();
    // Outra fechada antiga aparece (gravada por fora, como um quadro de outra versão): a gravação seguinte não a move ainda.
    const raw = JSON.parse(await fs.readFile(p.active, 'utf8')) as Task[];
    await fs.writeFile(p.active, JSON.stringify([...raw, task('t-outra', 'done', ago(OLD))], null, 2));
    await s.edit();
    expect(await p.ids(p.active)).toContain('t-outra');
    // Passada a hora, entra.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + COLD_ADMIT_EVERY_MS + 1000);
    await s.edit();
    expect(await p.ids(p.cold)).toContain('t-outra');
    expect(await p.ids(p.active)).not.toContain('t-outra');
  });

  it('gravação sem nada para mover não toca o arquivo morto', async () => {
    const p = await project('parado');
    const s = service(p.dir);
    await s.edit();
    const st = await fs.stat(p.cold);
    for (let i = 0; i < 3; i++) await s.edit();
    expect((await fs.stat(p.cold)).mtimeMs).toBe(st.mtimeMs);
  });
});

describe('leitura inteira contra só a ativa', () => {
  it('readTasks vê os dois arquivos; readActiveTasks só o ativo; a listagem da tela marca as prontas antigas como antes', async () => {
    const p = await project('leitura');
    const s = service(p.dir);
    await s.edit();
    const all = ids(await readTasks(p.dir));
    expect(all).toEqual(expect.arrayContaining(['t-aberta', 't-pronta-velha', 't-cancelada-velha', 't-pronta-nova']));
    const active = ids(await readActiveTasks(p.dir));
    expect(active).not.toContain('t-pronta-velha');
    expect(active).not.toContain('t-cancelada-velha');
    expect(active).toEqual(expect.arrayContaining(['t-aberta', 't-pronta-nova']));
    // A tela: a pronta de 2 dias aparece (não arquivada: o "arquivada" da tela é de 7 dias e não depende de onde a tarefa está no disco).
    const listed = (await s.svc.list('p'))!;
    expect(ids(listed)).toEqual(all);
    expect(listed.find((t) => t.id === 't-pronta-velha')!.archived).toBeFalsy();
    // A retenção lê o quadro inteiro (a cancelada protege a conversa dela).
    expect(ids(await readTasksStrict(p.dir))).toEqual(all);
  });

  it('a mesma tarefa nos dois arquivos (queda no meio da mudança): aparece uma vez, a do ativo', async () => {
    const p = await project('repetida', [task('t-x', 'todo', ago(HOUR), { title: 'reaberta' })]);
    await fs.writeFile(p.cold, JSON.stringify([task('t-x', 'done', ago(OLD), { title: 'velha' })], null, 2));
    const all = await readTasks(p.dir);
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('reaberta');
    expect((await readTasksStrict(p.dir)).map((t) => t.title)).toEqual(['reaberta']);
    // A gravação seguinte tira a cópia velha do morto.
    await service(p.dir).edit();
    expect(await p.ids(p.cold)).toEqual([]);
  });
});

describe('reabrir', () => {
  it('a cancelada que está no arquivo morto volta ao ativo, e sai do morto', async () => {
    const p = await project('reabre');
    const s = service(p.dir);
    await s.edit();
    expect(await p.ids(p.cold)).toContain('t-cancelada-velha');
    const out = await s.svc.reopen('p', 't-cancelada-velha');
    expect(out?.status).toBe('todo');
    expect(await p.ids(p.active)).toContain('t-cancelada-velha');
    expect(await p.ids(p.cold)).not.toContain('t-cancelada-velha');
    expect((await readTasks(p.dir)).filter((t) => t.id === 't-cancelada-velha')).toHaveLength(1);
  });

  it('a pronta do arquivo morto que volta para "a fazer" pela tela também volta ao ativo', async () => {
    const p = await project('volta');
    const s = service(p.dir);
    await s.edit();
    expect(await p.ids(p.cold)).toContain('t-pronta-velha');
    await s.svc.update('p', 't-pronta-velha', { status: 'todo' }, true);
    expect(await p.ids(p.active)).toContain('t-pronta-velha');
    expect(await p.ids(p.cold)).not.toContain('t-pronta-velha');
    // Reaberta: "a fazer", e a fila da Ana já pode tê-la começado.
    expect(['todo', 'doing']).toContain((await readTasks(p.dir)).find((t) => t.id === 't-pronta-velha')!.status);
  });

  it('apagar a tarefa do arquivo morto tira ela dos dois arquivos', async () => {
    const p = await project('apaga');
    const s = service(p.dir);
    await s.edit();
    expect(await s.svc.remove('p', 't-pronta-velha')).toBe(true);
    expect(await p.ids(p.cold)).not.toContain('t-pronta-velha');
    expect(await p.ids(p.active)).not.toContain('t-pronta-velha');
    expect((await readTasks(p.dir)).some((t) => t.id === 't-pronta-velha')).toBe(false);
  });
});

describe('queda no meio da mudança', () => {
  const realRename = fs.rename.bind(fs);
  /** O rename para `name` falha (como se o processo tivesse morrido ali): o que já foi gravado fica, o que vinha depois não entra. */
  const failRename = (name: string) =>
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === name) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      return realRename(from, to);
    });

  it('entrada: o morto foi gravado e o ativo não: a tarefa está nos dois, aparece uma vez, e a gravação falha inteira (nada mudou para quem lê)', async () => {
    const p = await project('queda-entrada');
    const before = await readTasks(p.dir);
    failRename('tasks.json');
    await expect(service(p.dir).edit()).rejects.toThrow(/EIO/);
    vi.restoreAllMocks();
    // No disco: as fechadas antigas já no morto, e ainda no ativo.
    expect(await p.ids(p.cold)).toEqual(['t-cancelada-velha', 't-pronta-velha']);
    expect(await p.ids(p.active)).toEqual(ids(before));
    // Quem lê: o quadro de antes, cada tarefa uma vez.
    expect(ids(await readTasks(p.dir))).toEqual(ids(before));
    expect(ids(await readTasksStrict(p.dir))).toEqual(ids(before));
    // A gravação seguinte termina a mudança.
    resetColdState();
    await service(p.dir).edit();
    expect(await p.ids(p.active)).not.toContain('t-pronta-velha');
    expect(await p.ids(p.cold)).toEqual(['t-cancelada-velha', 't-pronta-velha']);
    expect(new Set((await readTasks(p.dir)).map((t) => t.id)).size).toBe(before.length + 1);
  });

  it('saída: o ativo foi gravado e o morto não: a reaberta está nos dois, vale a do ativo, e a gravação não falha', async () => {
    const p = await project('queda-saida');
    const s = service(p.dir);
    await s.edit();
    failRename('tasks-arquivo.json');
    const out = await s.svc.reopen('p', 't-cancelada-velha');
    vi.restoreAllMocks();
    expect(out?.status).toBe('todo');
    expect(await p.ids(p.cold)).toContain('t-cancelada-velha'); // a cópia velha ficou
    const all = await readTasks(p.dir);
    expect(all.filter((t) => t.id === 't-cancelada-velha').map((t) => t.status)).toEqual(['todo']);
    // A gravação seguinte tira a repetida do morto.
    await s.edit();
    expect(await p.ids(p.cold)).not.toContain('t-cancelada-velha');
  });

  it('a cópia do morto não pôde ser gravada: a entrada fica para depois e as tarefas seguem no ativo', async () => {
    const p = await project('sem-copia');
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}tasks-arquivo${path.sep}`)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return realRename(from, to);
    });
    await service(p.dir).edit();
    vi.restoreAllMocks();
    expect(await p.ids(p.active)).toEqual(expect.arrayContaining(['t-pronta-velha', 't-cancelada-velha']));
    // O morto não ficou com as cópias (a limpeza depois do ativo as tirou), e o quadro aparece inteiro uma vez.
    expect(await p.ids(p.cold)).toEqual([]);
    expect(new Set((await readTasks(p.dir)).map((t) => t.id)).size).toBe(5);
  });

  it('apagar a do morto com a última gravação falhando: o erro sobe e a tarefa não volta calada; apagar de novo termina', async () => {
    const p = await project('apaga-falha');
    const s = service(p.dir);
    await s.edit();
    failRename('tasks-arquivo.json');
    await expect(s.svc.remove('p', 't-pronta-velha')).rejects.toThrow(/EIO/);
    vi.restoreAllMocks();
    // Não foi apagada (e ninguém ouviu que foi): segue no quadro.
    expect((await readTasks(p.dir)).some((t) => t.id === 't-pronta-velha')).toBe(true);
    expect(await s.svc.remove('p', 't-pronta-velha')).toBe(true);
    expect((await readTasks(p.dir)).some((t) => t.id === 't-pronta-velha')).toBe(false);
    expect(await p.ids(p.cold)).not.toContain('t-pronta-velha');
  });

  it('a reaberta só sai do morto depois de uma cópia do ativo que a tem (a cópia de 10 min atrás não a tem)', async () => {
    const p = await project('copia-ativo');
    const s = service(p.dir);
    await s.edit();
    await s.svc.reopen('p', 't-cancelada-velha');
    const dir = tasksBackupDir(p.dir, 'tasks');
    const newest = (await fs.readdir(dir)).filter((n) => /^tasks-\d{8}-\d{6}\.json$/.test(n)).sort().at(-1)!;
    const copy = JSON.parse(await fs.readFile(path.join(dir, newest), 'utf8')) as Task[];
    expect(copy.find((t) => t.id === 't-cancelada-velha')?.status).toBe('todo');
  });

  it('leitura que pega o ativo antes da saída e o morto depois dela: confere e lê de novo, e a reaberta não some', async () => {
    const p = await project('corrida');
    const s = service(p.dir);
    await s.edit();
    expect(await p.ids(p.cold)).toContain('t-cancelada-velha');
    await readTasks(p.dir); // os dois guardados: a leitura seguinte só faz o stat
    // A leitura lê o ativo (ainda sem a reaberta); no stat do morto, a reabertura inteira acontece (B grava o ativo com ela, C a tira do morto); depois a leitura segue.
    const realStat = fs.stat.bind(fs);
    let armed = true;
    vi.spyOn(fs, 'stat').mockImplementation((async (f: Parameters<typeof fs.stat>[0], ...rest: unknown[]) => {
      if (armed && path.basename(String(f)) === 'tasks-arquivo.json') {
        armed = false;
        await s.svc.reopen('p', 't-cancelada-velha');
      }
      return (realStat as (...a: unknown[]) => Promise<unknown>)(f, ...rest);
    }) as typeof fs.stat);
    const seen = await readTasks(p.dir);
    vi.restoreAllMocks();
    expect(armed).toBe(false); // a reabertura rodou no meio da leitura
    expect(seen.filter((t) => t.id === 't-cancelada-velha').map((t) => t.status)).toEqual(['todo']);
  });

  it('a retenção espera a mudança de arquivo em andamento e lê o quadro inteiro depois dela', async () => {
    const p = await project('retencao-espera');
    const s = service(p.dir);
    await s.edit();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === 'tasks-arquivo.json') {
        held();
        await gate; // C: o morto sendo regravado sem a reaberta
      }
      return realRename(from, to);
    });
    const reopening = s.svc.reopen('p', 't-cancelada-velha');
    await holding;
    let done = false;
    const strict = readTasksStrict(p.dir).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false); // esperando a mudança
    release();
    await reopening;
    vi.restoreAllMocks();
    expect((await strict).filter((t) => t.id === 't-cancelada-velha').map((t) => t.status)).toEqual(['todo']);
  });

  it('quem lê no meio da mudança vê o quadro inteiro (nunca sem a tarefa que está mudando de arquivo)', async () => {
    const p = await project('leitor');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === 'tasks-arquivo.json') {
        held();
        await gate; // o morto está sendo gravado
      }
      return realRename(from, to);
    });
    const writing = service(p.dir).edit();
    await holding;
    const seen = ids(await readTasks(p.dir));
    expect(seen).toEqual(ids(board()));
    release();
    await writing;
    vi.restoreAllMocks();
    expect(ids(await readTasks(p.dir))).toEqual(expect.arrayContaining(ids(board())));
  });
});

describe('arquivo morto estragado ou sumido', () => {
  it('estragado e sem cópia: nada aparece e nada é gravado, e o tasks.json fica intocado (sem o morto, a fila liberaria quem espera por uma cancelada dele)', async () => {
    const p = await project('estragado');
    await fs.writeFile(p.cold, Buffer.alloc(4000)); // zerado pela queda
    const activeBefore = await fs.readFile(p.active);
    // Antes de qualquer leitura inteira (como logo depois de subir): o caminho quente também não vê o ativo sozinho.
    expect(await readActiveTasks(p.dir)).toEqual([]);
    expect(await readTasks(p.dir)).toEqual([]);
    await expect(service(p.dir).edit()).rejects.toBeInstanceOf(BoardCorruptError);
    expect((await fs.readFile(p.active)).equals(activeBefore)).toBe(true);
    expect(boardIncidents()).toMatchObject([{ kind: 'corrupt', file: 'tasks-arquivo' }]);
    await expect(readTasksStrict(p.dir)).rejects.toThrow();
  });

  it('estragado com cópia: volta a cópia, e nada do ativo é tocado', async () => {
    const p = await project('volta-copia');
    const s = service(p.dir);
    await s.edit();
    const activeBefore = await fs.readFile(p.active, 'utf8');
    await fs.writeFile(p.cold, Buffer.alloc(4000));
    expect(ids(await readTasks(p.dir))).toEqual(expect.arrayContaining(['t-pronta-velha', 't-cancelada-velha']));
    expect(await p.ids(p.cold)).toEqual(['t-cancelada-velha', 't-pronta-velha']);
    expect(await fs.readFile(p.active, 'utf8')).toBe(activeBefore);
    expect(boardIncidents()).toMatchObject([{ kind: 'restored', file: 'tasks-arquivo' }]);
  });

  it('o morto que já existiu e sumiu (apagado, quarentena) volta da cópia, em vez de virar quadro sem as fechadas', async () => {
    const p = await project('sumiu');
    await service(p.dir).edit();
    resetColdState(); // como depois de reiniciar
    await fs.rm(p.cold);
    expect(ids(await readTasks(p.dir))).toEqual(expect.arrayContaining(['t-pronta-velha', 't-cancelada-velha']));
    expect(await p.ids(p.cold)).toEqual(['t-cancelada-velha', 't-pronta-velha']);
    expect(boardIncidents()).toMatchObject([{ kind: 'restored', file: 'tasks-arquivo', missing: true }]);
  });

  it('sumido e sem cópia que leia: trava o quadro, não refaz a tentativa a cada leitura, e tiradas as cópias também volta a ser quadro sem morto', async () => {
    const p = await project('sumiu-sem-copia');
    await service(p.dir).edit();
    const bdir = tasksBackupDir(p.dir, 'tasks-arquivo');
    for (const n of await fs.readdir(bdir)) await fs.writeFile(path.join(bdir, n), Buffer.alloc(100)); // as cópias também estragadas
    resetColdState();
    await fs.rm(p.cold);
    expect(await readTasks(p.dir)).toEqual([]);
    expect(boardIncidents()).toMatchObject([{ kind: 'corrupt', file: 'tasks-arquivo', missing: true }]);
    const spy = vi.spyOn(fs, 'readFile');
    for (let i = 0; i < 3; i++) expect(await readTasks(p.dir)).toEqual([]);
    expect(spy.mock.calls.filter(([f]) => String(f).startsWith(bdir))).toHaveLength(0);
    vi.restoreAllMocks();
    await fs.rm(bdir, { recursive: true });
    expect(ids(await readTasks(p.dir))).toEqual(expect.arrayContaining(['t-aberta', 't-pronta-nova']));
    expect(boardIncidents()).toEqual([]);
  });

  it('a pasta .myco apagada inteira (o morto e as cópias dele) é quadro novo, sem aviso, mesmo com o servidor no ar', async () => {
    const p = await project('recomeca');
    const s = service(p.dir);
    await s.edit();
    await fs.rm(path.join(p.dir, '.myco'), { recursive: true, force: true });
    expect(await readTasks(p.dir)).toEqual([]);
    expect(boardIncidents()).toEqual([]);
    await s.edit(); // volta a gravar do zero
    expect(await readTasks(p.dir)).toHaveLength(1);
  });

  it('a retenção não lê pela metade: morto sumido depois de existir lança', async () => {
    const p = await project('retencao');
    await service(p.dir).edit();
    resetColdState();
    await fs.rm(p.cold);
    await expect(readTasksStrict(p.dir)).rejects.toThrow(/sumiu/);
  });
});
