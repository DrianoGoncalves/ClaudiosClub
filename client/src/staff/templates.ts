import type { Autonomy, Playbook } from '../../../shared/model';

// Opções do questionário do funcionário. Os cargos (modelos de ficha) ficam em shared/roles.ts e
// nas configurações (config → Cargos), onde dá para editar os prontos e criar os seus.

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
