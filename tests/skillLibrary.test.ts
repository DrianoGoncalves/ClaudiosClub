import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSkillPlugin, hashSkillFolders, readLibrarySkill } from '../server/skillLibrary';
import { buildClaudeArgs, renderFicha } from '../server/staff/ficha';
import type { StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// MYCO_HOME de teste: nada no ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-skill-library-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-skills-'));
});
afterAll(() => removeTemp(root, home));

describe('sobra da biblioteca (virou Global)', () => {
  it('lê a pasta que sobrou da migração (conflito), para a rota GET de uma skill', async () => {
    const lib = path.join(root, 'sobra');
    await fs.mkdir(path.join(lib, 'vps'), { recursive: true });
    await fs.writeFile(path.join(lib, 'vps', 'SKILL.md'), '---\nname: vps\ndescription: Envia arquivos\n---\n\nUse o script.\n');
    await fs.writeFile(path.join(lib, 'vps', 'vps.ps1'), 'Write-Output ok');
    expect(await readLibrarySkill('vps', lib)).toMatchObject({ name: 'vps', description: 'Envia arquivos', body: 'Use o script.\n', files: ['vps.ps1'] });
    expect(await readLibrarySkill('nao-existe', lib)).toBeNull();
    expect(await readLibrarySkill('Com Espaço', lib)).toBeNull();
  });
});

describe('plugin da sessão', () => {
  it('leva só as skills que recebe, e sempre apaga o de antes', async () => {
    const target = path.join(root, 'run', 's1', 'myco-plugin');
    const src = path.join(root, 'origem', 'vps');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: vps\ndescription: x\n---\n');
    await fs.writeFile(path.join(src, 'vps.ps1'), 'Write-Output ok');
    const plugin = await buildSkillPlugin([{ name: 'vps', dir: src }], target);
    expect(plugin).toEqual({ dir: target, skills: ['vps'] });
    expect(JSON.parse(await fs.readFile(path.join(target, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'myco' });
    expect(await fs.readdir(path.join(target, 'skills'))).toEqual(['vps']);
    expect(await fs.readFile(path.join(target, 'skills', 'vps', 'vps.ps1'), 'utf8')).toBe('Write-Output ok');
    // Sem skill para o plugin: nada de plugin, e o de antes some.
    expect(await buildSkillPlugin([], target)).toBeNull();
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('a ficha mostra a skill do projeto que a Global esconde como `myco:<nome>`, e a sessão carrega o plugin', () => {
    const p = { name: 'Ana', role: 'Front', skills: ['project:acessibilidade', 'global:vps-projeto'], agents: [], servers: [], rules: [], knowledge: [], browser: false, mcps: null, autonomy: 'manual', model: null, effort: null } as unknown as StaffProfile;
    const plan = {
      marked: ['project:acessibilidade', 'global:vps-projeto'],
      off: [],
      native: ['global:vps-projeto'],
      plugin: [{ ref: 'project:acessibilidade', name: 'acessibilidade', dir: '/p/acessibilidade' }],
      present: [],
      missing: [],
    };
    const md = renderFicha(p, { company: 'X', projectName: 'p', projectPath: '/p', managerNames: [], fichaPath: 'f', memoryPath: 'm', mycoUrl: 'u', skillPlan: plan });
    expect(md).toContain('Skills: `myco:acessibilidade` (só sua), vps-projeto.');
    const args = buildClaudeArgs(p, { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null, pluginDir: 'C:/run/s/myco-plugin' });
    expect(args.slice(args.indexOf('--plugin-dir'), args.indexOf('--plugin-dir') + 2)).toEqual(['--plugin-dir', 'C:/run/s/myco-plugin']);
    expect(buildClaudeArgs(p, { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null })).not.toContain('--plugin-dir');
  });
});

describe('versão das skills marcadas (hashSkillFolders)', () => {
  it('estável para o mesmo pacote (em qualquer pasta); muda quando um arquivo do pacote muda; fora quem não existe; chave = ref', async () => {
    const dir = path.join(root, 'versoes', 'vps');
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: vps\ndescription: x\n---\n\nPasso 1.\n');
    await fs.writeFile(path.join(dir, 'scripts', 'deploy.sh'), 'echo ok\n');

    const first = await hashSkillFolders([
      { key: 'global:vps', dir },
      { key: 'project:nao-existe', dir: path.join(root, 'versoes', 'nao-existe') },
    ]);
    expect(Object.keys(first)).toEqual(['global:vps']);
    expect(first['global:vps']).toMatch(/^[0-9a-f]{12}$/);
    expect(await hashSkillFolders([{ key: 'global:vps', dir }])).toEqual(first);

    // Mesmo pacote copiado para outro lugar: mesmo hash (os caminhos são relativos ao pacote).
    await fs.cp(dir, path.join(root, 'versoes', 'copia', 'vps'), { recursive: true });
    expect(await hashSkillFolders([{ key: 'global:vps', dir: path.join(root, 'versoes', 'copia', 'vps') }])).toEqual(first);

    // Um arquivo do pacote que não é o SKILL.md também conta.
    await fs.writeFile(path.join(dir, 'scripts', 'deploy.sh'), 'echo outra coisa\n');
    const changed = await hashSkillFolders([{ key: 'global:vps', dir }]);
    expect(changed['global:vps']).not.toBe(first['global:vps']);

    // Arquivo novo na pasta da skill também muda a versão.
    await fs.writeFile(path.join(dir, 'notas.md'), 'nova\n');
    expect((await hashSkillFolders([{ key: 'global:vps', dir }]))['global:vps']).not.toBe(changed['global:vps']);
  });
});
