import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../server/adapters/claude';
import { parseFrontmatter, strList } from '../server/adapters/claude/frontmatter';
import { readHeadTail } from '../server/adapters/claude/fsutil';
import { encodeProjectDir, worktreeParent } from '../server/adapters/claude/paths';

// Fixture sintética: um ~/.claude falso com dois projetos, um worktree, uma sessão viva e arquivos sensíveis.
let root: string;
let home: string;
let projA: string;
let projB: string;
let worktree: string;
let symlinkOk = true;

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-test-'));
  home = path.join(root, 'home', '.claude');
  projA = path.join(root, 'work', 'proj.a');
  projB = path.join(root, 'work', 'projB');
  worktree = path.join(projA, '.claude', 'worktrees', 'wt-1');

  // BOM + CRLF, como os arquivos gravados pelo PowerShell.
  await write(
    path.join(projA, '.claude', 'agents', 'designer.md'),
    '\uFEFF---\r\nname: design-system\r\ndescription: Guardião do DS\r\ntools: Read, Grep\r\n---\r\nCorpo',
  );
  await write(path.join(projA, '.claude', 'agents', 'dup.md'), '---\nname: shared\n---\n');
  await write(path.join(home, 'agents', 'shared.md'), '---\nname: shared\ndescription: global\n---\n');
  await write(path.join(projA, '.claude', 'skills', 'ds', 'SKILL.md'), '---\nname: ds-label\ndescription: d\n---\n');
  await fs.mkdir(path.join(projA, '.claude', 'skills', 'sem-skill-md'), { recursive: true });
  await write(path.join(projA, 'CLAUDE.md'), '# A');
  await fs.mkdir(worktree, { recursive: true });

  await fs.mkdir(path.join(projB, '.claude', 'agents'), { recursive: true });
  try {
    await fs.symlink(
      path.join(projA, '.claude', 'agents', 'designer.md'),
      path.join(projB, '.claude', 'agents', 'emprestado.md'),
      'file',
    );
  } catch {
    symlinkOk = false; // Windows sem Modo de Desenvolvedor
  }

  await write(
    path.join(root, 'home', '.claude.json'),
    JSON.stringify({
      projects: {
        [projA]: {},
        [projA.replaceAll('\\', '/')]: {}, // mesma pasta com outra barra
        [projB]: {},
        [path.dirname(home)]: {}, // a própria home: seu `.claude` é o ~/.claude
      },
      oauthAccount: { emailAddress: 'segredo@example.com' },
    }),
  );

  const dirA = path.join(home, 'projects', encodeProjectDir(projA));
  await write(
    path.join(dirA, 's1.jsonl'),
    [
      JSON.stringify({ type: 'queue-operation', timestamp: '2026-10-26T10:00:00.000Z' }),
      JSON.stringify({ type: 'user', entrypoint: 'cli', version: '2.1.0', gitBranch: 'main', cwd: projA, timestamp: '2026-10-26T10:00:01.000Z' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Título antigo' }),
      'linha quebrada {',
      JSON.stringify({ type: 'custom-title', customTitle: 'Refatorar DS' }),
    ].join('\n'),
  );
  await write(path.join(dirA, 's1', 'subagents', 'agent-x.meta.json'), '{"agentType":"Explore"}');
  await write(path.join(dirA, 's1', 'subagents', 'agent-x.jsonl'), '');

  // Pasta de transcript sem chave no .claude.json: o caminho vem do `cwd`.
  await write(
    path.join(home, 'projects', 'nome-qualquer', 's2.jsonl'),
    JSON.stringify({ type: 'user', entrypoint: 'claude-desktop', cwd: worktree }),
  );

  await write(
    path.join(home, 'sessions', '123.json'),
    JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: projA, status: 'waiting', name: 'viva', messagingSocketPath: '\\\\.\\pipe\\x' }),
  );
  await write(path.join(home, 'sessions', '123.abc.key'), 'CHAVE-SECRETA');
  await write(path.join(home, '.credentials.json'), '{"token":"CREDENCIAL-SECRETA"}');

  await write(path.join(home, 'skills', 'vps', 'SKILL.md'), '---\nname: vps\ndescription: x: y: z\n---\n');
  await write(path.join(home, 'skills', 'synced', 'bucket-1', 'pdf', 'SKILL.md'), '---\nname: pdf\n---\n');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function adapter() {
  return new ClaudeAdapter({
    locations: { home, configFile: path.join(root, 'home', '.claude.json') },
    includeTemp: true, // a fixture fica na pasta temporária
  });
}

describe('paths', () => {
  it('codifica o caminho como o Claude Code', () => {
    expect(encodeProjectDir('C:\\Users\\voce\\Projetos\\ClaudiosClub')).toBe('C--Users-voce-Projetos-ClaudiosClub');
    expect(encodeProjectDir('C:\\www\\painel.cliente.com.br\\.refactor-app')).toBe('C--www-painel-cliente-com-br--refactor-app');
  });

  it('reconhece worktrees', () => {
    expect(worktreeParent('C:\\p\\.claude\\worktrees\\x')).toBe('C:\\p');
    expect(worktreeParent('/p/.claude/worktrees/x')).toBe('/p');
    expect(worktreeParent('C:\\p')).toBeNull();
  });
});

