import type { InboxItem } from '../../../shared/model';
import { t } from '../i18n';
import type { Tr } from './secretText';
import type { Kinded } from './taskAlerts';

// Item "ação barrada" da caixa "precisa de mim" (kind `denied`): uma regra de permissão negou uma ferramenta numa conversa de tarefa. O servidor manda a
// estrutura (`denied`) e o `summary`/`text` em pt-BR; a frase e o atalho saem daqui, no idioma da página. O contrato é `InboxItem.denied` (shared/model.ts).

type Denied = NonNullable<InboxItem['denied']>;

/** O item só precisa dizer o kind (nos testes, nem isso): sem ele, não é ação barrada. */
export function deniedOf(item: Kinded): Denied | null {
  const d = (item as Pick<InboxItem, 'denied'>).denied;
  return item.kind === 'denied' && d ? d : null;
}

/** O que barrou, na frase. A camada desconhecida (motor ou servidor mais novo que a tela) cai no texto do servidor, em pt-BR. */
function whatText(d: Denied, tr: Tr): string {
  const tool = d.tool;
  switch (d.layer) {
    case 'classifier':
      return tr('inbox.denied.classifier', { tool, reason: d.reason ?? tr('inbox.denied.noReason') });
    case 'classifierError':
      return tr('inbox.denied.classifierError', { tool });
    case 'club':
      return tr(d.hint === 'servers' ? 'inbox.denied.clubServers' : 'inbox.denied.clubFile', { tool });
    case 'safety':
      return tr('inbox.denied.safety', { tool, reason: d.reason ?? tr('inbox.denied.safetyDefault') });
    case 'settings':
      return tr('inbox.denied.settings', { tool });
    case 'sandbox':
      // Só leitura (plano ou aprovação manual) = `autonomy`; na sandbox de escrita a recusa é de algo fora da pasta de trabalho ou da rede liberada.
      return tr(d.hint === 'autonomy' ? 'inbox.denied.sandboxRead' : 'inbox.denied.sandboxOut', { tool });
    case 'other':
      return d.reason ? tr('inbox.denied.otherWhy', { tool, reason: d.reason }) : tr('inbox.denied.other', { tool });
    default:
      return d.text;
  }
}

/** “Tarefa”: o que foi barrado e por quem, no idioma atual (mais quantas negações vieram no mesmo turno); sem o `denied` (servidor antigo), o `summary`. */
export function deniedText(item: Kinded & Pick<InboxItem, 'summary'>, tr: Tr = t): string {
  const d = deniedOf(item);
  if (!d) return item.summary;
  const more = d.count > 1 ? ` ${tr('inbox.denied.more', { n: d.count - 1 })}` : '';
  return `${tr('inbox.denied.sentence', { task: d.taskTitle, what: whatText(d, tr) })}${more}`;
}

/** Onde o atalho leva: a ficha do funcionário (aba Projeto: autonomia e servidores) ou a conversa, onde está o botão do aviso. */
export type DeniedTarget = 'sheet' | 'chat';

export interface DeniedAction {
  to: DeniedTarget;
  label: string;
  title: string;
}

/**
 * O atalho de destrave conforme a dica do servidor (`DenialInfo.hint`): `autonomy` e `servers` levam à ficha, onde se muda (conversa sem ficha: sem atalho, o
 * clique no item já abre a conversa); `retry` abre a conversa, onde está o botão "Pedir para tentar de novo". Sem dica, ou dica que a tela não conhece, não há atalho.
 */
export function deniedAction(item: Kinded & Pick<InboxItem, 'staffId'>, tr: Tr = t): DeniedAction | null {
  const d = deniedOf(item);
  if (!d) return null;
  if (d.hint === 'retry') return { to: 'chat', label: tr('inbox.denied.act.retry'), title: tr('inbox.denied.act.retryTitle') };
  if (!item.staffId) return null;
  if (d.hint === 'autonomy') return { to: 'sheet', label: tr('inbox.denied.act.autonomy'), title: tr('inbox.denied.act.autonomyTitle') };
  if (d.hint === 'servers') return { to: 'sheet', label: tr('inbox.denied.act.servers'), title: tr('inbox.denied.act.serversTitle') };
  return null;
}
