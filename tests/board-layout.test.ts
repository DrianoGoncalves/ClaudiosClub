import { describe, expect, it } from 'vitest';
import type { Agent, Board, CostReport, LinkInfo, Project, Session, Skill, StaffProfile } from '../shared/model';
import { buildGraph, SIZES, type BoardNode, type BoardNodeType } from '../client/src/board/layout';

const FILE: LinkInfo = { kind: 'file', target: null };

function project(id: string, path: string, worktreeOf: string | null = null): Project {
  return {
    id,
    path,
    name: path.split('\\').pop()!,
    exists: true,
    worktreeOf,
    hasClaudeMd: false,
    agentCount: 0,
    skillCount: 0,
    sessionCount: 0,
    lastActivityAt: null,
  };
}

function agent(name: string, filePath: string, link: LinkInfo = FILE): Agent {
  return {
    id: `project:${filePath}`,
    name,
    description: null,
    tools: null,
    model: null,
    scope: 'project',
    filePath,
    link,
    duplicate: false,
    error: null,
  };
}

function skill(name: string, dirPath: string, scope: Skill['scope'] = 'project', link: LinkInfo = FILE): Skill {
  return { id: `${scope}:${dirPath}`, name, label: null, description: null, scope, readOnly: scope === 'synced', dirPath, link, error: null };
}

function session(id: string, title: string | null): Session {
  return {
    id,
    title,
    entrypoint: 'claude-desktop',
    gitBranch: null,
    version: null,
    startedAt: null,
    updatedAt: '2026-10-26T10:00:00.000Z',
    sizeBytes: 1,
    subagentCount: 0,
    live: null,
  };
}

function staffProfile(id: string, sessions: string[], reportsTo: string[] = []): StaffProfile {
  return {
    id,
    projectId: 'a',
    name: id.toUpperCase(),
    role: 'Dev',
    portrait: null,
    reportsTo,
    mission: 'm',
    firstTask: '',
    autonomy: 'manual',
    agents: [],
    skills: [],
    mcps: null,
    knowledge: [],
    rules: [],
    doneWhen: '',
    model: null,
    effort: null,
    canHire: true,
    usageStop: null,
    playbook: null,
    worktree: false,
    servers: [],
    browser: false,
    sessions: sessions.map((s) => ({ id: s, startedAt: '' })),
    createdAt: '',
    updatedAt: '',
  };
}

const A = 'C:\\www\\a';
const B = 'C:\\www\\b';
const WT = 'C:\\www\\a\\.claude\\worktrees\\wt';

function board(): Board {
  const many = Array.from({ length: 8 }, (_, i) => skill(`s${i}`, `${A}\\.claude\\skills\\s${i}`));
  return {
    projects: [project('a', A), project('b', B), project('wt', WT, A)],
    inventories: {
      a: { agents: [agent('design-system', `${A}\\.claude\\agents\\ds.md`)], skills: many },
      // Emprestado de A por symlink (caminho com outra caixa/barra, como pode vir do disco).
      b: { agents: [agent('design-system', `${B}\\.claude\\agents\\ds.md`, { kind: 'symlink', target: 'c:/www/A/.claude/agents/ds.md' })], skills: [] },
      wt: { agents: [], skills: [] },
    },
    sessions: {
      a: [session('s-a1', 'Refatorar DS'), session('s-a2', null)],
      b: [session('s-b1', 'Revisor')],
    },
    staff: [],
    images: {},
    user: {
      agents: [],
      skills: [skill('vps', 'C:\\h\\.claude\\skills\\vps', 'user'), skill('pdf', 'C:\\h\\.claude\\skills\\synced\\x\\pdf', 'synced'), skill('docx', 'C:\\h\\.claude\\skills\\synced\\x\\docx', 'synced')],
    },
    live: [
      { sessionId: '1', pid: 1, cwd: 'c:/www/a', name: null, status: 'waiting', alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null },
      { sessionId: '2', pid: 2, cwd: A, name: null, status: 'idle', alive: false, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null },
    ],
  };
}

