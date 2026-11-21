import { describe, expect, it } from 'vitest';
import type { Engine, StaffProfile } from '../shared/model';
import { renderFicha, type FichaContext } from '../server/staff/ficha';

// Economia de contexto (t-e63a03): o custo das conversas vem do que é relido a cada turno (prints, arquivo grande lido inteiro, revisão que explora o
// projeto, card gigante, conversa que não fecha). As regras saem no texto GERADO pela ficha (vale para todas as fichas, projetos e os dois motores),
// só para quem se aplica: prints com navegador, card pequeno para quem delega, revisão enxuta junto da seção de revisão.

const ENGINES: Engine[] = ['claude', 'codex'];

const person = (engine: Engine, over: Partial<StaffProfile> = {}): StaffProfile =>
  ({
    id: 'gil-1',
    projectId: 'p',
    name: 'Gil',
    role: 'Back-end',
    portrait: null,
    reportsTo: [],
    mission: 'Servidor',
    autonomy: 'acceptEdits',
    agents: [],
    skills: [],
    mcps: null,
    knowledge: [],
    rules: [],
    canHire: false,
    playbook: null,
    worktree: false,
    servers: [],
    browser: false,
    sessions: [],
    engine,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...over,
  }) as StaffProfile;

const ctx = (over: Partial<FichaContext> = {}): FichaContext => ({
  company: 'Acme',
  projectName: 'painel',
  projectPath: 'C:\\www\\painel',
  managerNames: ['Denzel'],
  fichaPath: '.myco\\staff\\gil-1.md',
  memoryPath: '.myco\\staff\\gil-1.memory.md',
  mycoUrl: 'http://127.0.0.1:4848',
  ...over,
});

const PRINTS = 'screenshot só os que o critério de pronto pede, no fim (não a cada ajuste)';
const PNG = 'não reabra o PNG que acabou de capturar: a imagem já está no contexto até o fim';
const LEITURA = 'Arquivo grande (folha de estilo, i18n, módulo longo) se lê por trecho';
const REVISAO = 'Trabalhe pelo diff e pelo resumo da entrega: abra só os trechos que o diff toca, sem explorar o projeto nem rodar o que o pedido de revisão já trouxe rodado';
const REVISAO_PRINTS = 'dos prints, confira que existem os que o critério pede e abra no máximo 1-2 por amostra; profundidade na medida do risco';
const CARD = 'um card cabe numa sessão (uma tela ou um fluxo): pedido maior vira cards menores, com blockedBy quando um depende do outro, e não um card gigante';
const LONGA = 'Numa tarefa, entregue o que o critério de pronto já cobre (sem cortar prova que ele exige) e avise o que falta, em vez de seguir acumulando.';

const count = (text: string, part: string) => text.split(part).length - 1;
const team = [{ id: 'ana-1', name: 'Ana', role: 'Back-end', mission: 'Servidor.' }];

describe('1. prints: conferir por texto e console, screenshot só os do critério (só com navegador)', () => {
  it('Claude com Chrome do usuário: a regra entra uma vez na seção Navegador', () => {
    const md = renderFicha(person('claude', { browser: true }), ctx());
    expect(count(md, PRINTS)).toBe(1);
    expect(md).toContain(PNG);
    expect(md).toContain('Confira a tela pelo texto da página e pelo console');
    expect(md.indexOf('## Navegador')).toBeLessThan(md.indexOf(PRINTS));
  });

  it('Claude só com o navegador limpo (sem Chrome do usuário): a regra também entra', () => {
    const md = renderFicha(person('claude'), ctx({ cleanBrowser: { mcp: true, motivos: [] } }));
    expect(count(md, PRINTS)).toBe(1);
  });

  it('Codex com Chrome do usuário (myco-chrome) ou com o navegador limpo: a regra entra uma vez', () => {
    expect(count(renderFicha(person('codex'), ctx({ codexChrome: { mcp: true, motivos: [] } })), PRINTS)).toBe(1);
    expect(count(renderFicha(person('codex'), ctx({ cleanBrowser: { mcp: true, motivos: [] } })), PRINTS)).toBe(1);
    // Os dois navegadores juntos: as regras comuns saem uma vez só.
    expect(count(renderFicha(person('codex'), ctx({ codexChrome: { mcp: true, motivos: [] }, cleanBrowser: { mcp: true, motivos: [] } })), PRINTS)).toBe(1);
  });

  it.each(ENGINES)('sem navegador (%s), ou com navegador que não entrou: a regra não aparece', (engine) => {
    expect(renderFicha(person(engine), ctx())).not.toContain(PRINTS);
    expect(renderFicha(person(engine), ctx({ cleanBrowser: { mcp: false, motivos: ['internet'] } }))).not.toContain(PRINTS);
    if (engine === 'codex') expect(renderFicha(person(engine), ctx({ codexChrome: { mcp: false, motivos: ['config'] } }))).not.toContain(PRINTS);
  });
});

