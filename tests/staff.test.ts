import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUsage, Project, StaffProfile } from '../shared/model';
import { usageStopHit, UsageStopError } from '../server/usageStop';
import { ensureWorktree, worktreeFor } from '../server/staff/worktree';
import { listServers } from '../server/staff/servers';
import { execFileSync } from 'node:child_process';
import type { ToolAdapter } from '../server/adapters/types';
import {
  buildClaudeArgs,
  capAutonomy,
  renderFicha,
  systemPrompt,
  sanitizeArg,
  secretDenyRules,
  slugify,
  tabTitleSnippet,
  toCmdLine,
  type FichaContext,
} from '../server/staff/ficha';
import { cmdScript } from '../server/staff/launch';
import { buildMcpConfig, listMcpServers } from '../server/staff/mcp';
import { StaffError, StaffService } from '../server/staff/service';

const profile = (over: Partial<StaffProfile> = {}): StaffProfile => ({
  id: 'ana-1a2b',
  projectId: 'p',
  name: 'Ana "Revisora" Souza',
  role: 'Revisora 100%',
  portrait: null,
  reportsTo: [],
  mission: 'Revisar mudanças',
  firstTask: 'Revise o último commit',
  autonomy: 'plan',
  agents: ['Explore'],
  skills: [],
  mcps: null,
  knowledge: ['docs/arq.md'],
  rules: ['Não altere arquivos'],
  doneWhen: 'Lista de achados',
  model: 'opus',
  effort: 'high',
  canHire: false,
  usageStop: null,
  playbook: null,
  worktree: false,
  servers: [],
  browser: false,
  sessions: [],
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  ...over,
});

const ctx: FichaContext = {
  company: 'Acme & Cia',
  projectName: 'painel',
  projectPath: 'C:\\www\\painel',
  managerNames: [],
  fichaPath: '.myco\\staff\\ana-1a2b.md',
  memoryPath: '.myco\\staff\\ana-1a2b.memory.md',
  mycoUrl: 'http://127.0.0.1:4848',
};

