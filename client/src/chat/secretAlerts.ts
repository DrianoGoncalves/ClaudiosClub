import type { Engine, InboxItem } from '../../../shared/model';
import { sandboxOf } from '../inbox/codexSandbox';
import { pendingOf } from '../inbox/resolved';

/** Os itens de um tipo da caixa que são desta conversa, sem repetir id. Item sem conversa (`sessionId` vazio) não tem onde virar balão. */
function noticesOf(kind: InboxItem['kind'], inbox: readonly InboxItem[] | undefined, sessionId: string | null): InboxItem[] {
  if (!inbox || !sessionId) return [];
  const byId = new Map<string, InboxItem>();
  for (const item of pendingOf(inbox)) if (item.kind === kind && item.sessionId === sessionId && !byId.has(item.id)) byId.set(item.id, item);
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
 * Os avisos de erro da caixa (a conversa parou com erro, ou o turno parou no teto) desta conversa: o mesmo balão do segredo, com o mesmo "ignorar"
 * (o servidor guarda o carimbo do erro dispensado: outro erro da conversa volta a avisar). `chatTexts` são os avisos que a conversa já tem no
 * próprio fluxo: o teto de ferramentas e de minutos já escreve o mesmo texto lá, e repeti-lo aqui seria balão em dobro.
 */
export function errorNoticesFor(inbox: readonly InboxItem[] | undefined, sessionId: string | null, chatTexts: readonly string[] = []): InboxItem[] {
  return noticesOf('error', inbox, sessionId).filter((item) => !chatTexts.includes(item.summary));
}

/**
 * O aviso do sandbox do Codex (política de senha do Windows) como balão na conversa de quem roda no Codex: o terminal dele não funciona enquanto o item da caixa estiver vivo,
 * então vale para toda conversa do Codex, não só a que o disparou (o item é da máquina, sem conversa). Conversa do Claude não vê (o terminal dela não depende disso).
 * O balão é o mesmo item da caixa (mesmo id, mesmo "ignorar"): some dos dois lados juntos.
 */
export function sandboxNoticesFor(inbox: readonly InboxItem[] | undefined, engine: Engine): InboxItem[] {
  if (!inbox || engine !== 'codex') return [];
  return pendingOf(inbox).filter((item) => item.kind === 'error' && sandboxOf(item) !== null);
}

/**
 * A faixa vermelha do erro da conversa (`error`) e o balão do mesmo erro não aparecem juntos. `seen` é o erro que já virou balão:
 * dispensado o balão (na conversa ou na caixa), a faixa não volta no lugar dele, porque o erro continua no estado da conversa.
 */
export function errorLineShown(error: string | null, notices: readonly InboxItem[], seen: string | null): boolean {
  return !!error && seen !== error && !notices.some((n) => n.summary === error);
}

/** O `seen` seguinte: o erro de agora se ele está em balão, null quando o erro some (um erro igual, depois, volta a aparecer), senão o que já era. */
export function errorSeenAsNotice(error: string | null, notices: readonly InboxItem[], seen: string | null): string | null {
  if (!error) return null;
  return notices.some((n) => n.summary === error) ? error : seen;
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
