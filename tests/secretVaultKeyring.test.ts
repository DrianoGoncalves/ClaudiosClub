import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SECRETS_DIR, deleteSecret, getSecret, hasSecret, migrateVault, moveSecret, restoreVaultToFile, secretFile, setSecret, vaultBoot, vaultStatus } from '../server/secretVault';
import { fakeKeyring } from './support/fakeKeyring';
import { tempDirs } from './support/tmp';

const tmp = tempDirs();
const SECRET = 'Sénha "forte" ç $x `y` 100%\nsegunda linha ✓';
const MARKER = /^v1:keyring:[0-9a-f]{24}$/;

const setup = async () => {
  const kr = fakeKeyring();
  const dir = path.join(await tmp('myco-vault-kr-'), 'secrets');
  return { kr, dir, o: { dir, platform: 'linux' as const, keyring: kr } };
};
const read = (id: string, o: { dir: string }) => fs.readFile(secretFile(id, o), 'utf8');

afterEach(() => vi.restoreAllMocks());

describe('cofre no chaveiro (Linux): segredo novo', () => {
  it('vai para o chaveiro; o arquivo é só o marcador e não tem o valor', async () => {
    const { kr, dir, o } = await setup();
    const r = await setSecret('ftp:/proj:site', SECRET, o);
    expect(r).toEqual({ backend: 'keyring' });
    const raw = await read('ftp:/proj:site', o);
    expect(raw).toMatch(MARKER);
    expect(raw).not.toContain('forte');
    expect(raw).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect([...kr.items.values()]).toEqual([SECRET]);
    expect(await getSecret('ftp:/proj:site', o)).toBe(SECRET);
    expect(await hasSecret('ftp:/proj:site', o)).toBe(true);
    if (process.platform !== 'win32') {
      expect((await fs.stat(secretFile('ftp:/proj:site', o))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    }
    // O id do chaveiro é sorteado: não deriva do id do segredo (não revela projeto nem conexão).
    const kid = raw.slice('v1:keyring:'.length);
    expect(kid).not.toContain('site');
    expect(kr.items.has(kid)).toBe(true);
  });

  it('o valor do chaveiro aguenta o tamanho máximo e acentos', async () => {
    const { o } = await setup();
    const big = 'á'.repeat(2048); // 4096 bytes
    await setSecret('a', big, o);
    expect(await getSecret('a', o)).toBe(big);
    await expect(setSecret('a', big + 'x', o)).rejects.toThrow('grande demais');
    await expect(setSecret('a', '', o)).rejects.toThrow('vazio');
  });

  it('trocar o valor deixa um item só no chaveiro; apagar o limpa; renomear leva sem tocar nele', async () => {
    const { kr, dir, o } = await setup();
    await setSecret('ftp:/p:a', 'um', o);
    await setSecret('ftp:/p:a', 'dois', o);
    expect([...kr.items.values()]).toEqual(['dois']);
    expect(await getSecret('ftp:/p:a', o)).toBe('dois');

    kr.calls.length = 0;
    await moveSecret('ftp:/p:a', 'ftp:/p:b', o);
    expect(kr.calls).toEqual([]); // o marcador vai junto: sem decifrar nem regravar
    expect(await getSecret('ftp:/p:a', o)).toBeNull();
    expect(await getSecret('ftp:/p:b', o)).toBe('dois');
    expect(kr.items.size).toBe(1);

    expect(await deleteSecret('ftp:/p:b', o)).toBe(true);
    expect(kr.items.size).toBe(0);
    expect(await deleteSecret('ftp:/p:b', o)).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('renomear por cima de um segredo que estava no chaveiro não deixa o item antigo para trás', async () => {
    const { kr, o } = await setup();
    await setSecret('x', 'velho', o);
    await setSecret('y', 'novo', o);
    await moveSecret('y', 'x', o);
    expect(await getSecret('x', o)).toBe('novo');
    expect([...kr.items.values()]).toEqual(['novo']);
  });

  it('gravar no chaveiro e falhar ao gravar o marcador não deixa item sem dono nem temporário', async () => {
    const { kr, dir, o } = await setup();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disco'), { code: 'EIO' }));
    await expect(setSecret('z', 'valor', o)).rejects.toThrow('disco');
    expect(kr.items.size).toBe(0);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('o erro de leitura diz o motivo e não traz o valor', async () => {
    const { kr, o } = await setup();
    await setSecret('a', SECRET, o);
    kr.down = 'locked';
    const err = await getSecret('a', o).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/destrave o chaveiro/);
    expect((err as Error).message).not.toContain('forte');
    kr.down = 'timeout';
    await expect(getSecret('a', o)).rejects.toThrow(/não respondeu a tempo/);
    // Item sumiu do chaveiro (outro login, chaveiro recriado): pede para cadastrar de novo.
    kr.down = null;
    kr.items.clear();
    await expect(getSecret('a', o)).rejects.toThrow(/não tem este segredo: cadastre a senha de novo/);
    // Chaveiro desligado aqui, mas o marcador é dele.
    await expect(getSecret('a', { ...o, keyring: null })).rejects.toThrow(/desligado/);
  });

  it('marcador estragado é "corrompido"', async () => {
    const { dir, o } = await setup();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(secretFile('a', o), 'v1:keyring:nao-e-hex');
    await expect(getSecret('a', o)).rejects.toThrow('corrompido');
  });
});

describe('cofre sem chaveiro: continua no formato atual, com aviso', () => {
  it.each([
    ['no-tool', /secret-tool/],
    ['no-bus', /D-Bus/],
    ['no-service', /nenhum chaveiro/],
    ['locked', /bloqueado/],
    ['timeout', /não respondeu/],
    ['failed', /recusou/],
  ] as const)('chaveiro fora (%s): grava v1:file:, lê de volta e avisa', async (reason, why) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kr, o } = await setup();
    kr.down = reason;
    const r = await setSecret('ftp:/p:site', SECRET, o);
    expect(r.backend).toBe('file');
    expect(r.warning).toMatch(why);
    expect(r.warning).toMatch(/sem cifra/);
    expect(r.warning).not.toContain('forte');
    expect(await read('ftp:/p:site', o)).toBe(`v1:file:${Buffer.from(SECRET).toString('base64')}`);
    expect(await getSecret('ftp:/p:site', o)).toBe(SECRET);
    expect(kr.items.size).toBe(0);
    // Uma linha de log por motivo e por processo, sem valor.
    await setSecret('ftp:/p:outro', 'x', o);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[cofre]'));
    expect(lines.length).toBeLessThanOrEqual(1);
    expect(lines.join('\n')).not.toContain('forte');
  });

  it('chaveiro desligado (keyring: null): arquivo, sem aviso (foi escolha)', async () => {
    const { o } = await setup();
    const r = await setSecret('a', 'v', { ...o, keyring: null });
    expect(r).toEqual({ backend: 'file' });
    expect(await read('a', o)).toBe(`v1:file:${Buffer.from('v').toString('base64')}`);
  });

  it('o vitest, a pasta de teste, MYCO_VAULT_KEYRING=off e outra casa nunca chegam ao chaveiro do sistema', async () => {
    const tmpDir = await tmp('myco-vault-kr-');
    // Sob o vitest o chaveiro do sistema só entra com `MYCO_VAULT_KEYRING=on`: a pasta padrão desta rodada (MYCO_HOME de teste) fica em arquivo, sem sondar.
    expect(await vaultStatus({ dir: tmpDir, platform: 'linux' })).toEqual({ backend: 'file' });
    expect(await vaultStatus({ platform: 'linux' })).toEqual({ backend: 'file' });
    vi.stubEnv('MYCO_VAULT_KEYRING', 'off');
    try {
      expect(await vaultStatus({ dir: DEFAULT_SECRETS_DIR, platform: 'linux' })).toEqual({ backend: 'file' });
    } finally {
      vi.unstubAllEnvs();
    }
    // macOS: arquivo.
    expect(await vaultStatus({ platform: 'darwin' })).toEqual({ backend: 'file' });
  });

  it('gravar sem chaveiro injetado, sob o vitest, não toca nada além da pasta pedida', async () => {
    const dir = path.join(await tmp('myco-vault-kr-'), 'secrets');
    expect(await setSecret('a', 'v', { dir, platform: 'linux' })).toEqual({ backend: 'file' });
    expect(await migrateVault({ dir, platform: 'linux' })).toEqual({ migrated: 0, kept: 1 });
  });

  it('vaultStatus: chaveiro de pé = keyring; fora = arquivo com o aviso', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kr, o } = await setup();
    expect(await vaultStatus(o)).toEqual({ backend: 'keyring' });
    kr.down = 'no-bus';
    const s = await vaultStatus(o);
    expect(s.backend).toBe('file');
    expect(s.warning).toMatch(/D-Bus/);
  });
});

describe('segredos antigos (v1:file:): lidos e migrados sem perda', () => {
  const legacy = async (o: { dir: string; platform: 'linux' }, ids: string[], values = ids.map((i) => `senha-${i}-ç`)) => {
    for (const [i, id] of ids.entries()) await setSecret(id, values[i]!, { ...o, keyring: null });
    return values;
  };

  it('o formato antigo segue lido com o chaveiro disponível (e nada é migrado na leitura)', async () => {
    const { kr, o } = await setup();
    await legacy(o, ['a']);
    expect(await getSecret('a', o)).toBe('senha-a-ç');
    expect(kr.calls).toEqual([]);
    expect(await read('a', o)).toMatch(/^v1:file:/);
  });

  it('migra todos: o chaveiro tem o valor, o arquivo vira marcador e getSecret devolve o mesmo', async () => {
    const { kr, o } = await setup();
    const ids = ['ftp:/p:a', 'ftp:/p:b', 'mcp:club:x:env:KEY'];
    const values = await legacy(o, ids);
    expect(await migrateVault(o)).toEqual({ migrated: 3, kept: 0 });
    for (const [i, id] of ids.entries()) {
      expect(await read(id, o)).toMatch(MARKER);
      expect(await getSecret(id, o)).toBe(values[i]);
    }
    expect([...kr.items.values()].sort()).toEqual([...values].sort());
    // Segunda vez: nada a fazer.
    kr.calls.length = 0;
    expect(await migrateVault(o)).toEqual({ migrated: 0, kept: 0 });
    expect(kr.calls).toEqual([]);
    expect(await fs.readdir(o.dir)).toHaveLength(3); // sem temporário largado
  });

  it('chaveiro fora: nada muda (arquivo intacto, byte a byte) e o motivo vem no resultado', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kr, o } = await setup();
    await legacy(o, ['a', 'b']);
    const before = [await read('a', o), await read('b', o)];
    kr.down = 'locked';
    const r = await migrateVault(o);
    expect(r).toMatchObject({ migrated: 0, kept: 2 });
    expect(r.reason).toMatch(/bloqueado/);
    expect([await read('a', o), await read('b', o)]).toEqual(before);
    expect(await getSecret('a', o)).toBe('senha-a-ç');
  });

  it('cai no meio: o que passou fica migrado, o resto intacto, e uma nova rodada termina', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kr, o } = await setup();
    const ids = ['a', 'b', 'c'];
    const values = await legacy(o, ids);
    const before = new Map<string, string>();
    for (const id of ids) before.set(id, await read(id, o));
    // O chaveiro cai logo depois de gravar o 2º item: a leitura de conferência falha.
    let stores = 0;
    kr.onStore = () => {
      if (++stores === 2) queueMicrotask(() => (kr.down = 'timeout'));
    };
    const first = await migrateVault(o);
    expect(first.migrated).toBe(1);
    expect(first.kept).toBe(2);
    expect(first.reason).toMatch(/não respondeu/);
    // Quem não passou segue em arquivo, byte a byte; nenhum segredo se perdeu.
    const files = await Promise.all(ids.map(async (id) => ({ id, raw: await read(id, o) })));
    expect(files.filter((f) => f.raw === before.get(f.id))).toHaveLength(2);
    expect(files.filter((f) => MARKER.test(f.raw))).toHaveLength(1);
    kr.down = null;
    kr.onStore = undefined;
    const second = await migrateVault(o);
    expect(second.migrated).toBe(2);
    for (const [i, id] of ids.entries()) expect(await getSecret(id, o)).toBe(values[i]);
    expect(await migrateVault(o)).toEqual({ migrated: 0, kept: 0 });
  });

  it('o item não confere na leitura de volta: o arquivo fica e o item recém-criado sai', async () => {
    const { kr, o } = await setup();
    await legacy(o, ['a']);
    const before = await read('a', o);
    kr.onLookup = () => 'outro valor';
    expect(await migrateVault(o)).toEqual({ migrated: 0, kept: 1 });
    expect(await read('a', o)).toBe(before);
    expect(kr.items.size).toBe(0);
  });

  it('o arquivo mudou no meio da migração (outra gravação): fica como está', async () => {
    const { kr, o } = await setup();
    await legacy(o, ['a']);
    kr.onLookup = async () => {
      await fs.writeFile(secretFile('a', o), `v1:file:${Buffer.from('mudou').toString('base64')}`);
      return undefined; // segue o valor que o fake tem
    };
    expect(await migrateVault(o)).toEqual({ migrated: 0, kept: 1 });
    expect(await getSecret('a', o)).toBe('mudou');
    expect(kr.items.size).toBe(0);
  });

  it('falha ao gravar o marcador: arquivo antigo intacto, sem item nem temporário sobrando', async () => {
    const { kr, o } = await setup();
    await legacy(o, ['a']);
    const before = await read('a', o);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disco'), { code: 'EIO' }));
    expect(await migrateVault(o)).toEqual({ migrated: 0, kept: 1 });
    expect(await read('a', o)).toBe(before);
    expect(kr.items.size).toBe(0);
    expect(await fs.readdir(o.dir)).toHaveLength(1);
  });

  it('sem chaveiro configurado, a migração só conta o que ficou em arquivo; o que já é marcador não entra', async () => {
    const { kr, o } = await setup();
    await legacy(o, ['a']);
    await setSecret('b', 'no-chaveiro', o);
    expect(await migrateVault({ ...o, keyring: null })).toEqual({ migrated: 0, kept: 1 });
    expect(kr.items.size).toBe(1);
  });

  it('pasta do cofre inexistente: nada a migrar', async () => {
    const { o } = await setup();
    expect(await migrateVault(o)).toEqual({ migrated: 0, kept: 0 });
  });

  it('caminho de volta: do chaveiro para o arquivo, sem perda; o que o chaveiro não entrega fica', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kr, o } = await setup();
    await setSecret('a', SECRET, o);
    await setSecret('b', 'dois', o);
    const [kidA] = (await read('a', o)).slice('v1:keyring:'.length).split('\n');
    kr.items.delete(kidA!); // o item de "a" sumiu: não dá para devolver
    expect(await restoreVaultToFile(o)).toEqual({ restored: 1, kept: 1 });
    expect(await read('b', o)).toBe(`v1:file:${Buffer.from('dois').toString('base64')}`);
    expect(await getSecret('b', { ...o, keyring: null })).toBe('dois');
    expect(kr.items.size).toBe(0);
    expect(await read('a', o)).toMatch(MARKER);
    // Chaveiro fora: nada muda.
    await setSecret('c', 'tres', o);
    kr.down = 'no-bus';
    expect(await restoreVaultToFile(o)).toEqual({ restored: 0, kept: 2 });
  });
});

