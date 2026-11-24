import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { encodeProjectDir } from '../server/adapters/claude/paths';
import { ROOT } from '../server/root';
import { setSecret } from '../server/secretVault';
import { clubSecretId } from '../server/staff/mcp';
import { migrateMcpsAtBoot } from '../server/staff/mcpMigration';
import { saveTestedTools } from '../server/staff/mcpTools';
import { listProjectStaff, readProfile, saveProfile } from '../server/staff/store';
import { removeTemp } from './support/tmp';

// `npm run mcp:rollback` (scripts/mcp-rollback.ts) de verdade, com os caminhos padrão trocados por MYCO_HOME, MYCO_CLAUDE_CONFIG e MYCO_CLAUDE_HOME:
// nunca o ~/.claude.json nem o ~/.myco reais. A migração roda em processo, com as mesmas funções do boot.

const roots: string[] = [];
afterAll(() => removeTemp(...roots));

const REGISTRO = {
  servers: {
    fs: { type: 'stdio', command: 'node', args: ['srv.js'], env: ['FS_TOKEN'] },
    web: { type: 'http', url: 'https://mcp.exemplo.com/mcp', headers: ['Authorization'] },
    aberto: { type: 'http', url: 'https://aberto.exemplo.com/mcp' },
    sse1: { type: 'sse', url: 'https://sse.exemplo.com/sse' },
  },
};

/** Um Club migrado: registro, cofre, ferramentas testadas no modelo antigo e uma ficha com `mcps: ['fs']` num projeto que o ~/.claude.json conhece (ou não). */
async function migrated(opts: { projectKnown: boolean }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-rbscript-'));
  roots.push(dir);
  const home = path.join(dir, 'myco');
  const claudeJson = path.join(dir, 'claude.json');
  const proj = path.join(dir, 'projeto');
  const projectId = encodeProjectDir(proj);
  const vault = { dir: path.join(home, 'secrets'), platform: 'linux' as const };
  const toolsFile = path.join(home, 'mcp-tools.json');
  const recordFile = path.join(home, 'mcps-migracao.json');
  const launcherFile = path.join(dir, 'dist', 'mcp-launch.mjs');
  await fs.mkdir(path.dirname(launcherFile), { recursive: true });
  await fs.writeFile(launcherFile, '// lançador de teste\n');
  await fs.mkdir(proj, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'mcps.json'), JSON.stringify(REGISTRO));
  await fs.writeFile(claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { usuario: { command: 'meu-mcp' } }, projects: opts.projectKnown ? { [proj]: {} } : {} }, null, 2));
  await setSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), 'valor-RB-1234', vault);
  await setSecret(clubSecretId('web', 'header', 'Authorization'), 'Bearer RB-5678', vault);
  await saveTestedTools(toolsFile, 'club||fs', 'fp1', [{ name: 'ler', readOnly: true }], new Date('2026-11-01T00:00:00Z'));
  const ficha = {
    id: 'ana', projectId, name: 'Ana', role: 'Dev', portrait: null, reportsTo: [], mission: 'Implementar', firstTask: '', autonomy: 'manual', agents: [], skills: [],
    mcps: ['fs'], knowledge: [], rules: [], doneWhen: '', model: null, effort: null, canHire: false, playbook: null, worktree: false, servers: [], browser: false,
    sessions: [], createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
  } as unknown as StaffProfile;
  await saveProfile(proj, ficha);
  await migrateMcpsAtBoot({
    clubFile: path.join(home, 'mcps.json'),
    claudeConfigFile: claudeJson,
    backupDir: path.join(home, 'backups'),
    recordFile,
    toolsFile,
    vault,
    launcher: { command: process.execPath, args: [launcherFile] },
    projects: [{ id: projectId, path: proj }],
    known: async () => ({ globalNames: ['fs'], projectNames: [] }),
    list: listProjectStaff,
    save: saveProfile,
  });
  // A TEMP do processo do script é outra: o adapter não conta projeto dentro da pasta temporária do sistema (e as pastas deste teste estão nela).
  const childTmp = path.join(dir, 'tmp');
  await fs.mkdir(childTmp, { recursive: true });
  const env = { ...process.env, MYCO_HOME: home, MYCO_CLAUDE_CONFIG: claudeJson, MYCO_CLAUDE_HOME: path.join(dir, '.claude'), TEMP: childTmp, TMP: childTmp, TMPDIR: childTmp };
  const rollback = () => {
    try {
      return { status: 0, out: execSync('npm run mcp:rollback --silent', { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000, windowsHide: true, stdio: 'pipe' }), err: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { status: x.status, out: x.stdout, err: x.stderr };
    }
  };
  const readClaude = async () => JSON.parse(await fs.readFile(claudeJson, 'utf8')) as { mcpServers: Record<string, unknown>; projects: unknown; numStartups: number };
  return { dir, home, proj, claudeJson, toolsFile, recordFile, rollback, readClaude };
}

