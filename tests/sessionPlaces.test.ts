import { describe, expect, it } from 'vitest';
import { sessionPlaces } from '../server/sessionPlaces';
import type { LiveSession, Project, StaffProfile } from '../shared/model';

const project = (id: string, p: string, extra: Partial<Project> = {}) => ({ id, path: p, name: id, exists: true, worktreeOf: null, ...extra }) as Project;
const live = (cwd: string) => ({ cwd, name: 'viva' }) as LiveSession;
const bia = { id: 'bia', name: 'Bia', projectId: 'loja', sessions: [{ id: 's-bia', startedAt: '2026-10-26T10:00:00Z' }] } as StaffProfile;

// `projects` é a lista do quadro; `offBoard` são os ids do que o Claude Code conhece e ficou fora dele.
const board = [project('loja', '/w/loja'), project('loja-wt', '/w/loja/.claude/worktrees/myco-bia', { worktreeOf: '/w/loja' })];

describe('caixa "precisa de mim" e avisos de turno', () => {
  it('sessão de projeto que o Claude Code conhece e está fora do quadro fica escondida (worktree dele também)', () => {
    const off = new Set(['-w-fora', '-w-fora--claude-worktrees-x']);
    const { where, hidden } = sessionPlaces(board, [bia], new Set(), off);
    expect(hidden(where('s1', live('/w/fora')))).toBe(true);
    expect(hidden(where('s1b', live('/w/fora/.claude/worktrees/x')))).toBe(true);
    // Sem a lista dos de fora, nada some.
    expect(sessionPlaces(board, [bia], new Set()).hidden(where('s1', live('/w/fora')))).toBe(false);
  });

  it('sessão de projeto desconhecido continua aparecendo (item legítimo da caixa não some)', () => {
    const { where, hidden } = sessionPlaces(board, [bia], new Set(), new Set(['-w-fora']));
    expect(hidden(where('s2', live('/w/loja/subpasta')))).toBe(false);
    expect(hidden(where('s3'))).toBe(false); // sem pasta nem dono: processo que já saiu
    expect(hidden(where('s5', live('/w/outro-lugar')))).toBe(false);
  });

  it('sessão de projeto do quadro aparece, também a de funcionário e a da worktree dele', () => {
    const { where, hidden } = sessionPlaces(board, [bia], new Set());
    expect(where('s1', live('/w/loja'))).toMatchObject({ projectId: 'loja', projectName: 'loja' });
    expect(hidden(where('s1', live('/w/loja')))).toBe(false);
    expect(hidden(where('s-bia', live('/w/loja/.claude/worktrees/myco-bia')))).toBe(false);
    expect(where('s-bia')).toMatchObject({ projectId: 'loja', staffId: 'bia', name: 'Bia' });
    // A worktree do Claudio’s Club soma no projeto principal.
    expect(where('s4', live('/w/loja/.claude/worktrees/myco-bia')).projectId).toBe('loja');
  });

  it('arquivado continua escondido', () => {
    expect(sessionPlaces(board, [bia], new Set(['loja'])).hidden(sessionPlaces(board, [bia], new Set()).where('s1', live('/w/loja')))).toBe(true);
    const { where, hidden } = sessionPlaces(board, [bia], new Set(['staff:bia']));
    expect(hidden(where('s-bia'))).toBe(true);
  });
});
