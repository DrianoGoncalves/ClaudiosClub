import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CodexUsage } from '../shared/model';
import { CodexUsageLine } from '../client/src/toolbar/Toolbar';

// Linha do Codex no header geral: o ícone >_ (semáforo) não aparece junto do botão "Instalar", já que sem Codex nem há login.

const base: CodexUsage = { connected: false, reason: null, detail: null, limits: [], updatedAt: null, version: null, upgradeCommand: null };
const html = (codex: Partial<CodexUsage>) => renderToStaticMarkup(createElement(CodexUsageLine, { codex: { ...base, ...codex } }));

describe('linha do Codex no header', () => {
  it('não instalado: botão de instalar, sem o ícone vermelho nem o nome', () => {
    const out = html({ reason: 'not_installed' });
    expect(out).toContain('btn-login');
    expect(out).not.toContain('auth-light');
    expect(out).not.toContain('auth-off');
    expect(out).not.toContain('auth-name');
  });

  it('instalado e sem login: ícone vermelho e botão de entrar', () => {
    const out = html({ reason: 'not_logged_in' });
    expect(out).toContain('auth-light auth-off');
    expect(out).toContain('auth-name');
    expect(out).toContain('btn-login');
  });

  it('conectado: ícone verde, sem botão', () => {
    const out = html({ connected: true });
    expect(out).toContain('auth-light auth-ok');
    expect(out).not.toContain('btn-login');
  });

  it('lendo pela primeira vez e erro: o ícone segue o estado normal', () => {
    expect(html({ reason: 'loading' })).toContain('auth-light auth-wait');
    expect(html({ reason: 'error' })).toContain('auth-light auth-off');
  });
});
