import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { defaultLocations } from '../server/adapters/claude/paths';
import { codexDenyPaths } from '../server/chat/codexArgs';
import { MYCO_HOME } from '../server/config';
import { DEFAULT_SECRETS_DIR, deleteSecret, setSecret } from '../server/secretVault';
import { secretDenyRules } from '../server/staff/ficha';
import { buildMcpConfig, CLUB_MCP_FILE, clubSecretId } from '../server/staff/mcp';
import {
  defaultLaunchPaths,
  launchSpec,
  McpLaunchError,
  mcpLaunchCommand,
  parseLaunchArgs,
  refuseLaunchPaths,
  runMcpLaunchCli,
  type LaunchArgs,
  type LaunchPaths,
} from '../server/staff/mcpLaunch';
import { removeTemp } from './support/tmp';

// Os segredos da biblioteca do Club: nunca no mcp.json (a sessão lê), só no cofre, e o lançador os tira de lá ao subir.
// Tudo em pastas temporárias; o cofre usa o modo arquivo (platform linux), que lê em qualquer sistema.

const VALOR = 'valor-do-cofre-AB12cd34';
const HDR = 'Bearer tok-do-cofre-987zyx';
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-launch-'));
});
afterAll(() => removeTemp(root));

/** Uma biblioteca com um stdio (env no cofre), um http com cabeçalho e um http sem nada; os valores já no cofre. */
async function setup(extra: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(root, 'c-'));
  const proj = path.join(dir, 'projeto');
  await fs.mkdir(proj, { recursive: true });
  const claude = path.join(dir, 'claude.json');
  const club = path.join(dir, 'mcps.json');
  const vault = { dir: path.join(dir, 'secrets'), platform: 'linux' as const };
  await fs.writeFile(
    club,
    JSON.stringify({
      servers: {
        fs: { type: 'stdio', command: 'node', args: ['srv.js'], env: ['FS_TOKEN'] },
        web: { type: 'http', url: 'https://mcp.exemplo.com/mcp', headers: ['Authorization'] },
        aberto: { type: 'http', url: 'https://aberto.exemplo.com/mcp' },
        ...extra,
      },
    }),
  );
  await setSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), VALOR, vault);
  await setSecret(clubSecretId('web', 'header', 'Authorization'), HDR, vault);
  // A Global: o que a biblioteca grava no ~/.claude.json (a entrada que chama o lançador; ver clubEntry).
  await fs.writeFile(claude, JSON.stringify({ mcpServers: pointers(club, vault.dir) }));
  return { dir, proj, claude, club, vault };
}

/** As entradas do ~/.claude.json dos três servidores de `setup`, à mão (aceita `%` no caminho, que clubEntry recusa para o headersHelper). */
function pointers(clubFile: string, vaultDir: string) {
  const launch = mcpLaunchCommand();
  const tail = (name: string) => ['--server', name, '--club', clubFile, '--vault', vaultDir];
  return {
    fs: { type: 'stdio', command: launch.command, args: [...launch.args, ...tail('fs')] },
    web: {
      type: 'http',
      url: 'https://mcp.exemplo.com/mcp',
      headersHelper: [launch.command, ...launch.args, '--headers', ...tail('web')].map((p) => `"${p}"`).join(' '),
    },
    aberto: { type: 'http', url: 'https://aberto.exemplo.com/mcp' },
  };
}

