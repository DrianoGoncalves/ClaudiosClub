import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, deleteStaffConfirm, type DirectoryStaff } from '../client/src/api';
import type { StaffProfile } from '../shared/model';
import { differingFields, fieldsThatDiffer, hrGroups, linkTargets, orphansOf, personGroup, sameNameGroups } from '../client/src/staff/directory';
import { memoryUsage } from '../client/src/staff/memoryUsage';

const person = (over: Partial<DirectoryStaff>): DirectoryStaff => ({
  projectId: 'p1',
  projectName: 'Loja',
  staffId: 's1',
  name: 'Ana',
  role: 'Dev',
  mission: '',
  hasPortrait: false,
  updatedAt: '2026-11-05T00:00:00.000Z',
  personId: null,
  archived: false,
  reportsTo: [],
  ...over,
});

const ana1 = person({ staffId: 'ana', personId: 'pa' });
const ana2 = person({ projectId: 'p2', projectName: 'Blog', staffId: 'ana2', personId: 'pa' });
const ana3 = person({ projectId: 'p3', projectName: 'Site', staffId: 'ana3', personId: 'pa', archived: true });
const bruno = person({ staffId: 'bruno', name: 'Bruno', role: 'QA' });
const caio = person({ projectId: 'p2', projectName: 'Blog', staffId: 'caio', name: 'Caio', role: 'Gestão' });
const all = [bruno, ana2, caio, ana1, ana3];

describe('RH: agrupar as cópias da mesma pessoa', () => {
  it('cópias com o mesmo personId num grupo; sem vínculo, uma por grupo; em ordem de nome', () => {
    const groups = hrGroups(all, '', null);
    expect(groups.map((g) => g.people.map((p) => p.staffId))).toEqual([['ana2', 'ana', 'ana3'], ['bruno'], ['caio']]);
    expect(groups.map((g) => g.total)).toEqual([3, 1, 1]);
  });

  it('filtro de projeto vale por ficha, mas o grupo conta todas as cópias', () => {
    const groups = hrGroups(all, '', 'p2');
    expect(groups.map((g) => g.people.map((p) => p.staffId))).toEqual([['ana2'], ['caio']]);
    expect(groups[0]!.total).toBe(3);
  });

  it('busca sem acento por nome, cargo ou projeto', () => {
    expect(hrGroups(all, 'gestao', null).map((g) => g.key)).toEqual(['p2/caio']);
    expect(hrGroups(all, 'site', null).map((g) => g.people.map((p) => p.staffId))).toEqual([['ana3']]);
    expect(hrGroups(all, 'ninguém', null)).toEqual([]);
  });

  it('servidor ainda sem os campos novos: tudo sem vínculo', () => {
    const old = all.map(({ personId: _p, archived: _a, reportsTo: _r, ...rest }) => rest as DirectoryStaff);
    expect(hrGroups(old, '', null)).toHaveLength(5);
    expect(orphansOf(old, { projectId: 'p1', staffId: 'ana' })).toEqual([]);
  });
});

describe('RH: uma linha por pessoa', () => {
  it('o grupo guarda todas as fichas da pessoa, mesmo as filtradas fora', () => {
    const [ana] = hrGroups(all, '', 'p2');
    expect(ana!.people.map((p) => p.staffId)).toEqual(['ana2']);
    expect(ana!.all.map((p) => p.staffId)).toEqual(['ana2', 'ana', 'ana3']);
  });

  it('a pessoa de uma ficha: as fichas com o mesmo personId, em ordem de projeto', () => {
    expect(personGroup(all, ana1).map((p) => p.staffId)).toEqual(['ana2', 'ana', 'ana3']);
    expect(personGroup(all, bruno).map((p) => p.staffId)).toEqual(['bruno']);
  });
});

describe('RH: unificar fichas de mesmo nome', () => {
  const james1 = person({ staffId: 'j1', name: 'James', role: 'Dev' });
  const james2 = person({ projectId: 'p2', projectName: 'Blog', staffId: 'j2', name: ' james ', role: 'Dev' });
  const james3 = person({ projectId: 'p3', projectName: 'Site', staffId: 'j3', name: 'JAMES' });
  const group = (people: DirectoryStaff[], p: DirectoryStaff) => hrGroups(people, '', null).find((g) => g.all.includes(p))!;

  it('mesmo nome (sem acento nem caixa), sem vínculo, em outro projeto', () => {
    const people = [james1, james2, bruno];
    expect(sameNameGroups(people, group(people, james1)).map((g) => g.map((p) => p.staffId))).toEqual([['j2']]);
    expect(sameNameGroups(people, group(people, bruno))).toEqual([]);
  });

  it('já ligados não aparecem; um grupo inteiro vem junto', () => {
    const a = { ...james1, personId: 'pj' };
    const b = { ...james2, personId: 'pj' };
    expect(sameNameGroups([a, b, james3], group([a, b, james3], a)).map((g) => g.map((p) => p.staffId))).toEqual([['j3']]);
    expect(sameNameGroups([a, b], group([a, b], a))).toEqual([]);
  });

  it('não junta duas fichas de um mesmo projeto na mesma pessoa', () => {
    const outra = person({ projectId: 'p1', projectName: 'Loja', staffId: 'j9', name: 'James' });
    const people = [james1, james2, outra];
    // A de p1 é do mesmo projeto de james1: não é candidata a ele; james2 é.
    expect(sameNameGroups(people, group(people, james1)).map((g) => g.map((p) => p.staffId))).toEqual([['j2']]);
    // Dois candidatos no mesmo projeto: entra só o primeiro.
    const dup = person({ projectId: 'p2', projectName: 'Blog', staffId: 'j8', name: 'James' });
    const trio = [james1, james2, dup];
    expect(sameNameGroups(trio, group(trio, james1))).toHaveLength(1);
  });
});

