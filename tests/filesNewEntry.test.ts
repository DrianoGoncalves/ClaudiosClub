import { describe, expect, it } from 'vitest';
import { foldersToShow, joinPath, nameProblem, parentOf } from '../client/src/files/newEntry';

describe('nome de arquivo/pasta novo', () => {
  it('barra vazio, caminho absoluto e ..', () => {
    expect(nameProblem('')).toBe('empty');
    expect(nameProblem('   ')).toBe('empty');
    expect(nameProblem('/etc')).toBe('absolute');
    expect(nameProblem('\\x')).toBe('absolute');
    expect(nameProblem('..')).toBe('dots');
    expect(nameProblem('a/../b')).toBe('dots');
    expect(nameProblem('a\\..\\b')).toBe('dots');
    expect(nameProblem('a//b')).toBe('dots');
    expect(nameProblem('./a')).toBe('dots');
  });

  it('aceita nome simples, subpasta e barra no fim', () => {
    expect(nameProblem('novo.ts')).toBeNull();
    expect(nameProblem('..env')).toBeNull();
    expect(nameProblem('src/novo.ts')).toBeNull();
    expect(nameProblem('pasta/')).toBeNull();
  });

  it('monta o caminho relativo com /', () => {
    expect(joinPath('', ' novo.ts ')).toBe('novo.ts');
    expect(joinPath('src', 'a\\b.ts')).toBe('src/a/b.ts');
    expect(joinPath('src', 'pasta/')).toBe('src/pasta');
  });

  it('pastas a abrir na árvore depois de criar', () => {
    expect(foldersToShow('', 'novo.ts')).toEqual(['']);
    expect(foldersToShow('src', 'src/a/b/c.ts')).toEqual(['src', 'src/a', 'src/a/b']);
    expect(foldersToShow('', 'a/b')).toEqual(['', 'a']);
    expect(parentOf('src/a.ts')).toBe('src');
    expect(parentOf('a.ts')).toBe('');
  });
});
