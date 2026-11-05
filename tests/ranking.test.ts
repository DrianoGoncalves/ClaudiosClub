import { describe, expect, it } from 'vitest';
import type { AppConfig, Board, Project, SavingsReport, Session, SessionSavings, StaffProfile } from '../shared/model';
import { rankingGroups, rankingRows, savingsList, teamSavings, type RankingRow } from '../client/src/ranking';

// Objetos mínimos: só os campos que ranking.ts lê; o resto fica de fora (cast com `as`, como nos outros testes).
const project = (id: string, name: string) => ({ id, name }) as Project;
const session = (id: string) => ({ id }) as Session;
const staff = (id: string, projectId: string, sessions: string[]) =>
  ({ id, projectId, name: id.toUpperCase(), role: 'Dev', sessions: sessions.map((s) => ({ id: s, startedAt: '' })) }) as StaffProfile;
const board = (over: Partial<Board>) => ({ projects: [], staff: [], sessions: {}, ...over }) as Board;
const config = (projects: string[] = [], sessions: string[] = []) => ({ archived: { projects, sessions } }) as AppConfig;
const saving = (sessionId: string, usd: number, asPlannerUsd: number | null, { runs = 0, executorUsd = 0, discardedUsd = 0 } = {}): SessionSavings =>
  ({ projectId: 'a', sessionId, usd, executorUsd, asPlannerUsd, discardedUsd, runs });
const report = (sessions: SessionSavings[]): SavingsReport => ({ since: null, sessions, scanning: false });
const row = (rows: RankingRow[], nodeId: string) => rows.find((r) => r.nodeId === nodeId)!;

// Quatro com gasto: ana (+1) e caio (+4) e dan (−2) usam subagents; bia não usa.
function equipe(): RankingRow[] {
  const b = board({
    projects: [project('a', 'Alfa')],
    staff: [staff('ana', 'a', ['s1']), staff('bia', 'a', ['s2']), staff('caio', 'a', ['s3']), staff('dan', 'a', ['s4'])],
  });
  return rankingRows(
    rankingGroups(b, null),
    report([
      saving('s1', 10, 11, { runs: 1 }),
      saving('s2', 6, 6),
      saving('s3', 8, 12, { runs: 1 }),
      saving('s4', 20, 18, { runs: 2 }),
    ]),
  );
}

describe('rankingGroups', () => {
  it('sessões da ficha ficam juntas; conversa sem ficha vai para o fantasma do projeto', () => {
    const b = board({
      projects: [project('a', 'Alfa'), project('b', 'Beta')],
      staff: [staff('ana', 'a', ['s1', 's2'])],
      sessions: { a: [session('s1'), session('s2'), session('s3')], b: [session('s4')] },
    });
    const groups = rankingGroups(b, null);
    expect(groups.map((g) => [g.nodeId, g.sessionIds])).toEqual([
      ['h:a:ana', ['s1', 's2']],
      ['g:a', ['s3']],
      ['g:b', ['s4']],
    ]);
    expect(groups[0]).toMatchObject({ name: 'ANA', detail: 'Dev · Alfa', archived: false });
    expect(groups[1]).toMatchObject({ name: 'Freela', detail: 'Alfa' });
  });

  it('sessão listada em duas fichas do projeto conta uma vez só: fica com a última, como no quadro', () => {
    const b = board({
      projects: [project('a', 'Alfa')],
      staff: [staff('ana', 'a', ['s1', 's2']), staff('bia', 'a', ['s2', 's3', 's3'])],
      sessions: { a: [session('s1'), session('s2'), session('s3'), session('s4')] },
    });
    const groups = rankingGroups(b, null);
    expect(groups.map((g) => [g.nodeId, g.sessionIds])).toEqual([
      ['h:a:ana', ['s1']],
      ['h:a:bia', ['s2', 's3']],
      ['g:a', ['s4']],
    ]);
    const rows = rankingRows(groups, report([saving('s1', 1, 1), saving('s2', 10, 10), saving('s3', 5, 5)]));
    expect(rows.reduce((sum, r) => sum + r.usd, 0)).toBe(16);
  });

  it('funcionário e projeto arquivados aparecem, marcados como arquivados', () => {
    const b = board({
      projects: [project('a', 'Alfa'), project('b', 'Beta')],
      staff: [staff('ana', 'a', ['s1']), staff('bia', 'a', ['s2']), staff('caio', 'b', ['s3'])],
      sessions: { a: [session('s1'), session('s2'), session('s8'), session('s9')] },
    });
    const flags = (cfg: AppConfig) => rankingGroups(b, cfg).map((g) => [g.nodeId, g.archived]);
    // Ficha arquivada por `staff:<id>`; o fantasma só fica arquivado se todas as conversas avulsas estiverem.
    expect(flags(config(['b'], ['staff:ana', 's9']))).toEqual([
      ['h:a:ana', true],
      ['h:a:bia', false],
      ['g:a', false],
      ['h:b:caio', true],
    ]);
    expect(flags(config(['b'], ['staff:ana', 's8', 's9']))).toEqual([
      ['h:a:ana', true],
      ['h:a:bia', false],
      ['g:a', true],
      ['h:b:caio', true],
    ]);
    // Projeto arquivado: a equipe dele e o fantasma saem arquivados junto.
    expect(flags(config(['a']))).toEqual([
      ['h:a:ana', true],
      ['h:a:bia', true],
      ['g:a', true],
      ['h:b:caio', false],
    ]);
  });
});

