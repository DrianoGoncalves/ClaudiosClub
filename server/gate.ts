import type http from 'node:http';
import { anonymousGetMay, EXT_PREFIX, extensionMay, projectOfPath, projectScopeVerdict, sandboxVerdict, staffMayPost } from './apiPolicy';
import { isSandboxAddress, resolveCaller, SANDBOX_HOST, TOKEN_HEADER, type Caller, type SessionTokens } from './callers';
import { EXTENSION_ORIGIN } from './extension/identity';
import type { ExtensionTokens } from './extension/tokens';
import { admit, NEEDS_PAIRING, type Pairing } from './pairing';

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
  /** Pelo token da conversa (obrigatório na sandbox e nas rotas POST de funcionário; sem ele, só a tela, que lê pelo cookie); nunca para a tela. */
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

/** Sem o token da conversa numa rota POST de funcionário: sem ele o servidor não sabe de qual projeto o pedido é. */
const NEEDS_TOKEN =
  'esta rota é de funcionário e exige o cabeçalho x-myco-token com o MYCO_TOKEN da sua conversa (já está no seu ambiente: -H "x-myco-token: $MYCO_TOKEN"). Sem ele o Claudio’s Club não sabe de qual projeto você é';

/** GET de /api/* sem o cookie do pareamento e sem token: a tela (ou o funcionário, com o token do projeto) lê, o curl sem nada não. */
const NEEDS_PAIRED_OR_TOKEN =
  'esta leitura exige um navegador pareado (clique em "Parear este navegador", no aviso ou no config) ou, para funcionário, o cabeçalho x-myco-token com o MYCO_TOKEN da sua conversa (-H "x-myco-token: $MYCO_TOKEN"), que só alcança o seu projeto';

/** O que a linha de log de uma recusa leva: o motivo, a rota, o projeto e quem chamou. Nunca o token, o cookie nem o conteúdo do pedido. */
export interface Refusal {
  status: number;
  reason: string;
  method: string;
  pathname: string;
  /** O projeto que a rota ou a conversa pedia, quando há um. */
  projectId?: string | null;
  caller: Caller | null;
}

const printable = (s: string, max: number) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, max);

/** A linha de log de uma recusa: só ids (projeto, ficha, conversa) e o caminho, sem token, cookie, corpo nem query. */
export function refusalLine(r: Refusal): string {
  const who = r.caller
    ? `${r.caller.staffId ?? 'conversa sem ficha'} (${r.caller.engine}, conversa ${r.caller.sessionId}, token do projeto ${r.caller.projectId})`
    : 'sem token';
  return `[gate] recusado ${r.status} (${r.reason}): ${r.method} ${printable(r.pathname, 200)} projeto=${r.projectId ?? '-'} chamador=${printable(who, 200)}`;
}

/**
 * Confere o pedido e responde as recusas. `null`: já respondeu (ou é rota do pareamento); senão, segue para as rotas.
 *
 * - Host: só o de máquina local (e, pelo socket da sandbox, o próprio 127.0.0.2). Método: GET e POST.
 * - Ações (POST) exigem `x-myco`; com Origin (o navegador), também o cookie do pareamento (ver pairing.ts `admit`).
 * - Pela sandbox do Codex: o `Origin` e o cookie não contam (nunca é tela), o `x-myco-token` de uma conversa do Codex é obrigatório (401) e só
 *   as rotas liberadas (apiPolicy.ts `sandboxVerdict`) passam (403), no projeto da própria conversa. Isso vem antes e é mais estreito que o resto.
 * - Precedência do token e do cookie: com Origin local e cookie do pareamento (`fromBrowser`, a tela) o token, se vier, é ignorado e vale a tela.
 *   Sem isso (o GET da tela não manda Origin, o curl de um funcionário), um token apresentado é sempre conferido, mesmo junto de um cookie válido:
 *   inválido é 401 (nunca leitura anônima) e válido restringe o pedido ao projeto dele (a regra mais estreita vence).
 * - Em 127.0.0.1 o token válido faz de `caller` o dono dele (as rotas o usam no lugar de `requestedBy` e `reportsTo` do pedido) e o pedido só alcança
 *   o projeto dele (apiPolicy.ts `projectScopeVerdict`: 403 em outro projeto e no que não é de projeto, fora o `health`).
 * - Sem ser a tela, o POST só vale nas rotas de funcionário (`staffMayPost`, 400 nas outras) e exige o token (401 sem ele).
 * - GET de /api/* sem token (fora o `health`, apiPolicy.ts `anonymousGetMay`) só vale com o cookie do pareamento, mesmo sem Origin (o GET da tela não
 *   manda): sem ele, 401 `needs-pairing`. Um Origin que não é local não vira tela, nem com o cookie.
 * - Cada recusa por token, projeto ou cookie vai para o log (`refusalLine`).
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
  const log = d.log ?? ((line: string) => console.log(line));
  const refuse = (status: number, reason: string, error: string, caller: Caller | null, code?: string): null => {
    log(refusalLine({ status, reason, method: req.method ?? '', pathname: url.pathname, projectId: projectOfPath(url.pathname), caller }));
    reply(res, status, { error, ...(code && { code }) });
    return null;
  };
  const resolved = fromBrowser ? ({ ok: true, caller: null } as const) : resolveCaller(sandbox, req.headers[TOKEN_HEADER], d.tokens);
  if (!resolved.ok) return refuse(resolved.status, req.headers[TOKEN_HEADER] ? 'token-invalido' : 'sem-token', resolved.error, null);
  const caller = resolved.caller;
  if (caller?.sandbox) {
    const verdict = sandboxVerdict(req.method, url.pathname, caller.projectId);
    if (verdict) return refuse(verdict.status, 'sandbox', verdict.error, caller);
  }
  if (req.method === 'POST' && !fromBrowser && url.pathname.startsWith('/api/')) {
    if (!staffMayPost(url.pathname)) {
      reply(res, 400, { error: 'só pelo Claudio’s Club' });
      return null;
    }
    if (!caller) return refuse(401, 'sem-token', NEEDS_TOKEN, null);
  }
  if (caller && !caller.sandbox) {
    const verdict = projectScopeVerdict(req.method, url.pathname, caller.projectId);
    if (verdict) return refuse(verdict.status, verdict.reason, verdict.error, caller);
  }
  if (req.method === 'GET' && !caller && url.pathname.startsWith('/api/') && !anonymousGetMay(url.pathname)) {
    // `caller` nulo aqui: nunca é a sandbox (ela sempre tem token). A tela é o cookie, com Origin local ou sem Origin.
    const screen = d.isLocalOrigin(req.headers.origin) && d.pairing.isPaired(req.headers.cookie);
    if (!screen) return refuse(401, 'sem-cookie', NEEDS_PAIRED_OR_TOKEN, null, NEEDS_PAIRING);
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