describe('subida do servidor (vaultBoot): log com contagem e sem valor', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, out: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(`WARN ${l}`) } };
  };

  it('com chaveiro: onde ficam, quantos migraram', async () => {
    const { kr, o } = await setup();
    await setSecret('a', 'segredo-a', { ...o, keyring: null });
    await setSecret('b', 'segredo-b', { ...o, keyring: null });
    const { lines, out } = capture();
    expect(await vaultBoot(o, out)).toEqual({ migrated: 2, kept: 0 });
    expect(lines).toEqual(['[cofre] segredos guardados em: chaveiro do sistema', '[cofre] 2 segredo(s) migrado(s) para o chaveiro, 0 mantido(s) em arquivo']);
    expect(lines.join('\n')).not.toContain('segredo-a');
    expect(kr.items.size).toBe(2);
  });

  it('sem chaveiro: aviso e a contagem do que ficou em arquivo', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kr, o } = await setup();
    await setSecret('a', 'segredo-a', { ...o, keyring: null });
    kr.down = 'no-bus';
    const { lines, out } = capture();
    const r = await vaultBoot(o, out);
    expect(r).toMatchObject({ migrated: 0, kept: 1 });
    expect(lines[0]).toMatch(/^WARN \[cofre\] Sem chaveiro do sistema \(.*D-Bus.*\)/);
    expect(lines[1]).toMatch(/0 segredo\(s\) migrado\(s\) para o chaveiro, 1 mantido\(s\) em arquivo/);
    expect(lines.join('\n')).not.toContain('segredo-a');
  });

  it('chaveiro desligado por escolha: não fala do que ficou em arquivo', async () => {
    const { o } = await setup();
    await setSecret('a', 'x', { ...o, keyring: null });
    const { lines, out } = capture();
    await vaultBoot({ ...o, keyring: null }, out);
    expect(lines).toEqual(['[cofre] segredos guardados em: arquivo (0600, sem cifra)']);
  });
});

