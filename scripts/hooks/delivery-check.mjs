// Hook do Claude Code que o Claudio’s Club liga em todo funcionário (--settings, ver server/staff/launch.ts).
//   pre:  toda chamada ao Agent diz qual agent (sem subagent_type vira fork ou general-purpose, no
//         modelo de quem chama), e os do roteiro (executor, pesquisador, revisor) rodam em primeiro
//         plano. Sem `run_in_background: false` o Claude Code os põe em segundo plano: a entrega não
//         volta para quem chamou conferir, e o agent morre se a conversa fechar.
//   post: cada entrega do executor vem com o lembrete de conferir antes de seguir.
// Lê o evento em JSON no stdin e responde em JSON no stdout. Qualquer erro: não responde nada, e o
// Claude Code segue como se o hook não existisse.

const ROTEIRO = new Set(['executor', 'pesquisador', 'revisor']);

const SEM_TIPO =
  '[MyCo] Diga qual agent chamar (subagent_type). Sem ele, o Claude Code usa um fork ou o general-purpose, que rodam no seu modelo (o fork ainda copia esta conversa inteira). ' +
  'Escolha pelo nome: os do roteiro (pesquisador, executor, revisor), quando existem no projeto, custam bem menos.';

const PRIMEIRO_PLANO =
  '[MyCo] Chame o agent `{agent}` com run_in_background: false: sem isso ele roda em segundo plano, a entrega não volta para você conferir nesta conversa ' +
  'e ele morre se a conversa fechar. Para rodar tarefas em paralelo, faça várias chamadas ao Agent na mesma mensagem.';

const CONFERIR =
  '[MyCo] Entrega do executor recebida. Antes de seguir ou de dizer que está pronto, confira: ' +
  '1) `git status`/`git diff --stat` mostra os arquivos pedidos (diff vazio = não foi feito; sem git, abra os arquivos pedidos); ' +
  '2) leia o diff desses arquivos e compare com o pedido; ' +
  '3) rode a checagem de tipos e os testes do que mudou (sem testes no projeto, a verificação mais simples que prove: rodar o script, abrir a página). ' +
  'Se algo falhou, devolva ao executor com o que está errado; na segunda falha, chame-o com model: "sonnet", divida a tarefa ou pergunte ao usuário. No resumo final, diga o que conferiu.';

function answer(hookEventName, extra) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, ...extra } }));
}

const deny = (reason) => answer('PreToolUse', { permissionDecision: 'deny', permissionDecisionReason: reason });

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw);
    if (!ev || typeof ev !== 'object' || !ev.tool_input || typeof ev.tool_input !== 'object') return;
    const input = ev.tool_input;
    const agent = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
    if (process.argv[2] === 'pre') {
      if (!agent) deny(SEM_TIPO);
      else if (ROTEIRO.has(agent) && input.run_in_background !== false) deny(PRIMEIRO_PLANO.replace('{agent}', agent));
    } else if (process.argv[2] === 'post' && agent === 'executor') {
      // Em segundo plano o Agent volta na hora, antes da entrega: ainda não há o que conferir.
      if (!JSON.stringify(ev.tool_response ?? '').includes('async_launched')) answer('PostToolUse', { additionalContext: CONFERIR });
    }
  } catch {
    // entrada inesperada: sem resposta
  }
});