describe('2. leitura: arquivo grande por trecho, sem reler o que já está no contexto (todas as fichas)', () => {
  it('Claude: Grep + Read com offset/limit', () => {
    const md = renderFicha(person('claude'), ctx());
    expect(count(md, LEITURA)).toBe(1);
    expect(md).toContain('(Grep + Read com offset/limit), não inteiro; não releia o que já está no contexto.');
    expect(md.indexOf('## Postura')).toBeLessThan(md.indexOf(LEITURA));
    expect(md.indexOf(LEITURA)).toBeLessThan(md.indexOf('## Manual do Claudio’s Club'));
  });

  it('Codex: o mesmo pedido, sem citar a ferramenta Read que ele não tem', () => {
    const md = renderFicha(person('codex'), ctx());
    expect(count(md, LEITURA)).toBe(1);
    expect(md).toContain('(ache o trecho com busca e leia só essas linhas), não inteiro; não releia o que já está no contexto.');
    expect(md).not.toContain('Read com offset');
  });

  it.each(ENGINES)('vale sem gestor e sem URL do Club (%s): é da ficha, não da fila', (engine) => {
    expect(renderFicha(person(engine), ctx({ managerNames: [], mycoUrl: '' }))).toContain(LEITURA);
  });
});

describe('3. revisão enxuta: pelo diff e pelo resumo, prints por amostra (junto da seção de revisão)', () => {
  it.each(ENGINES)('a regra entra uma vez, dentro de "Quem revisa", antes da falha que reprova (%s)', (engine) => {
    const md = renderFicha(person(engine), ctx());
    expect(count(md, REVISAO)).toBe(1);
    expect(md).toContain(`${REVISAO}; ${REVISAO_PRINTS}.`);
    expect(md.indexOf('## Follow-up de revisão')).toBeLessThan(md.indexOf('Quem revisa: o que é importante você REPROVA'));
    expect(md.indexOf('Quem revisa: o que é importante você REPROVA')).toBeLessThan(md.indexOf(REVISAO));
    expect(md.indexOf(REVISAO)).toBeLessThan(md.indexOf('Falha que invalida a aprovação'));
  });

  it.each(ENGINES)('sem a seção de revisão (sem URL do Club), a regra não aparece (%s)', (engine) => {
    expect(renderFicha(person(engine), ctx({ mycoUrl: '' }))).not.toContain(REVISAO);
  });

  it('a ficha do Codex continua sem a palavra "revisor" nem os termos do Claude (a regra não os traz)', () => {
    const md = renderFicha(person('codex'), ctx());
    for (const banned of [/revisor/i, /\bAgent\b/, /Chrome/, /Claude Code/, /mcp__/]) expect(md).not.toMatch(banned);
  });
});

describe('4. tamanho do card: um card cabe numa sessão (só para quem delega)', () => {
  it.each(ENGINES)('o gestor (%s) recebe a regra, junto de "Repasse sem pesquisar", sem a ordem antiga de nunca dividir', (engine) => {
    const md = renderFicha(person(engine), ctx({ managerNames: [], team }));
    expect(count(md, CARD)).toBe(1);
    expect(md.indexOf('Repasse sem pesquisar')).toBeLessThan(md.indexOf(CARD));
    expect(md.indexOf(CARD)).toBeLessThan(md.indexOf('Para passar uma tarefa:'));
    expect(md).not.toContain('sem você dividir nem planejar');
    // O que já valia: pedido de uma área só vai inteiro, sem o gestor planejar; partes de áreas diferentes viram uma tarefa para cada pessoa.
    expect(md).toContain('numa tarefa só para essa pessoa, sem você planejar;');
    expect(md).toContain('um pedido com partes de áreas diferentes vira uma tarefa para cada pessoa');
  });

  it.each(ENGINES)('quem não delega (sem equipe, ou só recebe tarefa) não recebe (%s)', (engine) => {
    expect(renderFicha(person(engine), ctx({ team: [] }))).not.toContain(CARD);
    expect(renderFicha(person(engine), ctx())).not.toContain(CARD);
  });
});

describe('5. contexto grande: fechar o que dá e entregar em vez de acumular', () => {
  it.each(ENGINES)('a linha do aviso de contexto ganha o que fazer numa tarefa, sem cortar a prova do critério (%s)', (engine) => {
    const md = renderFicha(person(engine), ctx());
    expect(count(md, LONGA)).toBe(1);
    expect(md).toContain('`[MyCo] Contexto desta conversa: …`, ela já está grande e cada resposta custa mais: feche o assunto atual e use o ponto de corte assim que for natural. ' + LONGA);
    // Ajuste da linha que já existia: não há uma segunda regra de contexto grande.
    expect(count(md, 'Contexto desta conversa')).toBe(1);
    expect(md.indexOf('## Memória')).toBeLessThan(md.indexOf(LONGA));
  });

  it.each(ENGINES)('vale também para quem não recebe tarefa de gestor (%s)', (engine) => {
    expect(renderFicha(person(engine), ctx({ managerNames: [] }))).toContain(LONGA);
  });
});
