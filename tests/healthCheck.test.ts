import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maskSnippet, type RuleId } from '../server/health/rules';
import { checkProjectHealth, type HealthOptions, type HealthReport } from '../server/health/scan';

/** Texto com cara de chave aleatória, gerado na hora (mesmo truque de secrets.test.ts). */
const noise = (n: number) => Array.from({ length: n }, (_, i) => 'q7Xz2LmP9wKd4RtB'[(i * 7) % 16]).join('');

const dirs: string[] = [];

async function makeProject(files: Record<string, string>, extra: { git?: boolean; track?: string[] }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-health-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  }
  if (extra.git || extra.track) execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  // `add` só para o git listar como rastreado; não há commit.
  if (extra.track?.length) execFileSync('git', ['add', '-f', '--', ...extra.track], { cwd: dir, windowsHide: true });
  return dir;
}

async function run(files: Record<string, string>, extra: { git?: boolean; track?: string[]; limits?: HealthOptions } = {}): Promise<HealthReport> {
  const dir = await makeProject(files, extra);
  return checkProjectHealth(dir, extra.limits);
}

const rule = (r: HealthReport, id: RuleId) => r.findings.filter((f) => f.rule === id);

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 3 });
});

describe('hardcoded-secret', () => {
  it('chave de produção no código é alta, com a linha', async () => {
    const r = await run({ 'src/pay.ts': `const ok = 1;\nconst k = '${'sk_live_'}${noise(24)}';\n` });
    expect(rule(r, 'hardcoded-secret')).toEqual([expect.objectContaining({ severity: 'high', file: 'src/pay.ts', line: 2 })]);
  });

  it('variável de ambiente e placeholder não acusam', async () => {
    const r = await run({ 'src/a.ts': 'const k = process.env.STRIPE_KEY;\nDB_PASSWORD=<sua senha>\n' });
    expect(rule(r, 'hardcoded-secret')).toEqual([]);
  });

  it('URL de loopback com senha padrão é baixa, não alta', async () => {
    const r = await run({ 'src/db.ts': "const url = 'postgres://postgres:postgres@127.0.0.1:5432/db';\n" });
    expect(rule(r, 'hardcoded-secret')).toEqual([expect.objectContaining({ severity: 'low' })]);
  });

  it('em arquivo de teste é média', async () => {
    const r = await run({ 'tests/api.test.ts': `const k = '${'sk_live_'}${noise(24)}';\n` });
    expect(rule(r, 'hardcoded-secret')).toEqual([expect.objectContaining({ severity: 'medium' })]);
  });
});

describe('env-committed', () => {
  it('.env rastreado pelo git é alto e sem linha', async () => {
    const r = await run({ '.env': 'DATABASE_URL=x\n' }, { git: true, track: ['.env'] });
    expect(rule(r, 'env-committed')).toEqual([expect.objectContaining({ severity: 'high', file: '.env', line: null, snippet: '' })]);
  });

  it('.env.example rastreado não entra', async () => {
    const r = await run({ '.env.example': 'DATABASE_URL=\n' }, { git: true, track: ['.env.example'] });
    expect(rule(r, 'env-committed')).toEqual([]);
  });

  it('.env ignorado pelo .gitignore não é lido nem acusado', async () => {
    const r = await run({ '.gitignore': '.env\n', '.env': `PASSWORD=${noise(12)}\n` }, { git: true });
    expect(rule(r, 'env-committed')).toEqual([]);
    expect(r.findings.some((f) => f.file === '.env')).toBe(false);
  });
});

