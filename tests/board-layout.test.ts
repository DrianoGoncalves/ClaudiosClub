import { describe, expect, it } from 'vitest';
import type { Agent, Board, CostReport, InboxItem, LinkInfo, Project, Session, Skill, StaffProfile } from '../shared/model';
import { buildGraph as buildGraphRaw, readingOrder, SIZES, type BoardNode, type BoardNodeType } from '../client/src/board/layout';
import { portraitUrl } from '../client/src/board/nodes';

// Estes testes contam com a sala do usuário; o padrão do quadro é escondê-la (ver "escopo do usuário" abaixo).
const buildGraph = (b: Parameters<typeof buildGraphRaw>[0], o: Parameters<typeof buildGraphRaw>[1]) => buildGraphRaw(b, { showUserScope: true, ...o });

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
    effort: null,
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
    topic: null,
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
    for (const shelves of [{}, OPEN_A]) {
      const all = buildGraph(board(), shelves).nodes;
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
  });

  it('muitos projetos viram uma grade (várias linhas), não uma fila', () => {
    const projects = Array.from({ length: 12 }, (_, i) => project(`p${i}`, `C:\\www\\p${i}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const rooms = buildGraph(b, {}).nodes.filter((n) => n.type === 'room').map(rect);
    expect(rooms).toHaveLength(13); // "você" + 12
    expect(new Set(rooms.map((r) => r.y)).size).toBeGreaterThan(1);
    const w = Math.max(...rooms.map((r) => r.x + r.w)) - Math.min(...rooms.map((r) => r.x));
    const h = Math.max(...rooms.map((r) => r.y + r.h)) - Math.min(...rooms.map((r) => r.y));
    expect(w / h).toBeLessThan(4);
  });

  it('salas em ordem alfabética do nome, depois da sala "você", lidas da esquerda para a direita', () => {
    const names = ['zeta', 'Alfa', 'p10', 'beta', 'p2'];
    const projects = names.map((n) => project(n, `C:\\www\\${n}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const rooms = buildGraph(b, {}).nodes.filter((n) => n.type === 'room');
    const owners = rooms.map((r) => (r.type === 'room' ? r.data.owner : ''));
    expect(owners).toEqual(['u', 'p:Alfa', 'p:beta', 'p:p2', 'p:p10', 'p:zeta']);
    // A ordem na tela segue a da lista: linha por linha, da esquerda para a direita.
    const onScreen = [...rooms].sort((x, y) => x.position.y - y.position.y || x.position.x - y.position.x);
    expect(onScreen.map((r) => r.id)).toEqual(rooms.map((r) => r.id));
    // A lista do servidor não é reordenada no lugar.
    expect(b.projects.map((p) => p.name)).toEqual(names);
  });

  it('bolinhas na linha do gestor só quando o trabalho foi delegado; conversa direta só anima a borda', () => {
    const busy = (delegated: boolean) => ({
      ...board(),
      staff: [staffProfile('ana', ['s-a1']), staffProfile('bia', ['s-a2'], ['ana'])],
      live: [
        { sessionId: 's-a2', pid: 9, cwd: A, name: null, status: 'busy', alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null, delegated },
      ],
    } as Board);
    const line = (b: Board) => buildGraph(b, {}).edges.find((e) => e.source === 'h:a:ana' && e.target === 'h:a:bia');
    expect(line(busy(false))?.data?.active).toBeFalsy();
    expect(line(busy(true))?.data?.active).toBe(true);
  });

  it('a grade segue a proporção da tela: deitada cresce para a direita, em pé para baixo', () => {
    const projects = Array.from({ length: 12 }, (_, i) => project(`p${i}`, `C:\\www\\p${i}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const ratio = (aspect: number) => {
      const rooms = buildGraph(b, { aspect }).nodes.filter((n) => n.type === 'room').map(rect);
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

  it('com workspaces (aba Todos), as salas do mesmo workspace formam um bloco; os sem workspace vêm por último', () => {
    // Nomes que, em ordem alfabética, alternam os workspaces: p1(x) p2(y) p3(x) p4(y) p5(x) p6(-) p7(y) p8(-).
    const ws = ['x', 'y', 'x', 'y', 'x', null, 'y', null];
    const projects = ws.map((_, i) => project(`p${i + 1}`, `C:\\www\\p${i + 1}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const of = new Map(projects.map((p, i) => [p.id, ws[i]!] as const));
    const groups = { of, order: ['y', 'x'] }; // a ordem das abas, não a alfabética
    const roomsOf = (id: string | null, opts: Parameters<typeof buildGraph>[1]) => {
      const rooms = buildGraph(b, opts).nodes.filter((n) => n.type === 'room');
      return rooms.filter((r) => r.type === 'room' && of.get(r.data.owner.slice(2)) === id).map(rect);
    };
    const box = (rs: ReturnType<typeof rect>[]) => ({
      x: Math.min(...rs.map((r) => r.x)),
      y: Math.min(...rs.map((r) => r.y)),
      x2: Math.max(...rs.map((r) => r.x + r.w)),
      y2: Math.max(...rs.map((r) => r.y + r.h)),
    });
    const apart = (a: ReturnType<typeof box>, c: ReturnType<typeof box>) => a.x2 <= c.x || c.x2 <= a.x || a.y2 <= c.y || c.y2 <= a.y;
    const grouped = { aspect: 16 / 9, groups };
    const [bx, by, bn] = [box(roomsOf('x', grouped)), box(roomsOf('y', grouped)), box(roomsOf(null, grouped))];
    expect(apart(bx, by) && apart(bx, bn) && apart(by, bn)).toBe(true);
    // Sem `groups` a ordem alfabética mistura os workspaces: os blocos se cruzam.
    const mixed = { aspect: 16 / 9 };
    expect(apart(box(roomsOf('x', mixed)), box(roomsOf('y', mixed)))).toBe(false);
    // Ordem das abas: y antes de x (lendo linha por linha); sem workspace por último.
    const first = (rs: ReturnType<typeof rect>[]) => [...rs].sort((p, q) => p.y - q.y || p.x - q.x)[0]!;
    const reading = (r: ReturnType<typeof rect>) => r.y * 1e6 + r.x;
    expect(reading(first(roomsOf('y', grouped)))).toBeLessThan(reading(first(roomsOf('x', grouped))));
    expect(reading(first(roomsOf('x', grouped)))).toBeLessThan(reading(first(roomsOf(null, grouped))));
    // Dentro do bloco, continua a ordem alfabética, e nada se sobrepõe.
    const owners = (o: Parameters<typeof buildGraph>[1]) => buildGraph(b, o).nodes.flatMap((n) => (n.type === 'room' ? [n.data.owner] : []));
    expect(owners(grouped)).toEqual(['u', 'p:p2', 'p:p4', 'p:p7', 'p:p1', 'p:p3', 'p:p5', 'p:p6', 'p:p8']);
    const all = buildGraph(b, grouped).nodes.filter((n) => n.type !== 'room');
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i]!, all[j]!)).toBe(false);
  });

  it('`order` manda dentro do bloco: os fora da lista vêm depois, em ordem alfabética; as abas seguem a ordem delas', () => {
    const ws = ['x', 'y', 'x', 'y', 'x', 'y'];
    const projects = ws.map((_, i) => project(`p${i + 1}`, `C:\\www\\p${i + 1}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const groups = { of: new Map(projects.map((p, i) => [p.id, ws[i]!] as const)), order: ['y', 'x'] };
    const owners = (order?: string[]) => buildGraph(b, { aspect: 16 / 9, groups, order, showUserScope: false }).nodes.flatMap((n) => (n.type === 'room' ? [n.data.owner] : []));
    expect(owners()).toEqual(['p:p2', 'p:p4', 'p:p6', 'p:p1', 'p:p3', 'p:p5']);
    // p5 e p4 sobem; p1 e p3 (fora da lista) ficam depois, alfabéticos; o bloco y continua antes do x.
    expect(owners(['p5', 'p4'])).toEqual(['p:p4', 'p:p2', 'p:p6', 'p:p5', 'p:p1', 'p:p3']);
  });

  it('ordem de leitura: de cima para baixo e da esquerda para a direita, por bloco', () => {
    const at = (id: string, block: string, x: number, y: number) => ({ id, block, x, y });
    expect(readingOrder([at('c', 'x', 0, 400), at('b', 'x', 500, 0), at('a', 'x', 0, 0), at('z', 'y', 0, 0)])).toEqual(['a', 'b', 'c', 'z']);
    // Topo quase na mesma altura = mesma linha (vale o x); uma linha de verdade abaixo vem depois.
    expect(readingOrder([at('b', 'x', 500, 0), at('a', 'x', 0, 40), at('c', 'x', 0, 300)])).toEqual(['a', 'b', 'c']);
    // Cada bloco é lido à parte: uma sala de outro workspace entre as linhas não as junta nem separa.
    expect(readingOrder([at('a', 'x', 0, 0), at('o', 'y', 0, 100), at('b', 'x', 500, 50)])).toEqual(['a', 'b', 'o']);
    expect(readingOrder([])).toEqual([]);
  });

  it('os workspaces ficam lado a lado na tela deitada e empilhados na em pé', () => {
    const ws = ['x', 'x', 'y', 'y', 'z', 'z'];
    const projects = ws.map((_, i) => project(`p${i + 1}`, `C:\\www\\p${i + 1}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const of = new Map(projects.map((p, i) => [p.id, ws[i]!] as const));
    const groups = { of, order: ['x', 'y', 'z'] };
    const blocks = (aspect: number) => {
      const rooms = buildGraph(b, { aspect, groups, showUserScope: false }).nodes.filter((n) => n.type === 'room');
      return ['x', 'y', 'z'].map((id) => {
        const rs = rooms.filter((r) => r.type === 'room' && of.get(r.data.owner.slice(2)) === id).map(rect);
        return { x: Math.min(...rs.map((r) => r.x)), y: Math.min(...rs.map((r) => r.y)), x2: Math.max(...rs.map((r) => r.x + r.w)), y2: Math.max(...rs.map((r) => r.y + r.h)) };
      });
    };
    const [a, c, d] = blocks(16 / 9);
    expect(a!.x2).toBeLessThanOrEqual(c!.x);
    expect(c!.x2).toBeLessThanOrEqual(d!.x);
    expect([a!.y, c!.y, d!.y]).toEqual([a!.y, a!.y, a!.y]);
    const [e, f, g] = blocks(9 / 16);
    expect(e!.y2).toBeLessThanOrEqual(f!.y);
    expect(f!.y2).toBeLessThanOrEqual(g!.y);
    expect([e!.x, f!.x, g!.x]).toEqual([e!.x, e!.x, e!.x]);
  });

  it('com `groups` mas um workspace só, a planta é a mesma da grade simples', () => {
    const projects = Array.from({ length: 7 }, (_, i) => project(`p${i}`, `C:\\www\\p${i}`));
    const b: Board = { ...board(), projects, inventories: {}, sessions: {} };
    const of = new Map(projects.map((p) => [p.id, 'x'] as const));
    // Sem a sala "você" (que abre um bloco próprio quando há workspaces).
    const at = (o: Parameters<typeof buildGraph>[1]) => buildGraph(b, { aspect: 2, showUserScope: false, ...o }).nodes.map((n) => [n.id, n.position.x, n.position.y]);
    expect(at({ groups: { of, order: ['x'] } })).toEqual(at({}));
  });

  it('muitos agents/skills vão para uma estante, que abre quando pedido', () => {
    const closed = buildGraph(board(), {}).nodes;
    const shelf = closed.find((n) => n.id === 'sh:p:a');
    expect(shelf?.type === 'shelf' && shelf.data).toEqual({ agents: 1, skills: 8, expanded: false });
    expect(closed.some((n) => n.type === 'skill' && n.data.skill.dirPath.startsWith(A))).toBe(false);
    // Poucos itens (projeto B) continuam soltos.
    expect(closed.some((n) => n.id === 'sh:p:b')).toBe(false);
    expect(closed.some((n) => n.type === 'agent' && n.data.agent.filePath.startsWith(B))).toBe(true);

    const open = buildGraph(board(), { ...OPEN_A }).nodes;
    expect(open.filter((n) => n.type === 'skill' && n.data.skill.dirPath.startsWith(A))).toHaveLength(8);
    const s = open.find((n) => n.id === 'sh:p:a');
    expect(s?.type === 'shelf' && s.data.expanded).toBe(true);
  });

  it('worktrees ficam fora do quadro', () => {
    expect(buildGraph(board(), {}).nodes.some((n) => n.id === 'p:wt')).toBe(false);
  });

  it('agrupa as skills sincronizadas num nó só', () => {
    const { nodes } = buildGraph(board(), {});
    const synced = nodes.find((n) => n.type === 'synced');
    expect(synced?.type === 'synced' && synced.data.skills.map((s) => s.name)).toEqual(['pdf', 'docx']);
    expect(nodes.filter((n) => n.type === 'skill' && n.data.skill.scope === 'synced')).toHaveLength(0);
  });

  it('liga a origem ao agent emprestado', () => {
    const { edges } = buildGraph(board(), { ...OPEN_A });
    const borrow = edges.filter((e) => e.data?.kind === 'borrow');
    expect(borrow).toHaveLength(1);
    expect(borrow[0]).toMatchObject({
      source: `a:project:${A}\\.claude\\agents\\ds.md`,
      target: `a:project:${B}\\.claude\\agents\\ds.md`,
    });
  });

  it('com a estante fechada, o empréstimo sai da estante', () => {
    const borrow = buildGraph(board(), {}).edges.filter((e) => e.data?.kind === 'borrow');
    expect(borrow).toHaveLength(1);
    expect(borrow[0]).toMatchObject({ source: 'sh:p:a', target: `a:project:${B}\\.claude\\agents\\ds.md` });
  });

  it('conversas sem ficha viram um funcionário fantasma por projeto, com o custo somado', () => {
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
    const { nodes, edges } = buildGraph(board(), { costs, ...OPEN_A });

    const employees = nodes.filter((n) => n.type === 'employee');
    expect(employees.map((n) => n.id).sort()).toEqual(['g:a', 'g:b']);
    expect(edges.some((e) => e.source === 'p:a' && e.target === 'g:a' && e.data?.kind === 'contains')).toBe(true);

    const a1 = nodes.find((n) => n.id === 'g:a');
    expect(a1?.type === 'employee' && a1.data.ghost?.map((x) => x.id).sort()).toEqual(['s-a1', 's-a2']);
    expect(a1?.type === 'employee' && a1.data.costUsd).toBe(7.5);
    const b1 = nodes.find((n) => n.id === 'g:b');
    expect(b1?.type === 'employee' && b1.data.costUsd).toBeNull();
    const ds = nodes.find((n) => n.type === 'agent' && n.data.agent.filePath.startsWith(A));
    expect(ds?.type === 'agent' && ds.data.cost).toEqual({ usd: 2, runs: 3 });
  });

  it('salas em grade; hierarquia de cima para baixo; agents e skills ao lado do projeto', () => {
    const { nodes, edges } = buildGraph(board(), { ...OPEN_A });
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
    expect(pos('g:a').y).toBeGreaterThan(pos('p:a').y);
    expect(edges.find((e) => e.source === 'p:a' && e.target === 'g:a')).toMatchObject({ sourceHandle: 'b', targetHandle: 't', data: { kind: 'contains' } });
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
    const open = buildGraph(board(), {});
    const folded = buildGraph(board(), { collapsedRooms: ['p:a'] });
    const ids = (g: typeof open) => g.nodes.map((n) => n.id);
    expect(ids(open)).toContain('g:a');
    expect(ids(folded)).not.toContain('g:a');
    expect(folded.edges.some((e) => e.source === 'p:a' || e.target === 'p:a')).toBe(false);
    const header = folded.nodes.find((n) => n.id === 'p:a')!;
    const room = folded.nodes.find((n) => n.id === 'r:p:a')!;
    // 1 agent + 8 skills guardados.
    expect(header.type === 'project' && header.data.header).toMatchObject({ collapsed: true, resources: 9 });
    expect(room.height).toBe(header.height);
    // As outras salas continuam abertas.
    expect(ids(folded)).toContain('g:b');
  });

  it('git no cabeçalho: o estado do projeto chega ao nó', () => {
    const git = { a: { branch: 'main', dirty: 2, upstream: 'origin/main', ahead: 1, behind: 0 } };
    const { nodes } = buildGraph(board(), { git });
    const a = nodes.find((n) => n.id === 'p:a');
    const b = nodes.find((n) => n.id === 'p:b');
    expect(a?.type === 'project' && a.data.git).toEqual(git.a);
    expect(b?.type === 'project' && b.data.git).toBeNull();
  });

  it('cor da sala: a parede do projeto leva a cor escolhida; sem escolha (e a sala "você"), a padrão', () => {
    const { nodes } = buildGraph(board(), { projectColors: { a: 'teal' } });
    const color = (id: string) => {
      const room = nodes.find((n) => n.id === id);
      return room?.type === 'room' ? room.data.color : undefined;
    };
    expect(color('r:p:a')).toBe('teal');
    expect(color('r:p:b')).toBeNull();
    expect(color('r:u')).toBeNull();
  });

  it('funcionário com mais de um gestor: uma linha abaixo de todos, com a mesma ligação de cada um', () => {
    // ana e bia no mesmo nível: caio fica abaixo das duas e recebe a mesma linha (base → topo) de cada.
    const b = {
      ...board(),
      staff: [staffProfile('ana', ['s-a1']), staffProfile('bia', ['s-a2']), staffProfile('caio', [], ['ana', 'bia'])],
    };
    const { nodes, edges } = buildGraph(b, {});
    const posOf = (list: typeof nodes, id: string) => list.find((n) => n.id === id)!.position;
    expect(posOf(nodes, 'h:a:caio').y).toBeGreaterThan(posOf(nodes, 'h:a:ana').y);
    for (const manager of ['ana', 'bia']) {
      const link = edges.find((e) => e.source === `h:a:${manager}` && e.target === 'h:a:caio');
      expect(link?.data?.kind).toBe('contains');
      expect(link).toMatchObject({ sourceHandle: 'b', targetHandle: 't' });
      expect(link?.data?.detour).toBeUndefined();
    }

    // ana chefia bia; caio reporta a ana e a bia: fica abaixo de bia (a mais funda), nunca ao lado dela.
    const chain = { ...board(), staff: [staffProfile('ana', ['s-a1']), staffProfile('bia', ['s-a2'], ['ana']), staffProfile('caio', [], ['ana', 'bia'])] };
    const g = buildGraph(chain, {});
    const [ana, bia, caio] = ['ana', 'bia', 'caio'].map((id) => posOf(g.nodes, `h:a:${id}`));
    expect(caio!.y).toBeGreaterThan(bia!.y);
    expect(bia!.y).toBeGreaterThan(ana!.y);
    const fromBia = g.edges.find((e) => e.source === 'h:a:bia' && e.target === 'h:a:caio');
    expect(fromBia?.data?.kind).toBe('contains');
    expect(fromBia?.data?.detour).toBeUndefined();
    // De ana (duas fileiras acima) a linha contorna o cartão de bia por fora, com as barras no meio dos vãos.
    const fromAna = g.edges.find((e) => e.source === 'h:a:ana' && e.target === 'h:a:caio');
    expect(fromAna?.data?.kind).toBe('contains');
    const detour = fromAna?.data?.detour;
    expect(detour).toBeDefined();
    const { w, h } = SIZES.employee;
    expect(detour!.x < bia!.x || detour!.x > bia!.x + w).toBe(true);
    expect(detour!.y1).toBeGreaterThan(ana!.y + h);
    expect(detour!.y1).toBeLessThan(bia!.y);
    expect(detour!.y2).toBeGreaterThan(bia!.y + h);
    expect(detour!.y2).toBeLessThan(caio!.y);
  });

  it('ciclo de gestores não trava o layout', () => {
    const b = { ...board(), staff: [staffProfile('x', [], ['y']), staffProfile('y', [], ['x'])] };
    const ids = buildGraph(b, {}).nodes.map((n) => n.id);
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
    const { nodes, edges } = buildGraph(b, { costs });

    // As duas sessões do chefe viram um funcionário só.
    expect(nodes.some((n) => n.id === 'g:a')).toBe(false); // sem conversa solta, sem fantasma
    const chefe = nodes.find((n) => n.id === 'h:a:chefe');
    expect(chefe?.type === 'employee' && chefe.data.session?.id).toBe('s-a1');
    expect(chefe?.type === 'employee' && chefe.data.costUsd).toBe(3);

    const novo = nodes.find((n) => n.id === 'h:a:novo');
    expect(novo?.type === 'employee' && novo.data.session).toBeNull();
    expect(edges.some((e) => e.source === 'h:a:chefe' && e.target === 'h:a:novo')).toBe(true);
    expect(edges.some((e) => e.source === 'p:a' && e.target === 'h:a:novo')).toBe(false);
  });

  it('ficha trabalhando numa conversa que não é a última: o cartão e a linha seguem a conversa viva', () => {
    const b = { ...board(), staff: [staffProfile('chefe', ['s-a1', 's-a2'])] };
    const working = { sessionId: 's-a2', pid: 9, cwd: A, name: null, status: 'busy', alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null, delegated: true } as const;
    b.live = [working];
    const { nodes, edges } = buildGraph(b, {});
    const chefe = nodes.find((n) => n.id === 'h:a:chefe');
    expect(chefe?.type === 'employee' && chefe.data.session?.id).toBe('s-a2');
    expect(chefe?.type === 'employee' && chefe.data.session?.live?.status).toBe('busy');
    expect(edges.filter((e) => e.data?.active).map((e) => e.target)).toEqual(['h:a:chefe']);

    // A mais recente também viva e no mesmo estado: no empate fica a mais recente.
    b.live = [working, { ...working, sessionId: 's-a1' }];
    const tie = buildGraph(b, {}).nodes.find((n) => n.id === 'h:a:chefe');
    expect(tie?.type === 'employee' && tie.data.session?.id).toBe('s-a1');
    // Trabalhando ganha de parada, mesmo na mais antiga.
    b.live = [{ ...working, sessionId: 's-a1', status: 'idle' }, working];
    const busy = buildGraph(b, {}).nodes.find((n) => n.id === 'h:a:chefe');
    expect(busy?.type === 'employee' && busy.data.session?.id).toBe('s-a2');
  });

  it('arquivados somem do quadro, ou aparecem marcados quando pedido', () => {
    const archived = { projects: ['b'], sessions: ['s-a2'], conversations: {} };
    const hidden = buildGraph(board(), { archived });
    const ids = hidden.nodes.map((n) => n.id);
    expect(ids).not.toContain('p:b');
    expect(ids).not.toContain('g:b'); // funcionários de projeto arquivado somem junto
    const ghost = hidden.nodes.find((n) => n.id === 'g:a');
    expect(ghost?.type === 'employee' && ghost.data.ghost?.map((x) => x.id)).toEqual(['s-a1']);

    const shown = buildGraph(board(), { archived, showArchived: true });
    const b = shown.nodes.find((n) => n.id === 'p:b');
    expect(b?.type === 'project' && b.data.archived).toBe(true);
    const a = shown.nodes.find((n) => n.id === 'g:a');
    expect(a?.type === 'employee' && a.data.ghost?.map((x) => x.id).sort()).toEqual(['s-a1', 's-a2']);
    expect(a?.type === 'employee' && a.data.archived).toBe(false); // só arquivado com todas as conversas arquivadas
    const onlyArchived = buildGraph(board(), { archived: { projects: [], sessions: ['s-a1', 's-a2'], conversations: {} }, showArchived: true });
    const all = onlyArchived.nodes.find((n) => n.id === 'g:a');
    expect(all?.type === 'employee' && all.data.archived).toBe(true);
  });

  it('marca como ativa só a linha que chega a um funcionário trabalhando numa tarefa delegada', () => {
    const b = board();
    const working = { sessionId: 's-a1', pid: 9, cwd: A, name: null, status: 'busy', alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null } as const;
    // Trabalhando no que você pediu no chat: nenhuma linha anima (só a borda do cartão).
    b.live = [working];
    expect(buildGraph(b, {}).edges.filter((e) => e.data?.active)).toEqual([]);
    b.live = [{ ...working, delegated: true }];
    const active = buildGraph(b, {}).edges.filter((e) => e.data?.active);
    expect(active.map((e) => e.target)).toEqual(['g:a']);
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
    const { edges } = buildGraph(b, {});
    const d = edges.filter((e) => e.data?.kind === 'delegates');
    // Só o agent que existe no quadro ganha linha (Explore é embutido); o do projeto A, não o emprestado em B.
    // Com muitos itens, o agent está guardado na estante fechada da sala: a linha vai até ela.
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ source: 'g:a', target: 'sh:p:a', data: { kind: 'delegates', active: true }, sourceHandle: 'ro', targetHandle: 'li' });
  });

  it('anexa só as sessões vivas do projeto', () => {
    const { nodes } = buildGraph(board(), {});
    const a = nodes.find((n) => n.id === 'p:a');
    expect(a?.type === 'project' && a.data.live.map((s) => s.sessionId)).toEqual(['1']);
  });

  it('esperando você: cartão e contador da sala destacam quem tem item na caixa, mesmo com a sessão parada', () => {
    const b = board();
    b.staff = [staffProfile('ana', ['s-a1'])];
    // O turno de s-a1 acabou perguntando: a sessão está parada (idle), não esperando resposta.
    b.live = [{ sessionId: 's-a1', pid: 9, cwd: A, name: null, status: 'idle', alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null }];
    const question: InboxItem = {
      id: 'question:s-a1:t', kind: 'waiting', projectId: 'a', projectName: 'a', sessionId: 's-a1', staffId: null,
      name: 'Refatorar DS', summary: 'perguntou: qual branch?', at: '2026-10-29T10:00:00.000Z',
    };
    const routine: InboxItem = { ...question, id: 'routine:r1', kind: 'routine', sessionId: '', staffId: 'ana', name: 'ANA', summary: 'rotina pulada' };
    const graph = (inbox: InboxItem[]) => buildGraph(b, { inbox }).nodes;
    const emp = (nodes: BoardNode[], id: string) => {
      const n = nodes.find((x) => x.id === id);
      return n?.type === 'employee' ? n.data : null;
    };
    const proj = (nodes: BoardNode[], id: string) => {
      const n = nodes.find((x) => x.id === id);
      return n?.type === 'project' ? n.data : null;
    };

    // Sem item e com a sessão parada: nada destaca.
    expect(emp(graph([]), 'h:a:ana')?.needsYou).toBe(false);
    expect(proj(graph([]), 'p:a')?.awaiting).toBe(0);
    // Pergunta na caixa de uma sessão da ficha: o cartão da ficha destaca; o contador da sala conta a sessão viva.
    expect(emp(graph([question]), 'h:a:ana')?.needsYou).toBe(true);
    expect(proj(graph([question]), 'p:a')?.awaiting).toBe(1);
    // Rotina pulada da ficha (sem sessão) também destaca o cartão dela.
    expect(emp(graph([routine]), 'h:a:ana')?.needsYou).toBe(true);
    // Sessão esperando em outro lugar que você dispensou (sem item na caixa): o cartão apaga.
    b.live = [{ ...b.live[0]!, status: 'waiting' }];
    expect(emp(graph([]), 'h:a:ana')?.needsYou).toBe(false);
    expect(proj(graph([]), 'p:a')?.awaiting).toBe(0);
  });

  it('conversa solta com item na caixa destaca o fantasma, que mostra a conversa viva', () => {
    const b = board();
    b.live = [{ sessionId: 's-a2', pid: 8, cwd: A, name: null, status: 'idle', alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null }];
    const item: InboxItem = { id: 'error:s-a2', kind: 'error', projectId: 'a', projectName: 'a', sessionId: 's-a2', staffId: null, name: 'sessão', summary: 'erro', at: null };
    const { nodes } = buildGraph(b, { inbox: [item] });
    const n = nodes.find((x) => x.id === 'g:a');
    expect(n?.type === 'employee' && n.data.needsYou).toBe(true);
    expect(n?.type === 'employee' && n.data.session?.id).toBe('s-a2');
    const other = buildGraph(b, { inbox: [] }).nodes.find((x) => x.id === 'g:a');
    expect(other?.type === 'employee' && other.data.needsYou).toBe(false);
  });
});

describe('escopo do usuário', () => {
  it('fica fora do quadro por padrão e volta com a opção do config', () => {
    const ids = (show?: boolean) => buildGraphRaw(board(), { showUserScope: show }).nodes.map((n) => n.id);
    expect(ids()).not.toContain('u');
    expect(ids(true)).toContain('u');
  });
});

describe('endereço do retrato', () => {
  it('muda quando a ficha é salva, para o quadro buscar a foto nova sem recarregar', () => {
    const before = portraitUrl('a', { ...staffProfile('ana', []), updatedAt: '2026-11-03T10:00:00.000Z' });
    const after = portraitUrl('a', { ...staffProfile('ana', []), updatedAt: '2026-11-03T10:05:00.000Z' });
    expect(before).toMatch(/^\/api\/projects\/a\/staff\/ana\/portrait\?v=/);
    expect(after).not.toBe(before);
  });
});
