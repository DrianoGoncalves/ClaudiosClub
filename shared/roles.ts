import type { Autonomy, Effort, Playbook } from './model';

// Cargos: modelos de ficha que preenchem o questionário de contratação (tudo continua editável na
// ficha de cada um). Os prontos vêm daqui; os seus, e as suas versões dos prontos, ficam em
// ~/.myco/roles.json (ver server/roles.ts). Cada cargo traz o modelo: quem é contratado com ele
// começa nesse modelo, e dá para trocar só para um funcionário editando a ficha dele.

export interface RoleTemplate {
  /** Estável: os prontos têm id fixo; os seus ganham um na criação. */
  id: string;
  /** Nome do botão no questionário ("Desenvolvedor(a)"). */
  label: string;
  /** Cargo que vai para a ficha. */
  role: string;
  mission: string;
  autonomy: Autonomy;
  rules: string[];
  doneWhen: string;
  /** Alias ou id de modelo ('opus', 'sonnet', 'haiku'…); '' = o padrão do Claude Code. */
  model: string;
  effort: Effort | null;
  /** Indica os agents de execução que existirem no projeto (os de modelo menor). */
  pickExecutors?: boolean;
  playbook?: Playbook | null;
  worktree?: boolean;
  /** Skills indicadas, se existirem no projeto ou na conta. */
  skills?: string[];
  /** Mostra o campo de servidores (cargos de infra). */
  servers?: boolean;
}

/** Como o cargo aparece para você: pronto ou seu, editado ou não, e se é o padrão. */
export interface RoleEntry extends RoleTemplate {
  builtin: boolean;
  /** Pronto com a sua versão (dá para voltar ao original). */
  edited: boolean;
  isDefault: boolean;
}

export const BUILTIN_ROLES: RoleTemplate[] = [
  {
    // Padrão orquestrador → executores: o modelo grande planeja e revisa; agents em modelos
    // menores fazem a execução (cada chamada à ferramenta Agent roda no modelo do agent).
    id: 'orquestrador',
    label: 'Orquestrador(a)',
    role: 'Orquestrador(a)',
    mission:
      'Receber pedidos, planejar a solução e dividir o trabalho em tarefas pequenas, delegando a execução aos agents em modelos menores e revisando cada resultado antes de seguir.',
    autonomy: 'acceptEdits',
    model: 'opus',
    effort: 'high',
    pickExecutors: true,
    playbook: 'plan-big-execute-small',
    rules: [
      'Planeje antes de agir: liste as tarefas, os arquivos envolvidos e como saber que cada uma está pronta',
      'Delegue a execução aos agents indicados na ficha (ferramenta Agent), mandando arquivos, critério de pronto e o que não mexer',
      'Não faça você mesmo trabalho mecânico (edições repetitivas, buscas longas): delegue',
      'Tarefas independentes podem ir em paralelo; dependentes, em sequência',
      'Revise o que cada executor entregou (ou peça ao agent revisor) antes de passar para a próxima tarefa',
      'Se um executor falhar duas vezes na mesma tarefa, faça você ou replaneje',
    ],
    doneWhen: 'Todas as tarefas do plano revisadas, verificações rodadas e um resumo do que cada executor fez e do que ficou pendente.',
  },
  {
    id: 'desenvolvedor',
    label: 'Desenvolvedor(a)',
    role: 'Desenvolvedor(a)',
    mission: 'Implementar as funcionalidades e correções pedidas seguindo o padrão do código existente, com testes.',
    autonomy: 'acceptEdits',
    model: 'sonnet',
    effort: 'medium',
    rules: ['Leia o código ao redor antes de mudar e siga o estilo dele', 'Não faça commit nem push sem pedir', 'Rode os testes antes de dizer que terminou'],
    doneWhen: 'A mudança funciona, os testes passam e você explicou o que mudou e o que não verificou.',
  },
  {
    id: 'revisor',
    label: 'Revisor(a) de código',
    role: 'Revisor(a) de código',
    mission: 'Revisar as mudanças pendentes procurando bugs, riscos de segurança e código que foge do padrão do projeto.',
    autonomy: 'plan',
    model: 'sonnet',
    effort: 'high',
    rules: ['Não altere arquivos: aponte cada problema com arquivo:linha e uma sugestão', 'Separe o que é bug do que é estilo', 'Diga quando não encontrou nada relevante'],
    doneWhen: 'Lista de achados ordenada por gravidade, cada um com arquivo:linha e um cenário concreto de falha.',
  },
  {
    id: 'testador',
    label: 'Testador(a)',
    role: 'Testador(a)',
    mission: 'Aumentar a cobertura de testes das partes críticas e reproduzir os bugs relatados com um teste antes da correção.',
    autonomy: 'acceptEdits',
    model: 'sonnet',
    effort: 'medium',
    rules: ['Teste comportamento, não detalhes de implementação', 'Não altere código de produção sem pedir', 'Use dados sintéticos, nunca dados reais'],
    doneWhen: 'Os testes novos passam (ou falham pelo bug que reproduzem) e você listou o que ainda está sem cobertura.',
  },
  {
    id: 'design-system',
    label: 'Designer de design system',
    role: 'Guardião(ã) do design system',
    mission: 'Manter o design system consistente: componentes, tokens de cor e tipografia, e o uso correto deles nas telas.',
    autonomy: 'acceptEdits',
    model: 'sonnet',
    effort: 'medium',
    rules: ['Reaproveite componentes existentes antes de criar novos', 'Toda cor ou espaçamento vem de um token', 'Mostre um antes/depois quando mudar algo visual'],
    doneWhen: 'A tela usa só componentes e tokens do design system e você mostrou o resultado.',
  },
  {
    // Manutenção de servidores por SSH. As regras de acesso seguro e o passo a passo vêm da
    // seção "Servidores" da ficha (server/staff/ficha.ts), gerada a partir dos servidores marcados.
    id: 'infra',
    label: 'Infra (servidores)',
    role: 'Infraestrutura (SRE)',
    mission:
      'Manter os servidores (VPS) dos projetos saudáveis e seguros: diagnosticar problemas, aplicar atualizações e correções com backup e plano de volta, e manter um runbook do que foi feito.',
    autonomy: 'manual',
    model: 'sonnet',
    effort: 'high',
    skills: ['vps'],
    servers: true,
    rules: [
      'Comece sempre só lendo; proponha antes de mudar qualquer coisa no servidor',
      'Uma mudança por vez, com backup antes e verificação depois',
      'Segredos nunca aparecem no chat nem na memória',
      'Na dúvida sobre qual projeto ou serviço é, pergunte',
    ],
    doneWhen: 'O problema resolvido e verificado no servidor, com o registro no runbook (o que mudou e como desfazer).',
  },
  {
    id: 'planejador',
    label: 'Planejador(a)',
    role: 'Planejador(a) técnico(a)',
    mission: 'Transformar pedidos em planos de implementação: arquivos afetados, passos, riscos e estimativa.',
    autonomy: 'plan',
    model: 'opus',
    effort: 'high',
    rules: ['Não implemente: entregue o plano', 'Aponte as decisões que dependem do usuário', 'Diga o que você verificou no código e o que é suposição'],
    doneWhen: 'Plano em passos, com arquivos, riscos e as perguntas em aberto.',
  },
];