describe('client-exposed-secret', () => {
  it('nome sensível com prefixo público é alto', async () => {
    const r = await run({ 'src/app.ts': 'const k = import.meta.env.VITE_PAYMENT_SECRET;\n' });
    expect(rule(r, 'client-exposed-secret')).toEqual([expect.objectContaining({ severity: 'high', line: 1 })]);
  });

  it('nome com TOKEN é médio', async () => {
    const r = await run({ 'src/api.ts': 'const t = process.env.NEXT_PUBLIC_API_TOKEN;\n' });
    expect(rule(r, 'client-exposed-secret')).toEqual([expect.objectContaining({ severity: 'medium' })]);
  });

  it('chave pública por design (anon) não entra', async () => {
    const r = await run({ 'src/sb.ts': 'const u = import.meta.env.VITE_SUPABASE_ANON_KEY;\n' });
    expect(rule(r, 'client-exposed-secret')).toEqual([]);
  });

  it('valor com cara de segredo numa variável pública é alto', async () => {
    const r = await run({ 'src/cfg.ts': `export const cfg = { VITE_KEY: '${'sk_live_'}${noise(24)}' };\n` });
    expect(rule(r, 'client-exposed-secret')).toEqual([expect.objectContaining({ severity: 'high' })]);
  });
});

describe('supabase-no-rls', () => {
  const pkg = JSON.stringify({ dependencies: { '@supabase/supabase-js': '^2.0.0' } });

  it('tabela criada sem enable row level security é alta', async () => {
    const r = await run({ 'package.json': pkg, 'supabase/migrations/001.sql': 'create table public.notes (id int);\n' });
    expect(rule(r, 'supabase-no-rls')).toEqual([expect.objectContaining({ severity: 'high', file: 'supabase/migrations/001.sql', line: 1 })]);
  });

  it('com enable em outro .sql não acusa', async () => {
    const r = await run({
      'package.json': pkg,
      'supabase/migrations/001.sql': 'create table public.notes (id int);\n',
      'supabase/migrations/002.sql': 'alter table public.notes enable row level security;\n',
    });
    expect(rule(r, 'supabase-no-rls')).toEqual([]);
  });

  it('sem Supabase no projeto a regra nem roda', async () => {
    const r = await run({ 'db/001.sql': 'create table notes (id int);\n' });
    expect(rule(r, 'supabase-no-rls')).toEqual([]);
  });
});

describe('supabase-open-policy', () => {
  it('policy de escrita com using/with check (true) é alta', async () => {
    const r = await run({ 'supabase/migrations/003.sql': 'create policy "todos" on notes\n  for insert with check (true);\n' });
    expect(rule(r, 'supabase-open-policy')).toEqual([expect.objectContaining({ severity: 'high', line: 1 })]);
  });

  it('leitura aberta é média', async () => {
    const r = await run({ 'supabase/migrations/004.sql': 'create policy "ler" on notes for select using (true);\n' });
    expect(rule(r, 'supabase-open-policy')).toEqual([expect.objectContaining({ severity: 'medium' })]);
  });

  it('policy por dono não acusa', async () => {
    const r = await run({ 'supabase/migrations/005.sql': 'create policy "dono" on notes for all using (auth.uid() = user_id);\n' });
    expect(rule(r, 'supabase-open-policy')).toEqual([]);
  });
});

describe('firebase-open-rules', () => {
  const fs1 = (cond: string) =>
    `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{d}/documents {\n    match /x/{id} {\n      allow read, write: ${cond};\n    }\n  }\n}\n`;

  it('escrita sem condição ou com if true é alta', async () => {
    const r = await run({ 'firestore.rules': fs1('if true') });
    expect(rule(r, 'firebase-open-rules')).toEqual([expect.objectContaining({ severity: 'high', line: 5 })]);
  });

  it('modo de teste (data até uma data) é alto', async () => {
    const r = await run({ 'firestore.rules': fs1('if request.time < timestamp.date(2030, 1, 1)') });
    expect(rule(r, 'firebase-open-rules')).toEqual([expect.objectContaining({ severity: 'high' })]);
  });

  it('regra com request.auth não acusa', async () => {
    const r = await run({ 'firestore.rules': fs1('if request.auth != null') });
    expect(rule(r, 'firebase-open-rules')).toEqual([]);
  });

  it('só leitura aberta é média', async () => {
    const r = await run({ 'storage.rules': 'service firebase.storage {\n  match /b {\n    allow read: if true;\n  }\n}\n' });
    expect(rule(r, 'firebase-open-rules')).toEqual([expect.objectContaining({ severity: 'medium' })]);
  });

  it('database.rules.json com .write true é alto', async () => {
    const r = await run({ 'database.rules.json': '{\n  "rules": {\n    ".read": false,\n    ".write": true\n  }\n}\n' });
    expect(rule(r, 'firebase-open-rules')).toEqual([expect.objectContaining({ severity: 'high', line: 4 })]);
  });
});