describe('buildMcpConfig: a Global do Club sai sem valor', () => {
  it('nenhum valor do cofre vai para a configuração', async () => {
    const env = await setup();
    const cfg = await buildMcpConfig(env.proj, ['global:fs', 'global:web', 'global:aberto'], env.claude, { clubFile: env.club, vault: env.vault });
    const dump = JSON.stringify(cfg);
    expect(dump).not.toContain(VALOR);
    expect(dump).not.toContain('tok-do-cofre-987zyx');
  });

  it('stdio aponta para o lançador, com o nome, a biblioteca e o cofre; sem env', async () => {
    const env = await setup();
    const cfg = await buildMcpConfig(env.proj, ['global:fs'], env.claude, { clubFile: env.club, vault: env.vault });
    const launch = mcpLaunchCommand();
    expect(cfg.mcpServers.fs).toEqual({
      type: 'stdio',
      command: launch.command,
      args: [...launch.args, '--server', 'fs', '--club', env.club, '--vault', env.vault.dir],
    });
    expect(cfg.mcpServers.fs).not.toHaveProperty('env');
  });

  it('http com cabeçalho usa headersHelper com --headers; http sem cabeçalho fica como estava', async () => {
    const env = await setup();
    const cfg = await buildMcpConfig(env.proj, ['global:web', 'global:aberto'], env.claude, { clubFile: env.club, vault: env.vault });
    const web = cfg.mcpServers.web as { type: string; url: string; headers?: unknown; headersHelper?: string };
    expect(web.type).toBe('http');
    expect(web.url).toBe('https://mcp.exemplo.com/mcp');
    expect(web.headers).toBeUndefined();
    expect(web.headersHelper).toMatch(/^"[^"]+" /);
    expect(web.headersHelper).toContain('"--headers" "--server" "web" "--club" ');
    expect(cfg.mcpServers.aberto).toEqual({ type: 'http', url: 'https://aberto.exemplo.com/mcp' });
  });

  it('sem valor no cofre, o servidor fica de fora e o aviso não traz o valor', async () => {
    const env = await setup();
    await fs.rm(env.vault.dir, { recursive: true, force: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await buildMcpConfig(env.proj, ['global:fs', 'global:web'], env.claude, { clubFile: env.club, vault: env.vault });
    expect(cfg.mcpServers).toEqual({});
    const log = warn.mock.calls.flat().join(' ');
    expect(log).toContain('FS_TOKEN');
    expect(log).toContain('Authorization');
    expect(log).not.toContain(VALOR);
    warn.mockRestore();
  });

  it('caminho com % na pasta da biblioteca: o http com cabeçalho sai; o stdio segue', async () => {
    const env = await setup();
    const pct = path.join(env.dir, 'pct%x');
    await fs.mkdir(pct, { recursive: true });
    const club = path.join(pct, 'mcps.json');
    await fs.copyFile(env.club, club);
    // As entradas do ~/.claude.json apontam para a biblioteca nesse caminho (o Club mudou de pasta depois de gravá-las).
    await fs.writeFile(env.claude, JSON.stringify({ mcpServers: pointers(club, env.vault.dir) }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await buildMcpConfig(env.proj, ['global:fs', 'global:web'], env.claude, { clubFile: club, vault: env.vault });
    expect(Object.keys(cfg.mcpServers)).toEqual(['fs']);
    expect(warn.mock.calls.flat().join(' ')).toContain('web');
    warn.mockRestore();
  });
});

describe('launchSpec: o que o lançador sobe, do cofre e da biblioteca', () => {
  it('stdio: comando, argumentos e ambiente do cofre; http: cabeçalhos do cofre', async () => {
    const env = await setup();
    expect(await launchSpec('fs', { clubFile: env.club, vault: env.vault })).toEqual({ command: 'node', args: ['srv.js'], env: { FS_TOKEN: VALOR } });
    expect(await launchSpec('web', { clubFile: env.club, vault: env.vault })).toEqual({ headers: { Authorization: HDR } });
    expect(await launchSpec('aberto', { clubFile: env.club, vault: env.vault })).toEqual({ headers: {} });
  });

  it('nome inválido e servidor inexistente são recusados (inclusive __proto__)', async () => {
    const env = await setup();
    const o = { clubFile: env.club, vault: env.vault };
    await expect(launchSpec('../fs', o)).rejects.toThrow('nome de MCP inválido');
    await expect(launchSpec('com espaco', o)).rejects.toThrow('nome de MCP inválido');
    await expect(launchSpec('', o)).rejects.toThrow('nome de MCP inválido');
    await expect(launchSpec('nao-existe', o)).rejects.toThrow('não está na biblioteca');
    await expect(launchSpec('__proto__', o)).rejects.toThrow('não está na biblioteca');
  });

  it('valor que sumiu do cofre: erro com o nome da chave e sem valor', async () => {
    const env = await setup();
    await deleteSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault);
    const err = await launchSpec('fs', { clubFile: env.club, vault: env.vault }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpLaunchError);
    expect((err as Error).message).toContain('FS_TOKEN');
    expect((err as Error).message).not.toContain(VALOR);
  });

  it('o comando é o da biblioteca: a linha de comando não tem flag de comando', async () => {
    const env = await setup();
    const a = parseLaunchArgs(['--server', 'fs', '--command', 'evil', '--club', env.club, '--vault', env.vault.dir]);
    expect(a).not.toHaveProperty('command');
    expect(a).toMatchObject({ server: 'fs', headers: false, club: env.club, vault: env.vault.dir });
    expect(await launchSpec(a.server!, { clubFile: a.club, vault: { dir: a.vault } })).toMatchObject({ command: 'node', args: ['srv.js'] });
  });
});

/**
 * O ambiente do lançador como processo: o MYCO_HOME é a pasta do teste, e a biblioteca (mcps.json) e o cofre (secrets) de `setup` são os padrão
 * dele. O lançador não aceita `--club` nem `--vault` de outro lugar (ver refuseLaunchPaths).
 */
const HOME_OF = (env: { dir: string }): NodeJS.ProcessEnv => ({ ...process.env, MYCO_HOME: env.dir });

describe('o lançador de verdade (processo)', () => {
  /** Um script que grava o valor da env num arquivo e sai com 7. */
  async function fakeServer(dir: string) {
    const out = path.join(dir, 'saida.txt');
    const script = path.join(dir, 'mcp-falso.cjs');
    await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.FS_TOKEN ?? 'SEM');\nprocess.exit(7);\n`);
    return { out, script };
  }

  it('sobe o comando da biblioteca com o valor do cofre na env e repassa o código de saída', async () => {
    const env = await setup();
    const { out, script } = await fakeServer(env.dir);
    await fs.writeFile(env.club, JSON.stringify({ servers: { falso: { type: 'stdio', command: process.execPath, args: [script], env: ['FS_TOKEN'] } } }));
    await setSecret(clubSecretId('falso', 'env', 'FS_TOKEN'), VALOR, env.vault);
    const L = mcpLaunchCommand(false);
    const r = spawnSync(L.command, [...L.args, '--server', 'falso', '--club', env.club, '--vault', env.vault.dir], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: HOME_OF(env) });
    expect(r.status).toBe(7);
    expect(await fs.readFile(out, 'utf8')).toBe(VALOR);
    expect(`${r.stdout}${r.stderr}`).not.toContain(VALOR);
  }, 60_000);

  it('valor faltando: não sobe o comando, sai com 1 e diz o nome da chave no stderr', async () => {
    const env = await setup();
    const { out, script } = await fakeServer(env.dir);
    await fs.writeFile(env.club, JSON.stringify({ servers: { falso: { type: 'stdio', command: process.execPath, args: [script], env: ['FS_TOKEN'] } } }));
    const L = mcpLaunchCommand(false);
    const r = spawnSync(L.command, [...L.args, '--server', 'falso', '--club', env.club, '--vault', env.vault.dir], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: HOME_OF(env) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[myco-mcp]');
    expect(r.stderr).toContain('FS_TOKEN');
    await expect(fs.access(out)).rejects.toThrow();
  }, 60_000);

  it('comando que não existe: sai com erro (não com 0)', async () => {
    const env = await setup();
    await fs.writeFile(env.club, JSON.stringify({ servers: { falso: { type: 'stdio', command: 'comando-que-nao-existe-zz9' } } }));
    const L = mcpLaunchCommand(false);
    const r = spawnSync(L.command, [...L.args, '--server', 'falso', '--club', env.club, '--vault', env.vault.dir], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: HOME_OF(env) });
    expect(r.status).not.toBe(0);
  }, 60_000);

  it('--headers imprime só o JSON dos cabeçalhos do cofre', async () => {
    const env = await setup();
    const L = mcpLaunchCommand(false);
    const r = spawnSync(L.command, [...L.args, '--headers', '--server', 'web', '--club', env.club, '--vault', env.vault.dir], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: HOME_OF(env) });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: HDR });
  }, 60_000);

  it('--headers: stdio recusa (exit 1, stdout vazio); cabeçalho faltando também', async () => {
    const env = await setup();
    const L = mcpLaunchCommand(false);
    const base = [...L.args, '--club', env.club, '--vault', env.vault.dir];
    const stdio = spawnSync(L.command, [...base, '--headers', '--server', 'fs'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: HOME_OF(env) });
    expect(stdio.status).toBe(1);
    expect(stdio.stdout).toBe('');
    expect(stdio.stderr).toContain('não é http');
    await deleteSecret(clubSecretId('web', 'header', 'Authorization'), env.vault);
    const miss = spawnSync(L.command, [...base, '--headers', '--server', 'web'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: HOME_OF(env) });
    expect(miss.status).toBe(1);
    expect(miss.stdout).toBe('');
    expect(miss.stderr).toContain('Authorization');
    expect(`${miss.stdout}${miss.stderr}`).not.toContain(HDR);
  }, 60_000);
});

describe('o lançador não confia na linha de comando para os caminhos (--club, --vault, --snapshot)', () => {
  /**
   * A biblioteca do Club (stdio com um segredo no cofre padrão) e, num "repositório", outra biblioteca com o mesmo servidor e o mesmo nome de chave:
   * quem chama o lançador com o `--club` do repositório quer o segredo real no env do comando que o repositório define. O MCP falso grava o valor
   * que recebeu em `out` e sai com 7: sem `out`, o comando não subiu.
   */
  async function arm() {
    const env = await setup();
    const out = path.join(env.dir, 'saida.txt');
    const script = path.join(env.dir, 'mcp-falso.cjs');
    await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.FS_TOKEN ?? 'SEM');\nprocess.exit(7);\n`);
    const def = { type: 'stdio', command: process.execPath, args: [script], env: ['FS_TOKEN'] };
    await fs.writeFile(env.club, JSON.stringify({ servers: { falso: def } }));
    await setSecret(clubSecretId('falso', 'env', 'FS_TOKEN'), VALOR, env.vault);
    const repo = path.join(env.dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const evilClub = path.join(repo, 'mcps.json');
    await fs.writeFile(evilClub, JSON.stringify({ servers: { falso: def } }));
    const paths: LaunchPaths = { club: env.club, vault: env.vault.dir, runDir: path.join(env.dir, 'run') };
    /** Um arquivo de lançamento do Codex em `file` (cria a pasta) que sobe o mesmo MCP falso, com o valor do próprio arquivo. */
    const snapshot = async (file: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ servers: { falso: { type: 'stdio', command: process.execPath, args: [script], env: { FS_TOKEN: 'do-snapshot' } } } }));
      return file;
    };
    return { ...env, out, repo, evilClub, paths, snapshot };
  }

  /** `runMcpLaunchCli` com o stderr capturado. */
  async function cli(argv: string[], paths: LaunchPaths) {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runMcpLaunchCli(argv, paths);
      return { code, err: write.mock.calls.map((c) => String(c[0])).join('') };
    } finally {
      write.mockRestore();
    }
  }

  it('--club de outro arquivo: recusado sem subir o comando, sem o valor na mensagem; o padrão sobe com o segredo do cofre', async () => {
    const a = await arm();
    const bad = await cli(['--server', 'falso', '--club', a.evilClub, '--vault', a.vault.dir], a.paths);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('--club');
    expect(bad.err).toContain('recusado');
    expect(bad.err).not.toContain(a.evilClub);
    expect(bad.err).not.toContain(VALOR);
    await expect(fs.access(a.out)).rejects.toThrow();

    // O mesmo comando com o `--club` padrão sobe (a fixture está certa: a recusa acima é pelo caminho).
    const ok = await cli(['--server', 'falso', '--club', a.club, '--vault', a.vault.dir], a.paths);
    expect(ok.code).toBe(7);
    expect(await fs.readFile(a.out, 'utf8')).toBe(VALOR);
  });

  it('--vault de outra pasta: recusado sem subir o comando', async () => {
    const a = await arm();
    const other = path.join(a.dir, 'cofre-de-fora');
    const bad = await cli(['--server', 'falso', '--club', a.club, '--vault', other], a.paths);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('--vault');
    expect(bad.err).toContain('recusado');
    expect(bad.err).not.toContain(other);
    await expect(fs.access(a.out)).rejects.toThrow();
    // Argumento vazio também não é o padrão (path.resolve('') seria a pasta de onde o processo foi chamado).
    expect((await cli(['--server', 'falso', '--club', '', '--vault', a.vault.dir], a.paths)).code).toBe(1);
    await expect(fs.access(a.out)).rejects.toThrow();
  });

  it('--snapshot fora de <MYCO_HOME>/run/<sessão>/: recusado sem subir o comando; dentro, sobe', async () => {
    const a = await arm();
    const run = a.paths.runDir;
    const outside = [
      await a.snapshot(path.join(a.repo, 'codex-mcp.json')),
      await a.snapshot(path.join(run, 'codex-mcp.json')),
      await a.snapshot(path.join(run, 'sessao-1', 'fundo', 'codex-mcp.json')),
      // Sem path.join, que tiraria o `..`: o lançador é quem normaliza.
      await a.snapshot([run, 'sessao-1', '..', '..', 'repo', 'snap.json'].join(path.sep)),
      await a.snapshot(path.join(`${run}-outro`, 'sessao-1', 'codex-mcp.json')),
    ];
    for (const file of outside) {
      const bad = await cli(['--snapshot', file, '--server', 'falso'], a.paths);
      expect(bad.code, file).toBe(1);
      expect(bad.err).toContain('--snapshot');
      expect(bad.err).toContain('recusado');
      expect(bad.err).not.toContain(file);
    }
    await expect(fs.access(a.out)).rejects.toThrow();

    const inside = await a.snapshot(path.join(run, 'sessao-1', 'codex-mcp.json'));
    expect((await cli(['--snapshot', inside, '--server', 'falso'], a.paths)).code).toBe(7);
    expect(await fs.readFile(a.out, 'utf8')).toBe('do-snapshot');
  });

  it('refuseLaunchPaths: o padrão escrito de outro jeito vale (`.`, sem --club/--vault); o que só parece com ele não', async () => {
    const p: LaunchPaths = { club: path.join(root, 'h', 'mcps.json'), vault: path.join(root, 'h', 'secrets'), runDir: path.join(root, 'h', 'run') };
    const args = (over: Partial<LaunchArgs>): LaunchArgs => ({ headers: false, server: 'x', club: p.club, vault: p.vault, ...over });
    expect(refuseLaunchPaths(args({}), p)).toBeNull();
    expect(refuseLaunchPaths(args({ club: path.join(root, 'h', '.', 'mcps.json'), vault: path.join(root, 'h', 'x', '..', 'secrets') }), p)).toBeNull();
    expect(refuseLaunchPaths(args({ snapshot: path.join(p.runDir, 's', 'codex-mcp.json') }), p)).toBeNull();
    if (process.platform === 'win32') expect(refuseLaunchPaths(args({ club: p.club.toUpperCase() }), p)).toBeNull();
    expect(refuseLaunchPaths(args({ club: `${p.club}.outro` }), p)).toContain('--club');
    expect(refuseLaunchPaths(args({ club: path.join(root, 'h', 'mcps.json', '..', '..', 'mcps.json') }), p)).toContain('--club');
    expect(refuseLaunchPaths(args({ vault: `${p.vault}-2` }), p)).toContain('--vault');
    // O snapshot é uma pasta, o arquivo da pasta de lançamento (sem sessão) ou a própria pasta: nenhum vale.
    for (const snapshot of [p.runDir, path.join(p.runDir, 's'), path.join(p.runDir, 'a.json'), path.join(p.runDir, '..', 'codex-mcp.json'), '']) {
      expect(refuseLaunchPaths(args({ snapshot }), p), snapshot).toContain('--snapshot');
    }
  });

  it('o padrão do lançador é o do Club: biblioteca e cofre do MYCO_HOME, e a pasta run dele', () => {
    expect(defaultLaunchPaths()).toEqual({ club: CLUB_MCP_FILE, vault: DEFAULT_SECRETS_DIR, runDir: path.join(MYCO_HOME, 'run') });
  });

  it('o lançador de verdade (processo): --club e --snapshot de fora saem com 1, sem subir o comando nem trazer o valor', async () => {
    const a = await arm();
    const L = mcpLaunchCommand(false);
    const sp = (argv: string[]) => spawnSync(L.command, [...L.args, ...argv], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: HOME_OF(a) });
    const club = sp(['--server', 'falso', '--club', a.evilClub, '--vault', a.vault.dir]);
    const snap = sp(['--snapshot', await a.snapshot(path.join(a.repo, 'codex-mcp.json')), '--server', 'falso']);
    for (const r of [club, snap]) {
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('recusado');
      expect(`${r.stdout}${r.stderr}`).not.toContain(a.repo);
      expect(`${r.stdout}${r.stderr}`).not.toContain(VALOR);
    }
    await expect(fs.access(a.out)).rejects.toThrow();
    // O padrão, pelo mesmo processo, sobe.
    expect(sp(['--server', 'falso', '--club', a.club, '--vault', a.vault.dir]).status).toBe(7);
    expect(await fs.readFile(a.out, 'utf8')).toBe(VALOR);
  }, 120_000);
});

