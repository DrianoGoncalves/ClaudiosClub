import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { SessionTokens } from '../server/callers';
import {
  cleanPath,
  PICK_TIMEOUT_MS,
  PickerBusyError,
  pickFolder,
  readLinux,
  readMac,
  readWindows,
  runTool,
  toolsFor,
  windowsScript,
  type RunResult,
  type Runner,
} from '../server/folderPicker';
import { gate } from '../server/gate';
import { Pairing } from '../server/pairing';

// "Novo projeto → pasta que já existe": o servidor abre a janela nativa e devolve o caminho. Nada aqui abre janela de verdade: o que roda é
// trocado por um `runner` falso. (A janela do Windows foi aberta de verdade à parte: ver a entrega da tarefa.)

const run = (over: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, missing: false, ...over });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const ROUTE = '/api/new-project/pick-folder';

/** Um runner que responde por programa e guarda o que foi pedido. */
function fake(answers: Record<string, RunResult>): { runner: Runner; calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> } {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = [];
  const runner: Runner = async (cmd, args, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    return answers[path.basename(cmd)] ?? run({ missing: true });
  };
  return { runner, calls };
}

describe('Windows: o comando', () => {
  it('PowerShell -STA com o script codificado, sem -Command: o que roda é só o script constante', () => {
    const [tool, ...rest] = toolsFor('win32', { SystemRoot: 'C:\\Windows' });
    expect(rest).toEqual([]);
    expect(tool!.cmd).toMatch(/powershell(\.exe)?$/i);
    expect(tool!.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass']);
    expect(tool!.args[5]).toBe('-EncodedCommand');
    expect(tool!.args).toHaveLength(7);
    expect(tool!.args).not.toContain('-Command');
    expect(Buffer.from(tool!.args[6]!, 'base64').toString('utf16le')).toBe(windowsScript());
  });

  it('o script abre a janela de pasta (IFileDialog) por um dono TopMost e devolve o caminho em base64', () => {
    const s = windowsScript();
    expect(s).toContain('FOS_PICKFOLDERS');
    expect(s).toContain('owner.TopMost = true');
    expect(s).toContain('SetForegroundWindow');
    expect(s).toContain("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))");
    expect(s).toContain("'CANCEL'");
    // Nada de tecla sintética: um Alt apertado cairia no navegador que está à frente.
    expect(s).not.toContain('keybd_event');
  });

  it('nada do ambiente nem do pedido entra no comando: o mesmo script com qualquer env (só o caminho do exe muda)', () => {
    const a = toolsFor('win32', { SystemRoot: 'C:\\Windows' })[0]!.args;
    const b = toolsFor('win32', { SystemRoot: 'D:\\Outro', PATH: '"; calc; "', USERNAME: '$(calc)', TEMP: "x'; calc; '" })[0]!.args;
    expect(b).toEqual(a);
    expect(windowsScript()).toBe(windowsScript());
  });
});

describe('Windows: a saída', () => {
  it('OK:<base64> vira o caminho, com acento e espaço', () => {
    const p = 'C:\\Users\\Ana\\Área João\\loja';
    expect(readWindows(run({ stdout: `OK:${b64(p)}\r\n` }))).toEqual({ path: p });
    // Linha de aviso antes da resposta não atrapalha.
    expect(readWindows(run({ stdout: `aviso qualquer\r\nOK:${b64(p)}\r\n` }))).toEqual({ path: p });
  });

  it('CANCEL é cancelado; raiz de unidade fica como está; barra final sai', () => {
    expect(readWindows(run({ stdout: 'CANCEL\r\n' }))).toEqual({ cancelled: true });
    expect(readWindows(run({ stdout: `OK:${b64('C:\\')}\r\n` }))).toEqual({ path: 'C:\\' });
    expect(readWindows(run({ stdout: `OK:${b64('D:\\obras\\')}\r\n` }))).toEqual({ path: 'D:\\obras' });
    expect(readWindows(run({ stdout: `OK:${b64('\\\\servidor\\pasta\\proj')}\r\n` }))).toEqual({ path: '\\\\servidor\\pasta\\proj' });
  });

  it('falha: código diferente de 0, saída vazia, lixo, base64 inválido, caminho relativo ou com caractere de controle', () => {
    expect(readWindows(run({ code: 1, stderr: 'erro', stdout: `OK:${b64('C:\\x')}` }))).toBeNull();
    expect(readWindows(run({ stdout: '' }))).toBeNull();
    expect(readWindows(run({ stdout: 'qualquer coisa' }))).toBeNull();
    expect(readWindows(run({ stdout: 'OK:@@@@' }))).toBeNull();
    expect(readWindows(run({ stdout: `OK:${b64('relativo\\pasta')}` }))).toBeNull();
    expect(readWindows(run({ stdout: `OK:${b64('C:\\a\nb')}` }))).toBeNull();
    expect(readWindows(run({ stdout: `OK:${b64('')}` }))).toBeNull();
  });
});

describe('macOS (osascript)', () => {
  it('um -e por linha do AppleScript fixo: choose folder dentro do System Events', () => {
    const [tool, ...rest] = toolsFor('darwin', {});
    expect(rest).toEqual([]);
    expect(tool!.cmd).toBe('osascript');
    const lines = tool!.args.filter((_, i) => i % 2 === 1);
    expect(tool!.args.filter((_, i) => i % 2 === 0).every((a) => a === '-e')).toBe(true);
    expect(lines).toContain('tell application "System Events"');
    expect(lines.join('\n')).toContain('POSIX path of (choose folder with prompt "Escolha a pasta do projeto")');
    expect(lines.at(-1)).toBe('return p');
    expect(toolsFor('darwin', { HOME: '"; do shell script "rm -rf /' })[0]!.args).toEqual(tool!.args);
  });

  it('lê o caminho (sem a barra final), o cancelamento (-128) e a falha', () => {
    expect(readMac(run({ stdout: '/Users/ana/Projetos/loja/\n' }))).toEqual({ path: '/Users/ana/Projetos/loja' });
    expect(readMac(run({ stdout: '/\n' }))).toEqual({ path: '/' });
    expect(readMac(run({ code: 1, stderr: '0:42: execution error: User canceled. (-128)\n' }))).toEqual({ cancelled: true });
    expect(readMac(run({ code: 1, stderr: 'execution error: não autorizado (-1743)' }))).toBeNull();
    expect(readMac(run({ stdout: 'relativo/pasta\n' }))).toBeNull();
    expect(readMac(run({ stdout: '' }))).toBeNull();
  });
});

describe('Linux (zenity ou kdialog)', () => {
  it('sem tela (nem DISPLAY nem WAYLAND_DISPLAY) não há o que abrir', () => {
    expect(toolsFor('linux', {})).toEqual([]);
    expect(toolsFor('linux', { DISPLAY: '' })).toEqual([]);
  });

  it('com tela: zenity e depois kdialog, só com argumentos fixos', () => {
    for (const env of [{ DISPLAY: ':0' }, { WAYLAND_DISPLAY: 'wayland-0' }]) {
      const tools = toolsFor('linux', env);
      expect(tools.map((t) => t.cmd)).toEqual(['zenity', 'kdialog']);
      expect(tools[0]!.args).toEqual(['--file-selection', '--directory', '--title=Escolha a pasta do projeto']);
      expect(tools[1]!.args).toEqual(['--getexistingdirectory', '--title', 'Escolha a pasta do projeto']);
    }
    expect(toolsFor('linux', { DISPLAY: ':0', HOME: "x'; rm -rf /; '" })[0]!.args).toEqual(toolsFor('linux', { DISPLAY: ':1' })[0]!.args);
  });

  it('lê o caminho (com acento, espaço e a quebra de linha do fim)', () => {
    expect(readLinux(run({ stdout: '/home/ana/Área de Trabalho/loja\n' }))).toEqual({ path: '/home/ana/Área de Trabalho/loja' });
    expect(readLinux(run({ stdout: '/home/ana/loja/\n' }))).toEqual({ path: '/home/ana/loja' });
    expect(readLinux(run({ stdout: 'relativo\n' }))).toBeNull();
  });

  it('fechar a janela (código 1, nada na saída) é cancelado, mesmo com aviso do GTK; sem tela é falha, não cancelamento', () => {
    expect(readLinux(run({ code: 1 }))).toEqual({ cancelled: true });
    expect(readLinux(run({ code: 1, stderr: 'Gtk-Message: Failed to load module "canberra-gtk-module"\n' }))).toEqual({ cancelled: true });
    expect(readLinux(run({ code: 1, stderr: 'Gtk-WARNING **: cannot open display: \n' }))).toBeNull();
    expect(readLinux(run({ code: 255, stderr: 'erro' }))).toBeNull();
    expect(readLinux(run({ code: 1, stdout: '/algo\n' }))).toBeNull();
  });
});

describe('cleanPath', () => {
  it('só caminho absoluto de uma linha; a barra final sai (menos na raiz)', () => {
    expect(cleanPath('/a/b/\n', 'linux')).toBe('/a/b');
    expect(cleanPath('/\n', 'darwin')).toBe('/');
    expect(cleanPath('C:\\a\\b\\\r\n', 'win32')).toBe('C:\\a\\b');
    expect(cleanPath('C:\\', 'win32')).toBe('C:\\');
    for (const bad of ['', '\n', 'a/b', '.', '..', '/a\u0000b', '/a\nb', '/a\u001bb']) expect(cleanPath(bad, 'linux'), JSON.stringify(bad)).toBeNull();
    expect(cleanPath('/a/b', 'win32')).toBe('/a/b'); // `/a/b` é absoluto no Windows também (sem unidade): a validação da criação decide
  });
});

describe('pickFolder', () => {
  it('Windows: devolve o caminho escolhido; o prazo vai ao runner (5 min por padrão)', async () => {
    const { runner, calls } = fake({ 'powershell.exe': run({ stdout: `OK:${b64('C:\\obras\\loja')}\r\n` }) });
    expect(PICK_TIMEOUT_MS).toBe(5 * 60_000);
    expect(await pickFolder({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, runner })).toEqual({ path: 'C:\\obras\\loja' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.timeoutMs).toBe(PICK_TIMEOUT_MS);
    expect(await pickFolder({ platform: 'win32', env: {}, runner, timeoutMs: 1234 })).toEqual({ path: 'C:\\obras\\loja' });
    expect(calls[1]!.timeoutMs).toBe(1234);
  });

  it('janela fechada sem escolher: { cancelled: true }', async () => {
    const win = fake({ 'powershell.exe': run({ stdout: 'CANCEL\r\n' }) });
    expect(await pickFolder({ platform: 'win32', env: {}, runner: win.runner })).toEqual({ cancelled: true });
    const mac = fake({ osascript: run({ code: 1, stderr: 'User canceled. (-128)' }) });
    expect(await pickFolder({ platform: 'darwin', env: {}, runner: mac.runner })).toEqual({ cancelled: true });
  });

  it('prazo estourado (o runner matou o processo): { cancelled: true }, sem ler a saída', async () => {
    const { runner } = fake({ 'powershell.exe': run({ code: null, timedOut: true, stdout: `OK:${b64('C:\\nao-vale')}` }) });
    expect(await pickFolder({ platform: 'win32', env: {}, runner })).toEqual({ cancelled: true });
  });

  it('sem ferramenta: { unsupported: true } (Linux sem tela, sem zenity nem kdialog, sistema que não conhecemos), sem rodar nada quando não há o que rodar', async () => {
    const none = fake({});
    expect(await pickFolder({ platform: 'linux', env: {}, runner: none.runner })).toEqual({ unsupported: true });
    expect(none.calls).toEqual([]); // sem tela, nem tenta
    expect(await pickFolder({ platform: 'linux', env: { DISPLAY: ':0' }, runner: none.runner })).toEqual({ unsupported: true });
    expect(none.calls.map((c) => c.cmd)).toEqual(['zenity', 'kdialog']);
    const freebsd = fake({});
    expect(await pickFolder({ platform: 'freebsd', env: { DISPLAY: ':0' }, runner: freebsd.runner })).toEqual({ unsupported: true });
    expect(freebsd.calls).toEqual([]);
    expect(await pickFolder({ platform: 'win32', env: {}, runner: none.runner })).toEqual({ unsupported: true }); // powershell.exe ausente
  });

  it('Linux: sem zenity usa o kdialog; o cancelamento de um não vai para o outro', async () => {
    const onlyKde = fake({ kdialog: run({ stdout: '/home/ana/loja\n' }) });
    expect(await pickFolder({ platform: 'linux', env: { DISPLAY: ':0' }, runner: onlyKde.runner })).toEqual({ path: '/home/ana/loja' });
    expect(onlyKde.calls.map((c) => c.cmd)).toEqual(['zenity', 'kdialog']);
    const cancelled = fake({ zenity: run({ code: 1 }), kdialog: run({ stdout: '/nao/deve/chegar\n' }) });
    expect(await pickFolder({ platform: 'linux', env: { DISPLAY: ':0' }, runner: cancelled.runner })).toEqual({ cancelled: true });
    expect(cancelled.calls.map((c) => c.cmd)).toEqual(['zenity']);
  });

  it('ferramenta que falha (sem tela, erro do sistema): tenta a próxima e, esgotadas, unsupported; o motivo vai ao log, só a 1ª linha', async () => {
    const log: string[] = [];
    const { runner } = fake({
      zenity: run({ code: 1, stderr: 'Gtk-WARNING **: cannot open display: :0\nsegunda linha com /home/ana/segredo\n' }),
      kdialog: run({ code: 255, stderr: 'kdialog: erro\n' }),
    });
    expect(await pickFolder({ platform: 'linux', env: { DISPLAY: ':0' }, runner, log: (l) => log.push(l) })).toEqual({ unsupported: true });
    expect(log).toHaveLength(2);
    expect(log[0]).toContain('zenity falhou');
    expect(log.join('\n')).not.toContain('segunda linha');
  });

  it('um por vez: o segundo pedido com a janela aberta é PickerBusyError (409 na rota) e, fechada a primeira, abre de novo', async () => {
    let release!: (r: RunResult) => void;
    const first: Runner = () => new Promise((resolve) => (release = resolve));
    const open = pickFolder({ platform: 'win32', env: {}, runner: first });
    const second = pickFolder({ platform: 'win32', env: {}, runner: fake({ 'powershell.exe': run({ stdout: 'CANCEL' }) }).runner });
    await expect(second).rejects.toBeInstanceOf(PickerBusyError);
    await expect(second).rejects.toMatchObject({ code: 'busy', message: expect.stringContaining('já há uma janela') });
    release(run({ stdout: `OK:${b64('C:\\um')}` }));
    expect(await open).toEqual({ path: 'C:\\um' });
    expect(await pickFolder({ platform: 'win32', env: {}, runner: fake({ 'powershell.exe': run({ stdout: 'CANCEL' }) }).runner })).toEqual({ cancelled: true });
  });

  it('o runner que estoura não deixa o seletor "aberto" para sempre', async () => {
    const boom: Runner = async () => {
      throw new Error('quebrou');
    };
    await expect(pickFolder({ platform: 'win32', env: {}, runner: boom })).rejects.toThrow('quebrou');
    expect(await pickFolder({ platform: 'win32', env: {}, runner: fake({ 'powershell.exe': run({ stdout: 'CANCEL' }) }).runner })).toEqual({ cancelled: true });
  });
});

describe('runTool (processo de verdade, sem janela)', () => {
  it('captura a saída e o código', async () => {
    const r = await runTool(process.execPath, ['-e', "process.stdout.write('ola'); process.stderr.write('erro'); process.exit(3)"], 20_000);
    expect(r).toMatchObject({ code: 3, stdout: 'ola', stderr: 'erro', timedOut: false, missing: false });
  });

  it('programa que não existe: missing', async () => {
    const r = await runTool(path.join(os.tmpdir(), 'nao-existe-myco-seletor'), [], 5_000);
    expect(r).toMatchObject({ missing: true, timedOut: false });
  });

  it('prazo: mata o processo e avisa timedOut', async () => {
    const r = await runTool(process.execPath, ['-e', "console.log(process.pid); setInterval(() => {}, 1000)"], 4_000);
    expect(r.timedOut).toBe(true);
    expect(r.code === null || r.code !== 0).toBe(true);
    const pid = Number(r.stdout.trim());
    // O processo não pode ter sobrado (se a máquina estava tão carregada que ele nem imprimiu o pid, não há o que conferir).
    if (pid > 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 30_000);
});

describe('a rota: só a tela chega', () => {
  it('fica fora das listas de funcionário e da sandbox do Codex (apiPolicy.ts)', () => {
    expect(staffMayPost(ROUTE)).toBe(false);
    expect(sandboxVerdict('POST', ROUTE, 'p1')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', ROUTE, 'p1')).toMatchObject({ status: 403 });
  });

  describe('pela porta de entrada de verdade', () => {
    let dir: string;
    let srv: http.Server;
    let base: string;
    let pairing: Pairing;
    const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', 'claudio.localhost']);

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-picker-'));
      pairing = new Pairing(path.join(dir, 'secrets', 'pairing.key'));
      srv = http.createServer((req, res) => {
        const g = gate(req, res, { pairing, tokens: new SessionTokens(), localHostnames: LOCAL, isLocalOrigin: (o) => !o || LOCAL.has(new URL(o).hostname), log: () => {} });
        if (!g) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ fromBrowser: g.fromBrowser }));
      });
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise((r) => srv.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const post = (headers: Record<string, string>): Promise<{ status: number; body: { error?: string; fromBrowser?: boolean } }> =>
      new Promise((resolve, reject) => {
        const req = http.request(`${base}${ROUTE}`, { method: 'POST', headers }, (res) => {
          let text = '';
          res.setEncoding('utf8').on('data', (d: string) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end('{}');
      });

    it('funcionário pela API (x-myco, sem Origin) leva 400 "só pelo Claudio’s Club" (token inventado é 401, conferido antes); só a tela pareada passa', async () => {
      expect(await post({ 'x-myco': '1' })).toEqual({ status: 400, body: { error: 'só pelo Claudio’s Club' } });
      expect((await post({ 'x-myco': '1', 'x-myco-token': 'f'.repeat(64) })).status).toBe(401);
      // Origin forjado sem o cookie do pareamento: recusado antes de chegar à rota.
      expect((await post({ 'x-myco': '1', origin: 'http://localhost:4848' })).status).toBe(403);
      // Sem x-myco: 403.
      expect((await post({})).status).toBe(403);
      const tela = await post({ 'x-myco': '1', origin: 'http://localhost:4848', cookie: pairing.setCookieHeader().split(';')[0]! });
      expect(tela).toEqual({ status: 200, body: { fromBrowser: true } });
    });
  });

  it('o código da rota: POST só da tela, sem corpo no comando, e o 409 sai com `code`', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const route = /\/\^\\\/api\\\/new-project\\\/pick-folder\$\/,([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(src).toMatch(/'POST',\s*\/\^\\\/api\\\/new-project\\\/pick-folder\$\//);
    expect(route).toContain("if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club')");
    expect(route).toContain('return pickFolder({ log:');
    // Nada do pedido entra: o handler nem lê o corpo, a URL, os parâmetros ou o cabeçalho.
    expect(route).not.toMatch(/\b(body|url|params|caller|userAgent)\b/);
    expect(src).toContain("if (err instanceof PickerBusyError) return send(res, 409, { error: err.message, code: err.code });");
  });
});
