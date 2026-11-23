import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_TONE, INBOX_TONE, toneClass } from '../client/src/inbox/alertTone';

describe('mapa de tons de alerta', () => {
  it('cobre todos os tipos da caixa', () => {
    expect(Object.keys(INBOX_TONE).sort()).toEqual(
      ['blocked', 'denied', 'error', 'followUp', 'notStarted', 'orphan', 'permission', 'plan', 'question', 'routine', 'secret', 'stuck', 'usage', 'waiting'],
    );
  });
  it('erro é vermelho, espera por você é amarelo, resolvido é verde', () => {
    expect(INBOX_TONE.error).toBe('error');
    expect(INBOX_TONE.question).toBe('action');
    expect(CARD_TONE.owner).toBe(INBOX_TONE.question);
    expect(CARD_TONE.rejected).toBe(INBOX_TONE.error);
    expect(toneClass(CARD_TONE.resolved)).toBe('tone-done');
  });
});


describe('selos do quadro leem o mapa de tons', () => {
  it.each(['tasks/TasksBoard.tsx', 'tasks/TaskCommit.tsx', 'tasks/ReviewWho.tsx', 'tasks/TaskNoCode.tsx', 'tasks/TaskFollowUps.tsx', 'tasks/TaskDoubt.tsx', 'tasks/waitTone.ts'])('%s usa cardTone', (f) => {
    const src = readFileSync(`client/src/${f}`, 'utf8');
    expect(src).toMatch(/cardTone\(/);
    // O contorno do cartão (task-card is-waiting) não é selo e fica fora.
    if (!f.endsWith('TasksBoard.tsx')) expect(src).not.toMatch(/['"` ]is-(waiting|approved|rejected)['"` ]/);
  });
});