describe('rankingRows', () => {
  it('soma as sessões do funcionário; conversa sem ficha soma no fantasma', () => {
    const b = board({
      projects: [project('a', 'Alfa')],
      staff: [staff('ana', 'a', ['s1', 's2'])],
      sessions: { a: [session('s1'), session('s2'), session('s3')] },
    });
    const rows = rankingRows(
      rankingGroups(b, null),
      report([saving('s1', 10, 15, { runs: 2, executorUsd: 4, discardedUsd: 1 }), saving('s2', 5, 5, { runs: 1, executorUsd: 1 }), saving('s3', 3, 3)]),
    );
    expect(row(rows, 'h:a:ana')).toMatchObject({ usd: 15, executorUsd: 5, discardedUsd: 1, runs: 3 });
    expect(row(rows, 'g:a')).toMatchObject({ usd: 3, executorUsd: 0, runs: 0 });
  });

  it('quem não gastou no período não aparece (mas continua nos grupos)', () => {
    const b = board({ projects: [project('a', 'Alfa')], staff: [staff('ana', 'a', ['s1']), staff('bia', 'a', ['s2'])] });
    const groups = rankingGroups(b, null);
    expect(groups.map((g) => g.nodeId)).toEqual(['h:a:ana', 'h:a:bia']);
    expect(rankingRows(groups, report([saving('s1', 2, 2, { runs: 1 })])).map((r) => r.nodeId)).toEqual(['h:a:ana']);
  });

  it('arquivados que gastaram aparecem no ranking, marcados', () => {
    const b = board({
      projects: [project('a', 'Alfa'), project('b', 'Beta')],
      staff: [staff('ana', 'a', ['s1']), staff('caio', 'b', ['s3'])],
    });
    const rows = rankingRows(
      rankingGroups(b, config(['b'], ['staff:ana'])),
      report([saving('s1', 5, 5, { runs: 1 }), saving('s3', 2, 2)]),
    );
    expect(rows.map((r) => [r.nodeId, r.archived])).toEqual([
      ['h:a:ana', true],
      ['h:b:caio', true],
    ]);
  });
});

describe('economia', () => {
  it('economia = soma de (asPlannerUsd − usd) só das sessões com preço; % = economia / o que custaria com o chefe', () => {
    const b = board({ projects: [project('a', 'Alfa')], staff: [staff('ana', 'a', ['s1', 's2', 's3'])] });
    const ana = row(
      rankingRows(
        rankingGroups(b, null),
        report([
          saving('s1', 10, 15, { runs: 1 }), // +5
          saving('s2', 4, null, { runs: 1 }), // sem preço: o gasto conta, a economia não
          saving('s3', 2, 6, { runs: 1 }), // +4
        ]),
      ),
      'h:a:ana',
    );
    expect(ana.usd).toBe(16);
    expect(ana.savedUsd).toBeCloseTo(9, 10);
    expect(ana.baseUsd).toBeCloseTo(21, 10);
    expect(ana.savedPct).toBeCloseTo(9 / 21, 10);
  });

  it('economia negativa (ficou mais caro) sai negativa', () => {
    const b = board({ projects: [project('a', 'Alfa')], staff: [staff('caio', 'a', ['s1'])] });
    const caio = row(rankingRows(rankingGroups(b, null), report([saving('s1', 8, 5, { runs: 1 })])), 'h:a:caio');
    expect(caio.savedUsd).toBeCloseTo(-3, 10);
    expect(caio.savedPct).toBeCloseTo(-0.6, 10);
  });

  it('sem nenhuma sessão com preço: economia 0 e % null', () => {
    const b = board({ projects: [project('a', 'Alfa')], staff: [staff('ana', 'a', ['s1'])] });
    const ana = row(rankingRows(rankingGroups(b, null), report([saving('s1', 4, null, { runs: 1 })])), 'h:a:ana');
    expect(ana).toMatchObject({ usd: 4, savedUsd: 0, baseUsd: 0, savedPct: null });
  });
});

describe('savingsList', () => {
  it('só quem usou subagents (runs > 0), do que mais economizou ao que mais gastou a mais', () => {
    // Ordem por gasto é dan, ana, caio, bia; por economia, caio, ana, dan. bia sai (runs 0).
    expect(savingsList(equipe()).map((r) => r.nodeId)).toEqual(['h:a:caio', 'h:a:ana', 'h:a:dan']);
  });
});

describe('teamSavings', () => {
  it('total da equipe: soma a economia; a % é sobre tudo que custaria com o chefe, inclusive quem não usou subagents', () => {
    const team = teamSavings(equipe());
    // Economia: 1 + 4 − 2 + 0 = 3. Base: 11 + 12 + 18 + 6 = 47 (bia entra na base).
    expect(team?.savedUsd).toBeCloseTo(3, 10);
    expect(team?.savedPct).toBeCloseTo(3 / 47, 10);
  });

  it('sem nenhum preço na equipe: null', () => {
    const b = board({ projects: [project('a', 'Alfa')], staff: [staff('ana', 'a', ['s1'])] });
    expect(teamSavings(rankingRows(rankingGroups(b, null), report([saving('s1', 4, null, { runs: 1 })])))).toBeNull();
    expect(teamSavings([])).toBeNull();
  });
});