describe('negações de leitura da sessão (secretDenyRules)', () => {
  const profile = { servers: [] } as unknown as StaffProfile;
  /** O mesmo formato de ruleDirOf (ficha.ts): `~/…` dentro da home, senão o caminho absoluto. */
  const ruleOf = (dir: string) => {
    const rel = path.relative(os.homedir(), dir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel.replace(/\\/g, '/')}`;
    const abs = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d: string) => `//${d.toLowerCase()}/`);
    return abs.startsWith('//') ? abs : `/${abs}`;
  };

  it('tem o ~/.claude.json e os backups (do Claude Code e do Club), e o mcp.json da pasta de lançamento', () => {
    const deny = secretDenyRules(profile);
    for (const tool of ['Read', 'Edit', 'Write']) {
      expect(deny).toContain(`${tool}(~/.claude.json*)`);
      expect(deny).toContain(`${tool}(~/.claude/backups/**)`);
      expect(deny).toContain(`${tool}(${ruleOf(path.join(MYCO_HOME, 'backups'))}/**)`);
    }
    const run = ruleOf(path.join(MYCO_HOME, 'run'));
    expect(deny).toContain(`Read(${run}/**/mcp.json)`);
    expect(deny).toContain(`Edit(${run}/**)`);
    expect(deny).toContain(`Write(${run}/**)`);
  });

  it('não nega a leitura da pasta de lançamento inteira (o plugin da sessão mora nela)', () => {
    const run = ruleOf(path.join(MYCO_HOME, 'run'));
    expect(secretDenyRules(profile)).not.toContain(`Read(${run}/**)`);
  });

  it('um ~/.claude.json fora do padrão (MYCO_CLAUDE_CONFIG) entra com o caminho dele; com espaço, fica de fora', async () => {
    const antes = process.env.MYCO_CLAUDE_CONFIG;
    try {
      const outro = path.join(root, 'outro', 'meu.claude.json');
      process.env.MYCO_CLAUDE_CONFIG = outro;
      expect(defaultLocations().configFile).toBe(outro);
      const deny = secretDenyRules(profile);
      expect(deny).toContain(`Read(${ruleOf(outro)}*)`);
      expect(deny).toContain(`Write(${ruleOf(outro)}*)`);

      process.env.MYCO_CLAUDE_CONFIG = path.join(root, 'com espaco', 'claude.json');
      expect(secretDenyRules(profile).some((r) => r.includes('com espaco'))).toBe(false);
    } finally {
      if (antes === undefined) delete process.env.MYCO_CLAUDE_CONFIG;
      else process.env.MYCO_CLAUDE_CONFIG = antes;
    }
  });
});

