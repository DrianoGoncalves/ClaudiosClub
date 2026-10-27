import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ClaudeAdapter } from './adapters/claude';
import { defaultLocations } from './adapters/claude/paths';
import type { ToolAdapter } from './adapters/types';
import { getAuthStatus, openLoginTerminal } from './auth';
import { ArchiveRequest, ConfigPatch, MYCO_HOME, readConfig, setArchived, updateConfig } from './config';
import { z } from 'zod';
import { AgentError, AgentInput, readAgentSource, saveAgent } from './adapters/claude/agentWrite';
import { ChatError, ChatManager } from './chat/manager';
import { ChatRegistry } from './chat/registry';
import { StaffError, StaffService } from './staff/service';
import { FileError, projectImageUrl, readAccountRules, readProjectImage, saveAccountRules, saveProjectImage } from './files';
import { readUsage } from './usage';
import { UsageStopError } from './usageStop';
import { browserStatus } from './browser';
import { gitState } from './git';
import { buildOrchestration, MarkBody, readMarks, saveMark, withRunInfo } from './orchestration';
import type { Board, CostReport, InboxItem, InboxKind, LiveSession, Project, TurnNotice } from '../shared/model';
import { TurnWatcher } from './turns';
import { RoutineScheduler, type RoutineOutcome } from './routines';
import type { Routine, StaffProfile } from '../shared/model';
import { encodeProjectDir, pathKey } from './adapters/claude/paths';
import { AUTONOMY, readProfile } from './staff/store';
import { TaskError, TaskService } from './tasks';
import { CodeError } from './taskCode';
import { cleanRunDir } from './runCleanup';

const PORT = Number(process.env.MYCO_PORT ?? 4848);
// Só local: o MyCo lê transcripts e configurações do usuário.
const HOST = '127.0.0.1';
const CLIENT_DIR = path.resolve(import.meta.dirname, '../dist/client');
// `myco.localhost`: endereço fixo do MyCo. Todo `*.localhost` aponta para a própria máquina nos
// navegadores (RFC 6761), sem mexer no arquivo hosts; continua protegido contra DNS rebinding.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', 'myco.localhost']);
// Retratos chegam como data URL no JSON da contratação.
const MAX_BODY = 4 * 1024 * 1024;

const adapter: ToolAdapter = new ClaudeAdapter();
const staff = new StaffService(adapter, {
  runDir: path.join(MYCO_HOME, 'run'),
  claudeConfigFile: defaultLocations().configFile,
  mycoUrl: `http://127.0.0.1:${PORT}`,
  onChange: (prev, next) => chats.profileChanged(prev, next),
  weekCost: async (projectId) => {
    const c = await getCosts();
    return { project: c.projects[projectId]?.last7d ?? 0, total: c.total.last7d };
  },
});
const chats = new ChatManager({
  transcriptsDir: path.join(defaultLocations().home, 'projects'),
  usageFile: path.join(MYCO_HOME, 'usage.json'),
  listLive: () => adapter.listLiveSessions(),
  resolve: (projectId, sessionId, staffId) => staff.chatSpawn(projectId, sessionId, staffId),
  registry: new ChatRegistry(path.join(MYCO_HOME, 'run', 'chats.json')),
  onPlanApproved: (sid, plan) => void tasks.onPlanApproved(sid, plan).catch(() => {}),
  onSent: (sid) => void tasks.onSent(sid).catch(() => {}),
});
// Quem acabou de terminar o turno (trabalhando → parado), para o aviso "terminou" no navegador.
const turns = new TurnWatcher(
  () => adapter.listLiveSessions(),
  (sid) => chats.lastAssistantText(sid),
  (sid) => void tasks.onTurnDone(sid).catch(() => {}),
);
turns.start();

// Tarefas por projeto (`.myco/tasks.json`): começam numa conversa nova e andam sozinhas com ela.
const projectPathOf = async (projectId: string) => {
  const p = (await adapter.listProjects()).find((x) => x.id === projectId);
  return p?.exists ? p.path : null;
};
const tasks = new TaskService({
  projectPath: projectPathOf,
  projectIds: async () => (await adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf).map((p) => p.id),
  readProfile: async (projectId, staffId) => {
    const dir = await projectPathOf(projectId);
    return dir ? readProfile(dir, staffId) : null;
  },
  send: async (projectId, staffId, text, force) => {
    if (!force) await staff.checkUsage(projectId, staffId);
    return chats.send(projectId, null, staffId, text);
  },
  branchFor: async (dir, profile) => (profile.worktree ? `myco/${profile.id}` : ((await gitState(dir))?.branch ?? null)),
});

