/**
 * Texto de ajuda da opção "worktree própria" na ficha: o efeito de ligar ou não, junto da opção do projeto "um escritor por vez"
 * (`singleWriter` em `.myco/board.json`). `singleWriter` null = ainda lendo, falhou ou servidor sem a rota: não afirma nada sobre a espera.
 */
export type WorktreeWaitKey = 'staff.worktreeWaitOwn' | 'staff.worktreeWaitQueue' | 'staff.worktreeWaitShared' | 'staff.worktreeWaitDirect';

export function worktreeWaitKey(worktree: boolean, singleWriter: boolean | null): WorktreeWaitKey {
  if (worktree) return 'staff.worktreeWaitOwn';
  if (singleWriter === null) return 'staff.worktreeWaitDirect';
  return singleWriter ? 'staff.worktreeWaitQueue' : 'staff.worktreeWaitShared';
}
