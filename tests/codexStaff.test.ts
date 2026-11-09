import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUsage, Project, StaffProfile } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { StaffError, StaffService, type StaffServiceOptions } from '../server/staff/service';
import { UsageStopError } from '../server/usageStop';
import { readSeal, sealFile, writeSeal } from '../server/staff/seal';
import { fichaFile, memoryFile, profileFile, readProfile, saveChatChoice, saveProfile, StaffInputSchema } from '../server/staff/store';

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
const service = (over: Partial<StaffServiceOptions> = {}) =>
  new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage, codexEnabled: async () => true, ...over });

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
    // Voltou ao Claude pela tela (não à mão): o selo do Codex sai. Mexer no arquivo sem isso é o caso do selo (ver "selo da ficha do Codex").
    await writeSeal(path.join(root, 'run'), projectPath, asClaude);
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
    const svc = new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'x', readUsage: noUsage, codexEnabled: async () => true, codexCatalog: catalog, log: (l) => logs.push(l) });
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

describe('contratação por gestor que roda no Codex', () => {
  const hireBody = { name: 'Sub', role: 'Ajudante', mission: 'Ajudar', autonomy: 'bypassPermissions', launch: false };
  const codexBoss = async (svc: StaffService, name: string, over: Record<string, unknown> = {}) =>
    (await svc.hire('proj-id', { ...base, name, engine: 'codex', autonomy: 'auto', canHire: true, ...over }, true))!.profile;

  it('quem o gestor Codex contrata pela API sem pedir motor nasce no Codex, com a autonomia dele no máximo e sem servidores nem Chrome', async () => {
    const svc = service();
    const boss = await codexBoss(svc, 'Chefe Codex');
    const hired = (await svc.hire('proj-id', { ...hireBody, name: 'Sub 1', reportsTo: [boss.id], browser: true, canHire: true, servers: ['vps1'] }, false))!.profile;
    expect(hired).toMatchObject({ engine: 'codex', autonomy: 'auto', canHire: false, servers: [], browser: false, hiredBy: boss.id, temporary: true });
    expect((await readProfile(projectPath, hired.id))?.engine).toBe('codex'); // gravado, não só devolvido
    // Sem `engine` no pedido, nasce no Codex (o padrão do gestor Codex).
    const semMotor = (await svc.hire('proj-id', { ...hireBody, name: 'Sub 2', reportsTo: [boss.id] }, false))!.profile;
    expect(semMotor).toMatchObject({ engine: 'codex', autonomy: 'auto' });
    // Modelo do Claude não vale no Codex (vai o padrão); o do Codex fica; `ultra` (só do Codex) passa.
    const alias = (await svc.hire('proj-id', { ...hireBody, name: 'Sub 3', reportsTo: [boss.id], model: 'opus', effort: 'max' }, false))!.profile;
    expect(alias).toMatchObject({ engine: 'codex', model: null, effort: 'max' });
    const gpt = (await svc.hire('proj-id', { ...hireBody, name: 'Sub 4', reportsTo: [boss.id], engine: 'codex', model: 'gpt-6-luna', effort: 'ultra' }, false))!.profile;
    expect(gpt).toMatchObject({ engine: 'codex', model: 'gpt-6-luna', effort: 'ultra' });
    // A conversa dele abre no Codex (a sandbox), não como o Claude `auto` do pedido.
    const spawn = (await svc.chatSpawn('proj-id', null, hired.id))!;
    expect(spawn).toMatchObject({ engine: 'codex', args: [], codex: { autonomy: 'auto' } });
  });

  it('gestor Codex pedindo engine claude: nasce Claude travado em manual, sem Chrome, MCPs, servidores nem canHire, mesmo pedindo auto', async () => {
    const svc = service();
    const boss = await codexBoss(svc, 'Chefe Libera');
    const pedido = { ...hireBody, reportsTo: [boss.id], engine: 'claude', autonomy: 'auto', browser: true, mcps: ['github'], canHire: true, servers: ['vps1'] };
    const hired = (await svc.hire('proj-id', { ...pedido, name: 'Sub Claude Travado' }, false))!.profile;
    expect(hired).toMatchObject({ engine: 'claude', autonomy: 'manual', browser: false, mcps: [], servers: [], canHire: false, hiredBy: boss.id, temporary: true });
    const gravado = (await readProfile(projectPath, hired.id))!; // gravado, não só devolvido
    expect(gravado).toMatchObject({ engine: 'claude', autonomy: 'manual', browser: false, mcps: [], servers: [], canHire: false });
    // Também com `bypassPermissions`: a trava vale.
    const bypass = (await svc.hire('proj-id', { ...pedido, name: 'Sub Claude Bypass', autonomy: 'bypassPermissions' }, false))!.profile;
    expect(bypass).toMatchObject({ engine: 'claude', autonomy: 'manual', browser: false, mcps: [], servers: [], canHire: false });
    // A conversa abre como Claude, no "Pede tudo" (manual), sem o Chrome, e a ficha conta por quê.
    const spawn = (await svc.chatSpawn('proj-id', null, hired.id))!;
    expect(spawn.engine).toBeUndefined();
    expect(spawn.args.slice(spawn.args.indexOf('--permission-mode'), spawn.args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'manual']);
    expect(spawn.args).not.toContain('--chrome');
    const ficha = await fs.readFile(fichaFile(projectPath, hired.id), 'utf8');
    expect(ficha).toContain('Você foi contratado por um gestor no Codex e por isso pede aprovação de tudo');
    // Quem o gestor Codex contrata sem pedir motor não ganha essa linha.
    const codexSub = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Sem Linha', reportsTo: [boss.id] }, false))!.profile;
    expect(await fs.readFile(fichaFile(projectPath, codexSub.id), 'utf8')).not.toContain('contratado por um gestor no Codex');
  });

  it('o Claude contratado por gestor Codex fica selado: subir a autonomia na ficha do disco não abre a conversa; salvar pela tela confirma e a trava segue', async () => {
    const svc = service();
    const boss = await codexBoss(svc, 'Chefe Selo');
    const hired = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Selado', reportsTo: [boss.id], engine: 'claude' }, false))!.profile;
    expect(await readSeal(path.join(root, 'run'), projectPath, hired.id)).toMatchObject({ engine: 'claude', autonomy: 'manual' });
    // O contratado edita o próprio arquivo (fora da sandbox) para `bypassPermissions`: a conversa recusa, e nada novo é gravado.
    await saveProfile(projectPath, { ...(await readProfile(projectPath, hired.id))!, autonomy: 'bypassPermissions' });
    await expect(svc.chatSpawn('proj-id', null, hired.id)).rejects.toThrow(/foi mudada fora do Claudio’s Club \(autonomia bypassPermissions em vez de manual\)/);
    await expect(svc.chatSpawn('proj-id', null, hired.id)).rejects.toThrow(/Quem foi contratado por um gestor no Codex/);
    // Trocar o motor para o Codex no arquivo também não vale.
    await saveProfile(projectPath, { ...(await readProfile(projectPath, hired.id))!, autonomy: 'manual', engine: 'codex' });
    await expect(svc.chatSpawn('proj-id', null, hired.id)).rejects.toThrow(/motor codex em vez de claude/);
    // Voltando ao que o selo guarda, abre de novo.
    await saveProfile(projectPath, { ...(await readProfile(projectPath, hired.id))!, engine: 'claude' });
    expect((await svc.chatSpawn('proj-id', null, hired.id))!.engine).toBeUndefined();
    // O dono, pela tela, pode mudar a autonomia; a trava (o selo) segue com o valor novo.
    const { id: _i, projectId: _p, portrait: _pt, sessions: _s, createdAt: _c, updatedAt: _u, ...fields } = (await readProfile(projectPath, hired.id))!;
    await svc.update('proj-id', hired.id, { ...fields, autonomy: 'acceptEdits' });
    expect(await readSeal(path.join(root, 'run'), projectPath, hired.id)).toMatchObject({ engine: 'claude', autonomy: 'acceptEdits' });
    await saveProfile(projectPath, { ...(await readProfile(projectPath, hired.id))!, autonomy: 'bypassPermissions' });
    await expect(svc.chatSpawn('proj-id', null, hired.id)).rejects.toThrow(/autonomia bypassPermissions em vez de acceptEdits/);
  });

  it('a autonomia do subfuncionário nunca passa da do gestor Codex, mesmo com outro gestor mais livre na lista', async () => {
    const svc = service();
    const boss = await codexBoss(svc, 'Chefe Acaba', { autonomy: 'acceptEdits', canHire: false });
    const claudeBoss = (await svc.hire('proj-id', { ...base, name: 'Chefe Claude', autonomy: 'bypassPermissions', canHire: true }, true))!.profile;
    // Quem contrata (canHire) é o do Claude, mas o pedido também aponta para um Codex: nasce no Codex, no teto dele.
    const hired = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Misto', reportsTo: [claudeBoss.id, boss.id] }, false))!.profile;
    expect(hired).toMatchObject({ engine: 'codex', autonomy: 'acceptEdits', hiredBy: claudeBoss.id });
    // Com `engine: "claude"` e um gestor Codex entre os gestores, vale a trava: manual e sem Chrome, MCPs, servidores e canHire.
    const livre = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Misto Claude', reportsTo: [claudeBoss.id, boss.id], engine: 'claude', browser: true, mcps: ['github'] }, false))!.profile;
    expect(livre).toMatchObject({ engine: 'claude', autonomy: 'manual', browser: false, mcps: [], servers: [], canHire: false, hiredBy: claudeBoss.id });
  });

  it('gestor do Claude segue como sempre: contratado sem engine (Claude), autonomia limitada à do gestor', async () => {
    const svc = service();
    const boss = (await svc.hire('proj-id', { ...base, name: 'Chefe Normal', autonomy: 'auto', canHire: true, mcps: null }, true))!.profile;
    const hired = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Claude', reportsTo: [boss.id], model: 'opus', browser: true }, false))!.profile;
    expect(hired.engine).toBeUndefined();
    expect(hired).toMatchObject({ autonomy: 'auto', model: 'opus', browser: true, canHire: false }); // o gestor usa o Chrome: o subfuncionário também
    expect(await readSeal(path.join(root, 'run'), projectPath, hired.id)).toBeNull(); // sem selo: o caminho Claude → Claude não muda
    // Pedindo `engine: "claude"` o gestor do Claude também não muda nada: autonomia limitada à dele, sem trava de manual.
    const pediu = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Pediu Claude', reportsTo: [boss.id], engine: 'claude', mcps: ['github'] }, false))!.profile;
    expect(pediu).toMatchObject({ engine: 'claude', autonomy: 'auto', mcps: ['github'] });
    expect(await readSeal(path.join(root, 'run'), projectPath, pediu.id)).toBeNull();
    expect((await svc.chatSpawn('proj-id', null, hired.id))!.engine).toBeUndefined();
    // Pelo navegador (o dono), qualquer motor e autonomia, como antes.
    const dono = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Dono', reportsTo: [boss.id], engine: 'claude' }, true))!.profile;
    expect(dono).toMatchObject({ engine: 'claude', autonomy: 'bypassPermissions' });
    const donoCodex = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Dono Codex', engine: 'codex' }, true))!.profile;
    expect(donoCodex.engine).toBe('codex');
  });

  it('o gestor Codex que se rebaixou no arquivo (engine claude) não contrata: o selo pega antes de nascer um Claude sem sandbox', async () => {
    const svc = service();
    const boss = await codexBoss(svc, 'Chefe Rebaixado');
    await saveProfile(projectPath, { ...boss, engine: 'claude', autonomy: 'bypassPermissions' });
    await expect(svc.hire('proj-id', { ...hireBody, name: 'Sub Rebaixado', reportsTo: [boss.id] }, false)).rejects.toThrow(/A ficha de Chefe Rebaixado foi mudada fora do Claudio’s Club/);
    await expect(svc.hire('proj-id', { ...hireBody, name: 'Sub Rebaixado', reportsTo: [boss.id] }, false)).rejects.toBeInstanceOf(StaffError);
  });

  it('os outros caminhos de criar ficha pela API não existem: copiar, adotar sessão, editar, restaurar e apagar são só do navegador', async () => {
    const svc = service();
    const boss = await codexBoss(svc, 'Chefe Rotas');
    await expect(svc.hire('proj-id', { ...hireBody, name: 'Adota', reportsTo: [boss.id], adoptSessionId: '11111111-2222-4333-8444-555555555555' }, false)).rejects.toThrow('só pelo Claudio’s Club');
    await expect(svc.copyFrom('proj-id', {}, false)).rejects.toThrow('só pelo Claudio’s Club');
    await expect(svc.deleteStaff('proj-id', boss.id, false)).rejects.toThrow('só pelo Claudio’s Club');
    const { staffMayPost } = await import('../server/apiPolicy');
    // A API de funcionário só alcança a contratação (POST /staff), que é a que acabou de ser coberta; o resto da ficha fica fora.
    expect(staffMayPost('/api/projects/p/staff')).toBe(true);
    for (const rota of ['staff/copy', `staff/${boss.id}`, `staff/${boss.id}/restore`, `staff/${boss.id}/managers`, `staff/${boss.id}/keep`]) {
      expect(staffMayPost(`/api/projects/p/${rota}`)).toBe(false);
    }
    const index = await fs.readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(index).toContain("throw new BadRequest('a ficha só é editada pelo Claudio’s Club')");
  });
});