describe('ficha', () => {
  it('gestor: a equipe dele, com o caminho para passar tarefa, e o roteiro manda o que é da área para a pessoa', () => {
    const team = [
      { id: 'luana-0d88', name: 'Luana', role: 'Design system', mission: 'Cuidar do design system. E de mais coisas.' },
      { id: 'raquel-1', name: 'Raquel', role: 'Infra', mission: 'Servidores.', temporary: true },
    ];
    const md = renderFicha(profile({ projectId: 'proj-x', playbook: 'plan-big-execute-small' }), { ...ctx, team });
    expect(md).toContain('## Sua equipe');
    expect(md).toContain('- Luana (Design system), id `luana-0d88`: Cuidar do design system.');
    expect(md).toContain('- Raquel (Infra, temporário)');
    expect(md).toContain('POST http://127.0.0.1:4848/api/projects/proj-x/tasks');
    expect(md).toContain('requestedBy: "ana-1a2b"');
    expect(md).toContain('Antes de chamar o executor (ou de fazer você mesmo): se a tarefa é da área de alguém da sua equipe');
    // O que é da área não fica com o gestor, ele repassa sem pesquisar o código e confere na medida do risco.
    expect(md).toContain('nem para o executor nem para você');
    expect(md).toContain('Repasse sem pesquisar');
    expect(md).toContain('Confira na medida do risco');
    // Sem equipe, nada disso.
    const solo = renderFicha(profile({ playbook: 'plan-big-execute-small' }), ctx);
    expect(solo).not.toContain('Sua equipe');
    // Quem reporta a alguém entrega com as provas; quem não reporta, não tem a seção.
    expect(renderFicha(profile(), { ...ctx, managerNames: ['Daniel'] })).toContain('## Entrega');
    expect(solo).not.toContain('## Entrega');
  });

  it('tem missão, autonomia, regras, memória e a seção de contratação', () => {
    const md = renderFicha(profile(), ctx);
    for (const part of ['## Missão', 'Revisar mudanças', '## Primeira tarefa', 'Só lê e planeja', '- Não altere arquivos', '## Memória', 'ana-1a2b.memory.md', 'substitua o que ficou velho', '`[MyCo:ponto-de-corte]`', 'não pode contratar']) {
      expect(md).toContain(part);
    }
    const hiring = renderFicha(profile({ canHire: true, projectId: 'proj-x' }), ctx);
    expect(hiring).toContain('/api/projects/proj-x/staff com');
    expect(hiring).toContain('reportsTo: ["ana-1a2b"]');
    expect(hiring).toMatch(/use subagents[\s\S]*só para um papel contínuo/);
    expect(hiring).toContain('/api/projects/proj-x/staff/<id dele>/done');
    // O próprio temporário sabe que é temporário.
    expect(renderFicha(profile({ temporary: true }), ctx)).toContain('Você é temporário');
    expect(md).not.toContain('Você é temporário');
  });

  it('prompt de sistema: identidade, onde fica a memória e a ficha inteira (vai por arquivo)', () => {
    const ficha = renderFicha(profile(), ctx);
    const sys = systemPrompt(profile(), ctx, ficha);
    // Por arquivo, nada é cortado (aspas e % não passam pela linha de comando).
    expect(sys).toMatch(/^Você é Ana "Revisora" Souza, Revisora 100%/);
    expect(sys).toContain('.myco\\staff\\ana-1a2b.memory.md');
    expect(sys).toContain('releia .myco\\staff\\ana-1a2b.md');
    expect(sys).toContain(ficha.trim());
    expect(sanitizeArg('a "b"\n%c% & d')).toBe('a b c d');
  });

  it('argumentos: prompt primeiro; sessão nova com --session-id; MCP só quando restrito', () => {
    const args = buildClaudeArgs(profile(), { sessionId: 'uuid-1', resume: false, systemPromptFile: 'C:\\run\\system.md', mcpConfigPath: null, firstPrompt: 'Olá' });
    expect(args[0]).toBe('Olá');
    expect(args).toEqual([
      'Olá', '--session-id', 'uuid-1', '--name', 'Ana Revisora Souza - Revisora 100',
      '--append-system-prompt-file', 'C:\\run\\system.md', '--exclude-dynamic-system-prompt-sections',
      '--permission-mode', 'plan', '--model', 'opus', '--effort', 'high',
      '--no-chrome', '--disallowedTools', secretDenyRules(profile()).join(','),
    ]);
    const withChrome = buildClaudeArgs(profile({ browser: true }), { sessionId: 'u', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null });
    expect(withChrome).toContain('--chrome');
    expect(withChrome).not.toContain('--no-chrome');
    expect(renderFicha(profile({ browser: true }), ctx)).toContain('## Navegador');
    expect(renderFicha(profile(), ctx)).not.toContain('## Navegador');
    // O nome dele no título das abas que usa (o grupo de abas da extensão não dá para renomear).
    const p = profile({ browser: true });
    expect(renderFicha(p, ctx)).toContain(tabTitleSnippet(p.name));
    expect(tabTitleSnippet('Ana "Dev"')).toContain(JSON.stringify('[Ana "Dev"] '));
    const resumed = buildClaudeArgs(profile(), { sessionId: 'uuid-1', resume: true, systemPromptFile: 'S', mcpConfigPath: 'C:\\m.json', firstPrompt: 'Olá' });
    expect(resumed.slice(0, 2)).toEqual(['--resume', 'uuid-1']);
    expect(resumed.slice(-3)).toEqual(['--mcp-config', 'C:\\m.json', '--strict-mcp-config']);
    expect(toCmdLine('claude', ['Olá', '--model', 'opus'])).toBe('claude "Olá" --model "opus"');
  });

  it('subfuncionário não passa da autonomia do gestor', () => {
    expect(capAutonomy('auto', 'acceptEdits')).toBe('acceptEdits');
    expect(capAutonomy('plan', 'auto')).toBe('plan');
    // "Sem travas" só passa para baixo se o gestor também for sem travas.
    expect(capAutonomy('bypassPermissions', 'auto')).toBe('auto');
    expect(capAutonomy('bypassPermissions', 'bypassPermissions')).toBe('bypassPermissions');
  });

  it('slug sem acentos e script do cmd em CRLF com UTF-8', () => {
    expect(slugify('João da Silva!')).toBe('joao-da-silva');
    const script = cmdScript('T', 'C:\\www\\a b', 'claude "x"');
    expect(script).toContain('chcp 65001');
    expect(script).toContain('cd /d "C:\\www\\a b"\r\nclaude "x"');
    expect(script).toContain('set CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1');
    expect(script).toMatch(/if errorlevel 1 \([\s\S]*pause >nul\r\n\)\r\nexit/);
  });
});

