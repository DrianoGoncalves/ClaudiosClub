import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session, StaffProfile } from '../shared/model';
import { uncommittedByConversation } from '../server/uncommitted';

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-unc-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-11-06T12:00:00Z');
const RECENT = '2026-11-05T10:00:00Z';
const OLD = '2026-09-01T10:00:00Z';

/** Repositório de verdade com a/b/c commitados. */
async function repo() {
  const dir = path.join(root, `repo-${++n}`);
  await fs.mkdir(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Teste');
  git('config', 'user.email', 't@t');
  git('config', 'core.autocrlf', 'false');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(path.join(dir, f), '1\n');
  git('add', '.');
  git('commit', '-qm', 'início');
  return dir;
}

function session(id: string, updatedAt: string, topic: string | null = null): Session {
  return { id, title: null, topic, entrypoint: 'cli', gitBranch: 'main', version: null, startedAt: updatedAt, updatedAt, sizeBytes: 0, subagentCount: 0, live: null };
}

function staff(id: string, name: string, sessions: string[], worktree = false): StaffProfile {
  return { id, name, worktree, sessions: sessions.map((s) => ({ id: s, startedAt: RECENT })) } as unknown as StaffProfile;
}

/** Transcript com um Edit por arquivo (caminho absoluto, como o Claude Code grava). */
async function transcript(name: string, files: string[]) {
  const file = path.join(root, `${name}.jsonl`);
  await fs.writeFile(file, files.map((f) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: f } }] } })).join('\n'));
  return file;
}

async function report(dir: string, sessions: Session[], staffList: StaffProfile[], transcripts: Record<string, string>) {
  return uncommittedByConversation({
    projectPath: dir,
    sessions,
    staff: staffList,
    transcriptOf: async (sid) => transcripts[sid] ?? path.join(root, 'nao-existe.jsonl'),
    now: NOW,
  });
}

describe('arquivos sem commit por conversa', () => {
  it('um arquivo, uma conversa: o grupo traz o funcionário e ninguém mais', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'a.txt'), '2\n');
    const r = await report(dir, [session('s-ana', RECENT)], [staff('ana', 'Ana', ['s-ana'])], {
      's-ana': await transcript('ana', [path.join(dir, 'a.txt')]),
    });
    expect(r.total).toBe(1);
    expect(r.conversations).toEqual([
      { sessionId: 's-ana', staffId: 'ana', name: 'Ana', topic: null, files: [{ path: 'a.txt', status: 'M', also: [] }] },
    ]);
    expect(r.unowned).toEqual([]);
  });

  it('arquivo editado por duas conversas aparece nas duas, com o nome da outra; sem dono e não rastreado à parte', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'a.txt'), '2\n'); // Ana
    await fs.writeFile(path.join(dir, 'b.txt'), '2\n'); // Ana e Bruno
    await fs.writeFile(path.join(dir, 'c.txt'), '2\n'); // ninguém registrado
    await fs.writeFile(path.join(dir, 'novo.txt'), 'oi\n'); // não rastreado, ninguém
    const r = await report(
      dir,
      [session('s-ana', RECENT), session('s-bruno', RECENT)],
      [staff('ana', 'Ana', ['s-ana']), staff('bruno', 'Bruno', ['s-bruno'])],
      {
        's-ana': await transcript('ana2', [path.join(dir, 'a.txt'), path.join(dir, 'b.txt')]),
        's-bruno': await transcript('bruno2', [path.join(dir, 'b.txt')]),
      },
    );
    const ana = r.conversations.find((c) => c.sessionId === 's-ana')!;
    const bruno = r.conversations.find((c) => c.sessionId === 's-bruno')!;
    expect(ana.files.find((f) => f.path === 'b.txt')).toEqual({ path: 'b.txt', status: 'M', also: ['Bruno'] });
    expect(ana.files.find((f) => f.path === 'a.txt')?.also).toEqual([]);
    expect(bruno.files).toEqual([{ path: 'b.txt', status: 'M', also: ['Ana'] }]);
    expect(r.unowned.map((f) => f.path).sort()).toEqual(['c.txt', 'novo.txt']);
    expect(r.total).toBe(4); // a, b, c modificados + novo.txt não rastreado
  });

  it('conversa fora da janela de 14 dias é ignorada: o arquivo dela fica sem dono', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'a.txt'), '2\n');
    const r = await report(dir, [session('s-velha', OLD)], [staff('carla', 'Carla', ['s-velha'])], {
      's-velha': await transcript('velha', [path.join(dir, 'a.txt')]),
    });
    expect(r.conversations).toEqual([]);
    expect(r.unowned.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('conversa de funcionário com worktree própria fica de fora; arquivos da worktree também', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'a.txt'), '2\n');
    await fs.mkdir(path.join(dir, '.claude', 'worktrees', 'myco-duda'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude', 'worktrees', 'myco-duda', 'x.txt'), 'x\n');
    const r = await report(dir, [session('s-duda', RECENT)], [staff('duda', 'Duda', ['s-duda'], true)], {
      's-duda': await transcript('duda', [path.join(dir, 'a.txt')]),
    });
    expect(r.conversations).toEqual([]);
    expect(r.unowned.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('edição só num subagent conta para a conversa; subpasta com nome .jsonl é ignorada', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'a.txt'), '2\n'); // só o subagent editou
    await fs.writeFile(path.join(dir, 'b.txt'), '2\n'); // o principal editou
    await fs.writeFile(path.join(dir, 'c.txt'), '2\n'); // ninguém
    const main = await transcript('orq', [path.join(dir, 'b.txt')]);
    const sub = path.join(root, 'orq', 'subagents');
    await fs.mkdir(path.join(sub, 'pasta.jsonl'), { recursive: true });
    await fs.writeFile(path.join(sub, 'pasta.jsonl', 'x.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(dir, 'c.txt') } }] } }));
    await fs.writeFile(path.join(sub, 'agent-1.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(dir, 'a.txt') } }] } }));
    const r = await report(dir, [session('s-orq', RECENT)], [staff('orq', 'Orq', ['s-orq'])], { 's-orq': main });
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0]!.files.map((f) => f.path)).toEqual(['b.txt', 'a.txt']); // principal primeiro, depois o subagent
    expect(r.unowned.map((f) => f.path)).toEqual(['c.txt']);
  });

  it('conversa sem ficha: entra com staffId nulo e o assunto como nome', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'c.txt'), '2\n');
    const r = await report(dir, [session('s-x', RECENT, 'Ajuste do menu')], [], {
      's-x': await transcript('x', [path.join(dir, 'c.txt')]),
    });
    expect(r.conversations).toEqual([
      { sessionId: 's-x', staffId: null, name: 'Ajuste do menu', topic: 'Ajuste do menu', files: [{ path: 'c.txt', status: 'M', also: [] }] },
    ]);
  });
});
