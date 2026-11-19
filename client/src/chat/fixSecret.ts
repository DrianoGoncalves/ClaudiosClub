import type { InboxItem } from '../../../shared/model';
import { FileApiError, isPairingError } from '../api';
import { t, type MsgKey } from '../i18n';
import { secretFileOf } from './secretAlerts';

// "Corrigir" no aviso de segredo (balão do chat e caixa "precisa de mim") e o "clique aqui" do arquivo de segredo na aba Arquivos.
// Arquivo comum abre na aba Arquivos (na linha do segredo, se o servidor a achou); arquivo de segredo abre FORA do Club, no editor de texto do computador
// (`filesApi.openEditor`): o conteúdo nunca passa pela tela. Aqui só a decisão e as frases; quem chama cuida do estado.

/** O que o "Corrigir" faz: abre na aba Arquivos (arquivo comum) ou no editor do computador (arquivo de segredo). */
export type FixTarget = { how: 'files'; path: string; line?: number } | { how: 'editor'; path: string };

/** O que o clique deu: a aba Arquivos abriu, o editor abriu, ou foi recusado (`text` null = recusa por pareamento, que o aviso do App já explica). */
export type FixOutcome = { kind: 'files' } | { kind: 'opened' } | { kind: 'refused'; text: string | null };

/** A frase que fica sob o botão depois do clique. */
export interface FixNote {
  ok: boolean;
  text: string;
}

export interface FixDeps {
  projectId: string;
  /** A página roda neste computador (endereço de loopback)? O editor abre na máquina do Club: de outra máquina, a janela subiria onde ninguém está olhando. */
  local: boolean;
  openEditor: (projectId: string, path: string) => Promise<unknown>;
  /** Abre a aba Arquivos do projeto no arquivo (e na linha, se vier). Sem ele, só o editor do computador está disponível. */
  openFiles?: (path: string, line?: number) => void;
}

/** O alvo do "Corrigir" do item: arquivo de segredo vai ao editor do computador; arquivo comum à aba Arquivos, se há como abri-la; sem arquivo, nada. */
export function fixTargetOf(item: Pick<InboxItem, 'secret'>, canOpenFiles: boolean): FixTarget | null {
  const file = secretFileOf(item);
  if (!file) return null;
  if (file.blocked) return { how: 'editor', path: file.path };
  if (!canOpenFiles) return null;
  const line = item.secret?.line;
  // A linha só posiciona o editor; o que não for um inteiro razoável é ignorado em vez de virar posição estranha.
  return Number.isInteger(line) && line! > 0 && line! <= 1_000_000 ? { how: 'files', path: file.path, line } : { how: 'files', path: file.path };
}

/** A frase (chave) de uma recusa da rota de abrir no editor, pelo status e pelo `code`: o texto do servidor vem só em português e não é usado. Pareamento = null. */
export function fixProblemKey(err: unknown): MsgKey | null {
  if (isPairingError(err)) return null;
  if (err instanceof FileApiError) {
    if (err.status === 403) return err.code === 'not-secret' ? 'chat.fixNotSecret' : 'chat.fixForbidden';
    if (err.status === 404) return 'chat.fixGone';
    if (err.status === 409) {
      if (err.code === 'no-display') return 'chat.fixNoDisplay';
      if (err.code === 'no-editor') return 'chat.fixNoEditor';
      if (err.code === 'changed') return 'chat.fixChanged';
    }
    if (err.status === 502) return 'chat.fixFailed';
  }
  return 'chat.fixError';
}

/** Abre um arquivo de segredo fora do Club. Arquivo que o servidor diz não ser de segredo (lista velha na tela) cai na aba Arquivos, se ela existe. */
export async function openOutside(path: string, d: FixDeps): Promise<FixOutcome> {
  if (!d.local) return { kind: 'refused', text: t('chat.fixRemote') };
  try {
    await d.openEditor(d.projectId, path);
    return { kind: 'opened' };
  } catch (err) {
    if (err instanceof FileApiError && err.code === 'not-secret' && d.openFiles) {
      d.openFiles(path);
      return { kind: 'files' };
    }
    const key = fixProblemKey(err);
    return { kind: 'refused', text: key && t(key) };
  }
}

/** Faz o que o alvo manda. */
export async function runFix(target: FixTarget, d: FixDeps): Promise<FixOutcome> {
  if (target.how === 'editor') return openOutside(target.path, d);
  if (!d.openFiles) return { kind: 'refused', text: t('chat.fixError') };
  d.openFiles(target.path, target.line);
  return { kind: 'files' };
}

/** A frase sob o botão: só quando o editor abriu ou houve recusa com texto; a aba Arquivos abrindo já é o resultado. */
export function fixNoteOf(outcome: FixOutcome): FixNote | null {
  if (outcome.kind === 'opened') return { ok: true, text: t('chat.fixOpened') };
  if (outcome.kind === 'refused' && outcome.text) return { ok: false, text: outcome.text };
  return null;
}
