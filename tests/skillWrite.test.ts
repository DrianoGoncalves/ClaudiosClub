import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteSkill,
  hookFilesOf,
  readSkillSource,
  saveSkill,
  SkillDeleteInput,
  SkillSaveInput,
  type DeleteSkillResult,
  type SkillTarget,
} from '../server/adapters/claude/skillWrite';
import { renderFicha, type FichaContext } from '../server/staff/ficha';
import type { StaffProfile } from '../shared/model';

// Tudo em pastas temporárias, com a conta e o projeto de mentira: nada aqui toca o ~/.claude de quem roda os testes.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-skillwrite-'));
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Dá para criar link neste Windows (junction não precisa de admin; symlink de arquivo costuma precisar). */
async function canLink(kind: 'dir' | 'file'): Promise<boolean> {
  const dir = await fs.mkdtemp(path.join(root, 'probe-'));
  const target = path.join(dir, kind === 'dir' ? 'alvo' : 'alvo.md');
  if (kind === 'dir') await fs.mkdir(target);
  else await fs.writeFile(target, 'x');
  try {
    await fs.symlink(target, path.join(dir, 'link'), kind === 'dir' ? 'junction' : 'file');
    return true;
  } catch {
    return false;
  }
}
const dirLinkOk = await canLink('dir');
const fileLinkOk = await canLink('file');

const MD = (desc: string, body: string) => `---\nname: vps\ndescription: ${desc}\n---\n\n${body}\n`;
const hit = (command: string) => ({ type: 'command', command });

/** Uma conta (claudeHome/skills) com as skills dadas, cada uma com um SKILL.md. Backups em `backups/skills` e `backups/settings`. */
async function setup(tag: string, names: string[] = ['vps']) {
  const claudeHome = path.join(root, tag, 'home');
  const skills = path.join(claudeHome, 'skills');
  for (const n of names) {
    await fs.mkdir(path.join(skills, n), { recursive: true });
    await fs.writeFile(path.join(skills, n, 'SKILL.md'), MD('Envia arquivos', `Passo de ${n}.`));
  }
  return {
    claudeHome,
    skills,
    backupDir: path.join(root, tag, 'backups', 'skills'),
    settingsBackupDir: path.join(root, tag, 'backups', 'settings'),
  };
}

const userT = (skills: string, name: string): SkillTarget => ({ scope: 'user', owner: 'user', root: skills, name });

/** A exclusão que apagou: devolve o caminho da lixeira (falha se a resposta foi o aviso). */
function trashed(r: DeleteSkillResult): string {
  if (!('trash' in r)) throw new Error(`esperava a lixeira, veio ${JSON.stringify(r)}`);
  return r.trash;
}