// Rotinas: no horário, a mensagem vai ao funcionário pelo mesmo caminho do chat do painel.
const routines = new RoutineScheduler({
  file: path.join(MYCO_HOME, 'routines.json'),
  listStaff: async () => {
    const [projects, config] = await Promise.all([adapter.listProjects(), readConfig()]);
    const archived = new Set([...config.archived.projects, ...config.archived.sessions]);
    const all = await staff.listAll(projects.filter((p) => p.exists && !archived.has(p.id)));
    return all.filter((s) => !archived.has(`staff:${s.id}`));
  },
  run: runRoutine,
});

/**
 * Uma rotina disparando. As mesmas travas do chat valem, mas não há a quem perguntar: passou da
 * trava de consumo ou do orçamento, a rotina é pulada (e o aviso vai para a caixa). Também não
 * começa com o funcionário trabalhando ou com a sessão aberta em outro lugar.
 */
async function runRoutine(profile: StaffProfile, r: Routine): Promise<RoutineOutcome> {
  try {
    await staff.checkUsage(profile.projectId, profile.id);
  } catch (err) {
    if (err instanceof UsageStopError) return { ok: false, text: `pulada: ${err.message}` };
    throw err;
  }
  const last = r.mode === 'continue' ? (profile.sessions.at(-1)?.id ?? null) : null;
  if (last && chats.isBusy(last)) return { ok: false, text: 'pulada: ele estava trabalhando' };
  try {
    const sid = await chats.send(profile.projectId, last, profile.id, `[Rotina "${r.name}"] ${r.message}`);
    return { ok: true, text: last === sid ? 'mandada na última conversa' : 'mandada numa conversa nova' };
  } catch (err) {
    if (err instanceof ChatError) return { ok: false, text: `pulada: ${err.message}` };
    throw err;
  }
}

/** Imagem colada no chat (já reduzida no navegador): data URL PNG, JPEG, WebP ou GIF. */
const ChatImage = z
  .string()
  .max(1_200_000, 'imagem grande demais')
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, 'imagem inválida: use PNG, JPEG, WebP ou GIF');
const SendBody = z
  .object({
    sessionId: z.string().uuid().nullable(),
    staffId: z.string().max(40).nullable(),
    text: z.string().trim().max(50_000).default(''),
    /** Prints e imagens coladas (até 4). */
    images: z.array(ChatImage).max(4, 'no máximo 4 imagens por mensagem').default([]),
    /** Confirmado no MyCo: segue mesmo acima da linha de parada do consumo. */
    force: z.boolean().default(false),
    /** Com o funcionário trabalhando; sem ela, vale a da configuração. */
    priority: z.enum(['now', 'next', 'later']).optional(),
  })
  .refine((b) => b.text.length > 0 || b.images.length > 0, 'mensagem vazia');
const PermissionBody = z.object({
  requestId: z.string().min(1).max(100),
  allow: z.boolean(),
  /** Ao negar: o que o funcionário lê (ex.: "quero mudanças no plano"). */
  message: z.string().trim().min(1).max(500).optional(),
  /** Ao aprovar um plano: autonomia com que ele executa (só pelo MyCo). */
  executeAs: z.enum(AUTONOMY).optional(),
});
const StaffRef = z.object({ staffId: z.string().max(40).nullable().default(null), force: z.boolean().default(false) });

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequest(r.error.issues[0]?.message ?? 'pedido inválido');
  return r.data;
}

interface Request {
  params: string[];
  url: URL;
  body: unknown;
  /** Veio da página do MyCo (tem Origin local), e não de uma ferramenta de linha de comando. */
  fromBrowser: boolean;
}

type Handler = (r: Request) => Promise<unknown>;

/** Resposta binária (retratos), em vez de JSON. */
class Raw {
  constructor(
    readonly bytes: Buffer,
    readonly type: string,
  ) {}
}

class BadRequest extends Error {}

