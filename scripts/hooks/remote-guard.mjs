// Hook do Claude Code que o Claudio’s Club põe em todo funcionário (launch.ts, staffSettings), no Bash e no PowerShell
// (matcher `Bash|PowerShell`). Acesso remoto no terminal (ssh, scp, sftp, rsync e afins) é bloqueado para todos, com ou sem
// servidor na ficha: com servidor, o acesso é só pelo MCP myco-ssh (mcp__myco-ssh__ssh_*). A regra de --disallowedTools
// (ficha.ts, REMOTE_TOOLS) barra o nome do programa; este hook pega as variantes óbvias: caminho até o programa, programa
// dentro de outro comando (bash -c, cmd /c, env, xargs), git com ssh por config ou variável, e comando codificado (-enc).
// Não é barreira completa: interpretadores (python, node) e strings montadas (s""sh) escapam. É residual documentado.
// Lê o evento em JSON no stdin e responde em JSON no stdout. Só nega; nunca libera.
// Fail-closed: entrada ilegível, sem nome de ferramenta, comando que não é texto ou erro inesperado: "deny".
// Outra ferramenta (nome conhecido): não responde.

const TOOLS = new Set(['Bash', 'PowerShell']);
const REMOTE = new Set(['ssh', 'scp', 'sftp', 'rsync', 'plink', 'pscp', 'psftp', 'sshpass', 'autossh', 'mosh']);
const SHELLS = new Set(['powershell', 'pwsh']);
// Separadores de token: espaço e o que abre outro comando, agrupa ou cita (e o `$(`).
const SPLIT = /[\s;&|()<>`'"{},=]+|\$\(/;
const B64 = /^[A-Za-z0-9+/=]+$/;
const MSG =
  'O Claudio’s Club bloqueia ssh, scp, sftp e rsync no terminal; com conexão na ficha, use as ferramentas mcp__myco-ssh__ssh_*; ' +
  'para procurar texto, use a ferramenta Grep.';

const out = (permissionDecision, reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `[MyCo] ${reason}` },
});

/** O token sem aspas, `@` e `&` nas pontas. */
const edges = (t) => t.replace(/^[\s"'`@&]+|[\s"'`]+$/g, '');

/** O nome do programa: o basename depois do último / ou \, minúsculo e sem .exe/.com/.cmd/.bat. */
const nameOf = (t) =>
  edges(t)
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(exe|com|cmd|bat)$/, '');

/** Algum token do comando é um programa de acesso remoto. */
const hasRemote = (cmd) => cmd.split(SPLIT).some((t) => REMOTE.has(nameOf(t)));

/** Flag de comando codificado do PowerShell: `-` ou `/` seguido de um prefixo de "encodedcommand" (ao menos `-e`). */
const isEncodedFlag = (w) => w.length >= 2 && /^[-/]/.test(w) && 'encodedcommand'.startsWith(w.slice(1).toLowerCase());

/** powershell/pwsh com -enc (ou prefixo de -encodedcommand) seguido de base64 de 16+ caracteres: não dá para conferir. */
function encodedPs(cmd) {
  const words = cmd.split(/\s+/).map(edges);
  if (!words.some((w) => SHELLS.has(nameOf(w)))) return false;
  return words.some((w, i) => isEncodedFlag(w) && i + 1 < words.length && words[i + 1].length >= 16 && B64.test(words[i + 1]));
}

/** Decide a entrada inteira. Lança só em erro inesperado (quem chama responde deny). */
function verdict(raw) {
  const ev = JSON.parse(raw);
  const tool = ev && typeof ev === 'object' ? ev.tool_name : undefined;
  // Sem nome de ferramenta, não dá para provar que não é Bash/PowerShell: bloqueia.
  if (typeof tool !== 'string') return out('deny', 'entrada da ferramenta sem nome: bloqueado por segurança.');
  if (!TOOLS.has(tool)) return null;
  const cmd = ev.tool_input?.command;
  if (typeof cmd !== 'string') return out('deny', 'comando sem texto: bloqueado por segurança.');
  if (hasRemote(cmd) || /git_ssh|sshcommand|rsync_rsh/.test(cmd.toLowerCase()) || encodedPs(cmd)) return out('deny', MSG);
  return null;
}

/** Erro inesperado: se a entrada for de outra ferramenta, não responde; se não der para ler, bloqueia. */
function failClosed(raw) {
  try {
    const t = JSON.parse(raw)?.tool_name;
    if (typeof t === 'string' && !TOOLS.has(t)) return null;
  } catch {
    // entrada ilegível: segue para o bloqueio
  }
  return out('deny', 'não deu para conferir o comando do terminal: bloqueado por segurança.');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('error', () => process.stdout.write(JSON.stringify(out('deny', 'entrada do hook indisponível: bloqueado por segurança.'))));
process.stdin.on('end', () => {
  let res;
  try {
    res = verdict(raw);
  } catch {
    res = failClosed(raw);
  }
  if (res) process.stdout.write(JSON.stringify(res));
});
