import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AUTO_REVIEW_ROUNDS, CHANGED_FILES_MAX, type BoardConfig, type StaffProfile } from '../shared/model';
import { AutoBadge, AutoInfo } from '../client/src/tasks/AutoCard';
import { BoardReview, reviewerToTurnOn, type BoardReviewState } from '../client/src/tasks/BoardReview';
import { fellToOwner, reviewPlan } from '../client/src/tasks/reviewRule';
import { OwnerBadge, ReviewWho } from '../client/src/tasks/ReviewWho';
import messages from '../client/src/i18n/tasks';

const staff = (id: string, name = id) => ({ id, name, role: 'Dev' }) as StaffProfile;
const people = [staff('ana', 'Ana'), staff('bia', 'Bia'), staff('caio', 'Caio')];
const off: BoardConfig = { autoReview: false, reviewerId: null };
const on = (reviewerId: string): BoardConfig => ({ autoReview: true, reviewerId });

describe('reviewPlan', () => {
  const base = { staffId: 'bia', reviewerId: null, reviewRounds: 0, review: null };

  it('sem revisão automática (quadro desligado, nada na tarefa) ninguém revisa sozinho: é o dono, sem aviso', () => {
    const plan = reviewPlan(base, off);
    expect(plan).toEqual({ kind: 'owner', why: 'off' });
    expect(fellToOwner(plan)).toBe(false);
    expect(reviewPlan(base, null)).toEqual({ kind: 'owner', why: 'off' });
  });

  it('o responsável do quadro revisa o que outro funcionário fez', () => {
    expect(reviewPlan(base, on('ana'))).toEqual({ kind: 'staff', id: 'ana', from: 'board' });
  });

  it('o responsável do quadro fez a tarefa: fica com o dono', () => {
    const plan = reviewPlan({ ...base, staffId: 'ana' }, on('ana'));
    expect(plan).toEqual({ kind: 'owner', why: 'self' });
    expect(fellToOwner(plan)).toBe(true);
  });

  it('o revisor apontado na tarefa tem prioridade, com o quadro ligado ou não', () => {
    expect(reviewPlan({ ...base, reviewerId: 'caio' }, on('ana'))).toEqual({ kind: 'staff', id: 'caio', from: 'task' });
    expect(reviewPlan({ ...base, reviewerId: 'caio' }, off)).toEqual({ kind: 'staff', id: 'caio', from: 'task' });
    // Mesmo quando o responsável do quadro fez a tarefa, o apontado revisa.
    expect(reviewPlan({ ...base, staffId: 'ana', reviewerId: 'caio' }, on('ana'))).toEqual({ kind: 'staff', id: 'caio', from: 'task' });
  });

  it('pedido de revisão em andamento: quem foi pedido está revisando', () => {
    const review = { staffId: 'caio', sessionId: 's', at: '2026-11-16T10:00:00Z' };
    expect(reviewPlan({ ...base, staffId: 'ana', review }, on('ana'))).toEqual({ kind: 'staff', id: 'caio', from: 'asked' });
  });

  it('rodadas acabaram, última reprovada ou sem veredito: o que sobrou é do dono', () => {
    const answered = { staffId: 'ana', sessionId: 's', at: '2026-11-16T10:00:00Z', doneAt: '2026-11-16T10:05:00Z', verdict: 'rejected' as const };
    const plan = reviewPlan({ ...base, reviewRounds: AUTO_REVIEW_ROUNDS, review: answered }, on('ana'));
    expect(plan).toEqual({ kind: 'owner', why: 'cap' });
    expect(fellToOwner(plan)).toBe(true);
    // Aprovada pelo revisor (só falta mesclar) não é "limite": o dono não está decidindo a revisão.
    expect(reviewPlan({ ...base, reviewRounds: AUTO_REVIEW_ROUNDS, review: { ...answered, verdict: 'approved' } }, on('ana')).kind).toBe('staff');
    // Ainda com rodadas sobrando: o revisor volta.
    expect(reviewPlan({ ...base, reviewRounds: AUTO_REVIEW_ROUNDS - 1, review: answered }, on('ana')).kind).toBe('staff');
  });
});

describe('reviewerToTurnOn', () => {
  it('mantém o responsável gravado se ele ainda é do projeto; senão, o primeiro da lista', () => {
    expect(reviewerToTurnOn({ autoReview: false, reviewerId: 'bia' }, people)).toBe('bia');
    expect(reviewerToTurnOn({ autoReview: false, reviewerId: 'saiu' }, people)).toBe('ana');
    expect(reviewerToTurnOn(off, people)).toBe('ana');
    expect(reviewerToTurnOn(off, [])).toBeNull();
  });
});

