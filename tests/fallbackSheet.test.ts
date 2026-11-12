import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskFallback } from '../shared/model';
import { ChatFallbackBadge, TaskFallbackBadge } from '../client/src/staff/FallbackBadge';
import { FallbackField } from '../client/src/staff/FallbackField';
import {
  draftOf,
  fallbackEfforts,
  fallbackHelpKeys,
  fallbackProblem,
  fallbackToSend,
  keepFallbackEffort,
  otherEngine,
  showFallbackField,
  type FallbackDraft,
} from '../client/src/staff/fallbackEngine';
import type { CodexCatalog } from '../client/src/staff/codexEngine';
import { t } from '../client/src/i18n';

// Motor secundário na ficha, no cartão da tarefa e no chat: o que a tela mostra e o que ela manda ao servidor.

const off: FallbackDraft = { on: false, model: '', effort: '' };
const catalog: CodexCatalog = [
  { slug: 'gpt-6-sol', displayName: 'GPT-6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'high' },
  { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
];

describe('o outro motor', () => {
  it('o secundário é sempre o oposto do principal', () => {
    expect(otherEngine('claude')).toBe('codex');
    expect(otherEngine('codex')).toBe('claude');
  });
});

describe('quando o campo aparece', () => {
  it('Codex como principal: sempre (o secundário é o Claude)', () => {
    expect(showFallbackField(false, 'codex', false)).toBe(true);
  });
  it('Claude como principal: só com o Codex ligado, ou com um secundário já gravado (para dar para tirar)', () => {
    expect(showFallbackField(false, 'claude', false)).toBe(false);
    expect(showFallbackField(null, 'claude', false)).toBe(false);
    expect(showFallbackField(true, 'claude', false)).toBe(true);
    expect(showFallbackField(false, 'claude', true)).toBe(true);
  });
});

describe('o que vai ao servidor', () => {
  it('ligado: o outro motor, o modelo sem espaços e o esforço só se escolhido', () => {
    expect(fallbackToSend({ on: true, model: ' gpt-6-sol ', effort: 'high' }, 'claude', false, true)).toEqual({ fallback: { engine: 'codex', model: 'gpt-6-sol', effort: 'high' } });
    expect(fallbackToSend({ on: true, model: 'sonnet', effort: '' }, 'codex', true, true)).toEqual({ fallback: { engine: 'claude', model: 'sonnet' } });
  });
  it('desligado: tira o que a ficha tinha (null); sem nada salvo, nem manda a chave', () => {
    expect(fallbackToSend(off, 'claude', true, true)).toEqual({ fallback: null });
    expect(fallbackToSend(off, 'claude', false, true)).toEqual({});
  });
  it('campo escondido (ficha simples, adoção): não manda a chave, o servidor mantém o que está', () => {
    expect(fallbackToSend({ on: true, model: 'sonnet', effort: '' }, 'codex', true, false)).toEqual({});
    expect(fallbackToSend(off, 'claude', true, false)).toEqual({});
  });
  it('o rascunho nasce do que a ficha tem', () => {
    expect(draftOf(undefined)).toEqual(off);
    expect(draftOf({ engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' })).toEqual({ on: true, model: 'gpt-6-sol', effort: 'ultra' });
    expect(draftOf({ engine: 'claude', model: 'opus' })).toEqual({ on: true, model: 'opus', effort: '' });
  });
});

describe('validação antes de mandar', () => {
  it('desligado não reclama; ligado exige o modelo', () => {
    expect(fallbackProblem(off)).toBeNull();
    expect(fallbackProblem({ on: true, model: '  ', effort: '' })).toBe('staff.errFallbackModel');
  });
  it('o modelo segue a regra do servidor (letras, números, ponto, hífen, sublinhado, colchetes; até 60)', () => {
    expect(fallbackProblem({ on: true, model: 'claude-sonnet-5-5', effort: '' })).toBeNull();
    expect(fallbackProblem({ on: true, model: 'opus[1m]', effort: '' })).toBeNull();
    expect(fallbackProblem({ on: true, model: 'gpt 6', effort: '' })).toBe('staff.errFallbackModelBad');
    expect(fallbackProblem({ on: true, model: 'a;rm -rf', effort: '' })).toBe('staff.errFallbackModelBad');
    expect(fallbackProblem({ on: true, model: 'x'.repeat(61), effort: '' })).toBe('staff.errFallbackModelBad');
  });
});

describe('esforço do secundário', () => {
  it('Claude: low a max, nunca ultra', () => {
    expect(fallbackEfforts('claude', 'sonnet', null)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('Codex sem catálogo ou com modelo digitado fora dele: todos, com ultra', () => {
    expect(fallbackEfforts('codex', 'gpt-6-sol', null)).toContain('ultra');
    expect(fallbackEfforts('codex', 'outro-modelo', catalog)).toContain('ultra');
  });
  it('Codex com modelo do catálogo: só os que ele aceita', () => {
    expect(fallbackEfforts('codex', 'gpt-6-luna', catalog)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(fallbackEfforts('codex', 'gpt-6-sol', catalog)).toContain('ultra');
  });
  it('trocou o modelo: o esforço fica se ainda vale, senão limpa', () => {
    const luna = fallbackEfforts('codex', 'gpt-6-luna', catalog);
    expect(keepFallbackEffort('high', luna)).toBe('high');
    expect(keepFallbackEffort('ultra', luna)).toBe('');
    expect(keepFallbackEffort('', luna)).toBe('');
  });
});

describe('textos de ajuda', () => {
  it('Claude como secundário de ficha Codex avisa do modo e do que não tem; Codex avisa da sandbox', () => {
    expect(fallbackHelpKeys('codex')).toEqual(['staff.fallbackHelp', 'staff.fallbackClaudeNote']);
    expect(fallbackHelpKeys('claude')).toEqual(['staff.fallbackHelp', 'staff.fallbackCodexNote']);
    const claude = t('staff.fallbackClaudeNote', { mode: t('staff.autonomyEditsLabel') });
    expect(claude).toContain('Edita sozinho');
    expect(claude).toMatch(/sem MCP, Chrome nem servidores/);
    expect(claude).not.toMatch(/manual/i);
    expect(t('staff.fallbackHelp')).toMatch(/outro provedor/);
  });
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const connections = [
  { name: 'vps', source: 'vps' as const },
  { name: 'site', source: 'ftp' as const },
];
const field = (main: 'claude' | 'codex', draft: FallbackDraft, servers: string[] = []) =>
  html(createElement(FallbackField, { main, servers, serverList: connections, draft, onChange: () => {} }));

describe('campo na ficha', () => {
  it('desligado: só o botão e a frase de que a tarefa espera; nada de modelo', () => {
    const out = field('claude', off);
    expect(out).toContain('Motor secundário (quando o principal bater o limite)');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('espera o limite do principal voltar');
    expect(out).not.toContain('<input');
  });
  it('ligado numa ficha Codex: motor Claude fixo (sem seletor), modelo com sugestões, esforço sem ultra, ajuda do modo', () => {
    const out = field('codex', { on: true, model: 'sonnet', effort: 'high' });
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('<b>Claude</b>');
    expect(out).toContain('value="sonnet"');
    expect(out).toContain('<datalist');
    expect(out).toContain('value="opus"');
    expect(out).not.toContain('value="ultra"');
    expect(out).toContain('Edita sozinho');
    expect(out).toContain('outro provedor');
  });
  it('ligado numa ficha Claude: motor Codex, esforço com ultra', () => {
    const out = field('claude', { on: true, model: 'gpt-6-sol', effort: '' });
    expect(out).toContain('<b>Codex (GPT)</b>');
    expect(out).toContain('value="ultra"');
  });
  it('Codex como secundário com conexão FTP na ficha: botão desligado e o motivo na tela', () => {
    const out = field('claude', off, ['site']);
    expect(out).toContain('disabled');
    expect(out).toContain('Conexão FTP não funciona no Codex');
  });
  it('Codex como secundário com só SSH na ficha: botão livre, sem aviso', () => {
    const out = field('claude', off, ['vps']);
    expect(out).not.toContain('disabled');
    expect(out).not.toContain('Conexão FTP não funciona');
  });
  it('Codex já ligado e FTP adicionado depois: o botão continua livre (para desligar) e o aviso fica', () => {
    const out = field('claude', { on: true, model: 'gpt-6-sol', effort: '' }, ['site']);
    expect(out).not.toMatch(/<button[^>]*disabled/);
    expect(out).toContain('role="note"');
  });
});

const task: TaskFallback = { engine: 'codex', model: 'gpt-6-sol', from: 'claude', at: Date.UTC(2026, 10, 10, 15, 30, 0), fromSession: null, reason: 'limit-mid' };

describe('selos', () => {
  it('tarefa: motor e modelo, com o motivo e a hora no tooltip', () => {
    const out = html(createElement(TaskFallbackBadge, { fallback: task }));
    expect(out).toContain('no secundário: Codex (GPT) · gpt-6-sol');
    expect(out).toContain('Trocou no meio');
    expect(out).toContain('Claude');
    expect(out).toMatch(/title="[^"]*Desde [^"]*2026/);
  });
  it('tarefa que já começou no secundário: motivo "começou direto"', () => {
    const out = html(createElement(TaskFallbackBadge, { fallback: { ...task, reason: 'limit-start' } }));
    expect(out).toContain('Começou direto no motor secundário');
  });
  it('chat: diz o motor e o modelo e que o principal estava no limite', () => {
    const out = html(createElement(ChatFallbackBadge, { fallback: { engine: 'claude', model: 'sonnet' } }));
    expect(out).toContain('No motor secundário: Claude · sonnet');
    expect(out).toContain('estava no limite de uso');
    expect(out).toContain('Codex (GPT)'); // o principal que estourou
  });
});
