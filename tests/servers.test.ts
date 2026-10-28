import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectionInput,
  explainSshError,
  readConnections,
  removeConnection,
  saveConnection,
  sshConfigFile,
  testConnection,
} from '../server/staff/servers';

let root: string;
let key: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-conn-'));
  key = path.join(root, 'id_teste');
  await fs.writeFile(key, 'não é lida');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const project = async (name: string) => {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};
const conn = (over: Record<string, unknown> = {}) => ({ name: 'prod', host: '72.61.33.164', port: 22, user: 'deploy', identityFile: key, remoteRoot: '/var/www/app/', ...over });

describe('conexões SSH do projeto', () => {
  it('recusa o que viraria outra linha (ou opção) no ssh_config', () => {
    const bad = [
      { host: 'vps.com\n  ProxyCommand calc.exe' },
      { host: '-oProxyCommand=calc' },
      { host: 'vps com espaço' },
      { name: '-F' },
      { name: 'prod\nHost *' },
      { user: 'root -o x' },
      { user: '-oProxyCommand=x' },
      { identityFile: 'C:/k"\n  ProxyCommand x' },
      { identityFile: 'C:/%h/k' },
      { identityFile: `${key}.pub` },
      { port: 0 },
      { port: 70000 },
      { remoteRoot: 'var/www' },
      { remoteRoot: '/var/www; rm -rf /' },
      { remoteRoot: '/var/www\n' + 'x' },
    ];
    for (const over of bad) expect(ConnectionInput.safeParse(conn(over)).success, JSON.stringify(over)).toBe(false);
    for (const host of ['vps.example.com', '10.0.0.5', '2001:db8::1', 'localhost']) {
      expect(ConnectionInput.safeParse(conn({ host })).success, host).toBe(true);
    }
    // Pasta remota vazia = nenhuma; a barra final sai.
    expect(ConnectionInput.parse(conn({ remoteRoot: '' })).remoteRoot).toBeNull();
    expect(ConnectionInput.parse(conn()).remoteRoot).toBe('/var/www/app');
  });

  it('salva no .vps (fora do git), gera o ssh_config e não perde o que a skill vps usa', async () => {
    const dir = await project('salvar');
    await fs.mkdir(path.join(dir, '.vps'), { recursive: true });
    await fs.writeFile(path.join(dir, '.vps', 'config.json'), JSON.stringify({ connections: { prod: { host: 'VPS', localSubfolder: 'site' } } }));
    expect((await readConnections(dir))[0]).toMatchObject({ name: 'prod', host: 'VPS', complete: false, user: null });

    // Completar a que já existe é editar (a tela manda o nome original); criar outra igual, não.
    await expect(saveConnection(dir, conn())).rejects.toThrow('já existe');
    const saved = await saveConnection(dir, conn(), 'prod');
    expect(saved).toMatchObject({ name: 'prod', complete: true, keyFound: true, remoteRoot: '/var/www/app' });
    const file = JSON.parse(await fs.readFile(path.join(dir, '.vps', 'config.json'), 'utf8'));
    expect(file).toMatchObject({ default: 'prod', connections: { prod: { host: '72.61.33.164', localSubfolder: 'site', user: 'deploy' } } });
    expect(await fs.readFile(path.join(dir, '.vps', '.gitignore'), 'utf8')).toBe('*\n');

    const cfg = await fs.readFile(sshConfigFile(dir), 'utf8');
    for (const line of ['Host prod', 'HostName 72.61.33.164', 'User deploy', `IdentityFile "${key.replace(/\\/g, '/')}"`, 'IdentitiesOnly yes', 'BatchMode yes', 'ForwardAgent no', 'ClearAllForwardings yes', 'StrictHostKeyChecking accept-new']) {
      expect(cfg).toContain(line);
    }
    // O conteúdo da chave nunca vai para lugar nenhum.
    expect(cfg + JSON.stringify(file)).not.toContain('não é lida');
  });

  it('chave que não existe, nome repetido e renomear', async () => {
    const dir = await project('regras');
    await expect(saveConnection(dir, conn({ identityFile: path.join(root, 'sumiu') }))).rejects.toThrow('chave não encontrada');
    await saveConnection(dir, conn());
    await saveConnection(dir, conn({ name: 'staging', host: 'staging.example.com' }));
    await expect(saveConnection(dir, conn({ name: 'staging' }), 'prod')).rejects.toThrow('já existe');
    await saveConnection(dir, conn({ name: 'producao' }), 'prod');
    expect((await readConnections(dir)).map((c) => c.name).sort()).toEqual(['producao', 'staging']);
    const file = JSON.parse(await fs.readFile(path.join(dir, '.vps', 'config.json'), 'utf8'));
    expect(file.default).toBe('producao');
  });

  it('remover a última apaga o ssh_config', async () => {
    const dir = await project('remover');
    await saveConnection(dir, conn());
    expect(await removeConnection(dir, 'prod')).toBe(true);
    expect(await removeConnection(dir, 'prod')).toBe(false);
    await expect(fs.stat(sshConfigFile(dir))).rejects.toThrow();
  });

  it('testar: roda o ssh com o arquivo do projeto e explica a falha', async () => {
    const dir = await project('testar');
    await saveConnection(dir, conn());
    const calls: string[][] = [];
    const ok = await testConnection(dir, 'prod', async (_cmd, args) => (calls.push(args), { code: 0, stdout: 'myco-ok\n', stderr: '' }));
    expect(ok).toEqual({ ok: true, message: 'conectou em deploy@72.61.33.164' });
    expect(calls[0]).toEqual(['-F', sshConfigFile(dir), 'prod', 'echo myco-ok']);

    const denied = await testConnection(dir, 'prod', async () => ({ code: 255, stdout: '', stderr: 'deploy@72.61.33.164: Permission denied (publickey).' }));
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain('recusou a chave');
    const noSsh = await testConnection(dir, 'prod', async () => ({ code: -1, stdout: '', stderr: '', missing: true }));
    expect(noSsh.message).toContain('não está instalado');
  });

  it('erros do ssh em palavras', () => {
    expect(explainSshError('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@')).toContain('pode ser um ataque');
    expect(explainSshError('WARNING: UNPROTECTED PRIVATE KEY FILE!')).toContain('aberto demais');
    expect(explainSshError('ssh: Could not resolve hostname x: Name or service not known')).toContain('host não encontrado');
    expect(explainSshError('connect to host 1.2.3.4 port 2222: Connection timed out', 2222)).toContain('porta 2222');
    expect(explainSshError('algo novo\n')).toBe('a conexão falhou: algo novo');
  });
});
