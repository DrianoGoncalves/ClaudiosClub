// Guarda de segredos: procura, no que passa pelas conversas do Claudio’s Club (o que você escreve, os comandos
// que o funcionário roda e o que eles devolvem), coisas com cara de segredo. Não bloqueia nada: avisa
// na caixa "precisa de mim" para você trocar a senha/token e não colar de novo. O segredo em si nunca
// é guardado nem mostrado: só o tipo, o contexto que não é segredo (nome do comando, da variável, o host), onde apareceu,
// o palpite local de ser real ou exemplo (`scanSecrets`) e uma dica mascarada com no máximo 4 caracteres do valor.

import { createHmac } from 'node:crypto';
import type { SecretHint, SecretKind, SecretReason, SecretSource, SecretVerdict } from '../../shared/model';

// Os tipos moram no shared (o cliente monta a frase do aviso); aqui só se reexportam.
export type { SecretHint, SecretKind, SecretReason, SecretSource, SecretVerdict };

export interface SecretFinding {
  kind: SecretKind;
  /**
   * Tipo com o contexto que não é segredo, em português: "chave de API da Anthropic", "senha no comando mysql (-p)",
   * "senha na variável DB_PASSWORD", "senha numa URL de conexão (host db:5432)". Nunca traz o valor.
   */
  label: string;
  /**
   * Contexto estável para o cliente traduzir: provedor da chave ('anthropic', 'github'…), comando (mysql…),
   * nome da variável, host da URL. Ausente quando o padrão não tem contexto (`--password`, variável genérica).
   */
  detail?: string;
}

const VAR_NAME = /^[A-Z0-9_]{1,40}$/;
const CONN_HOST = /^[\w.\-:\[\]]{1,80}$/;