describe('skills: editar o SKILL.md', () => {
  it('grava o conteúdo inteiro, guarda a versão anterior e não renomeia a pasta', async () => {
    const { skills, backupDir } = await setup('edit');
    const saved = await saveSkill({ ...userT(skills, 'vps'), content: MD('Envia e baixa arquivos', 'Novo passo.'), backupDir });
    expect(saved).toMatchObject({ name: 'vps', editable: true, link: null });
    expect(await fs.readFile(path.join(skills, 'vps', 'SKILL.md'), 'utf8')).toBe(MD('Envia e baixa arquivos', 'Novo passo.'));
    const backups = await fs.readdir(backupDir);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^user-user-vps\./);
    expect(await fs.readFile(path.join(backupDir, backups[0]!), 'utf8')).toContain('Passo de vps.');
    expect(await fs.readdir(skills)).toEqual(['vps']);
  });

  it('skill de projeto: o backup leva o escopo e o projeto no nome', async () => {
    const proj = path.join(root, 'proj-x', 'app');
    const skills = path.join(proj, '.claude', 'skills');
    await fs.mkdir(path.join(skills, 'deploy'), { recursive: true });
    await fs.writeFile(path.join(skills, 'deploy', 'SKILL.md'), MD('Faz deploy', 'Antigo.'));
    const backupDir = path.join(root, 'proj-x', 'backups');
    await saveSkill({ scope: 'project', owner: 'p-1a2b', root: skills, name: 'deploy', content: MD('Faz deploy', 'Novo.'), backupDir });
    const [backup] = await fs.readdir(backupDir);
    expect(backup).toMatch(/^project-p-1a2b-deploy\./);
  });

  it('recusa segredo no texto e skill que não existe', async () => {
    const { skills, backupDir } = await setup('secret');
    await expect(saveSkill({ ...userT(skills, 'vps'), content: 'Use DB_PASSWORD=senhaForte123', backupDir })).rejects.toThrow('no texto da skill');
    await expect(saveSkill({ ...userT(skills, 'nao-existe'), content: 'x', backupDir })).rejects.toThrow('skill não encontrada');
    expect(await fs.readFile(path.join(skills, 'vps', 'SKILL.md'), 'utf8')).toContain('Passo de vps.');
  });

  it('o schema da gravação recusa nome com barra e SKILL.md vazio', () => {
    expect(SkillSaveInput.safeParse({ scope: 'user', name: '../x', content: 'a' }).success).toBe(false);
    expect(SkillSaveInput.safeParse({ scope: 'user', name: 'vps', content: '   ' }).success).toBe(false);
    expect(SkillSaveInput.safeParse({ scope: 'user', name: 'vps', content: '---\n---\n' }).success).toBe(true);
  });
});

describe('skills: excluir para a lixeira', () => {
  it('manda a pasta inteira para .lixeira (recuperável) quando nenhum hook aponta para ela', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('trash');
    await fs.writeFile(path.join(skills, 'vps', 'extra.sh'), 'echo');
    // Settings válido, com hook que não é desta skill: não bloqueia nem pede confirmação.
    await fs.writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [hit('echo ok')] }] } }));
    const res = await deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: hookFilesOf(claudeHome, []) });
    expect(res).not.toHaveProperty('removedHooks');
    const trash = trashed(res);
    expect(await fs.readdir(skills)).toEqual([]);
    expect(path.dirname(trash)).toBe(path.join(backupDir, '.lixeira'));
    expect(path.basename(trash)).toMatch(/^user-user-vps-/);
    expect(await fs.readFile(path.join(trash, 'SKILL.md'), 'utf8')).toContain('Passo de vps.');
    expect(await fs.readFile(path.join(trash, 'extra.sh'), 'utf8')).toBe('echo');
  });

  it('recusa apagar as sincronizadas da conta', async () => {
    const { skills, backupDir, settingsBackupDir } = await setup('synced', []);
    await fs.mkdir(path.join(skills, 'synced', 'bucket', 'pdf'), { recursive: true });
    await fs.writeFile(path.join(skills, 'synced', 'bucket', 'pdf', 'SKILL.md'), MD('Lê PDF', 'x'));
    await expect(deleteSkill({ ...userT(skills, 'synced'), backupDir, settingsBackupDir, hookFiles: [] })).rejects.toThrow('sincronizadas');
    await expect(saveSkill({ ...userT(skills, 'synced'), content: 'x', backupDir })).rejects.toThrow('sincronizadas');
    expect(await fs.stat(path.join(skills, 'synced', 'bucket', 'pdf', 'SKILL.md'))).toBeTruthy();
  });

  it('recusa nome inválido e tentativa de sair da pasta (ler, gravar e apagar)', async () => {
    const { skills, backupDir, settingsBackupDir } = await setup('names');
    // Uma skill fora da pasta de skills, que o nome não pode alcançar.
    await fs.mkdir(path.join(root, 'names', 'fora'), { recursive: true });
    await fs.writeFile(path.join(root, 'names', 'fora', 'SKILL.md'), MD('fora', 'intacto'));
    for (const bad of ['../fora', '..\\fora', '../../fora', 'a/b', 'a\\b', '..', '.', 'vps.bak', '', 'C:vps', 'x'.repeat(65)]) {
      await expect(readSkillSource(userT(skills, bad))).rejects.toThrow('nome');
      await expect(saveSkill({ ...userT(skills, bad), content: 'pwn', backupDir })).rejects.toThrow('nome');
      await expect(deleteSkill({ ...userT(skills, bad), backupDir, settingsBackupDir, hookFiles: [] })).rejects.toThrow('nome');
    }
    expect(await fs.readFile(path.join(root, 'names', 'fora', 'SKILL.md'), 'utf8')).toContain('intacto');
  });
});