let root: string;
let projectPath: string;
let claudeJson: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-staff-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(
    path.join(projectPath, '.mcp.json'),
    JSON.stringify({ mcpServers: { db: { command: 'db-mcp', env: { DB_PASS: 'SEGREDO-PROJ' } }, docs: { type: 'http', url: 'https://x' } } }),
  );
  claudeJson = path.join(root, '.claude.json');
  await fs.writeFile(
    claudeJson,
    JSON.stringify({
      oauthAccount: { emailAddress: 'nao@vaza' },
      mcpServers: { n8n: { type: 'http', url: 'https://n8n', headers: { Authorization: 'SEGREDO-USER' } } },
      projects: { [projectPath.replaceAll('\\', '/')]: { mcpServers: { db: { command: 'db-local', env: { DB_PASS: 'SEGREDO-LOCAL' } } } } },
    }),
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('infra: servidores por SSH', () => {
  it('lista só as conexões completas do projeto, sem usuário nem chave (o ~/.ssh/config fica de fora)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-srv-'));
    const key = path.join(dir, 'chave');
    await fs.writeFile(key, 'x');
    await fs.mkdir(path.join(dir, 'proj', '.vps'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'proj', '.vps', 'config.json'),
      JSON.stringify({
        connections: {
          prod: { host: 'vps-a.example.com', user: 'deploy', identityFile: key, remoteRoot: '/var/www/app' },
          apelido: { host: 'VPS' },
          'mal nome': { host: 'x' },
        },
      }),
    );
    const list = await listServers(path.join(dir, 'proj'));
    expect(list).toEqual([{ name: 'prod', source: 'vps', host: 'vps-a.example.com', remoteRoot: '/var/www/app' }]);
    expect(JSON.stringify(list)).not.toMatch(/chave|deploy|identity/i);
  });

  it('a ficha traz as conexões e as regras; a linha de comando bloqueia chaves e .env', () => {
    const p = profile({ servers: ['prod', 'sumiu'] });
    const md = renderFicha(p, { ...ctx, servers: [{ name: 'prod', source: 'vps', host: 'vps-a', remoteRoot: '/var/www/app' }] });
    for (const part of ['## Servidores', '- `prod`: vps-a', '/var/www/app', 'ssh -F "', '.vps/ssh_config" <conexão>', 'não existe mais no projeto', 'Nunca, sem pedir antes']) {
      expect(md).toContain(part);
    }
    expect(md).not.toContain('skill `vps`');
    expect(renderFicha({ ...p, skills: ['vps'] }, ctx)).toContain('skill `vps`');
    expect(renderFicha(profile(), ctx)).not.toContain('## Servidores');
    // O workspace do projeto entra como contexto, sem tomar o lugar da empresa.
    expect(renderFicha(profile(), { ...ctx, workspace: 'Cliente X' })).toContain('Empresa: Acme & Cia. Workspace: Cliente X.');
    expect(renderFicha(profile(), ctx)).not.toContain('Workspace:');
    const args = buildClaudeArgs(p, { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null, keyFiles: ['C:\\chaves\\ia', 'C:/com espaço/k'] });
    const deny = args[args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(deny).toEqual(expect.arrayContaining(['Read(~/.ssh/**)', 'Read(**/.env)', 'Read(**/.vps/**)', 'Read(//c/chaves/ia)']));
    expect(deny.join(',')).not.toContain('espaço');
    // Com servidor, o ssh fica liberado (só as conexões dele estão no ssh_config).
    expect(deny).not.toContain('Bash(ssh:*)');
  });

  it('sem servidor na ficha: nada de ssh, scp, sftp ou rsync, no Bash nem no PowerShell', () => {
    const deny = secretDenyRules(profile());
    expect(deny).toEqual(expect.arrayContaining(['Bash(ssh:*)', 'PowerShell(ssh:*)', 'Bash(scp:*)', 'PowerShell(scp.exe:*)', 'Bash(rsync:*)', 'Edit(**/.vps/**)']));
    expect(deny).not.toContain('Read(**/.env)');
  });
});

