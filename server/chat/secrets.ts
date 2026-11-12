// Guarda de segredos: procura, no que passa pelas conversas do Claudio’s Club (o que você escreve, os comandos
// que o funcionário roda e o que eles devolvem), coisas com cara de segredo. Não bloqueia nada: avisa
// na caixa "precisa de mim" para você trocar a senha/token e não colar de novo. O segredo em si nunca
// é guardado nem mostrado: só o tipo, o contexto que não é segredo (nome do comando, da variável, o host) e onde apareceu.

import type { SecretKind, SecretSource } from '../../shared/model';

// Os tipos moram no shared (o cliente monta a frase do aviso); aqui só se reexportam.
export type { SecretKind, SecretSource };

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
};

const envLabel = (m: RegExpMatchArray) => (VAR_NAME.test(m[1]!) ? `senha na variável ${m[1]}` : 'senha numa variável de ambiente');
const envDetail = (m: RegExpMatchArray) => (VAR_NAME.test(m[1]!) ? m[1] : undefined);

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
  { kind: 'password-cli', label: (m) => `senha no comando ${m[1]!.toLowerCase()} (-p)`, detail: (m) => m[1]!.toLowerCase(), re: /\b(mysql|mariadb|mysqldump)\b[^\n]*\s-p(?!\s)(?![$<{%])[^\s'"]{4,}/i },
  { kind: 'password-cli', label: 'senha em --password', re: /--password[= ](?![$<{%])['"]?[^\s'"$<{%]{4,}/i },
  { kind: 'password-env', label: envLabel, detail: envDetail, re: /\b(DB_PASS(?:WORD)?|MYSQL_(?:ROOT_)?PASSWORD|POSTGRES_PASSWORD|PASSWORD|PASSWD|PGPASSWORD)\s*[=:]\s*['"]?(?![$<{%*])[^\s'"$<{%*]{6,}/ },
  // Variável com prefixo (MY_DB_PASSWORD=, SMTP_PASSWORD="…"): só no formato .env/shell, com `=` e valor sem espaço.
  // Sem isso, FORGOT_PASSWORD: 'Esqueci a senha' e RESET_PASSWORD_LABEL= viravam aviso. Sem PASS sozinho (nome curto demais).
  { kind: 'password-env', label: envLabel, detail: envDetail, re: /\b((?:[A-Z0-9]+_)+(?:DB_PASS(?:WORD)?|PASSWORD|PASSWD))\s*=\s*(?:"[^"\s$<{%*]{6,}"|'[^'\s$<{%*]{6,}'|[^\s'"$<{%*]{6,})/ },
  // Conexão com usuário e senha na URL: postgres://user:senha@host. O rótulo leva só o host, nunca user nem senha.
  { kind: 'password-url', label: (m) => { const host = connHost(m[1]); return host ? `senha numa URL de conexão (host ${host})` : 'senha numa URL de conexão'; }, detail: (m) => connHost(m[1]) ?? undefined, re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?![$<{%*])[^\s:@/]{4,}@([^\s/]+)/i },
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
