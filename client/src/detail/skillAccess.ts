import type { Skill } from '../../../shared/model';
import type { SkillDeleted, SkillDeleteResult, SkillHook, SkillRef, SkillSource } from '../api';

// Editar e excluir as skills da conta e do projeto. As regras que a tela decide sozinha ficam aqui (puras); a recusa de
// verdade é do servidor (link, hook apontando, sincronizada) e a mensagem dele vai para a tela como veio.

/** A skill que dá para mexer: da conta ou do projeto, não sincronizada. Sincronizada (ou projeto sem id): null. */
export function skillRef(skill: Skill, projectId: string | null): SkillRef | null {
  if (skill.readOnly || skill.scope === 'synced') return null;
  if (skill.scope === 'project') return projectId ? { scope: 'project', projectId, name: skill.name } : null;
  return { scope: 'user', projectId: null, name: skill.name };
}

/** Por que as ações ficam escondidas: link (com o destino) ou outro motivo (fora da pasta de skills do escopo, sincronizada). */
export type SkillLock = { kind: 'link'; target: string } | { kind: 'other' };

export function skillLock(source: SkillSource): SkillLock | null {
  if (source.editable) return null;
  return source.link !== null ? { kind: 'link', target: source.link } : { kind: 'other' };
}

/** O servidor não apagou nada: há hooks apontando para a skill e falta a confirmação. */
export function needsHooksConfirm(res: SkillDeleteResult): res is { needsConfirm: true; hooks: SkillHook[] } {
  return 'needsConfirm' in res;
}

/**
 * A confirmação não bate mais com os settings (alguém mexeu nos hooks desde o aviso). O servidor só manda a mensagem
 * (400 sem código), então é ela que se reconhece: "os hooks mudaram desde o aviso: confirme de novo".
 */
export function hooksChanged(message: string): boolean {
  return /hooks mudaram/i.test(message);
}

/** Uma linha por hook, para o aviso do canto: "Stop (C:/Users/a/.claude/settings.json)". */
export function hookLabel(h: SkillHook): string {
  return `${h.event} (${h.file})`;
}

/** O texto do aviso do canto depois de excluir: onde ficou a pasta e, se saíram hooks, quais e onde estão os backups. */
export type SkillDeletedNotice = { key: 'app.skillDeleted' | 'app.skillDeletedHooks'; hooks: string; backups: string };

export function deletedNotice(done: SkillDeleted): SkillDeletedNotice {
  const hooks = done.removedHooks ?? [];
  if (hooks.length === 0) return { key: 'app.skillDeleted', hooks: '', backups: '' };
  return { key: 'app.skillDeletedHooks', hooks: hooks.map(hookLabel).join('; '), backups: (done.settingsBackups ?? []).join('; ') };
}
