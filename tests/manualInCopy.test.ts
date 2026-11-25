import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// t-edf1bf: a documentação (docs/uso e client/public/manual.html) do projeto do Claudio’s Club se edita na CÓPIA do card (ou do funcionário), não na pasta principal. O ROOT segue negado e só
// leitura; o que muda é a ficha, que passa a dizer onde editar. O ROOT é trocado por uma pasta temporária (o prepareRun grava a ficha e a memória no projeto).
const env = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  const base = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'myco-manualcopy-'));
  process.env.MYCO_HOME = nodePath.join(base, 'home');
  return { base, club: nodePath.join(base, 'club') };
});
vi.mock('../server/root', () => ({ ROOT: env.club }));

const { prepareRun } = await import('../server/staff/launch');
const { buildClaudeArgs, renderFicha, secretDenyRules } = await import('../server/staff/ficha');
const { fichaFile } = await import('../server/staff/store');

const ID = 'ana-1a2b';
const HOOKS = fileURLToPath(new URL('../scripts/hooks', import.meta.url));
const profile = (over: Partial<StaffProfile> = {}) =>
  ({ id: ID, projectId: 'p', name: 'Ana', role: 'Analista', mission: 'x', firstTask: '', autonomy: 'acceptEdits', agents: [], skills: [], mcps: null, mcpAccess: {}, knowledge: [], rules: [], doneWhen: '', reportsTo: [], engine: 'claude', model: null, effort: null, canHire: false, playbook: null, worktree: false, servers: [], sshWrite: [], browser: false, portrait: null, sessions: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over }) as unknown as StaffProfile;

const EDIT_COPY = 'edite a cópia na sua pasta de trabalho';
const READ_ONLY = '(só leitura)';
const copyOf = (project: string) => path.join(project, '.claude', 'worktrees', 'myco-card-t-x');
const ctxOf = (projectPath: string) => ({ company: 'Co', projectName: 'p', projectPath, managerNames: [], mycoUrl: 'http://127.0.0.2:1', runDir: path.join(env.base, 'home', 'run'), claudeConfigFile: path.join(projectPath, 'claude.json'), userAgentsDir: path.join(env.base, 'agents') });
const fichaOf = async (project: string) => fs.readFile(fichaFile(project, ID), 'utf8');

const other = path.join(env.base, 'outro');

beforeAll(async () => {
  for (const project of [env.club, other]) {
    await fs.mkdir(path.join(project, '.myco', 'staff', `${ID}.memory`), { recursive: true });
    await fs.mkdir(path.join(copyOf(project), 'docs', 'uso'), { recursive: true });
  }
  await fs.mkdir(path.join(env.club, 'docs', 'uso'), { recursive: true });
  await fs.writeFile(path.join(env.club, 'package.json'), '{"name":"club","version":"0.0.0"}');
  await fs.cp(HOOKS, path.join(env.club, 'scripts', 'hooks'), { recursive: true }); // o prepareRun copia os hooks do ROOT para a pasta da conversa
});
afterAll(() => removeTemp(env.base));

describe('documentação na cópia do card', () => {
  it('numa worktree (do card) do projeto do Club: o ROOT segue negado e só leitura, e a ficha manda editar a cópia', async () => {
    const run = await prepareRun(profile(), ctxOf(env.club), randomUUID(), copyOf(env.club));
    expect(run.manualEditable).toBe(false);
    const ficha = await fichaOf(env.club);
    const section = ficha.slice(ficha.indexOf('## Manual do Claudio’s Club'), ficha.indexOf('## Regras'));
    expect(section).toContain(`${path.join(env.club, 'docs', 'uso', 'README.md').replace(/\\/g, '/')}\` ${READ_ONLY}`);
    expect(section).toContain(EDIT_COPY);
    expect(section).toContain('`docs/uso/` e `client/public/manual.html`');
    expect(section).toContain('não aplique o arquivo na pasta principal');
  });

  it('nenhuma regra nova: as 3 negações são as mesmas de antes, presas ao docs/uso do ROOT (não a um docs/uso relativo, que pegaria a cópia)', async () => {
    const run = await prepareRun(profile(), ctxOf(env.club), randomUUID(), copyOf(env.club));
    const base = { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null };
    const denyOf = (o: Parameters<typeof buildClaudeArgs>[1]) => {
      const args = buildClaudeArgs(profile(), o);
      return args[args.indexOf('--disallowedTools') + 1]!.split(',');
    };
    const deny = denyOf({ ...base, manualEditable: run.manualEditable });
    const manual = deny.filter((r) => r.includes('docs/uso'));
    expect(manual).toHaveLength(3);
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) expect(manual).toContainEqual(expect.stringMatching(new RegExp(`^${tool}\\(.*/club/docs/uso/\\*\\*\\)$`)));
    // Nenhuma liberação: é o mesmo conjunto da sessão sem a informação (padrão negado).
    expect(deny).toEqual(denyOf(base));
    expect(secretDenyRules(profile()).filter((r) => r.includes('docs/uso'))).toHaveLength(3);
  });

  it('projeto do Club SEM worktree: o manual é editável no ROOT e a ficha não manda para a cópia nem diz "só leitura"', async () => {
    const run = await prepareRun(profile(), ctxOf(env.club), randomUUID(), env.club);
    expect(run.manualEditable).toBe(true);
    const ficha = await fichaOf(env.club);
    const section = ficha.slice(ficha.indexOf('## Manual do Claudio’s Club'), ficha.indexOf('## Regras'));
    expect(section).not.toContain(EDIT_COPY);
    expect(section).not.toContain(READ_ONLY);
  });

  it('outro projeto, mesmo em worktree: o manual do Club segue só leitura e não há cópia dele para editar', async () => {
    const run = await prepareRun(profile(), ctxOf(other), randomUUID(), copyOf(other));
    expect(run.manualEditable).toBe(false);
    const ficha = await fichaOf(other);
    const section = ficha.slice(ficha.indexOf('## Manual do Claudio’s Club'), ficha.indexOf('## Regras'));
    expect(section).toContain(READ_ONLY);
    expect(section).not.toContain(EDIT_COPY);
  });

  it('Codex: a mesma linha, sem as palavras que a ficha do Codex não pode ter', () => {
    const ctx = { company: 'Co', projectName: 'p', projectPath: env.club, managerNames: [], fichaPath: 'f.md', memoryPath: 'm.md', mycoUrl: 'http://127.0.0.1:4848' };
    const text = renderFicha(profile({ engine: 'codex' }), { ...ctx, manualInCopy: true });
    const section = text.slice(text.indexOf('## Manual do Claudio’s Club'), text.indexOf('## Regras'));
    expect(section).toContain(EDIT_COPY);
    // A seção é a mesma nos dois motores (tests/codexEngine.test.ts:1052 olha a ficha inteira do Codex).
    for (const banned of [/\bAgent\b/, /agents?\b/i, /subagent/i, /pesquisador|executor|revisor/i, /Chrome/i, /Monitor/, /skills?\b/i, /Claude Code/, /mcp__/]) expect(section, String(banned)).not.toMatch(banned);
    // Editável (ROOT sem worktree) tem prioridade sobre a cópia: a flag da cópia sozinha nunca vira "edite a cópia" onde o ROOT já é editável.
    expect(renderFicha(profile(), { ...ctx, manualEditable: true, manualInCopy: true })).not.toContain(EDIT_COPY);
    expect(renderFicha(profile(), ctx)).not.toContain(EDIT_COPY);
  });
});