describe('linha de parada do consumo', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const usage = (fiveHour: number, sevenDay: number, resetsAt = '2026-10-26T14:00:00Z'): AccountUsage => ({
    tapInstalled: true,
    updatedAt: '2026-10-26T11:59:00Z',
    limits: [
      { kind: 'five_hour', percentUsed: fiveHour, resetsAt },
      { kind: 'seven_day', percentUsed: sevenDay, resetsAt: '2026-10-30T00:00:00Z' },
    ],
  });
  const company = { fiveHour: 90, sevenDay: 95 };

  it('para no primeiro limite que passou da linha', () => {
    expect(usageStopHit(usage(50, 50), company, null, now)).toBeNull();
    expect(usageStopHit(usage(90, 50), company, null, now)).toMatchObject({ kind: 'five_hour', limit: 90, fromProfile: false });
    expect(usageStopHit(usage(10, 96), company, null, now)).toMatchObject({ kind: 'seven_day', limit: 95 });
  });

  it('a ficha manda nos limites que define; null na empresa = sem trava', () => {
    expect(usageStopHit(usage(80, 10), company, { fiveHour: 70, sevenDay: null }, now)).toMatchObject({ limit: 70, fromProfile: true });
    expect(usageStopHit(usage(92, 10), company, { fiveHour: 99, sevenDay: null }, now)).toBeNull();
    expect(usageStopHit(usage(100, 100), { fiveHour: null, sevenDay: null }, null, now)).toBeNull();
  });

  it('ignora leitura de uma janela que já renovou', () => {
    expect(usageStopHit(usage(99, 10, '2026-10-26T11:00:00Z'), company, null, now)).toBeNull();
  });
});

describe('MCPs', () => {
  it('lista nomes e origem sem configuração; o local vence o do projeto', async () => {
    const list = await listMcpServers(projectPath, claudeJson);
    expect(list).toEqual([
      { name: 'db', source: 'local', transport: 'stdio' },
      { name: 'docs', source: 'project', transport: 'http' },
      { name: 'n8n', source: 'user', transport: 'http' },
    ]);
    expect(JSON.stringify(list)).not.toContain('SEGREDO');
  });

  it('monta a config só com os escolhidos', async () => {
    const cfg = await buildMcpConfig(projectPath, ['db', 'inexistente'], claudeJson);
    expect(Object.keys(cfg.mcpServers)).toEqual(['db']);
    expect(cfg.mcpServers.db).toMatchObject({ command: 'db-local' });
  });
});

