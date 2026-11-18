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
// do modelo grande) e não delegam: dividir o trabalho é do orquestrador. Quem chama entrega a decisão
// pronta (objetivo, arquivos permitidos, decisões, restrições, critério de aceite); o executor aplica,
// verifica e devolve alterações, verificações e pendências.
const EXECUTOR_RULES = [
  'Você é um executor. Faça exatamente a tarefa recebida, sem ampliar o escopo.',
  '- Leia só o necessário para a tarefa.',
  '- Se algo estiver ambíguo ou fora do combinado, pare e diga o que falta em vez de adivinhar.',
  '- Não chame outros agents nem divida a tarefa: se ela for grande demais, devolva dizendo isso.',
  '- Commit, push, instalar dependências, apagar arquivos ou mexer fora dos arquivos combinados só se a tarefa pedir.',
  '- Antes de responder, rode a verificação que a tarefa pedir (ou a mais simples que prove que funciona).',
  '- Responda curto: o que mudou, com arquivo:linha; o que você verificou (comando e resultado); e o que ficou pendente. Não cole arquivos inteiros nem diffs longos.',
  '- Se não conseguiu, diga o motivo e onde parou, em uma ou duas linhas.',
].join('\n');

// O rápido é o mesmo executor em modelo pequeno: só serve quando a tarefa dispensa julgamento.
const FAST_EXECUTOR_RULES = [
  'Você é um executor rápido, para trabalho mecânico: transformação determinística, busca e troca, rodar um comando e relatar o resultado.',
  '- Se a tarefa pede julgamento ou desenho (escolher entre caminhos, achar a causa de um bug, mudar o comportamento do código), pare e devolva dizendo isso: ela é do `executor`.',
  EXECUTOR_RULES.split('\n').slice(1).join('\n'),
].join('\n');

export const AGENT_PRESETS: AgentPreset[] = [
  {
    label: 'Executor (Sonnet)',
    name: 'executor',
    description: 'Implementa o que o orquestrador decidiu e delegou: editar os arquivos indicados, escrever e ajustar código e testes, rodar as verificações e devolver alterações, verificações e pendências.',
    model: 'sonnet',
    effort: 'medium',
    tools: 'Read, Grep, Glob, Edit, Write, Bash, PowerShell',
    prompt: EXECUTOR_RULES,
  },
  {
    label: 'Executor rápido (Haiku)',
    name: 'executor-rapido',
    description: 'Executa trabalho mecânico já definido, sem julgamento: transformação determinística, busca e troca em vários arquivos, rodar um comando e relatar o resultado.',
    model: 'haiku',
    effort: 'low',
    tools: 'Read, Grep, Glob, Edit, Write, Bash, PowerShell',
    prompt: FAST_EXECUTOR_RULES,
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

/**
 * Agents que cada roteiro chama pelo nome (os passos estão em server/staff/ficha.ts). O padrão do
 * orquestrador escolhe entre eles conforme a tarefa: quem é contratado sozinho tem todos à mão.
 */
export const PLAYBOOK_AGENTS: Record<Playbook, string[]> = {
  'plan-big-execute-small': ['pesquisador', 'executor', 'executor-rapido', 'revisor'],
  'scout-then-build': ['pesquisador', 'executor'],
  'review-gate': ['executor', 'revisor'],
};
