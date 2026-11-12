import type { InboxItem, SecretKind, SecretSource } from '../../../shared/model';
import { t, type MsgKey } from '../i18n';

// Frase do aviso de segredo na caixa "precisa de mim", no idioma da página. O servidor manda o `summary`
// em pt-BR (fallback) e o `secret` (tipo, contexto estável, origem). Aqui a frase sai do `secret`.
// O valor do segredo nunca chega ao cliente: só tipo, provedor, comando, nome da variável e host.

export type Tr = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** Provedor da chave (detail do servidor) → texto. Um provedor novo no servidor precisa de chave aqui. */
const API_KEY: Record<string, MsgKey> = {
  anthropic: 'inbox.secret.api.anthropic',
  openai: 'inbox.secret.api.openai',
  github: 'inbox.secret.api.github',
  aws: 'inbox.secret.api.aws',
  slack: 'inbox.secret.api.slack',
  stripe: 'inbox.secret.api.stripe',
  google: 'inbox.secret.api.google',
};

const WHERE: Record<SecretSource | 'chat', MsgKey> = {
  owner: 'inbox.secret.where.owner',
  'staff-reply': 'inbox.secret.where.staffReply',
  'tool-input': 'inbox.secret.where.toolInput',
  'tool-result': 'inbox.secret.where.toolResult',
  chat: 'inbox.secret.where.chat',
};

function labelOf(kind: SecretKind, detail: string | undefined, tr: Tr): string {
  switch (kind) {
    case 'private-key':
      return tr('inbox.secret.privateKey');
    case 'api-key': {
      const key = detail ? API_KEY[detail] : undefined;
      return key ? tr(key) : tr('inbox.secret.apiKey');
    }
    case 'password-cli':
      return detail ? tr('inbox.secret.cliDb', { command: detail }) : tr('inbox.secret.cliFlag');
    case 'password-env':
      return detail ? tr('inbox.secret.envVar', { name: detail }) : tr('inbox.secret.envAny');
    case 'password-url':
      return detail ? tr('inbox.secret.url', { host: detail }) : tr('inbox.secret.urlAny');
  }
}

/** Texto do aviso: com `secret`, a frase no idioma atual; sem ele (servidor antigo, item sem tipo), o `summary`. */
export function secretText(item: Pick<InboxItem, 'summary' | 'secret'>, tr: Tr = t): string {
  const s = item.secret;
  if (!s) return item.summary;
  const label = labelOf(s.kind, s.detail, tr);
  return tr('inbox.secret.sentence', { label: `${label.charAt(0).toUpperCase()}${label.slice(1)}`, where: tr(WHERE[s.source ?? 'chat']) });
}
