import { describe, expect, it } from 'vitest';
import type { RetentionPreview } from '../shared/model';
import { normalizeRetentionDays, previewFor, previewTotal, retentionOrderBroken, skippedProjects } from '../client/src/toolbar/retention';

const preview = (over: Partial<RetentionPreview> = {}): RetentionPreview => ({
  deleteAfterDays: 30,
  enabledAt: null,
  claude: { count: 3, bytes: 3000 },
  codex: { count: 2, bytes: 500 },
  oldest: '2026-09-01T00:00:00.000Z',
  skipped: [],
  ...over,
});

describe('normalizeRetentionDays', () => {
  it('inteiro de 0 (desligado) a 365', () => {
    expect(normalizeRetentionDays('0')).toBe(0);
    expect(normalizeRetentionDays('7')).toBe(7);
    expect(normalizeRetentionDays('7.6')).toBe(8);
    expect(normalizeRetentionDays('-3')).toBe(0);
    expect(normalizeRetentionDays('365')).toBe(365);
    expect(normalizeRetentionDays('9999')).toBe(365);
  });
  it('vazio ou lixo devolve null (o campo volta ao valor salvo)', () => {
    expect(normalizeRetentionDays('')).toBeNull();
    expect(normalizeRetentionDays('  ')).toBeNull();
    expect(normalizeRetentionDays('uma semana')).toBeNull();
  });
});

describe('retentionOrderBroken', () => {
  it('só quebra com os dois ligados e apagar <= arquivar', () => {
    expect(retentionOrderBroken(7, 30)).toBe(false);
    expect(retentionOrderBroken(30, 30)).toBe(true);
    expect(retentionOrderBroken(30, 7)).toBe(true);
  });
  it('0 desliga o lado e não entra na conta', () => {
    expect(retentionOrderBroken(0, 7)).toBe(false);
    expect(retentionOrderBroken(30, 0)).toBe(false);
    expect(retentionOrderBroken(0, 0)).toBe(false);
  });
});

describe('previewFor', () => {
  it('vale só para o prazo com que foi feita', () => {
    const p = preview();
    expect(previewFor(p, 30)).toBe(p);
    expect(previewFor(p, 20)).toBeNull();
  });
  it('sem prévia, ou com a exclusão sem dias, não vale', () => {
    expect(previewFor(null, 30)).toBeNull();
    expect(previewFor(preview({ deleteAfterDays: 0 }), 0)).toBeNull();
  });
});

describe('previewTotal', () => {
  it('soma Claude e Codex', () => {
    expect(previewTotal(preview())).toEqual({ count: 5, bytes: 3500 });
  });
});

describe('skippedProjects', () => {
  it('lista os projetos pulados', () => {
    expect(skippedProjects(preview({ skipped: ['A', 'B'] }))).toEqual(['A', 'B']);
  });
  it('servidor sem o campo, ou com lixo, não derruba a tela', () => {
    expect(skippedProjects({})).toEqual([]);
    expect(skippedProjects({ skipped: [] })).toEqual([]);
    expect(skippedProjects({ skipped: ['A', '', 3 as unknown as string] })).toEqual(['A']);
  });
});
