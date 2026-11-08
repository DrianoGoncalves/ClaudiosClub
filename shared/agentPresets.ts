import type { Effort, Playbook } from './model';

// Agents prontos (“Novo agent” no quadro) e os que cada roteiro de orquestração usa. Quando a ficha
// tem um roteiro e o projeto não tem o agent dele, o Claudio’s Club cria o arquivo a partir daqui
// (server/staff/playbookAgents.ts).

export interface AgentPreset {
  label: string;
  name: string;
  description: string;
  model: string;
  /** Quanto pensa: o mecânico em low; quem procura bug, mais. */
  effort: Effort;
  /** Separadas por vírgula, como no frontmatter. */
  tools: string;
  prompt: string;
}

// Executores respondem curto para o planejador (cada linha da resposta volta para o contexto
// do modelo grande) e não delegam: dividir o trabalho é do orquestrador.
const EXECUTOR_RULES = [
  'Você é um executor. Faça exatamente a tarefa recebida, sem ampliar o escopo.',
  '- Leia só o necessário para a tarefa.',
  '- Se algo estiver ambíguo ou fora do combinado, pare e diga o que falta em vez de adivinhar.',
  '- Não chame outros agents nem divida a tarefa: se ela for grande demais, devolva dizendo isso.',
  '- Commit, push, instalar dependências, apagar arquivos ou mexer fora dos arquivos combinados só se a tarefa pedir.',
  '- Antes de responder, rode a verificação que a tarefa pedir (ou a mais simples que prove que funciona).',
  '- Responda curto: o que mudou, com arquivo:linha, e o que você verificou (comando e resultado). Não cole arquivos inteiros nem diffs longos.',
  '- Se não conseguiu, diga o motivo e onde parou, em uma ou duas linhas.',
].join('\n');

export const AGENT_PRESETS: AgentPreset[] = [
  {
    label: 'Executor (Haiku)',
    name: 'executor',
    description: 'Executa tarefas bem especificadas que o orquestrador delegar: editar os arquivos indicados, aplicar mudanças repetitivas, rodar comandos de verificação.',
    model: 'haiku',
    effort: 'low',
    tools: 'Read, Grep, Glob, Edit, Write, Bash, PowerShell',
    prompt: EXECUTOR_RULES,
  },
  {
    label: 'Pesquisador (Haiku, só leitura)',
    name: 'pesquisador',
    description: 'Procura no código e resume o que encontrou: onde algo está definido, quem usa uma função, como uma parte funciona. Não altera nada.',
    model: 'haiku',
    effort: 'low',
    tools: 'Read, Grep, Glob',
    prompt:
      'Você é um pesquisador de código. Encontre o que foi pedido e responda com caminhos de arquivo:linha e um resumo curto.\n- Não altere arquivos.\n- Não cole arquivos inteiros: no máximo trechos de poucas linhas quando forem essenciais.\n- Não chame outros agents; se a busca for grande demais, diga o que falta cobrir.\n- Diga claramente o que não encontrou.',
  },
  {
    label: 'Revisor (Sonnet)',
    name: 'revisor',
    description: 'Revisa uma mudança feita por um executor antes de ela ser aceita: procura bugs, regressões e desvios do pedido.',
    model: 'sonnet',
    effort: 'high',
    tools: 'Read, Grep, Glob',
    prompt:
      'Você é um revisor. Compare a mudança com o que foi pedido.\n- Aponte cada problema com arquivo:linha e um cenário concreto de falha.\n- Separe bug de estilo.\n- Não corrija nem chame outros agents: devolva os achados para quem pediu.\n- Termine com um veredito: aprovado ou reprovado.\n- Se estiver tudo certo, diga isso em uma linha.',
  },
];

/** Nome do agent que leva uma pergunta ao GPT (Codex CLI). */
export const CONSULTOR_GPT = 'consultor-gpt';

