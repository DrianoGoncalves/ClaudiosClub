import type { InboxItem } from '../../../shared/model';
import { t } from '../i18n';
import type { Tr } from './secretText';

// Aviso "o terminal do Codex não funciona nesta máquina" (política de senha do Windows), item `codexSandbox` da caixa (ver `InboxItem.codexSandbox` em shared/model.ts).
// O servidor manda o `summary` em pt-BR (fallback) e os campos de onde a frase sai aqui, no idioma da página. O Club só avisa: o comando é para o dono copiar e rodar como administrador.

/** O único comando que a tela oferece para copiar: o `command` do servidor só vale se for exatamente este (o dono o cola num terminal de administrador). */
export const SANDBOX_FIX = 'net accounts /minpwage:0';

export interface SandboxAlert {
  /** Duração mínima da senha lida, em dias; null = a leitura não deu. */
  days: number | null;
  /** O comando a copiar; null = o comando não resolve (a duração já é 0, a causa é outra regra de senha). */
  command: string | null;
}

/** O aviso do item, ou null se o item não é um (ou traz uma causa ou um comando que a tela não conhece: aí vale o `summary` do servidor, sem botão de copiar). */
export function sandboxOf(item: Pick<InboxItem, 'codexSandbox'>): SandboxAlert | null {
  const s = item.codexSandbox;
  if (!s || s.cause !== 'password-policy' || s.command !== SANDBOX_FIX) return null;
  const days = typeof s.minPasswordAgeDays === 'number' && Number.isInteger(s.minPasswordAgeDays) && s.minPasswordAgeDays >= 0 ? s.minPasswordAgeDays : null;
  return { days, command: days === 0 ? null : s.command };
}

/** A frase do aviso: o que não funciona e a causa, conforme o que o servidor leu da política. */
export function sandboxText(alert: SandboxAlert, tr: Tr = t): string {
  if (alert.days === null) return tr('inbox.sandbox.ageUnknown');
  if (alert.days === 0) return tr('inbox.sandbox.ageZero');
  return tr(alert.days === 1 ? 'inbox.sandbox.ageOne' : 'inbox.sandbox.ageOther', { days: alert.days });
}
