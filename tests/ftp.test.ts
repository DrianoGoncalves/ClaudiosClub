import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FtpConnection } from '../shared/model';
import {
  basicFtpConnector,
  connectWithRetry,
  explainFtpError,
  FtpBreaker,
  FtpInput,
  ftpSecretId,
  listFtpServers,
  readFtpConnections,
  removeFtpConnection,
  resolveRemote,
  saveFtpConnection,
  testFtpConnection,
  type FtpConnector,
  type FtpSession,
} from '../server/staff/ftp';
import { saveConnection } from '../server/staff/servers';
import { getSecret, hasSecret } from '../server/secretVault';

const PASSWORD = 'S3nh@-Secreta-FTP';

let root: string;
let vault: { dir: string; platform: NodeJS.Platform };
let key: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-ftp-'));
  // Modo arquivo: o mesmo caminho do Linux, rápido (o DPAPI tem teste próprio).
  vault = { dir: path.join(root, 'secrets'), platform: 'linux' };
  key = path.join(root, 'id_teste');
  await fs.writeFile(key, 'x');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const project = async (name: string) => {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};
const ftp = (over: Record<string, unknown> = {}) => ({ name: 'site', protocol: 'ftps', host: 'ftp.example.com', user: 'deploy@example.com', remoteRoot: '/public_html/', password: PASSWORD, ...over });

/** Tudo o que sai para a tela e para os arquivos do projeto, junto, para procurar a senha. */
async function everything(dir: string, extra: unknown[] = []): Promise<string> {
  const files = await fs.readdir(path.join(dir, '.vps')).catch(() => [] as string[]);
  const contents = await Promise.all(files.map((f) => fs.readFile(path.join(dir, '.vps', f), 'utf8')));
  return JSON.stringify([contents, await readFtpConnections(dir, vault), await listFtpServers(dir, vault), ...extra]);
}

describe('conexões FTP: cadastro', () => {
  it('validação estrita (host, nome, usuário, pasta, protocolo, senha)', () => {
    const bad = [
      { host: 'ftp.com\r\nUSER x' },
      { host: '-x' },
      { name: '../x' },
      { name: 'a b' },
      { user: 'eu mesmo' },
      { user: 'x\r\nDELE /' },
      { protocol: 'sftp' },
      { port: 0 },
      { remoteRoot: 'public_html' },
      { remoteRoot: '/a b' },
      { password: 'a\r\nDELE x' },
    ];
    for (const over of bad) expect(FtpInput.safeParse(ftp(over)).success, JSON.stringify(over)).toBe(false);
    const ok = FtpInput.parse(ftp({ protocol: undefined, port: undefined, remoteRoot: '' }));
    expect(ok).toMatchObject({ protocol: 'ftps', port: 21, remoteRoot: null, user: 'deploy@example.com' });
  });

  it('salva sem senha no arquivo, a senha no cofre; a lista só diz hasPassword', async () => {
    const dir = await project('salvar');
    const saved = await saveFtpConnection(dir, ftp(), vault);
    expect(saved).toEqual({ protocol: 'ftps', name: 'site', host: 'ftp.example.com', port: 21, user: 'deploy@example.com', remoteRoot: '/public_html', hasPassword: true });
    expect(await getSecret(ftpSecretId(dir, 'site'), vault)).toBe(PASSWORD);
    const file = JSON.parse(await fs.readFile(path.join(dir, '.vps', 'ftp.json'), 'utf8'));
    expect(file.connections.site).toEqual({ protocol: 'ftps', host: 'ftp.example.com', port: 21, user: 'deploy@example.com', remoteRoot: '/public_html' });
    expect(await fs.readFile(path.join(dir, '.vps', '.gitignore'), 'utf8')).toBe('*\n');
    // Para a ficha: sem usuário.
    expect(await listFtpServers(dir, vault)).toEqual([{ name: 'site', source: 'ftp', protocol: 'ftps', host: 'ftp.example.com', remoteRoot: '/public_html' }]);
    expect(await everything(dir, [saved])).not.toContain(PASSWORD);
  });

  it('criar exige senha; editar sem senha mantém; renomear leva a senha; apagar apaga a senha', async () => {
    const dir = await project('editar');
    await expect(saveFtpConnection(dir, ftp({ password: undefined }), vault)).rejects.toThrow('informe a senha');
    await saveFtpConnection(dir, ftp(), vault);
    await expect(saveFtpConnection(dir, ftp(), vault)).rejects.toThrow('já existe');
    // Edita só o host: senha fica.
    await saveFtpConnection(dir, ftp({ host: 'novo.example.com', password: '', originalName: 'site' }), vault);
    expect(await getSecret(ftpSecretId(dir, 'site'), vault)).toBe(PASSWORD);
    // Renomeia: a senha vai junto, a antiga some.
    const renamed = await saveFtpConnection(dir, ftp({ name: 'loja', password: undefined, originalName: 'site' }), vault);
    expect(renamed).toMatchObject({ name: 'loja', host: 'ftp.example.com', hasPassword: true });
    expect(await hasSecret(ftpSecretId(dir, 'site'), vault)).toBe(false);
    expect(await getSecret(ftpSecretId(dir, 'loja'), vault)).toBe(PASSWORD);
    // Renomeia trocando a senha.
    await saveFtpConnection(dir, ftp({ name: 'loja2', password: 'outra-senha', originalName: 'loja' }), vault);
    expect(await hasSecret(ftpSecretId(dir, 'loja'), vault)).toBe(false);
    expect(await getSecret(ftpSecretId(dir, 'loja2'), vault)).toBe('outra-senha');
    await expect(saveFtpConnection(dir, ftp({ originalName: 'nao-existe' }), vault)).rejects.toThrow('não encontrada');

    expect(await removeFtpConnection(dir, 'loja2', vault)).toBe(true);
    expect(await removeFtpConnection(dir, 'loja2', vault)).toBe(false);
    expect(await hasSecret(ftpSecretId(dir, 'loja2'), vault)).toBe(false);
    expect(await readFtpConnections(dir, vault)).toEqual([]);
  });

  it('nome único entre SSH e FTP (o config.json da skill vps não muda)', async () => {
    const dir = await project('unico');
    await saveConnection(dir, { name: 'prod', host: '10.0.0.1', port: 22, user: 'deploy', identityFile: key, remoteRoot: null });
    const vpsBefore = await fs.readFile(path.join(dir, '.vps', 'config.json'), 'utf8');
    await expect(saveFtpConnection(dir, ftp({ name: 'PROD' }), vault)).rejects.toThrow('conexão SSH');
    await saveFtpConnection(dir, ftp(), vault);
    expect(await fs.readFile(path.join(dir, '.vps', 'config.json'), 'utf8')).toBe(vpsBefore);
  });
});

