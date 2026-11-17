import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSkill, withName } from '../server/skillCreate';

// MYCO_HOME de teste: nada no ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-skill-create-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
let GLOBAL: string;
let PROJ: string;
/** Destino das criações: a conta (`user`) ou o projeto (`project`), como o servidor monta pelo id. */
const resolveTarget = async (scope: 'user' | 'project', projectId: string | null) => ({
  scope,
  owner: scope === 'user' ? 'user' : (projectId ?? 'p'),
  root: scope === 'user' ? GLOBAL : PROJ,
});
const opts = () => ({ resolveTarget, globalRoot: GLOBAL });

const SECRET_BODY = 'Use DB_PASSWORD=senhaForte123 no comando';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-skill-create-'));
  GLOBAL = path.join(root, 'conta', 'skills');
  PROJ = path.join(root, 'projeto', '.claude', 'skills');
  await fs.mkdir(path.join(GLOBAL, 'vps', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(GLOBAL, 'vps', 'SKILL.md'), '---\nname: vps\ndescription: Envia arquivos\n---\n\nUse o script.\n');
  await fs.writeFile(path.join(GLOBAL, 'vps', 'scripts', 'envio.sh'), 'echo ok\n');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe('criar em branco', () => {
  it('grava o SKILL.md com nome e descrição, no escopo pedido', async () => {
    const r = await createSkill({ scope: 'project', projectId: 'p1', name: 'revisar-a11y', source: 'blank', description: 'Use para revisar acessibilidade', body: '1. Contraste\n2. Foco' }, opts());
    expect(r).toEqual({ name: 'revisar-a11y', files: 1 });
    const text = await fs.readFile(path.join(PROJ, 'revisar-a11y', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: revisar-a11y\ndescription: "?Use para revisar acessibilidade/);
    expect(text.endsWith('1. Contraste\n2. Foco\n')).toBe(true);
  });

  it('na conta, vai para a pasta Global', async () => {
    await createSkill({ scope: 'user', name: 'nova-conta', source: 'blank', description: 'Da conta' }, opts());
    expect(await fs.readFile(path.join(GLOBAL, 'nova-conta', 'SKILL.md'), 'utf8')).toContain('name: nova-conta');
  });

  it('recusa nome inválido: maiúscula, caminho, espaço e começo com hífen', async () => {
    for (const name of ['Vps', '../x', 'a/b', 'com espaco', '-x', 'a'.repeat(65)]) {
      await expect(createSkill({ scope: 'project', projectId: 'p1', name, source: 'blank', description: 'x' }, opts())).rejects.toThrow('nome');
    }
  });

  it('recusa nome que já existe e não sobrescreve', async () => {
    await createSkill({ scope: 'project', projectId: 'p2', name: 'repetida', source: 'blank', description: 'Primeira' }, opts());
    await expect(createSkill({ scope: 'project', projectId: 'p2', name: 'repetida', source: 'blank', description: 'Segunda' }, opts())).rejects.toThrow('já existe');
    expect(await fs.readFile(path.join(PROJ, 'repetida', 'SKILL.md'), 'utf8')).toContain('Primeira');
  });

  it('a conta não aceita o nome synced (é a pasta das sincronizadas)', async () => {
    await expect(createSkill({ scope: 'user', name: 'synced', source: 'blank', description: 'x' }, opts())).rejects.toThrow('synced');
  });

  it('descrição vazia recusa; segredo no texto recusa, sem gravar a pasta', async () => {
    await expect(createSkill({ scope: 'project', projectId: 'p3', name: 'sem-descricao', source: 'blank', description: '  ' }, opts())).rejects.toThrow('descrição');
    await expect(createSkill({ scope: 'project', projectId: 'p3', name: 'com-segredo', source: 'blank', description: 'Banco', body: SECRET_BODY }, opts())).rejects.toThrow('senha na variável DB_PASSWORD');
    await expect(fs.stat(path.join(PROJ, 'com-segredo'))).rejects.toThrow();
    await expect(fs.stat(path.join(PROJ, 'sem-descricao'))).rejects.toThrow();
  });
});

describe('copiar de uma skill da conta', () => {
  it('copia a pasta inteira para o projeto (cópia independente)', async () => {
    const r = await createSkill({ scope: 'project', projectId: 'p4', name: 'vps', source: 'copy', from: 'vps' }, opts());
    expect(r).toEqual({ name: 'vps', files: 2 });
    expect(await fs.readFile(path.join(PROJ, 'vps', 'scripts', 'envio.sh'), 'utf8')).toBe('echo ok\n');
    await fs.writeFile(path.join(GLOBAL, 'vps', 'SKILL.md'), '---\nname: vps\ndescription: mudou na conta\n---\n');
    expect(await fs.readFile(path.join(PROJ, 'vps', 'SKILL.md'), 'utf8')).toContain('Envia arquivos');
  });

  it('com outro nome, reescreve o name: do frontmatter da cópia; a origem não muda', async () => {
    await createSkill({ scope: 'project', projectId: 'p5', name: 'envio-local', source: 'copy', from: 'vps' }, opts());
    const copia = await fs.readFile(path.join(PROJ, 'envio-local', 'SKILL.md'), 'utf8');
    expect(copia).toMatch(/^---\nname: envio-local\n/);
    // A origem está como o teste anterior deixou (a descrição mudou lá); a cópia leva o mesmo texto, só o nome é outro.
    expect(copia).toContain('mudou na conta');
    expect(await fs.readFile(path.join(GLOBAL, 'vps', 'SKILL.md'), 'utf8')).toContain('mudou na conta');
  });

  it('withName: troca o name existente, põe o que falta e ganha frontmatter se não tinha', () => {
    expect(withName('---\nname: a\ndescription: x\n---\n\nCorpo\n', 'b')).toBe('---\nname: b\ndescription: x\n---\n\nCorpo\n');
    expect(withName('---\ndescription: x\n---\n', 'b')).toBe('---\nname: b\ndescription: x\n---\n');
    expect(withName('Sem frontmatter\n', 'b')).toBe('---\nname: b\n---\n\nSem frontmatter\n');
  });

  it('recusa a cópia para a conta (a Global já é da conta) e a de skill que não existe', async () => {
    await expect(createSkill({ scope: 'user', name: 'copia-conta', source: 'copy', from: 'vps' }, opts())).rejects.toThrow('a cópia vai para um projeto');
    await expect(createSkill({ scope: 'project', projectId: 'p6', name: 'fantasma', source: 'copy', from: 'nao-existe' }, opts())).rejects.toThrow('não existe a skill nao-existe');
    await expect(createSkill({ scope: 'project', projectId: 'p6', name: 'fantasma', source: 'copy' }, opts())).rejects.toThrow('escolha a skill');
  });

  it('recusa origem que é link, origem com link dentro, a sincronizada, pasta sem SKILL.md', async () => {
    const alvo = path.join(root, 'alvo-link');
    await fs.mkdir(alvo, { recursive: true });
    await fs.writeFile(path.join(alvo, 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
    await fs.symlink(alvo, path.join(GLOBAL, 'link-skill'), 'junction');
    await expect(createSkill({ scope: 'project', projectId: 'p7', name: 'copia-link', source: 'copy', from: 'link-skill' }, opts())).rejects.toThrow('é um link');

    await fs.mkdir(path.join(GLOBAL, 'com-link'), { recursive: true });
    await fs.writeFile(path.join(GLOBAL, 'com-link', 'SKILL.md'), '---\nname: com-link\ndescription: x\n---\n');
    await fs.symlink(alvo, path.join(GLOBAL, 'com-link', 'dentro'), 'junction');
    await expect(createSkill({ scope: 'project', projectId: 'p7', name: 'copia-com-link', source: 'copy', from: 'com-link' }, opts())).rejects.toThrow('link dentro');

    await expect(createSkill({ scope: 'project', projectId: 'p7', name: 'copia-sync', source: 'copy', from: 'synced' }, opts())).rejects.toThrow('não pode ser copiada');

    await fs.mkdir(path.join(GLOBAL, 'sem-md'), { recursive: true });
    await fs.writeFile(path.join(GLOBAL, 'sem-md', 'outro.md'), 'x');
    await expect(createSkill({ scope: 'project', projectId: 'p7', name: 'copia-sem-md', source: 'copy', from: 'sem-md' }, opts())).rejects.toThrow('não tem SKILL.md');
    await expect(fs.stat(path.join(PROJ, 'copia-link'))).rejects.toThrow();
    await expect(fs.stat(path.join(PROJ, 'copia-com-link'))).rejects.toThrow();
  });

  it('recusa mais de 200 arquivos e mais de 5 MB no total, sem copiar', async () => {
    const muitos = path.join(GLOBAL, 'muitos');
    await fs.mkdir(muitos, { recursive: true });
    await fs.writeFile(path.join(muitos, 'SKILL.md'), '---\nname: muitos\ndescription: x\n---\n');
    for (let i = 0; i < 200; i++) await fs.writeFile(path.join(muitos, `a${i}.txt`), 'x');
    await expect(createSkill({ scope: 'project', projectId: 'p8', name: 'copia-muitos', source: 'copy', from: 'muitos' }, opts())).rejects.toThrow('mais de 200 arquivos');

    const grande = path.join(GLOBAL, 'grande');
    await fs.mkdir(grande, { recursive: true });
    await fs.writeFile(path.join(grande, 'SKILL.md'), '---\nname: grande\ndescription: x\n---\n');
    await fs.writeFile(path.join(grande, 'a.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
    await fs.writeFile(path.join(grande, 'b.bin'), Buffer.alloc(3 * 1024 * 1024, 2));
    await expect(createSkill({ scope: 'project', projectId: 'p8', name: 'copia-grande', source: 'copy', from: 'grande' }, opts())).rejects.toThrow('grande demais');
    await expect(fs.stat(path.join(PROJ, 'copia-muitos'))).rejects.toThrow();
    await expect(fs.stat(path.join(PROJ, 'copia-grande'))).rejects.toThrow();
  });

  it('recusa a cópia com segredo no texto da skill de origem', async () => {
    await fs.mkdir(path.join(GLOBAL, 'com-senha'), { recursive: true });
    await fs.writeFile(path.join(GLOBAL, 'com-senha', 'SKILL.md'), `---\nname: com-senha\ndescription: x\n---\n\n${SECRET_BODY}\n`);
    await expect(createSkill({ scope: 'project', projectId: 'p9', name: 'copia-senha', source: 'copy', from: 'com-senha' }, opts())).rejects.toThrow('senha na variável DB_PASSWORD');
  });
});
