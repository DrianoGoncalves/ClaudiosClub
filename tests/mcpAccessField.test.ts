import { describe, expect, it } from 'vitest';
import { t } from '../client/src/i18n';
import {
  accessOf,
  accessToSend,
  BROWSER_KEYS,
  browserAccess,
  browserAccessHints,
  hasAccessKey,
  MCP_ACCESS_LABEL,
  MCP_ACCESS_LEVELS,
  mcpAccessHints,
  withAccess,
  withBrowserAccess,
} from '../client/src/staff/mcpAccessField';
import { CHROME_KEYS } from '../server/staff/mcpAccess';
import { StaffInputSchema } from '../server/staff/store';

describe('acesso por MCP na ficha', () => {
  it('sem regra = Livre; Livre tira a chave, os outros níveis a gravam', () => {
    expect(accessOf({}, 'github')).toBe('free');
    expect(accessOf({ github: 'off' }, 'github')).toBe('off');
    expect(withAccess({}, 'github', 'ask')).toEqual({ github: 'ask' });
    expect(withAccess({ a: 'ask', b: 'off' }, 'a', 'readonly')).toEqual({ a: 'readonly', b: 'off' });
    expect(withAccess({ a: 'ask', b: 'off' }, 'a', 'free')).toEqual({ b: 'off' });
  });

  it('não altera o objeto recebido', () => {
    const m = { a: 'ask' } as const;
    withAccess(m, 'a', 'free');
    withBrowserAccess(m, 'off');
    expect(m).toEqual({ a: 'ask' });
  });

  it('os quatro níveis têm texto nos 3 idiomas, do mais solto ao mais fechado', () => {
    expect(MCP_ACCESS_LEVELS).toEqual(['free', 'ask', 'readonly', 'off']);
    expect(MCP_ACCESS_LEVELS.map((l) => t(MCP_ACCESS_LABEL[l]))).toEqual(['Livre', 'Pede antes de escrever', 'Só leitura', 'Desligado']);
    for (const k of ['staff.mcpAccessIntro', 'staff.mcpAccessFor', 'staff.mcpAccessNoKey', 'staff.browserAccess'] as const) expect(t(k)).not.toBe(k);
  });

  it('nome que o servidor recusa fica sem seletor', () => {
    for (const ok of ['github', 'myco-ssh', 'claude.ai Gmail', 'x'.repeat(100)]) expect(hasAccessKey(ok)).toBe(true);
    for (const ruim of ['', 'x'.repeat(101), '__proto__', 'constructor', 'prototype']) expect(hasAccessKey(ruim)).toBe(false);
  });

  it('o pedido leva o mapa só quando mudou (ausente mantém; {} limpa), sem entradas livres', () => {
    expect(accessToSend({}, undefined)).toEqual({});
    expect(accessToSend({ a: 'ask' }, { a: 'ask' })).toEqual({});
    expect(accessToSend({ b: 'off', a: 'ask' }, { a: 'ask', b: 'off' })).toEqual({});
    expect(accessToSend({ a: 'ask' }, undefined)).toEqual({ mcpAccess: { a: 'ask' } });
    expect(accessToSend({ a: 'off' }, { a: 'ask' })).toEqual({ mcpAccess: { a: 'off' } });
    expect(accessToSend({}, { a: 'ask' })).toEqual({ mcpAccess: {} });
    expect(accessToSend({ a: 'free', b: 'ask' }, { b: 'ask' })).toEqual({});
  });

  it('as chaves que a tela não mostra seguem junto ao mudar outra (o servidor troca o mapa todo)', () => {
    const salvo = { 'myco-ssh': 'readonly', desmarcado: 'off' } as const;
    expect(accessToSend(withAccess(salvo, 'github', 'ask'), salvo)).toEqual({ mcpAccess: { 'myco-ssh': 'readonly', desmarcado: 'off', github: 'ask' } });
  });

  it('o pedido passa no schema do servidor', () => {
    const base = { name: 'Ana', role: 'dev', mission: 'x', firstTask: '', reportsTo: [], autonomy: 'manual', agents: [], skills: [], mcps: null, knowledge: [], rules: [], doneWhen: '', canHire: false, worktree: false, servers: [], browser: true };
    const { mcpAccess } = accessToSend(withBrowserAccess({ github: 'ask', 'claude.ai Gmail': 'readonly' }, 'off'), undefined);
    expect(StaffInputSchema.safeParse({ ...base, mcpAccess }).success).toBe(true);
  });
});

