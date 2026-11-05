import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { DEFAULT_SECRETS_DIR } from './secretVault';

// Pareamento do navegador. Os funcionários rodam como o seu usuário e falam com a API (curl, x-myco); antes, um
// `Origin` qualquer bastava para passar por "só pelo Claudio’s Club". Agora, ação de navegador exige um cookie que só
// existe num navegador pareado:
// - Chave de 32 bytes em ~/.myco/secrets/pairing.key (0600, pasta 0700), criada na subida. Fica no cofre porque as
//   regras das sessões (ver staff/ficha.ts) já bloqueiam Read/Edit/Write ali e o MCP de FTP não envia nada de lá.
// - Código de uso único, válido por 2 min: `<ms em base36>.<nonce>.<HMAC>`, gerado pelos scripts que abrem o painel
//   (npm run daily/setup/pair, myco://open e o atalho opcional) e entregue só ao navegador, nunca impresso.
// - "Parear este navegador" (config e aviso de não pareado), em qualquer navegador: POST /api/pair/request devolve um
//   pedido (id secreto, só de quem pediu) e um código curto que a tela mostra, e abre um terminal com
//   `npm run pair CÓDIGO` pronto. Lá você confere o código e confirma: o script aprova com a chave
//   (POST /api/pair/approve) e a aba, que pergunta em POST /api/pair/claim, recebe o cookie. Quem não tem a chave só
//   cria pedidos; sem terminal interativo (um funcionário), o script não aprova.
// - GET /api/pair?code= confere o código e grava o cookie (HttpOnly, SameSite=Strict, 1 ano): um HMAC derivado da
//   chave, nunca ela. Trocar a chave (POST /api/pair/rotate) desfaz todos os pareamentos.
// É uma barreira a mais, não a única: quem roda como você ainda consegue ler o arquivo por outro comando (as regras
// cobrem Read/Edit/Write, não todo Bash) ou agir pelo seu navegador (extensão do Chrome). Corta o atalho trivial
// (`curl -H "Origin: …"`), e o log registra cada pareamento.

export const PAIR_KEY_FILE = path.join(DEFAULT_SECRETS_DIR, 'pairing.key');
export const PAIR_COOKIE = 'myco_pair';
export const PAIR_PATH = '/api/pair';
export const PAIR_ROTATE_PATH = '/api/pair/rotate';
export const PAIR_REQUEST_PATH = '/api/pair/request';
export const PAIR_CLAIM_PATH = '/api/pair/claim';
export const PAIR_APPROVE_PATH = '/api/pair/approve';
export const PAIR_CODE_TTL_MS = 2 * 60_000;
/** Quanto vale um pedido de "Parear este navegador" e quantos ficam guardados (o mais antigo sai). */
export const PAIR_REQUEST_TTL_MS = 10 * 60_000;
const PAIR_MAX_REQUESTS = 20;
/** Entre dois terminais de aprovação: um script pedindo sem parar não enche a tela de janelas. */
export const PAIR_TERMINAL_GAP_MS = 15_000;
/** O código que a tela mostra: 8 letras/dígitos sem os que se confundem (0/O, 1/I), como "K7QX-4M2P". */
export const PAIR_USER_CODE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
/** Relógio da mesma máquina: só uma folga mínima para código "do futuro". */
const CLOCK_SKEW_MS = 5_000;
export const NEEDS_PAIRING = 'needs-pairing';
export const NEEDS_PAIRING_MESSAGE = 'este navegador não está pareado: clique em "Parear este navegador" (no aviso ou no config)';

const KEY_HEX = /^[0-9a-f]{64}$/;
const CODE = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

function readKey(file: string): Buffer | null {
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    return KEY_HEX.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null;
  }
}

