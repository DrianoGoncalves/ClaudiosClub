import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxItem, Task } from '../shared/model';
import { inboxText } from '../client/src/inbox/inboxText';
import type { Tr } from '../client/src/inbox/secretText';
import { alertAction, isFallbackWait, stuckText } from '../client/src/inbox/taskAlerts';
import { FallbackWaitBadge, fallbackWaitText } from '../client/src/tasks/FallbackWait';
import staffMessages from '../client/src/i18n/staff';
import taskMessages from '../client/src/i18n/tasks';

// A tarefa que espera o limite do motor da ficha voltar porque a troca para o secundário não serve (`Task.fallbackBlocked`): o selo do cartão,
// a frase do detalhe e o item da caixa (`stuck:<tarefa>:fallback`, sem ação do dono).

const NOW = Date.parse('2026-11-17T10:00:00');
const MIN = 60_000;
const SANDBOX = 'outra conversa do Codex está rodando agora; no Windows duas ao mesmo tempo derrubam a sandbox uma da outra';
const wait = (over: Partial<NonNullable<Task['fallbackBlocked']>> = {}): NonNullable<Task['fallbackBlocked']> => ({
  reason: 'sandbox',
  detail: SANDBOX,
  engine: 'codex',
  from: 'claude',
  since: '2026-11-17T09:50:00',
  until: new Date(NOW + 90 * MIN).toISOString(),
  ...over,
});

describe('texto da espera (cartão e detalhe)', () => {
  it('diz o limite que espera, o motor que não serve e o motivo, com o detalhe do servidor', () => {
    const text = fallbackWaitText(wait(), NOW)!;
    expect(text.head).toBe('Sem troca: espera o limite do Claude voltar');
    expect(text.hint).toContain('O Claude bateu o limite de uso');
    expect(text.hint).toMatch(/\(volta \d{2}:\d{2}\)/);
    expect(text.hint).toContain('a troca para o Codex (GPT) não serve agora: sandbox indisponível (outra conversa do Codex');
    expect(text.hint).toContain('segue no Claude');
  });

  it('cada motivo tem a sua frase; motivo desconhecido cai em "a troca não abre"', () => {
    expect(fallbackWaitText(wait({ reason: 'agents', detail: 'o Codex não tem os agents da ficha: gil' }), NOW)!.hint).toContain('agents indisponíveis (o Codex não tem os agents da ficha: gil)');
    expect(fallbackWaitText(wait({ reason: 'model', detail: '' }), NOW)!.hint).toContain('modelo indisponível.');
    expect(fallbackWaitText(wait({ reason: 'other', detail: 'o Codex está desligado' }), NOW)!.hint).toContain('a troca não abre (o Codex está desligado)');
    expect(fallbackWaitText(wait({ reason: 'novo' as never, detail: '' }), NOW)!.hint).toContain('a troca não abre.');
  });

  it('limite que volta em outro dia mostra dia e hora; sem `until` (ou ilegível), não promete hora', () => {
    const amanha = new Date(NOW + 30 * 60 * MIN).toISOString();
    expect(fallbackWaitText(wait({ until: amanha }), NOW)!.hint).toMatch(/\(volta \d{2}\/\d{2}[ ,]+\d{2}:\d{2}\)/);
    expect(fallbackWaitText(wait({ until: null }), NOW)!.hint).not.toContain('(volta');
    expect(fallbackWaitText(wait({ until: 'lixo' }), NOW)!.hint).not.toContain('(volta');
  });

  it('o limite passou (until antes de agora): sem selo, como o servidor; sem marca, também', () => {
    expect(fallbackWaitText(wait({ until: new Date(NOW - MIN).toISOString() }), NOW)).toBeNull();
    expect(fallbackWaitText(wait({ until: new Date(NOW).toISOString() }), NOW)).toBeNull();
    expect(fallbackWaitText(undefined, NOW)).toBeNull();
  });

  it('o motor da ficha pode ser o Codex: a frase troca os nomes', () => {
    const text = fallbackWaitText(wait({ from: 'codex', engine: 'claude', reason: 'model', detail: '' }), NOW)!;
    expect(text.head).toBe('Sem troca: espera o limite do Codex (GPT) voltar');
    expect(text.hint).toContain('a troca para o Claude não serve agora');
  });
});

