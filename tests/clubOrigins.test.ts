import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import { originsDir, pidAlive, registeredOrigins, registeredPorts, registerOrigin } from '../scripts/hooks/club-origins.mjs';
import { clubBlockedOrigins, registeredClubPorts, registerClubServer } from '../server/clubAddress';
import { cleanBrowserOf, codexChromeOf } from '../server/staff/launch';
import { removeTemp } from './support/tmp';

// O navegador dos funcionários não abre a tela do Club por origem nenhuma: a porta do servidor, o Vite do `npm run dev` (127.0.0.1:5173, com proxy de
// /api para o servidor) e os nomes claudio.localhost / myco.localhost. A prévia de interface (127.0.0.1:5199) e uma instância isolada seguem abertas.
// As origens ficam no registro de scripts/hooks/club-origins.mjs; o hook (club-guard.mjs) o relê a cada chamada.

let root: string;
let hooksDir: string;
let n = 0;
/** Um MYCO_HOME de teste (a pasta `run/origins` fica dentro dele). */
const newHome = async () => {
  const home = path.join(root, `home-${n++}`);
  await fs.mkdir(home, { recursive: true });
  return home;
};
/** PID de um processo que já saiu (o registro dele é lixo). */
const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
};
const writeRecord = async (home: string, name: string, rec: unknown) => {
  const dir = originsDir({ MYCO_HOME: home });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), typeof rec === 'string' ? rec : JSON.stringify(rec));
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-origins-'));
  // A cópia dos hooks como a conversa a leva (prepareRun copia os dois arquivos para a mesma pasta): o import relativo tem de funcionar lá.
  hooksDir = path.join(root, 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  const src = fileURLToPath(new URL('../scripts/hooks/', import.meta.url));
  for (const f of ['club-guard.mjs', 'club-origins.mjs']) await fs.copyFile(path.join(src, f), path.join(hooksDir, f));
});
afterAll(() => removeTemp(root));

const hook = () => path.join(hooksDir, 'club-guard.mjs');
const run = (input: unknown, env: Record<string, string>) =>
  execFileSync(process.execPath, [hook(), 'pre'], { input: JSON.stringify(input), env: { ...process.env, ...env } }).toString();
const denied = (out: string) => out !== '' && JSON.parse(out).hookSpecificOutput?.permissionDecision === 'deny';
const nav = (url: string) => ({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url } });

describe('registro de origens (club-origins.mjs)', () => {
  it('grava a origem de quem serve, lê de volta e apaga ao desregistrar', async () => {
    const dir = originsDir({ MYCO_HOME: await newHome() });
    const off = registerOrigin({ kind: 'vite', port: 5173, proxyTo: 4848 }, dir);
    expect(off).toBeTypeOf('function');
    expect(registeredOrigins(dir)).toEqual([{ kind: 'vite', port: 5173, proxyTo: 4848, pid: process.pid }]);
    expect(registeredPorts(dir)).toEqual([5173]);
    off!();
    expect(registeredPorts(dir)).toEqual([]);
  });

  it('só vale quem está vivo: o registro de processo morto some (e é apagado)', async () => {
    const home = await newHome();
    await writeRecord(home, 'vite-5173.json', { kind: 'vite', port: 5173, pid: deadPid() });
    await writeRecord(home, 'server-4900.json', { kind: 'server', port: 4900, pid: process.pid });
    const dir = originsDir({ MYCO_HOME: home });
    expect(registeredPorts(dir)).toEqual([4900]);
    await expect(fs.stat(path.join(dir, 'vite-5173.json'))).rejects.toThrow();
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
  });

  it('lixo no registro não derruba nem entra: JSON quebrado, porta inválida, tipo desconhecido, pasta ausente', async () => {
    const home = await newHome();
    await writeRecord(home, 'a.json', 'não é json');
    await writeRecord(home, 'b.json', { kind: 'vite', port: 99999, pid: process.pid });
    await writeRecord(home, 'c.json', { kind: 'outro', port: 5173, pid: process.pid });
    await writeRecord(home, 'd.txt', { kind: 'vite', port: 5173, pid: process.pid });
    expect(registeredPorts(originsDir({ MYCO_HOME: home }))).toEqual([]);
    expect(registeredPorts(path.join(root, 'nao-existe'))).toEqual([]);
    expect(registerOrigin({ kind: 'vite', port: 0 } as never, originsDir({ MYCO_HOME: home }))).toBeNull();
  });

  it('quem desregistra só apaga o que é seu (outro processo tomou a porta)', async () => {
    const home = await newHome();
    const dir = originsDir({ MYCO_HOME: home });
    const off = registerOrigin({ kind: 'vite', port: 5173 }, dir);
    await writeRecord(home, 'vite-5173.json', { kind: 'vite', port: 5173, pid: process.ppid });
    off!();
    expect(registeredOrigins(dir, () => true)).toHaveLength(1);
  });
});

