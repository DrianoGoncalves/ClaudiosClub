import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES } from '../shared/roles';
import { listRoles, removeRole, restoreBuiltins, saveRole, setDefaultRole } from '../server/roles';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-roles-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const custom = { label: 'Copywriter', role: 'Redator(a)', mission: 'Escrever os textos do site.', autonomy: 'acceptEdits', rules: ['Tom simples'], doneWhen: '', model: 'haiku', effort: 'low' };

describe('cargos', () => {
  it('sem arquivo: os prontos, cada um com modelo', async () => {
    const list = await listRoles(path.join(root, 'vazio.json'));
    expect(list.map((r) => r.id)).toEqual(BUILTIN_ROLES.map((r) => r.id));
    expect(list.every((r) => r.builtin && !r.edited && r.model)).toBe(true);
  });

  it('cria o seu, edita um pronto (e volta ao original), tira e devolve prontos', async () => {
    const file = path.join(root, 'a.json');
    let list = await saveRole(custom, file);
    const mine = list.find((r) => r.label === 'Copywriter')!;
    expect(mine).toMatchObject({ id: 'copywriter', builtin: false, model: 'haiku' });
    expect((await saveRole({ ...custom, label: 'Copywriter' }, file)).filter((r) => r.label === 'Copywriter').map((r) => r.id)).toEqual(['copywriter', 'copywriter-2']);

    const dev = BUILTIN_ROLES.find((r) => r.id === 'desenvolvedor')!;
    list = await saveRole({ ...dev, model: 'opus' }, file);
    expect(list.find((r) => r.id === 'desenvolvedor')).toMatchObject({ model: 'opus', edited: true, builtin: true });
    list = await removeRole('desenvolvedor', file); // volta ao original
    expect(list.find((r) => r.id === 'desenvolvedor')).toMatchObject({ model: dev.model, edited: false });
    list = await removeRole('desenvolvedor', file); // agora tira da lista
    expect(list.some((r) => r.id === 'desenvolvedor')).toBe(false);
    list = await restoreBuiltins(file);
    expect(list.some((r) => r.id === 'desenvolvedor')).toBe(true);

    list = await removeRole('copywriter-2', file);
    expect(list.some((r) => r.id === 'copywriter-2')).toBe(false);
    await expect(removeRole('nao-existe', file)).rejects.toThrow(/não encontrado/);
  });

  it('o padrão da contratação: escolhe, troca, some junto com o cargo; valida o cargo', async () => {
    const file = path.join(root, 'b.json');
    await saveRole(custom, file);
    expect((await setDefaultRole('copywriter', file)).find((r) => r.isDefault)?.id).toBe('copywriter');
    expect((await setDefaultRole('infra', file)).filter((r) => r.isDefault).map((r) => r.id)).toEqual(['infra']);
    await setDefaultRole('copywriter', file);
    expect((await removeRole('copywriter', file)).some((r) => r.isDefault)).toBe(false);
    await expect(setDefaultRole('fantasma', file)).rejects.toThrow(/não encontrado/);
    await expect(saveRole({ ...custom, label: ' ' }, file)).rejects.toThrow(/nome/);
    await expect(saveRole({ ...custom, model: 'opus; rm -rf' }, file)).rejects.toThrow(/modelo inválido/);
  });
});
