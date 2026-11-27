import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KeyringError, classifyStderr, createSecretToolKeyring, withBusEnv, type KeyringReason } from '../server/secretKeyring';
import { getSecret, migrateVault, secretFile, setSecret } from '../server/secretVault';
import { tempDirs } from './support/tmp';

// O adaptador do `secret-tool` contra um `secret-tool` falso (script sh numa pasta temporária): confere o protocolo de verdade (argumentos, entrada padrão,
// códigos de saída, prazo, ambiente) sem tocar no chaveiro da máquina. Só Linux/macOS: é onde o `sh` e o `secret-tool` existem.
const tmp = tempDirs();

// FAKE_MODE: ok | nobus | noservice | locked | broken | hang | hang-once.
const SCRIPT = `#!/bin/sh
store="$FAKE_STORE"
printf '%s\\n' "$*" >> "$store/argv.log"
printf '%s' "$DBUS_SESSION_BUS_ADDRESS" > "$store/dbus.env"
printf '%s' "$LC_ALL" > "$store/lc.env"
case "$FAKE_MODE" in
  nobus) echo "secret-tool: Cannot autolaunch D-Bus without X11 \\$DISPLAY" >&2; exit 1;;
  noservice) echo "secret-tool: The name org.freedesktop.secrets was not provided by any .service files" >&2; exit 1;;
  locked) echo "secret-tool: Cannot create an item in a locked collection" >&2; exit 1;;
  broken) echo "secret-tool: algo inesperado" >&2; exit 1;;
  hang) exec sleep 30;;
  hang-once) if [ ! -e "$store/hung" ]; then : > "$store/hung"; exec sleep 30; fi;;
esac
cmd="$1"; shift
case "$1" in --label=*) shift;; esac
id="$4"
case "$cmd" in
  store) cat > "$store/item-$id";;
  lookup) if [ -f "$store/item-$id" ]; then cat "$store/item-$id"; else exit 1; fi;;
  clear) rm -f "$store/item-$id";;
  *) echo "uso" >&2; exit 2;;
esac
`;

let bin = '';
let root = '';
beforeAll(async () => {
  root = await tmp('myco-fake-st-');
  bin = path.join(root, 'secret-tool');
  await fs.writeFile(bin, SCRIPT, { mode: 0o755 });
});

