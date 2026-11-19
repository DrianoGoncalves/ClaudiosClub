import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Board, McpServerInfo, StaffProfile } from '../shared/model';
import staffMessages from '../client/src/i18n/staff';
import { StaffForm } from '../client/src/staff/HireForm';
import { planImpasse, toolsEdit, type PlanImpasse, type PlanImpasseCtx } from '../client/src/staff/planImpasse';
import { agentNotes, PlanImpasseNote } from '../client/src/staff/PlanImpasseNote';

const READ = ['Read', 'Grep', 'Glob'];
const EDIT = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'PowerShell'];
const mcp = (name: string, tools?: McpServerInfo['tools']): McpServerInfo => ({ name, source: 'club', transport: 'stdio', ...(tools && { tools }) });

const ctx = (over: Partial<PlanImpasseCtx> = {}): PlanImpasseCtx => ({
  autonomy: 'plan',
  engine: 'claude',
  agents: [],
  agentFiles: [],
  playbook: '',
  mcps: null,
  mcpOn: new Set(),
  mcpAccess: {},
  browser: false,
  codexBrowser: false,
  ...over,
});

describe('impasse "Só planeja" × agent que edita', () => {
  it('só avisa em plan: nas outras autonomias, o mesmo agent não é impasse', () => {
    const agentFiles = [{ name: 'executor', tools: EDIT }];
    expect(planImpasse(ctx({ agents: ['executor'], agentFiles }))).toEqual({ agents: ['executor'], playbookAgents: [], mcps: [], browser: false });
    for (const autonomy of ['manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const) expect(planImpasse(ctx({ autonomy, agents: ['executor'], agentFiles }))).toBeNull();
  });

  it('agent que só lê (pesquisador, revisor) não é impasse; o que grava ou roda comando é', () => {
    const agentFiles = [
      { name: 'pesquisador', tools: READ },
      { name: 'revisor', tools: READ },
      { name: 'executor', tools: EDIT },
      { name: 'escritor', tools: ['Read', 'Write'] },
      { name: 'shell', tools: ['Read', 'PowerShell'] },
    ];
    expect(planImpasse(ctx({ agents: ['pesquisador', 'revisor'], agentFiles }))).toBeNull();
    expect(planImpasse(ctx({ agents: ['pesquisador', 'executor', 'escritor', 'shell'], agentFiles }))?.agents).toEqual(['executor', 'escritor', 'shell']);
  });

  it('ferramenta com regra (`Bash(git:*)`) e NotebookEdit contam; sem lista de ferramentas o agent herda todas e conta', () => {
    expect(toolsEdit(['Read', 'Bash(git:*)'])).toBe(true);
    expect(toolsEdit(['Read', 'NotebookEdit'])).toBe(true);
    expect(toolsEdit(['Read', 'Grep', 'WebFetch'])).toBe(false);
    expect(toolsEdit(['Bashful'])).toBe(false);
    expect(toolsEdit(null)).toBe(true);
    expect(toolsEdit(undefined)).toBe(true);
    expect(planImpasse(ctx({ agents: ['livre'], agentFiles: [{ name: 'livre', tools: null }] }))?.agents).toEqual(['livre']);
  });

  it('o pronto que ainda não tem arquivo vale pelas ferramentas do pronto; nome desconhecido sem arquivo não conta', () => {
    expect(planImpasse(ctx({ agents: ['executor', 'executor-rapido'] }))?.agents).toEqual(['executor', 'executor-rapido']);
    expect(planImpasse(ctx({ agents: ['pesquisador', 'revisor'] }))).toBeNull();
    expect(planImpasse(ctx({ agents: ['fantasma'] }))).toBeNull();
  });

  it('o arquivo do projeto manda sobre o pronto: executor com só leitura não é impasse', () => {
    expect(planImpasse(ctx({ agents: ['executor'], agentFiles: [{ name: 'executor', tools: READ }] }))).toBeNull();
  });

  it('mesmo nome no projeto e na conta: vale o do projeto, em qualquer ordem da lista (como no Claude Code)', () => {
    const user = { name: 'executor', tools: EDIT, scope: 'user' as const };
    const project = { name: 'executor', tools: READ, scope: 'project' as const };
    expect(planImpasse(ctx({ agents: ['executor'], agentFiles: [project, user] }))).toBeNull();
    expect(planImpasse(ctx({ agents: ['executor'], agentFiles: [user, project] }))).toBeNull();
    // o contrário: o do projeto edita e o da conta não
    expect(planImpasse(ctx({ agents: ['executor'], agentFiles: [{ ...user, tools: READ }, { ...project, tools: EDIT }] }))?.agents).toEqual(['executor']);
    // sem `scope`, vale o primeiro da lista
    expect(planImpasse(ctx({ agents: ['executor'], agentFiles: [{ name: 'executor', tools: READ }, { name: 'executor', tools: EDIT }] }))).toBeNull();
  });

  it('o roteiro conta (os agents dele são criados ao abrir a conversa), sem repetir o que já está marcado', () => {
    expect(planImpasse(ctx({ playbook: 'plan-big-execute-small' }))?.agents).toEqual(['executor', 'executor-rapido']);
    expect(planImpasse(ctx({ playbook: 'scout-then-build' }))?.agents).toEqual(['executor']);
    expect(planImpasse(ctx({ playbook: 'review-gate' }))?.agents).toEqual(['executor']);
    expect(planImpasse(ctx({ playbook: 'scout-then-build', agents: ['executor', 'pesquisador'] }))?.agents).toEqual(['executor']);
  });

  it('playbookAgents: só os que o roteiro chama (mesmo marcados na lista); o marcado direto fica de fora, e o aviso (agents) não muda', () => {
    const agentFiles = [{ name: 'escritor', tools: ['Read', 'Write'] }];
    // marcado direto e fora do roteiro
    expect(planImpasse(ctx({ agents: ['executor'] }))).toMatchObject({ agents: ['executor'], playbookAgents: [] });
    // vem do roteiro, o projeto nem tem o agent: não há o que desmarcar
    expect(planImpasse(ctx({ playbook: 'scout-then-build' }))).toMatchObject({ agents: ['executor'], playbookAgents: ['executor'] });
    // marcado na lista E chamado pelo roteiro: é do roteiro (desmarcar não limpa o aviso)
    expect(planImpasse(ctx({ playbook: 'scout-then-build', agents: ['executor'] }))).toMatchObject({ agents: ['executor'], playbookAgents: ['executor'] });
    // misto: um do roteiro, outro só marcado
    expect(planImpasse(ctx({ playbook: 'scout-then-build', agents: ['escritor'], agentFiles }))).toMatchObject({ agents: ['escritor', 'executor'], playbookAgents: ['executor'] });
    // o que só lê (pesquisador) não entra, mesmo chamado pelo roteiro
    expect(planImpasse(ctx({ playbook: 'plan-big-execute-small' }))?.playbookAgents).toEqual(['executor', 'executor-rapido']);
  });

  it('Codex: a lista de agents e os MCPs não valem (a ficha sai sem eles); o roteiro vale, na mesma sandbox só leitura', () => {
    const agentFiles = [{ name: 'executor', tools: EDIT }];
    expect(planImpasse(ctx({ engine: 'codex', agents: ['executor'], agentFiles, mcps: [mcp('x')], mcpOn: new Set(['x']) }))).toBeNull();
    expect(planImpasse(ctx({ engine: 'codex', playbook: 'plan-big-execute-small' }))).toEqual({ agents: ['executor', 'executor-rapido'], playbookAgents: ['executor', 'executor-rapido'], mcps: [], browser: false });
  });
});

describe('impasse "Só planeja" × MCP Livre', () => {
  const list = [mcp('github'), mcp('lido', { total: 4, write: 0 }), mcp('grava', { total: 6, write: 2 }), mcp('fechado'), mcp('desmarcado')];
  const on = new Set(['github', 'lido', 'grava', 'fechado']);

  it('Livre (o padrão, sem chave no mapa) e marcado: entra; o testado sem ferramenta de escrita não tem o que travar', () => {
    expect(planImpasse(ctx({ mcps: list, mcpOn: on }))?.mcps).toEqual(['github', 'grava', 'fechado']);
  });

  it('Pede antes, Só leitura e Desligado tiram o MCP do aviso; MCP desmarcado nunca entra', () => {
    const mcpAccess = { github: 'readonly', grava: 'ask', fechado: 'off' } as const;
    expect(planImpasse(ctx({ mcps: list, mcpOn: on, mcpAccess }))).toBeNull();
    expect(planImpasse(ctx({ mcps: list, mcpOn: new Set(), mcpAccess: {} }))).toBeNull();
  });

  it('sem plan não há aviso, e a lista que não carregou (null) não quebra', () => {
    expect(planImpasse(ctx({ autonomy: 'acceptEdits', mcps: list, mcpOn: on }))).toBeNull();
    expect(planImpasse(ctx({ mcps: null }))).toBeNull();
  });

  it('agent e MCP juntos: os dois vêm no mesmo aviso', () => {
    expect(planImpasse(ctx({ agents: ['executor'], mcps: list, mcpOn: new Set(['github']) }))).toEqual({ agents: ['executor'], playbookAgents: [], mcps: ['github'], browser: false });
  });
});

describe('impasse "Só planeja" × navegador Livre', () => {
  it('Claude: navegador marcado e Livre (o padrão da ficha) avisa; as outras travas e o navegador desmarcado não', () => {
    expect(planImpasse(ctx({ browser: true }))).toEqual({ agents: [], playbookAgents: [], mcps: [], browser: true });
    for (const level of ['ask', 'readonly', 'off'] as const) {
      expect(planImpasse(ctx({ browser: true, mcpAccess: { 'claude-in-chrome': level, 'myco-chrome': level } }))).toBeNull();
    }
    expect(planImpasse(ctx({ browser: false }))).toBeNull();
  });

  it('o seletor vale pelo mais restritivo das duas chaves do navegador', () => {
    expect(planImpasse(ctx({ browser: true, mcpAccess: { 'myco-chrome': 'readonly' } }))).toBeNull();
    expect(planImpasse(ctx({ browser: true, mcpAccess: { 'claude-in-chrome': 'off' } }))).toBeNull();
  });

  it('Codex: só com o Chrome do GPT ligado nas Configurações (sem ele o navegador não sobe)', () => {
    expect(planImpasse(ctx({ engine: 'codex', browser: true, codexBrowser: true }))).toEqual({ agents: [], playbookAgents: [], mcps: [], browser: true });
    expect(planImpasse(ctx({ engine: 'codex', browser: true, codexBrowser: false }))).toBeNull();
    expect(planImpasse(ctx({ engine: 'codex', browser: true, codexBrowser: true, mcpAccess: { 'myco-chrome': 'readonly' } }))).toBeNull();
    expect(planImpasse(ctx({ engine: 'codex', browser: false, codexBrowser: true }))).toBeNull();
  });

  it('sem plan não há aviso do navegador', () => {
    for (const autonomy of ['manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const) expect(planImpasse(ctx({ autonomy, browser: true }))).toBeNull();
  });
});

describe('o aviso na ficha', () => {
  const note = (impasse: Partial<PlanImpasse>, engine: 'claude' | 'codex' = 'claude') =>
    renderToStaticMarkup(createElement(PlanImpasseNote, { engine, impasse: { agents: [], playbookAgents: [], mcps: [], browser: false, ...impasse } }));

  it('Claude: título, nomes, a saída pelo pesquisador e o MCP em Só leitura; é uma nota (role="note"), não um erro', () => {
    const html = note({ agents: ['executor', 'executor-rapido'], mcps: ['github'] });
    expect(html).toContain('role="note"');
    expect(html).toContain('Impasse: “Só planeja” não grava');
    expect(html).toContain('executor, executor-rapido');
    expect(html).toContain('pesquisador');
    expect(html).toContain('MCP em “Livre” não tem trava de escrita');
    expect(html).toContain('em “Só planeja” quem segura é o próprio modelo (github)');
    expect(html).toContain('Para garantir, use “Só leitura”');
    expect(html).not.toContain('escapa');
    expect(html).not.toMatch(/\{\w+\}/);
  });

  it('o navegador entra na lista do MCP, depois dos MCPs', () => {
    expect(note({ mcps: ['github'], browser: true })).toContain('(github, navegador)');
    expect(note({ browser: true })).toContain('(navegador)');
  });

  it('só o que tem: sem MCP nem navegador não fala de MCP; sem agent não fala de agent', () => {
    expect(note({ agents: ['executor'] })).not.toContain('MCP em');
    const onlyMcp = note({ mcps: ['github'] });
    expect(onlyMcp).not.toContain('herda o modo');
    expect(onlyMcp).not.toContain('gasta consumo');
  });

  it('concordância: 1 agent no singular, 2 ou mais no plural (Claude e Codex)', () => {
    expect(note({ agents: ['executor'] })).toContain('O agent herda o modo e não grava: executor só gasta consumo. Tire-o da ficha');
    expect(note({ agents: ['executor', 'executor-rapido'] })).toContain('Os agents herdam o modo e não gravam: executor, executor-rapido só gastam consumo. Tire-os da ficha');
    expect(note({ agents: ['executor'], playbookAgents: ['executor'] }, 'codex')).toContain('No Codex o agent roda na mesma sandbox, só de leitura, e não grava: executor só gasta consumo. Tire o roteiro que o chama');
    expect(note({ agents: ['executor', 'executor-rapido'], playbookAgents: ['executor', 'executor-rapido'] }, 'codex')).toContain(
      'No Codex os agents rodam na mesma sandbox, só de leitura, e não gravam: executor, executor-rapido só gastam consumo. Tire o roteiro que os chama',
    );
  });

  it('Codex: não manda usar o pesquisador (o roteiro é que chama o agent)', () => {
    expect(note({ agents: ['executor'], playbookAgents: ['executor'] }, 'codex')).not.toContain('use o “pesquisador”');
  });

  it('Claude, agent que vem do roteiro: manda trocar o roteiro ou a autonomia, não tirar da ficha (desmarcar não limpa o aviso)', () => {
    const html = note({ agents: ['executor'], playbookAgents: ['executor'] });
    expect(html).toContain('O roteiro chama o agent executor, que herda o modo e não grava: só gasta consumo. Troque o roteiro ou escolha uma autonomia que edite.');
    expect(html).not.toMatch(/Tire-o|Tire-os|da ficha|pesquisador/);
    const plural = note({ agents: ['executor', 'executor-rapido'], playbookAgents: ['executor', 'executor-rapido'] });
    expect(plural).toContain('O roteiro chama os agents executor, executor-rapido, que herdam o modo e não gravam: só gastam consumo. Troque o roteiro ou escolha uma autonomia que edite.');
    expect(plural).not.toMatch(/Tire-o|Tire-os|da ficha/);
  });

  it('Claude, agent marcado direto na ficha (fora do roteiro): segue com "tire-o da ficha"', () => {
    const html = note({ agents: ['executor'], playbookAgents: [] });
    expect(html).toContain('Tire-o da ficha ou use o “pesquisador”');
    expect(html).not.toContain('Troque o roteiro');
    expect(html).not.toContain('O roteiro chama');
  });

  it('Claude, misto: cada agent no conselho da sua origem (o do roteiro não aparece no "tire-o da ficha")', () => {
    const html = note({ agents: ['escritor', 'executor'], playbookAgents: ['executor'] });
    expect(html).toContain('O agent herda o modo e não grava: escritor só gasta consumo. Tire-o da ficha');
    expect(html).toContain('O roteiro chama o agent executor, que herda o modo');
    expect(html).not.toContain('escritor, executor');
    expect(html.match(/<p>/g)).toHaveLength(3);
  });
});

describe('a escolha do texto de agents (agentNotes)', () => {
  const pick = (impasse: Partial<PlanImpasse>, engine: 'claude' | 'codex' = 'claude') => agentNotes({ agents: [], playbookAgents: [], mcps: [], browser: false, ...impasse }, engine);

  it('Claude: marcado direto → texto da ficha; do roteiro → texto do roteiro; singular e plural por origem', () => {
    expect(pick({ agents: ['a'] })).toEqual([{ key: 'staff.planImpasse.agentsOne', names: ['a'] }]);
    expect(pick({ agents: ['a', 'b'] })).toEqual([{ key: 'staff.planImpasse.agentsOther', names: ['a', 'b'] }]);
    expect(pick({ agents: ['a'], playbookAgents: ['a'] })).toEqual([{ key: 'staff.planImpasse.agentsPlaybookOne', names: ['a'] }]);
    expect(pick({ agents: ['a', 'b'], playbookAgents: ['a', 'b'] })).toEqual([{ key: 'staff.planImpasse.agentsPlaybookOther', names: ['a', 'b'] }]);
    expect(pick({ agents: ['a', 'b', 'c'], playbookAgents: ['b'] })).toEqual([
      { key: 'staff.planImpasse.agentsOther', names: ['a', 'c'] },
      { key: 'staff.planImpasse.agentsPlaybookOne', names: ['b'] },
    ]);
  });

  it('Codex: tudo vem do roteiro e usa o texto do Codex', () => {
    expect(pick({ agents: ['a'], playbookAgents: ['a'] }, 'codex')).toEqual([{ key: 'staff.planImpasse.agentsCodexOne', names: ['a'] }]);
    expect(pick({ agents: ['a', 'b'], playbookAgents: ['a', 'b'] }, 'codex')).toEqual([{ key: 'staff.planImpasse.agentsCodexOther', names: ['a', 'b'] }]);
  });

  it('sem agent não há parágrafo de agent', () => {
    expect(pick({})).toEqual([]);
    expect(pick({}, 'codex')).toEqual([]);
  });
});

describe('i18n do aviso (pt, en, es)', () => {
  const keys = [
    'staff.planImpasse.title',
    'staff.planImpasse.agentsOne',
    'staff.planImpasse.agentsOther',
    'staff.planImpasse.agentsPlaybookOne',
    'staff.planImpasse.agentsPlaybookOther',
    'staff.planImpasse.agentsCodexOne',
    'staff.planImpasse.agentsCodexOther',
    'staff.planImpasse.mcps',
    'staff.planImpasse.browser',
  ] as const;

  it('as chaves existem nos 3 idiomas, com as mesmas variáveis, e en/es não são o texto em português', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keys) {
      const pt = staffMessages['pt-BR'][key];
      for (const lang of ['en', 'es'] as const) {
        const text = staffMessages[lang][key];
        expect(text, `${lang} ${key}`).toBeTruthy();
        // "navegador" é a mesma palavra em português e espanhol.
        if (!(lang === 'es' && key === 'staff.planImpasse.browser')) expect(text).not.toBe(pt);
        expect(vars(text), `${lang} ${key}`).toEqual(vars(pt));
      }
    }
  });

  it('singular e plural diferem em cada idioma (verbo concorda), e o texto de MCP não diz mais que escapa do plano', () => {
    for (const lang of ['pt-BR', 'en', 'es'] as const) {
      const m = staffMessages[lang];
      expect(m['staff.planImpasse.agentsOne']).not.toBe(m['staff.planImpasse.agentsOther']);
      expect(m['staff.planImpasse.agentsPlaybookOne']).not.toBe(m['staff.planImpasse.agentsPlaybookOther']);
      expect(m['staff.planImpasse.agentsCodexOne']).not.toBe(m['staff.planImpasse.agentsCodexOther']);
      // o do roteiro manda trocar o roteiro, nunca tirar da ficha (en: "Remove it from the profile"; es: "Quítalo de la ficha")
      expect(m['staff.planImpasse.agentsPlaybookOne']).not.toMatch(/ficha|profile|Tire|Remove|Quít/);
      expect(m['staff.planImpasse.agentsPlaybookOther']).not.toMatch(/ficha|profile|Tire|Remove|Quít/);
      expect(m['staff.planImpasse.mcps']).not.toMatch(/escapa|escapes/);
      expect(m['staff.mcpAccessIntro']).not.toMatch(/escapa|escapes/);
    }
    expect(staffMessages.en['staff.planImpasse.agentsOne']).toContain('only burns usage');
    expect(staffMessages.en['staff.planImpasse.agentsOther']).toContain('only burn usage');
    expect(staffMessages.es['staff.planImpasse.agentsOne']).toContain('solo gasta consumo');
    expect(staffMessages.es['staff.planImpasse.agentsOther']).toContain('solo gastan consumo');
  });
});

describe('ficha aberta (contratar/editar): o aviso aparece só no impasse', () => {
  const board = (): Board =>
    ({
      projects: [{ id: 'p1', name: 'Loja', path: 'C:/loja', exists: true }],
      inventories: { p1: { agents: [{ name: 'executor', description: null, tools: EDIT, model: 'sonnet', effort: 'medium', scope: 'project' }, { name: 'pesquisador', description: null, tools: READ, model: 'haiku', effort: 'low', scope: 'project' }], skills: [] } },
      user: { agents: [], skills: [] },
      staff: [],
    }) as unknown as Board;
  /** `browser: false` por padrão: o navegador vem ligado e Livre, e já é impasse sozinho (testado à parte). */
  const open = (over: Partial<StaffProfile>, extra: { codexBrowser?: boolean } = {}) => {
    const profile = { id: 's1', projectId: 'p1', name: 'Jinx', role: 'Design', mission: 'm', autonomy: 'plan', skills: [], agents: [], servers: [], reportsTo: [], rules: [], knowledge: [], browser: false, ...over } as unknown as StaffProfile;
    return renderToStaticMarkup(createElement(StaffForm, { board: board(), projectId: 'p1', mode: { kind: 'edit', profile }, onClose: () => {}, onHired: () => {}, onSaved: () => {}, ...extra }));
  };
  const hire = (initial: { autonomy?: 'plan' | 'manual'; agents?: string[] }) =>
    renderToStaticMarkup(createElement(StaffForm, { board: board(), projectId: 'p1', mode: { kind: 'hire', reportsTo: [] }, initial, onClose: () => {}, onHired: () => {}, onSaved: () => {} }));

  it('editar: plan + executor marcado mostra o impasse, dentro do campo Autonomia', () => {
    const html = open({ agents: ['executor'] });
    expect(html).toContain('plan-impasse');
    expect(html).toContain('Impasse: “Só planeja” não grava');
    expect(html.indexOf('plan-impasse')).toBeGreaterThan(html.indexOf('<legend>Autonomia</legend>'));
  });

  it('editar: plan + só o pesquisador (sem navegador) não mostra aviso', () => {
    expect(open({ agents: ['pesquisador'] })).not.toContain('plan-impasse');
  });

  it('editar: outra autonomia com o mesmo executor não mostra aviso', () => {
    expect(open({ autonomy: 'acceptEdits', agents: ['executor'] })).not.toContain('plan-impasse');
  });

  it('editar: Codex com roteiro que chama o executor mostra a versão do Codex (a lista de agents nem existe)', () => {
    const html = open({ engine: 'codex', playbook: 'plan-big-execute-small' });
    expect(html).toContain('plan-impasse');
    expect(html).toContain('No Codex os agents rodam na mesma sandbox');
  });

  it('editar: Claude com roteiro que chama o executor manda trocar o roteiro (mesmo com o executor marcado na lista); marcado direto segue com "tire-o da ficha"', () => {
    for (const agents of [[], ['executor']]) {
      const html = open({ playbook: 'scout-then-build', agents });
      expect(html).toContain('O roteiro chama o agent executor');
      expect(html).toContain('Troque o roteiro ou escolha uma autonomia que edite');
      expect(html).not.toContain('Tire-o da ficha');
    }
    expect(open({ agents: ['executor'] })).toContain('Tire-o da ficha');
    expect(open({ agents: ['executor'] })).not.toContain('Troque o roteiro');
  });

  it('contratar: plan + executor marcado mostra o impasse; com Pede tudo (o padrão), não', () => {
    const html = hire({ autonomy: 'plan', agents: ['executor'] });
    expect(html).toContain('plan-impasse');
    expect(html).toContain('Impasse: “Só planeja” não grava');
    expect(html).toContain('O agent herda o modo e não grava: executor só gasta consumo');
    expect(html.indexOf('plan-impasse')).toBeGreaterThan(html.indexOf('<legend>Autonomia</legend>'));
    expect(hire({ autonomy: 'manual', agents: ['executor'] })).not.toContain('plan-impasse');
    expect(hire({})).not.toContain('plan-impasse');
  });

  it('contratar: o navegador, que vem ligado e Livre, já é impasse em plan (sem agent marcado)', () => {
    const html = hire({ autonomy: 'plan' });
    expect(html).toContain('plan-impasse');
    expect(html).toContain('(navegador)');
    expect(html).not.toContain('herda o modo');
  });

  it('editar: plan + navegador Livre avisa; Só leitura, ou navegador desmarcado, não', () => {
    expect(open({ browser: true })).toContain('(navegador)');
    expect(open({ browser: true, mcpAccess: { 'claude-in-chrome': 'readonly', 'myco-chrome': 'readonly' } })).not.toContain('plan-impasse');
    expect(open({ browser: false })).not.toContain('plan-impasse');
  });

  it('editar: no Codex o navegador só conta com o Chrome do GPT ligado nas Configurações', () => {
    expect(open({ engine: 'codex', browser: true }, { codexBrowser: true })).toContain('(navegador)');
    expect(open({ engine: 'codex', browser: true }, { codexBrowser: false })).not.toContain('plan-impasse');
  });
});