/** Grava a chave só para o seu usuário. `exclusive`: falha se já existe (duas subidas ao mesmo tempo). */
function writeKey(file: string, key: Buffer, exclusive: boolean): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const content = `${key.toString('hex')}\n`;
  if (exclusive) {
    fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
  } else {
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

/** A chave do pareamento; cria (ou troca uma corrompida) se preciso. Síncrono: roda na subida e nos scripts. */
export function readOrCreatePairKey(file = PAIR_KEY_FILE): Buffer {
  const existing = readKey(file);
  if (existing) return existing;
  const key = randomBytes(32);
  try {
    writeKey(file, key, true);
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Outro processo criou agora: vale a dele. Arquivo existente mas inválido: troca.
    const other = readKey(file);
    if (other) return other;
    writeKey(file, key, false);
    return key;
  }
}

const mac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest('base64url');
const codeMac = (key: Buffer, ts: string, nonce: string) => mac(key, `myco-pair-code:v1:${ts}:${nonce}`);

/** Comparação em tempo constante, sem vazar o tamanho (compara os hashes). */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Código de pareamento de uso único (vale PAIR_CODE_TTL_MS a partir de `now`). */
export function pairCode(key: Buffer, now = Date.now(), nonce = randomBytes(16).toString('base64url')): string {
  const ts = now.toString(36);
  return `${ts}.${nonce}.${codeMac(key, ts, nonce)}`;
}

/** Endereço que o navegador abre: `base` é o do painel (http://claudio.localhost:4848 ou o Vite, :5173). */
export function pairUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}${PAIR_PATH}?code=${encodeURIComponent(code)}`;
}

/** O valor de um cookie no cabeçalho Cookie (todos com esse nome: pode haver mais de um caminho). */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
}

export type CodeCheck = 'ok' | 'invalid' | 'expired' | 'used';

export class Pairing {
  private key: Buffer;
  /** Nonces já usados → até quando guardar (depois disso o código expirou de qualquer jeito). */
  private readonly used = new Map<string, number>();
  /** Pedidos de "Parear este navegador": id (segredo de quem pediu) → código da tela, prazo e se já foi aprovado. */
  private readonly requests = new Map<string, { code: string; until: number; approved: boolean }>();
  private lastTerminal = -Infinity;

  constructor(
    private readonly file = PAIR_KEY_FILE,
    private readonly now: () => number = Date.now,
  ) {
    this.key = readOrCreatePairKey(file);
  }

  /** Confere e gasta o código: uma vez só, dentro do prazo. */
  checkCode(code: unknown): CodeCheck {
    const t = this.now();
    for (const [nonce, until] of this.used) if (until < t) this.used.delete(nonce);
    const m = typeof code === 'string' ? CODE.exec(code) : null;
    if (!m) return 'invalid';
    const [, ts, nonce, given] = m as unknown as [string, string, string, string];
    if (!sameSecret(given, codeMac(this.key, ts, nonce))) return 'invalid';
    const issued = parseInt(ts, 36);
    if (!Number.isSafeInteger(issued) || t - issued > PAIR_CODE_TTL_MS || issued - t > CLOCK_SKEW_MS) return 'expired';
    if (this.used.has(nonce)) return 'used';
    this.used.set(nonce, issued + PAIR_CODE_TTL_MS + CLOCK_SKEW_MS);
    return 'ok';
  }

  /** Pedido novo: o id fica só com quem pediu; o código é o que a tela mostra para aprovar. */
  request(): { id: string; code: string } {
    this.prune();
    while (this.requests.size >= PAIR_MAX_REQUESTS) this.requests.delete(this.requests.keys().next().value!);
    const id = randomBytes(24).toString('base64url');
    // 32 letras: cada byte & 31 cai em uma delas sem viés.
    const code = [...randomBytes(8)].map((b) => USER_CODE_ALPHABET[b & 31]).join('');
    this.requests.set(id, { code, until: this.now() + PAIR_REQUEST_TTL_MS, approved: false });
    return { id, code: `${code.slice(0, 4)}-${code.slice(4)}` };
  }

  /** Aprova o pedido com este código (quem chama já provou ter a chave). */
  approve(code: string): boolean {
    this.prune();
    const want = code.replace(/[^0-9a-z]/gi, '').toUpperCase();
    for (const r of this.requests.values()) {
      if (r.code === want && !r.approved) {
        r.approved = true;
        return true;
      }
    }
    return false;
  }

  /** A aba que pediu pergunta: aprovado gasta o pedido (o cookie vai uma vez só). */
  claim(id: unknown): 'paired' | 'waiting' | 'gone' {
    this.prune();
    const r = typeof id === 'string' ? this.requests.get(id) : undefined;
    if (!r) return 'gone';
    if (!r.approved) return 'waiting';
    this.requests.delete(id as string);
    return 'paired';
  }

  /** Terminal de aprovação: no máximo um a cada PAIR_TERMINAL_GAP_MS. */
  takeTerminalSlot(): boolean {
    const t = this.now();
    if (t - this.lastTerminal < PAIR_TERMINAL_GAP_MS) return false;
    this.lastTerminal = t;
    return true;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, r] of this.requests) if (r.until < t) this.requests.delete(id);
  }

  /** O valor do cookie: derivado da chave (HMAC), nunca a chave. */
  cookieValue(): string {
    return `v1.${mac(this.key, 'myco-pair-cookie:v1')}`;
  }

  isPaired(cookieHeader: string | undefined): boolean {
    const expected = this.cookieValue();
    // Todos conferidos (sem sair no primeiro), para o tempo não depender de qual bateu.
    return cookieValues(cookieHeader, PAIR_COOKIE).reduce((ok, v) => sameSecret(v, expected) || ok, false);
  }

  setCookieHeader(): string {
    return `${PAIR_COOKIE}=${this.cookieValue()}; Max-Age=${PAIR_COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Strict`;
  }

  /** Chave nova: todo navegador pareado (e todo código ainda não usado) deixa de valer. */
  rotate(): void {
    const key = randomBytes(32);
    writeKey(this.file, key, false);
    this.key = key;
    this.used.clear();
    this.requests.clear();
  }
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

const FAILED_PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claudio’s Club</title></head>
<body style="font: 15px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 0 auto; padding: 24px">
<h1 style="font-size: 20px">Este link de pareamento não vale mais</h1>
<p>Ele é de uso único e vale por 2 minutos. Volte ao Claudio’s Club, clique em <b>Parear este navegador</b> e rode
no terminal o comando que aparece.</p>
</body></html>`;

/** Só o tipo do motivo: o código, o cookie e a chave nunca vão para o log. */
type Log = (line: string) => void;

export interface AdmitOptions {
  /** Origin local (localhost, claudio.localhost…); sem Origin, também (curl, um funcionário). */
  isLocalOrigin: (origin: string | undefined) => boolean;
  /** Abre o terminal de aprovação com `npm run pair CÓDIGO` pronto; devolve se abriu. */
  openApproval?: (code: string) => boolean;
  log?: Log;
}

const header = (req: http.IncomingMessage, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : '';
};

/**
 * As três rotas do "Parear este navegador". Os dados vão em cabeçalhos (`x-pair-*`): a porta de entrada não lê corpo.
 * - request e claim: do navegador ainda sem cookie (por isso passam antes da checagem dele); só com Origin.
 * - approve: do `npm run pair CÓDIGO`, com a prova da chave (um código de uso único, como o do link).
 */
function pairRoute(req: http.IncomingMessage, res: http.ServerResponse, path: string, pairing: Pairing, o: AdmitOptions, log: Log): void {
  const fromPage = !!req.headers.origin;
  if (path === PAIR_REQUEST_PATH) {
    if (!fromPage) return json(res, 400, { error: 'só pelo Claudio’s Club' });
    if (pairing.isPaired(req.headers.cookie)) return json(res, 200, { paired: true });
    const made = pairing.request();
    // O terminal só pergunta (padrão: não) e mostra o código: aprovar continua sendo de quem está na frente da tela.
    const terminal = !!o.openApproval && pairing.takeTerminalSlot() && o.openApproval(made.code);
    log(`[pareamento] pedido de pareamento criado${terminal ? ' (terminal de aprovação aberto)' : ''}`);
    return json(res, 200, { paired: false, terminal, ...made });
  }
  if (path === PAIR_CLAIM_PATH) {
    if (!fromPage) return json(res, 400, { error: 'só pelo Claudio’s Club' });
    const state = pairing.claim(header(req, 'x-pair-request'));
    if (state === 'gone') return json(res, 410, { error: 'o código expirou: clique em Parear de novo', code: 'pair-gone' });
    if (state === 'waiting') return json(res, 200, { paired: false });
    log('[pareamento] navegador pareado (código aprovado no terminal)');
    return json(res, 200, { paired: true }, { 'set-cookie': pairing.setCookieHeader() });
  }
  // approve: a prova vem primeiro, para quem não tem a chave nem saber se um código existe.
  if (pairing.checkCode(header(req, 'x-pair-proof')) !== 'ok') {
    log('[pareamento] aprovação recusada (sem a chave)');
    return json(res, 403, { error: 'aprovação recusada: rode npm run pair na pasta do Claudio’s Club' });
  }
  if (!pairing.approve(header(req, 'x-pair-code'))) {
    return json(res, 404, { error: 'nenhum pedido com esse código (vale 10 min): clique em Parear de novo' });
  }
  log('[pareamento] pedido aprovado no terminal');
  json(res, 200, { ok: true });
}

export type Admission = { done: true } | { done: false; fromBrowser: boolean };

/**
 * Porta de entrada de cada pedido (depois da checagem de Host). Responde e devolve `done` quando é recusa ou rota do
 * pareamento; senão, diz se o pedido é do navegador pareado.
 * - POST sem x-myco ou com Origin de fora: 403 (uma página qualquer não dispara ações locais).
 * - POST com Origin local e sem cookie válido: 403 `needs-pairing` (navegador não pareado, ou um Origin forjado).
 *   As exceções são POST /api/pair/request e /api/pair/claim, que existem justamente para quem ainda não tem o cookie.
 * - POST sem Origin: segue como ferramenta (funcionário pela API); as rotas "só pelo Claudio’s Club" recusam.
 */
export function admit(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pairing: Pairing, o: AdmitOptions): Admission {
  const log = o.log ?? ((line: string) => console.log(line));
  const origin = req.headers.origin;
  if (req.method === 'POST') {
    if (req.headers['x-myco'] !== '1' || !o.isLocalOrigin(origin)) {
      json(res, 403, { error: 'origem não permitida' });
      return { done: true };
    }
    if (url.pathname === PAIR_REQUEST_PATH || url.pathname === PAIR_CLAIM_PATH || url.pathname === PAIR_APPROVE_PATH) {
      pairRoute(req, res, url.pathname, pairing, o, log);
      return { done: true };
    }
    if (origin && !pairing.isPaired(req.headers.cookie)) {
      json(res, 403, { error: NEEDS_PAIRING_MESSAGE, code: NEEDS_PAIRING });
      return { done: true };
    }
  }
  const fromBrowser = !!origin && pairing.isPaired(req.headers.cookie);

  if (url.pathname === PAIR_PATH && req.method === 'GET') {
    const result = pairing.checkCode(url.searchParams.get('code'));
    if (result === 'ok') {
      log('[pareamento] navegador pareado');
      res.writeHead(303, { ...SECURITY_HEADERS, location: '/', 'set-cookie': pairing.setCookieHeader() });
      res.end();
      return { done: true };
    }
    log(`[pareamento] código recusado (${result === 'used' ? 'já usado' : result === 'expired' ? 'expirado' : 'inválido'})`);
    // Já pareado (ex.: o atalho aberto duas vezes): só entra.
    if (pairing.isPaired(req.headers.cookie)) {
      res.writeHead(303, { ...SECURITY_HEADERS, location: '/' });
      res.end();
      return { done: true };
    }
    res.writeHead(403, {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    res.end(FAILED_PAGE);
    return { done: true };
  }

  if (url.pathname === PAIR_ROTATE_PATH && req.method === 'POST') {
    if (!fromBrowser) {
      json(res, 400, { error: 'só pelo Claudio’s Club' });
      return { done: true };
    }
    pairing.rotate();
    log('[pareamento] chave trocada: todos os navegadores precisam parear de novo (este segue pareado)');
    // Quem pediu já provou ser o navegador pareado: recebe o cookie novo e não fica de fora.
    json(res, 200, { ok: true }, { 'set-cookie': pairing.setCookieHeader() });
    return { done: true };
  }

  return { done: false, fromBrowser };
}
