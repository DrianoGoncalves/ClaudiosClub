// Modelos de equipe: uma equipe pronta (cargos de shared/roles.ts + hierarquia) para um tipo de projeto. Aplicar um modelo só cria as
// fichas (server/staff/service.ts `applyTeamTemplate`): nenhuma tarefa, nenhuma conversa, nada começa sozinho. O cliente importa
// esta lista para mostrar nome e cargo de cada pessoa antes de aplicar; os ids das fichas nascem na hora de aplicar.

export interface TeamTemplateMember {
  /** Só vale dentro do modelo: `reportsTo` aponta para ela. */
  key: string;
  /** Nome fixo da pessoa neste modelo. */
  name: string;
  /** Id de um cargo pronto de shared/roles.ts (a ficha sai dele). */
  roleId: string;
  /** Chaves de quem ele reporta, sempre de membros que vêm antes na lista; vazio = reporta ao usuário. */
  reportsTo: string[];
}

export interface TeamTemplate {
  /** Estável: é o `templateId` da API. */
  id: string;
  label: string;
  description: string;
  members: TeamTemplateMember[];
}

// Todos reportam ao orquestrador: cada cargo tem uma área sem sobreposição (ver shared/roles.ts), então um nível só basta e o
// orquestrador é o único que o usuário procura. Dois orquestradores no mesmo projeto confundem quem recebe o pedido: por isso o modelo
// nunca é somado a uma equipe que já existe.
export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'site-landing-page',
    label: 'Site / landing page',
    description: 'Uma equipe para criar e publicar um site ou uma landing page: identidade e layout, código da página e anúncios.',
    members: [
      { key: 'lider', name: 'Marina', roleId: 'orquestrador', reportsTo: [] },
      { key: 'design', name: 'Caio', roleId: 'web-designer', reportsTo: ['lider'] },
      { key: 'front', name: 'Bia', roleId: 'frontend', reportsTo: ['lider'] },
      { key: 'trafego', name: 'Rafael', roleId: 'trafego', reportsTo: ['lider'] },
    ],
  },
  {
    id: 'manutencao-saas',
    label: 'Manutenção de SaaS',
    description: 'Uma equipe para manter um SaaS no ar: correções e melhorias, testes, segurança e infraestrutura.',
    members: [
      { key: 'lider', name: 'Helena', roleId: 'orquestrador', reportsTo: [] },
      { key: 'dev', name: 'Tiago', roleId: 'desenvolvedor', reportsTo: ['lider'] },
      { key: 'front', name: 'Laura', roleId: 'frontend', reportsTo: ['lider'] },
      { key: 'qa', name: 'Otávio', roleId: 'testador', reportsTo: ['lider'] },
      { key: 'seg', name: 'Renata', roleId: 'seguranca', reportsTo: ['lider'] },
      { key: 'infra', name: 'Davi', roleId: 'infra', reportsTo: ['lider'] },
    ],
  },
];

export const teamTemplateById = (id: string): TeamTemplate | undefined => TEAM_TEMPLATES.find((t) => t.id === id);