describe('stripe-webhook-unverified', () => {
  it('webhook do Stripe sem constructEvent é alto', async () => {
    const r = await run({ 'api/webhook.js': "// webhook do stripe\nconst event = req.body;\nif (event.type === 'checkout.session.completed') done();\n" });
    expect(rule(r, 'stripe-webhook-unverified')).toEqual([expect.objectContaining({ severity: 'high', line: 1 })]);
  });

  it('com constructEvent não acusa', async () => {
    const r = await run({ 'api/webhook.js': '// webhook do stripe\nconst ev = stripe.webhooks.constructEvent(body, sig, secret);\n' });
    expect(rule(r, 'stripe-webhook-unverified')).toEqual([]);
  });
});

describe('cors-open', () => {
  it('origem * é média', async () => {
    const r = await run({ 'server.ts': "import cors from 'cors';\napp.use(cors());\n" });
    expect(rule(r, 'cors-open')).toEqual([expect.objectContaining({ severity: 'medium', line: 2 })]);
  });

  it('origem fixa não acusa', async () => {
    const r = await run({ 'server.ts': "app.use(cors({ origin: 'https://x.com' }));\n" });
    expect(rule(r, 'cors-open')).toEqual([]);
  });

  it('origem refletida com credentials é alta', async () => {
    const r = await run({ 'server.ts': 'app.use(cors({ origin: true, credentials: true }));\n' });
    expect(rule(r, 'cors-open')).toEqual([expect.objectContaining({ severity: 'high' })]);
  });
});

describe('unauthenticated-endpoint', () => {
  it('rota de escrita sem marcador de login é média', async () => {
    const r = await run({ 'src/api.ts': "app.post('/tarefa', (req, res) => {\n  res.send('ok');\n});\n" });
    expect(rule(r, 'unauthenticated-endpoint')).toEqual([expect.objectContaining({ severity: 'medium', line: 1 })]);
  });

  it('rota com requireAuth não acusa', async () => {
    const r = await run({ 'src/api.ts': "app.post('/tarefa', requireAuth, (req, res) => res.send('ok'));\n" });
    expect(rule(r, 'unauthenticated-endpoint')).toEqual([]);
  });

  it('leitura de dado sem login é baixa', async () => {
    const r = await run({ 'src/api.ts': "app.get('/lista', (req, res) => res.json(prisma.user.findMany()));\n" });
    expect(rule(r, 'unauthenticated-endpoint')).toEqual([expect.objectContaining({ severity: 'low' })]);
  });

  it('Next com middleware na raiz não acusa; sem middleware acusa', async () => {
    const route = { 'app/api/x/route.ts': 'export async function POST(req: Request) {\n  await save(await req.json());\n}\n' };
    expect(rule(await run(route), 'unauthenticated-endpoint')).toEqual([expect.objectContaining({ severity: 'medium' })]);
    expect(rule(await run({ ...route, 'middleware.ts': 'export function middleware() {}\n' }), 'unauthenticated-endpoint')).toEqual([]);
  });
});

describe('large-file', () => {
  it('arquivo de 1001 linhas é baixo, na linha 1001', async () => {
    const r = await run({ 'src/big.ts': Array(1001).fill('const a = 1;').join('\n') });
    expect(rule(r, 'large-file')).toEqual([expect.objectContaining({ severity: 'low', file: 'src/big.ts', line: 1001 })]);
  });

  it('arquivo de 999 linhas não acusa', async () => {
    const r = await run({ 'src/ok.ts': Array(999).fill('const a = 1;').join('\n') });
    expect(rule(r, 'large-file')).toEqual([]);
  });

  it('acima do limite de bytes não é lido e vira achado sem linha', async () => {
    const r = await run({ 'src/huge.ts': 'x'.repeat(200) }, { limits: { maxFileBytes: 100 } });
    expect(rule(r, 'large-file')).toEqual([expect.objectContaining({ severity: 'low', line: null })]);
    expect(r.stats.skipped.tooBig).toBe(1);
  });
});

