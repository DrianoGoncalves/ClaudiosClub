import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project } from '../shared/model';
import { BUILTIN_ROLES } from '../shared/roles';
import { TEAM_TEMPLATES, teamTemplateById } from '../shared/teamTemplates';
import type { ToolAdapter } from '../server/adapters/types';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { SessionTokens } from '../server/callers';
import { gate } from '../server/gate';
import { legacyDemoPaths } from '../server/legacyDemo';
import { parseNewProject, ProjectError } from '../server/newProject';
import { Pairing } from '../server/pairing';
import { StaffBusyError, StaffError, StaffService, StaffTeamExistsError } from '../server/staff/service';
import { createProfile, fichaFile, hasStaffFiles, listProjectStaff, memoryFile, StaffInputSchema } from '../server/staff/store';
import { removeTemp, removeTempSync } from './support/tmp';

// A pasta do demo antigo é lida de MYCO_HOME: aponta para uma pasta temporária antes de os módulos carregarem.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-teamtpl-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
let seq = 0;
const projects = new Map<string, string>();

const project = (id: string, dir: string): Project => ({
  id,
  path: dir,
  name: id,
  exists: true,
  worktreeOf: null,
  hasClaudeMd: false,
  agentCount: 0,
  skillCount: 0,
  sessionCount: 0,
  lastActivityAt: null,
});

const adapter = () =>
  ({
    listProjects: async (): Promise<Project[]> => [...projects].map(([id, dir]) => project(id, dir)),
    getUserScope: async () => ({ agents: [], skills: [] }),
    getProjectInventory: async () => ({ agents: [], skills: [] }),
  }) as unknown as ToolAdapter;

const service = () => new StaffService(adapter(), { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, '.claude.json'), mycoUrl: 'x' });

