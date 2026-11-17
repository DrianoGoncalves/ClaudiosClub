import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SECRETS_DIR } from '../secretVault';

// Pareamentos da extensão do Chrome. O código (XXXX-XXXX) é mostrado nas Configurações e digitado na extensão: uso único, 5 min, só em
// memória. Quem troca o código recebe um token (32 bytes) que só vai para a extensão. No disco fica só o sha256 do token: um arquivo lido
// não entrega um token que funcione. Nunca loga o código nem o token.

export const EXTENSION_TOKENS_FILE = path.join(DEFAULT_SECRETS_DIR, 'extension-tokens.json');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 5 * 60_000;
/** Pareamentos ativos ao mesmo tempo: acima disso, revogue um nas Configurações. */
export const MAX_EXTENSION_PAIRINGS = 5;
const LABEL_MAX = 40;
const LABEL_DEFAULT = 'Chrome';
/** O `lastUsedAt` só é gravado de novo depois disso (cada pedido da extensão não vira uma escrita no disco). */
const TOUCH_MS = 10 * 60_000;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export interface PairingRecord {
  id: string;
  label: string;
  /** sha256 hex do token (o token em si nunca vai ao disco). */
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type ClaimResult = { token: string; id: string } | 'invalid' | 'full';

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** Comparação em tempo constante, como `sameSecret` de pairing.ts (compara os hashes, então o tamanho não vaza). */
function sameHash(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Só o que o usuário digitou: sem caracteres de controle, sem espaços nas pontas, até LABEL_MAX. */
function cleanLabel(label: string | undefined): string {
  const clean = (label ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, LABEL_MAX);
  return clean || LABEL_DEFAULT;
}

/** O conteúdo do arquivo; inválido (ou ausente) é lista vazia. */
function loadRecords(file: string): PairingRecord[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { pairings?: unknown };
    if (!Array.isArray(data.pairings)) return [];
    return data.pairings.filter(
      (r): r is PairingRecord =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as PairingRecord).id === 'string' &&
        typeof (r as PairingRecord).label === 'string' &&
        typeof (r as PairingRecord).hash === 'string' &&
        typeof (r as PairingRecord).createdAt === 'string' &&
        ((r as PairingRecord).lastUsedAt === null || typeof (r as PairingRecord).lastUsedAt === 'string'),
    );
  } catch {
    return [];
  }
}

export class ExtensionTokens {
  private records: PairingRecord[];
  /** O código ativo (só o hash, em memória). Um novo substitui o anterior. */
  private pending: { codeHash: string; until: number; label: string } | null = null;

  constructor(
    private readonly file = EXTENSION_TOKENS_FILE,
    private readonly now: () => number = Date.now,
  ) {
    this.records = loadRecords(file);
  }

  /** Gera o código de pareamento (vale 5 min). `label`: o nome que aparece nas Configurações. */
  startPairing(label?: string): { code: string; expiresAt: string } {
    const raw = [...randomBytes(8)].map((b) => CODE_ALPHABET[b & 31]).join('');
    const until = this.now() + CODE_TTL_MS;
    this.pending = { codeHash: sha256Hex(raw), until, label: cleanLabel(label) };
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: new Date(until).toISOString() };
  }

  /** Troca o código pelo token (uso único). Expirado ou errado é 'invalid'; cheio de pareamentos é 'full' (o código segue valendo). */
  claim(code: unknown): ClaimResult {
    const pending = this.pending;
    if (!pending || typeof code !== 'string') return 'invalid';
    const typed = code.replace(/[^0-9a-z]/gi, '').toUpperCase();
    if (this.now() > pending.until) {
      this.pending = null;
      return 'invalid';
    }
    if (!sameHash(sha256Hex(typed), pending.codeHash)) return 'invalid';
    if (this.records.length >= MAX_EXTENSION_PAIRINGS) return 'full';
    this.pending = null;
    const token = randomBytes(32).toString('base64url');
    const id = `ext-${randomBytes(3).toString('hex')}`;
    const at = new Date(this.now()).toISOString();
    this.records.push({ id, label: pending.label, hash: sha256Hex(token), createdAt: at, lastUsedAt: null });
    this.save();
    return { token, id };
  }

  /** O dono do token (pareamento e nome); null se não existe, revogado ou com outra forma. */
  verify(token: unknown): { id: string; label: string } | null {
    if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) return null;
    const hash = sha256Hex(token);
    const rec = this.records.find((r) => r.hash === hash);
    if (!rec) return null;
    const t = this.now();
    const last = rec.lastUsedAt ? Date.parse(rec.lastUsedAt) : -Infinity;
    if (t - last >= TOUCH_MS) {
      rec.lastUsedAt = new Date(t).toISOString();
      try {
        this.save();
      } catch {
        // O uso é só um carimbo: falha ao gravar não derruba o pedido.
      }
    }
    return { id: rec.id, label: rec.label };
  }

  /** Os pareamentos, só com os metadados (nunca o hash). */
  list(): Array<Pick<PairingRecord, 'id' | 'label' | 'createdAt' | 'lastUsedAt'>> {
    return this.records.map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  /** Revoga um pareamento: o token dele deixa de valer. */
  revoke(id: string): boolean {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.records.splice(i, 1);
    this.save();
    return true;
  }

  /** Grava de forma atômica (tmp + rename), só para o seu usuário (como a chave do pareamento em pairing.ts). */
  private save(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    const content = `${JSON.stringify({ pairings: this.records }, null, 2)}\n`;
    try {
      fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
  }
}
