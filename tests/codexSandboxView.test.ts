import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/src/api';
import { copyText } from '../client/src/chat/markdown';
import { SecretNotice } from '../client/src/chat/SecretNotice';
import { errorNoticesFor, sandboxNoticesFor, secretNoticesFor } from '../client/src/chat/secretAlerts';
import { SANDBOX_FIX, sandboxOf, sandboxText } from '../client/src/inbox/codexSandbox';
import { inboxText, inboxWho } from '../client/src/inbox/inboxText';
import { SandboxFix } from '../client/src/inbox/SandboxFix';
import { dismissCall } from '../client/src/inbox/useInbox';
import staff from '../client/src/i18n/staff';
import type { InboxItem } from '../shared/model';

// O que o servidor manda (server/inboxItems.ts `codexSandboxInboxItem`): item da máquina, sem projeto nem conversa, com `codexSandbox`.
const sandbox = (days: number | null, over: Partial<NonNullable<InboxItem['codexSandbox']>> = {}): InboxItem => ({
  id: 'codexsandbox:password-policy',
  kind: 'error',
  projectId: '',
  projectName: '',
  sessionId: '',
  staffId: null,
  name: 'Sandbox do Codex',
  summary: 'texto do servidor em pt-BR',
  at: '2026-11-19T10:00:00.000Z',
  codexSandbox: { cause: 'password-policy', source: 'check', minPasswordAgeDays: days, command: SANDBOX_FIX, domainNote: true, ...over },
});

describe('sandboxOf: o aviso que a tela sabe mostrar', () => {
  it('duração maior que 0: a causa conhecida, com o comando para copiar', () => {
    expect(sandboxOf(sandbox(1))).toEqual({ days: 1, command: 'net accounts /minpwage:0' });
    expect(sandboxOf(sandbox(42))).toEqual({ days: 42, command: 'net accounts /minpwage:0' });
  });

  it('duração 0: o comando não resolve, então não há o que copiar', () => {
    expect(sandboxOf(sandbox(0))).toEqual({ days: 0, command: null });
  });

  it('leitura que não deu (null) ou valor que não é inteiro ≥ 0: duração desconhecida, o comando segue oferecido', () => {
    expect(sandboxOf(sandbox(null))).toEqual({ days: null, command: SANDBOX_FIX });
    expect(sandboxOf(sandbox(-3))).toEqual({ days: null, command: SANDBOX_FIX });
    expect(sandboxOf(sandbox(1.5))).toEqual({ days: null, command: SANDBOX_FIX });
  });

  it('só o comando conhecido vira botão de copiar: outro texto (ou outra causa) deixa o item sem o aviso', () => {
    expect(sandboxOf(sandbox(1, { command: 'net accounts /minpwage:0 & del /s C:\\' }))).toBeNull();
    expect(sandboxOf(sandbox(1, { command: 'net accounts /minpwage:1' }))).toBeNull();
    expect(sandboxOf(sandbox(1, { command: '' }))).toBeNull();
    expect(sandboxOf({ codexSandbox: { cause: 'outra' as 'password-policy', source: 'check', minPasswordAgeDays: 1, command: SANDBOX_FIX, domainNote: true } })).toBeNull();
    expect(sandboxOf({})).toBeNull();
  });
});

describe('a frase do item da caixa', () => {
  it('sai do campo estruturado, em leigo, e não do summary pt-BR do servidor', () => {
    expect(inboxText(sandbox(1))).toBe(
      'O terminal dos funcionários no Codex não funciona nesta máquina: a política de senha do Windows exige duração mínima de 1 dia, e o Codex não consegue trocar a senha dos usuários locais dele.',
    );
    expect(inboxText(sandbox(30))).toContain('duração mínima de 30 dias');
    expect(inboxText(sandbox(0))).toContain('A duração mínima da senha já está em 0');
    expect(inboxText(sandbox(0))).toContain('net accounts');
    expect(inboxText(sandbox(null))).toContain('A causa mais comum é a duração mínima da senha do Windows');
    for (const days of [0, 1, 30, null]) expect(inboxText(sandbox(days))).toContain('O terminal dos funcionários no Codex não funciona nesta máquina');
  });

  it('item que a tela não reconhece mostra o summary do servidor, como qualquer erro', () => {
    expect(inboxText(sandbox(1, { command: 'outro' }))).toBe('texto do servidor em pt-BR');
  });

  it('quem avisa é "Codex" no idioma da tela, não o nome pt-BR do servidor', () => {
    expect(inboxWho(sandbox(1))).toBe('Codex');
    expect(inboxWho(sandbox(1, { command: 'outro' }))).toBe('Sandbox do Codex');
  });
});

describe('as 3 línguas', () => {
  const keys = (locale: 'pt-BR' | 'en' | 'es') => Object.keys(staff[locale]).filter((k) => k.startsWith('inbox.sandbox.')).sort();
  const vars = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

  it('pt-BR, en e es têm as mesmas chaves e os mesmos {campos}', () => {
    expect(keys('pt-BR').length).toBeGreaterThanOrEqual(12);
    expect(keys('en')).toEqual(keys('pt-BR'));
    expect(keys('es')).toEqual(keys('pt-BR'));
    const text = (locale: 'pt-BR' | 'en' | 'es', k: string) => (staff[locale] as Record<string, string>)[k]!;
    for (const k of keys('pt-BR')) {
      expect(vars(text('en', k)), k).toEqual(vars(text('pt-BR', k)));
      expect(vars(text('es', k)), k).toEqual(vars(text('pt-BR', k)));
    }
  });

  describe('a página em outro idioma', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });
    const inLocale = async (locale: string) => {
      vi.resetModules();
      vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
      const [text, view] = await Promise.all([import('../client/src/inbox/inboxText'), import('../client/src/inbox/codexSandbox')]);
      return { ...text, ...view };
    };

    it.each([
      ['en', 'The terminal for Codex employees does not work on this machine', 'minimum password age of 3 days'],
      ['es', 'La terminal de los empleados en Codex no funciona en esta máquina', 'duración mínima de 3 días'],
    ])('%s: a frase sai no idioma, com os dias', async (locale, head, days) => {
      const m = await inLocale(locale);
      expect(m.inboxText(sandbox(3))).toContain(head);
      expect(m.inboxText(sandbox(3))).toContain(days);
      expect(m.inboxText(sandbox(1))).toContain(locale === 'en' ? 'of 1 day,' : 'de 1 día,');
      expect(m.inboxWho(sandbox(3))).toBe('Codex');
      // O texto de uma língua não vaza para a outra.
      expect(m.inboxText(sandbox(3))).not.toContain('não funciona nesta máquina');
    });
  });
});

