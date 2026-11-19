import { describe, expect, it } from 'vitest';
import { BLOCKERS_FORMAT, BLOCKERS_MAX, FORWARD_MAX, citedIds, doubtIsAboutRejection, fitReviewText, nextBlockerId, parseBlockers, priorBlockers } from '../server/reviewBlockers';
import type { Rejection } from '../shared/model';

// O bloco de bloqueadores da reprovação (t-33b84c): a leitura (ok, ausente, malformado, ids entre rodadas), o corte que nunca perde 🔴 e a dúvida que vai ao revisor.

const block = (...lines: string[]) => ['[BLOQUEADORES]', ...lines, '[/BLOQUEADORES]'].join('\n');
const L1 = 'R1 | server/a.ts:10 | quebra com lista vazia | rodar tests/a.test.ts e ficar verde';
const L2 = 'R2 | server/b.ts:7 | sem teste | existir tests/b.test.ts verde';

describe('parseBlockers', () => {
  it('bloco válido: um item por linha, e o resto do texto sem o bloco', () => {
    const p = parseBlockers(`REPROVADO\n\n🔴 server/a.ts:10 quebra\n\n${block(L1, L2)}\n\n🟢 nome`);
    expect(p.status).toBe('ok');
    expect(p.blockers).toEqual([
      { id: 'R1', where: 'server/a.ts:10', problem: 'quebra com lista vazia', proof: 'rodar tests/a.test.ts e ficar verde' },
      { id: 'R2', where: 'server/b.ts:7', problem: 'sem teste', proof: 'existir tests/b.test.ts verde' },
    ]);
    expect(p.warnings).toEqual([]);
    expect(p.rest).toBe('REPROVADO\n\n🔴 server/a.ts:10 quebra\n\n🟢 nome');
    expect(p.rest).not.toContain('BLOQUEADORES');
  });

  it('tolera markdown em volta, cerca de código, marcador de lista, tabela e CRLF', () => {
    const text = ['REPROVADO', '**[BLOQUEADORES]**', '```text', `- 🔴 ${L1}`, `| R2 | server/b.ts:7 | sem teste | existir tests/b.test.ts verde |`, '```', '> [/BLOQUEADORES]'].join('\r\n');
    const p = parseBlockers(text);
    expect(p.status).toBe('ok');
    expect(p.blockers.map((b) => b.id)).toEqual(['R1', 'R2']);
    expect(p.blockers[1]).toMatchObject({ where: 'server/b.ts:7', proof: 'existir tests/b.test.ts verde' });
  });

  it('o " | " a mais dentro do texto vai para o último campo; o id é lido sem caixa nem negrito', () => {
    const p = parseBlockers(block('**r3** | a.ts:1 | usa a ou b | prova com | e com | mais'));
    expect(p.status).toBe('ok');
    expect(p.blockers[0]).toMatchObject({ id: 'R3', where: 'a.ts:1', problem: 'usa a ou b', proof: 'prova com | e com | mais' });
  });

  it('sem nenhuma marca: ausente, e o texto segue inteiro', () => {
    const text = 'REPROVADO\n🔴 a.ts:1 quebrou';
    expect(parseBlockers(text)).toEqual({ status: 'absent', blockers: [], warnings: [], rest: text });
  });

  it.each([
    ['abertura sem fechamento', `REPROVADO\n[BLOQUEADORES]\n${L1}`, /sem abertura ou sem fechamento/],
    ['fechamento sem abertura', `REPROVADO\n${L1}\n[/BLOQUEADORES]`, /sem abertura ou sem fechamento/],
    ['fechamento antes da abertura', `[/BLOQUEADORES]\n${L1}\n[BLOQUEADORES]`, /antes da abertura/],
    ['dois blocos', `${block(L1)}\n\n${block(L2)}`, /mais de um bloco/],
    ['bloco vazio', block('', '```', '```'), /vazio/],
    ['linha sem os 4 campos', block('R1 | a.ts:1 | só o problema'), /faltam campos/],
    ['campo vazio', block('R1 | a.ts:1 |  | prova'), /campo vazio/],
    ['id que não é Rn', block('X1 | a.ts:1 | p | prova'), /não é R1, R2/],
    ['id com zero à esquerda', block('R01 | a.ts:1 | p | prova'), /não é R1, R2/],
    ['id zero', block('R0 | a.ts:1 | p | prova'), /não é R1, R2/],
    ['id repetido', block(L1, 'R1 | b.ts:2 | outro | outra prova'), /R1 aparece duas vezes/],
    ['bloqueadores demais', block(...Array.from({ length: BLOCKERS_MAX + 1 }, (_, i) => `R${i + 1} | a.ts:${i} | p | prova`)), /demais/],
  ])('malformado: %s (o texto segue cru, com o motivo)', (_name, text, why) => {
    const p = parseBlockers(text);
    expect(p.status).toBe('malformed');
    expect(p.blockers).toEqual([]);
    expect(p.warnings[0]).toMatch(why);
    expect(p.rest).toBe(text);
  });

  it('ids entre rodadas: o aberto se repete, o novo passa do maior já usado; o reaproveitado vira aviso e o bloco continua válido', () => {
    const rej = (blockers: string[]): Rejection => ({
      round: 1,
      at: '2026-11-19T10:00:00.000Z',
      deliveryAt: null,
      reviewer: { staffId: 'rev-1', name: 'Rui', sessionId: 's' },
      block: 'ok',
      blockers: blockers.map((id) => ({ id, where: 'a.ts:1', problem: 'p', proof: 'q' })),
    });
    // Rodada 1 teve R1 e R2; a 2ª manteve só o R2 aberto.
    const prior = priorBlockers([rej(['R1', 'R2']), rej(['R2'])]);
    expect(prior).toEqual({ open: ['R2'], maxId: 2 });
    expect(nextBlockerId(prior)).toBe('R3');

    const carried = parseBlockers(block('R2 | a.ts:1 | segue | prova', 'R3 | b.ts:2 | novo | prova'), prior);
    expect(carried).toMatchObject({ status: 'ok', warnings: [] });
    expect(carried.blockers.map((b) => b.id)).toEqual(['R2', 'R3']);

    const reused = parseBlockers(block('R1 | c.ts:3 | outro problema com o número velho | prova'), prior);
    expect(reused.status).toBe('ok');
    expect(reused.blockers.map((b) => b.id)).toEqual(['R1']);
    expect(reused.warnings).toHaveLength(1);
    expect(reused.warnings[0]).toMatch(/R1 já foi usado numa rodada anterior e não estava aberto/);
  });

  it('priorBlockers sem reprovação anterior: nada aberto, nada usado', () => {
    expect(priorBlockers(undefined)).toEqual({ open: [], maxId: 0 });
    expect(nextBlockerId(priorBlockers([]))).toBe('R1');
  });

  it('o exemplo do formato que o pedido de revisão dá ao revisor é, ele mesmo, um bloco válido', () => {
    const p = parseBlockers(BLOCKERS_FORMAT);
    expect(p.status).toBe('ok');
    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0]!.id).toBe('R1');
  });
});

