import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type DirectoryStaff } from '../client/src/api';
import { copiesOf, hrGroups, linkCandidates, orphansOf } from '../client/src/staff/directory';

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
    expect(copiesOf(old, { projectId: 'p1', staffId: 'ana' })).toEqual([]);
    expect(orphansOf(old, { projectId: 'p1', staffId: 'ana' })).toEqual([]);
  });
});

describe('RH: contar as cópias', () => {
  it('as outras fichas da mesma pessoa, sem a própria', () => {
    expect(copiesOf(all, { projectId: 'p1', staffId: 'ana' }).map((p) => p.staffId)).toEqual(['ana2', 'ana3']);
  });

  it('sem vínculo (ou ficha que não está na lista), nenhuma cópia', () => {
    expect(copiesOf(all, { projectId: 'p1', staffId: 'bruno' })).toEqual([]);
    expect(copiesOf(all, { projectId: 'p9', staffId: 'x' })).toEqual([]);
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
  it('fichas de outros projetos que ainda não são a mesma pessoa', () => {
    expect(linkCandidates(all, { projectId: 'p1', staffId: 'ana' }, '').map((p) => p.staffId)).toEqual(['caio']);
    expect(linkCandidates(all, { projectId: 'p1', staffId: 'bruno' }, '').map((p) => p.staffId)).toEqual(['ana2', 'ana3', 'caio']);
    expect(linkCandidates(all, { projectId: 'p1', staffId: 'bruno' }, 'blog').map((p) => p.staffId)).toEqual(['ana2', 'caio']);
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

  it('editar só manda applyToCopies quando marcado', async () => {
    const input = { name: 'Ana' } as Parameters<typeof api.updateStaff>[2];
    let f = stub({ id: 'a', copiesUpdated: 2 });
    expect((await api.updateStaff('p1', 'a', input, true)).copiesUpdated).toBe(2);
    expect(sent(f).body).toEqual({ name: 'Ana', applyToCopies: true });
    f = stub({ id: 'a' });
    await api.updateStaff('p1', 'a', input);
    expect(sent(f).body).toEqual({ name: 'Ana' });
  });
});
