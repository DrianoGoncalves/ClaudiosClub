import { describe, expect, it } from 'vitest';
import type { Engine, StaffProfile } from '../shared/model';
import { BUILTIN_ROLES } from '../shared/roles';
import { CONSULT_TOOLS, consultDenyRules, renderConsultFicha, renderFicha, type FichaContext } from '../server/staff/ficha';

// Perguntas na ficha (t-8438ef): toda ficha (qualquer cargo, os dois motores) manda perguntar por opções, que o Club mostra como card amarelo, e proíbe pergunta solta no texto.
// No Codex, sem AskUserQuestion, o equivalente é o bloco final com `DÚVIDA:` e opções numeradas. A conversa de consulta entre projetos segue sem a regra.

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
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
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

const count = (text: string, part: string) => text.split(part).length - 1;
/** A seção Perguntas, do título até a próxima seção. */
const section = (md: string) => /^## Perguntas\n[\s\S]*?(?=\n\n## |\n$)/m.exec(md)?.[0] ?? '';

const SOLTA = 'Nada de pergunta solta no texto da resposta ("quer que eu…?", "prefere A ou B?"), no meio ou no fim.';
const SEM_TRAVA = 'Se não trava, decida pelo padrão sensato, siga e diga em uma linha o que decidiu';
const SEM_LICENCA = 'pergunta é para decisão, não para pedir licença de continuar o que já foi pedido';
const OPCOES = '2 a 4 opções que não se sobrepõem, a recomendada primeiro e terminada em "(Recomendado)", cada uma com uma descrição curta do efeito';
const CODEX_OPCOES = '(2 a 4, que não se sobrepõem, a recomendada primeiro e terminada em "(Recomendado)", cada uma com o efeito em poucas palavras)';

describe('1. Claude: pergunta com opções (card amarelo) e nada de pergunta solta, em toda ficha', () => {
  it('a seção entra uma vez, antes do Manual, com as opções, o "Outro" e a proibição de pergunta solta', () => {
    const md = renderFicha(person('claude'), ctx());
    expect(count(md, '## Perguntas')).toBe(1);
    expect(count(md, 'AskUserQuestion')).toBe(1);
    expect(count(md, SOLTA)).toBe(1);
    expect(count(md, SEM_TRAVA)).toBe(1);
    expect(count(md, SEM_LICENCA)).toBe(1);
    expect(count(md, OPCOES)).toBe(1);
    expect(md).toContain('card amarelo');
    expect(md).toContain('junte as dúvidas numa chamada só (até 4 perguntas)');
    expect(md).toContain('A opção "Outro", para resposta livre, já existe.');
    // Sem o bloco do Codex.
    expect(md).not.toContain('DÚVIDA: <a pergunta>');
    expect(md.indexOf('## Postura')).toBeLessThan(md.indexOf('## Perguntas'));
    expect(md.indexOf('## Perguntas')).toBeLessThan(md.indexOf('## Manual do Claudio’s Club'));
  });

  it('curta: a seção cabe em poucas linhas (a ficha já é longa)', () => {
    const s = section(renderFicha(person('claude'), ctx()));
    expect(s.split('\n').length).toBeLessThanOrEqual(5);
    expect(s.length).toBeLessThan(950);
  });

  // Todos os cargos prontos, com a autonomia, o roteiro e o contratar de cada um, com e sem gestor (quem fala direto com o usuário também pergunta por opções).
  it.each(BUILTIN_ROLES.map((r) => [r.id, r] as const))('cargo %s: a regra entra uma vez, com e sem gestor', (_id, r) => {
    for (const managerNames of [['Denzel'], []]) {
      const p = person('claude', { role: r.role, autonomy: r.autonomy, canHire: r.canHire ?? false, playbook: r.playbook ?? null, worktree: r.worktree ?? false, servers: [] });
      const md = renderFicha(p, ctx({ managerNames }));
      expect(count(md, '## Perguntas'), `${r.id} ${managerNames.length}`).toBe(1);
      expect(count(md, 'AskUserQuestion'), `${r.id} ${managerNames.length}`).toBe(1);
      expect(count(md, SOLTA), `${r.id} ${managerNames.length}`).toBe(1);
    }
  });

  it('os cargos prontos existem (o teste acima não passa em vão)', () => {
    expect(BUILTIN_ROLES.length).toBeGreaterThanOrEqual(10);
  });
});