const ID = '([A-Za-z0-9-]+)';

const routes: Array<['GET' | 'POST', RegExp, Handler]> = [
  ['GET', /^\/api\/health$/, async () => ({ ok: true, adapter: adapter.id })],
  ['GET', /^\/api\/projects$/, () => adapter.listProjects()],
  ['GET', new RegExp(`^/api/projects/${ID}$`), ({ params: [id] }) => adapter.getProject(id!)],
  ['GET', new RegExp(`^/api/projects/${ID}/mcp$`), ({ params: [id] }) => staff.listMcp(id!)],
  ['GET', new RegExp(`^/api/projects/${ID}/servers$`), ({ params: [id] }) => staff.listServers(id!)],
  ['POST', new RegExp(`^/api/projects/${ID}/staff$`), ({ params: [id], body, fromBrowser }) => staff.hire(id!, body, fromBrowser)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/launch$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      const b = parse(z.object({ resume: z.boolean().default(false), force: z.boolean().default(false) }), body ?? {});
      return staff.launch(id!, staffId!, b.resume, fromBrowser && b.force);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('a ficha só é editada pelo MyCo');
      return staff.update(id!, staffId!, body);
    },
  ],
  ['GET', new RegExp(`^/api/projects/${ID}/staff/${ID}/versions$`), ({ params: [id, staffId] }) => staff.versions(id!, staffId!)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/restore$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('a ficha só é editada pelo MyCo');
      return staff.restore(id!, staffId!, parse(z.object({ version: z.string().max(40) }), body).version);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/managers$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('vínculos só pelo MyCo');
      return staff.addManager(id!, staffId!, parse(z.object({ managerId: z.string().max(40) }), body).managerId);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/managers/remove$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('vínculos só pelo MyCo');
      return staff.removeManager(id!, staffId!, parse(z.object({ managerId: z.string().max(40) }), body).managerId);
    },
  ],
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/portrait$`),
    async ({ params: [id, staffId] }) => {
      const img = await staff.portrait(id!, staffId!);
      return img ? new Raw(img.bytes, img.type) : null;
    },
  ],
  // ---- conversa ----
  ['GET', new RegExp(`^/api/projects/${ID}/chat/${ID}$`), ({ params: [pid, sid] }) => chats.snapshot(pid!, sid!)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/send$`),
    async ({ params: [pid], body, fromBrowser }) => {
      const b = parse(SendBody, body);
      if (!(fromBrowser && b.force)) await staff.checkUsage(pid!, b.staffId);
      const priority = b.priority ?? (await readConfig()).sendWhileBusy;
      return { sessionId: await chats.send(pid!, b.sessionId, b.staffId, b.text, priority, b.images) };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/chat/${ID}/compact$`),
    async ({ params: [pid, sid], body, fromBrowser }) => {
      const b = parse(StaffRef, body);
      if (!(fromBrowser && b.force)) await staff.checkUsage(pid!, b.staffId);
      await chats.compact(pid!, sid!, b.staffId);
      return { ok: true };
    },
  ],
  [
    'POST',
    new RegExp(`^/api/chat/${ID}/permission$`),
    async ({ params: [sid], body, fromBrowser }) => {
      const b = parse(PermissionBody, body);
      return { ok: chats.answer(sid!, b.requestId, b.allow, { message: b.message, executeAs: fromBrowser ? b.executeAs : undefined }) };
    },
  ],
  // ---- caixa "precisa de mim" ----
  ['GET', /^\/api\/inbox$/, () => getInbox()],
  ['GET', /^\/api\/turns$/, ({ url }) => getTurns(url.searchParams.get('since'))],
  // ---- tarefas por projeto ----
  ['GET', /^\/api\/tasks\/summary$/, () => tasks.summary()],
  ['GET', new RegExp(`^/api/projects/${ID}/tasks$`), ({ params: [id] }) => tasks.list(id!)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks$`),
    ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo MyCo');
      return tasks.create(id!, body);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}$`),
    ({ params: [id, taskId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo MyCo');
      return tasks.update(id!, taskId!, body);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/start$`),
    ({ params: [id, taskId], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo MyCo');
      return tasks.start(id!, taskId!, (body as { force?: unknown } | null)?.force === true);
    },
  ],
  ['GET', new RegExp(`^/api/projects/${ID}/tasks/${ID}/code$`), ({ params: [id, taskId] }) => tasks.code(id!, taskId!)],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/(test|merge|review|deploy)$`),
    ({ params: [id, taskId, action], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo MyCo');
      const b = parse(z.object({ staffId: z.string().max(40).optional(), force: z.boolean().default(false), skipTests: z.boolean().default(false) }), body ?? {});
      if (action === 'test') return tasks.test(id!, taskId!);
      if (action === 'merge') return tasks.merge(id!, taskId!, b.skipTests);
      if (!b.staffId) throw new BadRequest(action === 'review' ? 'escolha quem revisa' : 'escolha quem faz o deploy');
      return action === 'review' ? tasks.requestReview(id!, taskId!, b.staffId, b.force) : tasks.requestDeploy(id!, taskId!, b.staffId, b.force);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/tasks/${ID}/delete$`),
    async ({ params: [id, taskId], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('tarefas só pelo MyCo');
      return { ok: await tasks.remove(id!, taskId!) };
    },
  ],
  // ---- rotinas agendadas ----
  ['GET', /^\/api\/routines\/state$/, () => routines.state()],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/routines$`),
    ({ params: [id, staffId], body, fromBrowser }) => {
      // Um funcionário não agenda trabalho para si mesmo (nem para outro) pela API.
      if (!fromBrowser) throw new BadRequest('rotinas só pelo MyCo');
      return staff.setRoutines(id!, staffId!, (body as { routines?: unknown } | null)?.routines);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/staff/${ID}/routines/${ID}/run$`),
    async ({ params: [id, staffId, routineId], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('rotinas só pelo MyCo');
      const profile = (await staff.listAll((await adapter.listProjects()).filter((p) => p.id === id))).find((s) => s.id === staffId);
      return profile ? await routines.runNow(profile, routineId!) : null;
    },
  ],
  [
    'POST',
    /^\/api\/routines\/alerts\/dismiss$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo MyCo');
      const b = parse(z.object({ id: z.string().min(1).max(300) }), body);
      return { ok: routines.dismissAlert(b.id) };
    },
  ],
  [
    'POST',
    /^\/api\/secrets\/dismiss$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo MyCo');
      const b = parse(z.object({ id: z.string().min(1).max(200) }), body);
      return { ok: chats.dismissSecret(b.id) };
    },
  ],
  ['POST', new RegExp(`^/api/chat/${ID}/interrupt$`), async ({ params: [sid] }) => (chats.interrupt(sid!), { ok: true })],
  ['POST', new RegExp(`^/api/chat/${ID}/stop$`), async ({ params: [sid] }) => (chats.stop(sid!), { ok: true })],
  [
    'POST',
    new RegExp(`^/api/chat/${ID}/adopt$`),
    async ({ params: [sid], fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo MyCo');
      await chats.adopt(sid!);
      return { ok: true };
    },
  ],
  // ---- imagem do projeto e regras da conta ----
  [
    'GET',
    new RegExp(`^/api/projects/${ID}/image$`),
    async ({ params: [id] }) => {
      const p = await projectById(id!);
      const img = p ? await readProjectImage(p.path) : null;
      return img ? new Raw(img.bytes, img.type) : null;
    },
  ],
  [
    'POST',
    new RegExp(`^/api/projects/${ID}/image$`),
    async ({ params: [id], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo MyCo');
      const p = await projectById(id!);
      if (!p) return null;
      const { dataUrl } = parse(z.object({ dataUrl: z.string().max(3_000_000).nullable() }), body);
      await saveProjectImage(p.path, dataUrl);
      return { image: await projectImageUrl(p.id, p.path) };
    },
  ],
  ['GET', /^\/api\/account\/rules$/, () => readAccountRules()],
  [
    'POST',
    /^\/api\/account\/rules$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('as regras da conta só são editadas pelo MyCo');
      return saveAccountRules(parse(z.object({ text: z.string() }), body).text);
    },
  ],
  // ---- agents (subagents): criar e editar ----
  [
    'GET',
    /^\/api\/agents\/source$/,
    async ({ url }) => {
      const dir = await agentsDir(url.searchParams.get('scope'), url.searchParams.get('projectId'));
      const name = url.searchParams.get('name') ?? '';
      return dir ? readAgentSource(dir, name) : null;
    },
  ],
  [
    'POST',
    /^\/api\/agents\/save$/,
    async ({ body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('agents só são editados pelo MyCo');
      const b = parse(z.object({ scope: z.enum(['project', 'user']), projectId: z.string().max(200).nullable().default(null) }), body);
      const dir = await agentsDir(b.scope, b.projectId);
      if (!dir) return null;
      return saveAgent(dir, parse(AgentInput, body), path.join(MYCO_HOME, 'backups', 'agents'));
    },
  ],
  ['GET', /^\/api\/user$/, () => adapter.getUserScope()],
  ['GET', /^\/api\/board$/, () => getBoard()],
  ['GET', /^\/api\/live$/, () => adapter.listLiveSessions()],
  // Estado do código de cada projeto (git status, com cache curto); worktrees ficam de fora.
  [
    'GET',
    /^\/api\/git$/,
    async () => {
      const projects = (await adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf);
      const states = await Promise.all(projects.map(async (p) => [p.id, await gitState(p.path)] as const));
      return Object.fromEntries(states.filter(([, s]) => s !== null));
    },
  ],
  ['GET', /^\/api\/auth$/, ({ url }) => getAuthStatus({ fresh: url.searchParams.has('fresh') })],
  ['POST', /^\/api\/auth\/login$/, async () => openLoginTerminal()],
  ['GET', /^\/api\/usage$/, () => readUsage()],
  ['GET', /^\/api\/browser$/, ({ url }) => browserStatus(url.searchParams.has('fresh'))],
  ['GET', /^\/api\/costs$/, () => getCosts()],
  // ---- "valeu a pena?" de uma sessão ----
  [
    'GET',
    new RegExp(`^/api/sessions/${ID}/orchestration$`),
    async ({ params: [sid] }) => {
      const { files, scanning } = await adapter.getSessionCostFiles(sid!);
      return buildOrchestration(sid!, await withRunInfo(files), await readMarks(sid!), scanning);
    },
  ],
  [
    'POST',
    new RegExp(`^/api/sessions/${ID}/marks$`),
    async ({ params: [sid], body, fromBrowser }) => {
      if (!fromBrowser) throw new BadRequest('só pelo MyCo');
      const b = parse(MarkBody, body);
      return saveMark(sid!, b.runId, b.mark);
    },
  ],
  [
    'POST',
    /^\/api\/archive$/,
    async ({ body }) => {
      const req = ArchiveRequest.safeParse(body);
      if (!req.success) throw new BadRequest('pedido de arquivamento inválido');
      return setArchived(req.data);
    },
  ],
  ['GET', /^\/api\/config$/, () => readConfig()],
  [
    'POST',
    /^\/api\/config$/,
    async ({ body }) => {
      const patch = ConfigPatch.safeParse(body);
      if (!patch.success) throw new BadRequest(patch.error.issues[0]?.message ?? 'configuração inválida');
      return updateConfig(patch.data);
    },
  ],
];

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  // Bloqueia DNS rebinding: só aceita Host local.
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTNAMES.has(hostname)) return send(res, 403, { error: 'host não permitido' });
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'método não permitido' });
  // Ações (POST) exigem um cabeçalho próprio: o navegador não deixa outro site enviá-lo sem CORS,
  // que este servidor não libera. Assim uma página qualquer não consegue disparar ações locais.
  if (req.method === 'POST' && (req.headers['x-myco'] !== '1' || !isLocalOrigin(req.headers.origin))) {
    return send(res, 403, { error: 'origem não permitida' });
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const stream = STREAM_ROUTE.exec(url.pathname);
  if (stream && req.method === 'GET') return serveChatStream(stream[1]!, Number(url.searchParams.get('after') ?? 0), req, res);
  if (url.pathname.startsWith('/api/')) {
    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(url.pathname);
      if (!m || method !== req.method) continue;
      try {
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        const out = await handler({ params: m.slice(1), url, body, fromBrowser: !!req.headers.origin });
        if (out === null) return send(res, 404, { error: 'não encontrado' });
        if (out instanceof Raw) {
          // no-cache + ETag: o navegador confere a cada vez, mas só baixa de novo se a imagem mudou.
          const etag = `"${createHash('sha1').update(out.bytes).digest('base64url')}"`;
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': 'no-cache' });
            return res.end();
          }
          res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-cache', etag });
          return res.end(out.bytes);
        }
        return send(res, 200, out);
      } catch (err) {
        if (err instanceof UsageStopError) return send(res, 409, { error: err.message, code: err.code, hit: err.hit });
        // Mescla recusada (sem testes, teste vermelho, conflito): 409 com o motivo; `no-tests` dá para confirmar.
        if (err instanceof CodeError) return send(res, 409, { error: err.message, code: err.code });
        if (
          err instanceof BadRequest ||
          err instanceof StaffError ||
          err instanceof ChatError ||
          err instanceof TaskError ||
          err instanceof FileError ||
          err instanceof AgentError ||
          (err as NodeJS.ErrnoException | null)?.code === 'EEXIST'
        ) {
          const message = (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'já existe um arquivo com esse nome' : (err as Error).message;
          return send(res, err instanceof ChatError ? 409 : 400, { error: message });
        }
        console.error(err);
        return send(res, 500, { error: 'erro interno' });
      }
    }
    return send(res, 404, { error: 'rota desconhecida' });
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'método não permitido' });
  return serveStatic(url.pathname, res);
});