describe('o que é ignorado', () => {
  it('arquivo no .gitignore e node_modules/ não aparecem; binário com NUL é pulado', async () => {
    const leak = `const k = '${'sk_live_'}${noise(24)}';\n`;
    const r = await run(
      {
        '.gitignore': 'config/local.json\n',
        'config/local.json': leak,
        'node_modules/pkg/index.js': leak,
        'data.txt': `\u0000${leak}`,
        'src/ok.ts': 'export const a = 1;\n',
      },
      { git: true },
    );
    expect(r.findings.some((f) => f.file.startsWith('config/') || f.file.startsWith('node_modules/'))).toBe(false);
    expect(r.findings.some((f) => f.file === 'data.txt')).toBe(false);
    expect(r.stats.skipped.binary).toBe(1);
  });
});

describe('limites', () => {
  const five = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`${n}.txt`, 'texto\n']));

  it('limite de arquivos corta e diz por quê', async () => {
    const r = await run(five, { limits: { maxFiles: 2 } });
    expect(r.stats.truncated).toBe(true);
    expect(r.stats.truncatedBy).toBe('files');
  });

  it('orçamento de tempo zerado corta por tempo', async () => {
    const r = await run(five, { limits: { timeBudgetMs: 0 } });
    expect(r.stats.truncatedBy).toBe('time');
  });

  it('limite de bytes no total corta por bytes', async () => {
    const r = await run({ 'a.txt': 'aaaaaaaa', 'b.txt': 'bbbbbbbb' }, { limits: { maxTotalBytes: 10 } });
    expect(r.stats.truncatedBy).toBe('bytes');
  });
});

describe('não vaza segredo', () => {
  it('o JSON da resposta não contém nenhum valor de segredo', async () => {
    const live = noise(24);
    const ant = noise(28);
    const gh = noise(36);
    const urlPass = noise(16);
    const envPass = noise(18);
    const viteVal = noise(20);
    const r = await run({
      'src/pay.ts': `const live = '${'sk_live_'}${live}';\nconst ant = '${'sk-ant-api03-'}${ant}';\n`,
      'src/tok.ts': `const gh = '${'ghp_'}${gh}';\n`,
      'src/conn.ts': `const u = 'postgres://app:${urlPass}@db.prod.internal:5432/app';\n`,
      'src/db.js': `PASSWORD=${envPass}\n`,
      '.env.local': `VITE_STRIPE_SECRET=${viteVal}\n`,
    });
    expect(r.findings.length).toBeGreaterThan(4);
    const json = JSON.stringify(r);
    for (const value of [live, ant, gh, urlPass, envPass, viteVal]) expect(json).not.toContain(value);
    for (const f of r.findings) expect(f.snippet.length).toBeLessThanOrEqual(160);
  });

  it('.env rastreado com NEXT_PUBLIC_SERVICE_ROLE e VITE_PRIVATE_X: o valor não sai', async () => {
    const a = noise(22);
    const b = noise(20);
    const r = await run({ '.env': `${'NEXT_PUBLIC_SERVICE_ROLE'}=${a}\n${'VITE_PRIVATE_X'}=${b}\n` }, { git: true, track: ['.env'] });
    expect(rule(r, 'client-exposed-secret')).toHaveLength(2);
    const json = JSON.stringify(r);
    expect(json).not.toContain(a);
    expect(json).not.toContain(b);
  });

  it('maskSnippet tira o valor entre aspas com espaço e o de chave JSON', () => {
    const json = maskSnippet('{"password": "a b c"}');
    const attr = maskSnippet('password = "x y z"');
    expect(json).not.toContain('b c');
    expect(attr).not.toContain('y z');
    expect(json).toContain('****');
    expect(attr).toContain('****');
  });
});

describe('severidade em arquivo de teste', () => {
  it('CORS com credentials em *.test.ts sai medium, não high', async () => {
    const r = await run({ 'tests/cors.test.ts': 'app.use(cors({ origin: true, credentials: true }));\n' });
    expect(rule(r, 'cors-open')).toEqual([expect.objectContaining({ severity: 'medium' })]);
  });
});
