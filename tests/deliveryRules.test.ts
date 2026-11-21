import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine, StaffProfile } from '../shared/model';
import { BRIEF_RULES, DELIVERY_FORMAT, PREMISE_LINE, REQUIRED_PROOFS_LINE, REVIEW_RUBRIC, SCOPE_LINE } from '../server/deliveryRules';
import { renderFicha, type FichaContext } from '../server/staff/ficha';
import { TaskService } from '../server/tasks';
import { removeTemp } from './support/tmp';

// Entrega em formato fixo, provas exigidas e rubrica única do revisor (t-a7dc60): vale para todos os projetos e funcionários, nos dois motores, e por isso está no
// servidor (brief da tarefa, pedido de revisão e ficha do gestor), não em preset de cargo.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-delivery-'));
});
afterAll(() => removeTemp(root));

const ENGINES: Engine[] = ['claude', 'codex'];

describe('os textos fixos', () => {
  it('o formato da entrega tem os 5 itens, nesta ordem', () => {
    const lines = DELIVERY_FORMAT.split('\n');
    expect(lines[0]).toBe('Quando terminar, a sua última mensagem é a entrega, curta e neste formato fixo, nesta ordem:');
    expect(lines[1]).toMatch(/^1\. Critério de pronto: cada item do critério de aceite, um por linha, com feito, não feito ou parcial/);
    expect(lines[2]).toMatch(/^2\. tsc: /);
    expect(lines[3]).toMatch(/^3\. Testes do tema: .*contagem/);
    expect(lines[4]).toMatch(/^4\. Prints: os caminhos, quando o critério pedir\.$/);
    expect(lines[5]).toBe('5. O que ficou de fora e por quê.');
    expect(lines).toHaveLength(6);
  });

  it('as 2 linhas do brief: escopo é orientação (helper/teste novo ligado à tarefa pode, com justificativa; fora do assunto, não) e premissa que não bate = DÚVIDA antes de implementar', () => {
    expect(SCOPE_LINE).toContain('A lista de arquivos do pedido é orientação, não limite');
    expect(SCOPE_LINE).toContain('helper ou um teste novo ligado à tarefa pode, com uma linha de justificativa na entrega');
    expect(SCOPE_LINE).toContain('mudança fora do assunto da tarefa, não');
    expect(PREMISE_LINE).toContain('Se a premissa do pedido não bate com o código');
    expect(PREMISE_LINE).toContain('o comportamento descrito já é outro no HEAD, o arquivo citado não existe');
    expect(PREMISE_LINE).toContain('mande a DÚVIDA antes de implementar');
    expect(BRIEF_RULES).toEqual([SCOPE_LINE, PREMISE_LINE, DELIVERY_FORMAT]);
  });

  it('a rubrica: o que reprova, o que não reprova e a dúvida sobre a premissa', () => {
    expect(REVIEW_RUBRIC).toContain('- Reprova (🔴): bug, regressão, falha de segurança, item do critério de pronto não cumprido e falta de prova que o critério exige.');
    expect(REVIEW_RUBRIC).toContain('- Não reprova (no máximo 🟡 ou 🟢): prova que o critério não pede (se valer a pena, vira follow-up)');
    expect(REVIEW_RUBRIC).toContain('só escopo fora do assunto reprova');
    expect(REVIEW_RUBRIC).toContain('Na dúvida sobre a premissa do pedido (o código já é outro, o arquivo citado não existe), pergunte em vez de reprovar.');
  });
});