describe.skipIf(!dirLinkOk)('skills: link (junction) não se edita nem se apaga', () => {
  it('recusa, diz que é link e para onde aponta; o destino fica intacto', async () => {
    const tag = path.join(root, 'junction');
    const outside = path.join(tag, 'fora', 'vps');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'SKILL.md'), MD('Envia', 'Passo de vps.'));
    const skills = path.join(tag, 'home', 'skills');
    await fs.mkdir(skills, { recursive: true });
    await fs.symlink(outside, path.join(skills, 'vps'), 'junction');
    const backupDir = path.join(tag, 'backups', 'skills');
    const settingsBackupDir = path.join(tag, 'backups', 'settings');
    const dest = path.resolve(outside);

    await expect(saveSkill({ ...userT(skills, 'vps'), content: 'x', backupDir })).rejects.toThrow(dest);
    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: [] })).rejects.toThrow('link');
    expect(await readSkillSource(userT(skills, 'vps'))).toMatchObject({ editable: false, link: dest });
    expect(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8')).toContain('Passo de vps.');
  });
});

describe.skipIf(!fileLinkOk)('skills: SKILL.md que é link não se grava', () => {
  it('recusa gravar e apagar quando o SKILL.md é symlink', async () => {
    const tag = path.join(root, 'filelink');
    const outside = path.join(tag, 'fora.md');
    await fs.mkdir(tag, { recursive: true });
    await fs.writeFile(outside, MD('Envia', 'Passo de vps.'));
    const skills = path.join(tag, 'home', 'skills');
    await fs.mkdir(path.join(skills, 'vps'), { recursive: true });
    await fs.symlink(outside, path.join(skills, 'vps', 'SKILL.md'), 'file');
    const backupDir = path.join(tag, 'backups', 'skills');
    const settingsBackupDir = path.join(tag, 'backups', 'settings');
    await expect(saveSkill({ ...userT(skills, 'vps'), content: 'x', backupDir })).rejects.toThrow('link');
    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: [] })).rejects.toThrow('link');
    expect(await fs.readFile(outside, 'utf8')).toContain('Passo de vps.');
  });
});