describe('club-guard: o Vite do dev (127.0.0.1:5173, com proxy para o servidor) fica barrado', () => {
  it('1. 127.0.0.1:<porta do Vite> e localhost:<mesma porta> barrados, em qualquer forma do endereço', async () => {
    const home = await newHome();
    await writeRecord(home, 'vite-5173.json', { kind: 'vite', port: 5173, proxyTo: 4848, pid: process.pid });
    const env = { MYCO_HOME: home, MYCO_PORT: '4848' };
    for (const url of [
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5173/#/settings',
      'http://localhost:5173/',
      '127.0.0.1:5173',
      'http://127.1:5173',
      'http://[::1]:5173',
      'http://127.0.0.1:05173/',
      'http://127.0.0.1%3A5173',
      'HTTP://LOCALHOST:5173',
    ]) {
      const out = run(nav(url), env);
      expect(denied(out), url).toBe(true);
      expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toContain('[MyCo]');
    }
    // também por código do javascript_tool e por ação aninhada
    expect(denied(run({ tool_name: 'mcp__claude-in-chrome__javascript_tool', tool_input: { text: "location.href='http://127.0.0.1:5173'" } }, env))).toBe(true);
    expect(denied(run({ tool_name: 'mcp__playwright__browser_run_code', tool_input: { actions: [{ goto: ['http://localhost:5173'] }] } }, env))).toBe(true);
  });

  it('um Vite que sobe depois da conversa também vale (o registro é relido a cada chamada)', async () => {
    const home = await newHome();
    const env = { MYCO_HOME: home, MYCO_PORT: '4848' };
    expect(run(nav('http://127.0.0.1:5180'), env)).toBe('');
    await writeRecord(home, 'vite-5180.json', { kind: 'vite', port: 5180, proxyTo: 4848, pid: process.pid });
    expect(denied(run(nav('http://127.0.0.1:5180'), env))).toBe(true);
  });

  it('2. a prévia de interface (127.0.0.1:5199, sem servidor) continua abrindo, com o Vite do dev registrado', async () => {
    const home = await newHome();
    await writeRecord(home, 'vite-5173.json', { kind: 'vite', port: 5173, proxyTo: 4848, pid: process.pid });
    const env = { MYCO_HOME: home, MYCO_PORT: '4848' };
    for (const url of ['http://127.0.0.1:5199', 'http://localhost:5199/', 'http://127.0.0.1:5199/#/quadro']) expect(run(nav(url), env), url).toBe('');
  });

  it('2. uma instância isolada (MYCO_HOME próprio, outra porta) abre: o registro dela não é o do Club', async () => {
    const real = await newHome();
    const isolada = await newHome();
    // O servidor e o Vite da instância de teste gravam na pasta dela; o hook do Club real só lê a do Club real.
    await writeRecord(isolada, 'server-4950.json', { kind: 'server', port: 4950, pid: process.pid });
    await writeRecord(isolada, 'vite-5180.json', { kind: 'vite', port: 5180, proxyTo: 4950, pid: process.pid });
    const env = { MYCO_HOME: real, MYCO_PORT: '4848' };
    for (const url of ['http://127.0.0.1:4950', 'http://127.0.0.1:5180', 'http://localhost:5180/#/settings']) expect(run(nav(url), env), url).toBe('');
    // ... e a porta do Club real segue barrada
    expect(denied(run(nav('http://127.0.0.1:4848'), env))).toBe(true);
  });

  it('3. claudio.localhost em qualquer porta e a porta do servidor seguem barrados (com e sem registro)', async () => {
    const vazio = { MYCO_HOME: await newHome(), MYCO_PORT: '4848' };
    const home = await newHome();
    await writeRecord(home, 'vite-5173.json', { kind: 'vite', port: 5173, proxyTo: 4848, pid: process.pid });
    await writeRecord(home, 'server-4848.json', { kind: 'server', port: 4848, pid: process.pid });
    const comRegistro = { MYCO_HOME: home, MYCO_PORT: '4848' };
    for (const env of [vazio, comRegistro]) {
      for (const url of ['http://claudio.localhost:5173', 'http://claudio.localhost:4848/', 'http://claudio.localhost', 'http://myco.localhost:5173', 'http://localhost:4848/api/inbox', 'http://127.0.0.1:4848', 'http://[::1]:4848']) {
        expect(denied(run(nav(url), env)), `${url} (${env.MYCO_HOME === home ? 'com' : 'sem'} registro)`).toBe(true);
      }
    }
  });

  it('o projeto do funcionário em outra porta, e o registro de processo morto, não barram', async () => {
    const home = await newHome();
    await writeRecord(home, 'vite-5173.json', { kind: 'vite', port: 5173, proxyTo: 4848, pid: deadPid() });
    const env = { MYCO_HOME: home, MYCO_PORT: '4848' };
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://localhost:51730', 'http://localhost:05174', 'https://example.com']) expect(run(nav(url), env), url).toBe('');
  });
});

