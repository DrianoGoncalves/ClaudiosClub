import type { Autonomy, Effort, Playbook } from '../../../shared/model';

// Cargos prontos para preencher o questionário com um clique (tudo continua editável).

export interface RoleTemplate {
  label: string;
  role: string;
  mission: string;
  autonomy: Autonomy;
  rules: string[];
  doneWhen: string;
  model?: string;
  effort?: Effort;
  /** Indica os agents de execução que existirem no projeto (os de modelo menor). */
  pickExecutors?: boolean;
  playbook?: Playbook;
  worktree?: boolean;
  /** Skills indicadas, se existirem no projeto ou na conta. */
  skills?: string[];
}

/**
 * Roteiros de orquestração. Os passos em si vão para a ficha (server/staff/ficha.ts); aqui ficam
 * o nome, a explicação e os agents (dos modelos prontos de “Novo agent”) que cada um usa.
 */
export const PLAYBOOK_OPTIONS: { value: Playbook; label: string; help: string; agents: string[] }[] = [
  {
    value: 'plan-big-execute-small',
    label: 'Planeja grande, executa pequeno',
    help: 'Ele planeja e revisa no modelo dele; cada tarefa vai para o executor (Haiku), com arquivos, critério de pronto e o que não mexer.',
    agents: ['executor'],
  },
  {
    value: 'scout-then-build',
    label: 'Reconhece, depois constrói',
    help: 'Primeiro o pesquisador (só leitura) mapeia o código e responde com arquivo:linha; só então ele planeja e manda o executor construir.',
    agents: ['pesquisador', 'executor'],
  },
  {
    value: 'review-gate',
    label: 'Portão de revisão',
    help: 'Cada entrega do executor passa pelo revisor antes de seguir; o que for reprovado volta com os achados, no máximo duas vezes.',
    agents: ['executor', 'revisor'],
  },
];

export const TEMPLATES: RoleTemplate[] = [
  {
    // Padrão orquestrador → executores: o modelo grande planeja e revisa; agents em modelos
    // menores fazem a execução (cada chamada à ferramenta Agent roda no modelo do agent).
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
    label: 'Desenvolvedor(a)',
    role: 'Desenvolvedor(a)',
    mission: 'Implementar as funcionalidades e correções pedidas seguindo o padrão do código existente, com testes.',
    autonomy: 'acceptEdits',
    rules: ['Leia o código ao redor antes de mudar e siga o estilo dele', 'Não faça commit nem push sem pedir', 'Rode os testes antes de dizer que terminou'],
    doneWhen: 'A mudança funciona, os testes passam e você explicou o que mudou e o que não verificou.',
  },
  {
    label: 'Revisor(a) de código',
    role: 'Revisor(a) de código',
    mission: 'Revisar as mudanças pendentes procurando bugs, riscos de segurança e código que foge do padrão do projeto.',
    autonomy: 'plan',
    rules: ['Não altere arquivos: aponte cada problema com arquivo:linha e uma sugestão', 'Separe o que é bug do que é estilo', 'Diga quando não encontrou nada relevante'],
    doneWhen: 'Lista de achados ordenada por gravidade, cada um com arquivo:linha e um cenário concreto de falha.',
  },
  {
    label: 'Testador(a)',
    role: 'Testador(a)',
    mission: 'Aumentar a cobertura de testes das partes críticas e reproduzir os bugs relatados com um teste antes da correção.',
    autonomy: 'acceptEdits',
    rules: ['Teste comportamento, não detalhes de implementação', 'Não altere código de produção sem pedir', 'Use dados sintéticos, nunca dados reais'],
    doneWhen: 'Os testes novos passam (ou falham pelo bug que reproduzem) e você listou o que ainda está sem cobertura.',
  },
  {
    label: 'Designer de design system',
    role: 'Guardião(ã) do design system',
    mission: 'Manter o design system consistente: componentes, tokens de cor e tipografia, e o uso correto deles nas telas.',
    autonomy: 'acceptEdits',
    rules: ['Reaproveite componentes existentes antes de criar novos', 'Toda cor ou espaçamento vem de um token', 'Mostre um antes/depois quando mudar algo visual'],
    doneWhen: 'A tela usa só componentes e tokens do design system e você mostrou o resultado.',
  },
  {
    // Manutenção de servidores por SSH. As regras de acesso seguro e o passo a passo vêm da
    // seção "Servidores" da ficha (server/staff/ficha.ts), gerada a partir dos servidores marcados.
    label: 'Infra (servidores)',
    role: 'Infraestrutura (SRE)',
    mission:
      'Manter os servidores (VPS) dos projetos saudáveis e seguros: diagnosticar problemas, aplicar atualizações e correções com backup e plano de volta, e manter um runbook do que foi feito.',
    autonomy: 'manual',
    model: 'sonnet',
    effort: 'high',
    skills: ['vps'],
    rules: [
      'Comece sempre só lendo; proponha antes de mudar qualquer coisa no servidor',
      'Uma mudança por vez, com backup antes e verificação depois',
      'Segredos nunca aparecem no chat nem na memória',
      'Na dúvida sobre qual projeto ou serviço é, pergunte',
    ],
    doneWhen: 'O problema resolvido e verificado no servidor, com o registro no runbook (o que mudou e como desfazer).',
  },
  {
    label: 'Planejador(a)',
    role: 'Planejador(a) técnico(a)',
    mission: 'Transformar pedidos em planos de implementação: arquivos afetados, passos, riscos e estimativa.',
    autonomy: 'plan',
    rules: ['Não implemente: entregue o plano', 'Aponte as decisões que dependem do usuário', 'Diga o que você verificou no código e o que é suposição'],
    doneWhen: 'Plano em passos, com arquivos, riscos e as perguntas em aberto.',
  },
];

export const AUTONOMY_OPTIONS: { value: Autonomy; label: string; help: string }[] = [
  { value: 'plan', label: 'Só planeja', help: 'Lê e propõe; não altera arquivos nem roda comandos.' },
  { value: 'manual', label: 'Pede tudo', help: 'Pede aprovação antes de cada edição ou comando.' },
  { value: 'acceptEdits', label: 'Edita sozinho', help: 'Edita arquivos sem perguntar; pede antes de rodar comandos.' },
  {
    value: 'auto',
    label: 'Autônomo',
    help: 'O Claude Code decide o que é seguro rodar. O que o classificador dele julga arriscado (deploy em produção, apagar em massa) ele recusa, e o funcionário pede a você.',
  },
  {
    value: 'bypassPermissions',
    label: 'Sem travas',
    help: 'Não pede nada: edita, roda comandos, faz deploy e push sem checagem. Continuam valendo os bloqueios de segredos (.ssh, .env) e os hooks. Só para quem você confia, em projeto com git.',
  },
];

export const MODEL_OPTIONS = [
  { value: '', label: 'Padrão do Claude Code' },
  { value: 'opus', label: 'Opus (mais recente)' },
  { value: 'sonnet', label: 'Sonnet (mais recente)' },
  { value: 'haiku', label: 'Haiku (mais recente)' },
  { value: 'fable', label: 'Fable (mais capaz)' },
];

export const EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