describe('selo da ficha do Codex: a ficha mexida por fora não abre', () => {
  const runDir = () => path.join(root, 'run');
  const codexPerson = async (svc: StaffService, name: string, over: Record<string, unknown> = {}) =>
    (await svc.hire('proj-id', { ...base, name, engine: 'codex', autonomy: 'acceptEdits', ...over }, true))!.profile;

  it('contratar uma ficha do Codex grava o selo fora do projeto (em <runDir>/seals), com motor e autonomia', async () => {
    const svc = service();
    const p = await codexPerson(svc, 'Selada');
    const file = sealFile(runDir(), projectPath, p.id);
    expect(file.startsWith(path.join(root, 'run', 'seals'))).toBe(true);
    expect(file.startsWith(projectPath)).toBe(false); // fora da pasta onde a sandbox grava
    expect(await readSeal(runDir(), projectPath, p.id)).toMatchObject({ engine: 'codex', autonomy: 'acceptEdits' });
    // Quem roda no Claude não tem selo (o caminho do Claude não muda).
    const c = (await svc.hire('proj-id', { ...base, name: 'Sem Selo' }, true))!.profile;
    expect(await readSeal(runDir(), projectPath, c.id)).toBeNull();
  });

  it('o funcionário que se rebaixa no próprio arquivo (engine claude, bypass) não abre conversa nenhuma, nem como Claude, e nada é gravado', async () => {
    const svc = service();
    const p = await codexPerson(svc, 'Rebaixa Se');
    const adulterada = { ...p, engine: 'claude' as const, autonomy: 'bypassPermissions' as const };
    await saveProfile(projectPath, adulterada);
    const antes = await fs.readFile(fichaFile(projectPath, p.id), 'utf8').catch(() => null);
    const err = await svc.chatSpawn('proj-id', null, p.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as Error).message).toBe(
      'A ficha de Rebaixa Se foi mudada fora do Claudio’s Club (motor claude em vez de codex; autonomia bypassPermissions em vez de acceptEdits). Quem roda no Codex não muda o próprio motor nem a própria autonomia, então a conversa não abre. Abra a ficha, confira e salve de novo para confirmar, ou volte a uma versão anterior pelo histórico.',
    );
    // Recusou antes de abrir sessão, de reescrever a ficha .md e de criar worktree.
    expect((await readProfile(projectPath, p.id))?.sessions).toEqual([]);
    expect(await fs.readFile(fichaFile(projectPath, p.id), 'utf8').catch(() => null)).toBe(antes);
    // Conversa já gravada (reabrir) também.
    await expect(svc.chatSpawn('proj-id', '11111111-2222-4333-8444-555555555555', p.id)).rejects.toThrow(/foi mudada fora do Claudio’s Club/);
  });

  it('só a autonomia mexida (continua Codex) também recusa; só o motor também; voltar ao valor do selo abre de novo', async () => {
    const svc = service();
    const p = await codexPerson(svc, 'Sobe Autonomia');
    await saveProfile(projectPath, { ...p, autonomy: 'bypassPermissions' });
    await expect(svc.chatSpawn('proj-id', null, p.id)).rejects.toThrow(/\(autonomia bypassPermissions em vez de acceptEdits\)/);
    await saveProfile(projectPath, { ...p, engine: 'claude' });
    await expect(svc.chatSpawn('proj-id', null, p.id)).rejects.toThrow(/\(motor claude em vez de codex\)/);
    await saveProfile(projectPath, p); // o arquivo volta ao que o app gravou
    expect((await svc.chatSpawn('proj-id', null, p.id))!.engine).toBe('codex');
  });

  it('salvar pela tela confirma: a ficha mexida passa a valer com o que o dono viu e salvou; trocar de motor pela tela apaga o selo', async () => {
    const svc = service();
    const p = await codexPerson(svc, 'Confirma');
    await saveProfile(projectPath, { ...p, autonomy: 'bypassPermissions' });
    await expect(svc.chatSpawn('proj-id', null, p.id)).rejects.toThrow(StaffError);
    // O dono abre a ficha e salva (aqui, voltando a acceptEdits): vale e o selo acompanha.
    const saved = (await svc.update('proj-id', p.id, { ...base, name: 'Confirma', autonomy: 'acceptEdits' }))!;
    expect(saved.engine).toBe('codex');
    expect(await readSeal(runDir(), projectPath, p.id)).toMatchObject({ autonomy: 'acceptEdits' });
    expect((await svc.chatSpawn('proj-id', null, p.id))!.codex!.autonomy).toBe('acceptEdits');
    // Subir a autonomia pela tela também vale (é decisão do dono).
    await svc.update('proj-id', p.id, { ...base, name: 'Confirma', autonomy: 'auto' });
    expect((await svc.chatSpawn('proj-id', null, p.id))!.codex!.autonomy).toBe('auto');
    // Trocar para o Claude pela tela: o selo sai e a conversa abre como Claude.
    await svc.update('proj-id', p.id, { ...base, name: 'Confirma', autonomy: 'auto', engine: 'claude' });
    expect(await readSeal(runDir(), projectPath, p.id)).toBeNull();
    expect((await svc.chatSpawn('proj-id', null, p.id))!.engine).toBeUndefined();
  });

  it('restaurar uma versão pela tela regrava o selo; copiar a ficha sela a cópia; ficha do Codex sem selo (anterior a ele) é selada ao abrir', async () => {
    const svc = service();
    const p = await codexPerson(svc, 'Restaura');
    await svc.update('proj-id', p.id, { ...base, name: 'Restaura', autonomy: 'auto', mission: 'Segunda missão' });
    const versions = (await svc.versions('proj-id', p.id))!;
    const restored = (await svc.restore('proj-id', p.id, versions[0]!.version))!;
    expect(restored.autonomy).toBe('acceptEdits');
    expect(await readSeal(runDir(), projectPath, p.id)).toMatchObject({ autonomy: 'acceptEdits' });
    expect((await svc.chatSpawn('proj-id', null, p.id))!.codex!.autonomy).toBe('acceptEdits');
    // Sem selo (ficha criada antes dele): o primeiro open sela com o disco, e dali em diante a mexida por fora é pega.
    await fs.rm(sealFile(runDir(), projectPath, p.id));
    expect((await svc.chatSpawn('proj-id', null, p.id))!.engine).toBe('codex');
    expect(await readSeal(runDir(), projectPath, p.id)).toMatchObject({ engine: 'codex' });
    await saveProfile(projectPath, { ...(await readProfile(projectPath, p.id))!, engine: 'claude' });
    await expect(svc.chatSpawn('proj-id', null, p.id)).rejects.toThrow(StaffError);
  });

  it('quem mexe no gestor pelo quadro (+ e linha desfeita) também não sela uma ficha mexida por fora', async () => {
    const svc = service();
    const boss = await codexPerson(svc, 'Gestor Quadro');
    const sub = await codexPerson(svc, 'Sub Quadro');
    await saveProfile(projectPath, { ...sub, autonomy: 'bypassPermissions' });
    await expect(svc.addManager('proj-id', sub.id, boss.id)).rejects.toThrow(/foi mudada fora do Claudio’s Club/);
    expect(await readSeal(runDir(), projectPath, sub.id)).toMatchObject({ autonomy: 'acceptEdits' }); // o selo não foi regravado com o valor adulterado
    await saveProfile(projectPath, { ...sub, reportsTo: [boss.id] });
    await expect(svc.removeManager('proj-id', sub.id, boss.id)).resolves.toMatchObject({ reportsTo: [] });
  });

  it('a ficha do próprio funcionário vai como só leitura para a sandbox (JSON, .md, histórico); a memória não', async () => {
    const svc = service();
    const p = await codexPerson(svc, 'So Leitura');
    const spawn = (await svc.chatSpawn('proj-id', null, p.id))!;
    expect(spawn.codex!.readOnlyPaths).toEqual([profileFile(projectPath, p.id), fichaFile(projectPath, p.id), path.join(path.dirname(profileFile(projectPath, p.id)), `${p.id}.history`)]);
    expect(spawn.codex!.readOnlyPaths).not.toContain(memoryFile(projectPath, p.id));
  });
});

