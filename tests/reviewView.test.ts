import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CostReview, CostReviewFinding } from '../shared/model';
import { FINDING_TITLES, findingTitle, fixable, fixChange, formatTokens, groupFindings, REVIEW_MAX_DAYS, reviewDays, skipReason, summarizeApply, touchesFicha } from '../client/src/costReview';
import { ApplyResult, ReviewBody } from '../client/src/detail/StaffReview';
import { t } from '../client/src/i18n';

const finding = (id: string, severity: CostReviewFinding['severity']): CostReviewFinding => ({ id, severity, evidence: `e-${id}`, suggestion: `s-${id}` });

describe('reviewDays', () => {
  it('segue o filtro do ranking; "tudo" vira o máximo do servidor', () => {
    expect([1, 7, 30, 90].map(reviewDays)).toEqual([1, 7, 30, 90]);
    expect(reviewDays(null)).toBe(REVIEW_MAX_DAYS);
    expect(reviewDays(99999)).toBe(REVIEW_MAX_DAYS);
  });
});

describe('groupFindings', () => {
  it('agrupa por severidade (alta, média, baixa), mantém a ordem do servidor e omite grupo vazio', () => {
    const groups = groupFindings([finding('rework', 'low'), finding('long-context', 'high'), finding('no-model', 'low'), finding('big-memory', 'high')]);
    expect(groups.map((g) => [g.severity, g.items.map((f) => f.id)])).toEqual([
      ['high', ['long-context', 'big-memory']],
      ['low', ['rework', 'no-model']],
    ]);
  });

  it('sem achados: nenhum grupo', () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe('FINDING_TITLES', () => {
  it('todo id do servidor tem título traduzido (não cai na chave)', () => {
    const ids = ['long-context', 'ignored-context-warning', 'heavy-model-on-implementation', 'no-model', 'big-memory', 'big-tool-output', 'repeated-reads', 'inherited-model-agents', 'rework'];
    expect(Object.keys(FINDING_TITLES).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(t(FINDING_TITLES[id]!)).not.toMatch(/^detail\.finding\./);
  });
});

describe('formatTokens', () => {
  it('abrevia no idioma da tela (pt-BR nos testes); o espaço do Intl é inseparável, por isso o \\s', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(182_000).replace(/\s/g, ' ')).toBe('182 mil');
    expect(formatTokens(1_250_000)).toMatch(/^1,3\s+mi/);
  });
});

// Aplicar sugestões: o que muda, a confirmação e o resultado.

const ficha: CostReview['ficha'] = { model: 'opus', effort: 'xhigh', engine: 'claude' };
const heavy: CostReviewFinding = { ...finding('heavy-model-on-implementation', 'high'), fix: { kind: 'ficha', model: 'sonnet', effort: 'high' } };
const noModel: CostReviewFinding = { ...finding('no-model', 'low'), fix: { kind: 'ficha', model: 'sonnet' } };
const rule: CostReviewFinding = { ...finding('repeated-reads', 'low'), fix: { kind: 'rule', text: 'Não releia arquivo inteiro.' } };
const memory: CostReviewFinding = { ...finding('big-memory', 'medium'), fix: { kind: 'task', title: 'Compactar a memória', description: 'x' } };
const manual = finding('long-context', 'high');

describe('fixChange', () => {
  it('ficha: mostra só os campos que mudam, de → para', () => {
    expect(fixChange(heavy.fix!, ficha)).toBe('Modelo: Opus → Sonnet · Esforço: XHigh → High');
    expect(fixChange({ kind: 'ficha', effort: 'high' }, ficha)).toBe('Esforço: XHigh → High');
  });

  it('ficha sem modelo: de "padrão"', () => {
    expect(fixChange(noModel.fix!, { ...ficha, model: null })).toBe('Modelo: padrão → Sonnet');
  });

  it('regra e tarefa', () => {
    expect(fixChange(rule.fix!, ficha)).toBe('Nova regra: Não releia arquivo inteiro.');
    expect(fixChange(memory.fix!, ficha)).toBe('Cria a tarefa: Compactar a memória');
  });
});

describe('fixable e touchesFicha', () => {
  const all = [heavy, manual, rule, memory];

  it('só os achados com ajuste automático ganham caixa', () => {
    expect(fixable(all).map((f) => f.id)).toEqual(['heavy-model-on-implementation', 'repeated-reads', 'big-memory']);
  });

  it('o aviso das cópias vale só se algo escolhido mexe na ficha (modelo, esforço ou regra)', () => {
    expect(touchesFicha(all, new Set(['big-memory']))).toBe(false);
    expect(touchesFicha(all, new Set(['big-memory', 'repeated-reads']))).toBe(true);
    expect(touchesFicha(all, new Set(['heavy-model-on-implementation']))).toBe(true);
    expect(touchesFicha(all, new Set())).toBe(false);
  });
});

describe('skipReason', () => {
  it('traduz os motivos conhecidos do servidor e deixa passar o desconhecido', () => {
    expect(skipReason('já aplicado')).toBe('já aplicado');
    expect(skipReason('limite de regras da ficha')).toBe('limite de regras da ficha');
    expect(skipReason('motivo novo')).toBe('motivo novo');
    for (const r of ['não dispara mais', 'sem ajuste automático', 'já aplicado', 'limite de regras da ficha']) expect(skipReason(r)).not.toMatch(/^detail\.skip\./);
  });
});

describe('summarizeApply', () => {
  const result = {
    applied: [
      { id: 'heavy-model-on-implementation', kind: 'ficha' as const, before: { model: 'opus', effort: 'xhigh' as const }, after: { model: 'sonnet', effort: 'high' as const } },
      { id: 'repeated-reads', kind: 'rule' as const },
      { id: 'big-memory', kind: 'task' as const, taskId: 't-abc123' },
    ],
    skipped: [{ id: 'no-model', reason: 'já aplicado' }],
  };

  it('ficha pelo antes/depois do servidor; regra e tarefa pelo achado da análise; o id da tarefa vem junto', () => {
    expect(summarizeApply(result, [heavy, rule, memory, noModel])).toEqual({
      applied: [
        { id: 'heavy-model-on-implementation', change: 'Modelo: Opus → Sonnet · Esforço: XHigh → High' },
        { id: 'repeated-reads', change: 'Nova regra: Não releia arquivo inteiro.' },
        { id: 'big-memory', change: 'Tarefa criada: Compactar a memória', taskId: 't-abc123' },
      ],
      skipped: [{ id: 'no-model', reason: 'já aplicado' }],
    });
  });

  it('achado que sumiu da lista: o texto fica vazio, mas o item aparece', () => {
    expect(summarizeApply({ applied: [{ id: 'repeated-reads', kind: 'rule' }], skipped: [] }, []).applied).toEqual([{ id: 'repeated-reads', change: '' }]);
  });
});

describe('tela de aplicar', () => {
  const review: CostReview = {
    staffId: 's1',
    days: 90,
    totals: { sessions: 3, calls: 120, cacheRead: 5_000_000, cacheWrite: 1000, output: 20_000, maxContext: 300_000 },
    sessions: [],
    tasks: { total: 4, rework: 1, reopened: 0 },
    memory: { bytes: 20_000, lines: 90, detailBytes: 0 },
    ficha,
    findings: [heavy, manual, memory],
  };
  const render = (r: CostReview) => renderToStaticMarkup(createElement(ReviewBody, { review: r, name: 'Ana', onApply: async () => null }));

  it('caixa marcada só nos achados com ajuste, mostrando o que muda, e o botão conta as marcadas', () => {
    const out = render(review);
    expect(out.match(/type="checkbox"/g)).toHaveLength(2);
    expect(out.match(/checked=""/g)).toHaveLength(2);
    expect(out).toContain('Modelo: Opus → Sonnet');
    expect(out).toContain('Cria a tarefa: Compactar a memória');
    expect(out).toContain('Aplicar sugestões (2)');
    expect(out).not.toContain('disabled=""');
  });

  it('sem nenhum ajuste automático não há caixa nem botão', () => {
    const out = render({ ...review, findings: [manual] });
    expect(out).not.toContain('type="checkbox"');
    expect(out).not.toContain('Aplicar sugestões');
  });

  it('resultado: aplicados com a tarefa (link quando dá para abrir) e pulados com o motivo', () => {
    const summary = { applied: [{ id: 'big-memory', change: 'Tarefa criada: Compactar a memória', taskId: 't-abc123' }], skipped: [{ id: 'no-model', reason: 'já aplicado' }] };
    const plain = renderToStaticMarkup(createElement(ApplyResult, { summary }));
    expect(plain).toContain('Aplicado (1)');
    expect(plain).toContain('Não aplicado (1)');
    expect(plain).toContain(findingTitle('no-model'));
    expect(plain).toContain('t-abc123');
    expect(plain).not.toContain('<button');
    expect(renderToStaticMarkup(createElement(ApplyResult, { summary, onOpenTask: () => undefined }))).toContain('<button');
  });
});
