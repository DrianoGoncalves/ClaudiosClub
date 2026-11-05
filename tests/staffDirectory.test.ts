import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type DirectoryPerson } from '../client/src/api';
import { copyCandidates, hireDrop } from '../client/src/staff/directory';

const person = (over: Partial<DirectoryPerson>): DirectoryPerson => ({
  projectId: 'p1',
  projectName: 'Loja',
  staffId: 's1',
  name: 'Ana',
  role: 'Dev',
  mission: '',
  hasPortrait: false,
  updatedAt: '2026-11-05T00:00:00.000Z',
  ...over,
});

const people = [
  person({ staffId: 'a', name: 'Zé', role: 'Gestão de tráfego', projectName: 'Loja' }),
  person({ staffId: 'b', name: 'Bia', role: 'Design system', projectId: 'p2', projectName: 'Blog' }),
  person({ staffId: 'c', name: 'Caio', role: 'Dev', projectId: 'here', projectName: 'Aqui' }),
];

describe('contratar da empresa', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('esconde as fichas do próprio projeto e ordena por nome', () => {
    expect(copyCandidates(people, 'here', '').map((p) => p.name)).toEqual(['Bia', 'Zé']);
  });

  it('busca por nome, cargo ou projeto, sem acento e com várias palavras', () => {
    expect(copyCandidates(people, 'here', 'gestao').map((p) => p.staffId)).toEqual(['a']);
    expect(copyCandidates(people, 'here', 'BLOG').map((p) => p.staffId)).toEqual(['b']);
    expect(copyCandidates(people, 'here', 'design bia').map((p) => p.staffId)).toEqual(['b']);
    expect(copyCandidates(people, 'here', 'caio')).toEqual([]);
  });

  it('soltar o "+": outro projeto copia, colega do mesmo projeto vincula, o resto abre as opções', () => {
    const a = { projectId: 'A', staffId: null };
    const chefe = { projectId: 'A', staffId: 'chefe' };
    expect(hireDrop(a, { projectId: 'B', staffId: 'x' })).toEqual({ kind: 'copy', fromProjectId: 'B', staffId: 'x' });
    expect(hireDrop(chefe, { projectId: 'B', staffId: 'x' })).toEqual({ kind: 'copy', fromProjectId: 'B', staffId: 'x' });
    expect(hireDrop(chefe, { projectId: 'A', staffId: 'y' })).toEqual({ kind: 'link', staffId: 'y' });
    expect(hireDrop(a, { projectId: 'A', staffId: 'y' })).toEqual({ kind: 'options' });
    expect(hireDrop(a, null)).toEqual({ kind: 'options' });
    expect(hireDrop(a, { projectId: 'B', staffId: null })).toEqual({ kind: 'options' });
  });

  it('pede a cópia com a memória só quando marcada', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ profile: { id: 'novo' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', new EventTarget()); // o POST avisa o pareamento por evento
    const r = await api.copyStaff('here', { fromProjectId: 'p2', staffId: 'b', withMemory: false });
    expect(r.profile.id).toBe('novo');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/here/staff/copy');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ fromProjectId: 'p2', staffId: 'b', withMemory: false });
  });
});
