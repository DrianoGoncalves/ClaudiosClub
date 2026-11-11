import { randomBytes } from 'node:crypto';

// Quem está chamando a API. O servidor não confia no que o pedido declara (`requestedBy`, `reportsTo`, `Origin`): confia no socket por onde
// ele chegou e no token da sessão.
//
// - Socket: o servidor escuta em 127.0.0.1 (a tela, as ferramentas locais) e também em 127.0.0.2. A sandbox do Codex só alcança o 127.0.0.2
//   (a lista de domínios do perfil dela, ver server/chat/codexArgs.ts), então quem chega por ele é "da sandbox do Codex": nunca conta como
//   tela, mesmo mandando `Origin` ou cookie, e precisa do token da conversa. O endereço vem do socket (`req.socket.localAddress`), que o
//   cliente não escolhe depois de conectar.
// - Token: toda conversa (Claude ou Codex) recebe `MYCO_TOKEN` no ambiente, ao lado do `MYCO_SESSION_ID`. O mapa token → dono fica só em
//   memória: some quando o servidor reinicia (as conversas retomadas ganham outro) e quando a conversa fecha.

/** Endereço do Claudio’s Club para a sandbox do Codex (todo 127/8 é loopback no Linux e no Windows; no macOS pode faltar o alias). */
export const SANDBOX_HOST = '127.0.0.2';

/** Cabeçalho com o `MYCO_TOKEN` da conversa. */
export const TOKEN_HEADER = 'x-myco-token';

export type Engine = 'claude' | 'codex';

/** De quem é o token: a conversa dele e a ficha dela (`staffId` null: conversa sem ficha). */
export interface TokenOwner {
  staffId: string | null;
  projectId: string;
  sessionId: string;
  engine: Engine;
}

/** Quem chama a API (o dono do token). `sandbox`: chegou pelo 127.0.0.2, ou seja, de dentro da sandbox do Codex. */
export interface Caller extends TokenOwner {
  sandbox: boolean;
}

/** O pedido chegou pelo socket da sandbox do Codex? Aceita a forma IPv4 mapeada em IPv6 (`::ffff:127.0.0.2`). */
export function isSandboxAddress(localAddress: string | null | undefined): boolean {
  if (!localAddress) return false;
  return localAddress.toLowerCase().replace(/^::ffff:/, '') === SANDBOX_HOST;
}

/** `MYCO_TOKEN`: 32 bytes aleatórios em hexadecimal. */
const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

export class SessionTokens {
  private readonly owners = new Map<string, TokenOwner>();
  private readonly bySession = new Map<string, string>();

  /**
   * O token da conversa. Vale a conversa inteira: a do Codex roda uma execução por mensagem e todas usam o mesmo; reabrir a conversa
   * no mesmo servidor devolve o mesmo token. Depois de `revoke`, ou num servidor novo, sai outro.
   */
  issue(owner: TokenOwner): string {
    const have = this.bySession.get(owner.sessionId);
    if (have) {
      this.owners.set(have, { ...owner });
      return have;
    }
    const token = randomBytes(32).toString('hex');
    this.owners.set(token, { ...owner });
    this.bySession.set(owner.sessionId, token);
    return token;
  }

  /** O dono do token; null se não existe (ou nem tem a forma de um). */
  lookup(token: string | null | undefined): TokenOwner | null {
    if (!token || !TOKEN_FORMAT.test(token)) return null;
    const owner = this.owners.get(token);
    return owner ? { ...owner } : null;
  }

  /** A conversa acabou: o token dela deixa de valer. */
  revoke(sessionId: string): void {
    const token = this.bySession.get(sessionId);
    if (!token) return;
    this.bySession.delete(sessionId);
    this.owners.delete(token);
  }

  get size(): number {
    return this.owners.size;
  }
}

export type Resolution = { ok: true; caller: Caller | null } | { ok: false; status: 401; error: string };

const MISSING_TOKEN =
  'a sandbox do Codex precisa do cabeçalho x-myco-token com o MYCO_TOKEN da sua conversa (já está no seu ambiente: -H "x-myco-token: $MYCO_TOKEN")';
const BAD_TOKEN = 'x-myco-token inválido: use o MYCO_TOKEN da sua conversa do Codex (ele muda quando a conversa reabre num servidor novo)';

/**
 * Quem chama, pelo socket e pelo token.
 * - Socket da sandbox do Codex: o token é obrigatório e tem de ser de uma conversa do Codex; sem ele (ou outro), 401. O dono do token é quem chama.
 * - Socket normal (127.0.0.1): o token é opcional (compatibilidade com quem ainda não o manda: um processo fora da sandbox já tem acesso total
 *   à máquina, então não é segurança). Válido, o dono do token é quem chama e vale no lugar do que o pedido declara; ausente ou inválido
 *   (ex.: uma conversa de antes de um reinício), o pedido segue como antes, sem dono.
 */
export function resolveCaller(sandbox: boolean, tokenHeader: string | string[] | undefined, tokens: SessionTokens): Resolution {
  const raw = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  const owner = tokens.lookup(raw);
  if (!sandbox) return { ok: true, caller: owner && { ...owner, sandbox: false } };
  if (!raw) return { ok: false, status: 401, error: MISSING_TOKEN };
  if (!owner || owner.engine !== 'codex') return { ok: false, status: 401, error: BAD_TOKEN };
  return { ok: true, caller: { ...owner, sandbox: true } };
}

/**
 * Quem pede uma tarefa ou encerra um temporário pela API (`requestedBy`). Com o token da conversa vale quem chama e o declarado no pedido é
 * descartado (um Claude também não se passa por outro); sem token (127.0.0.1, compatibilidade), o que o pedido declara. Conversa sem ficha
 * não é ninguém: `error` diz o motivo.
 */
export function actingStaff(caller: Caller | null, declared: string | undefined): { staffId: string | undefined; error?: string } {
  if (!caller) return { staffId: declared };
  if (!caller.staffId) return { staffId: undefined, error: 'só um funcionário (com ficha) faz isto pela API' };
  return { staffId: caller.staffId };
}

/** A conversa de quem pede a tarefa (o token dele): a entrega volta para ela, e não para a mais recente dele. Sem token, undefined. */
export function requesterSessionOf(caller: Caller | null, requestedBy: string | undefined): string | undefined {
  return caller?.staffId && caller.staffId === requestedBy ? caller.sessionId : undefined;
}