describe('skills: hook apontando para a pasta pede confirmação', () => {
  it('sem confirmação: avisa com arquivo e evento, não apaga nada e não mostra o comando', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('hook-warn');
    const settings = path.join(claudeHome, 'settings.json');
    const script = path.join(skills, 'vps', 'run.ps1');
    // Caixa alta e barras `/`: a checagem normaliza os dois.
    const command = script.replace(/\\/g, '/').toUpperCase();
    const before = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'powershell', args: ['-File', command] }] }] } });
    await fs.writeFile(settings, before);

    const res = await deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: hookFilesOf(claudeHome, []) });
    expect(res).toEqual({ needsConfirm: true, hooks: [{ file: settings, event: 'PreToolUse' }] });
    expect(JSON.stringify(res)).not.toMatch(/run\.ps1|powershell/i);
    expect(await fs.readFile(settings, 'utf8')).toBe(before);
    expect(await fs.readdir(skills)).toEqual(['vps']);
    expect(await fs.readFile(path.join(skills, 'vps', 'SKILL.md'), 'utf8')).toContain('Passo de vps.');
    await expect(fs.stat(settingsBackupDir)).rejects.toThrow();
    await expect(fs.stat(path.join(backupDir, '.lixeira'))).rejects.toThrow();
  });

  it('com confirmação: tira só o hook da skill (o outro do mesmo grupo fica), faz backup e manda a skill para a lixeira', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('hook-yes');
    const settings = path.join(claudeHome, 'settings.json');
    const mine = `node "${path.join(skills, 'vps', 'x.mjs')}"`;
    const original = JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hit('echo ok'), hit(mine)] }] } }, null, 2) + '\n';
    await fs.writeFile(settings, original);

    const res = await deleteSkill({
      ...userT(skills, 'vps'),
      backupDir,
      settingsBackupDir,
      hookFiles: hookFilesOf(claudeHome, []),
      removeHooks: [{ file: settings, event: 'PreToolUse' }],
    });
    const trash = trashed(res);
    expect(res).toMatchObject({ removedHooks: [{ file: settings, event: 'PreToolUse' }] });

    // O settings: só o hook da skill saiu; o resto (inclusive a chave `model`) fica, com o formato padrão.
    const after = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hit('echo ok')] }] } };
    expect(await fs.readFile(settings, 'utf8')).toBe(JSON.stringify(after, null, 2) + '\n');

    // Backup do settings como estava antes, com o nome seguro e o carimbo.
    const [bk] = await fs.readdir(settingsBackupDir);
    expect(bk).toMatch(/^settings-[0-9a-f]{8}\./);
    expect(res).toMatchObject({ settingsBackups: [path.join(settingsBackupDir, bk!)] });
    expect(await fs.readFile(path.join(settingsBackupDir, bk!), 'utf8')).toBe(original);

    await expect(fs.stat(path.join(skills, 'vps'))).rejects.toThrow();
    expect(await fs.readFile(path.join(trash, 'SKILL.md'), 'utf8')).toContain('Passo de vps.');
  });

  it('grupo que fica sem hooks sai, evento que fica vazio sai, `hooks` vazio sai; o resto do arquivo fica', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('hook-empty');
    const settings = path.join(claudeHome, 'settings.json');
    const local = path.join(claudeHome, 'settings.local.json');
    const mine = `node "${path.join(skills, 'vps', 'x.mjs')}"`;
    await fs.writeFile(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [hit(mine)] }],
          PostToolUse: [
            { matcher: 'Edit', hooks: [hit(mine)] },
            { matcher: 'Bash', hooks: [hit('echo ok')] },
          ],
        },
      }),
    );
    await fs.writeFile(local, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [hit(mine)] }] } }));
    const asked = [
      { file: settings, event: 'Stop' },
      { file: settings, event: 'PostToolUse' },
      { file: local, event: 'Stop' },
    ];

    const res = await deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: hookFilesOf(claudeHome, []), removeHooks: asked });
    trashed(res);
    expect(res).toMatchObject({ removedHooks: asked });
    expect(JSON.parse(await fs.readFile(settings, 'utf8'))).toEqual({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [hit('echo ok')] }] } });
    // `hooks` era só isso: sai, e a outra chave fica.
    expect(JSON.parse(await fs.readFile(local, 'utf8'))).toEqual({ theme: 'dark' });
    expect(await fs.readdir(settingsBackupDir)).toHaveLength(2);
  });

  it('confirmação que não bate com o achado (mudou desde o aviso): recusa e não mexe em nada', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('hook-diverge');
    const settings = path.join(claudeHome, 'settings.json');
    const before = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [hit(`node "${path.join(skills, 'vps', 'x.mjs')}"`)] }] } });
    await fs.writeFile(settings, before);
    const hookFiles = hookFilesOf(claudeHome, []);
    const msg = 'os hooks mudaram desde o aviso: confirme de novo';

    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles, removeHooks: [{ file: settings, event: 'Stop' }] })).rejects.toThrow(msg);
    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles, removeHooks: [] })).rejects.toThrow(msg);
    expect(await fs.readFile(settings, 'utf8')).toBe(before);
    expect(await fs.readdir(skills)).toEqual(['vps']);
    await expect(fs.stat(settingsBackupDir)).rejects.toThrow();
  });

  it('hook com forma que não dá para tirar sozinho (sem o grupo `hooks`): recusa com ou sem confirmação', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('hook-shape');
    const settings = path.join(claudeHome, 'settings.json');
    const before = JSON.stringify({ hooks: { Stop: [{ command: `node "${path.join(skills, 'vps', 'x.mjs')}"` }] } });
    await fs.writeFile(settings, before);
    const hookFiles = hookFilesOf(claudeHome, []);
    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles })).rejects.toThrow('formato que não dá para tirar');
    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles, removeHooks: [{ file: settings, event: 'Stop' }] })).rejects.toThrow(
      'formato que não dá para tirar',
    );
    expect(await fs.readFile(settings, 'utf8')).toBe(before);
  });

  it('falha ao mandar para a lixeira: os settings voltam ao texto de antes', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('hook-fail');
    const settings = path.join(claudeHome, 'settings.json');
    const original = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [hit(`node "${path.join(skills, 'vps', 'x.mjs')}"`), hit('echo ok')] }] } }, null, 2) + '\n';
    await fs.writeFile(settings, original);
    // A lixeira não pode ser criada (`.lixeira` é um arquivo): o settings já foi mudado e tem de voltar.
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, '.lixeira'), 'não é pasta');

    await expect(
      deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: hookFilesOf(claudeHome, []), removeHooks: [{ file: settings, event: 'PreToolUse' }] }),
    ).rejects.toThrow();
    expect(await fs.readFile(settings, 'utf8')).toBe(original);
    expect(await fs.readdir(settingsBackupDir)).toHaveLength(1);
    expect(await fs.readdir(skills)).toEqual(['vps']);
  });

  it('skill de projeto: hook relativo (.claude/skills/<nome>) no settings.local do projeto pede confirmação, e a confirmação tira', async () => {
    const proj = path.join(root, 'hook-proj', 'app');
    const skills = path.join(proj, '.claude', 'skills');
    await fs.mkdir(path.join(skills, 'deploy'), { recursive: true });
    await fs.writeFile(path.join(skills, 'deploy', 'SKILL.md'), MD('Faz deploy', 'x'));
    const local = path.join(proj, '.claude', 'settings.local.json');
    await fs.writeFile(local, JSON.stringify({ hooks: { Stop: [{ hooks: [hit('node .claude\\skills\\deploy\\hook.mjs')] }] } }));
    const claudeHome = path.join(root, 'hook-proj', 'home');
    const t = { scope: 'project' as const, owner: 'p-hook', root: skills, name: 'deploy' };
    const backupDir = path.join(root, 'hook-proj', 'backups', 'skills');
    const settingsBackupDir = path.join(root, 'hook-proj', 'backups', 'settings');
    const hookFiles = hookFilesOf(claudeHome, [proj]);

    expect(await deleteSkill({ ...t, backupDir, settingsBackupDir, hookFiles })).toEqual({ needsConfirm: true, hooks: [{ file: local, event: 'Stop' }] });
    const res = await deleteSkill({ ...t, backupDir, settingsBackupDir, hookFiles, removeHooks: [{ file: local, event: 'Stop' }] });
    trashed(res);
    // Só tinha `hooks`: o arquivo fica como `{}`.
    expect(JSON.parse(await fs.readFile(local, 'utf8'))).toEqual({});
  });

  it('skill da conta: hook em settings de OUTRO projeto conhecido também pede confirmação', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('other-proj');
    const other = path.join(root, 'other-proj', 'outro');
    await fs.mkdir(path.join(other, '.claude'), { recursive: true });
    const local = path.join(other, '.claude', 'settings.json');
    await fs.writeFile(local, JSON.stringify({ hooks: { SessionStart: [{ hooks: [hit(`node "${path.join(skills, 'vps', 'x.mjs')}"`)] }] } }));
    expect(await deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: hookFilesOf(claudeHome, [other]) })).toEqual({
      needsConfirm: true,
      hooks: [{ file: local, event: 'SessionStart' }],
    });
    // Sem o projeto na lista (ele não é conhecido pelo Club), não há checagem nele: a regra é de quem passa a lista.
    expect(trashed(await deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: hookFilesOf(claudeHome, []) }))).toBeTruthy();
  });

  it('o schema da exclusão aceita removeHooks opcional e recusa formato errado', () => {
    expect(SkillDeleteInput.safeParse({ scope: 'user', name: 'vps' }).success).toBe(true);
    expect(SkillDeleteInput.safeParse({ scope: 'user', name: 'vps', removeHooks: [{ file: 'a', event: 'Stop' }] }).success).toBe(true);
    expect(SkillDeleteInput.safeParse({ scope: 'user', name: 'vps', removeHooks: 'a' }).success).toBe(false);
  });
});