const STREAM_ROUTE = new RegExp(`^/api/chat/${ID}/stream$`);

/** SSE da conversa: repete o que veio depois de `after` e segue ao vivo enquanto o processo existir. */
function serveChatStream(sessionId: string, after: number, req: http.IncomingMessage, res: http.ServerResponse) {
  if (!chats.has(sessionId)) return send(res, 404, { error: 'conversa não está aberta' });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': ok\n\n');
  const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const unsubscribe = chats.subscribe(sessionId, Number.isFinite(after) ? after : 0, write);
  // O ping mantém a conexão viva atrás de proxies (o do Vite, em desenvolvimento).
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe?.();
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest('corpo grande demais');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('JSON inválido');
  }
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // ferramentas locais (curl, um funcionário) não mandam Origin
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function getBoard(): Promise<Board> {
  const [projects, user, live] = await Promise.all([
    adapter.listProjects(),
    adapter.getUserScope(),
    adapter.listLiveSessions(),
  ]);
  const inventories: Board['inventories'] = {};
  const sessions: Board['sessions'] = {};
  const images: Board['images'] = {};
  const [staffList] = await Promise.all([
    staff.listAll(projects),
    ...projects.map(async (p) => {
      const [inv, list, image] = await Promise.all([
        adapter.getProjectInventory(p.id),
        adapter.getProjectSessions(p.id),
        p.exists ? projectImageUrl(p.id, p.path) : null,
      ]);
      if (inv) inventories[p.id] = inv;
      if (list) sessions[p.id] = list;
      if (image) images[p.id] = image;
    }),
  ]);
  // Sessões de funcionário numa worktree própria contam como do projeto (onde está a ficha).
  const folded = projects.map((p) => ({ ...p }));
  for (const [child, parent] of mycoWorktreeParents(projects)) {
    const moved = sessions[child] ?? [];
    if (!moved.length) continue;
    sessions[parent] = [...(sessions[parent] ?? []), ...moved].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sessions[child] = [];
    const pp = folded.find((p) => p.id === parent);
    const cp = folded.find((p) => p.id === child);
    if (pp && cp) {
      pp.sessionCount += cp.sessionCount;
      cp.sessionCount = 0;
    }
  }
  return { projects: folded, inventories, sessions, staff: staffList, images, user, live };
}

