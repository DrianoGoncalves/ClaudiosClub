import type { StaffProfile } from './model';

/**
 * O que é da pessoa: vale igual em todas as fichas com o mesmo `personId` (cópias entre projetos). Editar uma ficha
 * leva estes campos às outras (StaffService.update e restore, em server/staff/service.ts).
 */
export const PERSON_FIELDS = ['name', 'role', 'mission', 'doneWhen', 'rules', 'model', 'effort', 'playbook', 'personality'] as const satisfies readonly (keyof StaffProfile)[];

/** O retrato também é da pessoa, mas vem como arquivo (`portraitDataUrl` no pedido), então fica à parte. */
export const PERSON_PORTRAIT = 'portraitDataUrl';

/** O que é de cada projeto: a mesma pessoa pode ter valores diferentes aqui, e a edição de uma ficha não os leva às cópias. */
export const ALLOCATION_FIELDS = [
  'reportsTo',
  'firstTask',
  'autonomy',
  'agents',
  'skills',
  'mcps',
  'mcpWrite',
  'knowledge',
  'canHire',
  'worktree',
  'servers',
  'sshWrite',
  'browser',
  'engine',
  'fallback',
  'mcpPolicy',
] as const satisfies readonly (keyof StaffProfile)[];

/** Só do pedido: não são campos da ficha (abrir conversa, adotar sessão, confirmar consumo). */
export const REQUEST_FIELDS = ['launch', 'adoptSessionId', 'force', 'roleId'] as const;