describe('fitReviewText', () => {
  it('cabendo, sai como está (parágrafos separados por uma linha em branco)', () => {
    expect(fitReviewText('REPROVADO\n\n🔴 a.ts:1 quebrou\n\n\n🟢 nome')).toEqual({ text: 'REPROVADO\n\n🔴 a.ts:1 quebrou\n\n🟢 nome', cut: 0 });
  });

  it('um 🔴 depois do caractere 4000 NÃO some: o que sai é só o trecho sem 🔴, com marcador e a conta', () => {
    const filler = `🟢 ${'x'.repeat(FORWARD_MAX + 500)}`;
    const text = `REPROVADO\n\n${filler}\n\n🔴 z.ts:9 vaza segredo no log\n\n🟡 y.ts:2 nome ruim`;
    const fit = fitReviewText(text);
    expect(text.indexOf('🔴 z.ts:9')).toBeGreaterThan(FORWARD_MAX); // o 🔴 está além do corte antigo (slice(0, 4000))
    expect(fit.text).toContain('🔴 z.ts:9 vaza segredo no log');
    expect(fit.text).toContain('REPROVADO');
    expect(fit.text).toContain('🟡 y.ts:2 nome ruim'); // o que cabe segue na ordem
    expect(fit.text).not.toContain('xxxxxxxxxx');
    expect(fit.text).toContain('[… trecho sem 🔴 cortado …]');
    expect(fit.cut).toBe(filler.length);
  });

  it('todo parágrafo com 🔴 fica inteiro, mesmo que passe sozinho do limite: o limite vale só para o resto', () => {
    const red = `🔴 a.ts:1 ${'y'.repeat(FORWARD_MAX + 100)}`;
    const fit = fitReviewText(`REPROVADO\n\n${red}\n\n🟢 detalhe`);
    expect(fit.text).toContain(red);
    expect(fit.text.length).toBeGreaterThan(FORWARD_MAX);
    expect(fit.cut).toBe('REPROVADO'.length + '🟢 detalhe'.length); // sem sobra de orçamento, só o que não é 🔴 sai
  });

  it('vários trechos cortados em seguida viram um marcador só', () => {
    const big = (c: string) => `🟢 ${c.repeat(FORWARD_MAX)}`;
    const fit = fitReviewText(`🔴 a.ts:1 x\n\n${big('a')}\n\n${big('b')}\n\n🔴 b.ts:2 y`);
    expect(fit.text.match(/trecho sem 🔴 cortado/g)).toHaveLength(1);
    expect(fit.text).toContain('🔴 a.ts:1 x');
    expect(fit.text).toContain('🔴 b.ts:2 y');
  });
});

