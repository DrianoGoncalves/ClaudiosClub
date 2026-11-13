import type { Personality } from '../../../shared/personality';
import type { MsgKey } from '../i18n';

/** Nome e descrição curta de cada estilo de comunicação, no seletor da ficha. */
export const PERSONALITY_TEXT = {
  caveman: { name: 'staff.personalityCaveman', hint: 'staff.personalityCavemanHint' },
  tiozao: { name: 'staff.personalityTiozao', hint: 'staff.personalityTiozaoHint' },
  professor: { name: 'staff.personalityProfessor', hint: 'staff.personalityProfessorHint' },
  desbocado: { name: 'staff.personalityDesbocado', hint: 'staff.personalityDesbocadoHint' },
  cansado: { name: 'staff.personalityCansado', hint: 'staff.personalityCansadoHint' },
  nerd: { name: 'staff.personalityNerd', hint: 'staff.personalityNerdHint' },
  executivo: { name: 'staff.personalityExecutivo', hint: 'staff.personalityExecutivoHint' },
  narrador: { name: 'staff.personalityNarrador', hint: 'staff.personalityNarradorHint' },
  mineiro: { name: 'staff.personalityMineiro', hint: 'staff.personalityMineiroHint' },
  yoda: { name: 'staff.personalityYoda', hint: 'staff.personalityYodaHint' },
} as const satisfies Record<Personality, { name: MsgKey; hint: MsgKey }>;

/**
 * O que o pedido leva do campo: só muda quando o valor difere do salvo (ausente mantém; `null` limpa).
 * Sem ficha salva (contratar, adotar), o padrão não manda nada.
 */
export function personalityToSend(value: '' | Personality, saved: Personality | null | undefined): { personality?: Personality | null } {
  const next = value || null;
  return next === (saved ?? null) ? {} : { personality: next };
}