/** Um projeto novo, numa pasta temporária própria, já no quadro (o adaptador falso o lista). */
async function newProjectDir(): Promise<{ id: string; dir: string }> {
  const id = `p${++seq}`;
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  projects.set(id, dir);
  return { id, dir };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-teamtpl-'));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => removeTemp(root, home));

describe('os modelos (shared/teamTemplates.ts)', () => {
  it('são dois, com a composição pedida e o orquestrador primeiro', () => {
    expect(TEAM_TEMPLATES.map((t) => [t.id, t.label])).toEqual([
      ['site-landing-page', 'Site / landing page'],
      ['manutencao-saas', 'Manutenção de SaaS'],
    ]);
    expect(teamTemplateById('site-landing-page')!.members.map((m) => m.roleId)).toEqual(['orquestrador', 'web-designer', 'frontend', 'trafego']);
    expect(teamTemplateById('manutencao-saas')!.members.map((m) => m.roleId)).toEqual(['orquestrador', 'desenvolvedor', 'frontend', 'testador', 'seguranca', 'infra']);
    expect(teamTemplateById('nao-existe')).toBeUndefined();
  });

  it('cada membro tem cargo pronto que existe, nome fixo único e só reporta a quem vem antes; um só orquestrador, na raiz', () => {
    for (const t of TEAM_TEMPLATES) {
      const seen = new Set<string>();
      for (const m of t.members) {
        expect(BUILTIN_ROLES.some((r) => r.id === m.roleId), `${t.id}/${m.key}: cargo ${m.roleId}`).toBe(true);
        expect(m.name.trim().length).toBeGreaterThan(0);
        for (const k of m.reportsTo) expect(seen.has(k), `${t.id}/${m.key} reporta a ${k}, que não vem antes`).toBe(true);
        expect(seen.has(m.key)).toBe(false);
        seen.add(m.key);
      }
      expect(new Set(t.members.map((m) => m.name)).size).toBe(t.members.length);
      expect(t.members.filter((m) => m.roleId === 'orquestrador')).toHaveLength(1);
      expect(t.members.filter((m) => m.reportsTo.length === 0).map((m) => m.roleId)).toEqual(['orquestrador']);
    }
  });
});

describe('aplicar o modelo num projeto sem equipe', () => {
  for (const template of TEAM_TEMPLATES) {
    it(`${template.label}: cria as fichas dos cargos, a hierarquia e mais nada`, async () => {
      const { id, dir } = await newProjectDir();
      const out = await service().applyTeamTemplate(id, { templateId: template.id }, true);
      expect(out?.templateId).toBe(template.id);

      const staff = await listProjectStaff(dir, id);
      // Na ordem do modelo, uma ficha por membro.
      expect(staff.map((s) => s.name)).toEqual(template.members.map((m) => m.name));
      expect(out!.staff.map((s) => s.id)).toEqual(staff.map((s) => s.id));
      const byName = new Map(staff.map((s) => [s.name, s]));
      const boss = byName.get(template.members[0]!.name)!;

      for (const m of template.members) {
        const p = byName.get(m.name)!;
        const role = BUILTIN_ROLES.find((r) => r.id === m.roleId)!;
        // Id no padrão da contratação (slug do nome + 4 hex), nunca "-demo".
        expect(p.id).toMatch(/^[a-z0-9]+-[0-9a-f]{4}$/);
        expect(p.id).not.toContain('demo');
        // A ficha sai do cargo pronto.
        expect(p).toMatchObject({ role: role.role, mission: role.mission, rules: role.rules, doneWhen: role.doneWhen, autonomy: role.autonomy, effort: role.effort, canHire: !!role.canHire });
        expect(p.model).toBe(role.model || null);
        expect(p.playbook ?? null).toBe(role.playbook ?? null);
        // Sem servidores, sem o Chrome do usuário, sem MCP nem conversa.
        expect(p).toMatchObject({ servers: [], browser: false, sessions: [], mcps: [], projectId: id });
        // Hierarquia: todos reportam ao orquestrador, que reporta ao usuário.
        expect(p.reportsTo).toEqual(m.reportsTo.length ? [boss.id] : []);
      }
      expect(boss.role).toBe('Orquestrador(a)');
      expect(out!.staff.find((s) => s.id === boss.id)!.reportsTo).toEqual([]);

      // A ficha (.md) e a memória de cada um existem; a do orquestrador já lista a equipe, as dos outros não.
      for (const p of staff) {
        await expect(fs.stat(fichaFile(dir, p.id))).resolves.toBeTruthy();
        await expect(fs.stat(memoryFile(dir, p.id))).resolves.toBeTruthy();
      }
      const bossFicha = await fs.readFile(fichaFile(dir, boss.id), 'utf8');
      expect(bossFicha).toContain('## Sua equipe');
      for (const p of staff.filter((s) => s.id !== boss.id)) {
        expect(bossFicha).toContain(`id \`${p.id}\``);
        expect(await fs.readFile(fichaFile(dir, p.id), 'utf8')).not.toContain('## Sua equipe');
      }

      // Nenhuma tarefa, nenhuma conversa: nada além das fichas foi criado.
      await expect(fs.stat(path.join(dir, '.myco', 'tasks.json'))).rejects.toThrow();
      const files = await fs.readdir(path.join(dir, '.myco', 'staff'));
      expect(files.filter((f) => !f.endsWith('.json') && !f.endsWith('.md'))).toEqual([]);
      expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(template.members.length);
      expect((await fs.readdir(path.join(dir, '.myco'))).filter((f) => /task/i.test(f))).toEqual([]);
    });
  }

  it('o mesmo modelo em dois projetos dá ids diferentes (nome fixo, id novo)', async () => {
    const a = await newProjectDir();
    const b = await newProjectDir();
    await service().applyTeamTemplate(a.id, { templateId: 'manutencao-saas' }, true);
    await service().applyTeamTemplate(b.id, { templateId: 'manutencao-saas' }, true);
    const [sa, sb] = [await listProjectStaff(a.dir, a.id), await listProjectStaff(b.dir, b.id)];
    expect(sa.map((s) => s.name)).toEqual(sb.map((s) => s.name));
    expect(sa.map((s) => s.id)).not.toEqual(sb.map((s) => s.id));
  });
});

describe('o que recusa', () => {
  it('projeto que já tem funcionário: 409 (StaffTeamExistsError, code team-exists) e nada é somado', async () => {
    const { id, dir } = await newProjectDir();
    await createProfile(dir, id, StaffInputSchema.parse({ name: 'Ana', role: 'Dev', mission: 'Programar' }));
    const err = await service().applyTeamTemplate(id, { templateId: 'site-landing-page' }, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffTeamExistsError);
    expect(err).toBeInstanceOf(StaffBusyError); // o 409 da rota
    expect((err as StaffTeamExistsError).code).toBe('team-exists');
    expect((await listProjectStaff(dir, id)).map((s) => s.name)).toEqual(['Ana']);
  });

  it('quem já saiu da equipe (ficha encerrada) também conta: nunca soma', async () => {
    const { id, dir } = await newProjectDir();
    const p = await createProfile(dir, id, StaffInputSchema.parse({ name: 'Bia', role: 'Dev', mission: 'Programar' }));
    const file = path.join(dir, '.myco', 'staff', `${p.id}.json`);
    await fs.writeFile(file, JSON.stringify({ ...p, ended: { at: new Date().toISOString(), by: 'you' } }, null, 2));
    await expect(service().applyTeamTemplate(id, { templateId: 'manutencao-saas' }, true)).rejects.toBeInstanceOf(StaffTeamExistsError);
    expect(await hasStaffFiles(dir)).toBe(true);
    expect(await listProjectStaff(dir, id)).toHaveLength(1);
  });

  it('aplicar duas vezes: a segunda é 409 e a equipe fica com o tamanho do modelo (um orquestrador só)', async () => {
    const { id, dir } = await newProjectDir();
    await service().applyTeamTemplate(id, { templateId: 'site-landing-page' }, true);
    await expect(service().applyTeamTemplate(id, { templateId: 'manutencao-saas' }, true)).rejects.toBeInstanceOf(StaffTeamExistsError);
    const staff = await listProjectStaff(dir, id);
    expect(staff).toHaveLength(4);
    expect(staff.filter((s) => s.role === 'Orquestrador(a)')).toHaveLength(1);
  });

  it('duas chamadas juntas: uma cria, a outra leva 409 (nada de dois orquestradores)', async () => {
    const { id, dir } = await newProjectDir();
    const results = await Promise.allSettled([
      service().applyTeamTemplate(id, { templateId: 'manutencao-saas' }, true),
      service().applyTeamTemplate(id, { templateId: 'manutencao-saas' }, true),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(lost.reason).toBeInstanceOf(StaffTeamExistsError);
    const staff = await listProjectStaff(dir, id);
    expect(staff).toHaveLength(6);
    expect(staff.filter((s) => s.role === 'Orquestrador(a)')).toHaveLength(1);
  });

  it('modelo desconhecido ou corpo inválido: StaffError (400) e nada é criado', async () => {
    const { id, dir } = await newProjectDir();
    for (const body of [{ templateId: 'nao-existe' }, { templateId: 'pizzaria' }, { templateId: '../x' }, { templateId: 'A'.repeat(80) }, { templateId: 7 }, {}, null, 'site-landing-page', []]) {
      const err = await service().applyTeamTemplate(id, body, true).catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(StaffError);
      expect(err, JSON.stringify(body)).not.toBeInstanceOf(StaffBusyError);
    }
    await expect(service().applyTeamTemplate(id, { templateId: 'nao-existe' }, true)).rejects.toThrow('modelo de equipe desconhecido');
    expect(await hasStaffFiles(dir)).toBe(false);
  });

  it('sem ser pela tela (funcionário pela API): recusa e nada é criado', async () => {
    const { id, dir } = await newProjectDir();
    await expect(service().applyTeamTemplate(id, { templateId: 'site-landing-page' }, false)).rejects.toThrow('só pelo Claudio’s Club');
    expect(await hasStaffFiles(dir)).toBe(false);
  });

  it('projeto que não está no quadro: null (404 na rota), sem criar nada', async () => {
    expect(await service().applyTeamTemplate('nao-esta-no-quadro', { templateId: 'site-landing-page' }, true)).toBeNull();
  });

  it('falha no meio: o que já foi criado sai de volta e dá para aplicar de novo', async () => {
    const { id, dir } = await newProjectDir();
    const spy = vi.spyOn(StaffService.prototype as unknown as { context: () => Promise<unknown> }, 'context').mockRejectedValueOnce(new Error('falha de teste'));
    await expect(service().applyTeamTemplate(id, { templateId: 'manutencao-saas' }, true)).rejects.toThrow('falha de teste');
    expect(spy).toHaveBeenCalled();
    expect(await hasStaffFiles(dir)).toBe(false);
    expect((await fs.readdir(path.join(dir, '.myco', 'staff'))).filter((f) => /\.(json|md)$/.test(f))).toEqual([]);
    const again = await service().applyTeamTemplate(id, { templateId: 'manutencao-saas' }, true);
    expect(again!.staff).toHaveLength(6);
  });
});

describe('Novo projeto com templateId', () => {
  const parent = path.join(os.tmpdir(), 'qualquer');

  it('aceita um modelo da lista, nos dois modos, e continua opcional', () => {
    expect(parseNewProject({ mode: 'create', parent, name: 'loja', templateId: 'manutencao-saas' })).toMatchObject({ templateId: 'manutencao-saas' });
    expect(parseNewProject({ mode: 'existing', path: parent, templateId: 'site-landing-page' })).toMatchObject({ templateId: 'site-landing-page' });
    expect(parseNewProject({ mode: 'create', parent, name: 'loja' }).templateId).toBeUndefined();
  });

  it('modelo desconhecido recusa antes de criar a pasta (ProjectError, 400)', () => {
    for (const templateId of ['nao-existe', '', '../x', 'A'.repeat(80)]) {
      expect(() => parseNewProject({ mode: 'create', parent, name: 'loja', templateId }), templateId).toThrow(ProjectError);
    }
    expect(() => parseNewProject({ mode: 'create', parent, name: 'loja', templateId: 3 })).toThrow(ProjectError);
  });
});

describe('a rota e o fim do demo', () => {
  const ROUTE = '/api/projects/p1/staff/template';
  const src = fsSync.readFileSync(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');

  it('POST só da tela: fora das listas de funcionário e da sandbox do Codex (apiPolicy.ts)', () => {
    expect(staffMayPost(ROUTE)).toBe(false);
    expect(sandboxVerdict('POST', ROUTE, 'p1')).toMatchObject({ status: 403 });
  });

  describe('pela porta de entrada de verdade (mesmos cabeçalhos das outras rotas)', () => {
    let dir: string;
    let srv: http.Server;
    let base: string;
    let pairing: Pairing;
    const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', 'claudio.localhost']);

    beforeAll(async () => {
      dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'myco-teamtpl-gate-'));
      pairing = new Pairing(path.join(dir, 'secrets', 'pairing.key'));
      srv = http.createServer((req, res) => {
        const g = gate(req, res, { pairing, tokens: new SessionTokens(), localHostnames: LOCAL, isLocalOrigin: (o) => !o || LOCAL.has(new URL(o).hostname), log: () => {} });
        if (!g) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ fromBrowser: g.fromBrowser }));
      });
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise((r) => srv.close(r));
      removeTempSync(dir);
    });

    const post = (headers: Record<string, string>): Promise<{ status: number; body: { error?: string; fromBrowser?: boolean } }> =>
      new Promise((resolve, reject) => {
        const req = http.request(`${base}${ROUTE}`, { method: 'POST', headers }, (res) => {
          let text = '';
          res.setEncoding('utf8').on('data', (d: string) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end('{"templateId":"site-landing-page"}');
      });

    it('sem x-myco: 403; Origin forjado sem cookie: 403; token inventado: 401; funcionário (x-myco, sem Origin) leva 400; só a tela pareada passa', async () => {
      expect((await post({})).status).toBe(403);
      expect((await post({ 'x-myco': '1', origin: 'http://localhost:4848' })).status).toBe(403);
      expect((await post({ 'x-myco': '1', 'x-myco-token': 'f'.repeat(64) })).status).toBe(401);
      expect(await post({ 'x-myco': '1' })).toEqual({ status: 400, body: { error: 'só pelo Claudio’s Club' } });
      const tela = await post({ 'x-myco': '1', origin: 'http://localhost:4848', cookie: pairing.setCookieHeader().split(';')[0]! });
      expect(tela).toEqual({ status: 200, body: { fromBrowser: true } });
    });
  });

  it('o index.ts registra a rota antes da edição de ficha, mapeia o 409 com code, e a de Novo projeto aplica o modelo na mesma chamada', () => {
    const route = src.indexOf("new RegExp(`^/api/projects/${ID}/staff/template$`)");
    const edit = src.indexOf("new RegExp(`^/api/projects/${ID}/staff/${ID}$`)");
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(edit);
    expect(src).toMatch(/'POST', new RegExp\(`\^\/api\/projects\/\$\{ID\}\/staff\/template\$`\), \(\{ params: \[id\], body, fromBrowser \}\) => staff\.applyTeamTemplate\(id!, body, fromBrowser\)/);
    expect(src).toContain("if (err instanceof StaffTeamExistsError) return send(res, 409, { error: err.message, code: err.code });");
    // Novo projeto: pasta que já existe e já tem equipe recusa antes de abrir; o modelo entra depois de o projeto estar no quadro.
    const handler = /\/\^\\\/api\\\/new-project\$\/,\n\s*async \(\{ body, fromBrowser \}\) => \{([\s\S]*?)\n    \},\n  \],/.exec(src)![1]!;
    expect(handler).toContain("input.templateId && input.mode === 'existing' && (await hasStaffFiles(path.resolve(input.path)))) throw new StaffTeamExistsError()");
    expect(handler.indexOf('hasStaffFiles')).toBeLessThan(handler.indexOf('openProject(input)'));
    expect(handler.indexOf('openProject(input)')).toBeLessThan(handler.indexOf('staff.applyTeamTemplate(project.id'));
    expect(handler).toContain('...(team && { team })');
  });

  it('o demo saiu: sem server/demo.ts, sem a rota /api/demo, sem demo/ no repositório', () => {
    const rootDir = path.join(__dirname, '..');
    expect(fsSync.existsSync(path.join(rootDir, 'server', 'demo.ts'))).toBe(false);
    expect(fsSync.existsSync(path.join(rootDir, 'demo'))).toBe(false);
    expect(fsSync.existsSync(path.join(rootDir, 'tests', 'demo.test.ts'))).toBe(false);
    expect(src).not.toMatch(/api\\\/demo|createDemo|\.\/demo'/);
    expect(fsSync.readFileSync(path.join(rootDir, 'scripts', 'bundle.ts'), 'utf8')).not.toMatch(/demo/i);
  });

  it('o demo que o usuário já tem continua fixado no quadro e nada é apagado nem criado', async () => {
    expect(await legacyDemoPaths()).toEqual([]); // sem pasta, nada fixado e nada criado
    expect(fsSync.existsSync(path.join(home, 'demo'))).toBe(false);

    const atual = path.join(home, 'demo', 'my-co');
    const antigo = path.join(home, 'demo', 'cafe-demo');
    await fs.mkdir(path.join(atual, '.myco', 'staff'), { recursive: true });
    await fs.writeFile(path.join(atual, 'meu-arquivo.txt'), 'do usuário');
    expect(await legacyDemoPaths()).toEqual([atual]);
    await fs.mkdir(antigo, { recursive: true });
    expect(await legacyDemoPaths()).toEqual([atual, antigo]);
    expect(await fs.readFile(path.join(atual, 'meu-arquivo.txt'), 'utf8')).toBe('do usuário');
  });
});