const fresh = async (mode = 'ok', extra: Partial<Parameters<typeof createSecretToolKeyring>[0]> = {}) => {
  const store = await tmp('myco-fake-store-');
  const env = { PATH: process.env.PATH, FAKE_STORE: store, FAKE_MODE: mode, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fake/bus' };
  return { store, env, kr: createSecretToolKeyring({ bin, env, ...extra }) };
};
const failure = async (p: Promise<unknown>): Promise<KeyringReason | 'ok'> => p.then(() => 'ok' as const, (e: unknown) => (e instanceof KeyringError ? e.reason : ('other' as never)));

describe.runIf(process.platform !== 'win32')('adaptador do secret-tool', () => {
  it('store/lookup/clear: o valor vai só pela entrada padrão, em base64; o argv não o tem', async () => {
    const { store, kr } = await fresh();
    const value = 'Sénha "forte" ç $x `y`\nlinha 2 ✓ 100%';
    await kr.store('abc123', value);
    const stored = await fs.readFile(path.join(store, 'item-abc123'), 'utf8');
    expect(stored).toBe(Buffer.from(value).toString('base64'));
    const argv = await fs.readFile(path.join(store, 'argv.log'), 'utf8');
    expect(argv).toContain('store --label=Claudio\'s Club (cofre de segredos) application claudios-club id abc123');
    expect(argv).not.toContain('forte');
    expect(argv).not.toContain(stored);
    expect(await kr.lookup('abc123')).toBe(value);
    expect(await kr.lookup('naoexiste')).toBeNull();
    await kr.clear('abc123');
    expect(await kr.lookup('abc123')).toBeNull();
    await kr.clear('abc123'); // apagar o que não existe não é erro
  });

  it('o ambiente do filho leva LC_ALL=C e o endereço do D-Bus', async () => {
    const { store, kr } = await fresh();
    await kr.probe();
    expect(await fs.readFile(path.join(store, 'lc.env'), 'utf8')).toBe('C');
    expect(await fs.readFile(path.join(store, 'dbus.env'), 'utf8')).toBe('unix:path=/fake/bus');
    expect(await fs.readFile(path.join(store, 'argv.log'), 'utf8')).toContain('lookup application claudios-club id probe-inexistente'); // só consulta; não grava
  });

  it.each([
    ['nobus', 'no-bus'],
    ['noservice', 'no-service'],
    ['locked', 'locked'],
    ['broken', 'failed'],
  ] as const)('falha do chaveiro (%s) vira o motivo %s, em todas as operações', async (mode, reason) => {
    const { kr } = await fresh(mode);
    expect(await failure(kr.store('a', 'v'))).toBe(reason);
    expect(await failure(kr.lookup('a'))).toBe(reason);
    expect(await failure(kr.clear('a'))).toBe(reason);
    expect(await failure(kr.probe())).toBe(reason);
  });

  it('secret-tool ausente: no-tool', async () => {
    const kr = createSecretToolKeyring({ bin: path.join(root, 'nao-existe'), env: { PATH: '' } });
    expect(await failure(kr.store('a', 'v'))).toBe('no-tool');
    expect(await failure(kr.probe())).toBe('no-tool');
  });

  it('leitura: prazo curto e uma nova tentativa só quando estoura', async () => {
    const t0 = Date.now();
    const { store, kr } = await fresh('hang-once', { readTimeoutMs: 400 });
    await fs.writeFile(path.join(store, 'item-x'), Buffer.from('ok').toString('base64'));
    expect(await kr.lookup('x')).toBe('ok'); // a 1ª tentativa trava e morre em 400 ms; a 2ª responde
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((await fs.readFile(path.join(store, 'argv.log'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('leitura: travou nas duas tentativas = timeout (sem terceira)', async () => {
    const { store, kr } = await fresh('hang', { readTimeoutMs: 250 });
    expect(await failure(kr.lookup('x'))).toBe('timeout');
    expect((await fs.readFile(path.join(store, 'argv.log'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('leitura que travou: as próximas falham na hora (disjuntor), sem abrir outro processo; a escrita não é barrada; passado o tempo, tenta de novo', async () => {
    const { store, env, kr } = await fresh('hang', { readTimeoutMs: 150, readBreakMs: 600, writeTimeoutMs: 200 });
    const lines = async () => (await fs.readFile(path.join(store, 'argv.log'), 'utf8')).trim().split('\n').length;
    expect(await failure(kr.lookup('a'))).toBe('timeout');
    expect(await lines()).toBe(2); // as duas tentativas
    const t1 = Date.now();
    expect(await failure(kr.lookup('b'))).toBe('timeout');
    expect(await failure(kr.probe())).toBe('timeout');
    expect(Date.now() - t1).toBeLessThan(100); // sem esperar prazo nenhum
    expect(await lines()).toBe(2); // e sem abrir processo
    // O usuário pode ter acabado de destravar: a escrita não passa pelo disjuntor (abre processo e espera o próprio prazo).
    expect(await failure(kr.store('c', 'v'))).toBe('timeout');
    expect(await lines()).toBe(3);
    // Passado o tempo, a leitura tenta de novo (agora o chaveiro responde).
    await new Promise((r) => setTimeout(r, 650));
    env.FAKE_MODE = 'ok';
    expect(await kr.lookup('zzz')).toBeNull();
    expect(await lines()).toBe(4);
  });

  it('escrita: prazo próprio, sem nova tentativa', async () => {
    const { store, kr } = await fresh('hang', { readTimeoutMs: 100, writeTimeoutMs: 300 });
    expect(await failure(kr.store('x', 'v'))).toBe('timeout');
    expect((await fs.readFile(path.join(store, 'argv.log'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('o valor de volta que não é base64 é recusado (não vaza como texto)', async () => {
    const { store, kr } = await fresh();
    await fs.writeFile(path.join(store, 'item-x'), 'isto não é base64 !!');
    expect(await failure(kr.lookup('x'))).toBe('failed');
  });
});

describe('ambiente do D-Bus (filho do MCP sem a variável)', () => {
  it('sem DBUS_SESSION_BUS_ADDRESS usa $XDG_RUNTIME_DIR/bus, se o socket existe', async () => {
    const run = await tmp('myco-xdg-');
    await fs.writeFile(path.join(run, 'bus'), '');
    const env = withBusEnv({ XDG_RUNTIME_DIR: run, PATH: '/usr/bin' }, 1000);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${path.join(run, 'bus')}`);
    expect(env.LC_ALL).toBe('C');
  });

  it('sem XDG_RUNTIME_DIR tenta /run/user/<uid>/bus', () => {
    const env = withBusEnv({}, 4242424);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined(); // não existe: nada inventado
  });

  it('o endereço que já vem do ambiente não é trocado; caminho com caractere especial não vira endereço', async () => {
    expect(withBusEnv({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x/bus' }, 1).DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/x/bus');
    const odd = await tmp('myco-xdg,odd-');
    await fs.writeFile(path.join(odd, 'bus'), '');
    expect(withBusEnv({ XDG_RUNTIME_DIR: odd }, 1).DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it('classifyStderr', () => {
    expect(classifyStderr('secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY')).toBe('no-bus');
    expect(classifyStderr('Failed to connect to socket /run/user/1000/bus: No such file or directory')).toBe('no-bus');
    expect(classifyStderr('The name org.freedesktop.secrets was not provided by any .service files')).toBe('no-service');
    expect(classifyStderr('Cannot create an item in a locked collection')).toBe('locked');
    expect(classifyStderr('')).toBe('failed');
  });
});

describe.runIf(process.platform !== 'win32')('cofre de ponta a ponta com o secret-tool falso', () => {
  it('segredo novo vai para o "chaveiro" e o arquivo é só o marcador; antigo migra e é lido', async () => {
    const { store, kr } = await fresh();
    const dir = path.join(await tmp('myco-vault-e2e-'), 'secrets');
    const o = { dir, platform: 'linux' as const, keyring: kr };

    expect(await setSecret('ftp:/p:site', 'senha-nova', o)).toEqual({ backend: 'keyring' });
    expect(await fs.readFile(secretFile('ftp:/p:site', o), 'utf8')).toMatch(/^v1:keyring:[0-9a-f]{24}$/);
    const items = (await fs.readdir(store)).filter((f) => f.startsWith('item-'));
    expect(items).toHaveLength(1);
    expect(await fs.readFile(path.join(store, items[0]!), 'utf8')).toBe(Buffer.from('senha-nova').toString('base64'));
    expect(await getSecret('ftp:/p:site', o)).toBe('senha-nova');

    await setSecret('ftp:/p:velho', 'senha-velha', { ...o, keyring: null });
    expect(await getSecret('ftp:/p:velho', o)).toBe('senha-velha');
    expect(await migrateVault(o)).toEqual({ migrated: 1, kept: 0 });
    expect(await getSecret('ftp:/p:velho', o)).toBe('senha-velha');
    expect((await fs.readdir(store)).filter((f) => f.startsWith('item-'))).toHaveLength(2);
  });

  it('chaveiro bloqueado: a escrita cai para arquivo com aviso e a leitura de um item do chaveiro diz o motivo', async () => {
    const ok = await fresh();
    const dir = path.join(await tmp('myco-vault-e2e-'), 'secrets');
    await setSecret('a', 'no-chaveiro', { dir, platform: 'linux', keyring: ok.kr });
    const locked = await fresh('locked');
    const o = { dir, platform: 'linux' as const, keyring: locked.kr };
    const r = await setSecret('b', 'no-arquivo', o);
    expect(r.backend).toBe('file');
    expect(r.warning).toMatch(/bloqueado/);
    expect(await getSecret('b', o)).toBe('no-arquivo');
    await expect(getSecret('a', o)).rejects.toThrow(/destrave o chaveiro/);
  });
});
