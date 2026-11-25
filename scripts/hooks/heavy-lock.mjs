// A fila de validação pesada por máquina: suíte completa de testes e tsc do projeto inteiro rodam uma por vez, as outras esperam.
// Quem a usa: o hook heavy-guard.mjs (terminal dos funcionários, Claude Code) e o `runTests` do servidor (server/heavyQueue.ts).
// Sem dependências: o hook roda com o node puro, direto desta pasta (ou da cópia na pasta da conversa, ver launch.ts).
//
// Trava = um arquivo `heavy.lock` (JSON) criado só se não existir (`wx`). Ela é de um processo vivo e tem prazo: vale como "órfã" (qualquer
// um a tira) quando o processo dono morreu OU o prazo passou. O prazo cobre o que o pid não cobre: no hook, o dono é o processo do Claude
// (que vive mais que o comando) e uma chamada negada depois do hook nunca chega ao hook de saída (PostToolUse não dispara).
// Tirar uma órfã confere o conteúdo logo antes de apagar; sobra uma janela mínima em que duas esperas apagam a trava uma da outra
// (o pior caso é rodar duas validações juntas, como era sem a fila).

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = 'heavy.lock';
/** Trava que não dá para ler (ainda sendo escrita): vale por tanto tempo, depois é lixo. */
const UNREADABLE_MS = 5_000;

/** Espera `ms`; com `signal`, acaba antes se ele abortar (o timer sai junto, sem segurar o processo). */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** O processo existe (o mesmo critério de server/chat/registry.ts). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Lê a trava: `{ raw, rec }`; `rec` null = texto que não é uma trava; `null` = não existe. */
async function readLock(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const rec = JSON.parse(raw);
    return { raw, rec: rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null };
  } catch {
    return { raw, rec: null };
  }
}

/** A trava que está valendo agora (null = livre ou órfã); não apaga nada. */
export async function currentHolder(dir, { now = Date.now(), alive = pidAlive } = {}) {
  const file = path.join(dir, LOCK_FILE);
  const lock = await readLock(file);
  if (!lock) return null;
  return (await staleness(file, lock, now, alive)) ? null : lock.rec;
}

/** Órfã: o dono morreu, o prazo passou ou o texto não é uma trava (e já não está sendo escrito). */
async function staleness(file, lock, now, alive) {
  if (!lock.rec) {
    const stat = await fs.stat(file).catch(() => null);
    return !stat || now - stat.mtimeMs > UNREADABLE_MS;
  }
  const { pid, expiresAt } = lock.rec;
  return !(typeof expiresAt === 'number' && expiresAt > now) || !alive(pid);
}

/**
 * Tenta pegar a trava. Devolve `null` quando pegou, ou o registro de quem a segura. `undefined`: tirou uma órfã, tente de novo já.
 * `owner` igual ao do registro (com outra `key`): a chamada anterior do mesmo dono já acabou (negada ou interrompida, sem hook de saída):
 * a trava é dele, e é reaproveitada.
 */
async function attempt(file, rec, now, alive) {
  try {
    await fs.writeFile(file, JSON.stringify(rec), { flag: 'wx' });
    return null;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  const lock = await readLock(file);
  if (!lock) return undefined; // saiu entre o `wx` e a leitura
  if (lock.rec?.key === rec.key) return null; // já é nossa (hook repetido)
  const mine = !!rec.owner && lock.rec?.owner === rec.owner;
  if (mine || (await staleness(file, lock, now, alive))) {
    const again = await readLock(file);
    if (again && again.raw === lock.raw) await fs.unlink(file).catch(() => {});
    return undefined;
  }
  return lock.rec ?? { key: '', owner: null, pid: 0, label: '', since: now, expiresAt: now + UNREADABLE_MS }; // sendo escrita agora
}

/**
 * Espera a vez e pega a trava. `acquired: false` = passou de `maxWaitMs` (quem chama decide; o normal é seguir sem trava).
 * `key` identifica a chamada (quem pega solta com a mesma); `owner`, quem a pediu (uma conversa); `pid`, o processo que a segura
 * enquanto vale (morreu = órfã); `leaseMs`, o prazo. `signal`: quem pediu desistiu da vez; a espera acaba na hora com `acquired: false, aborted: true`
 * (e a trava não é pega: quem chama não deve rodar nada).
 */
export async function acquire({ dir, key, owner = null, pid, label = '', leaseMs, maxWaitMs, pollMs = 1_000, onWait, signal, now = () => Date.now(), alive = pidAlive }) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const started = now();
  let notified = false;
  for (;;) {
    if (signal?.aborted) return { acquired: false, aborted: true, waitedMs: now() - started, holder: null };
    const at = now();
    const rec = { key, owner, pid, label: String(label).slice(0, 120), since: at, expiresAt: at + leaseMs };
    const holder = await attempt(file, rec, at, alive);
    if (holder === null) return { acquired: true, waitedMs: now() - started, holder: null };
    if (holder === undefined) {
      await sleep(25); // tirou uma órfã (ou a trava saiu sozinha): tenta já, sem girar à toa se o disco recusar
      continue;
    }
    if (now() - started >= maxWaitMs) return { acquired: false, waitedMs: now() - started, holder };
    if (!notified) {
      notified = true;
      onWait?.(holder);
    }
    // Com folga aleatória (as esperas não batem juntas na trava), sem passar do limite de espera.
    await sleep(Math.max(10, Math.min(pollMs + Math.random() * pollMs * 0.5, maxWaitMs - (now() - started))), signal);
  }
}