describe('conexões FTP: teste e erros', () => {
  const conn: FtpConnection = { protocol: 'ftps', name: 'site', host: 'ftp.example.com', port: 21, user: 'u', remoteRoot: '/public_html', hasPassword: true };

  it('testar: conecta, lista a pasta da conexão e explica a falha (sem a senha)', async () => {
    const dir = await project('testar');
    await saveFtpConnection(dir, ftp(), vault);
    const listed: string[] = [];
    const good: FtpConnector = async (_c, pw) => {
      expect(pw).toBe(PASSWORD);
      return { list: async (d: string) => (listed.push(d), [{ name: 'index.html', type: 'file', size: 1, modifiedAt: null }]), close: () => {} } as unknown as FtpSession;
    };
    const ok = await testFtpConnection(dir, 'site', { vault, connect: good });
    expect(ok).toEqual({ ok: true, message: 'conectou em deploy@example.com@ftp.example.com (FTPS); /public_html: 1 itens.' });
    expect(listed).toEqual(['/public_html']);

    const denied = await testFtpConnection(dir, 'site', {
      vault,
      connect: async () => {
        throw Object.assign(new Error(`530 Login incorrect for ${PASSWORD}`), { code: 530 });
      },
    });
    expect(denied).toEqual({ ok: false, message: 'o servidor recusou o usuário ou a senha' });

    // Prazo: o servidor não responde.
    const slow = await testFtpConnection(dir, 'site', { vault, timeoutMs: 50, connect: () => new Promise(() => {}) });
    expect(slow.message).toContain('não respondeu');
    await expect(testFtpConnection(dir, 'sumiu', { vault })).rejects.toThrow('não encontrada');
  });

  it('certificado inválido é erro claro, nunca aceito sozinho', () => {
    expect(explainFtpError(Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), conn)).toContain('não é confiável');
    expect(explainFtpError(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), conn)).toContain('não é de ftp.example.com');
    expect(explainFtpError(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }), conn)).toContain('venceu');
    expect(explainFtpError(Object.assign(new Error('500 AUTH not understood'), { code: 500, ftpStage: 'tls' }), conn)).toContain('não aceita FTPS');
    expect(explainFtpError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), conn)).toBe('conexão recusada na porta 21');
    expect(explainFtpError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), conn)).toContain('host não encontrado');
    expect(explainFtpError(new Error(`algo com ${PASSWORD} no meio`), conn, PASSWORD)).not.toContain(PASSWORD);
  });

  it('basic-ftp de verdade contra um servidor local: FTPS recusado e senha errada, em palavras', async () => {
    // Servidor FTP mínimo em 127.0.0.1: recusa AUTH TLS e qualquer senha.
    const commands: string[] = [];
    const srv = net.createServer((sock) => {
      sock.write('220 teste\r\n');
      sock.on('data', (d) => {
        for (const line of d.toString().split('\r\n').filter(Boolean)) {
          commands.push(line.split(' ')[0]!);
          const cmd = line.split(' ')[0]!.toUpperCase();
          sock.write(cmd === 'AUTH' ? '500 sem TLS\r\n' : cmd === 'USER' ? '331 senha\r\n' : cmd === 'PASS' ? '530 Login incorrect.\r\n' : '200 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const dir = await project('real');
      await saveFtpConnection(dir, ftp({ name: 'tls', host: '127.0.0.1', port }), vault);
      await saveFtpConnection(dir, ftp({ name: 'puro', protocol: 'ftp', host: '127.0.0.1', port }), vault);
      expect((await testFtpConnection(dir, 'tls', { vault, timeoutMs: 5000 })).message).toContain('não aceita FTPS');
      // Sem TLS não houve login: a senha não saiu.
      expect(commands).not.toContain('PASS');
      const plain = await testFtpConnection(dir, 'puro', { vault, timeoutMs: 5000 });
      expect(plain).toEqual({ ok: false, message: 'o servidor recusou o usuário ou a senha' });
    } finally {
      srv.close();
    }
  });

  it('servidor que não responde: o basic-ftp desiste no prazo', async () => {
    const srv = net.createServer((sock) => sock.on('error', () => {}));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const err = await basicFtpConnector({ ...conn, host: '127.0.0.1', port }, 'x', 300).catch((e: unknown) => e);
      expect(explainFtpError(err, { ...conn, port })).toBe(`o servidor não respondeu na porta ${port}`);
    } finally {
      srv.close();
    }
  });

  it('tenta de novo só falha passageira; disjuntor depois de 3 falhas seguidas', async () => {
    let calls = 0;
    const flaky: FtpConnector = async () => {
      if (++calls < 3) throw Object.assign(new Error('x'), { code: 'ECONNRESET' });
      return { close: () => {} } as unknown as FtpSession;
    };
    await connectWithRetry(flaky, conn, 'p', 1000, { wait: async () => {} });
    expect(calls).toBe(3);
    calls = 0;
    const auth: FtpConnector = async () => {
      calls++;
      throw Object.assign(new Error('530'), { code: 530 });
    };
    await expect(connectWithRetry(auth, conn, 'p', 1000, { wait: async () => {} })).rejects.toThrow();
    expect(calls).toBe(1); // senha errada não é repetida

    let now = 0;
    const b = new FtpBreaker(3, 30_000, () => now);
    for (let i = 0; i < 3; i++) b.fail('site');
    expect(() => b.check('site')).toThrow('espere 30 s');
    now = 30_001;
    expect(() => b.check('site')).not.toThrow();
  });
});

describe('caminho remoto preso à pasta da conexão', () => {
  it('normaliza e recusa o que escapa', () => {
    expect(resolveRemote('/public_html', '/public_html', 'css/a.css')).toBe('/public_html/css/a.css');
    expect(resolveRemote('/public_html', '/public_html', '/public_html/x/')).toBe('/public_html/x');
    expect(resolveRemote('/public_html', '/public_html', 'a/../b')).toBe('/public_html/b');
    for (const bad of ['../etc/passwd', '/etc/passwd', '..\\..\\etc', '/public_html/../x', '/public_htmlx/a', 'a\r\nDELE /', '']) {
      expect(() => resolveRemote('/public_html', '/public_html', bad), JSON.stringify(bad)).toThrow();
    }
    // Sem pasta na conexão: relativo à pasta de login, sem limite.
    expect(resolveRemote(null, '/home/u', 'site/a')).toBe('/home/u/site/a');
    expect(resolveRemote(null, '/home/u', '/etc')).toBe('/etc');
  });
});
