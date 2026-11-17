import type http from 'node:http';
import { EXT_PREFIX, extensionMay, sandboxVerdict, staffMayPost } from './apiPolicy';
import { isSandboxAddress, resolveCaller, SANDBOX_HOST, TOKEN_HEADER, type Caller, type SessionTokens } from './callers';
import { EXTENSION_ORIGIN } from './extension/identity';
import type { ExtensionTokens } from './extension/tokens';
import { admit, type Pairing } from './pairing';

// A porta de entrada de todo pedido ao servidor (antes das rotas): Host, método, navegador pareado, quem chama (socket e token) e as listas de
// rotas. Separada de server/index.ts (que sobe o servidor ao ser importado) para os testes abrirem um servidor de verdade nos dois endereços.
//
// A extensão do Chrome (`/api/ext/…` com Origin `chrome-extension://<ID>`) tem caminho próprio, antes de `admit`: não é navegador pareado nem
// conversa. Só as rotas de apiPolicy.ts `extensionMay`, e só com o token do pareamento (Bearer). Cookie e x-myco-token não valem ali.

/** Única rota da extensão que não pede token: o código de pareamento é o que troca por um. */
const EXT_PAIR_PATH = '/api/ext/v1/pair';

export interface GateDeps {
  pairing: Pairing;
  tokens: SessionTokens;
  /** Pareamentos da extensão (token Bearer). Sem ele, a rota da extensão responde 403. */
  extensionTokens?: ExtensionTokens;
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
  /** Veio da extensão do Chrome: `pairingId` é o pareamento do token (null na rota de pareamento, que não tem token ainda). */
  extension?: { pairingId: string | null };
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
  const isExt = req.headers.origin === EXTENSION_ORIGIN;
  if (isExt || url.pathname.startsWith(EXT_PREFIX)) return extensionGate(req, res, url, sandbox, isExt, d);
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

/**
 * O caminho da extensão. Só o Origin da extensão e as rotas dela; a sandbox do Codex nunca. A ordem importa: o escopo (método e rota) vem antes
 * do token, para que uma rota fora da lista seja 403 mesmo sem token. Sem cabeçalhos CORS: a extensão tem permissão de host e não precisa.
 */
function extensionGate(req: http.IncomingMessage, res: http.ServerResponse, url: URL, sandbox: boolean, isExt: boolean, d: GateDeps): Admitted | null {
  if (sandbox) {
    reply(res, 403, { error: 'a extensão não fala pela sandbox' });
    return null;
  }
  if (!isExt) {
    reply(res, 403, { error: 'só a extensão do Claudio’s Club' });
    return null;
  }
  if (!extensionMay(req.method ?? '', url.pathname)) {
    reply(res, 403, { error: 'fora do escopo da extensão' });
    return null;
  }
  if (!d.extensionTokens) {
    reply(res, 403, { error: 'a extensão não está habilitada neste servidor' });
    return null;
  }
  // Pareamento: o código (na rota) é a prova; ainda não há token.
  if (url.pathname === EXT_PAIR_PATH) return { url, sandbox: false, fromBrowser: false, caller: null, extension: { pairingId: null } };
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const rec = d.extensionTokens.verify(bearer?.[1]);
  if (!rec) {
    reply(res, 401, { error: 'token da extensão inválido ou revogado: pareie de novo nas Configurações' });
    return null;
  }
  return { url, sandbox: false, fromBrowser: false, caller: null, extension: { pairingId: rec.id } };
}
