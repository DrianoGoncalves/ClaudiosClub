import { CLUB } from './config.js';

// Regras puras dos avisos (sem chrome.*): quais itens do inbox são novos, o texto do selo e o link que a notificação abre.
// Os tipos são os de InboxKind (shared/model.ts), os mesmos que a aba do Club avisa (client/src/inbox/useInbox.ts).

/** A mensagem (em _locales) que completa "Fulano …" em cada tipo de aviso. */
export const KIND_MESSAGE = {
  plan: 'kindPlan',
  permission: 'kindPermission',
  secret: 'kindSecret',
  waiting: 'kindWaiting',
  error: 'kindError',
  routine: 'kindRoutine',
  orphan: 'kindOrphan',
  usage: 'kindUsage',
  blocked: 'kindBlocked',
  notStarted: 'kindNotStarted',
};

/** Mais que isso de uma vez vira um aviso só (uma fila de notificações empilhadas esconde o que importa). */
export const MAX_SINGLE = 5;

/** Notificações que a extensão guarda para o clique (as mais recentes). */
export const MAX_TARGETS = 50;

/**
 * O que avisar nesta leitura. Na primeira (`seeded` falso) nada é novo: avisar de tudo ao parear seria só barulho, como a aba do Club
 * faz ao abrir. Depois, novo é o id que não estava na leitura anterior; quem sumiu e voltou avisa de novo.
 * @param {{ id: string }[]} items
 * @param {string[]} seen
 * @param {boolean} seeded
 * @returns {{ fresh: any[], seen: string[] }}
 */
export function planNotifications(items, seen, seeded) {
  const next = items.map((i) => i.id);
  if (!seeded) return { fresh: [], seen: next };
  const known = new Set(seen);
  return { fresh: items.filter((i) => !known.has(i.id)), seen: next };
}

/** O número do selo do ícone: vazio sem avisos, "99+" a partir de 100. */
export const badgeText = (count) => (count <= 0 ? '' : count > 99 ? '99+' : String(count));

/** Quem é o aviso: o funcionário e, sem ficha, o próprio projeto (igual a inboxWho da aba). */
export const whoOf = (item) => item.name || item.projectName;

const SAFE = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * O link que abre o Club na tela do aviso: `#abrir?kind=…&projeto=…&funcionario=…`, ou `#abrir?tela=tarefas&projeto=…` (o quadro de
 * tarefas do projeto). O Club lê (client/src/inbox/deepLink.ts) e confere o que vem; o que não for um id simples fica de fora.
 * @param {{ kind?: string, view?: 'tasks', projectId?: string, staffId?: string | null }} target
 */
export function clubLink(target) {
  const q = new URLSearchParams();
  if (target.kind) q.set('kind', target.kind);
  // Tarefa esperando outra, ou esquecida em "a fazer": o aviso é do quadro de tarefas (o id da tarefa o Club não manda à extensão).
  if (target.view === 'tasks' || target.kind === 'blocked' || target.kind === 'notStarted') q.set('tela', 'tarefas');
  if (target.projectId && SAFE.test(target.projectId)) q.set('projeto', target.projectId);
  if (target.staffId && SAFE.test(target.staffId)) q.set('funcionario', target.staffId);
  return `${CLUB}/#abrir?${q}`;
}

/**
 * Guarda o destino de uma notificação e solta as mais antigas.
 * @param {Record<string, any>} targets
 * @param {string} id
 * @param {{ kind: string, projectId: string, staffId: string | null }} target
 */
export function withTarget(targets, id, target) {
  const next = { ...targets };
  delete next[id];
  next[id] = target;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TARGETS))) delete next[key];
  return next;
}