describe('o Codex só vale ligado, na versão mínima e instalado', () => {
  it('com a opção desligada nas configurações (codexReview), a conversa de quem roda no Codex é recusada com aviso, sem gravar nada; a do Claude não muda', async () => {
    const off = service({ codexEnabled: async () => false });
    const p = (await service().hire('proj-id', { ...base, name: 'Desligado', engine: 'codex' }, true))!.profile;
    const err = await off.chatSpawn('proj-id', null, p.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as Error).message).toBe('O Codex está desligado nas configurações: ligue "Usar o Codex (GPT)" para abrir conversas de quem roda no Codex (ou troque o motor da ficha para o Claude).');
    expect((await readProfile(projectPath, p.id))?.sessions).toEqual([]); // nenhuma sessão registrada
    const claude = (await off.hire('proj-id', { ...base, name: 'Claude Com Codex Off' }, true))!.profile;
    expect((await off.chatSpawn('proj-id', null, claude.id))!.args).toContain('--session-id');
    // Ligado: abre.
    expect((await service().chatSpawn('proj-id', null, p.id))!.engine).toBe('codex');
    // Sem a opção nenhuma passada, vale o config de verdade (padrão desligado).
    const real = new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'x', readUsage: noUsage });
    const { readConfig } = await import('../server/config');
    if (!(await readConfig()).codexReview) await expect(real.chatSpawn('proj-id', null, p.id)).rejects.toThrow(/desligado nas configurações/);
  });

  it('Codex antigo ou ausente: a conversa não abre e a mensagem diz como atualizar; Codex que serve segue', async () => {
    const msg = 'O Codex 0.150.0 é antigo demais para rodar funcionários no Claudio’s Club (o mínimo é 0.156.1). Atualize com: codex update';
    const velho = service({ codexEnv: async () => ({ error: msg, version: '0.150.0', networkProxy: false, notice: null }) });
    const p = (await service().hire('proj-id', { ...base, name: 'Codex Velho', engine: 'codex' }, true))!.profile;
    await expect(velho.chatSpawn('proj-id', null, p.id)).rejects.toThrow(msg);
    await expect(velho.chatSpawn('proj-id', null, p.id)).rejects.toBeInstanceOf(StaffError);
    expect((await readProfile(projectPath, p.id))?.sessions).toEqual([]);
    const bom = service({ codexEnv: async () => ({ error: null, version: '0.167.0', networkProxy: true, notice: null }) });
    expect((await bom.chatSpawn('proj-id', null, p.id))!.engine).toBe('codex');
    // O Claude não passa por essa conferência.
    const claude = (await velho.hire('proj-id', { ...base, name: 'Claude Sem Conferir' }, true))!.profile;
    expect((await velho.chatSpawn('proj-id', null, claude.id))!.engine).toBeUndefined();
  });
});

