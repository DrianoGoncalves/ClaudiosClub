import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretNotice, SecretNoticeView } from '../client/src/chat/SecretNotice';
import { SecretVerdictRow } from '../client/src/chat/SecretVerdictRow';
import { secretHintOf, secretHintText, secretVerdictOf } from '../client/src/inbox/secretVerdict';
import type { InboxItem, SecretReason, SecretVerdict } from '../shared/model';

const item = (secret: Partial<NonNullable<InboxItem['secret']>> = {}): InboxItem => ({
  id: 'secret:s1:chave de API',
  kind: 'secret',
  projectId: 'p1',
  projectName: 'Projeto',
  sessionId: 's1',
  staffId: 'f1',
  name: 'Ana',
  summary: 'Chave de API apareceu no chat: troque e não cole segredos na conversa',
  at: '2026-11-16T10:00:00.000Z',
  secret: { kind: 'api-key', detail: 'anthropic', source: 'owner', ...secret },
});

const row = (secret: Partial<NonNullable<InboxItem['secret']>>) => renderToStaticMarkup(createElement(SecretVerdictRow, { item: item(secret) }));
const bubble = (secret: Partial<NonNullable<InboxItem['secret']>>) => renderToStaticMarkup(createElement(SecretNotice, { item: item(secret), onIgnore: async () => {} }));

/** Os `<button>` da árvore que a view devolve (a view não tem hooks, então roda sem navegador). */
function buttons(node: unknown, out: ReactElement<{ onClick?: () => void; children?: unknown; title?: string }>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<{ onClick?: () => void; children?: unknown; title?: string }>;
    if (el.type === 'button') out.push(el);
    buttons(el.props.children, out);
  }
  return out;
}

const STATES: Array<{ verdict: SecretVerdict; reason: SecretReason; label: string }> = [
  { verdict: 'example', reason: 'fake-token', label: 'provável exemplo/teste' },
  { verdict: 'local', reason: 'local-host', label: 'contexto local, autenticidade desconhecida' },
  { verdict: 'exposed', reason: 'provider-format', label: 'possível credencial exposta' },
  { verdict: 'unknown', reason: 'no-context', label: 'não foi possível determinar' },
];

describe('selo, dica e "por quê?" do alerta de segredo', () => {
  it.each(STATES)('$verdict: o balão traz o selo escrito, a dica e o motivo já calculado', ({ verdict, reason, label }) => {
    const html = bubble({ verdict, reason, hint: { prefix: 'sk-ant-', tail: 'a9F2', length: 108 } });
    expect(html).toContain(`secret-verdict is-${verdict}`);
    expect(html).toContain(label);
    expect(html).toContain('<code>sk-ant-…a9F2</code>, 108 car.');
    expect(html).toContain('>por quê?<');
    expect(html).toContain('<details class="secret-why">');
  });

  it('o "por quê?" começa fechado (sem `open`) e o motivo é texto puro, sem chamada nova', () => {
    const html = row({ verdict: 'exposed', reason: 'other-host' });
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain('provavelmente é de verdade');
  });

  it('todo código de motivo do servidor tem frase (nada de chave de tradução solta) e nenhuma manda ignorar', () => {
    const all: SecretReason[] = ['fake-token', 'placeholder', 'default-password', 'example-file', 'test-file', 'example-host', 'local-host', 'other-host', 'provider-format', 'private-key', 'strong-value', 'no-context'];
    for (const reason of all) {
      const v = secretVerdictOf(item({ verdict: 'unknown', reason }));
      expect(v?.why, reason).toBeTruthy();
      expect(v!.why, reason).not.toMatch(/^chat\./);
      expect(v!.why!.toLowerCase(), reason).not.toContain('ignor');
    }
  });

  it('código de motivo que a tela não conhece: o selo fica, o "por quê?" some', () => {
    const html = row({ verdict: 'exposed', reason: 'novo-codigo' as SecretReason });
    expect(html).toContain('possível credencial exposta');
    expect(html).not.toContain('por quê?');
    expect(secretVerdictOf(item({ verdict: 'exposed' }))?.why).toBeNull();
  });

  it('alerta antigo, sem os campos novos (ou com um estado que a tela não conhece), continua como antes: sem selo, dica nem "por quê?"', () => {
    const old = renderToStaticMarkup(createElement(SecretNotice, { item: item(), onIgnore: async () => {} }));
    expect(old).not.toContain('secret-verdict');
    expect(old).not.toContain('por quê?');
    expect(old).toContain('>Ignorar<');
    expect(secretVerdictOf(item())).toBeNull();
    expect(secretVerdictOf(item({ verdict: 'whatever' as SecretVerdict, reason: 'no-context' }))).toBeNull();
    expect(secretVerdictOf({ secret: undefined })).toBeNull();
    expect(row({ verdict: 'whatever' as SecretVerdict })).toBe('');
  });

  it('sem dica (chave privada) o selo aparece sozinho', () => {
    const html = row({ kind: 'private-key', verdict: 'exposed', reason: 'private-key' });
    expect(html).toContain('possível credencial exposta');
    expect(html).not.toContain('secret-hint');
  });
});

