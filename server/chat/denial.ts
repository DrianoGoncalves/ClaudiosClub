import type { DenialInfo } from '../../shared/model';

// Texto do resultado de uma ferramenta negada (is_error): diz quem barrou e, quando dá, o motivo.
// Os textos vêm do Claude Code; se mudarem, cai em `other` (aviso genérico), sem quebrar nada.

/** Classifica o texto da negação. Puro: a tela e o servidor leem a mesma saída. */
export function classifyDenial(text: string): DenialInfo {
  const t = text.replace(/\s+/g, ' ').trim();
  // Falha passageira do classificador (sem veredito): não é um "não" dele, vale tentar de novo.
  if (/auto mode classifier gave no verdict/i.test(t)) return { layer: 'classifierError', hint: 'retry' };
  if (/auto mode classifier/i.test(t) && /denied|judged/i.test(t)) {
    const reason = /Reason:\s*\[([^\]]+)\]/.exec(t)?.[1]?.trim();
    return { layer: 'classifier', ...(reason && { reason }), hint: 'autonomy' };
  }
  // Regra do Club (--disallowedTools): o comando vai no texto.
  const club = /Permission to use \S+ with command (.+?) has been denied/i.exec(t);
  if (club) {
    const cmd = club[1]!.trim();
    return { layer: 'club', hint: /^(ssh|scp|sftp|rsync)(\s|$)/i.test(cmd) ? 'servers' : null };
  }
  // Regra de leitura/edição (deny do Club ou do settings): o Claude Code não diz qual.
  if (/denied by your permission settings/i.test(t)) return { layer: 'settings', hint: null };
  const reason = shortReason(t);
  // Checagem embutida do Claude Code (caminho protegido): costuma ser o comando lido errado.
  if (/is blocked\.? This path is protected|protected from removal/i.test(t)) return { layer: 'safety', ...(reason && { reason }), hint: null };
  return { layer: 'other', ...(reason && { reason }), hint: null };
}

/** O texto em uma linha, até 120 caracteres: basta para saber o motivo sem despejar o resultado inteiro. */
function shortReason(t: string): string | undefined {
  const s = t.replace(/<\/?tool_use_error>/g, '').trim().replace(/[.\s]+$/, '');
  if (!s) return undefined;
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** Texto do aviso no chat (pt-BR, curto). `tool` é o nome da ferramenta negada. */
export function denialNotice(tool: string, d: DenialInfo): string {
  switch (d.layer) {
    case 'classifier':
      return `\`${tool}\` barrado pelo classificador do Claude Code (modo Autônomo): ${d.reason ?? 'sem motivo informado'}.`;
    case 'classifierError':
      return `\`${tool}\`: o classificador do Claude Code não respondeu; peça para tentar de novo.`;
    case 'club':
      return d.hint === 'servers'
        ? `\`${tool}\` bloqueado pelo Club: a ficha não tem conexão SSH.`
        : `\`${tool}\` bloqueado pelo Club: arquivo protegido (segredo ou chave).`;
    case 'safety':
      return `\`${tool}\` barrado pela checagem de segurança do Claude Code: ${d.reason ?? 'caminho protegido'}. Costuma ser o comando lido errado; o agente normalmente refaz.`;
    case 'settings':
      return `\`${tool}\` bloqueado: arquivo ou pasta negado nas regras de permissão (Club ou settings do Claude Code).`;
    default:
      return d.reason ? `${tool}: permissão negada (${d.reason})` : `${tool}: permissão negada`;
  }
}