describe('StaffService', () => {
  const project = (): Project => ({
    id: 'proj-id',
    path: projectPath,
    name: 'proj',
    exists: true,
    worktreeOf: null,
    hasClaudeMd: false,
    agentCount: 0,
    skillCount: 0,
    sessionCount: 0,
    lastActivityAt: null,
  });
  const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
  const opened: string[] = [];
  const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
  const service = (readUsage = noUsage) =>
    new StaffService(adapter, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'http://127.0.0.1:4848',
      open: (script) => opened.push(script),
      readUsage,
    });

  const input = { name: 'Bia', role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', mcps: ['docs'], launch: true };

  it('contrata pelo navegador: grava ficha, memória, script e abre a sessão', async () => {
    const r = await service().hire('proj-id', input, true);
    expect(r?.launch?.ok).toBe(true);
    const p = r!.profile;
    expect(p.id).toMatch(/^bia-[0-9a-f]{4}$/);
    expect(p.sessions).toHaveLength(1);

    const dir = path.join(projectPath, '.myco', 'staff');
    const ficha = await fs.readFile(path.join(dir, `${p.id}.md`), 'utf8');
    expect(ficha).toContain('# Ficha de Bia — Dev');
    expect(await fs.readFile(path.join(dir, `${p.id}.memory.md`), 'utf8')).toContain('Memória de Bia');

    const sid = p.sessions[0]!.id;
    expect(opened.at(-1)).toBe(path.join(root, 'run', sid, 'start.cmd'));
    const script = await fs.readFile(opened.at(-1)!, 'utf8');
    expect(script).toContain(`--session-id "${sid}"`);
    expect(script).toContain('--permission-mode "acceptEdits"');
    expect(script).toContain('--strict-mcp-config');
    // A config de MCP (com possíveis segredos) fica fora do projeto, só com o escolhido.
    const mcp = JSON.parse(await fs.readFile(path.join(root, 'run', sid, 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['docs']);
  });

  it('chamar de volta usa --resume na mesma sessão, sem duplicar', async () => {
    const svc = service();
    const { profile: p } = (await svc.hire('proj-id', { ...input, name: 'Caio' }, true))!;
    const r = await svc.launch('proj-id', p.id, true);
    expect(r?.sessionId).toBe(p.sessions[0]!.id);
    const script = await fs.readFile(opened.at(-1)!, 'utf8');
    expect(script).toContain(`--resume "${p.sessions[0]!.id}"`);
    const list = await svc.listAll([project()]);
    expect(list.find((s) => s.id === p.id)?.sessions).toHaveLength(1);
  });

  it('pela API (sem navegador), só um gestor que pode contratar, e com a autonomia dele no máximo', async () => {
    const svc = service();
    await expect(svc.hire('proj-id', { ...input, name: 'Solto', launch: false }, false)).rejects.toBeInstanceOf(StaffError);

    const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Chefe', autonomy: 'acceptEdits', canHire: true, launch: false }, true))!;
    // Contratado sem sessão: a ficha já fica no projeto.
    expect(await fs.readFile(path.join(projectPath, '.myco', 'staff', `${boss.id}.md`), 'utf8')).toContain('Para contratar: POST');
    // Pela API chega como texto (formato antigo): vira lista.
    const r = await svc.hire('proj-id', { ...input, name: 'Sub', autonomy: 'auto', canHire: true, reportsTo: boss.id, launch: false, servers: ['prod'] }, false);
    expect(r?.profile).toMatchObject({ reportsTo: [boss.id], autonomy: 'acceptEdits', canHire: false, servers: [], hiredBy: boss.id, temporary: true });
    // Só o gestor passa tarefa (pela API) para quem reporta a ele.
    expect(await svc.isManagerOf('proj-id', boss.id, r!.profile.id)).toBe(true);
    expect(await svc.isManagerOf('proj-id', r!.profile.id, boss.id)).toBe(false);
    expect(await svc.isManagerOf('proj-id', 'ninguem', r!.profile.id)).toBe(false);
  });

  it('temporário: abre numa conversa do Claudio’s Club, o gestor encerra, você efetiva; parado há dias sai sozinho', async () => {
    const archived = new Set<string>();
    const chats: Array<{ staffId: string; text: string }> = [];
    const working = new Set<string>();
    const sessions: Array<{ id: string; updatedAt: string }> = [];
    const adapterTemp = { listProjects: async () => [project()], getProjectSessions: async () => sessions } as unknown as ToolAdapter;
    const svc = new StaffService(adapterTemp, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'x',
      open: (s) => opened.push(s),
      readUsage: noUsage,
      openChat: async (_p, staffId, text) => (chats.push({ staffId, text }), 'conversa-1'),
      isWorking: (id) => working.has(id),
      archive: { has: async (k) => archived.has(k), set: async (k, v) => void (v ? archived.add(k) : archived.delete(k)) },
    });
    const { profile: boss } = (await svc.hire('proj-id', { ...input, name: 'Gestora', canHire: true, launch: false }, true))!;
    const before = opened.length;
    const r = (await svc.hire('proj-id', { ...input, name: 'Temp', firstTask: 'Mapear as rotas', reportsTo: [boss.id], launch: true }, false))!;
    expect(r.launch).toEqual({ ok: true, sessionId: 'conversa-1', command: '', error: null });
    expect(opened).toHaveLength(before); // nada de terminal
    expect(chats).toEqual([{ staffId: r.profile.id, text: 'Olá, Temp. Leia sua memória e comece pela primeira tarefa da ficha.' }]);

    // Você não é encerrado por outro; o temporário é.
    await expect(svc.end('proj-id', boss.id, 'x')).rejects.toThrow(/não é temporário/);
    const ended = (await svc.end('proj-id', r.profile.id, 'entregou o mapa'))!;
    expect(ended.ended).toMatchObject({ reason: 'entregou o mapa' });
    expect(archived.has(`staff:${r.profile.id}`)).toBe(true);
    // Efetivar: volta ao quadro e deixa de ser temporário.
    expect(await svc.keep('proj-id', r.profile.id)).toMatchObject({ temporary: false, ended: null });
    expect(archived.has(`staff:${r.profile.id}`)).toBe(false);

    // Parado há dias: sai sozinho; trabalhando ou com conversa recente, fica.
    const { profile: idle } = (await svc.hire('proj-id', { ...input, name: 'Parado', reportsTo: [boss.id], launch: false }, false))!;
    const in4days = new Date(Date.now() + 4 * 86_400_000);
    // (O projeto dos testes tem outros temporários: olha só para este.)
    const sweep = async (when: Date) => (await svc.sweepTemporaries(when)).filter((s) => s.id === idle.id).map((s) => s.ended?.reason);
    working.add(idle.id);
    expect(await sweep(in4days)).toEqual([]);
    working.delete(idle.id);
    expect(await sweep(new Date(Date.now() + 86_400_000))).toEqual([]);
    expect(await sweep(in4days)).toEqual(['parado há 4 dias']);
    // Restaurado: os dias recomeçam a contar.
    archived.delete(`staff:${idle.id}`);
    await svc.restored(idle.id);
    expect(await sweep(new Date(Date.now() + 2 * 86_400_000))).toEqual([]);
  });

  it('edita a ficha guardando a versão anterior, restaura, e não aceita ciclo de gestores', async () => {
    const svc = service();
    const { profile: a } = (await svc.hire('proj-id', { ...input, name: 'Ana', launch: false }, true))!;
    const { profile: b } = (await svc.hire('proj-id', { ...input, name: 'Beto', reportsTo: [a.id], launch: false }, true))!;
    const { id: _i, projectId: _p, portrait: _pt, sessions: _s, createdAt: _c, updatedAt: _u, ...fields } = a;

    const edited = await svc.update('proj-id', a.id, { ...fields, role: 'Tech lead', mission: 'Liderar' });
    expect(edited).toMatchObject({ role: 'Tech lead', mission: 'Liderar', createdAt: a.createdAt });
    expect(await fs.readFile(path.join(projectPath, '.myco', 'staff', `${a.id}.md`), 'utf8')).toContain('Liderar');

    const versions = (await svc.versions('proj-id', a.id))!;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ role: 'Dev' });
    const restored = await svc.restore('proj-id', a.id, versions[0]!.version);
    expect(restored).toMatchObject({ role: 'Dev', mission: 'Implementar' });

    // Ana chefiar a si mesma, ou passar a reportar a um subordinado dela: recusado.
    await expect(svc.update('proj-id', a.id, { ...fields, reportsTo: [a.id] })).rejects.toThrow('si mesmo');
    await expect(svc.update('proj-id', a.id, { ...fields, reportsTo: [b.id] })).rejects.toThrow('ciclo');
  });

  it('dá ficha a um funcionário criado fora do Claudio’s Club, sem abrir outra sessão', async () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const adapterWithSession = {
      listProjects: async () => [project()],
      getProjectSessions: async () => [{ id: sid, title: 'Sessão solta', startedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }],
    } as unknown as ToolAdapter;
    const svc = new StaffService(adapterWithSession, { runDir: path.join(root, 'run'), claudeConfigFile: claudeJson, mycoUrl: 'x', open: (s) => opened.push(s) });
    const before = opened.length;

    const r = await svc.hire('proj-id', { name: 'Gil', role: 'Dev', mission: 'Continuar', adoptSessionId: sid, launch: true }, true);
    expect(r?.launch).toBeNull();
    expect(opened.length).toBe(before); // não abriu terminal
    expect(r?.profile.sessions).toEqual([{ id: sid, startedAt: '2026-10-01T00:00:00.000Z' }]);

    await expect(svc.hire('proj-id', { name: 'Outro', role: 'Dev', mission: 'x', adoptSessionId: sid }, true)).rejects.toThrow('já é de Gil');
    await expect(
      svc.hire('proj-id', { name: 'X', role: 'Dev', mission: 'x', adoptSessionId: '99999999-2222-4333-8444-555555555555' }, true),
    ).rejects.toThrow('sessão não encontrada');
  });

  it('acrescenta um segundo gestor (arrastar o + até outro funcionário)', async () => {
    const svc = service();
    const { profile: a } = (await svc.hire('proj-id', { ...input, name: 'Duda', launch: false }, true))!;
    const { profile: c } = (await svc.hire('proj-id', { ...input, name: 'Eva', launch: false }, true))!;
    const { profile: x } = (await svc.hire('proj-id', { ...input, name: 'Fred', reportsTo: [a.id], launch: false }, true))!;
    const linked = await svc.addManager('proj-id', x.id, c.id);
    expect(linked?.reportsTo).toEqual([a.id, c.id]);
    expect((await svc.addManager('proj-id', x.id, c.id))?.reportsTo).toEqual([a.id, c.id]);
  });

  it('desfaz o vínculo com um gestor (botão na linha do quadro), com volta pelo histórico', async () => {
    const svc = service();
    const { profile: a } = (await svc.hire('proj-id', { ...input, name: 'Gui', launch: false }, true))!;
    const { profile: c } = (await svc.hire('proj-id', { ...input, name: 'Hana', launch: false }, true))!;
    const { profile: x } = (await svc.hire('proj-id', { ...input, name: 'Ivo', reportsTo: [a.id, c.id], launch: false }, true))!;
    expect((await svc.removeManager('proj-id', x.id, a.id))?.reportsTo).toEqual([c.id]);
    // Sem vínculo, nada muda; sem gestores, passa a reportar a você.
    expect((await svc.removeManager('proj-id', x.id, a.id))?.reportsTo).toEqual([c.id]);
    expect((await svc.removeManager('proj-id', x.id, c.id))?.reportsTo).toEqual([]);
    expect((await svc.versions('proj-id', x.id))?.length).toBe(2);
  });

  it('trava de consumo: recusa abrir acima da linha, a menos que confirmado', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const high = async (): Promise<AccountUsage> => ({
      tapInstalled: true,
      updatedAt: future,
      limits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: future }],
    });
    const svc = service(high);
    await expect(svc.hire('proj-id', { ...input, name: 'Gui' }, true)).rejects.toBeInstanceOf(UsageStopError);
    // A ficha pode subir a própria linha; pela API (sem navegador) não há como confirmar.
    const { profile: p } = (await svc.hire('proj-id', { ...input, name: 'Hel', launch: false }, true))!;
    await expect(svc.launch('proj-id', p.id, false)).rejects.toThrow('linha de parada: 90%');
    expect((await svc.launch('proj-id', p.id, false, true))?.ok).toBe(true);
    const r = await svc.hire('proj-id', { ...input, name: 'Ivo', usageStop: { fiveHour: 99, sevenDay: null } }, true);
    expect(r?.launch?.ok).toBe(true);
  });

  it('worktree própria: sessão nova roda nela, lê a ficha por --add-dir e retoma na mesma pasta', async () => {
    const created: string[] = [];
    const svc = new StaffService(adapter, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: claudeJson,
      mycoUrl: 'x',
      open: (s) => opened.push(s),
      readUsage: noUsage,
      ensureWorktree: async (projectPath, staffId) => {
        created.push(staffId);
        return worktreeFor(projectPath, staffId);
      },
    });
    const r = (await svc.hire('proj-id', { ...input, name: 'Wal', worktree: true, playbook: 'review-gate' }, true))!;
    const wt = worktreeFor(projectPath, r.profile.id);
    expect(created).toEqual([r.profile.id]);
    expect(r.profile.sessions[0]!.cwd).toBe(wt.path);
    const script = await fs.readFile(opened.at(-1)!, 'utf8');
    expect(script).toContain(`cd /d "${wt.path}"`);
    expect(script).toContain(`--add-dir "${path.join(projectPath, '.myco', 'staff')}"`);
    const ficha = await fs.readFile(path.join(projectPath, '.myco', 'staff', `${r.profile.id}.md`), 'utf8');
    expect(ficha).toContain('## Worktree própria');
    expect(ficha).toContain(`myco/${r.profile.id}`);
    expect(ficha).toContain('## Roteiro: Portão de revisão');

    const spawn = await svc.chatSpawn('proj-id', r.profile.sessions[0]!.id, r.profile.id);
    expect(spawn?.cwd).toBe(wt.path);
  });

  it('worktree: recusa projeto sem git, cria uma vez e reaproveita', async () => {
    const plain = path.join(root, 'sem-git');
    await fs.mkdir(plain, { recursive: true });
    await expect(ensureWorktree(plain, 'x-1')).rejects.toThrow('não é um repositório git');

    const repo = path.join(root, 'com-git');
    await fs.mkdir(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q');
    await fs.writeFile(path.join(repo, 'a.txt'), 'a');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    const wt = await ensureWorktree(repo, 'ana-1');
    expect(await fs.readFile(path.join(wt.path, 'a.txt'), 'utf8')).toBe('a');
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).not.toBe('myco/ana-1');
    expect((await ensureWorktree(repo, 'ana-1')).path).toBe(wt.path);
    // git de verdade: no Windows, com a máquina ocupada, passa fácil dos 5 s padrão.
  }, 30_000);

  it('valida a ficha e o retrato', async () => {
    await expect(service().hire('proj-id', { name: '', role: 'x', mission: 'y' }, true)).rejects.toThrow('informe o nome');
    await expect(service().hire('proj-id', { ...input, portraitDataUrl: 'data:text/html;base64,AAAA' }, true)).rejects.toThrow('retrato inválido');
    expect(await service().hire('outro', input, true)).toBeNull();
  });
});
