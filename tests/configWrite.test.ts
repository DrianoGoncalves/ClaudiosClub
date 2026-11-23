import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readConfig, setArchived, updateConfig } from '../server/config';
import { removeTemp } from './support/tmp';

// No Windows o rename do config.json pode falhar um instante com EPERM (antivírus/indexador): a tela não pode dar erro por isso.

let root: string;
let n = 0;
const fresh = () => path.join(root, `c${n++}`, 'config.json');
const tmps = async (file: string) => (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'));
const busy = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-configwrite-'));
});
afterAll(() => removeTemp(root));
afterEach(() => {
  vi.restoreAllMocks();
});

describe('gravação do config.json: rename com retry', () => {
  it('EPERM 2 vezes e depois passa: a gravação conclui', async () => {
    const file = fresh();
    const real = fs.rename.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (++calls <= 2) throw busy();
      return real(from, to);
    });
    const saved = await updateConfig({ autoContinue: false }, file);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(saved.autoContinue).toBe(false);
    expect((await readConfig(file)).autoContinue).toBe(false);
    expect(await tmps(file)).toEqual([]);
  });

  it('EBUSY e EACCES também repetem (outras gravações, como arquivar, passam pelo mesmo caminho)', async () => {
    const file = fresh();
    const real = fs.rename.bind(fs);
    const codes = ['EBUSY', 'EACCES'];
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const code = codes.shift();
      if (code) throw busy(code);
      return real(from, to);
    });
    await setArchived({ kind: 'session', id: 's-1', archived: true }, file);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).archived.sessions).toEqual(['s-1']);
    expect(await tmps(file)).toEqual([]);
  });

  it('EPERM sempre: o erro original sobe, o arquivo antigo fica intacto e não sobra .tmp', async () => {
    const file = fresh();
    await updateConfig({ autoContinue: true }, file);
    const before = await fs.readFile(file, 'utf8');
    const eperm = busy();
    const spy = vi.spyOn(fs, 'rename').mockRejectedValue(eperm);
    await expect(updateConfig({ autoContinue: false }, file)).rejects.toBe(eperm);
    expect(spy.mock.calls.length).toBeGreaterThan(1); // tentou de novo antes de desistir
    spy.mockRestore();
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await tmps(file)).toEqual([]);
    // a falha não trava a fila do arquivo: a próxima gravação funciona
    expect((await updateConfig({ autoContinue: false }, file)).autoContinue).toBe(false);
  });

  it('erro que não é de arquivo ocupado (ENOENT) sobe na hora, sem repetir', async () => {
    const file = fresh();
    const enoent = busy('ENOENT');
    const spy = vi.spyOn(fs, 'rename').mockRejectedValue(enoent);
    await expect(updateConfig({ autoContinue: false }, file)).rejects.toBe(enoent);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await tmps(file)).toEqual([]);
  });

  it('mudanças juntas no mesmo arquivo continuam em fila, mesmo com um EPERM no meio', async () => {
    const file = fresh();
    const real = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (++calls === 1) throw busy();
      return real(from, to);
    });
    await Promise.all(['a', 'b', 'c'].map((id) => setArchived({ kind: 'session', id, archived: true }, file)));
    expect(JSON.parse(await fs.readFile(file, 'utf8')).archived.sessions.sort()).toEqual(['a', 'b', 'c']);
    expect(await tmps(file)).toEqual([]);
  });
});
