// Hook de PreToolUse que o Claudio’s Club põe em toda conversa de funcionário, gestor e revisor, no Bash e no PowerShell, nos dois motores
// (Claude: launch.ts, staffSettings, matcher `Bash|PowerShell`; Codex: codexArgs.ts, codexHeavyArgs, matcher `Bash`): git que descarta mudança
// não commitada ou move o HEAD por cima dela é barrado no checkout principal do projeto. A regra (o que barra, onde, o que fica de fora) está em
// git-guard-lib.mjs; aqui só a entrada e a saída.
//   uso: node git-guard.mjs <pasta do projeto, o checkout principal>
// Lê o evento em JSON no stdin e responde em JSON no stdout (`permissionDecision: deny`, só os campos que o Codex aceita). Só nega; nunca libera.
// Fail-closed: entrada ilegível, sem nome de ferramenta, comando que não é texto ou erro inesperado: "deny". Outra ferramenta (nome conhecido): não responde.

import { failClosed, guard, unavailable } from './git-guard-lib.mjs';

const projectPath = process.argv[2];

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('error', () => process.stdout.write(JSON.stringify(unavailable())));
process.stdin.on('end', () => {
  let res;
  try {
    res = guard(JSON.parse(raw), projectPath);
  } catch {
    res = failClosed(raw);
  }
  if (res) process.stdout.write(JSON.stringify(res));
});
