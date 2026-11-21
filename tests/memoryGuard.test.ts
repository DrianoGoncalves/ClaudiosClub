import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { MEMORY_DETAIL_MAX_BYTES, MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES, memoryJudge, memoryMeasure, memoryOver } from '../scripts/hooks/memory-cap.mjs';
import { removeTemp } from './support/tmp';

// O teto da memória fora do MCP: a regra (scripts/hooks/memory-cap.mjs) e o hook que a faz valer no Write/Edit/MultiEdit do Claude
// (scripts/hooks/memory-guard.mjs), rodado de verdade, e a entrada que o staffSettings e o prepareRun põem nele.

const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-memguard-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const { MEMORY_GUARD_MATCHER, prepareRun, staffSettings } = await import('../server/staff/launch');

const HOOKS = fileURLToPath(new URL('../scripts/hooks', import.meta.url));
const hook = path.join(HOOKS, 'memory-guard.mjs');

let root: string;
const ID = 'ana-1a2b';
const staff = (...p: string[]) => path.join(root, '.myco', 'staff', ...p);
const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `- linha ${i}`).join('\n')}\n`;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-memguard-'));
  await fs.mkdir(staff(`${ID}.memory`), { recursive: true });
});
afterAll(() => removeTemp(root, home));

/** Roda o hook com o evento (ou o texto cru); devolve o que ele escreveu ('' = não respondeu). */
const run = (input: unknown, script = hook) => execFileSync(process.execPath, [script], { input: typeof input === 'string' ? input : JSON.stringify(input) }).toString();
const decision = (out: string) => (out === '' ? null : (JSON.parse(out).hookSpecificOutput.permissionDecision as string));
const reason = (out: string) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string;
const write = (file: string, content: unknown) => ({ tool_name: 'Write', cwd: root, tool_input: { file_path: file, content } });
const edit = (file: string, old_string: unknown, new_string: unknown, replace_all?: boolean) => ({ tool_name: 'Edit', cwd: root, tool_input: { file_path: file, old_string, new_string, ...(replace_all !== undefined && { replace_all }) } });

describe('memory-cap: a regra', () => {
  it('memoryMeasure: bytes em UTF-8 e linhas (a última sem quebra também conta)', () => {
    expect(memoryMeasure('')).toEqual({ bytes: 0, lines: 0 });
    expect(memoryMeasure('a\nb\n')).toEqual({ bytes: 4, lines: 2 });
    expect(memoryMeasure('a\nb')).toEqual({ bytes: 3, lines: 2 });
    expect(memoryMeasure('é\n')).toEqual({ bytes: 3, lines: 1 });
  });

  it('memoryOver: índice passa por bytes ou por linhas; detalhe só por bytes', () => {
    expect(memoryOver('index', { bytes: MEMORY_INDEX_MAX_BYTES, lines: MEMORY_INDEX_MAX_LINES })).toBe(false);
    expect(memoryOver('index', { bytes: MEMORY_INDEX_MAX_BYTES + 1, lines: 1 })).toBe(true);
    expect(memoryOver('index', { bytes: 10, lines: MEMORY_INDEX_MAX_LINES + 1 })).toBe(true);
    expect(memoryOver('detail', { bytes: MEMORY_DETAIL_MAX_BYTES, lines: 9_999 })).toBe(false);
    expect(memoryOver('detail', { bytes: MEMORY_DETAIL_MAX_BYTES + 1, lines: 1 })).toBe(true);
    expect(MEMORY_DETAIL_MAX_BYTES).toBeGreaterThan(MEMORY_INDEX_MAX_BYTES);
  });

  it('memoryJudge: dentro do teto passa; acima só se o atual também passa e o novo é menor (bytes menores, sem mais linhas)', () => {
    const fits = { bytes: 100, lines: 5 };
    const fat = { bytes: 50_000, lines: 400 };
    expect(memoryJudge('index', fits, null)).toEqual({ ok: true, over: false });
    expect(memoryJudge('index', fat, null)).toEqual({ ok: false, currentOver: false });
    expect(memoryJudge('index', fat, fits)).toEqual({ ok: false, currentOver: false }); // crescer acima do teto
    expect(memoryJudge('index', { bytes: 40_000, lines: 300 }, fat)).toEqual({ ok: true, over: true });
    expect(memoryJudge('index', fat, fat)).toEqual({ ok: false, currentOver: true });
    expect(memoryJudge('index', { bytes: 40_000, lines: 401 }, fat)).toEqual({ ok: false, currentOver: true });
    expect(memoryJudge('index', fits, fat)).toEqual({ ok: true, over: false });
  });
});

describe('memory-guard: o hook de Write/Edit/MultiEdit do Claude, rodado de verdade', () => {
  const idx = () => staff(`${ID}.memory.md`);
  const det = (n = 'assunto') => staff(`${ID}.memory`, `${n}.md`);

  it('Write do índice acima do teto (bytes ou linhas): deny com a orientação; dentro do teto: sem saída', () => {
    const bytes = run(write(idx(), 'x'.repeat(MEMORY_INDEX_MAX_BYTES + 1)));
    expect(decision(bytes)).toBe('deny');
    expect(reason(bytes)).toMatch(/^\[MyCo\] o índice da memória passa do teto/);
    expect(reason(bytes)).toContain('resuma');
    expect(reason(bytes)).toContain(`.myco/staff/${ID}.memory/<assunto>.md`);
    expect(decision(run(write(idx(), lines(MEMORY_INDEX_MAX_LINES + 1))))).toBe('deny');
    expect(run(write(idx(), lines(MEMORY_INDEX_MAX_LINES)))).toBe('');
    expect(run(write(idx(), 'x'.repeat(MEMORY_INDEX_MAX_BYTES)))).toBe('');
  });

  it('Write de detalhe: teto de 16 KB, sem teto de linhas; caminho relativo vale pelo cwd do evento', () => {
    expect(decision(run(write(det(), 'y'.repeat(MEMORY_DETAIL_MAX_BYTES + 1))))).toBe('deny');
    expect(reason(run(write(det(), 'y'.repeat(MEMORY_DETAIL_MAX_BYTES + 1))))).toContain('o detalhe da memória passa do teto');
    expect(run(write(det(), 'y'.repeat(MEMORY_DETAIL_MAX_BYTES)))).toBe('');
    expect(run(write(det(), lines(500)))).toBe('');
    expect(decision(run(write(path.join('.myco', 'staff', `${ID}.memory.md`), lines(80))))).toBe('deny');
  });

  it('Write de memória que já passa do teto: menor passa, igual ou maior não (nunca fica preso)', async () => {
    await fs.writeFile(idx(), lines(200));
    expect(decision(run(write(idx(), lines(201))))).toBe('deny');
    expect(reason(run(write(idx(), lines(201))))).toContain('já passa do teto');
    expect(decision(run(write(idx(), lines(200))))).toBe('deny');
    expect(run(write(idx(), lines(100)))).toBe(''); // menor, ainda acima: passa
    expect(run(write(idx(), lines(30)))).toBe(''); // cabe
    await fs.rm(idx());
  });

  it('Edit é medido pelo arquivo como ficaria: acrescentar que estoura nega; trocar por algo menor ou que cabe passa', async () => {
    await fs.writeFile(idx(), lines(58));
    expect(run(edit(idx(), '- linha 0\n', '- linha 0\n- a\n'))).toBe(''); // 59 linhas
    expect(decision(run(edit(idx(), '- linha 0\n', '- linha 0\n- a\n- b\n- c\n- d\n')))).toBe('deny'); // 62 linhas
    // replace_all: cada "- linha" vira duas linhas
    expect(decision(run(edit(idx(), '- linha', '- x\n- linha', true)))).toBe('deny');
    // um `$&` no texto novo é texto, não padrão de troca
    expect(run(edit(idx(), '- linha 1\n', '$& $1\n'))).toBe('');
    await fs.writeFile(idx(), lines(200));
    expect(run(edit(idx(), lines(200).slice(0, 400), ''))).toBe(''); // apaga um trecho: reduz
    expect(decision(run(edit(idx(), '- linha 0\n', '- linha 0\n- a\n')))).toBe('deny'); // a memória gorda não cresce
    await fs.rm(idx());
  });

  it('MultiEdit: as trocas valem em sequência', async () => {
    await fs.writeFile(idx(), lines(58));
    const multi = (edits: unknown) => ({ tool_name: 'MultiEdit', cwd: root, tool_input: { file_path: idx(), edits } });
    expect(run(multi([{ old_string: '- linha 0\n', new_string: '- linha 0\n- a\n' }]))).toBe('');
    expect(decision(run(multi([{ old_string: '- linha 0\n', new_string: '- linha 0\n- a\n- b\n' }, { old_string: '- linha 1\n', new_string: '- linha 1\n- c\n- d\n' }])))).toBe('deny');
    // uma troca que não se aplica: o hook não responde (o próprio MultiEdit recusa)
    expect(run(multi([{ old_string: 'não existe', new_string: 'x'.repeat(20_000) }]))).toBe('');
    await fs.rm(idx());
  });

  it('Edit que cria o arquivo (old_string vazio) acima do teto: deny; abaixo: sem saída', async () => {
    await fs.rm(idx(), { force: true });
    expect(decision(run(edit(idx(), '', lines(70))))).toBe('deny');
    expect(run(edit(idx(), '', lines(10)))).toBe('');
  });

  it('o que não é da memória, e o que não dá para saber, não responde', async () => {
    const big = 'x'.repeat(MEMORY_DETAIL_MAX_BYTES * 3);
    // outro arquivo, até dentro de .myco/staff (ficha e histórico)
    for (const f of [path.join(root, 'src', 'a.md'), staff(`${ID}.md`), staff(`${ID}.json`), staff(`${ID}.memory.md.bak`), staff(`${ID}.memory`, 'sub', 'x.md'), staff(`${ID}.memory`, 'x.txt'), path.join(root, '.myco', 'outro', `${ID}.memory.md`)]) {
      expect(run(write(f, big))).toBe('');
    }
    // `..` é resolvido antes de comparar: o caminho que "volta" para a memória vale como ela
    expect(decision(run(write(`${root}${path.sep}src${path.sep}..${path.sep}.myco${path.sep}staff${path.sep}${ID}.memory.md`, big)))).toBe('deny');
    // outras ferramentas, e dados fora do formato
    expect(run({ tool_name: 'Read', tool_input: { file_path: idx() } })).toBe('');
    expect(run({ tool_name: 'Bash', tool_input: { command: 'echo' } })).toBe('');
    expect(run(write(idx(), 42))).toBe('');
    expect(run({ tool_name: 'Write', tool_input: {} })).toBe('');
    expect(run({ tool_name: 'Edit', cwd: root, tool_input: { file_path: idx() } })).toBe('');
    // Edit de arquivo que não existe, com texto a trocar: o próprio Edit falha
    await fs.rm(idx(), { force: true });
    expect(run(edit(idx(), 'a', big))).toBe('');
  });

  it('erro inesperado não bloqueia (higiene de custo, não segurança): entrada ilegível ou vazia não responde', () => {
    expect(run('não é json')).toBe('');
    expect(run('')).toBe('');
    expect(run('null')).toBe('');
    expect(run('{}')).toBe('');
  });
});

describe('a conversa: o hook entra em todo funcionário', () => {
  const profile = { id: ID, projectId: 'p', name: 'Ana', role: 'Analista', mission: 'x', firstTask: '', autonomy: 'acceptEdits', agents: [], skills: [], mcps: null, mcpAccess: {}, knowledge: [], rules: [], doneWhen: '', reportsTo: [], engine: 'claude', model: null, effort: null, canHire: false, playbook: null, worktree: false, servers: [], sshWrite: [], browser: false, portrait: null, sessions: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as unknown as StaffProfile;

  it('staffSettings: PreToolUse com o matcher de Write, Edit e MultiEdit, node direto e sem onFailure (não trava a edição)', () => {
    expect(MEMORY_GUARD_MATCHER).toBe('Write|Edit|MultiEdit');
    const pre = staffSettings(undefined, undefined, { hooksDir: '/run/c1/hooks' }).hooks.PreToolUse;
    const entry = pre.find((h) => h.matcher === MEMORY_GUARD_MATCHER);
    expect(entry).toEqual({ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: process.execPath, args: [path.join('/run/c1/hooks', 'memory-guard.mjs')], timeout: 10 }] });
    // só antes da ferramenta
    expect(staffSettings().hooks.PostToolUse.some((h) => h.matcher === MEMORY_GUARD_MATCHER)).toBe(false);
  });

  it('prepareRun: cópia do hook e da regra na pasta da conversa, o settings aponta para a cópia, e a cópia roda sozinha', async () => {
    const proj = path.join(root, 'proj');
    await fs.mkdir(path.join(proj, '.myco', 'staff', `${ID}.memory`), { recursive: true });
    const sid = randomUUID();
    const r = await prepareRun(profile, { company: 'Co', projectName: 'p', projectPath: proj, managerNames: [], mycoUrl: 'http://127.0.0.2:1', runDir: path.join(home, 'run'), claudeConfigFile: path.join(proj, 'claude.json'), userAgentsDir: path.join(root, 'agents') }, sid, proj);
    const copy = path.join(home, 'run', sid, 'hooks');
    for (const f of ['memory-guard.mjs', 'memory-cap.mjs']) expect(await fs.readFile(path.join(copy, f), 'utf8')).toBe(await fs.readFile(path.join(HOOKS, f), 'utf8'));
    const settings = JSON.parse(await fs.readFile(r.settingsFile, 'utf8')) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ args: string[] }> }> } };
    expect(settings.hooks.PreToolUse.find((h) => h.matcher === MEMORY_GUARD_MATCHER)?.hooks[0]?.args).toEqual([path.join(copy, 'memory-guard.mjs')]);
    // A cópia importa a regra da própria pasta e nega.
    const file = path.join(proj, '.myco', 'staff', `${ID}.memory.md`);
    expect(decision(run({ tool_name: 'Write', cwd: proj, tool_input: { file_path: file, content: lines(70) } }, path.join(copy, 'memory-guard.mjs')))).toBe('deny');
  });
});