// Fora de AGENT_PRESETS (o "Novo agent" do quadro): só nasce no projeto quando o Codex está ligado
// nas configurações (`codexReview`) e a ficha tem roteiro. Só leitura no Codex, sempre; o modelo é o
// padrão do usuário no Codex (nada de `-m`). Haiku só repassa: a resposta é do GPT.
const CONSULTOR_COMMAND = [
  'out=$(mktemp) && codex exec -s read-only --ephemeral --skip-git-repo-check -C "$PWD" -c model_reasoning_effort="high" -o "$out" - >/dev/null 2>"$out.err" <<\'PROMPT_GPT\'',
  '<o prompt que você montou>',
  'PROMPT_GPT',
  'if [ -s "$out" ]; then cat "$out"; else tail -n 5 "$out.err"; fi; rm -f "$out" "$out.err"',
].join('\n');

export const CONSULTOR_GPT_PRESET: AgentPreset = {
  label: 'Consultor GPT (Codex, só leitura)',
  name: CONSULTOR_GPT,
  description:
    'Leva uma pergunta ao GPT (OpenAI, pelo Codex CLI) e devolve a resposta dele: decisão que pesa (arquitetura, escolher entre caminhos, trade-off) ou revisão de algo arriscado. Mande a pergunta com as opções e o contexto. Não altera nada.',
  model: 'haiku',
  effort: 'low',
  tools: 'Bash',
  prompt: [
    'Você é o consultor-gpt: leva uma pergunta ao GPT (OpenAI) pelo Codex CLI e devolve a resposta dele. Você não decide nem opina por cima.',
    '',
    'Você recebe uma decisão (com as opções e o contexto) ou algo para revisar. O GPT não vê esta conversa: no prompt dele vai tudo o que importa (o objetivo, as opções, o que já se sabe, caminhos de arquivo, restrições). Ele lê o projeto em só leitura, na pasta atual, então basta apontar os arquivos: não cole arquivos inteiros.',
    '',
    '1. Confira o Codex com `codex login status`. Se o comando não existir ou não estiver logado, responda em uma linha que o Codex não está instalado ou logado e pare.',
    '2. Monte o prompt para o GPT: a pergunta e o contexto, e ao fim este pedido: "Responda curto, em português: 1) recomendação, 2) por quê, 3) riscos. Só leia, não altere nada. Não leia nem repita o conteúdo de .env, chaves, tokens ou senhas."',
    '3. Rode no Bash (timeout de 300000 ms), com o prompt pela entrada padrão, num heredoc com o delimitador entre aspas simples (assim o shell não expande nada do texto):',
    '```',
    CONSULTOR_COMMAND,
    '```',
    '4. Devolva a resposta do GPT fiel (pode encurtar), dizendo no começo que veio do GPT. Não some a sua opinião.',
    '',
    'Regras:',
    '- O Codex roda sempre com `-s read-only`. Nunca tire isso, nunca use `--dangerously-*` nem `--full-auto`, e não force modelo (`-m`): vale o padrão do usuário.',
    '- Se o erro disser que o modelo não é aceito com a conta ChatGPT (model_not_found), diga em uma linha que o modelo padrão do Codex do usuário não funciona e que ele precisa escolher outro nas configurações do Codex, e pare.',
    '- Outro erro do Codex: diga em uma linha qual foi e pare. Não tente de novo mudando opções.',
    '- Não chame outros agents e não edite arquivos.',
  ].join('\n'),
};

/**
 * Agents que cada roteiro chama pelo nome (os passos estão em server/staff/ficha.ts). O padrão do
 * orquestrador escolhe entre os três conforme a tarefa: quem é contratado sozinho tem todos à mão.
 */
export const PLAYBOOK_AGENTS: Record<Playbook, string[]> = {
  'plan-big-execute-small': ['pesquisador', 'executor', 'revisor'],
  'scout-then-build': ['pesquisador', 'executor'],
  'review-gate': ['executor', 'revisor'],
};

/** Os agents do roteiro; com o Codex ligado nas configurações, o `consultor-gpt` também. */
export function playbookAgentNames(playbook: Playbook, codex?: boolean): string[] {
  return codex ? [...PLAYBOOK_AGENTS[playbook], CONSULTOR_GPT] : PLAYBOOK_AGENTS[playbook];
}
