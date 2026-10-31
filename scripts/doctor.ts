import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAuthStatus } from '../server/auth';
import { BUILT, ROOT, brokenBuild, brokenDeps, linuxAppsDir } from './lib';

// Checklist do Claudio’s Club: confere o que falta para rodar (Node 22+, Git, Claude Code, login, dependências, build
// e o botão Iniciar) e grava scripts/status.js, que a página scripts/start.html lê. Só leitura: não instala nada e não
// lê credencial nem valor de variável. Uso: npm run doctor

interface Check {
  id: 'node' | 'git' | 'claude' | 'login' | 'deps' | 'build' | 'launcher';
  ok: boolean;
  detail: string;
}

const LABELS: Record<Check['id'], string> = {
  node: 'Node 22 ou mais novo',
  git: 'Git',
  claude: 'Claude Code instalado',
  login: 'Login no Claude Code',
  deps: 'Dependências',
  build: 'Build do app',
  launcher: 'Botão Iniciar registrado',
};

/** Primeira linha da saída de um programa do PATH; vazia se ele não existe ou falha. */
function firstLine(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 10_000 });
  if (r.error || r.status !== 0) return '';
  return (r.stdout ?? '').split('\n')[0]?.trim() ?? '';
}

/** O botão Iniciar (link myco://) está registrado neste sistema? */
function launcherInstalled(): boolean {
  if (process.platform === 'win32') {
    return spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\myco\\shell\\open\\command'], { windowsHide: true }).status === 0;
  }
  if (process.platform === 'linux') return fs.existsSync(path.join(linuxAppsDir(), 'claudios-url.desktop'));
  return false;
}

async function collect(): Promise<Check[]> {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    ok: major >= 22,
    detail: major >= 22 ? process.version : `${process.version} (precisa 22+)`,
  });

  const git = firstLine('git', ['--version']);
  checks.push({ id: 'git', ok: !!git, detail: git || 'não encontrado' });

  const claude = firstLine('claude', ['--version']);
  checks.push({ id: 'claude', ok: !!claude, detail: claude || 'não encontrado' });

  const auth = await getAuthStatus({ fresh: true });
  const apiKey = !!process.env.ANTHROPIC_API_KEY;
  if (auth.loggedIn) checks.push({ id: 'login', ok: true, detail: 'sessão do Claude Code ativa' });
  else if (apiKey) checks.push({ id: 'login', ok: true, detail: 'ANTHROPIC_API_KEY definida' });
  else checks.push({ id: 'login', ok: false, detail: 'faça login: rode claude' });

  const installed = fs.existsSync(path.join(ROOT, 'node_modules', '.package-lock.json'));
  const broken = installed ? brokenDeps() : [];
  checks.push({
    id: 'deps',
    ok: installed && broken.length === 0,
    detail: !installed ? 'node_modules ausente' : broken.length ? `quebradas: ${broken.join(', ')} (rode npm ci)` : 'node_modules instalado',
  });

  const build = fs.existsSync(BUILT);
  const missing = brokenBuild();
  checks.push({
    id: 'build',
    ok: build && missing.length === 0,
    detail: !build ? 'build ausente' : missing.length ? `faltam ${missing.join(', ')} (rode npm run build)` : 'dist/client/index.html',
  });

  const launcher = launcherInstalled();
  checks.push({
    id: 'launcher',
    ok: launcher,
    detail: launcher
      ? 'myco:// registrado'
      : process.platform === 'darwin'
        ? 'sem atalho no macOS: use npm run daily:start'
        : 'registro não encontrado',
  });

  return checks;
}

async function main(): Promise<void> {
  const checks = await collect();
  const statusFile = path.join(ROOT, 'scripts', 'status.js');
  // status.js: window.claudioStatus = { at, checks }. UTF-8.
  const payload = { at: new Date().toISOString(), checks };
  fs.writeFileSync(statusFile, `window.claudioStatus = ${JSON.stringify(payload)};`, 'utf8');

  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${LABELS[c.id].padEnd(26)} ${c.detail}`);
  }
  const okCount = checks.filter((c) => c.ok).length;
  console.log(`${okCount} de ${checks.length} ok. Gravado em ${statusFile}`);
}

await main();