/** Host de uma URL de conexão, se ele é um host de verdade (sem aspas nem lixo em volta); senão null. */
function connHost(raw: string | undefined): string | null {
  const host = (raw ?? '').split(/['"),;]/)[0] ?? '';
  return CONN_HOST.test(host) ? host : null;
}

type Pattern = {
  kind: SecretKind;
  /** Rótulo fixo, ou montado do trecho casado (comando, variável, host): nunca o valor. */
  label: string | ((m: RegExpMatchArray) => string);
  /** Contexto estável (ver `SecretFinding.detail`); fixo ou tirado do trecho casado. */
  detail?: string | ((m: RegExpMatchArray) => string | undefined);
  re: RegExp;
  // `token`: chave gerada (aleatória). Uma com cara de teste (letra repetida, alfabeto em sequência,
  // "EXAMPLE") não é segredo: é exemplo de documentação ou fixture de teste lido pelo funcionário.
  token?: boolean;
  /** O valor da senha dentro do trecho casado (só para o palpite e a dica; nunca sai de `scanSecrets`). Sem ele, vale o trecho inteiro. */
  value?: (m: RegExpMatchArray) => string | null;
  /** O host da conexão, quando o trecho casado o traz (`mysql -h`, URL de conexão): ajuda a dizer se é local ou de verdade. */
  host?: (m: RegExpMatchArray) => string | null;
};

const envLabel = (m: RegExpMatchArray) => (VAR_NAME.test(m[1]!) ? `senha na variável ${m[1]}` : 'senha numa variável de ambiente');
const envDetail = (m: RegExpMatchArray) => (VAR_NAME.test(m[1]!) ? m[1] : undefined);
/** O valor de `NOME=valor` / `NOME: valor` (o nome nunca tem `=` nem `:`), sem as aspas em volta. */
const envValue = (m: RegExpMatchArray) => m[0].replace(/^[^=:]*[=:]\s*/, '').replace(/^['"]+|['"]+$/g, '') || null;

const PATTERNS: Pattern[] = [
  { kind: 'private-key', label: 'chave privada', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { kind: 'api-key', label: 'chave de API da Anthropic', detail: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, token: true },
  { kind: 'api-key', label: 'chave de API da OpenAI', detail: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g, token: true },
  { kind: 'api-key', label: 'token do GitHub', detail: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g, token: true },
  { kind: 'api-key', label: 'chave da AWS', detail: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g, token: true },
  { kind: 'api-key', label: 'token do Slack', detail: 'slack', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}/g, token: true },
  { kind: 'api-key', label: 'chave do Stripe', detail: 'stripe', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g, token: true },
  { kind: 'api-key', label: 'chave do Google', detail: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, token: true },
  // Senha na linha de comando: mysql -pSEGREDO, --password=SEGREDO, PASSWORD=SEGREDO (não placeholders).
  {
    kind: 'password-cli',
    label: (m) => `senha no comando ${m[1]!.toLowerCase()} (-p)`,
    detail: (m) => m[1]!.toLowerCase(),
    re: /\b(mysql|mariadb|mysqldump)\b[^\n]*\s-p(?!\s)(?![$<{%])[^\s'"]{4,}/i,
    value: (m) => /\s-p([^\s'"]+)$/.exec(m[0])?.[1] ?? null,
    host: (m) => /\s(?:-h\s*|--host[= ])['"]?([^\s'"]+)/i.exec(m[0])?.[1] ?? null,
  },
  { kind: 'password-cli', label: 'senha em --password', re: /--password[= ](?![$<{%])['"]?[^\s'"$<{%]{4,}/i, value: (m) => m[0].replace(/^--password[= ]['"]?/i, '') },
  { kind: 'password-env', label: envLabel, detail: envDetail, re: /\b(DB_PASS(?:WORD)?|MYSQL_(?:ROOT_)?PASSWORD|POSTGRES_PASSWORD|PASSWORD|PASSWD|PGPASSWORD)\s*[=:]\s*['"]?(?![$<{%*])[^\s'"$<{%*]{6,}/, value: envValue },
  // Variável com prefixo (MY_DB_PASSWORD=, SMTP_PASSWORD="…"): só no formato .env/shell, com `=` e valor sem espaço.
  // Sem isso, FORGOT_PASSWORD: 'Esqueci a senha' e RESET_PASSWORD_LABEL= viravam aviso. Sem PASS sozinho (nome curto demais).
  { kind: 'password-env', label: envLabel, detail: envDetail, re: /\b((?:[A-Z0-9]+_)+(?:DB_PASS(?:WORD)?|PASSWORD|PASSWD))\s*=\s*(?:"[^"\s$<{%*]{6,}"|'[^'\s$<{%*]{6,}'|[^\s'"$<{%*]{6,})/, value: envValue },
  // Conexão com usuário e senha na URL: postgres://user:senha@host. O rótulo leva só o host, nunca user nem senha.
  {
    kind: 'password-url',
    label: (m) => { const host = connHost(m[1]); return host ? `senha numa URL de conexão (host ${host})` : 'senha numa URL de conexão'; },
    detail: (m) => connHost(m[1]) ?? undefined,
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?![$<{%*])[^\s:@/]{4,}@([^\s/]+)/i,
    value: (m) => /^[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s:@/]+)@/i.exec(m[0])?.[1] ?? null,
    host: (m) => connHost(m[1]),
  },
];

// Cópias globais, feitas uma vez: findSecrets roda por linha, e recriar a regex a cada chamada custava à toa.
const GLOBAL_PATTERNS = PATTERNS.map((p) => ({ ...p, re: new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`) }));

function labelOf(p: Pattern, m: RegExpMatchArray): string {
  return typeof p.label === 'function' ? p.label(m) : p.label;
}

function finding(p: Pattern, m: RegExpMatchArray): SecretFinding {
  const detail = typeof p.detail === 'function' ? p.detail(m) : p.detail;
  return { kind: p.kind, label: labelOf(p, m), ...(detail && { detail }) };
}

/** O primeiro segredo encontrado no texto, ou null. */
export function findSecret(text: string): SecretFinding | null {
  if (!text || text.length < 8) return null;
  for (const p of PATTERNS) {
    if (!p.token) {
      const m = p.re.exec(text);
      if (m) return finding(p, m);
      continue;
    }
    for (const m of text.matchAll(p.re)) if (!looksFake(m[0])) return finding(p, m);
  }
  return null;
}

/**
 * O rótulo da versão anterior (genérico: "uma senha"). O "não é segredo" gravado em inbox.json casa pelo
 * texto do rótulo; sem isso, a dispensa de antes deixaria de valer quando o rótulo ganhou o contexto.
 */
export function legacyLabel(label: string): string | null {
  if (label.startsWith('senha numa URL de conexão')) return 'uma senha numa URL de conexão';
  if (label.startsWith('senha ')) return 'uma senha';
  return LEGACY_LABELS[label] ?? null;
}

const LEGACY_LABELS: Record<string, string> = {
  'chave privada': 'uma chave privada',
  'chave de API da Anthropic': 'uma chave da API da Anthropic',
  'chave de API da OpenAI': 'uma chave da OpenAI',
  'token do GitHub': 'um token do GitHub',
  'chave da AWS': 'uma chave da AWS',
  'token do Slack': 'um token do Slack',
  'chave do Stripe': 'uma chave do Stripe',
  'chave do Google': 'uma chave do Google',
};

/** Todas as ocorrências no texto, com posição (o health check mascara cada uma). */
export function findSecrets(text: string): Array<{ label: string; index: number; length: number }> {
  const out: Array<{ label: string; index: number; length: number }> = [];
  if (!text) return out;
  for (const p of GLOBAL_PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      if (p.token && looksFake(m[0])) continue;
      out.push({ label: labelOf(p, m), index: m.index ?? 0, length: m[0].length });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---- Palpite (real ou exemplo) e dica mascarada: heurística local e determinística, feita na detecção ----
// É o único momento em que o valor está em memória. Sem IA, sem testar a credencial no provedor, sem reler transcript.

/** Gravidade: um achado mais grave substitui o aviso que já existe (ver `ChatManager.noteSecret`). */
const RANK: Record<SecretVerdict, number> = { example: 0, local: 1, unknown: 2, exposed: 3 };

/** `true` se `a` é mais grave que `b`. */
export function worseVerdict(a: SecretVerdict, b: SecretVerdict): boolean {
  return RANK[a] > RANK[b];
}

/** Senhas padrão conhecidas (minúsculas). `root:root@host` num texto é quase sempre exemplo ou ambiente de dev. */
const DEFAULT_PASSWORDS = new Set([
  'root', 'toor', 'admin', 'administrator', 'password', 'passwd', 'pass', 'secret', 'changeme', 'change-me', 'change_me', 'default', 'test', 'testing', 'guest',
  'postgres', 'mysql', 'letmein', 'welcome', 'qwerty', 'abc123', 'senha', 'senha123', 'password1', 'password123', 'admin123', 'admin1234',
  '1234', '12345', '123456', '1234567', '12345678', '123456789', '1234567890',
]);

/** Valor de enchimento, não credencial: `xxxx`, `your-password`, `YOUR_DB_PASSWORD_HERE`, `exemplo123`, `redacted`. */
const PLACEHOLDER = /^(?:(?:x|\*|\.|0|-|_|#){3,}|(?:your|sua|seu)[-_]?(?:db|pass(?:word)?|senha|secret|token|key)[\w-]*|(?:my|minha)[-_]?(?:pass(?:word)?|senha|secret)[\w-]*|[\w-]+[-_](?:here|aqui)|(?:example|exemplo|sample|dummy|fake|placeholder|redacted)[\w-]*)$/i;

/** Arquivo de modelo: `.env.example`, `config.sample.php`, `docker-compose.template.yml`. */
const EXAMPLE_NAME = /(?:^|[._-])(?:example|exemplo|sample|template|dist)(?:[._-]|$)/i;
/** Pasta de teste (`tests/`, `__tests__/`, `fixtures/`, `__mocks__/`…). */
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|specs?|__mocks__|mocks?|fixtures?|testdata|e2e)(?:\/|$)/i;
/** Arquivo de teste (`a.test.ts`, `a.spec.js`, `test_a.py`, `a_test.go`). */
const TEST_NAME = /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i;

/** Prefixos públicos dos provedores (parte do formato, não do segredo): é o que a dica mostra antes dos últimos 4 caracteres. */
const PUBLIC_PREFIX = /^(?:sk-ant-|sk-proj-|sk-|(?:ghp|gho|ghu|ghs|ghr)_|github_pat_|AKIA|xox[abpors]-|(?:sk|rk)_live_|AIza)/;

/** Caminho relativo à pasta da conversa; absoluto fora dela vira só o nome (o resto do caminho não diz nada sobre o projeto). */
function projectRel(file: string, cwd?: string): string {
  const f = file.replace(/\\/g, '/');
  const c = cwd?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (c && f.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return f.slice(c.length + 1);
  return /^(?:[a-z]:)?\//i.test(f) ? f.slice(f.lastIndexOf('/') + 1) : f.replace(/^\.\//, '');
}

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

/** `local`: loopback ou de desenvolvimento; `example`: reservado para documentação; `other`: IP ou domínio de verdade; null: nome simples (`db`), que não diz nada. */
function hostClass(raw: string): 'local' | 'example' | 'other' | null {
  let h = raw.toLowerCase();
  if (h === '::1') return 'local';
  if (h.startsWith('[')) h = h.slice(1).split(']')[0] ?? '';
  else h = h.replace(/:\d+$/, '');
  if (!h) return null;
  if (h === '::1' || h === 'localhost' || h === '0.0.0.0' || /^127\./.test(h) || /\.(?:localhost|local|test)$/.test(h)) return 'local';
  if (/(?:^|\.)example\.(?:com|org|net)$/.test(h) || /\.(?:example|invalid)$/.test(h)) return 'example';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes('.')) return 'other';
  return null;
}

/** Senha longa (12+) e variada (3 de 4 tipos de caractere): não parece escrita à mão para um exemplo. */
function strongValue(v: string): boolean {
  if (v.length < 12) return false;
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length >= 3;
}

function verdictOf(p: Pattern, m: RegExpMatchArray, value: string, file: string | null): { verdict: SecretVerdict; reason: SecretReason; isDefault: boolean } {
  const out = (verdict: SecretVerdict, reason: SecretReason, isDefault = false) => ({ verdict, reason, isDefault });
  if (p.kind === 'private-key') return file && EXAMPLE_NAME.test(baseName(file)) ? out('example', 'example-file') : out('exposed', 'private-key');
  // Token de provedor com formato válido nunca é "exemplo", nem em .env.example nem em teste: chave de verdade vaza assim.
  if (p.token) return looksFake(value) ? out('example', 'fake-token') : out('exposed', 'provider-format');
  const isDefault = DEFAULT_PASSWORDS.has(value.toLowerCase());
  const host = p.host?.(m);
  const hc = host ? hostClass(host) : null;
  if (file && EXAMPLE_NAME.test(baseName(file))) return out('example', 'example-file', isDefault);
  if (file && (TEST_DIR.test(file) || TEST_NAME.test(baseName(file)))) return out('example', 'test-file', isDefault);
  if (PLACEHOLDER.test(value)) return out('example', 'placeholder', isDefault);
  // Senha padrão num host de verdade (`admin:admin@db.empresa.com`) é uma credencial real e fraca, não um exemplo.
  if (isDefault) return hc === 'other' ? out('exposed', 'other-host', true) : out('example', 'default-password', true);
  if (hc === 'example') return out('example', 'example-host');
  if (hc === 'local') return out('local', 'local-host');
  if (hc === 'other') return out('exposed', 'other-host');
  if (strongValue(value)) return out('exposed', 'strong-value');
  return out('unknown', 'no-context');
}

/** A dica mascarada (ver `SecretHint`): nunca mais de 4 caracteres do valor, e em senha nunca início e fim juntos. */
function hintOf(p: Pattern, value: string, isDefault: boolean): SecretHint | undefined {
  if (p.kind === 'private-key') return undefined;
  if (p.token) {
    const prefix = PUBLIC_PREFIX.exec(value)?.[0];
    return { ...(prefix && { prefix }), tail: value.slice(-4), length: value.length };
  }
  if (isDefault) return { isDefault: true };
  return value.length >= 12 ? { tail: value.slice(-2), length: value.length } : { length: value.length };
}

export interface SecretContext {
  /** O arquivo da ferramenta onde o texto apareceu, como o motor o deu (absoluto ou relativo à `cwd`). Conta para "modelo" e "teste". */
  file?: string | null;
  cwd?: string;
  /** Sal da instalação para a identidade da ocorrência (ver `ClassifiedSecret.occurrence`). */
  pepper?: string;
}

export interface ClassifiedSecret extends SecretFinding {
  verdict: SecretVerdict;
  reason: SecretReason;
  /** Ausente em chave privada. */
  hint?: SecretHint;
  /**
   * Identidade da ocorrência: HMAC do valor (com sal da instalação), cortado em 48 bits. Só serve para "não é segredo" valer para aquela
   * ocorrência e não para o rótulo todo; não dá para recuperar o valor dele. Fica no servidor: nunca vai no item da caixa, no log nem na extensão.
   */
  occurrence: string;
}

/** Teto de ocorrências por padrão em um texto: um log com a mesma variável mil vezes não pesa. */
const MAX_MATCHES = 100;

/**
 * Todos os segredos do texto, um por rótulo (a ocorrência mais grave de cada), do mais grave ao menos grave, com palpite e dica.
 * Diferente de `findSecret`: o token com cara de exemplo também sai (como `example`), e um exemplo não esconde um real no mesmo texto.
 * Quem bloqueia algo (instalar skill, salvar MCP…) segue com `findSecret`, que ignora o exemplo.
 */
export function scanSecrets(text: string, ctx: SecretContext = {}): ClassifiedSecret[] {
  if (!text || text.length < 8) return [];
  const file = ctx.file ? projectRel(ctx.file, ctx.cwd) : null;
  type Best = { finding: SecretFinding; v: ReturnType<typeof verdictOf>; value: string; p: Pattern; ident: string };
  const best = new Map<string, Best>();
  for (const p of GLOBAL_PATTERNS) {
    let n = 0;
    for (const m of text.matchAll(p.re)) {
      if (++n > MAX_MATCHES) break;
      const label = labelOf(p, m);
      const cur = best.get(label);
      if (cur?.v.verdict === 'exposed') continue; // não há mais grave
      const value = (p.token ? m[0] : p.value?.(m)) ?? m[0];
      const v = verdictOf(p, m, value, file);
      if (cur && !worseVerdict(v.verdict, cur.v.verdict)) continue;
      // Chave privada: o trecho casado é só o cabeçalho (igual em toda chave); o começo do corpo distingue uma da outra.
      const ident = p.kind === 'private-key' ? text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 80) : value;
      best.set(label, { finding: finding(p, m), v, value, p, ident });
    }
  }
  return [...best.values()]
    .sort((a, b) => RANK[b.v.verdict] - RANK[a.v.verdict])
    .map(({ finding: f, v, value, p, ident }) => {
      const hint = hintOf(p, value, v.isDefault);
      const occurrence = createHmac('sha256', ctx.pepper ?? '').update(f.label).update('\0').update(ident).digest('hex').slice(0, 12);
      return { ...f, verdict: v.verdict, reason: v.reason, ...(hint && { hint }), occurrence };
    });
}

const WHERE: Record<SecretSource, string> = {
  owner: 'na sua mensagem',
  'staff-reply': 'na resposta do funcionário',
  'tool-input': 'no comando que o funcionário rodou',
  'tool-result': 'na saída de um comando',
};

/**
 * Frase do aviso "precisa de mim": o rótulo com maiúscula e onde apareceu (sem origem, "no chat").
 * Recebe só o rótulo de `findSecret`, então o valor do segredo não entra aqui.
 */
export function secretAlert(label: string, source?: SecretSource): string {
  const where = source ? WHERE[source] : 'no chat';
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} apareceu ${where}: troque e não cole segredos na conversa`;
}

/**
 * Parte aleatória com cara de teste: poucas letras diferentes (`AAAA…`), o alfabeto em sequência
 * (`abcdef…`, `0123…`) ou uma palavra de exemplo. Chave de verdade é aleatória e não cai em nada disso.
 */
export function looksFake(token: string): boolean {
  if (/example|exemplo|dummy|fake|xxxx/i.test(token)) return true;
  // A parte gerada: o trecho alfanumérico mais longo (sem o prefixo "sk-ant-", "ghp_"…).
  const body = token.split(/[_-]/).reduce((a, b) => (b.length > a.length ? b : a), '');
  if (body.length < 8) return false;
  if (new Set(body).size <= 4) return true;
  let steps = 0;
  for (let i = 1; i < body.length; i++) if (body.charCodeAt(i) - body.charCodeAt(i - 1) === 1) steps++;
  return steps / (body.length - 1) >= 0.6;
}