describe('trava de consumo: o 5h/7d é da conta do Claude', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const high = async (): Promise<AccountUsage> => ({ tapInstalled: true, updatedAt: future, limits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: future }] });

  it('quem roda no Codex não é barrado pelo consumo do Claude; o Claude, a conversa avulsa e o destino sem ficha seguem barrados', async () => {
    const svc = service({ readUsage: high });
    const codex = (await svc.hire('proj-id', { ...base, name: 'Trava Codex', engine: 'codex' }, true))!.profile;
    const claude = (await svc.hire('proj-id', { ...base, name: 'Trava Claude' }, true))!.profile;
    await expect(svc.checkUsage('proj-id', { staffId: codex.id })).resolves.toBeUndefined();
    await expect(svc.checkUsage('proj-id', { engine: 'codex' })).resolves.toBeUndefined();
    await expect(svc.checkUsage('proj-id', { staffId: claude.id })).rejects.toBeInstanceOf(UsageStopError);
    await expect(svc.checkUsage('proj-id', { engine: 'claude' })).rejects.toBeInstanceOf(UsageStopError);
    await expect(svc.checkUsage('proj-id', { staffId: null })).rejects.toBeInstanceOf(UsageStopError);
    await expect(svc.checkUsage('proj-id', { staffId: 'sumiu' })).rejects.toBeInstanceOf(UsageStopError);
    await expect(svc.checkUsage('proj-id')).rejects.toBeInstanceOf(UsageStopError);
  });

  it('contratar já começando a conversa: Codex passa, Claude é recusado', async () => {
    const svc = service({ readUsage: high });
    expect((await svc.hire('proj-id', { ...base, name: 'Contrata Codex', engine: 'codex', launch: true }, true))?.profile.engine).toBe('codex');
    await expect(svc.hire('proj-id', { ...base, name: 'Contrata Claude', launch: true }, true)).rejects.toBeInstanceOf(UsageStopError);
  });
});

