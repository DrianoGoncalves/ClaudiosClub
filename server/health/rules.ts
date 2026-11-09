import { findSecrets } from '../chat/secrets';

// Regras fixas do health check: padrão de texto, sem IA. Cada função recebe um arquivo (ou a lista
// deles) e devolve achados com o trecho ainda sem máscara; quem mascara é o maskSnippet, no fim.

export type Severity = 'high' | 'medium' | 'low';

export type RuleId =
  | 'hardcoded-secret'
  | 'env-committed'
  | 'client-exposed-secret'
  | 'supabase-no-rls'
  | 'supabase-open-policy'
  | 'firebase-open-rules'
  | 'stripe-webhook-unverified'
  | 'cors-open'
  | 'unauthenticated-endpoint'
  | 'large-file';

export interface Finding {
  rule: RuleId;
  severity: Severity;
  file: string;
  /** Null nos achados de arquivo inteiro. */
  line: number | null;
  snippet: string;
}

export interface SourceFile {
  rel: string;
  text: string;
}

export interface ProjectCtx {
  usesSupabase: boolean;
  hasRootMiddleware: boolean;
}

export const RULES: Record<RuleId, { title: string; why: string; fix: string }> = {
  'hardcoded-secret': {
    title: 'Segredo escrito no código',
    why: 'Quem lê o arquivo ou o repositório fica com a chave. Apagar o trecho não basta: quem viu, viu.',
    fix: 'Tire o valor do código e leia de variável de ambiente. Troque a chave que apareceu, porque ela pode já ter vazado.',
  },
  'env-committed': {
    title: 'Arquivo .env versionado no git',
    why: 'O .env costuma ter senhas e chaves. Estando no git, vai para o histórico e para todo clone.',
    fix: 'Remova o arquivo do git (git rm --cached) e garanta que o .gitignore o cubra. Troque os valores que estavam nele.',
  },
  'client-exposed-secret': {
    title: 'Segredo exposto no front-end',
    why: 'Variáveis com prefixo público (VITE_, NEXT_PUBLIC_…) vão para o navegador. Quem abre o site lê o valor.',
    fix: 'Mova a chave para o servidor e chame a API a partir dele. Troque a chave que foi exposta.',
  },
  'supabase-no-rls': {
    title: 'Tabela do Supabase sem RLS',
    why: 'Sem row level security, qualquer um com a chave pública lê e altera a tabela inteira.',
    fix: 'Ative RLS na tabela (alter table … enable row level security) e crie as policies por usuário.',
  },
  'supabase-open-policy': {
    title: 'Policy do Supabase aberta',
    why: 'Uma policy com using (true) ou with check (true) libera a operação para qualquer um.',
    fix: 'Restrinja a policy ao dono da linha, por exemplo using (auth.uid() = user_id).',
  },
  'firebase-open-rules': {
    title: 'Regra do Firebase aberta',
    why: 'Regra sem condição, com if true ou em modo de teste deixa qualquer um ler ou gravar.',
    fix: 'Troque a regra por uma condição de login e de dono (request.auth != null e request.auth.uid == …).',
  },
  'stripe-webhook-unverified': {
    title: 'Webhook do Stripe sem checar a assinatura',
    why: 'Sem checar a assinatura, qualquer um pode mandar um evento falso (pagamento confirmado sem pagar).',
    fix: 'Valide o evento com stripe.webhooks.constructEvent usando o segredo do webhook antes de agir.',
  },
  'cors-open': {
    title: 'CORS aberto para qualquer origem',
    why: 'Qualquer site consegue chamar a API pelo navegador. Com credenciais, isso vira roubo de sessão.',
    fix: 'Liste as origens permitidas em vez de *. Só habilite credentials para origens conhecidas.',
  },
  'unauthenticated-endpoint': {
    title: 'Rota sem checagem de login',
    why: 'Rota que escreve ou lê dados sem nenhum marcador de autenticação no arquivo pode estar aberta.',
    fix: 'Exija login na rota (middleware ou guarda dela) e confira quem pode chamar. Se a checagem estiver em outro arquivo, confirme.',
  },
  'large-file': {
    title: 'Arquivo grande demais para a checagem',
    why: 'Arquivo muito grande esconde problema e fica difícil de revisar. Acima de 1 MB, o conteúdo nem foi lido.',
    fix: 'Divida o arquivo em módulos menores. Se for gerado, deixe-o fora do git.',
  },
};