describe('selo no cartão', () => {
  const html = (w: Task['fallbackBlocked'], warm?: boolean) => renderToStaticMarkup(createElement(FallbackWaitBadge, { wait: w, now: NOW, warm }));

  it('só A fazer leva o laranja (task-wait); nas outras colunas fica neutro', () => {
    expect(html(wait(), true)).toContain('task-queue task-fbwait task-wait small');
    expect(html(wait(), false)).toContain('task-queue task-fbwait small');
    expect(html(wait())).not.toContain('task-wait');
  });

  it('texto escapado; a frase inteira vai no title', () => {
    const out = html(wait({ detail: '<b>x</b> & y' }));
    expect(out).toContain('Sem troca: espera o limite do Claude voltar');
    expect(out).toContain('title="O Claude bateu o limite de uso');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(out).not.toContain('<b>x');
  });

  it('sem espera (ou vencida): nada na tela', () => {
    expect(html(undefined)).toBe('');
    expect(html(wait({ until: new Date(NOW - MIN).toISOString() }))).toBe('');
  });
});

describe('item da caixa', () => {
  type Locale = 'pt-BR' | 'en' | 'es';
  const tr = (locale: Locale): Tr => (key, vars) => {
    const text = (staffMessages[locale] as Record<string, string>)[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
  };
  const item = (over: Partial<InboxItem> = {}): InboxItem =>
    ({
      id: 'stuck:t-1:fallback',
      kind: 'stuck',
      projectId: 'p',
      projectName: 'P',
      sessionId: '',
      staffId: 'ana-1',
      name: 'Ana',
      summary: '“Tela” está parada: espera o limite do Claude baixar: a troca para o Codex não serve agora (sandbox indisponível: x)',
      at: '2026-11-17T10:00:00Z',
      stuck: { taskId: 't-1', taskTitle: 'Tela', reason: 'x', selfHeals: true, humanAction: null, since: '2026-11-17T10:00:00Z' },
      ...over,
    }) as unknown as InboxItem;

  it('é a espera da troca: id `:fallback` e sem ação do dono', () => {
    expect(isFallbackWait(item())).toBe(true);
    expect(alertAction(item(), tr('pt-BR'))).toBeNull();
    // Sem humanAction mas com outro id (parada que se recupera sozinha de outro jeito), ou com ação: não é esta.
    expect(isFallbackWait(item({ id: 'stuck:t-1:review' }))).toBe(false);
    expect(isFallbackWait(item({ stuck: { ...item().stuck!, humanAction: 'review' } }))).toBe(false);
    expect(isFallbackWait({ kind: 'question' })).toBe(false);
  });

  it('a frase sai por idioma, com o título da tarefa; sem o id, segue o summary do servidor', () => {
    const pt = stuckText(item(), tr('pt-BR'));
    expect(pt).toBe('“Tela” espera o limite do motor principal voltar: a troca para o secundário não serve agora. Volta sozinha, sem ação sua');
    expect(inboxText(item(), tr('pt-BR'))).toBe(pt);
    expect(stuckText(item(), tr('en'))).toContain('waiting for the main engine’s limit');
    expect(stuckText(item(), tr('es'))).toContain('espera a que vuelva el límite del motor principal');
    expect(stuckText(item({ id: 'stuck:t-1:review' }), tr('pt-BR'))).toBe(item().summary);
  });
});

describe('textos novos', () => {
  it('as mesmas chaves nos 3 idiomas, nenhuma vazia', () => {
    for (const [messages, prefix] of [
      [taskMessages, /^tasks\.fbWait/],
      [staffMessages, /^inbox\.stuck\./],
    ] as const) {
      const pt = Object.keys(messages['pt-BR']).filter((k) => prefix.test(k)).sort();
      expect(pt.length).toBeGreaterThan(3);
      for (const locale of ['en', 'es'] as const) {
        expect(Object.keys(messages[locale]).filter((k) => prefix.test(k)).sort()).toEqual(pt);
        for (const k of pt) expect((messages[locale] as Record<string, string>)[k]!.trim()).not.toBe('');
      }
    }
  });
});