describe('acesso do navegador', () => {
  it('as chaves são as do servidor', () => {
    expect([...BROWSER_KEYS]).toEqual([...CHROME_KEYS]);
  });

  it('mostra o mais restritivo das duas chaves', () => {
    expect(browserAccess({})).toBe('free');
    expect(browserAccess({ 'claude-in-chrome': 'ask' })).toBe('ask');
    expect(browserAccess({ 'myco-chrome': 'readonly' })).toBe('readonly');
    expect(browserAccess({ 'claude-in-chrome': 'ask', 'myco-chrome': 'off' })).toBe('off');
    expect(browserAccess({ github: 'off' })).toBe('free');
  });

  it('trocar o nível grava as duas chaves; Livre tira as duas e não toca nas outras', () => {
    expect(withBrowserAccess({ github: 'ask' }, 'readonly')).toEqual({ github: 'ask', 'claude-in-chrome': 'readonly', 'myco-chrome': 'readonly' });
    expect(withBrowserAccess({ 'claude-in-chrome': 'off', 'myco-chrome': 'ask', github: 'ask' }, 'free')).toEqual({ github: 'ask' });
    expect(withBrowserAccess({ 'claude-in-chrome': 'off', 'myco-chrome': 'ask' }, 'ask')).toEqual({ 'claude-in-chrome': 'ask', 'myco-chrome': 'ask' });
  });

  it('sem mexer no navegador, o pedido não leva nada (mesmo com uma só chave salva)', () => {
    const salvo = { 'claude-in-chrome': 'ask' } as const;
    expect(accessToSend(salvo, salvo)).toEqual({});
  });
});

describe('dicas do seletor', () => {
  it('Livre e Desligado não levam dica', () => {
    for (const l of ['free', 'off'] as const) {
      expect(mcpAccessHints(l, {})).toEqual([]);
      expect(browserAccessHints(l)).toEqual([]);
    }
  });

  it('MCP testado: diz quantas ferramentas escrevem; Pede antes ainda avisa do GPT e do modo sem travas', () => {
    const info = { tools: { total: 5, write: 4 } };
    const count = { key: 'staff.mcpAccessCount', params: { write: 4, total: 5 } };
    expect(mcpAccessHints('readonly', info)).toEqual([count]);
    expect(mcpAccessHints('ask', info)).toEqual([count, { key: 'staff.mcpAccessAskNote' }]);
  });

  it('MCP sem teste: diz que nenhuma ferramenta conta como leitura (Só leitura bloqueia o MCP inteiro)', () => {
    expect(mcpAccessHints('readonly', {})).toEqual([{ key: 'staff.mcpAccessUntestedReadonly' }]);
    expect(mcpAccessHints('ask', {})).toEqual([{ key: 'staff.mcpAccessUntestedAsk' }, { key: 'staff.mcpAccessAskNote' }]);
  });

  it('o navegador não tem teste: a dica diz que não separa leitura de escrita', () => {
    expect(browserAccessHints('readonly')).toEqual([{ key: 'staff.browserAccessReadonly' }]);
    expect(browserAccessHints('ask')).toEqual([{ key: 'staff.browserAccessAsk' }, { key: 'staff.mcpAccessAskNote' }]);
  });

  it('a nota do "Pede antes" cita os nomes dos níveis e o do modo sem travas', () => {
    const vars = { ask: t(MCP_ACCESS_LABEL.ask), readonly: t(MCP_ACCESS_LABEL.readonly), bypass: t('staff.autonomyBypassLabel') };
    const note = t('staff.mcpAccessAskNote', vars);
    expect(note).toBe('No GPT e no modo Sem travas, “Pede antes de escrever” vira “Só leitura”: não há quem confirme.');
    expect(note).not.toMatch(/[{}]/);
  });
});