describe('applyToCopies não espalha modelo e esforço entre motores', () => {
  let a: string;
  let b: string;
  const twoProjects = [
    { id: 'proj-a', path: '', name: 'a' },
    { id: 'proj-b', path: '', name: 'b' },
  ];
  const svcOf = () => {
    const list = twoProjects.map((p) => ({ ...project(), ...p }));
    const adapter2 = { listProjects: async () => list } as unknown as ToolAdapter;
    return new StaffService(adapter2, { runDir: path.join(root, 'run2'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'x', readUsage: noUsage, codexEnabled: async () => true });
  };
  beforeAll(async () => {
    a = path.join(root, 'copias-a');
    b = path.join(root, 'copias-b');
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });
    twoProjects[0]!.path = a;
    twoProjects[1]!.path = b;
  });

  it('a cópia de outro motor recebe nome, cargo e regras, mas não o modelo nem o esforço; a do mesmo motor recebe tudo', async () => {
    const svc = svcOf();
    const origem = (await svc.hire('proj-a', { ...base, name: 'Pessoa', model: 'opus', effort: 'high', autonomy: 'plan' }, true))!.profile;
    // Duas cópias no projeto b: uma continua no Claude e a outra foi para o Codex (modelo e esforço do Codex).
    const claudeCopy = (await svc.copyFrom('proj-b', { fromProjectId: 'proj-a', staffId: origem.id }, true))!.profile;
    const codexCopy = (await svc.copyFrom('proj-b', { fromProjectId: 'proj-a', staffId: origem.id }, true))!.profile;
    await svc.update('proj-b', codexCopy.id, { ...base, name: 'Pessoa', autonomy: 'plan', engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' });
    // Edita a origem (Claude) com outro modelo e esforço e leva às cópias.
    const r = (await svc.update('proj-a', origem.id, { ...base, name: 'Pessoa Nova', role: 'Gerente', rules: ['Regra nova'], autonomy: 'plan', model: 'sonnet', effort: 'low', applyToCopies: true }))!;
    expect(r.copiesUpdated).toBe(2);
    const c1 = (await readProfile(b, claudeCopy.id))!;
    expect(c1).toMatchObject({ name: 'Pessoa Nova', role: 'Gerente', rules: ['Regra nova'], model: 'sonnet', effort: 'low' }); // mesmo motor: tudo
    const c2 = (await readProfile(b, codexCopy.id))!;
    expect(c2).toMatchObject({ name: 'Pessoa Nova', role: 'Gerente', rules: ['Regra nova'], engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' }); // outro motor: só o texto
    // E ao contrário: editar a cópia do Codex leva o modelo do Codex só às do Codex, e nunca `gpt-6-luna`/`ultra` à do Claude.
    const r2 = (await svc.update('proj-b', codexCopy.id, { ...base, name: 'Pessoa Nova', role: 'Gerente', rules: ['Regra nova'], autonomy: 'plan', engine: 'codex', model: 'gpt-6-luna', effort: 'ultra', mission: 'Missão do Codex', applyToCopies: true }))!;
    expect(r2.copiesUpdated).toBe(2);
    expect(await readProfile(a, origem.id)).toMatchObject({ mission: 'Missão do Codex', model: 'sonnet', effort: 'low' });
    expect(await readProfile(b, claudeCopy.id)).toMatchObject({ mission: 'Missão do Codex', model: 'sonnet', effort: 'low' });
    // O selo da cópia do Codex não muda por ter sido editada em lote (motor e autonomia dela ficaram).
    expect(await readSeal(path.join(root, 'run2'), b, codexCopy.id)).toMatchObject({ engine: 'codex', autonomy: 'plan' });
  });
});

describe('contratação e mensagens: quem chama é o dono do token, não o que o pedido declara', () => {
  const hireBody = { name: 'Sub', role: 'Ajudante', mission: 'Ajudar', autonomy: 'bypassPermissions', launch: false };
  const boss = async (svc: StaffService, name: string, over: Record<string, unknown> = {}) =>
    (await svc.hire('proj-id', { ...base, name, autonomy: 'auto', canHire: true, ...over }, true))!.profile;
  type Who = { staffId: string | null; engine: 'claude' | 'codex'; sessionId: string };
  const callerOf = (p: StaffProfile, engine: 'claude' | 'codex' = p.engine === 'codex' ? 'codex' : 'claude'): Who => ({ staffId: p.id, engine, sessionId: `sess-${p.id}` });

  it('Codex alegando um gestor Claude com canHire: o gestor passa a ser quem chama e o contratado nasce Codex (ou travado), nunca um Claude solto', async () => {
    const svc = service();
    const claudeBoss = await boss(svc, 'Gestor Claude Alegado', { autonomy: 'bypassPermissions' });
    const codexBoss = await boss(svc, 'Gestor Codex Que Chama', { engine: 'codex' });
    // O pedido forja reportsTo = o gestor do Claude e pede um Claude: sem a regra, nasceria Claude `bypassPermissions` fora da sandbox.
    const pedido = { ...hireBody, reportsTo: [claudeBoss.id], engine: 'claude', browser: true, mcps: ['github'], canHire: true };
    const travado = (await svc.hire('proj-id', { ...pedido, name: 'Forjado Claude' }, false, callerOf(codexBoss)))!.profile;
    expect(travado).toMatchObject({ reportsTo: [codexBoss.id], hiredBy: codexBoss.id, temporary: true, engine: 'claude', autonomy: 'manual', browser: false, mcps: [], canHire: false });
    expect(await readSeal(path.join(root, 'run'), projectPath, travado.id)).toMatchObject({ engine: 'claude', autonomy: 'manual' });
    expect((await readProfile(projectPath, travado.id))?.reportsTo).toEqual([codexBoss.id]);
    // Sem pedir motor: nasce no Codex, no teto da autonomia de quem chama.
    const semMotor = (await svc.hire('proj-id', { ...hireBody, name: 'Forjado Codex', reportsTo: [claudeBoss.id] }, false, callerOf(codexBoss)))!.profile;
    expect(semMotor).toMatchObject({ reportsTo: [codexBoss.id], hiredBy: codexBoss.id, engine: 'codex', autonomy: 'auto' });
    // Vários gestores no pedido: só quem chama.
    const varios = (await svc.hire('proj-id', { ...hireBody, name: 'Forjado Varios', reportsTo: [claudeBoss.id, 'ninguem', codexBoss.id] }, false, callerOf(codexBoss)))!.profile;
    expect(varios.reportsTo).toEqual([codexBoss.id]);
    // O gestor alegado não ganhou ninguém na equipe.
    const equipe = (await svc.directory()).people.filter((p) => p.reportsTo.includes(claudeBoss.id));
    expect(equipe).toEqual([]);
  });

  it('sem reportsTo no pedido também vale quem chama; gestor que não pode contratar, ou conversa sem ficha, não contrata', async () => {
    const svc = service();
    const codexBoss = await boss(svc, 'Gestor Sem Reports', { engine: 'codex' });
    const hired = (await svc.hire('proj-id', { ...hireBody, name: 'Sem Reports' }, false, callerOf(codexBoss)))!.profile;
    expect(hired).toMatchObject({ reportsTo: [codexBoss.id], hiredBy: codexBoss.id, engine: 'codex' });
    const semPoder = await boss(svc, 'Codex Sem Poder', { engine: 'codex', canHire: false });
    await expect(svc.hire('proj-id', { ...hireBody, name: 'Nao', reportsTo: [codexBoss.id] }, false, callerOf(semPoder))).rejects.toThrow('só um funcionário com permissão de contratar');
    await expect(svc.hire('proj-id', { ...hireBody, name: 'Nao', reportsTo: [codexBoss.id] }, false, { staffId: null, engine: 'claude' })).rejects.toThrow('com ficha');
    await expect(svc.hire('proj-id', { ...hireBody, name: 'Nao' }, false, { staffId: 'nao-existe', engine: 'codex' })).rejects.toThrow('gestor não encontrado');
  });

  it('Claude com token em 127.0.0.1 também não se passa por outro: o contratado é dele, e Claude contratando Claude não ganha a trava do Codex', async () => {
    const svc = service();
    const a = await boss(svc, 'Claude A');
    const b = await boss(svc, 'Claude B', { autonomy: 'bypassPermissions' });
    const hired = (await svc.hire('proj-id', { ...hireBody, name: 'De A', reportsTo: [b.id], engine: 'claude' }, false, callerOf(a)))!.profile;
    expect(hired).toMatchObject({ reportsTo: [a.id], hiredBy: a.id, engine: 'claude', autonomy: 'auto' }); // teto: a autonomia de quem chama, não a do alegado
    expect(await readSeal(path.join(root, 'run'), projectPath, hired.id)).toBeNull();
    // O token de uma conversa do Codex vale as regras de gestor Codex mesmo em 127.0.0.1.
    const codexBoss = await boss(svc, 'Codex Por Token', { engine: 'codex' });
    const sub = (await svc.hire('proj-id', { ...hireBody, name: 'Do Codex', reportsTo: [a.id], engine: 'claude' }, false, callerOf(codexBoss)))!.profile;
    expect(sub).toMatchObject({ reportsTo: [codexBoss.id], autonomy: 'manual' });
    // Pelo navegador (o dono), o `caller` não entra: o pedido vale como sempre.
    const dono = (await svc.hire('proj-id', { ...hireBody, name: 'Do Dono', reportsTo: [b.id], engine: 'claude' }, true, callerOf(a)))!.profile;
    expect(dono).toMatchObject({ reportsTo: [b.id], autonomy: 'bypassPermissions' });
  });

  it('mayReach: a sandbox só fala com a própria conversa e com as de quem reporta a ela', async () => {
    const svc = service();
    const gestor = await boss(svc, 'Gestor Reach', { engine: 'codex' });
    const outro = await boss(svc, 'Outro Reach', { engine: 'codex' });
    const sub = (await svc.hire('proj-id', { ...hireBody, name: 'Sub Reach', reportsTo: [gestor.id], launch: false }, false, callerOf(gestor)))!.profile;
    const alheio = (await svc.hire('proj-id', { ...hireBody, name: 'Alheio Reach', reportsTo: [outro.id], launch: false }, false, callerOf(outro)))!.profile;
    // As conversas ficam gravadas na ficha (o chatSpawn faz isso ao abrir).
    await saveProfile(projectPath, { ...(await readProfile(projectPath, sub.id))!, sessions: [{ id: 'sess-sub', startedAt: 'x' }] });
    await saveProfile(projectPath, { ...(await readProfile(projectPath, alheio.id))!, sessions: [{ id: 'sess-alheio', startedAt: 'x' }] });
    await saveProfile(projectPath, { ...(await readProfile(projectPath, gestor.id))!, sessions: [{ id: `sess-${gestor.id}`, startedAt: 'x' }, { id: 'sess-gestor-velha', startedAt: 'x' }] });
    const me = callerOf(gestor);
    const may = (target: { sessionId: string | null; staffId: string | null }, caller: Who = me) => svc.mayReach('proj-id', caller, target);
    // A própria conversa (a do token), com ou sem o funcionário dela junto.
    expect(await may({ sessionId: me.sessionId, staffId: null })).toBe(true);
    expect(await may({ sessionId: me.sessionId, staffId: gestor.id })).toBe(true);
    expect(await may({ sessionId: me.sessionId, staffId: alheio.id })).toBe(false);
    // Conversa de quem reporta a ele, ou uma nova dele; de quem não reporta, não.
    expect(await may({ sessionId: 'sess-sub', staffId: sub.id })).toBe(true);
    expect(await may({ sessionId: 'sess-sub', staffId: null })).toBe(true);
    expect(await may({ sessionId: null, staffId: sub.id })).toBe(true);
    expect(await may({ sessionId: 'sess-sub', staffId: alheio.id })).toBe(false);
    expect(await may({ sessionId: 'sess-alheio', staffId: alheio.id })).toBe(false);
    expect(await may({ sessionId: null, staffId: alheio.id })).toBe(false);
    // Nem outra conversa dele mesmo, nem a de um desconhecido, nem uma conversa nova sem funcionário.
    expect(await may({ sessionId: 'sess-gestor-velha', staffId: null })).toBe(false);
    expect(await may({ sessionId: 'sess-nao-existe', staffId: null })).toBe(false);
    expect(await may({ sessionId: null, staffId: null })).toBe(false);
    expect(await may({ sessionId: null, staffId: gestor.id })).toBe(false);
    // O gestor de fora não alcança o sub dele, e conversa sem ficha não alcança ninguém.
    expect(await may({ sessionId: 'sess-sub', staffId: sub.id }, callerOf(outro))).toBe(false);
    expect(await may({ sessionId: null, staffId: sub.id }, { staffId: null, sessionId: 's-livre', engine: 'codex' })).toBe(false);
    // Projeto que não existe.
    expect(await svc.mayReach('outro-projeto', me, { sessionId: me.sessionId, staffId: null })).toBe(false);
  });

  it('a ficha do Codex cita o 127.0.0.2 (codexUrl) e a do Claude, o 127.0.0.1; os dois mandam o x-myco-token nos curl', async () => {
    const svc = service({ mycoUrl: 'http://127.0.0.1:4849', codexUrl: 'http://127.0.0.2:4849' });
    const codex = await boss(svc, 'Ficha Codex Url', { engine: 'codex' });
    const claude = await boss(svc, 'Ficha Claude Url');
    const spawn = (await svc.chatSpawn('proj-id', null, codex.id))!;
    expect(spawn.codex!.mycoUrl).toBe('http://127.0.0.2:4849');
    expect(spawn.codex!.instructions).toContain('http://127.0.0.2:4849/api/projects/proj-id/staff');
    expect(spawn.codex!.instructions).not.toContain('127.0.0.1');
    expect(spawn.codex!.instructions).toContain('-H "x-myco-token: $MYCO_TOKEN"');
    const md = await fs.readFile(fichaFile(projectPath, claude.id), 'utf8');
    await svc.chatSpawn('proj-id', null, claude.id);
    const mdClaude = await fs.readFile(fichaFile(projectPath, claude.id), 'utf8');
    expect(md.length).toBeGreaterThan(0);
    expect(mdClaude).toContain('http://127.0.0.1:4849/api/projects/proj-id/staff');
    expect(mdClaude).not.toContain('127.0.0.2');
    expect(mdClaude).toContain('-H "x-myco-token: $MYCO_TOKEN"');
    // Sem codexUrl, o do Claude (os testes e quem não configura).
    const sem = service({ mycoUrl: 'http://127.0.0.1:4850' });
    expect((await sem.chatSpawn('proj-id', null, codex.id))!.codex!.mycoUrl).toBe('http://127.0.0.1:4850');
  });
});