/** Solta a trava, só se ainda for a desta chamada (o prazo pode tê-la passado a outra). */
export async function release(dir, key) {
  const file = path.join(dir, LOCK_FILE);
  const lock = await readLock(file);
  if (lock?.rec?.key === key) await fs.unlink(file).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------------------------
// O que é validação pesada: leitura do texto do comando (Bash ou PowerShell), sem rodar nada. Teste de um arquivo não entra.
// Não é barreira completa: um comando montado por string ou por interpretador escapa, como no remote-guard.mjs.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Separadores de comando, fora de aspas: quebra de linha, `;`, `&`, `|` (e os duplos) e o que abre ou fecha um grupo. */
const SEPARATORS = new Set([';', '&', '|', '\n', '\r', '(', ')', '{', '}']);

/** Divide o texto em comandos de palavras; aspas simples e duplas agrupam (e saem), `\` não é escape (caminho do Windows). */
function commands(text) {
  const out = [];
  let words = [];
  let word = '';
  let has = false;
  let quote = '';
  const endWord = () => {
    if (has) words.push(word);
    word = '';
    has = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (SEPARATORS.has(ch)) {
      // `2>&1`, `>&2`, `*>&1`: o `&` é de redirecionamento, não separa comando.
      if (ch === '&' && /(?:^|\D)\d*\*?>$/.test(word)) word += ch;
      else endCommand();
    } else if (/\s/.test(ch)) endWord();
    else {
      word += ch;
      has = true;
    }
  }
  endCommand();
  return out;
}

/** O nome do programa: depois da última barra, minúsculo, sem extensão de executável ou script. */
const nameOf = (w) =>
  String(w)
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1|mjs|cjs|js)$/, '');

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Redirecionamento (`>x`, `2>&1`, `*>$null`, `<x`): não é argumento. */
const REDIRECTION = /^\d*\*?[<>]/;
/** Prefixos que só repassam o comando. */
const PASS_THROUGH = new Set(['time', 'call', 'command', 'exec', 'nohup', 'env']);
const SHELLS = { bash: ['-c', '-lc'], sh: ['-c', '-lc'], zsh: ['-c', '-lc'], cmd: ['/c', '/k'], powershell: ['-c', '-command'], pwsh: ['-c', '-command'] };
/** Flags de vitest/jest que levam um valor na palavra seguinte (com `=` o valor já vem junto). */
const VALUE_FLAGS = new Set([
  '-c', '--config', '-r', '--root', '--dir', '-t', '--testnamepattern', '--reporter', '--outputfile', '--project', '--shard', '--pool',
  '--testtimeout', '--hooktimeout', '--teardowntimeout', '--maxworkers', '--minworkers', '--environment', '--mode', '--exclude', '--retry',
  '--maxconcurrency', '--browser', '--sequence.seed', '--setupfiles', '--globalsetup', '--coverage.reporter', '--coverage.include',
  '--coverage.exclude', '--testpathpattern', '--testmatch', '--coveragedirectory',
]);

/** Argumentos que não são flag nem valor de flag: arquivo ou filtro. */
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (REDIRECTION.test(a)) {
      if (/^\d*\*?(?:>{1,2}|<)$/.test(a)) i++; // `> saida.txt`: o destino é do redirecionamento
      continue;
    }
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a.toLowerCase())) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const INFO = new Set(['-v', '--version', '-h', '--help']);
const hasInfo = (args) => args.some((a) => INFO.has(a));

/**
 * vitest e jest: toda rodada de testes espera a vez, com arquivo ou filtro também (e o `vitest related`). Cada rodada sobe processos de ~350 MB; em 25/11/2026 três
 * funcionários rodavam "só este arquivo" ao mesmo tempo, fora da fila, e a máquina (8 GB, HDD) paginava sem parar. Só o que não roda teste fica de fora: `list`,
 * `init`, versão e ajuda.
 */
function runnerHeavy(args, sub, suite) {
  if (hasInfo(args) || args.includes('--init')) return false;
  const pos = positionals(args);
  if (pos[0] !== undefined && sub.light.has(pos[0].toLowerCase())) return false;
  if (!suite) return true;
  // A suíte inteira (`isFullSuiteCommand`): sem arquivo nem filtro; `related` e `bench` nunca são a suíte.
  if (pos[0] !== undefined && sub.partial.has(pos[0].toLowerCase())) return false;
  const rest = pos[0] !== undefined && sub.run.has(pos[0].toLowerCase()) ? pos.slice(1) : pos;
  return rest.length === 0;
}
const VITEST = { light: new Set(['list', 'init']), partial: new Set(['related', 'bench']), run: new Set(['run', 'watch', 'dev']) };
const JEST = { light: new Set(), partial: new Set(), run: new Set() };