describe('2. Codex: o equivalente sem AskUserQuestion (bloco final com DÚVIDA: e opções numeradas)', () => {
  it('a seção entra uma vez, com o bloco final, as opções e a mesma proibição', () => {
    const md = renderFicha(person('codex'), ctx());
    expect(count(md, '## Perguntas')).toBe(1);
    expect(count(md, SOLTA)).toBe(1);
    expect(count(md, SEM_TRAVA)).toBe(1);
    expect(count(md, SEM_LICENCA)).toBe(1);
    expect(count(md, CODEX_OPCOES)).toBe(1);
    expect(count(md, 'termine a resposta com UM bloco final, sem nada depois')).toBe(1);
    // O marcador é o que o Club já lê em tarefa de gestor (doubtFrom em tasks.ts).
    expect(count(md, '`DÚVIDA: <a pergunta>`')).toBe(1);
    expect(md).toContain('as opções numeradas');
    expect(md).toContain('várias dúvidas vão no mesmo bloco (até 4)');
    // O Codex não tem a ferramenta nem o card: a ficha dele não os cita.
    expect(md).not.toContain('AskUserQuestion');
    expect(md).not.toContain('card amarelo');
    expect(md.indexOf('## Postura')).toBeLessThan(md.indexOf('## Perguntas'));
    expect(md.indexOf('## Perguntas')).toBeLessThan(md.indexOf('## Manual do Claudio’s Club'));
  });

  it('curta, e sem a palavra "revisor" (regra da ficha do Codex)', () => {
    const s = section(renderFicha(person('codex'), ctx()));
    expect(s.split('\n').length).toBeLessThanOrEqual(5);
    expect(s.length).toBeLessThan(1100);
    expect(s.toLowerCase()).not.toContain('revisor');
  });

  it.each(BUILTIN_ROLES.map((r) => [r.id, r] as const))('cargo %s: a variante do Codex entra uma vez, com e sem gestor', (_id, r) => {
    for (const managerNames of [['Denzel'], []]) {
      const p = person('codex', { role: r.role, autonomy: r.autonomy, canHire: r.canHire ?? false, playbook: r.playbook ?? null, worktree: r.worktree ?? false, servers: [] });
      const md = renderFicha(p, ctx({ managerNames, mycoUrl: 'http://127.0.0.2:4848' }));
      expect(count(md, '## Perguntas'), `${r.id} ${managerNames.length}`).toBe(1);
      expect(count(md, '`DÚVIDA: <a pergunta>`'), `${r.id} ${managerNames.length}`).toBe(1);
      expect(md, r.id).not.toContain('AskUserQuestion');
    }
  });
});

describe('3. consulta entre projetos: sem mudança (continua sem AskUserQuestion e sem a seção)', () => {
  it.each(ENGINES)('%s: a ficha compacta não ganha a regra', (engine) => {
    const md = renderConsultFicha(person(engine), ctx());
    for (const gone of ['## Perguntas', 'AskUserQuestion', 'card amarelo', 'DÚVIDA:', 'Outro', SOLTA]) expect(md, gone).not.toContain(gone);
    expect(md).toContain('## Postura');
    expect(md).toContain('## Esta conversa é uma consulta');
  });

  it('a conversa de consulta segue sem a ferramenta: fora de --tools e negada em profundidade', () => {
    expect(CONSULT_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
    expect(consultDenyRules(person('claude'), { otherProjects: [] })).toContain('AskUserQuestion');
  });
});
