import type { InboxItem, InboxKind } from '../../../shared/model';

/**
 * Mapa único tipo de alerta → tom de cor, valendo na caixa de entrada e nos cartões do quadro.
 * A cor de cada tom (tokens `--tone-*` em styles.css, bloco "Tons de alerta") mora só lá; aqui fica só QUAL tom cada alerta usa.
 *   error  vermelho  falhou / vazou / negado
 *   action amarelo   espera VOCÊ (responder, aprovar, decidir)
 *   wait   laranja   fila que não anda (dependência, recurso, não começou)
 *   done   verde     resolvido, aprovado, no ar
 *   info   azul      informativo (rotina, uso, recomendação)
 */
export type AlertTone = 'error' | 'action' | 'wait' | 'done' | 'info';

/** Alertas da caixa de entrada (um por tipo de aviso). */
export const INBOX_TONE: Record<InboxKind, AlertTone> = {
  error: 'error',
  orphan: 'error',
  secret: 'error',
  denied: 'error',
  plan: 'action',
  permission: 'action',
  waiting: 'action',
  question: 'action',
  stuck: 'action',
  followUp: 'action',
  blocked: 'wait',
  notStarted: 'wait',
  routine: 'info',
  usage: 'info',
};

/**
 * O tom do item da caixa: o do tipo (`INBOX_TONE`), salvo o aviso de commit parcial com decisão do dono (`autoCommit.state` 'ready': nenhum card aberto toca as sobras, refazer o commit ou ignorar),
 * que é amarelo. O `failed` segue vermelho (kind 'error').
 */
export const inboxTone = (item: Pick<InboxItem, 'kind' | 'autoCommit'>): AlertTone => (item.kind === 'error' && item.autoCommit?.state === 'ready' ? 'action' : INBOX_TONE[item.kind]);

/** Selos do cartão do quadro que não são um aviso da caixa. */
export const CARD_TONE = {
  /** Espera você: plano, dúvida do gestor, follow-up, revisão do dono, commit sem ack (`.is-waiting`). */
  owner: 'action',
  /** Fila de A fazer que não anda (`.task-wait`). */
  queue: 'wait',
  approved: 'done',
  resolved: 'done',
  rejected: 'error',
  recommended: 'info',
} as const satisfies Record<string, AlertTone>;

/** Classe CSS do tom (`tone-error`…): define `--tone` e `--tone-ink`, e é o que o CSS lê para pintar o selo. */
export const toneClass = (tone: AlertTone): string => `tone-${tone}`;

/** Classe do tom de um selo do cartão do quadro (`CARD_TONE`). */
export const cardTone = (key: keyof typeof CARD_TONE): string => toneClass(CARD_TONE[key]);