const INBOX_ORDER: Record<InboxKind, number> = { plan: 0, permission: 1, secret: 2, waiting: 3, error: 4, routine: 5, orphan: 6 };

/**
 * Tudo que espera você, de todas as salas: planos prontos e permissões pendentes das conversas
 * no MyCo, sessões esperando resposta em outro lugar (app, terminal), conversas que pararam com
 * erro e processos órfãos de um reinício. Arquivados ficam de fora.
 */
async function getInbox(): Promise<InboxItem[]> {
  const [projects, live] = await Promise.all([adapter.listProjects(), adapter.listLiveSessions()]);
  const { where, hidden } = await sessionPlaces(projects);

  const out: InboxItem[] = [];
  const liveById = new Map(live.map((l) => [l.sessionId, l]));
  for (const { sessionId, pending, error } of chats.attention()) {
    const w = where(sessionId, liveById.get(sessionId));
    if (hidden(w)) continue;
    for (const p of pending) {
      const plan = p.plan !== undefined;
      out.push({ id: `perm:${p.id}`, kind: plan ? 'plan' : 'permission', ...w, summary: plan ? 'plano pronto para aprovar' : `${p.tool} ${p.summary}`, at: p.at });
    }
    if (error) out.push({ id: `error:${sessionId}`, kind: 'error', ...w, summary: error, at: null });
  }
  const orphans = await chats.orphans(live);
  const orphanIds = new Set(orphans.map((o) => o.sessionId));
  for (const o of orphans) {
    const w = where(o.sessionId, liveById.get(o.sessionId));
    if (!hidden(w)) out.push({ id: `orphan:${o.sessionId}`, kind: 'orphan', ...w, summary: 'processo de antes do reinício do MyCo: clique em Trazer', at: null });
  }
  const own = chats.ownPids();
  for (const l of live) {
    if (!l.alive || l.status !== 'waiting' || own.has(l.pid) || orphanIds.has(l.sessionId)) continue;
    const w = where(l.sessionId, l);
    if (hidden(w)) continue;
    const place = l.entrypoint === 'claude-desktop' ? 'no app do Claude' : l.entrypoint === 'sdk-cli' ? 'em outro programa' : 'num terminal';
    out.push({ id: `waiting:${l.sessionId}`, kind: 'waiting', ...w, summary: `esperando sua resposta ${place}`, at: l.statusUpdatedAt });
  }
  // Rotinas que não rodaram (trava de consumo, funcionário ocupado, sessão aberta em outro lugar).
  for (const a of routines.alerts()) {
    if (hidden({ projectId: a.projectId, staffId: a.staffId, sessionId: '' })) continue;
    out.push({
      id: `routine:${a.id}`,
      kind: 'routine',
      projectId: a.projectId,
      projectName: (await adapter.listProjects()).find((p) => p.id === a.projectId)?.name ?? '',
      sessionId: '',
      staffId: a.staffId,
      name: a.staffName,
      summary: `rotina "${a.routineName}" não rodou: ${a.text.replace(/^pulada: /, '')}`,
      at: a.at,
    });
  }
  // Segredos que apareceram nas conversas do MyCo (senha num comando, token colado…).
  for (const s of chats.secretHits()) {
    const w = where(s.sessionId, liveById.get(s.sessionId));
    if (!hidden(w)) out.push({ id: `secret:${s.id}`, kind: 'secret', ...w, summary: `${s.label} apareceu no chat: troque e não cole segredos na conversa`, at: s.at });
  }
  return out.sort((a, b) => INBOX_ORDER[a.kind] - INBOX_ORDER[b.kind] || (b.at ?? '').localeCompare(a.at ?? ''));
}