describe('clubBlockedOrigins: o --blocked-origins do Playwright (Codex e navegador limpo)', () => {
  it('sem portas extras, igual ao que era', () => {
    expect(clubBlockedOrigins(4848)).toBe('http://claudio.localhost:*;http://myco.localhost:*;http://localhost:4848;http://127.0.0.1:4848');
    expect(clubBlockedOrigins(4848, [])).toBe(clubBlockedOrigins(4848));
  });

  it('1. com o Vite registrado, localhost e 127.0.0.1 na porta dele entram (sem repetir a do servidor)', () => {
    expect(clubBlockedOrigins(4848, [5173, 4848, 5173])).toBe(
      'http://claudio.localhost:*;http://myco.localhost:*;http://localhost:4848;http://127.0.0.1:4848;http://localhost:5173;http://127.0.0.1:5173',
    );
    expect(clubBlockedOrigins(4848, [5173])).not.toContain('5199');
  });

  const CLI = fileURLToPath(import.meta.url); // qualquer arquivo que exista: o MCP só confere a existência
  const blocked = (args: string[] | undefined) => (args?.includes('--blocked-origins') ? args[args.indexOf('--blocked-origins') + 1] : undefined);

  it('o Codex (Chrome do dono) e o navegador limpo levam as origens registradas na hora de subir', () => {
    const ports = [5173];
    const chrome = codexChromeOf({ browser: true }, { codexBrowser: true, chromeMcpCli: CLI, clubPorts: ports }, false, root).mcp;
    expect(blocked(chrome?.args)).toBe(clubBlockedOrigins(undefined, ports));
    expect(blocked(chrome?.args)).toContain('http://127.0.0.1:5173');
    const limpo = cleanBrowserOf(true, { chromeMcpCli: CLI, cleanBrowserChannel: 'chrome', clubPorts: ports }, false, root).mcp;
    expect(limpo).not.toBeNull();
    expect(JSON.stringify(limpo?.args)).toContain('http://127.0.0.1:5173');
    expect(JSON.stringify(limpo?.args)).toContain('http://localhost:5173');
    expect(JSON.stringify(limpo?.args)).not.toContain('5199');
  });

  it('com o bloqueio desligado nas Configurações, nada disso entra; sem portas, o que já era', () => {
    expect(blocked(codexChromeOf({ browser: true }, { codexBrowser: true, chromeMcpCli: CLI, clubGuard: false, clubPorts: [5173] }, false, root).mcp?.args)).toBeUndefined();
    expect(blocked(codexChromeOf({ browser: true }, { codexBrowser: true, chromeMcpCli: CLI }, false, root).mcp?.args)).toBe(clubBlockedOrigins());
  });

  it('registeredClubPorts lê o registro do MYCO_HOME atual, sem a porta do servidor', async () => {
    const home = await newHome();
    await writeRecord(home, 'vite-5173.json', { kind: 'vite', port: 5173, proxyTo: 4848, pid: process.pid });
    await writeRecord(home, 'server-4848.json', { kind: 'server', port: 4848, pid: process.pid });
    const before = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    try {
      expect(registeredClubPorts()).toEqual([5173]);
    } finally {
      if (before === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = before;
    }
  });
});

describe('o servidor do Club grava a origem que serve', () => {
  it('registerClubServer grava a porta dele no MYCO_HOME atual e apaga ao desregistrar', async () => {
    const home = await newHome();
    const before = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    try {
      const off = registerClubServer(4900);
      expect(registeredOrigins(originsDir({ MYCO_HOME: home }))).toEqual([{ kind: 'server', port: 4900, pid: process.pid }]);
      off!();
      expect(registeredPorts(originsDir({ MYCO_HOME: home }))).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = before;
    }
  });
});

describe('vite.config.ts: o Vite do dev grava a origem que serve', () => {
  it('ao abrir a porta, registra porta + proxy para o servidor; ao fechar, apaga', async () => {
    const home = await newHome();
    const before = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    const vite = await createServer({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      logLevel: 'silent',
      server: { port: 0, strictPort: false, watch: null, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      await vite.listen();
      const port = (vite.httpServer!.address() as { port: number }).port;
      const dir = originsDir({ MYCO_HOME: home });
      expect(registeredOrigins(dir)).toEqual([{ kind: 'vite', port, proxyTo: Number(process.env.MYCO_PORT ?? 4848), pid: process.pid }]);
      // o hook vê o endereço que o Vite abriu
      expect(denied(run(nav(`http://127.0.0.1:${port}`), { MYCO_HOME: home, MYCO_PORT: '4848' }))).toBe(true);
      await vite.close();
      expect(registeredPorts(dir)).toEqual([]);
    } finally {
      await vite.close().catch(() => {});
      if (before === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = before;
    }
  }, 60_000);

  it('a prévia de interface (vite.preview.config.ts) não registra nada', async () => {
    const text = await fs.readFile(fileURLToPath(new URL('../vite.preview.config.ts', import.meta.url)), 'utf8');
    expect(text).not.toContain('club-origins');
    expect(text).not.toMatch(/proxy\s*:\s*\{/);
  });
});
