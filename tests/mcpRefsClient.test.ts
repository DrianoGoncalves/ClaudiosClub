import { describe, expect, it } from 'vitest';
import { mcpName, mcpsToSave, normalizeMcps, parseMcpRef, toggleMcp } from '../client/src/staff/mcpRefs';

const list = [
  { ref: 'global:n8n', scope: 'global' as const, name: 'n8n' },
  { ref: 'project:db', scope: 'project' as const, name: 'db' },
  { ref: 'global:db', scope: 'global' as const, name: 'db' },
];

describe('MCPs da ficha com escopo (cliente)', () => {
  it('lê a ref e o nome antigo', () => {
    expect(parseMcpRef('global:n8n')).toEqual({ scope: 'global', name: 'n8n' });
    expect(parseMcpRef('n8n')).toBeNull();
    expect(mcpName('project:db')).toBe('db');
    expect(mcpName('db')).toBe('db');
  });

  it('nome antigo vira Projeto se existe lá, senão Global; ref e repetido ficam', () => {
    expect(normalizeMcps(['db', 'n8n', 'x', 'global:db', 'n8n'], list)).toEqual(['project:db', 'global:n8n', 'global:x', 'global:db']);
  });

  it('marcar um tira o de mesmo nome no outro escopo', () => {
    const on = toggleMcp(new Set(['project:db']), 'global:db');
    expect([...on]).toEqual(['global:db']);
    expect([...toggleMcp(on, 'global:db')]).toEqual([]);
    expect([...toggleMcp(on, 'global:n8n')].sort()).toEqual(['global:db', 'global:n8n']);
  });

  it('todos marcados grava null; senão, as refs (também no Codex)', () => {
    const two = list.slice(0, 2);
    expect(mcpsToSave(two, new Set(['global:n8n', 'project:db']))).toBeNull();
    expect(mcpsToSave(two, new Set(['global:n8n']))).toEqual(['global:n8n']);
    expect(mcpsToSave([], new Set())).toEqual([]);
  });
});