describe('Windows fica como está', () => {
  it('no win32 o chaveiro nunca é chamado (nem para gravar, nem para apagar) e o caminho é o do DPAPI', async () => {
    if (process.platform === 'win32') return; // lá o DPAPI de verdade roda em tests/secretVault.test.ts
    const { kr, dir, o } = await setup();
    const w = { ...o, platform: 'win32' as const };
    await expect(setSecret('a', 'v', w)).rejects.toThrow(/PowerShell/); // aqui não há powershell.exe: prova que foi pelo DPAPI
    expect(kr.calls).toEqual([]);
    expect(await fs.readdir(dir).catch(() => [])).toEqual([]);

    // Modo arquivo antigo e marcador do DPAPI: as mesmas respostas de antes.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(secretFile('f', w), `v1:file:${Buffer.from('antigo').toString('base64')}`);
    expect(await getSecret('f', w)).toBe('antigo');
    await fs.writeFile(secretFile('k', w), `v1:keyring:${'a'.repeat(24)}`);
    await expect(getSecret('k', w)).rejects.toThrow(/chaveiro do Linux/);
    expect(await deleteSecret('k', w)).toBe(true);
    expect(await migrateVault(w)).toEqual({ migrated: 0, kept: 1 }); // só conta o `v1:file:`; não tenta chaveiro
    expect(kr.calls).toEqual([]);
  });

  it('o marcador do DPAPI no Linux segue pedindo para cadastrar de novo', async () => {
    const { dir, o } = await setup();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(secretFile('d', o), 'v1:dpapi:AAAA');
    await expect(getSecret('d', o)).rejects.toThrow(/cifrado no Windows/);
  });
});
