import type http from 'node:http';
import { sandboxVerdict, staffMayPost } from './apiPolicy';
import { isSandboxAddress, resolveCaller, SANDBOX_HOST, TOKEN_HEADER, type Caller, type SessionTokens } from './callers';
import { admit, type Pairing } from './pairing';

// A porta de entrada de todo pedido ao servidor (antes das rotas): Host, método, navegador pareado, quem chama (socket e token) e as listas de
// rotas. Separada de server/index.ts (que sobe o servidor ao ser importado) para os testes abrirem um servidor de verdade nos dois endereços.

export interface GateDeps {
  pairing: Pairing;
  tokens: SessionTokens;
  /** Hosts que o navegador usa para chegar aqui (localhost, claudio.localhost…): o resto é DNS rebinding. */
  localHostnames: ReadonlySet<string>;
  isLocalOrigin: (origin: string | undefined) => boolean;
  openApproval?: (code: string) => boolean;
  log?: (line: string) => void;
}

/** Pedido aceito: de onde veio, e quem chama. */
export interface Admitted {
  url: URL;
  /** Pelo socket da sandbox do Codex (127.0.0.2). */
  sandbox: boolean;
  /** Veio da tela: navegador pareado (Origin local e cookie). Nunca pelo socket da sandbox, mesmo com `Origin` e cookie. */
  fromBrowser: boolean;
  /** Pelo token da conversa (obrigatório na sandbox, opcional em 127.0.0.1); nunca para a tela. */
  caller: Caller | null;
}

/** Resposta JSON sem cache (a mesma das rotas). */
export function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** O pedido chegou pelo socket da sandbox do Codex? O endereço é o do socket local, que quem chama não escolhe. */
export const viaSandbox = (req: http.IncomingMessage): boolean => isSandboxAddress(req.socket.localAddress);

/**
 * Confere o pedido e responde as recusas. `null`: já respondeu (ou é rota do pareamento); senão, segue para as rotas.
 *
 * - Host: só o de máquina local (e, pelo socket da sandbox, o próprio 127.0.0.2). Método: GET e POST.
 * - Ações (POST) exigem `x-myco`; com Origin (o navegador), também o cookie do pareamento (ver pairing.ts `admit`).
 * - Pela sandbox do Codex: o `Origin` e o cookie não contam (nunca é tela), o `x-myco-token` de uma conversa do Codex é obrigatório (401) e só
 *   as rotas liberadas (apiPolicy.ts `sandboxVerdict`) passam (403), no projeto da própria conversa.
 * - Em 127.0.0.1 o token é opcional: válido, `caller` é o dono dele (as rotas o usam no lugar de `requestedBy` e `reportsTo` do pedido).
 * - Sem ser a tela, o POST só vale nas rotas de funcionário (`staffMayPost`).
 */
export function gate(req: http.IncomingMessage, res: http.ServerResponse, d: GateDeps): Admitted | null {
  const sandbox = viaSandbox(req);
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!d.localHostnames.has(hostname) && !(sandbox && hostname === SANDBOX_HOST)) {
    reply(res, 403, { error: 'host não permitido' });
    return null;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    reply(res, 405, { error: 'método não permitido' });
    return null;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const admission = admit(req, res, url, d.pairing, { isLocalOrigin: d.isLocalOrigin, openApproval: d.openApproval, isSandbox: viaSandbox, log: d.log });
  if (admission.done) return null;
  const { fromBrowser } = admission;
  const resolved = resolveCaller(sandbox, req.headers[TOKEN_HEADER], d.tokens);
  if (!resolved.ok) {
    reply(res, resolved.status, { error: resolved.error });
    return null;
  }
  const caller = fromBrowser ? null : resolved.caller;
  if (caller?.sandbox) {
    const verdict = sandboxVerdict(req.method, url.pathname, caller.projectId);
    if (verdict) {
      reply(res, verdict.status, { error: verdict.error });
      return null;
    }
  }
  if (req.method === 'POST' && !fromBrowser && url.pathname.startsWith('/api/') && !staffMayPost(url.pathname)) {
    reply(res, 400, { error: 'só pelo Claudio’s Club' });
    return null;
  }
  return { url, sandbox, fromBrowser, caller };
}
