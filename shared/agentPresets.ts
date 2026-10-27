import type { Playbook } from './model';

// Agents prontos (“Novo agent” no quadro) e os que cada roteiro de orquestração usa. Quando a ficha
// tem um roteiro e o projeto não tem o agent dele, o MyCo cria o arquivo a partir daqui
// (server/staff/playbookAgents.ts).

export interface AgentPreset {
  label: string;
  name: string;
  description: string;
  model: string;
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
  '- Responda curto: o que mudou, com arquivo:linha, e o que você verificou (comando e resultado). Não cole arquivos inteiros nem diffs longos.',
  '- Se não conseguiu, diga o motivo e onde parou, em uma ou duas linhas.',
].join('\n');

export const AGENT_PRESETS: AgentPreset[] = [
  {
    label: 'Executor (Haiku)',
    name: 'executor',
    description: 'Executa tarefas mecânicas e bem especificadas que o planejador delegar: editar arquivos indicados, aplicar mudanças repetitivas, rodar comandos de verificação.',
    model: 'haiku',
    tools: 'Read, Grep, Glob, Edit, Write, Bash, PowerShell',
    prompt: EXECUTOR_RULES,
  },
  {
    label: 'Pesquisador (Haiku, só leitura)',
    name: 'pesquisador',
    description: 'Procura no código e resume o que encontrou: onde algo está definido, quem usa uma função, como uma parte funciona. Não altera nada.',
    model: 'haiku',
    tools: 'Read, Grep, Glob',
    prompt:
      'Você é um pesquisador de código. Encontre o que foi pedido e responda com caminhos de arquivo:linha e um resumo curto.\n- Não altere arquivos.\n- Não cole arquivos inteiros: no máximo trechos de poucas linhas quando forem essenciais.\n- Não chame outros agents; se a busca for grande demais, diga o que falta cobrir.\n- Diga claramente o que não encontrou.',
  },
  {
    label: 'Revisor (Sonnet)',
    name: 'revisor',
    description: 'Revisa uma mudança feita por um executor antes de ela ser aceita: procura bugs, regressões e desvios do pedido.',
    model: 'sonnet',
    tools: 'Read, Grep, Glob',
    prompt:
      'Você é um revisor. Compare a mudança com o que foi pedido.\n- Aponte cada problema com arquivo:linha e um cenário concreto de falha.\n- Separe bug de estilo.\n- Não corrija nem chame outros agents: devolva os achados para quem pediu.\n- Termine com um veredito: aprovado ou reprovado.\n- Se estiver tudo certo, diga isso em uma linha.',
  },
];

/** Agents que cada roteiro chama pelo nome (os passos estão em server/staff/ficha.ts). */
export const PLAYBOOK_AGENTS: Record<Playbook, string[]> = {
  'plan-big-execute-small': ['executor'],
  'scout-then-build': ['pesquisador', 'executor'],
  'review-gate': ['executor', 'revisor'],
};