/** tsc do projeto inteiro: sem arquivo de código nos argumentos (com arquivo ele ignora o tsconfig e é pequeno). */
function tscHeavy(args) {
  if (hasInfo(args) || args.includes('--init')) return false;
  const files = positionals(args).filter((a) => /\.[cm]?tsx?$/.test(a));
  // `-p x.json`, `--project x.json` e `--build` têm valor próprio, que não é código.
  return files.length === 0;
}

/** Script do package.json que é suíte ou tsc: `npm test`, `npm run test:unit`, `yarn typecheck`. */
const HEAVY_SCRIPT = /^(test|tests|typecheck|type-check|tsc)(:.*)?$/i;

/**
 * O programa e os argumentos já sem prefixos (env, time, cd não entra: é outro comando). Devolve se é pesado: com `suite`, se é a suíte inteira (ou o tsc do
 * projeto); sem, se espera a vez na fila (qualquer rodada de testes, ou o tsc do projeto).
 */
function heavyCommand(words, depth, suite = false) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (ENV_ASSIGNMENT.test(w) || w === '&' || w === '.' || PASS_THROUGH.has(nameOf(w))) i++;
    else if (nameOf(w) === 'timeout' && /^\d+[smhd]?$/.test(words[i + 1] ?? '')) i += 2;
    else break;
  }
  const w = words[i];
  if (w === undefined) return false;
  const name = nameOf(w);
  const args = words.slice(i + 1);
  if (name in SHELLS) {
    // `bash -c "npm test"`, `cmd /c npm test`, `powershell -Command "npm test"`: confere o texto que ele roda.
    const at = args.findIndex((a) => SHELLS[name].includes(a.toLowerCase()));
    const payload = at === -1 ? '' : args.slice(at + 1).join(' ');
    return depth < 3 && payload !== '' && (suite ? isFullSuiteCommand : isHeavyCommand)(payload, depth + 1);
  }
  if (name === 'vitest') return runnerHeavy(args, VITEST, suite);
  if (name === 'jest') return runnerHeavy(args, JEST, suite);
  if (name === 'tsc') return tscHeavy(args);
  if (name === 'phpunit') return !hasInfo(args) && (!suite || positionals(args).length === 0);
  if (name === 'node') {
    // `node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc -p .`
    const script = args.find((a) => !a.startsWith('-'));
    const next = script === undefined ? [] : ['vitest', 'jest', 'tsc'].includes(nameOf(script)) ? [script, ...args.slice(args.indexOf(script) + 1)] : [];
    return next.length > 0 && heavyCommand(next, depth + 1, suite);
  }
  if (['npx', 'bunx', 'pnpx'].includes(name) || (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && ['exec', 'x', 'dlx'].includes((args[0] ?? '').toLowerCase()))) {
    const rest = name === 'npx' || name === 'bunx' || name === 'pnpx' ? args : args.slice(1);
    // Pula as flags do executor (-y, --yes, --no-install, -p pacote, -- ...) até o programa.
    let j = 0;
    while (j < rest.length && (rest[j].startsWith('-') || REDIRECTION.test(rest[j]))) j += ['-p', '--package', '-c'].includes(rest[j]) ? 2 : 1;
    return j < rest.length && heavyCommand(rest.slice(j), depth + 1, suite);
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const verb = (args[0] ?? '').toLowerCase();
    if (['test', 't', 'tst'].includes(verb)) return runnerArgsHeavy(args.slice(1), suite);
    if (['run', 'run-script', 'rum', 'urn'].includes(verb) || (name !== 'npm' && HEAVY_SCRIPT.test(verb))) {
      const script = ['run', 'run-script', 'rum', 'urn'].includes(verb) ? args[1] : args[0];
      return script !== undefined && HEAVY_SCRIPT.test(script) && runnerArgsHeavy(args.slice(['run', 'run-script', 'rum', 'urn'].includes(verb) ? 2 : 1), suite);
    }
    return false;
  }
  if (name === 'composer') return (args[0] ?? '').toLowerCase() === 'test' && (!suite || positionals(args.slice(1)).length === 0);
  return false;
}

/** Argumentos do `npm test`: na fila, com arquivo ou filtro também (ver `runnerHeavy`); como suíte inteira, só sem arquivo nem filtro. Versão e ajuda nunca. */
function runnerArgsHeavy(args, suite) {
  return !hasInfo(args) && (!suite || positionals(args).length === 0);
}

/** O comando (texto de uma chamada de terminal) espera a vez na fila de validação pesada? Qualquer rodada de testes, ou o tsc do projeto. */
export function isHeavyCommand(command, depth = 0) {
  if (typeof command !== 'string' || command.trim() === '') return false;
  return commands(command).some((words) => heavyCommand(words, depth));
}

/** O comando roda a suíte inteira de testes (sem arquivo nem filtro) ou o tsc do projeto? A nova rodada só dos arquivos que falharam nunca pode ser isso (testFailures.ts). */
export function isFullSuiteCommand(command, depth = 0) {
  if (typeof command !== 'string' || command.trim() === '') return false;
  return commands(command).some((words) => heavyCommand(words, depth, true));
}
