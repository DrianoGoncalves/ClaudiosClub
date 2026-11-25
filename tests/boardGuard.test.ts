import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { StateBusyError } from '../server/atomicWrite';
import {
  BoardCorruptError,
  backupTasks,
  boardIncidents,
  dismissBoardIncident,
  isBoardCorrupt,
  resetBoardGuard,
  tasksBackupDir,
  TASKS_BACKUP_EVERY_MS,
  TASKS_BACKUP_RECENT,
} from '../server/boardGuard';
import type { CodeEdit } from '../server/chat/codeEdits';
import { readTasks, TaskService } from '../server/tasks';
import { tempDirs } from './support/tmp';

// O quadro de tarefas depois de uma queda de energia (em 23/11/2026 o tasks.json voltou com 6,3 MB de zeros): a leitura recupera da cópia, a gravação nunca põe uma
// lista nova por cima do estragado, e arquivo preso não vira quadro vazio.

const tmp = tempDirs();
const realReadFile = fs.readFile.bind(fs);

beforeEach(() => resetBoardGuard());
afterEach(() => vi.restoreAllMocks());

const task = (id: string, title: string) => ({ id, title, description: '', status: 'todo', staffId: 'ana-1', sessionId: null, plan: null, branch: null, pr: null, history: [], createdAt: '2026-11-23T10:00:00.000Z', updatedAt: '2026-11-23T10:00:00.000Z' });
const text = (...titles: string[]) => JSON.stringify(titles.map((t, i) => task(`t-${i + 1}`, t)), null, 2) + '\n';

async function project(name: string) {
  const dir = await tmp(`myco-board-${name}-`);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  return { dir, file };
}
/** O que a queda deixou: o tamanho certo e só zeros. */
const zeroed = (file: string, size = 5000) => fs.writeFile(file, Buffer.alloc(size));
const settle = async (file: string) => {
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(file, old, old); // parado há 1 min: fora da janela em que o guardado não vale
};

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
  return {
    svc,
    edit: (): Promise<void> =>
      svc.onCodeEdit({ sessionId: 's-ana', projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: dir, files: [path.join(dir, 'src', 'a.ts')], request: 'Corrija o botão' } as CodeEdit),
  };
}

describe('cópias do quadro', () => {
  it('no máximo uma a cada 10 min; ficam as 6 mais novas e a última de cada dia por 7 dias', async () => {
    const p = await project('copias');
    const day = 86_400_000;
    const t0 = Date.parse('2026-11-24T12:00:00.000Z');
    expect(await backupTasks(p.dir, text('A'), t0)).toBe(true);
    expect(await backupTasks(p.dir, text('B'), t0 + TASKS_BACKUP_EVERY_MS - 1)).toBe(false); // dentro dos 10 min
    expect(await backupTasks(p.dir, text('C'), t0 + TASKS_BACKUP_EVERY_MS)).toBe(true);
    // 3 dias antes: uma por dia (2 cada), e depois 8 seguidas hoje.
    resetBoardGuard();
    for (const back of [3, 2, 1]) {
      for (const h of [0, 1]) {
        resetBoardGuard();
        await backupTasks(p.dir, text(`d${back}h${h}`), t0 - back * day + h * 3600_000);
      }
    }
    for (let i = 2; i < 10; i++) {
      resetBoardGuard();
      await backupTasks(p.dir, text(`hoje${i}`), t0 + i * TASKS_BACKUP_EVERY_MS);
    }
    const names = (await fs.readdir(tasksBackupDir(p.dir))).sort();
    const today = names.filter((n) => n.startsWith('tasks-20261124'));
    expect(today).toHaveLength(TASKS_BACKUP_RECENT); // as 6 mais novas
    for (const d of ['20261121', '20261122', '20261123']) {
      const of = names.filter((n) => n.startsWith(`tasks-${d}`));
      expect(of).toHaveLength(1); // a última do dia
      expect(of[0]).toBe(`tasks-${d}-130000.json`);
    }
  });

  it('a cópia de dia com mais de 7 dias sai', async () => {
    const p = await project('copias-velhas');
    const day = 86_400_000;
    const t0 = Date.parse('2026-11-24T12:00:00.000Z');
    await backupTasks(p.dir, text('velha'), t0 - 9 * day);
    for (let i = 0; i < TASKS_BACKUP_RECENT; i++) {
      resetBoardGuard();
      await backupTasks(p.dir, text(`nova${i}`), t0 + i * TASKS_BACKUP_EVERY_MS);
    }
    const names = await fs.readdir(tasksBackupDir(p.dir));
    expect(names.some((n) => n.startsWith('tasks-20261115'))).toBe(false);
    expect(names.filter((n) => n.startsWith('tasks-20261124'))).toHaveLength(TASKS_BACKUP_RECENT);
  });

  it('a gravação do quadro deixa uma cópia que lê como o quadro gravado', async () => {
    const p = await project('copia-gravacao');
    await service(p.dir).edit();
    const copies = async () => (await fs.readdir(tasksBackupDir(p.dir)).catch(() => [] as string[])).filter((n) => /^tasks-.*\.json$/.test(n));
    await vi.waitFor(async () => expect(await copies()).toHaveLength(1));
    const [name] = await copies();
    const copy = JSON.parse(await fs.readFile(path.join(tasksBackupDir(p.dir), name!), 'utf8')) as Array<{ id: string }>;
    const board = await readTasks(p.dir);
    expect(copy.map((t) => t.id)).toEqual(board.map((t) => t.id));
  });
});