describe('frontmatter', () => {
  it('cai para chave: valor quando o YAML é inválido', () => {
    expect(parseFrontmatter('---\nname: a\ndescription: x: y: z\n---\nbody').data).toEqual({ name: 'a', description: 'x: y: z' });
  });

  it('aceita frontmatter vazio e arquivo sem frontmatter', () => {
    expect(parseFrontmatter('---\n---\ncorpo')).toEqual({ data: {}, body: 'corpo' });
    expect(parseFrontmatter('só corpo').data).toEqual({});
  });

  it('normaliza tools em string ou lista', () => {
    expect(strList('Read, Grep ,')).toEqual(['Read', 'Grep']);
    expect(strList(['Read', 1, 'Bash'])).toEqual(['Read', 'Bash']);
    expect(strList(undefined)).toBeNull();
  });
});

describe('readHeadTail', () => {
  it('devolve só linhas completas do começo e do fim', async () => {
    const file = path.join(root, 'grande.jsonl');
    const lines = Array.from({ length: 200 }, (_, i) => `linha-${String(i).padStart(3, '0')}`);
    await fs.writeFile(file, lines.join('\n'));
    const { head, tail } = await readHeadTail(file, 100);
    expect(head[0]).toBe('linha-000');
    expect(head.every((l) => /^linha-\d{3}$/.test(l))).toBe(true);
    expect(tail.at(-1)).toBe('linha-199');
    expect(tail.every((l) => /^linha-\d{3}$/.test(l))).toBe(true);
  });
});

describe('ClaudeAdapter', () => {
  it('descobre projetos sem duplicar caminhos e acha o worktree pelo cwd', async () => {
    const projects = await adapter().listProjects();
    const paths = projects.map((p) => p.path).sort();
    expect(paths).toEqual([projA, projB, worktree, path.dirname(home)].map((p) => path.resolve(p)).sort());

    // Agents/skills do ~/.claude não contam como do projeto "home".
    expect(projects.find((p) => p.path === path.resolve(path.dirname(home)))).toMatchObject({ agentCount: 0, skillCount: 0 });

    const a = projects.find((p) => p.path === path.resolve(projA))!;
    expect(a).toMatchObject({ name: 'proj.a', hasClaudeMd: true, agentCount: 2, sessionCount: 1, exists: true });
    expect(projects.find((p) => p.path === path.resolve(worktree))).toMatchObject({
      id: 'nome-qualquer',
      worktreeOf: path.resolve(projA),
    });
  });

  it('lê agents, skills e sessões de um projeto', async () => {
    const ad = adapter();
    const a = (await ad.listProjects()).find((p) => p.path === path.resolve(projA))!;
    const detail = (await ad.getProject(a.id))!;

    const designer = detail.agents.find((x) => x.name === 'design-system')!;
    expect(designer).toMatchObject({ description: 'Guardião do DS', tools: ['Read', 'Grep'], scope: 'project', duplicate: false });
    // `shared` colide com o agent de mesmo nome em ~/.claude/agents.
    expect(detail.agents.find((x) => x.name === 'shared')!.duplicate).toBe(true);
    expect(detail.agents.every((x) => x.scope === 'project')).toBe(true);

    expect(detail.skills).toHaveLength(1);
    expect(detail.skills[0]).toMatchObject({ name: 'ds', label: 'ds-label', readOnly: false });

    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]).toMatchObject({
      id: 's1',
      title: 'Refatorar DS',
      entrypoint: 'cli',
      gitBranch: 'main',
      version: '2.1.0',
      startedAt: '2026-10-26T10:00:00.000Z',
      subagentCount: 1,
    });
    expect(detail.sessions[0]!.live).toMatchObject({ status: 'waiting', alive: true });
  });

  it('marca agents emprestados por symlink', async () => {
    if (!symlinkOk) return;
    const ad = adapter();
    const b = (await ad.listProjects()).find((p) => p.path === path.resolve(projB))!;
    const [agent] = (await ad.getProject(b.id))!.agents;
    expect(agent).toMatchObject({ name: 'design-system', link: { kind: 'symlink' } });
    expect(agent!.link.target).toBe(path.resolve(projA, '.claude', 'agents', 'designer.md'));
  });

  it('separa skills do usuário e sincronizadas', async () => {
    const scope = await adapter().getUserScope();
    expect(scope.agents.map((a) => a.name)).toEqual(['shared']);
    expect(scope.skills.map((s) => [s.name, s.scope, s.readOnly])).toEqual([
      ['vps', 'user', false],
      ['pdf', 'synced', true],
    ]);
    expect(scope.skills[0]!.description).toBe('x: y: z');
  });

  it('não vaza segredos nem campos internos', async () => {
    const ad = adapter();
    const projects = await ad.listProjects();
    const dump = JSON.stringify([
      projects,
      await Promise.all(projects.map((p) => ad.getProject(p.id))),
      await ad.getUserScope(),
      await ad.listLiveSessions(),
    ]);
    expect(dump).not.toContain('CHAVE-SECRETA');
    expect(dump).not.toContain('CREDENCIAL-SECRETA');
    expect(dump).not.toContain('segredo@example.com');
    expect(dump).not.toContain('messagingSocketPath');
  });

  it('retorna null para projeto desconhecido', async () => {
    expect(await adapter().getProject('nao-existe')).toBeNull();
  });
});
