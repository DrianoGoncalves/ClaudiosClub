import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { renameWithRetry, StateBusyError, writeAtomic } from '../server/atomicWrite';
import type { CodeEdit } from '../server/chat/codeEdits';
import { readConfig, setRetentionDeleteEnabledAt } from '../server/config';
import { secretFile, getSecret, setSecret } from '../server/secretVault';
import { appendRun, RUNS_FILE, RUNS_ROTATE_BYTES } from '../server/taskRuns';
import { EDIT_RETRY_WAITS_MS, readTasks, TaskService } from '../server/tasks';
import { tempDirs } from './support/tmp';

// No Windows o rename do arquivo de estado falha (EPERM/EBUSY/EACCES) enquanto outro processo o segura. O relógio aqui é simulado: cada espera
// (`setTimeout`) corre na hora e soma ao `clock`, então "ocupado por 2 s" não custa 2 s de teste.

const tmp = tempDirs();
const realRename = fs.rename.bind(fs);

let clock = 0;
let waits: number[] = [];
let renames = 0;

afterEach(() => vi.restoreAllMocks());

const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** `setTimeout` instantâneo que conta o tempo que se esperaria, e `Math.random` fixo (1 = a espera cheia; 0 = metade dela). */
function simulate(jitter: 0 | 1 = 1) {
  clock = 0;
  waits = [];
  renames = 0;
  vi.spyOn(Math, 'random').mockReturnValue(jitter);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    clock += ms ?? 0;
    queueMicrotask(fn);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
}

/** O rename do `target` falha com `code` enquanto `until()` for verdadeiro; os outros passam. */
function holdRename(target: string, code: string, until: () => boolean) {
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (path.basename(String(to)) === target) {
      renames++;
      if (until()) throw busy(code);
    }
    return realRename(from, to);
  });
}

const leftovers = async (dir: string) => (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));

describe('writeAtomic: rename preso por outro processo', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`${code} por 2 s (bem mais que os 650 ms de antes) e depois libera: grava sem erro`, async () => {
      const dir = await tmp('myco-busy-ok-');
      const file = path.join(dir, 'tasks.json');
      await fs.writeFile(file, '"velho"\n');
      simulate();
      holdRename('tasks.json', code, () => clock < 2000);
      await expect(writeAtomic(file, '"novo"\n')).resolves.toBeUndefined();
      expect(await fs.readFile(file, 'utf8')).toBe('"novo"\n');
      expect(await leftovers(dir)).toEqual([]);
      expect(clock).toBeGreaterThan(650);
      expect(clock).toBeGreaterThanOrEqual(2000);
    });
  }

  it('espera em backoff exponencial com teto por espera (25, 50, 100… até 1000 ms)', async () => {
    const dir = await tmp('myco-busy-curve-');
    simulate();
    holdRename('a.json', 'EPERM', () => renames < 10);
    await writeAtomic(path.join(dir, 'a.json'), '1');
    expect(waits).toEqual([25, 50, 100, 200, 400, 800, 1000, 1000, 1000]);
  });

  it('jitter: com o menor sorteio a espera é a metade', async () => {
    const dir = await tmp('myco-busy-jitter-');
    simulate(0);
    holdRename('a.json', 'EPERM', () => renames < 4);
    await writeAtomic(path.join(dir, 'a.json'), '1');
    expect(waits).toEqual([12.5, 25, 50]);
  });

  it('falha persistente: StateBusyError com mensagem clara, causa original, 12 tentativas, de ~3,3 a ~6,6 s, sem .tmp e sem tocar no arquivo', async () => {
    const dir = await tmp('myco-busy-persist-');
    const file = path.join(dir, 'tasks.json');
    await fs.writeFile(file, '"velho"\n');
    simulate(1);
    holdRename('tasks.json', 'EBUSY', () => true);
    const err = await writeAtomic(file, '"novo"\n').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StateBusyError);
    expect((err as StateBusyError).message).toBe('arquivo ocupado, tente de novo');
    expect((err as StateBusyError).message).not.toContain(dir); // o caminho fica no log, não na resposta
    expect((err as StateBusyError).file).toBe(file);
    expect(((err as StateBusyError).cause as NodeJS.ErrnoException).code).toBe('EBUSY');
    expect(renames).toBe(12);
    expect(clock).toBe(6575); // 25+50+100+200+400+800 e mais 5 esperas no teto de 1000
    simulate(0);
    holdRename('tasks.json', 'EBUSY', () => true);
    await writeAtomic(file, '"novo"\n').catch(() => undefined);
    expect(clock).toBeGreaterThan(3000); // no menor sorteio ainda são alguns segundos
    expect(await fs.readFile(file, 'utf8')).toBe('"velho"\n');
    expect(await leftovers(dir)).toEqual([]);
  });

  it('outro erro (disco cheio, caminho inválido) sai como veio, na 1ª vez e sem esperar', async () => {
    const dir = await tmp('myco-busy-other-');
    simulate();
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    const err = await writeAtomic(path.join(dir, 'a.json'), '1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(StateBusyError);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(waits).toEqual([]);
  });

  it('a falha de uma gravação não trava a fila do arquivo: a seguinte grava', async () => {
    const dir = await tmp('myco-busy-queue-');
    const file = path.join(dir, 'tasks.json');
    simulate();
    holdRename('tasks.json', 'EPERM', () => renames <= 12); // só a 1ª gravação esgota as tentativas
    const first = writeAtomic(file, '"a"\n').catch((e: unknown) => e);
    const second = writeAtomic(file, '"b"\n');
    expect(await first).toBeInstanceOf(StateBusyError);
    await second;
    expect(await fs.readFile(file, 'utf8')).toBe('"b"\n');
  });
});