/** Turnos que terminaram desde `since`, com quem e onde (para o aviso "terminou"). */
async function getTurns(since: string | null): Promise<TurnNotice[]> {
  const done = turns.since(since);
  if (!done.length) return [];
  const [projects, live] = await Promise.all([adapter.listProjects(), adapter.listLiveSessions()]);
  const { where, hidden } = await sessionPlaces(projects);
  const liveById = new Map(live.map((l) => [l.sessionId, l]));
  return done.flatMap((d) => {
    const w = where(d.sessionId, liveById.get(d.sessionId));
    return hidden(w) ? [] : [{ id: d.id, ...w, text: d.text, at: d.at }];
  });
}

/** Dono (funcionário/projeto) e nome de cada sessão; `hidden` = arquivada (ou o projeto dela). */
async function sessionPlaces(projects: Project[]) {
  const config = await readConfig();
  const staffList = await staff.listAll(projects);
  const parents = mycoWorktreeParents(projects);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const byPath = new Map(projects.map((p) => [pathKey(p.path), p.id]));
  const owner = new Map<string, { projectId: string; staffId: string; name: string }>();
  for (const s of staffList) for (const ss of s.sessions) owner.set(ss.id, { projectId: s.projectId, staffId: s.id, name: s.name });
  const archived = new Set([...config.archived.sessions, ...config.archived.projects]);

  const where = (sessionId: string, l?: LiveSession) => {
    const own = owner.get(sessionId);
    let projectId = own?.projectId ?? (l?.cwd ? (byPath.get(pathKey(l.cwd)) ?? encodeProjectDir(l.cwd)) : '');
    projectId = parents.get(projectId) ?? projectId;
    return {
      projectId,
      projectName: projectName.get(projectId) ?? '',
      sessionId,
      staffId: own?.staffId ?? null,
      name: own?.name ?? l?.name?.trim() ?? `sessão ${sessionId.slice(0, 8)}`,
    };
  };
  const hidden = (w: { projectId: string; staffId: string | null; sessionId: string }) =>
    archived.has(w.projectId) || archived.has(w.sessionId) || (w.staffId !== null && archived.has(`staff:${w.staffId}`));
  return { where, hidden };
}

