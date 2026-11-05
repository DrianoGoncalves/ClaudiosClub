import { describe, expect, it } from 'vitest';
import { staffTools } from '../client/src/board/nodes';
import type { StaffProfile } from '../shared/model';

const profile = (over: Partial<StaffProfile> = {}) =>
  ({ agents: [], skills: [], mcps: [], servers: [], playbook: null, worktree: false, browser: false, canHire: false, ...over }) as StaffProfile;

describe('ícones de ferramentas no cartão do funcionário', () => {
  it('sem nada na ficha, sem ícone (lista vazia de MCPs = nenhum)', () => {
    expect(staffTools(profile())).toEqual([]);
  });

  it('MCPs: null = todos os configurados; lista = os nomes', () => {
    expect(staffTools(profile({ mcps: null }))).toEqual([
      { tool: 'mcps', label: 'MCPs: todos os configurados (inclusive os conectores da conta)' },
    ]);
    expect(staffTools(profile({ mcps: ['github', 'notion'] }))).toEqual([{ tool: 'mcps', label: 'MCPs ligados: github, notion' }]);
  });

  it('agents somam os do roteiro, sem repetir, como a ficha mostra', () => {
    const [agents] = staffTools(profile({ playbook: 'review-gate', agents: ['revisor', 'designer'] }));
    expect(agents).toEqual({ tool: 'agents', label: 'Agents indicados: executor, revisor, designer' });
  });

  it('servidores: ícone só com conexão na ficha, e o tooltip só com os nomes', () => {
    expect(staffTools(profile({ servers: ['producao', 'ftp-site'] }))).toEqual([
      { tool: 'servers', label: 'Servidores (SSH e FTP): producao, ftp-site' },
    ]);
  });

  it('mantém a ordem: worktree, Chrome, servidores, contratar, agents, skills, MCPs', () => {
    const all = profile({ worktree: true, browser: true, servers: ['vps'], canHire: true, agents: ['executor'], skills: ['vps'], mcps: null });
    expect(staffTools(all).map((x) => x.tool)).toEqual(['worktree', 'browser', 'servers', 'canHire', 'agents', 'skills', 'mcps']);
    expect(staffTools(all).find((x) => x.tool === 'skills')?.label).toBe('Skills indicadas: vps');
  });
});
