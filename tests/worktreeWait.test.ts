import { describe, expect, it } from 'vitest';
import staff from '../client/src/i18n/staff';
import { worktreeWaitKey } from '../client/src/staff/worktreeWait';

// Ficha do funcionário: o texto sob "worktree própria" diz o efeito, de acordo com a opção do projeto "um escritor por vez".

describe('worktreeWaitKey', () => {
  it('com worktree, trabalha em paralelo, qualquer que seja a opção do projeto', () => {
    for (const sw of [true, false, null]) expect(worktreeWaitKey(true, sw)).toBe('staff.worktreeWaitOwn');
  });
  it('sem worktree e a opção do projeto ligada: espera a edição do outro', () => {
    expect(worktreeWaitKey(false, true)).toBe('staff.worktreeWaitQueue');
  });
  it('sem worktree e a opção desligada: edita junto, sem afirmar espera', () => {
    expect(worktreeWaitKey(false, false)).toBe('staff.worktreeWaitShared');
  });
  it('sem worktree e opção desconhecida (lendo, falhou, servidor velho): texto neutro', () => {
    expect(worktreeWaitKey(false, null)).toBe('staff.worktreeWaitDirect');
  });
});

describe('textos da espera por worktree', () => {
  const keys = ['staff.worktreeWaitOwn', 'staff.worktreeWaitQueue', 'staff.worktreeWaitShared', 'staff.worktreeWaitDirect'] as const;
  it('existem e são distintos em pt-BR, en e es', () => {
    for (const loc of ['pt-BR', 'en', 'es'] as const) {
      const texts = keys.map((k) => (staff[loc] as Record<string, string>)[k]);
      expect(texts.every((x) => typeof x === 'string' && x.length > 20)).toBe(true);
      expect(new Set(texts).size).toBe(keys.length);
    }
  });
});