describe('RH: campos da pessoa que as fichas diferem', () => {
  const values = { name: 'Ana', role: 'Dev', mission: 'Fazer', doneWhen: 'Pronto', rules: ['a', 'b'], model: 'opus', effort: 'high', playbook: null } as const;
  const copy = (over: Partial<StaffProfile>) => ({ ...values, rules: [...values.rules], projectId: 'p2', id: 'x', ...over }) as unknown as StaffProfile;

  it('nada difere quando só muda espaço, linha vazia ou null/vazio', () => {
    const same = copy({ name: ' Ana ', rules: [' a', '', 'b '], playbook: null });
    expect(differingFields({ ...values, rules: ['a', 'b'] }, [same])).toEqual([]);
    expect(differingFields({ ...values, rules: ['a', 'b'], model: null, effort: null }, [copy({ model: null, effort: null })])).toEqual([]);
  });

  it('lista os campos e as fichas que diferem, na ordem dos campos', () => {
    const other = copy({ projectId: 'p2', mission: 'Outra', rules: ['a'] });
    const third = copy({ projectId: 'p3', mission: 'Outra', model: 'sonnet' });
    const diffs = differingFields({ ...values, rules: ['a', 'b'] }, [other, third]);
    expect(diffs.map((d) => [d.field, d.others.map((o) => o.projectId)])).toEqual([
      ['mission', ['p2', 'p3']],
      ['rules', ['p2']],
      ['model', ['p3']],
    ]);
  });

  it('entre várias fichas: os campos em que não são todas iguais', () => {
    expect(fieldsThatDiffer([copy({}), copy({ role: 'QA' }), copy({ role: 'QA', effort: 'low' })])).toEqual(['role', 'effort']);
    expect(fieldsThatDiffer([copy({})])).toEqual([]);
    expect(fieldsThatDiffer([])).toEqual([]);
  });
});

describe('memória pessoal: o que a tela conta', () => {
  it('conta como o servidor grava: sem espaço no fim, uma quebra final, vazio é zero', () => {
    expect(memoryUsage('')).toEqual({ lines: 0, bytes: 0, fits: true });
    expect(memoryUsage('  \n\n')).toEqual({ lines: 0, bytes: 0, fits: true });
    expect(memoryUsage('a  \r\nb\n\n')).toEqual({ lines: 2, bytes: 4, fits: true });
  });

  it('passa de 40 linhas ou de 4 KB: não cabe', () => {
    expect(memoryUsage('x\n'.repeat(40)).fits).toBe(true);
    expect(memoryUsage('x\n'.repeat(41))).toMatchObject({ lines: 41, fits: false });
    expect(memoryUsage('é'.repeat(2048))).toMatchObject({ lines: 1, bytes: 4097, fits: false });
    expect(memoryUsage('a'.repeat(4095))).toMatchObject({ bytes: 4096, fits: true });
  });
});

describe('RH: aviso de quem fica sem chefe ao excluir', () => {
  const boss = person({ staffId: 'chefe', name: 'Chefe' });
  const only = person({ staffId: 'a', name: 'A', reportsTo: ['chefe'] });
  const two = person({ staffId: 'b', name: 'B', reportsTo: ['chefe', 'outro'] });
  const free = person({ staffId: 'c', name: 'C' });
  // Mesmo id de chefe em outro projeto: não é subordinado desta ficha.
  const elsewhere = person({ projectId: 'p2', staffId: 'd', name: 'D', reportsTo: ['chefe'] });

  it('só quem tem ele como único chefe, no mesmo projeto', () => {
    expect(orphansOf([boss, only, two, free, elsewhere], { projectId: 'p1', staffId: 'chefe' }).map((p) => p.name)).toEqual(['A']);
  });

  it('sem subordinados, lista vazia', () => {
    expect(orphansOf([boss, free], { projectId: 'p1', staffId: 'chefe' })).toEqual([]);
  });
});

describe('RH: com quem ligar', () => {
  const targets = (who: DirectoryStaff, query = '') => linkTargets(all, hrGroups(all, '', null).find((g) => g.all.includes(who))!, query).map((p) => p.staffId);

  it('fichas de quem ainda não é a mesma pessoa e não tem ficha em projeto dela', () => {
    // Caio tem ficha em p2, onde a Ana também tem: juntar daria duas fichas num projeto.
    expect(targets(ana1)).toEqual([]);
    expect(targets(bruno)).toEqual(['caio']);
    expect(targets(bruno, 'blog')).toEqual(['caio']);
  });
});