describe('quadro zerado pela queda', () => {
  it('com cópia: a leitura põe a cópia mais nova no lugar, guarda o estragado e deixa um aviso "restaurado"', async () => {
    const p = await project('com-copia');
    await backupTasks(p.dir, text('velha'), Date.parse('2026-11-23T10:00:00.000Z'));
    resetBoardGuard();
    await backupTasks(p.dir, text('nova', 'outra'), Date.parse('2026-11-23T20:40:00.000Z'));
    await zeroed(p.file);
    const tasks = await readTasks(p.dir);
    expect(tasks.map((t) => t.title)).toEqual(['nova', 'outra']);
    expect(await fs.readFile(p.file, 'utf8')).toBe(text('nova', 'outra'));
    const kept = (await fs.readdir(path.dirname(p.file))).filter((n) => n.startsWith('tasks.json.corrompido-'));
    expect(kept).toHaveLength(1);
    expect((await fs.readFile(path.join(path.dirname(p.file), kept[0]!))).every((b) => b === 0)).toBe(true);
    expect(boardIncidents()).toMatchObject([{ kind: 'restored', from: 'tasks-20261123-204000.json', fromAt: '2026-11-23T20:40:00.000Z' }]);
  });

  it('cópia estragada também: pula para a anterior que lê', async () => {
    const p = await project('copia-ruim');
    await backupTasks(p.dir, text('boa'), Date.parse('2026-11-23T10:00:00.000Z'));
    await fs.writeFile(path.join(tasksBackupDir(p.dir), 'tasks-20261123-200000.json'), Buffer.alloc(300));
    await zeroed(p.file);
    expect((await readTasks(p.dir)).map((t) => t.title)).toEqual(['boa']);
  });

  it('sem cópia, mas o servidor já tinha lido o quadro: volta a última versão lida', async () => {
    const p = await project('memoria');
    await fs.writeFile(p.file, text('lida'));
    await settle(p.file);
    expect((await readTasks(p.dir)).map((t) => t.title)).toEqual(['lida']);
    await zeroed(p.file);
    expect((await readTasks(p.dir)).map((t) => t.title)).toEqual(['lida']);
    expect(JSON.parse(await fs.readFile(p.file, 'utf8'))[0].title).toBe('lida');
    expect(boardIncidents()).toMatchObject([{ kind: 'restored', from: 'memoria' }]);
  });

  it('sem nada para voltar: a tela vê o quadro vazio, a gravação é recusada e o arquivo fica intocado', async () => {
    const p = await project('sem-nada');
    await zeroed(p.file);
    const before = await fs.readFile(p.file);
    expect(await readTasks(p.dir)).toEqual([]);
    expect(isBoardCorrupt(p.dir)).toBe(true);
    await expect(service(p.dir).edit()).rejects.toBeInstanceOf(BoardCorruptError);
    expect((await fs.readFile(p.file)).equals(before)).toBe(true);
    // "Corrompido" não some por ignorar: só quando o arquivo volta a ler.
    const [inc] = boardIncidents();
    expect(dismissBoardIncident(inc!.id)).toBe(false);
    await fs.writeFile(p.file, text('consertado'));
    expect((await readTasks(p.dir)).map((t) => t.title)).toEqual(['consertado']);
    expect(isBoardCorrupt(p.dir)).toBe(false);
    await service(p.dir).edit(); // volta a gravar
    expect((await readTasks(p.dir)).map((t) => t.title)).toContain('consertado');
  });

  it('corrompido e sem conserto: as leituras seguintes nem abrem o arquivo, e o estragado é guardado uma vez só', async () => {
    const p = await project('nao-rele');
    await zeroed(p.file, 200_000);
    await settle(p.file);
    expect(await readTasks(p.dir)).toEqual([]);
    const spy = vi.spyOn(fs, 'readFile');
    for (let i = 0; i < 5; i++) expect(await readTasks(p.dir)).toEqual([]);
    expect(spy.mock.calls.filter(([f]) => path.resolve(String(f)) === path.resolve(p.file))).toHaveLength(0);
    vi.restoreAllMocks();
    expect((await fs.readdir(path.dirname(p.file))).filter((n) => n.startsWith('tasks.json.corrompido-'))).toHaveLength(1);
  });

  it('a cópia não pode ser gravada (disco cheio): a leitura não lança, devolve a última versão lida e marca para tentar de novo', async () => {
    const p = await project('restaurar-falha');
    await fs.writeFile(p.file, text('lida'));
    await settle(p.file);
    await readTasks(p.dir); // o servidor tinha lido esta versão
    await backupTasks(p.dir, text('copia'));
    await zeroed(p.file);
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === 'tasks.json') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return realRename(from, to);
    });
    const tasks = await readTasks(p.dir);
    expect(tasks.map((t) => t.title)).toEqual(['lida']);
    const [inc] = boardIncidents();
    expect(inc).toMatchObject({ kind: 'corrupt' });
    expect(inc!.retryAt).toBeGreaterThan(Date.now());
    vi.restoreAllMocks();
    expect((await fs.readFile(p.file)).every((b) => b === 0)).toBe(true); // ninguém gravou por cima
  });

  it('o quadro estragado apagado para recomeçar: o aviso de "corrompido" sai e o quadro volta a gravar do zero', async () => {
    const p = await project('apagado');
    await zeroed(p.file);
    await readTasks(p.dir);
    expect(isBoardCorrupt(p.dir)).toBe(true);
    await fs.rm(p.file);
    expect(await readTasks(p.dir)).toEqual([]);
    expect(isBoardCorrupt(p.dir)).toBe(false);
    await service(p.dir).edit();
    expect(await readTasks(p.dir)).toHaveLength(1);
  });

  it('o aviso "restaurado" sai quando o dono ignora', async () => {
    const p = await project('ignorar');
    await backupTasks(p.dir, text('x'));
    await zeroed(p.file);
    await readTasks(p.dir);
    const [inc] = boardIncidents();
    expect(dismissBoardIncident(inc!.id)).toBe(true);
    expect(boardIncidents()).toEqual([]);
  });
});

