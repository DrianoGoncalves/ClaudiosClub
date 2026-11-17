// Modelo pedido que não existe mais na conta: como o claude recusa no stream. Só funções puras (sem processo), para testar cada formato.

/** O texto que o claude põe no lugar da resposta quando o modelo não existe (ou a conta não tem acesso a ele). */
const MODEL_GONE_TEXT = /issue with the selected model/i;

/**
 * Recusa de modelo inexistente: o `assistant` com `error: "model_not_found"`, ou o `result` de erro com `api_error_status` 404 e o
 * texto "There's an issue with the selected model (…)". Outro 404 (ou outro erro) não conta.
 */
export function isClaudeModelNotFound(ev: unknown): boolean {
  const e = ev as { error?: unknown; api_error_status?: unknown; result?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.error === 'model_not_found') return true;
  return e.api_error_status === 404 && typeof e.result === 'string' && MODEL_GONE_TEXT.test(e.result);
}
