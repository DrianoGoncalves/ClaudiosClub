import { API } from './config.js';

// Chamadas ao Club (/api/ext/v1/…). O token do pareamento vai em Bearer; o resto é só traduzir a falha:
// offline (o Club não responde, ou outra coisa responde na porta), unauthorized (token revogado), limited (429) e refused (o Club recusou, com motivo).

const TIMEOUT_MS = 8000;

export class ClubError extends Error {
  /**
   * @param {'offline' | 'unauthorized' | 'limited' | 'refused'} kind
   * @param {string} message
   * @param {{ status?: number | null, retryAfter?: number | null }} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    this.status = extra.status ?? null;
    this.retryAfter = extra.retryAfter ?? null;
  }
}

/**
 * @param {string} path
 * @param {{ method?: 'GET' | 'POST', body?: unknown, token?: string | null }} [opts]
 * @returns {Promise<any>}
 */
export async function call(path, { method = 'GET', body, token } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ClubError('offline', 'offline');
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data = isJson ? await res.json().catch(() => null) : null;
  // Sem JSON (a página de início do Club parado, outro programa na porta): para a extensão é o mesmo que offline.
  if (!data) throw new ClubError('offline', 'offline', { status: res.status });
  if (res.ok) return data;
  const message = typeof data.error === 'string' ? data.error : `status ${res.status}`;
  if (res.status === 401) throw new ClubError('unauthorized', message, { status: 401 });
  if (res.status === 429) throw new ClubError('limited', message, { status: 429, retryAfter: Number(res.headers.get('retry-after')) || null });
  throw new ClubError('refused', message, { status: res.status });
}