describe('skills: settings ilegível ou inválido bloqueia a exclusão', () => {
  it('JSON inválido: recusa (com ou sem confirmação) e a skill fica', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('badjson');
    const settings = path.join(claudeHome, 'settings.json');
    await fs.writeFile(settings, '{ "hooks": ');
    const hookFiles = hookFilesOf(claudeHome, []);
    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles })).rejects.toThrow(`${settings} não é um JSON válido`);
    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles, removeHooks: [] })).rejects.toThrow(
      `${settings} não é um JSON válido`,
    );
    expect(await fs.readdir(skills)).toEqual(['vps']);
  });

  it('hooks com formato que não dá para ler: recusa', async () => {
    const { claudeHome, skills, backupDir, settingsBackupDir } = await setup('badhooks');
    await fs.writeFile(path.join(claudeHome, 'settings.local.json'), JSON.stringify({ hooks: ['nada'] }));
    await expect(deleteSkill({ ...userT(skills, 'vps'), backupDir, settingsBackupDir, hookFiles: hookFilesOf(claudeHome, []) })).rejects.toThrow('formato inválido');
    expect(await fs.readdir(skills)).toEqual(['vps']);
  });
});

describe('ficha: skill que não existe mais', () => {
  it('marca a skill ausente, e o texto fixo da skill vps sai da seção de servidores', () => {
    const base = {
      id: 'ana-1a2b', projectId: 'p', name: 'Ana', role: 'Dev', portrait: null, mission: 'x', firstTask: '', reportsTo: [], autonomy: 'manual',
      agents: [], mcps: null, knowledge: [], rules: [], doneWhen: '', canHire: false, worktree: false, browser: false, playbook: null, sessions: [],
      model: null, effort: null, createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
    };
    const p = { ...base, skills: ['vps', 'sumiu'], servers: [] } as unknown as StaffProfile;
    const ctx: FichaContext = { company: 'X', projectName: 'p', projectPath: '/p', managerNames: [], fichaPath: 'f', memoryPath: 'm', mycoUrl: 'u', knownSkills: ['vps'] };

    const md = renderFicha(p, ctx);
    expect(md).toContain('Skills: vps, `sumiu` (não existe mais: avise o usuário).');
    expect(md).not.toContain('Ou a skill');
    expect(md).not.toContain('skill `vps`');

    // Com conexão, a seção de servidores não cita mais a skill vps.
    const withServer = renderFicha(
      { ...p, servers: ['prod'] } as unknown as StaffProfile,
      { ...ctx, servers: [{ name: 'prod', source: 'vps', protocol: 'ssh', host: 'vps-a', remoteRoot: '/var/www/app' }] },
    );
    expect(withServer).toContain('ssh -F "');
    expect(withServer).not.toContain('Ou a skill');
    expect(withServer).not.toContain('skill `vps`');

    // Sem a lista de existentes (ctx sem knownSkills), nada é marcado como ausente.
    expect(renderFicha(p, { ...ctx, knownSkills: undefined })).not.toContain('não existe mais: avise o usuário).');
  });
});
