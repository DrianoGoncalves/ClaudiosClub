import type { InboxItem, SecretHint, SecretReason, SecretVerdict } from '../../../shared/model';
import { t, type MsgKey } from '../i18n';
import type { Tr } from './secretText';

// O palpite do servidor sobre o segredo (real ou falso positivo), a dica mascarada e o "por quê?" do aviso de segredo, no idioma da página.
// Tudo sai do `secret` do item que já veio: nenhuma chamada nova. O valor do segredo nunca chega aqui; só a dica (início/fim, até 4 caracteres, e o tamanho).

/** O texto e o símbolo do selo de cada estado. O símbolo é só reforço: o estado está escrito, não depende da cor. */
const VERDICTS: Record<SecretVerdict, { label: MsgKey; glyph: string }> = {
  example: { label: 'chat.secretVerdict.example', glyph: '●' },
  local: { label: 'chat.secretVerdict.local', glyph: '◆' },
  exposed: { label: 'chat.secretVerdict.exposed', glyph: '▲' },
  unknown: { label: 'chat.secretVerdict.unknown', glyph: '?' },
};

/** O motivo de cada código do servidor. Código novo no servidor precisa de chave aqui (sem ela, o "por quê?" some e o selo fica). */
const REASONS: Record<SecretReason, MsgKey> = {
  'fake-token': 'chat.secretReason.fakeToken',
  placeholder: 'chat.secretReason.placeholder',
  'default-password': 'chat.secretReason.defaultPassword',
  'example-file': 'chat.secretReason.exampleFile',
  'test-file': 'chat.secretReason.testFile',
  'example-host': 'chat.secretReason.exampleHost',
  'local-host': 'chat.secretReason.localHost',
  'other-host': 'chat.secretReason.otherHost',
  'provider-format': 'chat.secretReason.providerFormat',
  'private-key': 'chat.secretReason.privateKey',
  'strong-value': 'chat.secretReason.strongValue',
  'no-context': 'chat.secretReason.noContext',
};

const has = (map: object, key: unknown): boolean => typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key);

/** O que a tela mostra do palpite: o selo, a dica (se houver) e o motivo (se o código for conhecido). */
export interface SecretVerdictView {
  verdict: SecretVerdict;
  label: string;
  glyph: string;
  hint: SecretHintView | null;
  /** A frase do "por quê?"; null quando o servidor não mandou o motivo (ou mandou um código que esta tela não conhece). */
  why: string | null;
}

/**
 * O palpite do aviso, ou null quando não há o que mostrar: aviso sem `verdict` (servidor antigo, chave do .mcp.json) ou com um valor que esta tela não conhece
 * continua aparecendo como antes, sem selo.
 */
export function secretVerdictOf(item: Pick<InboxItem, 'secret'>, tr: Tr = t): SecretVerdictView | null {
  const s = item.secret;
  if (!s || !has(VERDICTS, s.verdict)) return null;
  const verdict = s.verdict as SecretVerdict;
  const { label, glyph } = VERDICTS[verdict];
  return {
    verdict,
    label: tr(label),
    glyph,
    hint: secretHintOf(s.hint, tr),
    why: has(REASONS, s.reason) ? tr(REASONS[s.reason as SecretReason]) : null,
  };
}

/** A dica já em texto: a parte mascarada (início e/ou fim do valor) e a nota (tamanho, ou "senha padrão conhecida"). */
export interface SecretHintView {
  masked: string | null;
  note: string | null;
}

/** Sem caracteres de controle nem invisíveis (um deles poderia esconder ou inverter o que a dica mostra), em pontos de código (a senha pode ter acento). */
const visible = (value: unknown): string[] => (typeof value === 'string' ? Array.from(value.replace(/[\p{Cc}\p{Cf}\s]/gu, '')) : []);

/**
 * A dica mascarada em texto. O servidor já manda no máximo 4 caracteres do valor; aqui é a segunda trava (o prefixo público é cortado em 24 e o fim em 4),
 * porque o que passar do contrato não deve chegar à tela. Sem nada para mostrar (chave privada, dica vazia) = null.
 */
export function secretHintOf(hint: SecretHint | undefined, tr: Tr = t): SecretHintView | null {
  if (!hint || typeof hint !== 'object') return null;
  if (hint.isDefault === true) return { masked: null, note: tr('chat.secretHint.default') };
  const prefix = visible(hint.prefix).slice(0, 24).join('');
  const tail = visible(hint.tail).slice(-4).join('');
  const masked = prefix || tail ? `${prefix}…${tail}` : null;
  const length = typeof hint.length === 'number' && Number.isInteger(hint.length) && hint.length > 0 && hint.length <= 100_000 ? hint.length : null;
  const note = length === null ? null : tr('chat.secretHint.length', { n: length });
  return masked || note ? { masked, note } : null;
}

/** A dica numa linha só (para o `aria-label` e para teste). */
export const secretHintText = (hint: SecretHintView): string => [hint.masked, hint.note].filter(Boolean).join(', ');