describe('npm run mcp:rollback', () => {
  it('desfaz a migração com os caminhos padrão: entradas, ficha e chaves das ferramentas voltam, com backup antes de gravar', async () => {
    const e = await migrated({ projectKnown: true });
    expect(Object.keys((await e.readClaude()).mcpServers).sort()).toEqual(['aberto', 'fs', 'sse1', 'usuario', 'web']);
    const claudeMigrated = await fs.readFile(e.claudeJson, 'utf8');
    const toolsMigrated = await fs.readFile(e.toolsFile, 'utf8');
    expect((await readProfile(e.proj, 'ana'))!.mcps).toEqual(['global:fs']);

    const r = e.rollback();
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('4 entrada(s) removida(s)');
    expect(r.out).toContain('Fichas com o `mcps` de antes de volta: 1');
    expect(r.out).toContain('Chaves das ferramentas testadas devolvidas: 1');
    expect(r.out).toContain('Relatório apagado');

    const after = await e.readClaude();
    expect(Object.keys(after.mcpServers)).toEqual(['usuario']);
    expect(after.numStartups).toBe(3);
    expect((await readProfile(e.proj, 'ana'))!.mcps).toEqual(['fs']);
    expect(Object.keys((JSON.parse(await fs.readFile(e.toolsFile, 'utf8')) as { servers: object }).servers)).toEqual(['club||fs']);
    await expect(fs.stat(e.recordFile)).rejects.toThrow();

    // Backup antes de gravar: o ~/.claude.json e o mcp-tools.json de antes do rollback, em MYCO_HOME/backups. O registro e o cofre seguem.
    const backups = await fs.readdir(path.join(e.home, 'backups'));
    const claudeBackups = backups.filter((f) => f.startsWith('claude.json.'));
    const toolsBackups = backups.filter((f) => f.startsWith('mcp-tools.json.'));
    expect(toolsBackups).toHaveLength(1);
    expect(await fs.readFile(path.join(e.home, 'backups', toolsBackups[0]!), 'utf8')).toBe(toolsMigrated);
    // Há o backup da migração (o ~/.claude.json de antes dela) e o do rollback (o migrado).
    const contents = await Promise.all(claudeBackups.map((f) => fs.readFile(path.join(e.home, 'backups', f), 'utf8')));
    expect(contents).toContain(claudeMigrated);
    expect(JSON.parse(await fs.readFile(path.join(e.home, 'mcps.json'), 'utf8'))).toEqual(REGISTRO);
    expect(`${r.out}${r.err}`).not.toMatch(/valor-RB|Bearer RB/);

    // Sem relatório, nada a desfazer.
    const again = e.rollback();
    expect(again.status).toBe(0);
    expect(again.out).toContain('Nada a desfazer');
  }, 180_000);

  it('ficha que não foi achada (projeto fora do quadro): sai com erro, diz qual e mantém o relatório', async () => {
    const e = await migrated({ projectKnown: false });
    const r = e.rollback();
    expect(r.status).toBe(1);
    expect(r.err).toContain('ana');
    expect(r.err).toContain('o relatório foi mantido');
    expect(Object.keys((await e.readClaude()).mcpServers)).toEqual(['usuario']);
    await expect(fs.stat(e.recordFile)).resolves.toBeTruthy();
    expect((await readProfile(e.proj, 'ana'))!.mcps).toEqual(['global:fs']);
  }, 180_000);
});
