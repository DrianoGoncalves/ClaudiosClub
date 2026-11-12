import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCodexProjects } from '../server/adapters/codex/projects';

// Pastas que o Codex conhece (config.toml + cwd dos rollouts), com um ~/.codex falso em tmp.
// As pastas de projeto também ficam em tmp: por isso o padrão (sem includeTemp) as recusa, e os casos de lista passam includeTemp.

let root: string;
let home: string;
let work: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codexprj-'));
  home = path.join(root, '.codex');
  work = path.join(root, 'work');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const real = (p: string) => realpathSync.native(p);
/** Como o config.toml do Codex traz as pastas no Windows: em minúsculas. */
const caixa = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Cria as pastas (relativas a `work`) e devolve os caminhos. */
async function dirs<T extends string[]>(...rel: T): Promise<{ [K in keyof T]: string }> {
  const out = rel.map((r) => path.join(work, r));
  for (const d of out) await fs.mkdir(d, { recursive: true });
  return out as unknown as { [K in keyof T]: string };
}

async function config(text: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'config.toml'), text, 'utf8');
}

/** Um rollout como o Codex grava: a 1ª linha é session_meta com o cwd, e passa de 16 KB (base_instructions). */
async function rollout(day: string, id: string, cwd: string, o: { mtime?: Date; name?: string; pad?: number } = {}): Promise<string> {
  const dayDir = path.join(home, 'sessions', ...day.split('/'));
  await fs.mkdir(dayDir, { recursive: true });
  const stamp = day.replaceAll('/', '-');
  const file = path.join(dayDir, o.name ?? `rollout-${stamp}T10-00-00-${id}.jsonl`);
  const meta = { timestamp: `${stamp}T10:00:00.000Z`, ordinal: 0, type: 'session_meta', payload: { id, cwd, base_instructions: 'x'.repeat(o.pad ?? 20_000) } };
  const body = `${JSON.stringify(meta)}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed' } })}\n`;
  await fs.writeFile(file, body, 'utf8');
  if (o.mtime) await fs.utimes(file, o.mtime, o.mtime);
  return file;
}

describe('listCodexProjects', () => {
  it('lê config.toml (aspas simples e duplas) e o cwd dos rollouts, com a caixa do disco', async () => {
    const [traf, sleepy, fromRollout] = await dirs('traf', 'vps/sleepy forest', 'so-rollout');
    await config(
      `[projects.'${caixa(traf)}']\ntrust_level = "trusted"\n\n[projects."${caixa(sleepy).replace(/\\/g, '\\\\')}"]\ntrust_level = "trusted"\n`,
    );
    await rollout('2026/11/10', 'a1', fromRollout);

    const got = await listCodexProjects(home, { includeTemp: true });
    expect(got.map((p) => p.path).sort()).toEqual([traf, sleepy, fromRollout].map((p) => real(p)).sort());
  });

  it('a mesma pasta em mais de uma fonte (outra caixa) sai uma vez, com a atividade mais recente; sem rollout, sem lastActivityAt', async () => {
    const [shared, quiet] = await dirs('shared', 'quiet');
    await config(`[projects.'${caixa(shared)}']\n\n[projects.'${caixa(quiet)}']\n`);
    await rollout('2026/11/09', 'b1', shared, { mtime: new Date('2026-11-09T12:00:00.000Z') });
    await rollout('2026/11/11', 'b2', caixa(shared), { mtime: new Date('2026-11-11T08:00:00.000Z') });

    const got = await listCodexProjects(home, { includeTemp: true });
    expect(got).toEqual([
      { path: real(shared), lastActivityAt: '2026-11-11T08:00:00.000Z' },
      { path: real(quiet) },
    ]);
  });

  it('descarta o que não é projeto: inexistente, arquivo, dentro do CODEX_HOME, worktree do git e do Claude Code, .zst, caminho relativo', async () => {
    const [ok, sub, gitWt, claudeWt, zstOnly] = await dirs('ok', 'sub', 'gitwt', 'parent/.claude/worktrees/w1', 'so-zst');
    await fs.writeFile(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n', 'utf8'); // submódulo: entra
    await fs.writeFile(path.join(gitWt, '.git'), 'gitdir: C:/repo/.git/worktrees/gitwt\n', 'utf8'); // worktree do git: sai
    const insideHome = path.join(home, 'worktrees', 'w2');
    await fs.mkdir(insideHome, { recursive: true });
    const file = path.join(work, 'arquivo.txt');
    await fs.writeFile(file, 'x', 'utf8');
    await config(
      [ok, sub, gitWt, claudeWt, insideHome, path.join(work, 'sumiu'), file]
        .map((p) => `[projects.'${caixa(p)}']\n`)
        .join('\n') + `\n[projects.'relativo']\n`,
    );
    // Rollout em .zst: o Codex compacta os antigos; não se lê.
    await rollout('2026/11/10', 'zz', zstOnly, { name: 'rollout-2026-11-10T10-00-00-zz.jsonl.zst' });

    const got = await listCodexProjects(home, { includeTemp: true });
    expect(got.map((p) => p.path).sort()).toEqual([ok, sub].map((p) => real(p)).sort());
  });

  it('a temporária do sistema fica de fora por padrão (includeTemp libera, para testes)', async () => {
    const [p] = await dirs('tmpzinho');
    await config(`[projects.'${caixa(p)}']\n`);
    expect(await listCodexProjects(home)).toEqual([]);
    expect((await listCodexProjects(home, { includeTemp: true })).map((x) => x.path)).toEqual([real(p)]);
  });

  it('tolerante: config quebrado, rollout que não começa por session_meta ou não é JSON não derrubam a lista', async () => {
    const [ok, other] = await dirs('ok', 'other');
    await config(`[projects.'${caixa(other)}\n[[[ lixo\n`); // tabela sem fechamento: não conta
    const sess = path.join(home, 'sessions', '2026', '11', '10');
    await fs.mkdir(sess, { recursive: true });
    await fs.writeFile(path.join(sess, 'rollout-2026-11-10T10-00-00-q1.jsonl'), '{ isto nem é json\n', 'utf8');
    await fs.writeFile(
      path.join(sess, 'rollout-2026-11-10T10-00-00-q2.jsonl'),
      `${JSON.stringify({ type: 'event_msg', payload: { cwd: other } })}\n`,
      'utf8',
    );
    await rollout('2026/11/10', 'ok1', ok);

    expect((await listCodexProjects(home, { includeTemp: true })).map((p) => p.path)).toEqual([real(ok)]);
    expect(await listCodexProjects(path.join(root, 'nada'), { includeTemp: true })).toEqual([]);
  });

  it('lê só os 300 rollouts mais novos', async () => {
    const [old, recent] = await dirs('antigo', 'recente');
    await rollout('2026/01/01', 'old', old, { pad: 0 });
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => rollout('2026/11/10', `n${String(i).padStart(3, '0')}`, recent, { pad: 0 })),
    );

    expect((await listCodexProjects(home, { includeTemp: true })).map((p) => p.path)).toEqual([real(recent)]);
  });
});
