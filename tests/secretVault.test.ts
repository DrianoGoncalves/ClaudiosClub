import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteSecret, getSecret, hasSecret, moveSecret, secretFile, setSecret } from '../server/secretVault';

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-vault-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const SECRET = 'Sénha "forte" ç $x `y` 100%';

describe('cofre de segredos', () => {
  it('modo arquivo (Linux/mac): ida e volta, 0600 na pasta 0700, nome do arquivo sem o id', async () => {
    const o = { dir: path.join(dir, 'arquivo'), platform: 'linux' as const };
    await setSecret('ftp:/proj:site', SECRET, o);
    expect(await getSecret('ftp:/proj:site', o)).toBe(SECRET);
    expect(await hasSecret('ftp:/proj:site', o)).toBe(true);
    const file = secretFile('ftp:/proj:site', o);
    expect(path.basename(file)).not.toContain('site');
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(o.dir)).mode & 0o777).toBe(0o700);
    }
    // Renomear leva junto; apagar some.
    await moveSecret('ftp:/proj:site', 'ftp:/proj:novo', o);
    expect(await getSecret('ftp:/proj:site', o)).toBeNull();
    expect(await getSecret('ftp:/proj:novo', o)).toBe(SECRET);
    expect(await deleteSecret('ftp:/proj:novo', o)).toBe(true);
    expect(await deleteSecret('ftp:/proj:novo', o)).toBe(false);
    expect(await hasSecret('ftp:/proj:novo', o)).toBe(false);
    expect(await fs.readdir(o.dir)).toEqual([]); // sem temporário largado
  });

  it('recusa vazio e arquivo estragado', async () => {
    const o = { dir: path.join(dir, 'erros'), platform: 'linux' as const };
    await expect(setSecret('a', '', o)).rejects.toThrow('vazio');
    await fs.mkdir(o.dir, { recursive: true });
    await fs.writeFile(secretFile('a', o), 'lixo');
    await expect(getSecret('a', o)).rejects.toThrow('corrompido');
  });

  it.runIf(process.platform === 'win32')(
    'Windows: DPAPI de verdade (ida e volta); o arquivo não tem o segredo',
    async () => {
      const o = { dir: path.join(dir, 'dpapi') };
      await setSecret('ftp:c:\\proj:site', SECRET, o);
      const raw = await fs.readFile(secretFile('ftp:c:\\proj:site', o), 'utf8');
      expect(raw).toMatch(/^v1:dpapi:/);
      expect(raw).not.toContain('forte');
      expect(Buffer.from(raw.slice('v1:dpapi:'.length), 'base64').toString('latin1')).not.toContain('forte');
      expect(await getSecret('ftp:c:\\proj:site', o)).toBe(SECRET);
      // O blob vai junto ao renomear, sem decifrar.
      await moveSecret('ftp:c:\\proj:site', 'ftp:c:\\proj:outro', o);
      expect(await getSecret('ftp:c:\\proj:outro', o)).toBe(SECRET);
      // Blob adulterado não abre (e a mensagem não traz nada do segredo).
      await fs.writeFile(secretFile('ftp:c:\\proj:outro', o), 'v1:dpapi:AAAA');
      await expect(getSecret('ftp:c:\\proj:outro', o)).rejects.toThrow(/cadastre a senha de novo/);
    },
    60_000,
  );
});