export const TEST_PATH = /(^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[^/]+$/;
const PUBLIC_PREFIX = '(?:VITE|NEXT_PUBLIC|REACT_APP|EXPO_PUBLIC|PUBLIC)_';
const PUBLIC_NAME = new RegExp(`\\b${PUBLIC_PREFIX}\\w*`);
const PUBLIC_READ = new RegExp(`\\b(?:import\\.meta\\.env|process\\.env)\\.(${PUBLIC_PREFIX}\\w*)`, 'g');
const PUBLIC_ASSIGN = new RegExp(`^\\s*(?:export\\s+)?(${PUBLIC_PREFIX}\\w*)\\s*=`);
const SENSITIVE_NAME = /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE|SERVICE_KEY/;
const LOOPBACK_URL = /:\/\/[^\s:/@]+:(?:postgres|root|password|secret|admin|test|changeme|example)@(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|host\.docker\.internal)(?![\w.-])/i;
const ENV_FILE = /(^|\/)\.env(\..+)?$/;
const ENV_TEMPLATE = /\.(?:example|sample|template|dist)$/;

const STRIPE = /stripe/i;
const WEBHOOK = /webhook|stripe-signature|checkout\.session\.|event\.type/i;
const STRIPE_VERIFY = /constructEvent|construct_event/;

const CORS_WILDCARD = /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]?\*|\bcors\(\s*\)|\borigin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]/i;
const CORS_REFLECT = /\borigin\s*:\s*true\b|req\.headers\.origin|HTTP_ORIGIN|headers\.get\(\s*['"]origin['"]/i;
const CORS_CREDS = /credentials\s*:\s*true|allow_credentials\s*=\s*True|Allow-Credentials['"]?\s*[:,]\s*['"]?true/i;

const AUTH_MARK = /auth|session|getUser|requireAuth|jwt|passport|getServerSession|clerk|\$_SESSION|is_user_logged_in|current_user_can|wp_verify_nonce/i;
const EXPRESS_WRITE = /\b(?:app|router)\.(?:post|put|patch|delete)\(/;
const EXPRESS_READ = /\b(?:app|router)\.get\(/;
const NEXT_WRITE = /export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b/;
const NEXT_READ = /export\s+(?:async\s+)?function\s+GET\b/;
const PHP_WRITE = /\$_POST|php:\/\/input/;
const PHP_DB = /\b(?:mysqli_|PDO|mysql_query|pg_query)|->query\(/;
const DATA = /prisma\.|supabase\.from|\bdb\.|query\(|\bSELECT\b/;

const POLICY = /\bcreate\s+policy\b([\s\S]*?)(?=;|$)/gi;
const OPEN_CHECK = /\busing\s*\(\s*true\s*\)|\bwith\s+check\s*\(\s*true\s*\)/i;
const CREATE_TABLE = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?(\w+)"?/gi;
const ENABLE_RLS = /\balter\s+table\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(\w+)"?\s+enable\s+row\s+level\s+security/gi;
const DISABLE_RLS = /\balter\s+table\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(\w+)"?\s+disable\s+row\s+level\s+security/gi;
const FIREBASE_FILE = /(?:^|\/)(?:firestore|storage)\.rules$/;
const DB_JSON_FILE = /(?:^|\/)database\.rules\.json$/;
const ALLOW = /\ballow\s+([a-z,\s]+?)\s*(?::\s*if\s+([^;]+?))?\s*;/gi;
const TEST_MODE = /request\.time\s*<\s*timestamp\.date\(/;

const MAX_SNIPPET = 160;
const MAX_LINES = 1000;

/** Trecho sem segredo: segredo vira 4 caracteres + ****, atribuição e senha de URL também; por fim corta. */
export function maskSnippet(text: string): string {
  let out = maskSecrets(text);
  // Nome sensível + valor: sem aspas, até espaço/vírgula; entre aspas, até a aspa (com espaço dentro); JSON com aspas na chave.
  out = out.replace(/((?:pass|secret|token|key|pwd|private|role|credential|auth)\w*['"]?\s*[=:]\s*)(?:(['"])[^'"]*\2?|[^\s,;]+)/gi, '$1****');
  out = out.replace(/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1****@');
  return out.slice(0, MAX_SNIPPET);
}

// Mascara as ocorrências juntando as que se sobrepõem (um trecho pode bater em dois padrões).
function maskSecrets(text: string): string {
  const merged: Array<[number, number]> = [];
  for (const o of findSecrets(text)) {
    const end = o.index + o.length;
    const last = merged.at(-1);
    if (last && o.index <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([o.index, end]);
  }
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += `${text.slice(pos, s)}${text.slice(s, s + 4)}****`;
    pos = e;
  }
  return out + text.slice(pos);
}

/** Achados de um arquivo (as regras que não dependem dos outros arquivos). */
export function checkFile(f: SourceFile, ctx: ProjectCtx): Finding[] {
  return [
    ...hardcodedSecrets(f),
    ...clientExposed(f),
    ...stripeWebhook(f),
    ...corsOpen(f),
    ...unauthenticatedRoutes(f, ctx),
    ...supabasePolicies(f),
    ...firebaseRules(f),
    ...largeLines(f),
  ];
}

/** Achados que dependem de vários arquivos: .env rastreado e tabelas do Supabase. */
export function checkProject(files: SourceFile[], trackedEnv: string[], ctx: ProjectCtx): Finding[] {
  return [...envCommitted(trackedEnv), ...supabaseRls(files, ctx)];
}

/** Arquivo grande demais para ler: achado de arquivo inteiro, sem linha. */
export function tooBigFile(rel: string, bytes: number): Finding {
  return { rule: 'large-file', severity: 'low', file: rel, line: null, snippet: `${bytes} bytes, não varrido` };
}

function hit(rule: RuleId, severity: Severity, file: string, line: number, lines: string[]): Finding {
  return { rule, severity, file, line, snippet: lines[line - 1] ?? '' };
}

/** Número da linha (1-based) de uma posição no texto. */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const worst = (a: Severity, b: Severity) => (RANK[a] <= RANK[b] ? a : b);

function hardcodedSecrets(f: SourceFile): Finding[] {
  const out: Finding[] = [];
  const lines = f.text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // Variável pública com valor secreto é tratada em client-exposed-secret.
    if (PUBLIC_ASSIGN.test(line)) return;
    let severity: Severity | null = null;
    for (const o of findSecrets(line)) {
      const occ = line.slice(o.index, o.index + o.length);
      // Em arquivo de teste o high vira medium no scan.ts (um ponto só para todas as regras).
      const s: Severity = LOOPBACK_URL.test(occ) ? 'low' : 'high';
      severity = severity ? worst(severity, s) : s;
    }
    if (severity) out.push(hit('hardcoded-secret', severity, f.rel, i + 1, lines));
  });
  return out;
}

function clientExposed(f: SourceFile): Finding[] {
  const out: Finding[] = [];
  const lines = f.text.split(/\r?\n/);
  // Modelo de .env com nome e sem valor: não expõe nada, então não entra.
  const envFile = ENV_FILE.test(f.rel) && !ENV_TEMPLATE.test(f.rel);
  lines.forEach((line, i) => {
    const names = [...line.matchAll(PUBLIC_READ)].map((m) => m[1]!);
    const assign = envFile ? PUBLIC_ASSIGN.exec(line) : null;
    if (assign) names.push(assign[1]!);
    let severity: Severity | null = null;
    for (const name of names) {
      if (SENSITIVE_NAME.test(name)) severity = 'high';
      else if (/TOKEN/.test(name) && severity !== 'high') severity = 'medium';
    }
    // Valor com cara de segredo numa linha que fala de variável pública (ex.: sk_live direto no VITE_…).
    if (PUBLIC_NAME.test(line) && findSecrets(line).length) severity = 'high';
    // Atribuição em .env: o snippet é só o nome, montado aqui; a linha inteira (com o valor) não sai.
    if (severity) out.push({ rule: 'client-exposed-secret', severity, file: f.rel, line: i + 1, snippet: assign ? `${assign[1]}=****` : line });
  });
  return out;
}

function envCommitted(tracked: string[]): Finding[] {
  return tracked
    .filter((rel) => ENV_FILE.test(rel) && !ENV_TEMPLATE.test(rel))
    .map((rel) => ({ rule: 'env-committed' as const, severity: 'high' as const, file: rel, line: null, snippet: '' }));
}

function supabaseRls(files: SourceFile[], ctx: ProjectCtx): Finding[] {
  if (!ctx.usesSupabase) return [];
  const sql = files.filter((f) => f.rel.endsWith('.sql')).map((f) => ({ rel: f.rel, text: stripSqlComments(f.text) }));
  const enabled = new Set<string>();
  for (const f of sql) for (const m of f.text.matchAll(ENABLE_RLS)) enabled.add(m[1]!.toLowerCase());
  const out: Finding[] = [];
  for (const f of sql) {
    const lines = f.text.split(/\r?\n/);
    for (const m of f.text.matchAll(CREATE_TABLE)) {
      if (!enabled.has(m[1]!.toLowerCase())) out.push(hit('supabase-no-rls', 'high', f.rel, lineAt(f.text, m.index ?? 0), lines));
    }
    for (const m of f.text.matchAll(DISABLE_RLS)) out.push(hit('supabase-no-rls', 'high', f.rel, lineAt(f.text, m.index ?? 0), lines));
  }
  return out;
}

function supabasePolicies(f: SourceFile): Finding[] {
  if (!f.rel.endsWith('.sql')) return [];
  const text = stripSqlComments(f.text);
  const lines = text.split(/\r?\n/);
  const out: Finding[] = [];
  for (const m of text.matchAll(POLICY)) {
    const body = m[1]!;
    if (!OPEN_CHECK.test(body)) continue;
    // Sem "for" a policy vale para todas as operações.
    const cmd = /\bfor\s+(select|insert|update|delete|all)\b/i.exec(body)?.[1]?.toLowerCase() ?? 'all';
    const line = lineAt(text, m.index ?? 0);
    if (cmd === 'select') out.push(hit('supabase-open-policy', 'medium', f.rel, line, lines));
    else out.push(hit('supabase-open-policy', 'high', f.rel, line, lines));
  }
  return out;
}

function stripSqlComments(text: string): string {
  return text.replace(/--[^\n]*/g, '');
}

function firebaseRules(f: SourceFile): Finding[] {
  const out: Finding[] = [];
  if (DB_JSON_FILE.test(f.rel)) {
    const lines = f.text.split(/\r?\n/);
    for (const m of f.text.matchAll(/"\.write"\s*:\s*true\b/g)) out.push(hit('firebase-open-rules', 'high', f.rel, lineAt(f.text, m.index ?? 0), lines));
    for (const m of f.text.matchAll(/"\.read"\s*:\s*true\b/g)) out.push(hit('firebase-open-rules', 'medium', f.rel, lineAt(f.text, m.index ?? 0), lines));
    return out;
  }
  if (!FIREBASE_FILE.test(f.rel)) return out;
  const text = f.text.replace(/\/\/[^\n]*/g, '');
  const lines = text.split(/\r?\n/);
  for (const m of text.matchAll(ALLOW)) {
    const ops = m[1]!.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const cond = m[2]?.trim();
    const open = cond === undefined || cond === 'true';
    const line = lineAt(text, m.index ?? 0);
    if (open && ops.some((o) => ['write', 'create', 'update', 'delete'].includes(o))) out.push(hit('firebase-open-rules', 'high', f.rel, line, lines));
    else if (open && ops.some((o) => ['read', 'get', 'list'].includes(o))) out.push(hit('firebase-open-rules', 'medium', f.rel, line, lines));
  }
  for (const m of text.matchAll(new RegExp(TEST_MODE.source, 'g'))) out.push(hit('firebase-open-rules', 'high', f.rel, lineAt(text, m.index ?? 0), lines));
  return out;
}

function stripeWebhook(f: SourceFile): Finding[] {
  if (!STRIPE.test(f.text) || !WEBHOOK.test(f.text) || STRIPE_VERIFY.test(f.text)) return [];
  const lines = f.text.split(/\r?\n/);
  const first = lines.findIndex((l) => WEBHOOK.test(l));
  return [hit('stripe-webhook-unverified', 'high', f.rel, first === -1 ? 1 : first + 1, lines)];
}

function corsOpen(f: SourceFile): Finding[] {
  const lines = f.text.split(/\r?\n/);
  const reflectLine = lines.findIndex((l) => CORS_REFLECT.test(l));
  const wildcardLine = lines.findIndex((l) => CORS_WILDCARD.test(l));
  // Origem refletida com credenciais: qualquer site lê a resposta autenticada.
  if (reflectLine !== -1 && CORS_CREDS.test(f.text)) return [hit('cors-open', 'high', f.rel, reflectLine + 1, lines)];
  if (wildcardLine !== -1) return [hit('cors-open', 'medium', f.rel, wildcardLine + 1, lines)];
  return [];
}

function unauthenticatedRoutes(f: SourceFile, ctx: ProjectCtx): Finding[] {
  if (AUTH_MARK.test(f.text)) return [];
  const lines = f.text.split(/\r?\n/);
  const nextRoute = NEXT_WRITE.test(f.text) || NEXT_READ.test(f.text);
  // Next com middleware na raiz: as rotas passam por ele antes.
  if (nextRoute && ctx.hasRootMiddleware) return [];
  const firstLine = (re: RegExp) => lines.findIndex((l) => re.test(l));

  const writeLine = firstLine(EXPRESS_WRITE) !== -1 ? firstLine(EXPRESS_WRITE) : firstLine(NEXT_WRITE);
  if (writeLine !== -1) return [hit('unauthenticated-endpoint', 'medium', f.rel, writeLine + 1, lines)];
  if (PHP_WRITE.test(f.text) && PHP_DB.test(f.text)) return [hit('unauthenticated-endpoint', 'medium', f.rel, firstLine(PHP_WRITE) + 1, lines)];

  const readLine = firstLine(EXPRESS_READ) !== -1 ? firstLine(EXPRESS_READ) : firstLine(NEXT_READ);
  if (readLine !== -1 && DATA.test(f.text)) return [hit('unauthenticated-endpoint', 'low', f.rel, readLine + 1, lines)];
  return [];
}

function largeLines(f: SourceFile): Finding[] {
  const count = f.text.split('\n').length;
  if (count <= MAX_LINES) return [];
  return [{ rule: 'large-file', severity: 'low', file: f.rel, line: MAX_LINES + 1, snippet: `${count} linhas` }];
}
