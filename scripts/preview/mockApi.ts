import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import * as fx from './fixtures';

// API simulada da prévia: só responde com os dados de fixtures.ts, em memória. Não conecta a servidor nenhum.
// Leituras conhecidas devolvem os dados fictícios; o resto de GET devolve 404 e toda escrita (POST/PUT/DELETE) é recusada,
// para a prévia nunca parecer ter gravado algo de verdade.

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

export function route(method: string, path: string): { status: number; body: unknown } {
  if (method !== 'GET') return { status: 403, body: { error: 'Modo prévia: somente leitura, nada é gravado.' } };
  const p = path.replace(/\/$/, '');
  const exact: Record<string, unknown> = {
    '/api/board': fx.board,
    '/api/projects': fx.projects,
    '/api/user': fx.board.user,
    '/api/live': fx.lives,
    '/api/roles': fx.roles,
    '/api/config': fx.config,
    '/api/server': fx.server,
    '/api/system': fx.system,
    '/api/usage': fx.usage,
    '/api/auth': fx.auth,
    '/api/health': { ok: true },
    '/api/extension': { id: 'preview', available: false, pairings: [] },
    '/api/update': { supported: false, current: 'v1.5.1', latest: 'v1.5.1', behind: 0, diverged: false, dirty: false, notes: null, commits: [], checkedAt: null, error: null },
    '/api/inbox': [],
    '/api/turns': [],
    '/api/costs': fx.costs,
    '/api/git': Object.fromEntries(fx.projects.map((x) => [x.id, { branch: 'main', dirty: 2, upstream: 'origin/main', ahead: 0, behind: 0 }])),
    '/api/staff-directory': { people: [] },
    '/api/mcp-servers': { servers: [] },
    '/api/skills/library': [],
    '/api/browser': { extension: false, bridge: false, installUrl: '' },
    '/api/schedules': { routines: [] },
  };
  if (p in exact) return { status: 200, body: exact[p] };
  let m = /^\/api\/projects\/([^/]+)$/.exec(p);
  if (m) {
    const project = fx.projects.find((x) => x.id === decodeURIComponent(m![1]!));
    if (!project) return { status: 404, body: { error: 'projeto não existe na prévia' } };
    return { status: 200, body: { ...fx.board.inventories[project.id], project, sessions: fx.board.sessions[project.id] ?? [] } };
  }
  m = /^\/api\/projects\/([^/]+)\/(tasks|mcp|servers|git\/uncommitted|pause)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const what = m[2]!;
    if (what === 'tasks') return { status: 200, body: fx.tasks[id] ?? [] };
    if (what === 'pause') return { status: 200, body: { paused: null } };
    if (what === 'git/uncommitted') return { status: 200, body: { total: 0, recentDays: 3, conversations: [], unowned: [] } };
    return { status: 200, body: [] };
  }
  if (p === '/api/tasks/summary') return { status: 200, body: Object.fromEntries(fx.projects.map((x) => [x.id, fx.taskSummary])) };
  return { status: 404, body: { error: `sem dado fictício para ${p}` } };
}

export function mockApi(): Plugin {
  return {
    name: 'claudios-preview-mock-api',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/')) return next();
        const { status, body } = route(req.method ?? 'GET', url.split('?')[0]!);
        json(res, status, body);
      });
    },
  };
}
