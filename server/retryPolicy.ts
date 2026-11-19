import type { RetryState } from '../shared/model';

// Política de retry da linha de produção (tarefas): dúvida ao gestor, revisão automática, ajuste guardado e aviso a quem pediu usam a
// mesma conta. Backoff em passos, com jitter, e o último passo se repete. `now` e `rand` entram por parâmetro para os testes.

/** Minutos até a próxima tentativa, pela ordem das falhas seguidas: 1, 2, 4, 8 e 15 (o último se repete). */
export const RETRY_STEPS_MIN = [1, 2, 4, 8, 15] as const;
/** Dúvida que não teve resposta (ou não chegou ao gestor) depois disso vai para você. O retry ao gestor continua. */
export const ESCALATE_AFTER_MS = 30 * 60_000;
/** Revisão automática que não começa, ou revisor que não dá o veredito, depois disso é sua. */
export const REVIEW_WAIT_MS = 30 * 60_000;
/** Quanto esperar para re-pedir o veredito ao revisor que respondeu sem ele (ou que não respondeu). */
export const REASK_AFTER_MS = 10 * 60_000;
/** Ajuste guardado que falhou tantas vezes deixa de ir sozinho e fica parado, para você. */
export const HELD_MAX_FAILS = 5;
/** Conversa de tarefa que espera a sua resposta a um pedido de permissão há mais que isso conta como parada, e o gestor que pediu é avisado (uma vez). Sem opção na Config. */
export const PERMISSION_STUCK_MS = 15 * 60_000;
/** Aviso retido ao gestor (tarefa dele ainda aberta) é solto depois disso. */
export const OUTCOME_HOLD_MAX_MS = 2 * 3_600_000;
/** Fim de turno com agent ou comando em segundo plano pendente não é entrega (`Task.backgroundWait`); se ele não terminar nesse prazo, a entrega segue como está, com uma nota no card. */
export const BACKGROUND_WAIT_MS = 60 * 60_000;

/** A falha não passa sozinha (ficha sumiu, sem endereço da API): repetir não adianta. Quem lança escolhe; o resto é transitório. */
export class PermanentError extends Error {}

/**
 * Vale tentar de novo? Limite de consumo, conversa fechando e envio que falhou, sim; `PermanentError`, não. O que o servidor valida
 * antes (sem API, limite de dúvidas) nem chega aqui: já vai para você.
 */
export const isTransient = (err: unknown): boolean => !(err instanceof PermanentError);

/** Quando tentar de novo depois de `attempts` falhas seguidas (1 = a primeira): o passo × 0,8 a 1,2, como ISO. */
export function nextRetry(attempts: number, now: Date, rand: () => number = Math.random): string {
  const step = RETRY_STEPS_MIN[Math.min(Math.max(attempts, 1), RETRY_STEPS_MIN.length) - 1]!;
  return new Date(now.getTime() + step * 60_000 * (0.8 + rand() * 0.4)).toISOString();
}

/** O estado depois de mais uma falha: conta uma tentativa, marca a próxima e guarda o erro (curto: o arquivo é do projeto). */
export function failedRetry(prev: RetryState | undefined, err: unknown, now: Date, rand?: () => number): RetryState {
  const attempts = (prev?.attempts ?? 0) + 1;
  const message = err instanceof Error ? err.message : String(err);
  return { attempts, nextAt: nextRetry(attempts, now, rand), firstAt: prev?.firstAt ?? now.toISOString(), lastError: message.slice(0, 200) };
}

/** A hora da próxima tentativa já chegou? Sem estado ou com data ilegível: não (quem decide é outra regra). */
export const retryDue = (s: Pick<RetryState, 'nextAt'> | undefined, at: number): boolean => !!s && Date.parse(s.nextAt) <= at;