describe('a dica mascarada', () => {
  const text = (hint: Parameters<typeof secretHintOf>[0]) => {
    const h = secretHintOf(hint);
    return h && secretHintText(h);
  };

  it('token: prefixo público, "…", fim e tamanho', () => {
    expect(text({ prefix: 'sk-ant-', tail: 'a9F2', length: 108 })).toBe('sk-ant-…a9F2, 108 car.');
  });

  it('senha de 12+: só o fim (2) e o tamanho; senha curta: só o tamanho', () => {
    expect(text({ tail: 'ab', length: 14 })).toBe('…ab, 14 car.');
    expect(text({ length: 8 })).toBe('8 car.');
  });

  it('senha padrão conhecida: só a nota, nada do valor', () => {
    expect(secretHintOf({ isDefault: true, tail: 'oot', length: 4 })).toEqual({ masked: null, note: 'senha padrão conhecida' });
  });

  it('sem dica, dica vazia ou lixo: nada para mostrar', () => {
    expect(secretHintOf(undefined)).toBeNull();
    expect(secretHintOf({})).toBeNull();
    expect(secretHintOf({ length: 0 })).toBeNull();
    expect(secretHintOf({ length: -3 })).toBeNull();
    expect(secretHintOf({ length: 1.5 })).toBeNull();
    expect(secretHintOf({ length: Number.NaN })).toBeNull();
    expect(secretHintOf({ length: '12' as unknown as number })).toBeNull();
  });

  it('segunda trava: o que passa do contrato não chega à tela (fim em 4, prefixo em 24, sem caracteres invisíveis)', () => {
    expect(text({ prefix: 'ghp_', tail: 'abcdefghij', length: 40 })).toBe('ghp_…ghij, 40 car.');
    expect(text({ prefix: 'x'.repeat(60), length: 10 })).toBe(`${'x'.repeat(24)}…, 10 car.`);
    expect(text({ tail: 'a‮b\u0000c d', length: 12 })).toBe('…abcd, 12 car.');
  });

  it('o fim com acento vem inteiro (corta por caractere, não por byte)', () => {
    expect(text({ tail: 'ção', length: 13 })).toBe('…ção, 13 car.');
  });

  it('é texto no DOM: HTML na dica não vira marcação', () => {
    const html = row({ verdict: 'exposed', reason: 'strong-value', hint: { tail: '<b>', length: 12 } });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('credencial exposta nunca sugere ignorar', () => {
  const view = (secret: Partial<NonNullable<InboxItem['secret']>>) => SecretNoticeView({ item: item(secret), busy: false, onIgnore: () => {} });

  it('o botão do balão chama-se "Já troquei" e o título não diz "não vou trocar"', () => {
    const [btn] = buttons(view({ verdict: 'exposed', reason: 'other-host' }));
    expect(btn!.props.children).toBe('Já troquei');
    expect(btn!.props.title).not.toMatch(/ignor|não vou trocar/i);
    expect(bubble({ verdict: 'exposed', reason: 'other-host' })).not.toContain('Ignorar');
  });

  it('nos outros estados o botão segue "Ignorar"', () => {
    for (const verdict of ['example', 'local', 'unknown'] as const) {
      expect(buttons(view({ verdict, reason: 'no-context' })).map((b) => b.props.children), verdict).toEqual(['Ignorar']);
    }
  });

  it('o botão faz a mesma coisa nos dois nomes', () => {
    let ignored = 0;
    const [btn] = buttons(SecretNoticeView({ item: item({ verdict: 'exposed', reason: 'other-host' }), busy: false, onIgnore: () => (ignored += 1) }));
    btn!.props.onClick!();
    expect(ignored).toBe(1);
  });
});

describe('o aviso de erro não ganha selo', () => {
  it('kind error segue só com a frase', () => {
    const err: InboxItem = { ...item({ verdict: 'exposed', reason: 'other-host' }), kind: 'error' };
    expect(renderToStaticMarkup(createElement(SecretNotice, { item: err }))).not.toContain('secret-verdict');
  });
});
