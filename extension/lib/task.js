// A tarefa rápida: valida o formulário e monta o corpo de POST /api/ext/v1/tasks. Os limites são os do servidor (server/extension/routes.ts).

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 3000;
export const SELECTION_MAX = 3000;
export const SOURCE_TITLE_MAX = 200;
export const URL_MAX = 1000;

/** Só http/https vai como página (o resto, como chrome:// ou file://, o servidor descartaria). */
export function isWebUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parâmetro de URL que pode levar segredo (a mesma lista do servidor, server/extension/routes.ts): o valor nem sai do navegador. */
const SENSITIVE_PARAM = /token|code|key|secret|pass|auth|session|sig|jwt/i;

/** A URL sem usuário, senha nem fragmento, e com o valor dos parâmetros sensíveis trocado por REDACTED (o que a pessoa vê é o que vai). */
export function safeUrl(raw) {
  const u = new URL(raw);
  u.username = '';
  u.password = '';
  u.hash = '';
  for (const key of new Set(u.searchParams.keys())) if (SENSITIVE_PARAM.test(key)) u.searchParams.set(key, 'REDACTED');
  return u.toString();
}

/**
 * O que da página atual vai com a tarefa, já nos limites. `pick` diz o que a pessoa marcou. Vazio = nada a anexar.
 * @param {{ url?: string, title?: string, selection?: string }} page
 * @param {{ page: boolean, selection: boolean }} pick
 * @returns {{ url?: string, title?: string, selection?: string } | null}
 */
export function pageSource(page, pick) {
  const out = {};
  const url = pick.page && page.url && isWebUrl(page.url) ? safeUrl(page.url) : '';
  if (url && url.length <= URL_MAX) out.url = url;
  if (pick.page && page.title?.trim()) out.title = page.title.trim().slice(0, SOURCE_TITLE_MAX);
  if (pick.selection && page.selection?.trim()) out.selection = page.selection.trim().slice(0, SELECTION_MAX);
  return Object.keys(out).length ? out : null;
}

/**
 * @param {{ projectId: string, staffId: string, title: string, description: string, start: boolean, source: object | null }} form
 * @returns {{ ok: true, body: object } | { ok: false, error: 'errNoProject' | 'errNoStaff' | 'errNoTitle' | 'errTitleLong' | 'errDescriptionLong' }}
 */
export function buildTaskBody(form) {
  const title = form.title.trim();
  const description = form.description.trim();
  if (!form.projectId) return { ok: false, error: 'errNoProject' };
  if (!form.staffId) return { ok: false, error: 'errNoStaff' };
  if (!title) return { ok: false, error: 'errNoTitle' };
  if (title.length > TITLE_MAX) return { ok: false, error: 'errTitleLong' };
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: 'errDescriptionLong' };
  return {
    ok: true,
    body: {
      projectId: form.projectId,
      staffId: form.staffId,
      title,
      description,
      start: form.start === true,
      ...(form.source ? { source: form.source } : {}),
    },
  };
}
