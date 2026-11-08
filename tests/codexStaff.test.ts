import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUsage, Project, StaffProfile } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { StaffError, StaffService } from '../server/staff/service';
import { profileFile, readProfile, saveChatChoice, saveProfile, StaffInputSchema } from '../server/staff/store';

// Ficha com engine codex: o que o servidor aceita ao salvar, o que recusa ao abrir a conversa e o esforço `ultra` (só do Codex).

let root: string;
let projectPath: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-staff-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

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
const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
const service = () => new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage });

const base = { name: 'Cris', role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false };
const SERVERS = 'Quem tem servidores na ficha não pode rodar no Codex: tire os servidores ou use o Claude';

describe('ficha no Codex: servidores', () => {
  it('ao contratar, engine codex com servidores é recusado com o erro em português; sem servidores passa, e no Claude servidores seguem como sempre', async () => {
    const svc = service();
    await expect(svc.hire('proj-id', { ...base, engine: 'codex', servers: ['vps1'] }, true)).rejects.toThrow(SERVERS);
    await expect(svc.hire('proj-id', { ...base, engine: 'codex', servers: ['vps1'] }, true)).rejects.toBeInstanceOf(StaffError);
    const codex = (await svc.hire('proj-id', { ...base, name: 'Cris Codex', engine: 'codex', model: 'gpt-6-sol', effort: 'high' }, true))!.profile;
    expect(codex).toMatchObject({ engine: 'codex', model: 'gpt-6-sol', servers: [] });
    expect((await readProfile(projectPath, codex.id))?.engine).toBe('codex');
    const claude = (await svc.hire('proj-id', { ...base, name: 'Cris Claude', servers: ['vps1'] }, true))!.profile;
    expect(claude.servers).toEqual(['vps1']);
    expect(claude.engine).toBeUndefined();
  });

  it('o schema recusa na raiz (o erro aponta o campo servers)', () => {
    const r = StaffInputSchema.safeParse({ ...base, engine: 'codex', servers: ['a'] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]).toMatchObject({ message: SERVERS, path: ['servers'] });
  });

  it('ao editar, vale a ficha já junta: o pedido sem `engine` numa ficha do Codex, ou trocar para o Codex mantendo servidores, é recusado', async () => {
    const svc = service();
    const codex = (await svc.hire('proj-id', { ...base, name: 'Edita Codex', engine: 'codex' }, true))!.profile;
    // A tela não manda `engine` ao editar: o da ficha continua e os servidores novos não passam.
    await expect(svc.update('proj-id', codex.id, { ...base, name: 'Edita Codex', servers: ['vps1'] })).rejects.toThrow(SERVERS);
    const claude = (await svc.hire('proj-id', { ...base, name: 'Edita Claude', servers: ['vps1'] }, true))!.profile;
    await expect(svc.update('proj-id', claude.id, { ...base, name: 'Edita Claude', servers: ['vps1'], engine: 'codex' })).rejects.toThrow(SERVERS);
    // Tirando os servidores, troca de motor.
    const moved = await svc.update('proj-id', claude.id, { ...base, name: 'Edita Claude', servers: [], engine: 'codex' });
    expect(moved?.engine).toBe('codex');
    // Edição sem tocar no motor mantém o engine.
    expect((await svc.update('proj-id', codex.id, { ...base, name: 'Edita Codex', mission: 'Outra missão' }))?.engine).toBe('codex');
  });

  it('ao abrir a conversa, a segunda checagem recusa em vez de rodar (ficha antiga ou editada à mão)', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Mao', engine: 'codex' }, true))!.profile;
    // Servidores escritos direto no arquivo, sem passar pela validação.
    await saveProfile(projectPath, { ...p, servers: ['vps1'] });
    await expect(svc.chatSpawn('proj-id', null, p.id)).rejects.toThrow(SERVERS);
    await expect(svc.chatSpawn('proj-id', null, p.id)).rejects.toBeInstanceOf(StaffError);
  });

  it('abre a conversa do Codex: engine, argumentos do claude vazios, ficha sem Agent/Chrome e o cofre no contexto do bloqueio', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Abre', engine: 'codex', model: 'gpt-6-sol', effort: 'ultra', playbook: 'plan-big-execute-small', browser: true }, true))!.profile;
    const spawn = (await svc.chatSpawn('proj-id', null, p.id))!;
    expect(spawn).toMatchObject({ engine: 'codex', args: [], codex: { autonomy: 'acceptEdits', model: 'gpt-6-sol', effort: 'ultra', threadId: null } });
    expect(spawn.codex!.secrets).toMatchObject({ projectPath, home: os.homedir() });
    expect(spawn.codex!.secrets.mycoHome).toBe(process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco'));
    expect(spawn.codex!.secrets).not.toHaveProperty('keyFiles'); // só pastas: as chaves das conexões não entram no bloqueio
    expect(spawn.codex!.instructions).toContain('Ficha de Abre');
    expect(spawn.codex!.instructions).not.toMatch(/ferramenta Agent|subagent|Chrome/);
    // Reabrir: a mesma sessão, retomando a thread gravada (nenhuma ainda).
    expect((await svc.chatSpawn('proj-id', spawn.sessionId, p.id))!.sessionId).toBe(spawn.sessionId);
  });

  it('modelo do Claude que ficou na ficha ao trocar de motor não vai para o Codex', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Troca', engine: 'codex', model: 'opus' }, true))!.profile;
    expect((await svc.chatSpawn('proj-id', null, p.id))!.codex!.model).toBeNull();
  });
});