/** Worktrees criadas pelo MyCo (…/.claude/worktrees/myco-<ficha>) → id do projeto principal. */
function mycoWorktreeParents(projects: Project[]): Map<string, string> {
  const byPath = new Map(projects.map((p) => [pathKey(p.path), p.id]));
  const out = new Map<string, string>();
  for (const p of projects) {
    if (!p.worktreeOf || !path.basename(p.path).startsWith('myco-')) continue;
    const parent = byPath.get(pathKey(p.worktreeOf));
    if (parent) out.set(p.id, parent);
  }
  return out;
}

/** Custos: a mesma dobra do quadro (worktree do MyCo soma no projeto principal). */
async function getCosts(): Promise<CostReport> {
  const [report, projects] = await Promise.all([adapter.getCosts(), adapter.listProjects()]);
  const out: CostReport = { ...report, projects: { ...report.projects } };
  for (const [child, parent] of mycoWorktreeParents(projects)) {
    const c = out.projects[child];
    if (!c) continue;
    const p = out.projects[parent] ?? { usd: 0, today: 0, last7d: 0, month: 0, sessions: {} };
    out.projects[parent] = {
      usd: p.usd + c.usd,
      today: p.today + c.today,
      last7d: p.last7d + c.last7d,
      month: p.month + c.month,
      sessions: { ...p.sessions, ...c.sessions },
    };
    delete out.projects[child];
  }
  return out;
}

