import { describe, expect, it } from 'vitest';
import { t } from '../client/src/i18n';
import {
  levelOf,
  MCP_LEVEL_LABEL,
  MCP_LEVELS,
  mcpPolicyToSend,
  serverPolicyKey,
  toolKeysOf,
  toolNameOf,
  withLevel,
} from '../client/src/staff/mcpPolicyField';
import { McpPolicySchema } from '../server/staff/store';

describe('política de MCP na ficha', () => {
  it('chave do servidor: só nomes que o servidor aceita e que não confundem o separador "__"', () => {
    expect(serverPolicyKey('docs')).toBe('mcp__docs');
    expect(serverPolicyKey('myco-ftp')).toBe('mcp__myco-ftp');
    expect(serverPolicyKey('a_b')).toBe('mcp__a_b');
    for (const ruim of ['', 'claude.ai Gmail', 'a b', 'a__b', '_a', 'a_', '-a', 'a,b', 'a'.repeat(101)]) expect(serverPolicyKey(ruim)).toBeNull();
  });

  it('toda chave gerada passa no schema do servidor, com e sem ferramenta', () => {
    const key = serverPolicyKey('meu-mcp')!;
    expect(McpPolicySchema.safeParse({ [key]: 'ask', [`${key}__apagar`]: 'off' }).success).toBe(true);
  });

  it('sem regra = Permitir; Permitir tira a chave, os outros níveis a gravam', () => {
    expect(levelOf({}, 'mcp__a')).toBe('allow');
    expect(levelOf({ mcp__a: 'off' }, 'mcp__a')).toBe('off');
    expect(withLevel({}, 'mcp__a', 'ask')).toEqual({ mcp__a: 'ask' });
    expect(withLevel({ mcp__a: 'ask', mcp__b: 'off' }, 'mcp__a', 'off')).toEqual({ mcp__a: 'off', mcp__b: 'off' });
    expect(withLevel({ mcp__a: 'ask', mcp__b: 'off' }, 'mcp__a', 'allow')).toEqual({ mcp__b: 'off' });
  });

  it('não altera o objeto recebido', () => {
    const p = { mcp__a: 'ask' } as const;
    withLevel(p, 'mcp__a', 'allow');
    expect(p).toEqual({ mcp__a: 'ask' });
  });

  it('regras por ferramenta: só as do servidor, sem confundir servidor de nome parecido', () => {
    const keys = ['mcp__a', 'mcp__a__ler', 'mcp__a__apagar', 'mcp__ab__ler', 'mcp__b__x', 'mcp__a__'];
    expect(toolKeysOf(keys, 'mcp__a')).toEqual(['mcp__a__apagar', 'mcp__a__ler']);
    expect(toolNameOf('mcp__a__ler', 'mcp__a')).toBe('ler');
  });

  it('o pedido leva a política só quando mudou (ausente mantém; {} limpa)', () => {
    expect(mcpPolicyToSend({}, undefined)).toEqual({});
    expect(mcpPolicyToSend({ mcp__a: 'ask' }, { mcp__a: 'ask' })).toEqual({});
    expect(mcpPolicyToSend({ mcp__b: 'off', mcp__a: 'ask' }, { mcp__a: 'ask', mcp__b: 'off' })).toEqual({});
    expect(mcpPolicyToSend({ mcp__a: 'ask' }, undefined)).toEqual({ mcpPolicy: { mcp__a: 'ask' } });
    expect(mcpPolicyToSend({ mcp__a: 'off' }, { mcp__a: 'ask' })).toEqual({ mcpPolicy: { mcp__a: 'off' } });
    expect(mcpPolicyToSend({}, { mcp__a: 'ask' })).toEqual({ mcpPolicy: {} });
  });

  it('as chaves que a tela não mostra seguem junto ao mudar outra', () => {
    const salvo = { 'mcp__claude-in-chrome': 'ask', mcp__a__x: 'off' } as const;
    expect(mcpPolicyToSend(withLevel(salvo, 'mcp__b', 'off'), salvo)).toEqual({ mcpPolicy: { 'mcp__claude-in-chrome': 'ask', mcp__a__x: 'off', mcp__b: 'off' } });
  });

  it('níveis e textos de ficha existem nos 3 idiomas', () => {
    expect(MCP_LEVELS).toEqual(['allow', 'ask', 'off']);
    for (const l of MCP_LEVELS) expect(t(MCP_LEVEL_LABEL[l])).not.toBe(MCP_LEVEL_LABEL[l]);
    for (const k of ['staff.mcpPolicyTitle', 'staff.mcpPolicyIntro', 'staff.mcpPolicyHow', 'staff.mcpPolicyRule1', 'staff.mcpPolicyRule5', 'staff.mcpPolicyNoKey'] as const) {
      expect(t(k)).not.toBe(k);
    }
  });
});