describe('esforço ultra: só no Codex', () => {
  it('aceito para engine codex; recusado no Claude (explícito ou por omissão)', async () => {
    const svc = service();
    const ok = (await svc.hire('proj-id', { ...base, name: 'Ultra', engine: 'codex', effort: 'ultra' }, true))!.profile;
    expect(ok.effort).toBe('ultra');
    expect((await readProfile(projectPath, ok.id))?.effort).toBe('ultra');
    const erro = 'O esforço ultra só existe no Codex';
    await expect(svc.hire('proj-id', { ...base, name: 'Claude Ultra', engine: 'claude', effort: 'ultra' }, true)).rejects.toThrow(erro);
    await expect(svc.hire('proj-id', { ...base, name: 'Sem Motor Ultra', effort: 'ultra' }, true)).rejects.toThrow(erro);
    // Os esforços de sempre seguem valendo no Claude, e um inventado continua inválido.
    expect((await svc.hire('proj-id', { ...base, name: 'Max', effort: 'max' }, true))!.profile.effort).toBe('max');
    expect(StaffInputSchema.safeParse({ ...base, effort: 'ultra-mega' }).success).toBe(false);
    // Editar uma ficha do Claude para ultra também.
    const claude = (await svc.hire('proj-id', { ...base, name: 'Edita Ultra' }, true))!.profile;
    await expect(svc.update('proj-id', claude.id, { ...base, name: 'Edita Ultra', effort: 'ultra' })).rejects.toThrow(erro);
  });

  it('o esforço escolhido no chat só grava ultra para quem roda no Codex', async () => {
    const svc = service();
    const codex = (await svc.hire('proj-id', { ...base, name: 'Chat Codex', engine: 'codex' }, true))!.profile;
    const claude = (await svc.hire('proj-id', { ...base, name: 'Chat Claude' }, true))!.profile;
    await saveChatChoice(projectPath, codex.id, null, { effort: 'ultra' });
    await saveChatChoice(projectPath, claude.id, null, { effort: 'ultra' });
    expect((await readProfile(projectPath, codex.id))?.lastEffort).toBe('ultra');
    expect((await readProfile(projectPath, claude.id))?.lastEffort).toBeUndefined();
    await saveChatChoice(projectPath, claude.id, null, { effort: 'xhigh' });
    expect((await readProfile(projectPath, claude.id))?.lastEffort).toBe('xhigh');
  });

  it('ficha do Claude com ultra no arquivo (voltou de motor ou foi editada à mão): o valor sai na leitura e nunca vai para o `claude --effort`', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Voltou', engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' }, true))!.profile;
    const { engine: _e, ...asClaude } = p;
    await saveProfile(projectPath, { ...asClaude, model: 'sonnet', lastEffort: 'ultra', sessions: [{ id: 'abc', startedAt: 'x', effort: 'ultra' }] });
    const read = (await readProfile(projectPath, p.id))!;
    expect(read.effort).toBeNull();
    expect(read.lastEffort).toBeUndefined();
    expect(read.sessions[0]).toEqual({ id: 'abc', startedAt: 'x' });
    // O arquivo não é reescrito só por ler.
    expect(JSON.parse(await fs.readFile(profileFile(projectPath, p.id), 'utf8')).effort).toBe('ultra');
    const spawn = (await svc.chatSpawn('proj-id', null, p.id))!;
    expect(spawn.args).not.toContain('ultra');
    expect(spawn.args).not.toContain('--effort');
  });
});

