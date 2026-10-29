import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSkillPlugin, copyToLibrary, librarySkillsOf, listLibrary, readLibrarySkill, removeLibrarySkill, saveLibrarySkill } from '../server/skillLibrary';
import { buildClaudeArgs, renderFicha } from '../server/staff/ficha';
import type { StaffProfile } from '../shared/model';

let root: string;
let lib: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-skills-'));
  lib = path.join(root, 'biblioteca');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('biblioteca de skills', () => {
  it('cria, edita (renomeando) e mantém os campos do frontmatter que o MyCo não edita', async () => {
    await saveLibrarySkill({ name: 'revisar-a11y', description: 'Use para revisar acessibilidade', body: '1. Contraste\n2. Foco' }, lib);
    // Um campo escrito à mão no SKILL.md (o MyCo não edita) sobrevive à edição.
    const file = path.join(lib, 'revisar-a11y', 'SKILL.md');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('---\n\n', 'disable-model-invocation: true\n---\n\n'));
    await fs.writeFile(path.join(lib, 'revisar-a11y', 'checar.sh'), 'echo ok');
    const saved = await saveLibrarySkill({ originalName: 'revisar-a11y', name: 'acessibilidade', description: 'Quando revisar telas: contraste, foco, leitor de tela', body: 'Passos.' }, lib);
    expect(saved).toMatchObject({ name: 'acessibilidade', files: ['checar.sh'] });
    const text = await fs.readFile(path.join(lib, 'acessibilidade', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: acessibilidade\ndescription: "?Quando revisar telas/);
    expect(text).toContain('disable-model-invocation: true');
    expect(text.endsWith('Passos.\n')).toBe(true);
    expect((await listLibrary(lib)).map((s) => s.name)).toEqual(['acessibilidade']);
    expect(await readLibrarySkill('revisar-a11y', lib)).toBeNull();
  });

  it('recusa nome ruim, descrição vazia, nome repetido e segredo escrito na skill', async () => {
    await expect(saveLibrarySkill({ name: 'Com Espaço', description: 'x', body: '' }, lib)).rejects.toThrow('nome');
    await expect(saveLibrarySkill({ name: '../fora', description: 'x', body: '' }, lib)).rejects.toThrow('nome');
    await expect(saveLibrarySkill({ name: 'ok', description: '', body: '' }, lib)).rejects.toThrow('descrição');
    await saveLibrarySkill({ name: 'dupla', description: 'x', body: '' }, lib);
    await expect(saveLibrarySkill({ name: 'dupla', description: 'y', body: '' }, lib)).rejects.toThrow('já existe');
    await expect(saveLibrarySkill({ name: 'banco', description: 'Conectar no banco', body: 'Use DB_PASSWORD=senhaForte123 no comando' }, lib)).rejects.toThrow('uma senha');
  });

  it('tirar da biblioteca manda para a lixeira (nada é apagado)', async () => {
    await saveLibrarySkill({ name: 'temporaria', description: 'x', body: '' }, lib);
    expect(await removeLibrarySkill('temporaria', lib)).toBe(true);
    expect(await removeLibrarySkill('temporaria', lib)).toBe(false);
    const trash = await fs.readdir(path.join(lib, '.lixeira'));
    expect(trash.some((d) => d.startsWith('temporaria-'))).toBe(true);
    expect((await listLibrary(lib)).map((s) => s.name)).not.toContain('temporaria');
  });

  it('copia uma skill da conta (a original fica)', async () => {
    const account = path.join(root, 'conta-skills');
    await fs.mkdir(path.join(account, 'vps'), { recursive: true });
    await fs.writeFile(path.join(account, 'vps', 'SKILL.md'), '---\nname: vps\ndescription: Envia arquivos para a VPS\n---\n\nUse o script.');
    await fs.writeFile(path.join(account, 'vps', 'vps.ps1'), 'Write-Output ok');
    expect(await copyToLibrary('vps', account, lib)).toMatchObject({ name: 'vps', description: 'Envia arquivos para a VPS', files: ['vps.ps1'] });
    expect(await fs.readFile(path.join(account, 'vps', 'SKILL.md'), 'utf8')).toContain('Use o script.');
    await expect(copyToLibrary('vps', account, lib)).rejects.toThrow('já existe');
    await expect(copyToLibrary('nao-existe', account, lib)).rejects.toThrow();
  });

  it('o plugin da sessão leva só as skills da biblioteca que estão na ficha', async () => {
    const target = path.join(root, 'run', 's1', 'myco-plugin');
    expect(await librarySkillsOf(['vps', 'acessibilidade', 'do-projeto'], lib)).toEqual(['vps', 'acessibilidade']);
    const plugin = await buildSkillPlugin(['vps', 'do-projeto'], target, lib);
    expect(plugin).toEqual({ dir: target, skills: ['vps'] });
    expect(JSON.parse(await fs.readFile(path.join(target, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'myco' });
    expect(await fs.readdir(path.join(target, 'skills'))).toEqual(['vps']);
    expect(await fs.readFile(path.join(target, 'skills', 'vps', 'vps.ps1'), 'utf8')).toBe('Write-Output ok');
    // Sem skill da biblioteca na ficha: nada de plugin (e o de antes some).
    expect(await buildSkillPlugin(['do-projeto'], target, lib)).toBeNull();
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('a ficha mostra a skill da biblioteca com o prefixo, e a sessão carrega o plugin', () => {
    const p = { name: 'Ana', role: 'Front', skills: ['acessibilidade', 'vps-projeto'], agents: [], servers: [], rules: [], knowledge: [], browser: false, mcps: null, autonomy: 'manual', model: null, effort: null } as unknown as StaffProfile;
    const md = renderFicha(p, { company: 'X', projectName: 'p', projectPath: '/p', managerNames: [], fichaPath: 'f', memoryPath: 'm', mycoUrl: 'u', librarySkills: ['acessibilidade'] });
    expect(md).toContain('Skills: `myco:acessibilidade` (só sua), vps-projeto.');
    const args = buildClaudeArgs(p, { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null, pluginDir: 'C:/run/s/myco-plugin' });
    expect(args.slice(args.indexOf('--plugin-dir'), args.indexOf('--plugin-dir') + 2)).toEqual(['--plugin-dir', 'C:/run/s/myco-plugin']);
    expect(buildClaudeArgs(p, { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null })).not.toContain('--plugin-dir');
  });
});
