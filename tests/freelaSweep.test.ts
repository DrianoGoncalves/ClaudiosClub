import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigPatch, readConfig, setArchived, updateConfig } from '../server/config';
import { sweepFreelas, type FreelaSweepDeps } from '../server/freelaSweep';
import type { LiveSession, Project, Session, StaffProfile } from '../shared/model';

const NOW = new Date('2026-11-10T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

let root: string;
let file: string;
let n = 0;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-freela-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  file = path.join(root, `config-${n++}`, 'config.json');
});

const project = { id: 'p1', path: path.join(os.tmpdir(), 'p1'), name: 'p1', exists: true } as unknown as Project;
const session = (id: string, updatedAt: string, live: Partial<LiveSession> | null = null) =>
  ({ id, updatedAt, live: live as LiveSession | null }) as unknown as Session;

/** Sessões mutáveis (o teste muda `updatedAt` para simular atividade nova). */
function world(sessions: Session[], opts: { owned?: string[]; alive?: string[]; failList?: boolean } = {}) {
  const state = { sessions };
  const deps: FreelaSweepDeps = {
    configFile: file,
    adapter: {
      listProjects: async () => [project],
      getProjectSessions: async (_id: string, query?: { includeOld?: boolean }) => {
        if (opts.failList) throw new Error('falhou');
        // Como o adapter real: sem includeOld, a retenção (7 dias) esconde as antigas.
        if (query?.includeOld) return state.sessions;
        return state.sessions.filter((s) => Date.parse(s.updatedAt) >= NOW.getTime() - 7 * 86_400_000);
      },
      listLiveSessions: async () => (opts.alive ?? []).map((sessionId) => ({ sessionId, alive: true }) as LiveSession),
    },
    staff: {
      listAll: async () => (opts.owned?.length ? [{ id: 'st', sessions: opts.owned.map((id) => ({ id })) } as unknown as StaffProfile] : []),
    },
  };
  return { state, deps };
}