describe('RH: chamadas da API', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (body: unknown) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { dispatchEvent: () => true });
    return fetch;
  };
  const sent = (fetch: ReturnType<typeof vi.fn>) => {
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    return { url, method: init.method, myco: (init.headers as Record<string, string>)['x-myco'], body: JSON.parse(String(init.body)) };
  };

  it('ligar, desligar e excluir são POST com x-myco', async () => {
    let f = stub({ personId: 'pa' });
    await api.linkStaff({ projectId: 'p1', staffId: 'a' }, { projectId: 'p2', staffId: 'b' });
    expect(sent(f)).toEqual({
      url: '/api/staff-link',
      method: 'POST',
      myco: '1',
      body: { from: { projectId: 'p1', staffId: 'a' }, to: { projectId: 'p2', staffId: 'b' } },
    });
    f = stub({ ok: true });
    await api.unlinkStaff({ projectId: 'p1', staffId: 'a' });
    expect(sent(f)).toMatchObject({ url: '/api/staff-unlink', body: { projectId: 'p1', staffId: 'a' } });
    f = stub({ ok: true, orphaned: ['x'] });
    expect(await api.deleteStaff('p1', 'a')).toEqual({ ok: true, orphaned: ['x'] });
    expect(sent(f)).toMatchObject({ url: '/api/projects/p1/staff/a/delete', method: 'POST' });
  });

  it('excluir com a conversa trabalhando: 409 vira erro com a mensagem do servidor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Ana está trabalhando.' }), { status: 409 })));
    vi.stubGlobal('window', { dispatchEvent: () => true });
    await expect(api.deleteStaff('p1', 'a')).rejects.toThrow('Ana está trabalhando.');
  });

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const openTasks = () => reply(409, { error: 'Ana tem 2 tarefa(s) aberta(s) no quadro.', code: 'open-tasks', openTasks: 2 });

  it('excluir com tarefas abertas: pergunta de novo e, confirmado, repete com force', async () => {
    const f = vi.fn().mockResolvedValueOnce(openTasks()).mockResolvedValueOnce(reply(200, { ok: true, orphaned: [] }));
    vi.stubGlobal('fetch', f);
    vi.stubGlobal('window', { dispatchEvent: () => true });
    const ask = vi.fn().mockReturnValue(true);
    expect(await deleteStaffConfirm('p1', 'a', ask)).toEqual({ ok: true, orphaned: [] });
    expect(ask).toHaveBeenCalledWith(2);
    const bodies = f.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies).toEqual([{}, { force: true }]);
  });

  it('excluir com tarefas abertas e recusado: não repete, devolve null', async () => {
    const f = vi.fn().mockResolvedValueOnce(openTasks());
    vi.stubGlobal('fetch', f);
    vi.stubGlobal('window', { dispatchEvent: () => true });
    expect(await deleteStaffConfirm('p1', 'a', () => false)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('outro 409 (conversa trabalhando) só vira erro, sem 2ª pergunta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(409, { error: 'Ana está trabalhando.', code: 'busy' })));
    vi.stubGlobal('window', { dispatchEvent: () => true });
    const ask = vi.fn();
    await expect(deleteStaffConfirm('p1', 'a', ask)).rejects.toThrow('Ana está trabalhando.');
    expect(ask).not.toHaveBeenCalled();
  });

  it('editar não manda mais applyToCopies: o servidor leva os campos da pessoa às cópias sempre', async () => {
    const input = { name: 'Ana' } as Parameters<typeof api.updateStaff>[2];
    const f = stub({ id: 'a', copiesUpdated: 2 });
    expect((await api.updateStaff('p1', 'a', input)).copiesUpdated).toBe(2);
    expect(sent(f).body).toEqual({ name: 'Ana' });
  });

  it('memória pessoal: garantir a pessoa é POST, ler é GET, gravar é PUT com x-myco', async () => {
    let f = stub({ personId: 'pa' });
    await api.personOf('p1', 'a');
    expect(sent(f)).toMatchObject({ url: '/api/projects/p1/staff/a/person', method: 'POST', myco: '1' });
    f = stub({ text: 'oi\n', status: 'ok' });
    expect(await api.personMemory('pa')).toEqual({ text: 'oi\n', status: 'ok' });
    expect(f.mock.calls[0]![0]).toBe('/api/people/pa/memory');
    f = stub({ text: 'novo\n', status: 'ok' });
    await api.savePersonMemory('pa', 'novo');
    expect(sent(f)).toEqual({ url: '/api/people/pa/memory', method: 'PUT', myco: '1', body: { text: 'novo' } });
  });

  it('memória acima do limite: 400 vira erro com a mensagem do servidor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'a memória passa de 40 linhas (são 41): resuma o que vale levar' }), { status: 400 })));
    vi.stubGlobal('window', { dispatchEvent: () => true });
    await expect(api.savePersonMemory('pa', 'x')).rejects.toThrow('passa de 40 linhas');
  });
});
