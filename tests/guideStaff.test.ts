import { describe, expect, it } from 'vitest';
import { defaultGuideStaff } from '../client/src/detail/guideActions';

const s = (id: string, reportsTo: string[] = []) => ({ id, reportsTo });

describe('guia do projeto: quem faz por padrão', () => {
  it('sem equipe, ninguém', () => {
    expect(defaultGuideStaff([])).toBeNull();
  });

  it('o do topo do organograma (sem chefe), mesmo que não seja o primeiro da lista', () => {
    expect(defaultGuideStaff([s('dev', ['chefe']), s('chefe')])).toBe('chefe');
  });

  it('vários no topo: o primeiro', () => {
    expect(defaultGuideStaff([s('a'), s('b')])).toBe('a');
  });

  it('chefe que não está na equipe (arquivado, de outro projeto) não conta', () => {
    expect(defaultGuideStaff([s('a', ['fora']), s('b', ['a'])])).toBe('a');
  });

  it('só ciclo (todos se reportam): o primeiro', () => {
    expect(defaultGuideStaff([s('a', ['b']), s('b', ['a'])])).toBe('a');
  });
});