describe('writeAtomic e a queda de energia', () => {
  it('os dados vão para o disco (sync) antes da troca do arquivo', async () => {
    process.env.MYCO_FSYNC = '1'; // nos testes o sync fica desligado; aqui, ligado
    try {
      const dir = await tmp('myco-fsync-');
      const order: string[] = [];
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
        const fh = await realOpen(...args);
        const sync = fh.sync.bind(fh);
        fh.sync = async () => {
          order.push('sync');
          return sync();
        };
        return fh;
      }) as typeof fs.open);
      const realRename = fs.rename.bind(fs);
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        order.push('rename');
        return realRename(from, to);
      });
      const { writeAtomic } = await import('../server/atomicWrite');
      await writeAtomic(path.join(dir, 'tasks.json'), '[]\n');
      expect(order).toEqual(['sync', 'rename']);
      expect(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8')).toBe('[]\n');
    } finally {
      delete process.env.MYCO_FSYNC;
    }
  });
});

describe('quadro preso por outro processo na hora de gravar', () => {
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
  const holdRead = (file: string, until: () => boolean) =>
    vi.spyOn(fs, 'readFile').mockImplementation((async (f: unknown, ...rest: unknown[]) => {
      if (path.resolve(String(f)) === path.resolve(file) && until()) throw busy();
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(f, ...rest);
    }) as typeof fs.readFile);

  it('preso por um instante: espera, lê o quadro de verdade e grava por cima dele (nada se perde)', async () => {
    const p = await project('preso-instante');
    await fs.writeFile(p.file, text('existente'));
    let reads = 0;
    holdRead(p.file, () => ++reads <= 2);
    await service(p.dir).edit();
    vi.restoreAllMocks();
    const titles = (await readTasks(p.dir)).map((t) => t.title);
    expect(titles).toContain('existente');
    expect(titles.length).toBe(2);
  });

  it('preso de vez: StateBusyError (503) e o quadro fica como estava, em vez de virar uma lista quase vazia', async () => {
    const p = await project('preso-vez');
    await fs.writeFile(p.file, text('a', 'b', 'c'));
    const before = await fs.readFile(p.file, 'utf8');
    holdRead(p.file, () => true);
    await expect(service(p.dir).edit()).rejects.toBeInstanceOf(StateBusyError);
    vi.restoreAllMocks();
    expect(await fs.readFile(p.file, 'utf8')).toBe(before);
  });
});