describe('citedIds', () => {
  it('lê os Rn do texto inteiro, em maiúsculas e sem repetir; não confunde com outras palavras', () => {
    expect(citedIds('R1: feito. r2: não feito. R1 de novo. R10 e R100, mas R0, R1000, AR2 e REQ3 não contam')).toEqual(['R1', 'R2', 'R10', 'R100']);
    expect(citedIds('sem ids')).toEqual([]);
  });
});

describe('doubtIsAboutRejection', () => {
  const rej = (block: Rejection['block'], ids: string[] = []): Rejection => ({
    round: 1,
    at: '2026-11-19T10:00:00.000Z',
    deliveryAt: null,
    reviewer: { staffId: 'rev-1', name: 'Rui', sessionId: 's' },
    block,
    blockers: ids.map((id) => ({ id, where: 'a.ts:1', problem: 'p', proof: 'q' })),
  });

  it('com bloco: só se a dúvida ABRE com o id de um item aberto (um ou vários)', () => {
    const r = rej('ok', ['R1', 'R2']);
    expect(doubtIsAboutRejection('DÚVIDA: R2 — o pedido manda não mexer em b.ts', r)).toBe(true);
    expect(doubtIsAboutRejection('**DÚVIDA:** R1, R2 — qual vale?', r)).toBe(true);
    expect(doubtIsAboutRejection('DUVIDA: r1 e R2: contradizem', r)).toBe(true);
    expect(doubtIsAboutRejection('DÚVIDA: posso apagar a tabela? (o R2 não fala disso)', r)).toBe(false); // citar no meio não vale
    expect(doubtIsAboutRejection('DÚVIDA: R9 — id que não existe', r)).toBe(false);
    expect(doubtIsAboutRejection('DÚVIDA: 🔴 a.ts:1 — sem id', r)).toBe(false);
  });

  it('sem bloco válido (não há ids): vale a dúvida que abre com o 🔴', () => {
    for (const block of ['absent', 'malformed'] as const) {
      expect(doubtIsAboutRejection('DÚVIDA: 🔴 a.ts:1 — o que ele quer?', rej(block))).toBe(true);
      expect(doubtIsAboutRejection('DÚVIDA: posso apagar a tabela?', rej(block))).toBe(false);
      expect(doubtIsAboutRejection('DÚVIDA: R1 — sem id para casar', rej(block))).toBe(false);
    }
  });
});
