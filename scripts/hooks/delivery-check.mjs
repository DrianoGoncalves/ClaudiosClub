// Hook do Claude Code que o Claudio’s Club liga em todo funcionário (--settings, ver server/staff/launch.ts).
//   pre:  os agents do roteiro (executor, pesquisador, revisor) rodam em primeiro plano. Em segundo
//         plano a entrega não volta para quem chamou conferir, e o agent morre se a conversa fechar.
//   post: cada entrega do executor vem com o lembrete de conferir antes de seguir.
// Lê o evento em JSON no stdin e responde em JSON no stdout. Qualquer erro: não responde nada, e o
// Claude Code segue como se o hook não existisse.

const ROTEIRO = new Set(['executor', 'pesquisador', 'revisor']);

const PRIMEIRO_PLANO =
  '[MyCo] Chame o agent `{agent}` em primeiro plano (sem run_in_background): a entrega precisa voltar para você conferir antes de seguir, ' +
  'e um agent em segundo plano morre se a conversa fechar. Para rodar tarefas em paralelo, faça várias chamadas ao Agent na mesma mensagem.';

const CONFERIR =
  '[MyCo] Entrega do executor recebida. Antes de seguir ou de dizer que está pronto, confira: ' +
  '1) `git status`/`git diff --stat` mostra os arquivos pedidos (diff vazio = não foi feito); ' +
  '2) leia o diff desses arquivos e compare com o pedido; ' +
  '3) rode a checagem de tipos e os testes do que mudou. ' +
  'Se algo falhou, devolva ao executor com o que está errado (no máximo duas vezes) ou faça você. No resumo final, diga o que conferiu.';

function answer(hookEventName, extra) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, ...extra } }));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw);
    const input = ev.tool_input ?? {};
    const agent = typeof input.subagent_type === 'string' ? input.subagent_type : '';
    if (!ROTEIRO.has(agent)) return;
    if (process.argv[2] === 'pre' && input.run_in_background === true) {
      answer('PreToolUse', { permissionDecision: 'deny', permissionDecisionReason: PRIMEIRO_PLANO.replace('{agent}', agent) });
    } else if (process.argv[2] === 'post' && agent === 'executor') {
      answer('PostToolUse', { additionalContext: CONFERIR });
    }
  } catch {
    // entrada inesperada: sem resposta
  }
});
