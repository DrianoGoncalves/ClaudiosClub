import { z } from 'zod';

// Despertador: no meio do trabalho o funcionário pede "me chame de novo nesta conversa daqui a N segundos com esta
// mensagem" (acompanhar um deploy em outro servidor, o CI do GitHub, um site). O agendador é o mesmo do "continue" do
// limite de uso (autoContinue.ts), numa segunda instância com arquivo próprio: aqui ficam só o pedido e os textos.

export const WAKE_MIN_SECONDS = 10;
export const WAKE_MAX_SECONDS = 86_400;
export const WAKE_TEXT_MAX = 2_000;

/** O pedido do funcionário: `POST .../chat/:s/wake` com `{ "seconds": 90, "text": "..." }`. */
export const WakeBody = z.object({
  seconds: z
    .number({ required_error: 'falta seconds', invalid_type_error: 'seconds tem de ser um número inteiro' })
    .int('seconds tem de ser um número inteiro')
    .min(WAKE_MIN_SECONDS, `seconds: no mínimo ${WAKE_MIN_SECONDS}`)
    .max(WAKE_MAX_SECONDS, `seconds: no máximo ${WAKE_MAX_SECONDS} (24 h)`),
  text: z
    .string({ required_error: 'falta text', invalid_type_error: 'text tem de ser um texto' })
    .trim()
    .min(1, 'text não pode ser vazio')
    .max(WAKE_TEXT_MAX, `text: no máximo ${WAKE_TEXT_MAX} caracteres`),
});
export type WakeInput = z.infer<typeof WakeBody>;

const two = (n: number) => String(n).padStart(2, '0');

/** "10:32", na hora desta máquina. */
export function wakeClock(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Textos que ficam no item do aviso (o cliente mostra os dele, em pt/en/es, a partir de `wake` e `wakeAt`; estes são
 * o reserva em português). A contagem regressiva nunca vai no texto: o cliente a faz.
 */
export const wakeNotice = {
  waiting: (at: number) => `Volta a olhar em ${wakeClock(at)}h.`,
  sent: (now: number) => `Voltou a olhar às ${wakeClock(now)}h.`,
  cancelled: 'Despertador cancelado.',
  failed: (error: string) => `Não deu para voltar a olhar na hora marcada (${error}). Mande uma mensagem quando quiser.`,
};
