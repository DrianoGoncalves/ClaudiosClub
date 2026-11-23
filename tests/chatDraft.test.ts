import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearFreshDraft, draftKey, loadDraft, saveDraft } from '../client/src/chat/draftStore';

afterEach(() => vi.unstubAllGlobals());

function stubStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
  return data;
}

describe('rascunho da caixa do chat', () => {
  it('uma chave por projeto, funcionário e conversa; sem sessão é "novo"', () => {
    expect(draftKey('p', 's', 'abc')).not.toBe(draftKey('p', 's', 'def'));
    expect(draftKey('p', 's', 'abc')).not.toBe(draftKey('p', 'outro', 'abc'));
    expect(draftKey('p', 's', 'abc')).not.toBe(draftKey('q', 's', 'abc'));
    expect(draftKey('p', 's', null)).toContain(':novo');
    expect(draftKey('p', null, null)).not.toBe(draftKey('p', 's', null));
  });

  it('o texto guardado volta ao reabrir a mesma conversa e não aparece em outra', () => {
    stubStorage();
    const key = draftKey('p', 's', 'c1');
    saveDraft(key, 'meio da frase ');
    expect(loadDraft(key)).toBe('meio da frase ');
    expect(loadDraft(draftKey('p', 's', 'c2'))).toBe('');
  });

  it('"nova conversa" de novo abre a caixa vazia, sem o texto da nova abandonada', () => {
    stubStorage();
    saveDraft(draftKey('p', 's', null), 'texto da nova abandonada');
    expect(loadDraft(draftKey('p', 's', null))).toBe('texto da nova abandonada');
    clearFreshDraft('p', 's');
    expect(loadDraft(draftKey('p', 's', null))).toBe('');
    saveDraft(draftKey('p', 's', 'c1'), 'de outra conversa');
    clearFreshDraft('p', 's');
    expect(loadDraft(draftKey('p', 's', 'c1'))).toBe('de outra conversa');
  });

  it('removeItem que falha não faz o texto antigo voltar depois de apagar', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    const key = draftKey('p', 's', 'c7');
    saveDraft(key, 'antigo');
    saveDraft(key, '');
    expect(loadDraft(key)).toBe('');
  });

  it('caixa vazia ou só com espaços apaga o rascunho (enviou ou limpou)', () => {
    const data = stubStorage();
    const key = draftKey('p', 's', 'c1');
    saveDraft(key, 'oi');
    saveDraft(key, '   ');
    expect(loadDraft(key)).toBe('');
    expect(data.size).toBe(0);
  });

  it('com o sessionStorage bloqueado, segue na memória da página', () => {
    const boom = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('sessionStorage', { getItem: boom, setItem: boom, removeItem: boom });
    const key = draftKey('p', 's', 'c9');
    saveDraft(key, 'texto');
    expect(loadDraft(key)).toBe('texto');
    saveDraft(key, '');
    expect(loadDraft(key)).toBe('');
  });
});