describe('SandboxFix: o comando com botão de copiar e as notas', () => {
  const html = (days: number | null) => renderToStaticMarkup(createElement(SandboxFix, { alert: sandboxOf(sandbox(days))! }));

  it('mostra o comando, o botão Copiar, "como administrador" e a nota do domínio', () => {
    const h = html(1);
    expect(h).toContain('<code class="mono">net accounts /minpwage:0</code>');
    expect(h).toContain('>Copiar</button>');
    expect(h).toContain('Para resolver, rode este comando como administrador:');
    expect(h).toContain('Abra o PowerShell com “Executar como administrador”');
    expect(h).toContain('Em computador de domínio (empresa, escola), a política de grupo pode desfazer a mudança.');
  });

  it('leitura que não deu: pede para conferir antes de rodar', () => {
    const h = html(null);
    expect(h).toContain('Rode net accounts: se a duração mínima da senha for maior que 0, rode como administrador:');
    expect(h).toContain('net accounts /minpwage:0</code>');
  });

  it('duração já em 0: nada a copiar, o bloco nem aparece', () => {
    expect(html(0)).toBe('');
  });

  it('o aviso de falha da cópia só aparece depois de tentar (não na primeira renderização)', () => {
    expect(html(1)).not.toContain('Não deu para copiar');
  });
});

describe('copyText: a cópia que o botão faz', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('devolve true quando a área de transferência aceita, e o texto copiado é o do comando', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText(SANDBOX_FIX)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('net accounts /minpwage:0');
  });

  it('devolve false quando o navegador recusa ou não oferece a área de transferência (sem HTTPS, sem permissão)', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => Promise.reject(new Error('negado')) } });
    expect(await copyText('x')).toBe(false);
    vi.stubGlobal('navigator', {});
    expect(await copyText('x')).toBe(false);
  });
});

describe('o balão na conversa do Codex', () => {
  const ana = sandbox(1);
  const other: InboxItem = { ...sandbox(1), id: 'error:s1', sessionId: 's1', name: 'Ana', projectId: 'p1', projectName: 'P', codexSandbox: undefined, summary: 'erro comum' };

  it('só em conversa que roda no Codex; a do Claude não vê (o terminal dela não depende disso)', () => {
    expect(sandboxNoticesFor([ana], 'codex')).toEqual([ana]);
    expect(sandboxNoticesFor([ana], 'claude')).toEqual([]);
    expect(sandboxNoticesFor(undefined, 'codex')).toEqual([]);
    expect(sandboxNoticesFor([], 'codex')).toEqual([]);
  });

  it('pega só o aviso da máquina: outros erros e item de forma desconhecida ficam de fora', () => {
    expect(sandboxNoticesFor([other, sandbox(2, { command: 'outro' }), ana], 'codex')).toEqual([ana]);
  });

  it('o aviso da máquina (sem conversa) não vira o balão de erro comum de nenhuma conversa, nem o de segredo', () => {
    expect(errorNoticesFor([ana], 's1')).toEqual([]);
    expect(errorNoticesFor([ana], '')).toEqual([]);
    expect(secretNoticesFor([ana], 's1')).toEqual([]);
  });

  it('o balão leva o comando e um Ignorar com o texto próprio (volta só se a política passar a 0 e falhar de novo)', () => {
    const h = renderToStaticMarkup(createElement(SecretNotice, { item: ana, onIgnore: async () => {} }));
    expect(h).toContain('class="permission secret-notice is-error"');
    expect(h).toContain('O terminal dos funcionários no Codex não funciona nesta máquina');
    expect(h).toContain('net accounts /minpwage:0</code>');
    expect(h).toContain('>Ignorar<');
    expect(h).toContain('só volta se a política passar a 0 e falhar de novo');
    expect(h).not.toContain('Se a conversa parar com outro erro');
  });

  it('o erro comum segue como era: sem comando, com o Ignorar de sempre', () => {
    const h = renderToStaticMarkup(createElement(SecretNotice, { item: other, onIgnore: async () => {} }));
    expect(h).not.toContain('sandbox-fix');
    expect(h).toContain('Se a conversa parar com outro erro');
  });
});

describe('ignorar', () => {
  it('o × (caixa) e o Ignorar (balão) chamam a rota de erro com o id inteiro, `codexsandbox:password-policy`', async () => {
    const calls: string[] = [];
    const slots = api as unknown as Record<string, unknown>;
    const original = slots.dismissError;
    slots.dismissError = async (id: string) => (calls.push(id), { ok: true });
    try {
      await dismissCall(sandbox(1));
    } finally {
      slots.dismissError = original;
    }
    expect(calls).toEqual(['codexsandbox:password-policy']);
  });
});