describe('o brief da tarefa (nos dois motores): começo, retomada na fila e handoff', () => {
  const ana = (engine: Engine) => ({ id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false, engine }) as StaffProfile;

  async function club(name: string, engine: Engine, over: Partial<StaffProfile> = {}) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, '.myco', 'tasks.json');
    const sent: string[] = [];
    const sentTo: string[] = [];
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana-1' ? { ...ana(engine), ...over } : null),
      readLimit: async () => null, // sem limite em nenhum motor: só a troca que o teste pede (onLimit) acontece
      send: async (_p, _s, text) => (sent.push(text), 's-1'),
      sendTo: async (_p, session, _s, text) => (sentTo.push(text), session),
      branchFor: async () => null,
      isWorking: () => false,
      isSessionWorking: () => false,
      apiUrl: 'http://127.0.0.1:4848',
      sandboxApiUrl: 'http://127.0.0.2:4848',
    });
    const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
      const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
      fn(all.find((t) => t.id === id)!);
      await fs.writeFile(file, JSON.stringify(all));
    };
    return { svc, sent, sentTo, edit };
  }

  const brief = (text: string) => {
    expect(text).toContain(SCOPE_LINE);
    expect(text).toContain(PREMISE_LINE);
    expect(text).toContain(DELIVERY_FORMAT);
    // Nesta ordem, no fim do texto, depois do critério de aceite e da linha de cancelar.
    expect(text.indexOf(SCOPE_LINE)).toBeLessThan(text.indexOf(PREMISE_LINE));
    expect(text.indexOf(PREMISE_LINE)).toBeLessThan(text.indexOf(DELIVERY_FORMAT));
    expect(text.trimEnd().endsWith('5. O que ficou de fora e por quê.')).toBe(true);
    expect(text).not.toContain('responda com um resumo curto do que foi feito e do que falta'); // o fim antigo saiu
  };

  it.each(ENGINES)('texto de início, ficha no %s: a lista de arquivos é orientação, DÚVIDA se a premissa não bate e a entrega em formato fixo', async (engine) => {
    const c = await club(`inicio-${engine}`, engine);
    const t = (await c.svc.create('p', { title: 'Botão', description: 'Pedido do botão.', acceptance: 'O botão exporta CSV.', staffId: 'ana-1' }))!;
    await c.svc.start('p', t.id);
    brief(c.sent[0]!);
    expect(c.sent[0]!.indexOf('Critério de aceite: O botão exporta CSV.')).toBeLessThan(c.sent[0]!.indexOf(SCOPE_LINE));
    // O que é do motor (o endereço da API de cancelar) segue sendo do motor; o resto do texto é o mesmo.
    expect(c.sent[0]).toContain(engine === 'codex' ? 'http://127.0.0.2:4848/api/projects/p/tasks/' : 'http://127.0.0.1:4848/api/projects/p/tasks/');
  });

  it('o texto é o mesmo nos dois motores, fora o endereço da API', async () => {
    const texts: string[] = [];
    for (const engine of ENGINES) {
      const c = await club(`igual-${engine}`, engine);
      const t = (await c.svc.create('p', { title: 'Botão', description: 'Pedido do botão.', acceptance: 'Critério.', staffId: 'ana-1' }))!;
      await c.svc.start('p', t.id);
      texts.push(c.sent[0]!.replace(/http:\/\/127\.0\.0\.\d:4848/g, '<api>').replace(/t-[0-9a-f]{6}/g, 't-x'));
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it.each(ENGINES)('retomada na fila (o card voltou para "a fazer"), %s: o mesmo fim', async (engine) => {
    const c = await club(`retomada-${engine}`, engine);
    const t = (await c.svc.create('p', { title: 'Refazer', description: 'Refaça a tela.', staffId: 'ana-1' }))!;
    await c.svc.start('p', t.id);
    await c.edit(t.id, (x) => {
      x.status = 'todo';
      x.queuedAt = null;
    });
    await c.svc.tick();
    expect(c.sentTo).toHaveLength(1);
    expect(c.sentTo[0]).toContain('voltou para "A fazer"');
    brief(c.sentTo[0]!);
  });

  // A troca de motor no meio do turno (onLimit) abre a conversa nova com o handoff, que termina com o mesmo fim do texto de início. O teste dispara a troca de verdade e lê o
  // texto enviado à conversa nova (sent[1]; sent[0] é o início na antiga), em vez de casar o código-fonte: a linha do plano (planLineOf) entra no meio do fim e o regex quebrou.
  const PLAN_LINE = 'Esta tarefa pede o plano primeiro: nesta rodada NÃO edite arquivos';
  const OPEN_PLAN = { title: 'Botão', description: 'Pedido do botão.', acceptance: 'Critério.', staffId: 'ana-1' } as const;

  /** Abre o card, deixa o motor da ficha bater no limite no meio do turno e devolve o handoff que foi para a conversa nova (e o id do card). */
  async function handoff(name: string, engine: Engine, input: Record<string, unknown>, over: Partial<StaffProfile> = {}, edit?: (x: Record<string, any>) => void) {
    const to: Engine = engine === 'claude' ? 'codex' : 'claude';
    const c = await club(name, engine, { fallback: { engine: to, model: 'modelo-2' }, ...over });
    const t = (await c.svc.create('p', { ...OPEN_PLAN, ...input }))!;
    await c.svc.start('p', t.id);
    if (edit) await c.edit(t.id, edit);
    await c.svc.onLimit({ sessionId: 's-1', engine, hit: { resetsAt: Date.now() + 2 * 3_600_000, window: 'five_hour' } });
    expect(c.sent).toHaveLength(2); // o início na conversa antiga e o handoff na nova
    return { text: c.sent[1]!, to, id: t.id };
  }

  it.each(ENGINES)('handoff da troca de motor (ficha %s): leva o mesmo fim (cancelar com o endereço do motor novo + as 3 regras do brief), e a conversa nova é a que entrega', async (engine) => {
    const { text, to, id } = await handoff(`handoff-fim-${engine}`, engine, {});
    brief(text);
    const cancel = text.indexOf(`Cancelar esta tarefa (id \`${id}\`)`);
    expect(cancel).toBeGreaterThan(text.indexOf('## O que fazer')); // o fim vem depois das instruções do handoff
    expect(cancel).toBeLessThan(text.indexOf(SCOPE_LINE)); // e a linha de cancelar, antes das regras do brief, como no texto de início
    expect(text).toContain(to === 'codex' ? 'http://127.0.0.2:4848/api/projects/p/tasks/' : 'http://127.0.0.1:4848/api/projects/p/tasks/');
    expect(text).not.toContain(PLAN_LINE); // card sem pedido de plano: nada a mais no fim
  });

  it.each(ENGINES)('handoff da troca de motor (ficha %s), card plano-primeiro sem plano aprovado: a linha do plano entra, entre as instruções e a linha de cancelar', async (engine) => {
    const { text, id } = await handoff(`handoff-plano-${engine}`, engine, { planFirst: true });
    expect(text.split(PLAN_LINE)).toHaveLength(2); // uma vez só
    expect(text.indexOf(PLAN_LINE)).toBeGreaterThan(text.indexOf('## O que fazer'));
    expect(text.indexOf(PLAN_LINE)).toBeLessThan(text.indexOf(`Cancelar esta tarefa (id \`${id}\`)`));
    brief(text); // e o fim continua o mesmo
  });

  it('handoff da troca de motor: o pedido de plano na descrição (sem o campo) também leva a linha do plano', async () => {
    const { text } = await handoff('handoff-plano-descricao', 'claude', { description: 'PLANO PRIMEIRO: proponha antes de editar.' });
    expect(text).toContain(PLAN_LINE);
  });

  it('handoff da troca de motor: sem a linha do plano quando o plano já foi aprovado, quando o campo dispensa e quando a ficha só planeja', async () => {
    const aprovado = await handoff('handoff-plano-aprovado', 'claude', { planFirst: true }, {}, (x) => {
      x.plan = 'Plano aprovado: mudar o botão.';
    });
    expect(aprovado.text).not.toContain(PLAN_LINE);
    const dispensado = await handoff('handoff-plano-dispensado', 'claude', { planFirst: false, description: 'PLANO PRIMEIRO, mas o dono dispensou.' });
    expect(dispensado.text).not.toContain(PLAN_LINE);
    const soPlaneja = await handoff('handoff-plano-ficha-plan', 'claude', { planFirst: true }, { autonomy: 'plan' });
    expect(soPlaneja.text).not.toContain(PLAN_LINE); // a ficha "só planeja" já tem o plano pelo cartão da conversa
    brief(soPlaneja.text);
  });
});

describe('a ficha do gestor (seção de equipe), nos dois motores', () => {
  const profile = (engine: Engine) =>
    ({
      id: 'gio-1',
      projectId: 'proj-x',
      name: 'Gio',
      role: 'Orquestrador(a)',
      engine,
      mission: 'Passar o trabalho',
      autonomy: 'acceptEdits',
      agents: [],
      skills: [],
      knowledge: [],
      rules: [],
      worktree: false,
      servers: [],
      sessions: [],
      reportsTo: [],
    }) as unknown as StaffProfile;
  const ctx = (over: Partial<FichaContext> = {}): FichaContext => ({
    company: 'Acme',
    projectName: 'painel',
    projectPath: 'C:\\www\\painel',
    managerNames: [],
    fichaPath: '.myco\\staff\\gio-1.md',
    memoryPath: '.myco\\staff\\gio-1.memory.md',
    mycoUrl: 'http://127.0.0.1:4848',
    team: [{ id: 'ana-1', name: 'Ana', role: 'Back-end', mission: 'Servidor.' }],
    ...over,
  });

  it.each(ENGINES)('pede que o critério de pronto diga as provas exigidas, e só elas (%s)', (engine) => {
    const md = renderFicha(profile(engine), ctx());
    expect(md).toContain(REQUIRED_PROOFS_LINE);
    expect(REQUIRED_PROOFS_LINE).toContain('o critério de pronto (acceptance) diz quais provas a entrega precisa trazer (ex.: prints em 360, claro e escuro; teste de X; docs/uso), e só elas');
    expect(REQUIRED_PROOFS_LINE).toContain('prova que o critério não pede não');
    // Dentro da seção de equipe, antes de "Para passar uma tarefa" (que fala do campo acceptance).
    expect(md.indexOf('## Sua equipe')).toBeLessThan(md.indexOf(REQUIRED_PROOFS_LINE));
    expect(md.indexOf(REQUIRED_PROOFS_LINE)).toBeLessThan(md.indexOf('Para passar uma tarefa:'));
  });

  it.each(ENGINES)('a parte de revisão traz a rubrica única, e não manda mais "pedir" a prova que faltou (%s)', (engine) => {
    const md = renderFicha(profile(engine), ctx());
    const review = md.slice(md.indexOf('Quem confere a tarefa que você passa é você.'));
    expect(review).toContain(REVIEW_RUBRIC);
    expect(review).toContain('falta de prova que o critério exigia reprova (pela rubrica abaixo)');
    expect(md).not.toContain('se faltar prova, peça');
  });

  it('sem equipe, não há seção de equipe (nem provas exigidas nem rubrica); a seção Entrega de quem recebe tarefa segue o formato fixo', () => {
    const solo = renderFicha(profile('claude'), ctx({ team: [] }));
    expect(solo).not.toContain(REQUIRED_PROOFS_LINE);
    expect(solo).not.toContain(REVIEW_RUBRIC);
    const worker = renderFicha(profile('claude'), ctx({ team: [], managerNames: ['Denzel'] }));
    expect(worker).toContain('no formato fixo do texto da tarefa');
    expect(worker).toContain('os prints (caminho) quando o critério pedir');
    expect(worker).not.toContain('onde estão os prints');
  });
});

describe('a rubrica no pedido de revisão (revisor do card, do quadro ou gestor; nos dois motores)', () => {
  const people = (engine: Engine): Record<string, StaffProfile> => ({
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false, engine } as StaffProfile,
  });

  it.each(ENGINES)('o pedido traz a rubrica, depois da instrução de avaliar só o que é da tarefa e antes do formato do veredito (revisor no %s)', async (engine) => {
    const dir = path.join(root, `revisao-${engine}`);
    await fs.mkdir(dir, { recursive: true });
    const sent: string[] = [];
    const p = people(engine);
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => p[id] ?? null,
      send: async (_p, _s, text) => (sent.push(text), 's-1'),
      sendTo: async (_p, session) => session,
      branchFor: async () => null,
      isWorking: () => false,
      isSessionWorking: () => false,
      lastText: () => null,
      notify: async () => {},
      hasAsk: () => false,
      answerAsk: () => false,
      awaitingLimit: async () => false,
      apiUrl: 'http://127.0.0.1:4848',
    });
    const t = (await svc.create('p', { title: 'Tela A', description: 'Pedido.', acceptance: 'Prints em 360.', staffId: 'ana-1' }))!;
    await svc.requestReview('p', t.id, 'rev-1');
    const text = sent[0]!;
    expect(text).toContain(REVIEW_RUBRIC);
    expect(text.indexOf('Avalie só o que é desta tarefa')).toBeLessThan(text.indexOf(REVIEW_RUBRIC));
    expect(text.indexOf(REVIEW_RUBRIC)).toBeLessThan(text.indexOf('Responda com APROVADO ou REPROVADO na primeira linha'));
    // O que já valia segue valendo: só 🔴 reprova.
    expect(text).toContain('REPROVADO só se houver algum 🔴');
  });
});