describe('ficha no Codex: modelo fora do catálogo', () => {
  const models = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'].map((slug) => ({ slug, displayName: slug, efforts: ['low'], defaultEffort: null }));
  const withCatalog = (catalog: () => Promise<{ models: typeof models; reason: string | null }>) => {
    const logs: string[] = [];
    const svc = new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'x', readUsage: noUsage, codexCatalog: catalog, log: (l) => logs.push(l) });
    return { svc, logs };
  };
  const ok = async () => ({ models, reason: null });
  const out = (reason: string) => async () => ({ models: [], reason });

  it('salvar com modelo que a conta não tem (o caso do gpt-6.1-sol) é recusado, com a lista dos que existem', async () => {
    const { svc } = withCatalog(ok);
    const erro = 'O modelo gpt-6.1-sol não está no catálogo do Codex desta conta. Escolha um destes: gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol';
    await expect(svc.hire('proj-id', { ...base, name: 'Modelo Ruim', engine: 'codex', model: 'gpt-6.1-sol' }, true)).rejects.toThrow(erro);
    await expect(svc.hire('proj-id', { ...base, name: 'Modelo Ruim', engine: 'codex', model: 'gpt-6.1-sol' }, true)).rejects.toBeInstanceOf(StaffError);
    const bom = (await svc.hire('proj-id', { ...base, name: 'Modelo Bom', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    expect(bom.model).toBe('gpt-6-sol');
    // Sem modelo (o padrão do Codex) e o Claude não passam pelo catálogo.
    expect((await svc.hire('proj-id', { ...base, name: 'Sem Modelo', engine: 'codex' }, true))!.profile.model).toBeNull();
    expect((await svc.hire('proj-id', { ...base, name: 'Claude Normal', model: 'gpt-6.1-sol' }, true))!.profile.model).toBe('gpt-6.1-sol');
  });

  it('ao editar, recusa o modelo novo fora do catálogo; o que já estava na ficha não trava uma edição qualquer', async () => {
    const { svc } = withCatalog(ok);
    const p = (await svc.hire('proj-id', { ...base, name: 'Edita Modelo', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    await expect(svc.update('proj-id', p.id, { ...base, name: 'Edita Modelo', model: 'gpt-6.1-sol' })).rejects.toThrow(/gpt-6\.1-sol não está no catálogo/);
    expect((await svc.update('proj-id', p.id, { ...base, name: 'Edita Modelo', model: 'gpt-6-luna' }))?.model).toBe('gpt-6-luna');
    // Trocar do Claude para o Codex conta como mudança: o modelo precisa existir no catálogo.
    const c = (await svc.hire('proj-id', { ...base, name: 'Vai Pro Codex', model: 'opus' }, true))!.profile;
    await expect(svc.update('proj-id', c.id, { ...base, name: 'Vai Pro Codex', model: 'opus', engine: 'codex' })).rejects.toThrow(/opus não está no catálogo/);
    // Ficha antiga com modelo que a conta deixou de aceitar (gravada sem conferir): editar a missão não trava.
    await saveProfile(projectPath, { ...p, model: 'gpt-6.1-sol' });
    expect((await svc.update('proj-id', p.id, { ...base, name: 'Edita Modelo', model: 'gpt-6.1-sol', mission: 'Outra missão' }))?.mission).toBe('Outra missão');
  });

  it('catálogo indisponível (sem codex, sem login, falha): aceita, registra o aviso e não trava o salvamento', async () => {
    const semLogin = withCatalog(out('o Codex CLI está sem login (rode codex login)'));
    const p = (await semLogin.svc.hire('proj-id', { ...base, name: 'Sem Login', engine: 'codex', model: 'gpt-6.1-sol' }, true))!.profile;
    expect(p.model).toBe('gpt-6.1-sol');
    expect(semLogin.logs).toEqual(['modelo gpt-6.1-sol do Codex salvo sem conferir: catálogo indisponível (o Codex CLI está sem login (rode codex login))']);
    const quebrou = withCatalog(async () => {
      throw new Error('quebrou');
    });
    expect((await quebrou.svc.hire('proj-id', { ...base, name: 'Quebrou', engine: 'codex', model: 'gpt-9-sol' }, true))!.profile.model).toBe('gpt-9-sol');
    expect(quebrou.logs).toEqual(['modelo gpt-9-sol do Codex salvo sem conferir: quebrou']);
  });

  it('sem catálogo configurado (testes, outros usos), nada é conferido', async () => {
    const p = (await service().hire('proj-id', { ...base, name: 'Sem Conferir', engine: 'codex', model: 'qualquer-coisa' }, true))!.profile;
    expect(p.model).toBe('qualquer-coisa');
  });
});