describe('os demais arquivos de estado usam o mesmo retry', () => {
  it('config.json (mutate → mutateNow → writeAtomic): preso por 2 s e depois liberado, grava', async () => {
    const dir = await tmp('myco-busy-config-');
    const file = path.join(dir, 'config.json');
    simulate();
    holdRename('config.json', 'EPERM', () => clock < 2000);
    await setRetentionDeleteEnabledAt('2026-11-22T10:00:00.000Z', file);
    expect((await readConfig(file)).retentionDeleteEnabledAt).toBe('2026-11-22T10:00:00.000Z');
    expect(clock).toBeGreaterThanOrEqual(2000);
    expect(await leftovers(dir)).toEqual([]);
  });

  it('config.json preso de vez: StateBusyError (a API responde 503), e a fila do config segue aceitando gravações', async () => {
    const dir = await tmp('myco-busy-config2-');
    const file = path.join(dir, 'config.json');
    simulate();
    holdRename('config.json', 'EBUSY', () => renames <= 12);
    await expect(setRetentionDeleteEnabledAt('2026-11-22T10:00:00.000Z', file)).rejects.toBeInstanceOf(StateBusyError);
    await setRetentionDeleteEnabledAt('2026-11-23T10:00:00.000Z', file);
    expect((await readConfig(file)).retentionDeleteEnabledAt).toBe('2026-11-23T10:00:00.000Z');
  });

  it('rotação do log de execuções (taskRuns): o rename para `.1` preso por 2 s e depois liberado, gira sem erro', async () => {
    const dir = await tmp('myco-busy-runs-');
    const runs = path.join(dir, '.myco', RUNS_FILE);
    await fs.mkdir(path.dirname(runs), { recursive: true });
    await fs.writeFile(runs, 'x'.repeat(RUNS_ROTATE_BYTES + 10) + '\n');
    simulate();
    holdRename(`${RUNS_FILE}.1`, 'EPERM', () => clock < 2000);
    await appendRun(dir, { ev: 'start', runId: 'r-1', taskId: 't-aaaaaa', staffId: 'ana-1', at: '2026-11-22T10:00:00.000Z' });
    expect(clock).toBeGreaterThanOrEqual(2000);
    expect((await fs.stat(`${runs}.1`)).size).toBeGreaterThan(RUNS_ROTATE_BYTES);
    expect((await fs.readFile(runs, 'utf8')).trim()).toContain('"runId":"r-1"');
  });

  it('cofre de segredos (secretVault): o rename do segredo preso por 2 s e depois liberado, grava e lê de volta', async () => {
    const dir = await tmp('myco-busy-vault-');
    const opts = { dir, platform: 'linux' as const };
    simulate();
    holdRename(path.basename(secretFile('conn-1', opts)), 'EBUSY', () => clock < 2000);
    await setSecret('conn-1', 'senha-de-teste', opts);
    expect(clock).toBeGreaterThanOrEqual(2000);
    expect(await getSecret('conn-1', opts)).toBe('senha-de-teste');
    expect(await leftovers(dir)).toEqual([]);
  });

  it('renameWithRetry direto: esgotado, vira StateBusyError; livre na hora, não espera', async () => {
    const dir = await tmp('myco-busy-direct-');
    await fs.writeFile(path.join(dir, 'a.txt'), 'a');
    simulate();
    holdRename('b.txt', 'EACCES', () => true);
    await expect(renameWithRetry(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'))).rejects.toBeInstanceOf(StateBusyError);
    simulate();
    await renameWithRetry(path.join(dir, 'a.txt'), path.join(dir, 'c.txt'));
    expect(waits).toEqual([]);
  });
});

describe('card automático: quadro preso de vez, o registro é refeito', () => {
  const profile = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false, servers: [], engine: 'claude' } as unknown as StaffProfile;
  const boot = async (name: string) => {
    const dir = await tmp(`myco-busy-${name}-`);
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
    const edit = (): Promise<void> =>
      svc.onCodeEdit({ sessionId: 's-ana', projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: dir, files: [path.join(dir, 'src', 'a.ts')], request: 'Corrija o botão' } as CodeEdit);
    return { dir, edit };
  };

  it('a 1ª gravação esgota as tentativas (StateBusyError) e o registro é refeito: o card nasce, 1 só, sem erro para quem chamou', async () => {
    const f = await boot('card-ok');
    simulate();
    holdRename('tasks.json', 'EPERM', () => renames <= 12);
    await expect(f.edit()).resolves.toBeUndefined();
    expect(waits).toContain(EDIT_RETRY_WAITS_MS[0]);
    const cards = (await readTasks(f.dir)).filter((t) => t.autoCreated);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: 'doing', staffId: 'ana-1', sessionId: 's-ana', changedFiles: ['src/a.ts'] });
  });

  it('preso até a última repetição: desiste com StateBusyError depois de 3 registros (36 renames) e das esperas combinadas', async () => {
    const f = await boot('card-fail');
    simulate();
    holdRename('tasks.json', 'EBUSY', () => true);
    await expect(f.edit()).rejects.toBeInstanceOf(StateBusyError);
    expect(renames).toBe(3 * 12);
    for (const w of EDIT_RETRY_WAITS_MS) expect(waits).toContain(w);
    expect(await readTasks(f.dir)).toEqual([]);
  });

  it('erro que não é de arquivo ocupado não é repetido', async () => {
    const f = await boot('card-other');
    simulate();
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    await expect(f.edit()).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(waits).toEqual([]);
  });
});
