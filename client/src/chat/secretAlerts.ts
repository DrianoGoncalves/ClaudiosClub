import type { InboxItem } from '../../../shared/model';

/** Os itens de um tipo da caixa que são desta conversa, sem repetir id. Item sem conversa (`sessionId` vazio) não tem onde virar balão. */
function noticesOf(kind: InboxItem['kind'], inbox: readonly InboxItem[] | undefined, sessionId: string | null): InboxItem[] {
  if (!inbox || !sessionId) return [];
  const byId = new Map<string, InboxItem>();
  for (const item of inbox) if (item.kind === kind && item.sessionId === sessionId && !byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

/**
 * Os avisos de segredo da caixa "precisa de mim" que nasceram nesta conversa: viram balão no chat.
 * É o mesmo item da caixa (mesmo id, mesma frase, mesmo "ignorar"), então um aviso dá um balão só e some dos dois lados juntos.
 * Aviso sem conversa (chave no .mcp.json do projeto) não tem onde virar balão e fica só na caixa.
 */
export function secretNoticesFor(inbox: readonly InboxItem[] | undefined, sessionId: string | null): InboxItem[] {
  return noticesOf('secret', inbox, sessionId);
}

/**
 * Os avisos de erro da caixa (a conversa parou com erro, ou o turno parou no teto) desta conversa: o mesmo balão do segredo, sem o "ignorar"
 * (o servidor não tem como dispensar erro: ele some quando você manda mensagem nova). `chatTexts` são os avisos que a conversa já tem no
 * próprio fluxo: o teto de ferramentas e de minutos já escreve o mesmo texto lá, e repeti-lo aqui seria balão em dobro.
 */
export function errorNoticesFor(inbox: readonly InboxItem[] | undefined, sessionId: string | null, chatTexts: readonly string[] = []): InboxItem[] {
  return noticesOf('error', inbox, sessionId).filter((item) => !chatTexts.includes(item.summary));
}

/** O arquivo do segredo para a tela: o caminho (relativo ao projeto, com "/") e se a rota de arquivos o recusa (sem botão). */
export interface SecretFile {
  path: string;
  blocked: boolean;
}

/**
 * Só o caminho que o servidor mandou e que fica dentro do projeto: relativo, sem `..`, `.`, segmento vazio, `\`, `~` ou unidade (`C:`).
 * O servidor já valida; aqui é a segunda trava, porque o caminho vira clique que abre arquivo. Sem campo (servidor antigo, aviso sem arquivo) = null.
 */
export function secretFileOf(item: Pick<InboxItem, 'secret'>): SecretFile | null {
  const file = item.secret?.file;
  if (typeof file !== 'string' || !file || file.length > 500) return null;
  if (/[\\\0]|^[~/]|^[a-z]:/i.test(file)) return null;
  if (file.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return { path: file, blocked: item.secret?.fileBlocked === true };
}