function overlaps(a: BoardNode, b: BoardNode) {
  const sa = SIZES[a.type as BoardNodeType];
  const sb = SIZES[b.type as BoardNodeType];
  return (
    a.position.x < b.position.x + sb.w &&
    b.position.x < a.position.x + sa.w &&
    a.position.y < b.position.y + sb.h &&
    b.position.y < a.position.y + sa.h
  );
}

function rect(n: BoardNode) {
  const s = SIZES[n.type as BoardNodeType];
  return { x: n.position.x, y: n.position.y, w: n.width ?? s.w, h: n.height ?? s.h };
}

const OPEN_A = { expandedShelves: ['sh:p:a'] };

describe('buildGraph', () => {
  it('monta salas sem sobreposição', () => {
    for (const showWorktrees of [false, true]) {
      for (const shelves of [{}, OPEN_A]) {
        const all = buildGraph(board(), { showWorktrees, ...shelves }).nodes;
        const nodes = all.filter((n) => n.type !== 'room');
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            expect(overlaps(nodes[i]!, nodes[j]!), `${nodes[i]!.id} x ${nodes[j]!.id}`).toBe(false);
          }
        }
        // As salas também não se sobrepõem, e cada uma envolve os nós dela.
        const rooms = all.filter((n) => n.type === 'room');
        for (let i = 0; i < rooms.length; i++) {
          const a = rect(rooms[i]!);
          for (let j = i + 1; j < rooms.length; j++) {
            const b = rect(rooms[j]!);
            expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${rooms[i]!.id} x ${rooms[j]!.id}`).toBe(false);
          }
          const room = rooms[i]!;
          if (room.type !== 'room') continue;
          for (const id of room.data.members) {
            const m = rect(all.find((n) => n.id === id)!);
            expect(m.x >= a.x && m.y >= a.y && m.x + m.w <= a.x + a.w && m.y + m.h <= a.y + a.h, `${id} fora de ${room.id}`).toBe(true);
          }
        }
      }
    }
  });

  it('muitos projetos viram uma grade (várias linhas), não uma fila', () => {
    const projects = Array.from({ length: 12 }, (_, i) => project(`p${i}`, `C:\\www\\p${i}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const rooms = buildGraph(b, { showWorktrees: false }).nodes.filter((n) => n.type === 'room').map(rect);
    expect(rooms).toHaveLength(13); // "você" + 12
    expect(new Set(rooms.map((r) => r.y)).size).toBeGreaterThan(1);
    const w = Math.max(...rooms.map((r) => r.x + r.w)) - Math.min(...rooms.map((r) => r.x));
    const h = Math.max(...rooms.map((r) => r.y + r.h)) - Math.min(...rooms.map((r) => r.y));
    expect(w / h).toBeLessThan(4);
  });

  it('bolinhas na linha do gestor só quando o trabalho foi delegado; conversa direta só anima a borda', () => {
    const busy = (delegated: boolean) => ({
      ...board(),
      staff: [staffProfile('ana', ['s-a1']), staffProfile('bia', ['s-a2'], ['ana'])],
      live: [
        { sessionId: 's-a2', pid: 9, cwd: A, name: null, status: 'busy', alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null, delegated },
      ],
    } as Board);
    const line = (b: Board) => buildGraph(b, { showWorktrees: false }).edges.find((e) => e.source === 'h:a:ana' && e.target === 'h:a:bia');
    expect(line(busy(false))?.data?.active).toBeFalsy();
    expect(line(busy(true))?.data?.active).toBe(true);
  });

  it('a grade segue a proporção da tela: deitada cresce para a direita, em pé para baixo', () => {
    const projects = Array.from({ length: 12 }, (_, i) => project(`p${i}`, `C:\\www\\p${i}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const ratio = (aspect: number) => {
      const rooms = buildGraph(b, { showWorktrees: false, aspect }).nodes.filter((n) => n.type === 'room').map(rect);
      const w = Math.max(...rooms.map((r) => r.x + r.w)) - Math.min(...rooms.map((r) => r.x));
      const h = Math.max(...rooms.map((r) => r.y + r.h)) - Math.min(...rooms.map((r) => r.y));
      return w / h;
    };
    const wide = ratio(21 / 9);
    const tall = ratio(9 / 16);
    expect(wide).toBeGreaterThan(1);
    expect(tall).toBeLessThan(1);
    expect(wide).toBeGreaterThan(tall);
  });

  it('muitos agents/skills vão para uma estante, que abre quando pedido', () => {
    const closed = buildGraph(board(), { showWorktrees: false }).nodes;
    const shelf = closed.find((n) => n.id === 'sh:p:a');
    expect(shelf?.type === 'shelf' && shelf.data).toEqual({ agents: 1, skills: 8, expanded: false });
    expect(closed.some((n) => n.type === 'skill' && n.data.skill.dirPath.startsWith(A))).toBe(false);
    // Poucos itens (projeto B) continuam soltos.
    expect(closed.some((n) => n.id === 'sh:p:b')).toBe(false);
    expect(closed.some((n) => n.type === 'agent' && n.data.agent.filePath.startsWith(B))).toBe(true);

    const open = buildGraph(board(), { showWorktrees: false, ...OPEN_A }).nodes;
    expect(open.filter((n) => n.type === 'skill' && n.data.skill.dirPath.startsWith(A))).toHaveLength(8);
    const s = open.find((n) => n.id === 'sh:p:a');
    expect(s?.type === 'shelf' && s.data.expanded).toBe(true);
  });

  it('esconde worktrees por padrão e os põe sob o projeto-pai quando pedido', () => {
    expect(buildGraph(board(), { showWorktrees: false }).nodes.some((n) => n.id === 'p:wt')).toBe(false);
    const { edges } = buildGraph(board(), { showWorktrees: true });
    expect(edges.some((e) => e.source === 'p:a' && e.target === 'p:wt')).toBe(true);
  });

  it('agrupa as skills sincronizadas num nó só', () => {
    const { nodes } = buildGraph(board(), { showWorktrees: false });
    const synced = nodes.find((n) => n.type === 'synced');
    expect(synced?.type === 'synced' && synced.data.skills.map((s) => s.name)).toEqual(['pdf', 'docx']);
    expect(nodes.filter((n) => n.type === 'skill' && n.data.skill.scope === 'synced')).toHaveLength(0);
  });

  it('liga a origem ao agent emprestado', () => {
    const { edges } = buildGraph(board(), { showWorktrees: false, ...OPEN_A });
    const borrow = edges.filter((e) => e.data?.kind === 'borrow');
    expect(borrow).toHaveLength(1);
    expect(borrow[0]).toMatchObject({
      source: `a:project:${A}\\.claude\\agents\\ds.md`,
      target: `a:project:${B}\\.claude\\agents\\ds.md`,
    });
  });

  it('com a estante fechada, o empréstimo sai da estante', () => {
    const borrow = buildGraph(board(), { showWorktrees: false }).edges.filter((e) => e.data?.kind === 'borrow');
    expect(borrow).toHaveLength(1);
    expect(borrow[0]).toMatchObject({ source: 'sh:p:a', target: `a:project:${B}\\.claude\\agents\\ds.md` });
  });

  it('põe cada sessão como funcionário na sala do projeto, com o custo dela', () => {
    const summary = { usd: 10, today: 1, last7d: 5, month: 8 };
    const costs: CostReport = {
      generatedAt: '',
      pricingAsOf: '',
      scanning: false,
      total: summary,
      projects: { a: { ...summary, sessions: { 's-a1': 7.5 } } },
      agents: { 'design-system': { ...summary, usd: 2, runs: 3, projects: {} } },
      models: {},
      unpricedModels: [],
    };
    const { nodes, edges } = buildGraph(board(), { showWorktrees: false, costs, ...OPEN_A });

    const employees = nodes.filter((n) => n.type === 'employee');
    expect(employees.map((n) => n.id).sort()).toEqual(['e:s-a1', 'e:s-a2', 'e:s-b1']);
    expect(edges.some((e) => e.source === 'p:a' && e.target === 'e:s-a1' && e.data?.kind === 'contains')).toBe(true);

    const a1 = nodes.find((n) => n.id === 'e:s-a1');
    expect(a1?.type === 'employee' && a1.data.costUsd).toBe(7.5);
    const a2 = nodes.find((n) => n.id === 'e:s-a2');
    expect(a2?.type === 'employee' && a2.data.costUsd).toBeNull();
    const ds = nodes.find((n) => n.type === 'agent' && n.data.agent.filePath.startsWith(A));
    // Único agent com consumo: 100% dos subagents. Funcionário: 7,5 de 10 no total.
    expect(ds?.type === 'agent' && ds.data.cost).toEqual({ usd: 2, runs: 3, share: 1 });
    expect(a1?.type === 'employee' && a1.data.costShare).toBe(0.75);
  });

  it('salas em grade; hierarquia de cima para baixo; agents e skills ao lado do projeto', () => {
    const { nodes, edges } = buildGraph(board(), { showWorktrees: false, ...OPEN_A });
    const pos = (id: string) => nodes.find((n) => n.id === id)!.position;
    // Uma moldura por sala, na ordem: você primeiro.
    expect(nodes.filter((n) => n.type === 'room').map((n) => n.id)).toEqual(['r:u', 'r:p:a', 'r:p:b']);
    // "Você" vem antes na ordem de leitura (à esquerda, ou na linha de cima quando a grade quebra).
    expect(pos('u').y < pos('p:a').y || pos('u').x < pos('p:a').x).toBe(true);
    // O projeto é o cabeçalho da sala: colado nas bordas, de um lado ao outro (recursos à direita, embaixo).
    const header = nodes.find((n) => n.id === 'p:a')!;
    const room = nodes.find((n) => n.id === 'r:p:a')!;
    expect(header.position).toEqual(room.position);
    expect(header.width).toBe(room.width);
    expect(header.type === 'project' && header.data.header.sideAt).toBeGreaterThan(0);
    expect(pos(`a:project:${A}\\.claude\\agents\\ds.md`).y).toBeGreaterThan(pos('p:a').y);
    // Funcionário abaixo do projeto, ligado da base do projeto ao topo dele.
    expect(pos('e:s-a1').y).toBeGreaterThan(pos('p:a').y);
    expect(edges.find((e) => e.source === 'p:a' && e.target === 'e:s-a1')).toMatchObject({ sourceHandle: 'b', targetHandle: 't', data: { kind: 'contains' } });
    // Recursos: coluna à direita, encostada na borda da sala, abaixo do cabeçalho. A linha tracejada
    // desce do cabeçalho (alça `sd`) para o primeiro e segue de um para o outro (estante aberta primeiro).
    const ds = nodes.find((n) => n.type === 'agent' && n.data.agent.filePath.startsWith(A))!;
    expect(ds.position.x).toBeGreaterThan(pos('p:a').x);
    expect(ds.position.x + ds.width!).toBe(room.position.x + room.width! - 26);
    expect(edges.find((e) => e.source === 'p:a' && e.data?.kind === 'side')).toMatchObject({ target: 'sh:p:a', sourceHandle: 'sd', targetHandle: 't' });
    expect(edges.find((e) => e.target === ds.id && e.data?.kind === 'side')).toMatchObject({ sourceHandle: 'b', targetHandle: 't' });
    // Vale para a sala "você" também.
    const you = nodes.find((n) => n.id === 'u')!;
    const youRoom = nodes.find((n) => n.id === 'r:u')!;
    expect(you.position).toEqual(youRoom.position);
    expect(you.width).toBe(youRoom.width);
    const vps = nodes.find((n) => n.type === 'skill' && n.data.skill.name === 'vps')!;
    expect(vps.position.y).toBeGreaterThan(pos('u').y);
    expect(vps.position.x + vps.width!).toBe(youRoom.position.x + youRoom.width! - 26);
  });

  it('sala dobrada: só o cabeçalho, com o resumo; a moldura encolhe até ele', () => {
    const open = buildGraph(board(), { showWorktrees: false });
    const folded = buildGraph(board(), { showWorktrees: false, collapsedRooms: ['p:a'] });
    const ids = (g: typeof open) => g.nodes.map((n) => n.id);
    expect(ids(open)).toContain('e:s-a1');
    expect(ids(folded)).not.toContain('e:s-a1');
    expect(folded.edges.some((e) => e.source === 'p:a' || e.target === 'p:a')).toBe(false);
    const header = folded.nodes.find((n) => n.id === 'p:a')!;
    const room = folded.nodes.find((n) => n.id === 'r:p:a')!;
    // 1 agent + 8 skills guardados.
    expect(header.type === 'project' && header.data.header).toMatchObject({ collapsed: true, resources: 9 });
    expect(room.height).toBe(header.height);
    // As outras salas continuam abertas.
    expect(ids(folded)).toContain('e:s-b1');
  });

  it('git no cabeçalho: o estado do projeto chega ao nó', () => {
    const git = { a: { branch: 'main', dirty: 2, upstream: 'origin/main', ahead: 1, behind: 0 } };
    const { nodes } = buildGraph(board(), { showWorktrees: false, git });
    const a = nodes.find((n) => n.id === 'p:a');
    const b = nodes.find((n) => n.id === 'p:b');
    expect(a?.type === 'project' && a.data.git).toEqual(git.a);
    expect(b?.type === 'project' && b.data.git).toBeNull();
  });

  it('cor da sala: a parede do projeto leva a cor escolhida; sem escolha (e a sala "você"), a padrão', () => {
    const { nodes } = buildGraph(board(), { showWorktrees: false, projectColors: { a: 'teal' } });
    const color = (id: string) => {
      const room = nodes.find((n) => n.id === id);
      return room?.type === 'room' ? room.data.color : undefined;
    };
    expect(color('r:p:a')).toBe('teal');
    expect(color('r:p:b')).toBeNull();
    expect(color('r:u')).toBeNull();
  });

  it('funcionário com mais de um gestor: o segundo vira ligação extra, lateral se no mesmo nível', () => {
    const b = {
      ...board(),
      staff: [staffProfile('ana', ['s-a1']), staffProfile('bia', ['s-a2']), staffProfile('caio', [], ['ana', 'bia'])],
    };
    const { nodes, edges } = buildGraph(b, { showWorktrees: false });
    expect(edges.find((e) => e.source === 'h:a:ana' && e.target === 'h:a:caio')?.data?.kind).toBe('contains');
    const extra = edges.find((e) => e.source === 'h:a:bia' && e.target === 'h:a:caio');
    expect(extra?.data?.kind).toBe('calls');
    // ana e bia estão no mesmo nível; caio, abaixo: a ligação extra desce (base → topo).
    expect(extra).toMatchObject({ sourceHandle: 'b', targetHandle: 't' });

    const peers = { ...board(), staff: [staffProfile('ana', ['s-a1']), staffProfile('bia', ['s-a2'], ['ana']), staffProfile('caio', [], ['ana', 'bia'])] };
    const g = buildGraph(peers, { showWorktrees: false });
    const y = (id: string) => g.nodes.find((n) => n.id === id)!.position.y;
    expect(y('h:a:bia')).toBe(y('h:a:caio'));
    expect(g.edges.find((e) => e.source === 'h:a:bia' && e.target === 'h:a:caio')?.sourceHandle).toMatch(/^(ro|lo)$/);
    expect(nodes.some((n) => n.id === 'h:a:caio')).toBe(true);
  });

  it('ciclo de gestores não trava o layout', () => {
    const b = { ...board(), staff: [staffProfile('x', [], ['y']), staffProfile('y', [], ['x'])] };
    const ids = buildGraph(b, { showWorktrees: false }).nodes.map((n) => n.id);
    expect(ids).toContain('h:a:x');
    expect(ids).toContain('h:a:y');
  });

  it('contratados: ficha junta as sessões dela, soma o custo e subordinado fica sob o gestor', () => {
    const b = { ...board(), staff: [staffProfile('chefe', ['s-a1', 's-a2']), staffProfile('novo', [], ['chefe'])] };
    const summary = { usd: 0, today: 0, last7d: 0, month: 0 };
    const costs: CostReport = {
      generatedAt: '', pricingAsOf: '', scanning: false, total: summary,
      projects: { a: { ...summary, sessions: { 's-a1': 1, 's-a2': 2 } } },
      agents: {}, models: {}, unpricedModels: [],
    };
    const { nodes, edges } = buildGraph(b, { showWorktrees: false, costs });

    // As duas sessões do chefe viram um funcionário só.
    expect(nodes.some((n) => n.id === 'e:s-a1' || n.id === 'e:s-a2')).toBe(false);
    const chefe = nodes.find((n) => n.id === 'h:a:chefe');
    expect(chefe?.type === 'employee' && chefe.data.session?.id).toBe('s-a1');
    expect(chefe?.type === 'employee' && chefe.data.costUsd).toBe(3);

    const novo = nodes.find((n) => n.id === 'h:a:novo');
    expect(novo?.type === 'employee' && novo.data.session).toBeNull();
    expect(edges.some((e) => e.source === 'h:a:chefe' && e.target === 'h:a:novo')).toBe(true);
    expect(edges.some((e) => e.source === 'p:a' && e.target === 'h:a:novo')).toBe(false);
  });

  it('arquivados somem do quadro, ou aparecem marcados quando pedido', () => {
    const archived = { projects: ['b'], sessions: ['s-a2'] };
    const hidden = buildGraph(board(), { showWorktrees: false, archived });
    const ids = hidden.nodes.map((n) => n.id);
    expect(ids).not.toContain('p:b');
    expect(ids).not.toContain('e:s-b1'); // funcionários de projeto arquivado somem junto
    expect(ids).not.toContain('e:s-a2');
    expect(ids).toContain('e:s-a1');

    const shown = buildGraph(board(), { showWorktrees: false, archived, showArchived: true });
    const b = shown.nodes.find((n) => n.id === 'p:b');
    expect(b?.type === 'project' && b.data.archived).toBe(true);
    const a2 = shown.nodes.find((n) => n.id === 'e:s-a2');
    expect(a2?.type === 'employee' && a2.data.archived).toBe(true);
  });

  it('marca como ativa só a linha que chega a um funcionário trabalhando numa tarefa delegada', () => {
    const b = board();
    const working = { sessionId: 's-a1', pid: 9, cwd: A, name: null, status: 'busy', alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null } as const;
    // Trabalhando no que você pediu no chat: nenhuma linha anima (só a borda do cartão).
    b.live = [working];
    expect(buildGraph(b, { showWorktrees: false }).edges.filter((e) => e.data?.active)).toEqual([]);
    b.live = [{ ...working, delegated: true }];
    const active = buildGraph(b, { showWorktrees: false }).edges.filter((e) => e.data?.active);
    expect(active.map((e) => e.target)).toEqual(['e:s-a1']);
    expect(active[0]?.data?.kind).toBe('contains');
  });

  it('delegação ao vivo: linha do funcionário até o agent do projeto que está trabalhando para ele', () => {
    const b = board();
    b.live = [
      {
        sessionId: 's-a1', pid: 9, cwd: A, name: null, status: 'busy', alive: true, entrypoint: null, kind: null,
        startedAt: null, statusUpdatedAt: null, activeAgents: ['design-system', 'Explore'],
      },
    ];
    const { edges } = buildGraph(b, { showWorktrees: false });
    const d = edges.filter((e) => e.data?.kind === 'delegates');
    // Só o agent que existe no quadro ganha linha (Explore é embutido); o do projeto A, não o emprestado em B.
    // Com muitos itens, o agent está guardado na estante fechada da sala: a linha vai até ela.
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ source: 'e:s-a1', target: 'sh:p:a', data: { kind: 'delegates', active: true }, sourceHandle: 'ro', targetHandle: 'li' });
  });

  it('anexa só as sessões vivas do projeto', () => {
    const { nodes } = buildGraph(board(), { showWorktrees: false });
    const a = nodes.find((n) => n.id === 'p:a');
    expect(a?.type === 'project' && a.data.live.map((s) => s.sessionId)).toEqual(['1']);
  });
});
