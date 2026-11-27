import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_PRESETS, PLAYBOOK_AGENTS } from '../shared/agentPresets';
import { BUILTIN_NICHES, BUILTIN_ROLES, NICHES } from '../shared/roles';
import { listRoles, removeRole, restoreBuiltins, saveRole, setDefaultRole } from '../server/roles';
import { removeTemp } from './support/tmp';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-roles-'));
});
afterAll(() => removeTemp(root));

const custom = { label: 'Copywriter', role: 'Redator(a)', mission: 'Escrever os textos do site.', autonomy: 'acceptEdits', rules: ['Tom simples'], doneWhen: '', model: 'haiku', effort: 'low' };

// Quem edita código nasce pensador (planeja, delega o braçal, confere o diff); quem só decide ou audita não implementa e não muda.
const IMPLEMENTERS = ['desenvolvedor', 'dados', 'frontend', 'design-system', 'web-designer', 'trafego', 'ia', 'testador', 'infra', 'documentacao'];
const NOT_IMPLEMENTERS = ['produto', 'planejador', 'revisor', 'seguranca'];

describe('cargos que implementam: pensam e delegam', () => {
  it('todo cargo pronto está numa das listas (cargo novo obriga a decidir se implementa)', () => {
    expect(BUILTIN_ROLES.map((r) => r.id).sort()).toEqual([...IMPLEMENTERS, ...NOT_IMPLEMENTERS, 'orquestrador'].sort());
  });

  it('pré-marcam os agents executor, executor-rapido, pesquisador e revisor e o roteiro planejar → delegar → conferir', () => {
    for (const id of IMPLEMENTERS) {
      const role = BUILTIN_ROLES.find((r) => r.id === id)!;
      expect(role, id).toMatchObject({ pickExecutors: true, playbook: 'plan-big-execute-small' });
    }
    // O roteiro é quem chama estes quatro, e todos têm pronto (o Club cria o que faltar no projeto).
    expect([...PLAYBOOK_AGENTS['plan-big-execute-small']].sort()).toEqual(['executor', 'executor-rapido', 'pesquisador', 'revisor']);
    for (const name of PLAYBOOK_AGENTS['plan-big-execute-small']) expect(AGENT_PRESETS.some((p) => p.name === name), name).toBe(true);
  });

  it('produto, arquiteto, revisor e segurança não mudam: sem roteiro de delegação nem agents marcados', () => {
    for (const id of NOT_IMPLEMENTERS) {
      const role = BUILTIN_ROLES.find((r) => r.id === id)!;
      expect(role.playbook ?? null, id).toBeNull();
      expect(role.pickExecutors, id).toBeUndefined();
    }
    // O orquestrador segue como era.
    expect(BUILTIN_ROLES.find((r) => r.id === 'orquestrador')).toMatchObject({ pickExecutors: true, playbook: 'plan-big-execute-small' });
  });

  it('o orquestrador sabe como criar tag à mão: bloco "Tarefas:" com "- t-xxxxxx Título" e "(t-xxxxxx)" no título do commit', () => {
    const rule = BUILTIN_ROLES.find((r) => r.id === 'orquestrador')!.rules.find((r) => r.includes('Tag de versão'))!;
    expect(rule).toContain('"Tarefas:"');
    expect(rule).toContain('"- t-xxxxxx Título"');
    expect(rule).toContain('"(t-xxxxxx)"');
  });

  it('a versão que o dono já gravou de um pronto não é tocada (só o pronto novo muda)', async () => {
    const file = path.join(root, 'versao-antiga.json');
    const dev = BUILTIN_ROLES.find((r) => r.id === 'desenvolvedor')!;
    const { pickExecutors: _p, playbook: _b, ...old } = dev;
    await saveRole(old, file);
    const kept = (await listRoles(file)).find((r) => r.id === 'desenvolvedor')!;
    expect(kept.edited).toBe(true);
    expect(kept.playbook).toBeUndefined();
    // Voltando ao original, o cargo pronto traz o roteiro.
    expect((await removeRole('desenvolvedor', file)).find((r) => r.id === 'desenvolvedor')).toMatchObject({ edited: false, playbook: 'plan-big-execute-small', pickExecutors: true });
  });
});

describe('cargos', () => {
  it('sem arquivo: os prontos, cada um com modelo', async () => {
    const list = await listRoles(path.join(root, 'vazio.json'));
    expect(list.map((r) => r.id)).toEqual(BUILTIN_ROLES.map((r) => r.id));
    expect(list.every((r) => r.builtin && !r.edited && r.model)).toBe(true);
    // O padrão é o orquestrador, que já vem podendo contratar.
    expect(list.filter((r) => r.isDefault).map((r) => [r.id, r.canHire])).toEqual([['orquestrador', true]]);
  });

  it('padrão: "nenhum" escolhido continua nenhum', async () => {
    const file = path.join(root, 'sem-padrao.json');
    expect((await setDefaultRole(null, file)).some((r) => r.isDefault)).toBe(false);
    expect((await listRoles(file)).some((r) => r.isDefault)).toBe(false);
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

describe('nichos dos cargos', () => {
  it('cada cargo pronto está nos nichos da descrição, e o orquestrador em todos', () => {
    for (const n of NICHES) {
      const ids = BUILTIN_ROLES.filter((r) => r.niches?.includes(n)).map((r) => r.id);
      expect(ids.sort()).toEqual([...BUILTIN_NICHES[n]].sort());
      expect(ids).toContain('orquestrador');
    }
    expect(BUILTIN_ROLES.find((r) => r.id === 'dados')!.niches).toEqual(['software-factory', 'ecommerce', 'ai-product', 'infra', 'data-bi']);
    for (const r of BUILTIN_ROLES) expect(r.niches!.length).toBeGreaterThan(0);
  });

  it('salva e devolve os nichos do cargo seu (sem repetir) e rejeita nicho que não existe', async () => {
    const file = path.join(root, 'niches.json');
    const list = await saveRole({ ...custom, niches: ['sites', 'infra', 'sites'] }, file);
    expect(list.find((r) => r.label === 'Copywriter')!.niches).toEqual(['sites', 'infra']);
    await expect(saveRole({ ...custom, niches: ['agencia'] }, file)).rejects.toThrow();
    const sem = await saveRole({ ...custom, label: 'Sem nicho' }, file);
    expect(sem.find((r) => r.label === 'Sem nicho')!.niches).toBeUndefined();
  });

  it('pronto sem nichos salvos usa os do código; com nichos salvos usa os da sua versão', async () => {
    const file = path.join(root, 'niches-builtin.json');
    const base = BUILTIN_ROLES.find((r) => r.id === 'infra')!;
    const { niches: _n, ...semNichos } = base;
    let list = await saveRole(semNichos, file);
    expect(list.find((r) => r.id === 'infra')).toMatchObject({ edited: true, niches: base.niches });
    list = await saveRole({ ...semNichos, niches: ['sites'] }, file);
    expect(list.find((r) => r.id === 'infra')!.niches).toEqual(['sites']);
  });

  it('nicho que não existe mais no arquivo sai da lista sem derrubar o cargo', async () => {
    const file = path.join(root, 'niches-old.json');
    await fs.writeFile(file, JSON.stringify({ items: [{ ...custom, id: 'velho', niches: ['sites', 'extinto'] }], removed: [], defaultId: null }));
    const list = await listRoles(file);
    expect(list.find((r) => r.id === 'velho')!.niches).toEqual(['sites']);
  });
});