describe('BoardReview', () => {
  const state = (config: BoardConfig | null, extra: Partial<BoardReviewState> = {}): BoardReviewState => ({
    config,
    missing: false,
    error: null,
    saving: false,
    save: async () => {},
    ...extra,
  });
  const render = (review: BoardReviewState, list = people) => renderToStaticMarkup(createElement(BoardReview, { review, staff: list }));

  it('servidor sem a rota, ou ainda lendo: o bloco não aparece', () => {
    expect(render(state(null, { missing: true }))).toBe('');
    expect(render(state(null))).toBe('');
  });

  it('desligada: título diz desligada, botão não pressionado e sem seletor; a regra está escrita', () => {
    const html = render(state(off));
    expect(html).toContain('Revisão automática do quadro: desligada');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Desligada');
    expect(html).not.toContain('<select');
    expect(html).toContain('O responsável revisa o que outro funcionário fez');
    expect(html).toContain('O que ele mesmo fez vai para você aprovar ou reprovar');
  });

  it('ligada: título com o nome, botão pressionado e seletor com todos os funcionários e o responsável marcado', () => {
    const html = render(state(on('bia')));
    expect(html).toContain('Revisão automática do quadro: Bia revisa');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('<select');
    for (const p of people) expect(html).toContain(`value="${p.id}"`);
    expect(html).toMatch(/<option value="bia" selected="">/);
  });

  it('responsável que saiu do projeto aparece como está; sem funcionário, não dá para ligar', () => {
    expect(render(state(on('saiu')))).toMatch(/<option value="saiu"[^>]*>saiu<\/option>/);
    const none = render(state(off), []);
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Desligada<\/button>/);
    expect(none).toContain('Precisa de pelo menos um funcionário no projeto');
  });

  it('gravando, o controle fica desligado; erro do servidor aparece como veio', () => {
    expect(render(state(on('ana'), { saving: true }))).toMatch(/<select[^>]*disabled=""/);
    expect(render(state(off, { error: 'revisor não encontrado neste projeto' }))).toContain('revisor não encontrado neste projeto');
  });
});

describe('card registrado automaticamente', () => {
  it('selo só no card automático', () => {
    expect(renderToStaticMarkup(createElement(AutoBadge, { task: {} }))).toBe('');
    expect(renderToStaticMarkup(createElement(AutoBadge, { task: { autoCreated: true } }))).toContain('Registrado automaticamente');
  });

  it('detalhe lista os arquivos alterados; sem nenhum, avisa; no teto, diz que a lista parou', () => {
    const render = (changedFiles?: string[]) => renderToStaticMarkup(createElement(AutoInfo, { task: { autoCreated: true, changedFiles }, open: true }));
    expect(renderToStaticMarkup(createElement(AutoInfo, { task: {}, open: true }))).toBe('');
    const some = render(['client/src/App.tsx', 'server/tasks.ts']);
    expect(some).toContain('Arquivos alterados nesta conversa (2)');
    expect(some).toContain('client/src/App.tsx');
    expect(some).toContain('edições feitas pelas ferramentas de edição');
    expect(some).not.toContain('A lista para em');
    expect(render()).toContain('Nenhum arquivo registrado ainda.');
    const full = Array.from({ length: CHANGED_FILES_MAX }, (_, i) => `src/f${i}.ts`);
    expect(render(full)).toContain(`A lista para em ${CHANGED_FILES_MAX} arquivos`);
  });

  it('o caminho vai como texto, nunca como HTML', () => {
    const html = renderToStaticMarkup(createElement(AutoInfo, { task: { autoCreated: true, changedFiles: ['<img src=x onerror=alert(1)>.ts'] }, open: true }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('dono revisa', () => {
  const props = { workerName: 'Ana', reviewerName: (id: string) => id.toUpperCase(), asked: false };

  it('selo e caixa só quando a regra mandou para o dono', () => {
    const self = reviewPlan({ staffId: 'ana', reviewerId: null, reviewRounds: 0, review: null }, on('ana'));
    expect(renderToStaticMarkup(createElement(OwnerBadge, { plan: self }))).toContain('Você aprova ou reprova');
    const box = renderToStaticMarkup(createElement(ReviewWho, { plan: self, ...props }));
    expect(box).toContain('task-owner-box');
    expect(box).toContain('Ana é o responsável pela revisão e fez esta tarefa');
    expect(box).toContain('mande o ajuste na conversa da tarefa');

    const off = reviewPlan({ staffId: 'ana', reviewerId: null, reviewRounds: 0, review: null }, null);
    expect(renderToStaticMarkup(createElement(OwnerBadge, { plan: off }))).toBe('');
    expect(renderToStaticMarkup(createElement(ReviewWho, { plan: off, ...props }))).toBe('');
  });

  it('limite de rodadas diz quantas foram', () => {
    const html = renderToStaticMarkup(createElement(ReviewWho, { plan: { kind: 'owner', why: 'cap' }, ...props }));
    expect(html).toContain(`As ${AUTO_REVIEW_ROUNDS} revisões automáticas já foram usadas`);
  });

  it('com funcionário ainda por revisar, uma linha diz quem e por quê; com o pedido feito, nada (o pedido já mostra)', () => {
    const plan = { kind: 'staff', id: 'bia', from: 'board' } as const;
    expect(renderToStaticMarkup(createElement(ReviewWho, { plan, ...props }))).toContain('BIA revisa esta entrega (responsável do quadro)');
    expect(renderToStaticMarkup(createElement(ReviewWho, { plan: { ...plan, from: 'task' }, ...props }))).toContain('(apontado na tarefa)');
    expect(renderToStaticMarkup(createElement(ReviewWho, { plan, ...props, asked: true }))).toBe('');
  });
});

describe('i18n', () => {
  it('as chaves novas existem nos três idiomas', () => {
    const keys = Object.keys(messages['pt-BR']).filter((k) => /^tasks\.(boardReview|auto|changedFiles|ownerReview|reviewWho)/.test(k));
    expect(keys.length).toBeGreaterThan(15);
    for (const lang of ['en', 'es'] as const) for (const k of keys) expect((messages[lang] as Record<string, string>)[k], `${lang}:${k}`).toBeTruthy();
  });
});