describe('negações no Codex (codexDenyPaths)', () => {
  it('pastas de lançamento e de backup entram; o ~/.claude.json entra quando não há .vps arquivo', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'codex-'));
    const home = path.join(dir, 'home');
    const proj = path.join(dir, 'proj');
    const mycoHome = path.join(home, '.myco');
    for (const d of [path.join(home, '.ssh'), path.join(mycoHome, 'secrets'), path.join(mycoHome, 'run'), path.join(mycoHome, 'backups'), path.join(home, '.claude', 'backups'), proj]) {
      await fs.mkdir(d, { recursive: true });
    }
    await fs.writeFile(path.join(home, '.claude.json'), '{}');
    const ctx = { cwd: proj, projectPath: proj, home, mycoHome };
    const pastas = ['~/.ssh', path.join(mycoHome, 'secrets'), path.join(mycoHome, 'run'), path.join(mycoHome, 'backups'), path.join(home, '.claude', 'backups')];
    expect(codexDenyPaths(ctx)).toEqual([...pastas, path.join(home, '.claude.json')]);
  });

  it('com um .vps arquivo no projeto: o .vps entra, o ~/.claude.json fica de fora, sem erro', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'codex-vps-'));
    const home = path.join(dir, 'home');
    const proj = path.join(dir, 'proj');
    const mycoHome = path.join(home, '.myco');
    for (const d of [path.join(home, '.ssh'), path.join(mycoHome, 'run'), path.join(mycoHome, 'backups'), path.join(home, '.claude', 'backups'), proj]) {
      await fs.mkdir(d, { recursive: true });
    }
    await fs.writeFile(path.join(home, '.claude.json'), '{}');
    await fs.writeFile(path.join(proj, '.vps'), 'x');
    const ctx = { cwd: proj, projectPath: proj, home, mycoHome };
    expect(codexDenyPaths(ctx)).toEqual(['~/.ssh', path.join(mycoHome, 'run'), path.join(mycoHome, 'backups'), path.join(home, '.claude', 'backups'), path.join(proj, '.vps')]);
  });
});