describe('varredura de freelas', () => {
  it('padrão: 3 dias, e o controle começa vazio', async () => {
    const c = await readConfig(file);
    expect(c.freelaArchiveDays).toBe(3);
    expect(c.freelaAutoArchived).toEqual({});
  });

  it('arquiva sem ficha parado há mais de N dias; ficha, viva e recente ficam', async () => {
    const { deps } = world(
      [session('velho', daysAgo(5)), session('ficha', daysAgo(30)), session('viva', daysAgo(30)), session('recente', daysAgo(1)), session('viva2', daysAgo(30), { alive: true })],
      { owned: ['ficha'], alive: ['viva'] },
    );
    expect(await sweepFreelas(deps, NOW)).toEqual(['velho']);
    const c = await readConfig(file);
    expect(c.archived.sessions).toEqual(['velho']);
    expect(c.freelaAutoArchived).toEqual({ velho: daysAgo(5) });
  });

  it('a varredura vê as antigas (includeOld): freela parada há 10 dias é arquivado mesmo com o corte da listagem', async () => {
    const { deps } = world([session('velho10', daysAgo(10))]);
    expect(await sweepFreelas(deps, NOW)).toEqual(['velho10']);
  });

  it('usa o N configurado e 0 desliga', async () => {
    const { deps } = world([session('a', daysAgo(5)), session('b', daysAgo(10))]);
    await updateConfig({ freelaArchiveDays: 7 }, file);
    expect(await sweepFreelas(deps, NOW)).toEqual(['b']);

    await updateConfig({ freelaArchiveDays: 0 }, file);
    expect(await sweepFreelas(deps, new Date(NOW.getTime() + 365 * 86_400_000))).toEqual([]);
    expect((await readConfig(file)).archived.sessions).toEqual(['b']);
  });

  it('não mexe no que já está arquivado nem em projeto arquivado', async () => {
    const { deps } = world([session('a', daysAgo(9))]);
    await setArchived({ kind: 'project', id: 'p1', archived: true }, file);
    expect(await sweepFreelas(deps, NOW)).toEqual([]);
    await setArchived({ kind: 'project', id: 'p1', archived: false }, file);
    await setArchived({ kind: 'session', id: 'a', archived: true }, file);
    expect(await sweepFreelas(deps, NOW)).toEqual([]);
    expect((await readConfig(file)).freelaAutoArchived).toEqual({}); // arquivada por você: não é do controle
  });

  it('desarquivada não volta sem atividade nova; com atividade nova e nova inatividade, volta a valer', async () => {
    const { state, deps } = world([session('a', daysAgo(5))]);
    expect(await sweepFreelas(deps, NOW)).toEqual(['a']);

    await setArchived({ kind: 'session', id: 'a', archived: false }, file);
    expect(await sweepFreelas(deps, NOW)).toEqual([]);
    expect(await sweepFreelas(deps, new Date(NOW.getTime() + 30 * 86_400_000))).toEqual([]); // mais tempo parada: igual
    expect((await readConfig(file)).archived.sessions).toEqual([]);

    // Atividade nova (updatedAt mudou), ainda recente: fica.
    state.sessions = [session('a', daysAgo(1))];
    expect(await sweepFreelas(deps, NOW)).toEqual([]);
    // Parou de novo por mais de N dias: arquiva outra vez.
    const later = new Date(NOW.getTime() + 4 * 86_400_000);
    expect(await sweepFreelas(deps, later)).toEqual(['a']);
    expect((await readConfig(file)).freelaAutoArchived).toEqual({ a: daysAgo(1) });
  });

  it('o controle esquece sessões que não existem mais e tem teto de tamanho', async () => {
    const { state, deps } = world([session('a', daysAgo(5)), session('b', daysAgo(6))]);
    await sweepFreelas(deps, NOW);
    expect(Object.keys((await readConfig(file)).freelaAutoArchived).sort()).toEqual(['a', 'b']);

    state.sessions = [session('b', daysAgo(6))];
    await sweepFreelas(deps, NOW);
    expect((await readConfig(file)).freelaAutoArchived).toEqual({ b: daysAgo(6) });

    // Se a listagem falhou, não dá para saber o que existe: nada é esquecido.
    const failing = world([], { failList: true });
    await sweepFreelas({ ...failing.deps, configFile: file }, NOW);
    expect((await readConfig(file)).freelaAutoArchived).toEqual({ b: daysAgo(6) });

    // Teto: o controle guarda no máximo 500 (as mais recentes).
    const many = Array.from({ length: 520 }, (_, i) => session(`s${i}`, new Date(NOW.getTime() - (4 + i / 1000) * 86_400_000).toISOString()));
    const big = world(many);
    await sweepFreelas({ ...big.deps, configFile: file }, NOW);
    const c = await readConfig(file);
    expect(Object.keys(c.freelaAutoArchived)).toHaveLength(500);
    expect(c.archived.sessions.length).toBeGreaterThanOrEqual(520);
  });

  it('não grava o arquivo quando nada mudou', async () => {
    const { deps } = world([session('a', daysAgo(5))]);
    await sweepFreelas(deps, NOW);
    const before = await fs.stat(file);
    await fs.utimes(file, new Date(0), new Date(0));
    expect(await sweepFreelas(deps, NOW)).toEqual([]);
    expect((await fs.stat(file)).mtimeMs).toBe(0);
    expect(before.size).toBeGreaterThan(0);
  });

  it('config: valida freelaArchiveDays (inteiro de 0 a 90) e normaliza o arquivo editado à mão', async () => {
    for (const ok of [0, 1, 3, 90]) expect(ConfigPatch.safeParse({ freelaArchiveDays: ok }).success, String(ok)).toBe(true);
    for (const bad of [-1, 91, 1.5, '3', null, Number.NaN]) expect(ConfigPatch.safeParse({ freelaArchiveDays: bad }).success, String(bad)).toBe(false);

    expect((await updateConfig(ConfigPatch.parse({ freelaArchiveDays: 10 }), file)).freelaArchiveDays).toBe(10);
    await updateConfig(ConfigPatch.parse({ companyName: 'X' }), file);
    expect((await readConfig(file)).freelaArchiveDays).toBe(10);

    await fs.writeFile(file, JSON.stringify({ freelaArchiveDays: 500, freelaAutoArchived: { a: '2026-01-01', b: 7 } }));
    const c = await readConfig(file);
    expect(c.freelaArchiveDays).toBe(3);
    expect(c.freelaAutoArchived).toEqual({ a: '2026-01-01' });
  });

  it('duas gravações do config ao mesmo tempo não se perdem', async () => {
    await Promise.all([
      updateConfig({ companyName: 'Acme' }, file),
      updateConfig({ freelaArchiveDays: 9 }, file),
      setArchived({ kind: 'session', id: 'x', archived: true }, file),
    ]);
    const c = await readConfig(file);
    expect(c).toMatchObject({ companyName: 'Acme', freelaArchiveDays: 9, archived: { sessions: ['x'] } });
  });
});
