// Hook do Claude Code que o Claudio’s Club põe em todo funcionário (launch.ts, staffSettings), no Bash e no PowerShell: a fila de
// validação pesada por máquina (suíte completa de testes, tsc do projeto inteiro): uma por vez, as outras esperam aqui, antes de o
// comando rodar. Teste de um arquivo passa direto. A lógica (o que é pesado, a trava e o prazo) está em heavy-lock.mjs.
//   uso: node heavy-guard.mjs <pasta da trava> pre|post [pid do dono [prazo da trava em segundos]]
//   pre:  espera a vez (até WAIT_MAX_MS) e pega a trava; quem esperou ouve disso na tela (`systemMessage`) e na resposta (`additionalContext`).
//   post: solta a trava (PostToolUse e PostToolUseFailure: comando que falha, como teste vermelho, só dispara o segundo).
// Claude Code: sem os dois últimos argumentos. O dono da trava é o processo que abriu o hook (o Claude, que vive mais que o comando) e o
// prazo é o `timeout` da própria chamada. Codex (o mesmo script, ligado pelo codexHeavyArgs): quem abre o hook é um shell de vida curta, então o
// Claudio’s Club passa o pid dele (vivo enquanto a conversa existe) e o prazo (a chamada do Codex não traz timeout).
// `run_in_background` é negado: o PostToolUse sairia no começo da execução e soltaria a trava com a suíte ainda rodando.
// Nunca libera nem nega por outro motivo; qualquer erro (disco, entrada ilegível): não responde e o comando segue, como sem a fila.
// Não é barreira: comando montado por string ou por interpretador escapa (é uma cortesia de memória, não de segurança).

import { acquire, isHeavyCommand, release } from './heavy-lock.mjs';

const TOOLS = new Set(['Bash', 'PowerShell']);
/** Espera máxima pela vez: abaixo do `timeout` do hook no settings (900 s), para sair daqui e não ser cortado. */
const WAIT_MAX_MS = 13 * 60_000;
const DEFAULT_COMMAND_MS = 120_000;

const [dir, stage, ownerPid, leaseSeconds] = process.argv.slice(2);

const out = (body) => process.stdout.write(JSON.stringify(body));
const deny = (reason) => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[MyCo] ${reason}` } });
const seconds = (ms) => Math.max(1, Math.round(ms / 1000));

/** Quanto tempo o comando pode rodar: o prazo dado ao hook (Codex) ou o `timeout` da chamada, senão o padrão do Claude Code. A trava vale esse tempo (e um pouco mais). */
function leaseMs(input) {
  if (Number(leaseSeconds) > 0) return Number(leaseSeconds) * 1000;
  const asked = Number(input?.timeout) || Number(process.env.BASH_DEFAULT_TIMEOUT_MS) || DEFAULT_COMMAND_MS;
  return Math.min(Math.max(asked, 30_000), 3_600_000) + 30_000;
}

/** Quem pede: a conversa (MYCO_SESSION_ID está no ambiente do Claude e o hook o herda) e, num subagent, ele. */
const sessionOf = (ev) => process.env.MYCO_SESSION_ID || String(ev.session_id ?? '');
/** A chamada: o mesmo texto nos dois hooks (sem `tool_use_id`, vale a conversa: a chamada seguinte dela reaproveita a trava). */
const keyOf = (ev) => String(ev.tool_use_id ?? sessionOf(ev));

async function pre(ev, command) {
  if (ev.tool_input?.run_in_background === true) {
    return deny(
      'Suíte completa e tsc do projeto rodam uma por vez na máquina, em primeiro plano: tire o run_in_background e rode de novo (ou rode só os arquivos que você mudou, sem esperar vez).',
    );
  }
  // O `runTests` do servidor e os testes de dentro da suíte reconhecem a trava da própria conversa (server/heavyQueue.ts).
  const session = sessionOf(ev);
  const owner = ev.agent_id ? `${session}:${ev.agent_id}` : session;
  let who = '';
  const got = await acquire({
    dir,
    key: keyOf(ev),
    owner: owner || null,
    pid: Number(ownerPid) > 0 ? Number(ownerPid) : process.ppid,
    label: command.replace(/\s+/g, ' ').trim(),
    leaseMs: leaseMs(ev.tool_input),
    maxWaitMs: WAIT_MAX_MS,
    onWait: (holder) => (who = holder.label ? ` (${holder.label.slice(0, 80)})` : ''),
  });
  if (got.acquired && got.waitedMs < 1000) return;
  const text = got.acquired
    ? `Esperei ${seconds(got.waitedMs)} s a vez: outra validação pesada rodava${who}. Uma por vez nesta máquina.`
    : `Esperei ${seconds(got.waitedMs)} s e a fila não andou${who}: o comando segue sem trava.`;
  out({ systemMessage: `[MyCo] ${text}`, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[MyCo] ${text}` } });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('error', () => {});
process.stdin.on('end', async () => {
  try {
    const ev = JSON.parse(raw);
    const command = ev?.tool_input?.command;
    if (!dir || !TOOLS.has(ev?.tool_name) || typeof command !== 'string' || !isHeavyCommand(command)) return;
    if (stage === 'pre') await pre(ev, command);
    else if (stage === 'post') await release(dir, keyOf(ev));
  } catch {
    // sem fila: o comando segue
  }
});
