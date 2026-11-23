// Rascunho da caixa de mensagem do chat: o que a pessoa digitou e não enviou volta ao reabrir a conversa.
// Guardado no sessionStorage (some ao fechar a aba, não fica no disco), mas em claro e legível por qualquer script desta origem: aceito
// porque o app é local e sem conteúdo de terceiros; o texto sai ao enviar. Lógica pura, testada em tests/chatDraft.test.ts.

const PREFIX = 'myco.chatDraft.';
// A memória da página manda: ela é sempre a última escrita, então um `removeItem` que falhe não faz o texto antigo voltar.
const inMemory = new Map<string, string>();

/** Uma caixa por projeto, funcionário e conversa; a conversa ainda sem sessão (nova) é `novo`. */
export function draftKey(projectId: string, staffId: string | null, sessionId: string | null): string {
  return `${PREFIX}${projectId}:${staffId ?? ''}:${sessionId ?? 'novo'}`;
}

export function loadDraft(key: string): string {
  const mem = inMemory.get(key);
  if (mem !== undefined) return mem;
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** Texto em branco apaga o rascunho. */
export function saveDraft(key: string, text: string): void {
  const value = text.trim() ? text : '';
  inMemory.set(key, value);
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* segue na memória */
  }
}

/** "Nova conversa": a caixa da conversa sem sessão começa vazia, sem o texto da nova anterior. */
export function clearFreshDraft(projectId: string, staffId: string | null): void {
  saveDraft(draftKey(projectId, staffId, null), '');
}