/** Pasta de agents do projeto ou do usuário. */
async function agentsDir(scope: string | null, projectId: string | null): Promise<string | null> {
  if (scope === 'user') return path.join(defaultLocations().home, 'agents');
  if (scope !== 'project' || !projectId) return null;
  const p = await projectById(projectId);
  return p ? path.join(p.path, '.claude', 'agents') : null;
}

async function projectById(id: string) {
  const p = (await adapter.listProjects()).find((x) => x.id === id);
  return p?.exists ? p : null;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const requested = path.resolve(CLIENT_DIR, '.' + decodeURIComponent(pathname));
  const inside = requested === CLIENT_DIR || requested.startsWith(CLIENT_DIR + path.sep);
  const file = inside && (await isFile(requested)) ? requested : path.join(CLIENT_DIR, 'index.html');
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Cliente não compilado. Use `npm run dev` ou `npm run build`.');
  }
}

async function isFile(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isFile()).catch(() => false);
}

server.listen(PORT, HOST, () => {
  console.log(`MyCo em http://myco.localhost:${PORT} (adaptador: ${adapter.id})`);
  // Só quem conseguiu a porta limpa: um segundo servidor que falhou não mexe nos processos do outro.
  chats.cleanOrphans().catch((err) => console.error('[chat] limpeza de órfãos falhou:', err));
  // Só o servidor que ficou com a porta agenda: um segundo que falhou não dispara rotinas em dobro.
  routines.start();
  // Configs de sessão antigas em ~/.myco/run (podem ter tokens de MCP): na subida e a cada 12 h.
  const cleanRun = () =>
    cleanRunDir(path.join(MYCO_HOME, 'run'))
      .then((n) => n && console.log(`[run] ${n} pasta(s) de sessão antiga(s) apagada(s) de ~/.myco/run`))
      .catch(() => {});
  void cleanRun();
  setInterval(cleanRun, 12 * 60 * 60_000).unref();
});
