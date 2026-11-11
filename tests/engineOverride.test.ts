import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUsage, Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { ChatManager } from '../server/chat/manager';
import { StaffService, type StaffServiceOptions } from '../server/staff/service';
import { readProfile } from '../server/staff/store';
import { UsageStopError } from '../server/usageStop';

// Conversa no motor/modelo secundário (`engineOverride`): a conversa nova monta o motor dele, a sessão guarda o override (continue e
// reabrir seguem nele), o plano B do Codex não roda, e a ficha no disco não muda. Fakes no estilo de tests/codexEngine.test.ts.

/** Cada `spawn` devolve um processo falso novo: `emit` simula o stdout, `close` o fim. */
function fakeCodex() {
  const runs: Array<{
    cmd: string;
    args: string[];
    prompt: () => string;
    emit: (ev: object) => void;
    close: (code?: number | null) => void;
    child: EventEmitter;
  }> = [];
  const spawnImpl = (cmd: string, args: string[]) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 5252 + runs.length });
    let prompt = '';
    stdin.on('data', (d: Buffer) => (prompt += d.toString()));
    runs.push({
      cmd,
      args,
      prompt: () => prompt,
      emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'),
      close: (code = 0) => void child.emit('close', code),
      child,
    });
    return child as never;
  };
  return { runs, spawnImpl, last: () => runs[runs.length - 1]! };
}
type FakeRuns = ReturnType<typeof fakeCodex>;

let root: string;
let projectPath: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-override-'));
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

const base = { role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false };
const SECUNDARIO = { engine: 'codex', model: 'gpt-6-sol' } as const;

const tick = () => new Promise((r) => setTimeout(r, 15));
const optionOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const configOf = (args: string[], key: string) =>
  args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : [])).find((c) => c.startsWith(`${key}=`));
const fixture = async (name: string) =>
  (await fs.readFile(path.join(process.cwd(), 'tests', 'fixtures', 'codex', `${name}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

/** O turno do Codex acaba e a execução sai (como o `codex exec` faz). */
async function acabaTurno(run: FakeRuns['runs'][number]) {
  run.emit({ type: 'thread.started', thread_id: 'abcdef12-3456' });
  run.emit({ type: 'turn.completed', usage: {} });
  await tick();
  run.close(0);
  await tick();
}

/** Um manager com o serviço de verdade (a ficha em disco) e o `codex` falso; o `claude` falso também passa por aqui. */
function managerWith(svc: StaffService, f: FakeRuns, codexModels?: () => Promise<Array<{ slug: string }>>) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const m = new ChatManager({
    transcriptsDir: root,
    usageFile: path.join(root, 'usage-override.json'),
    listLive: async () => [],
    resolve: (projectId, sessionId, staffId, forkFrom, engineOverride) => svc.chatSpawn(projectId, sessionId, staffId, forkFrom, engineOverride),
    spawnImpl: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return f.spawnImpl(cmd, args);
    },
    codexModels,
  });
  return { m, calls };
}

describe('conversa no motor secundário (engineOverride)', () => {
  it('conversa nova numa ficha Claude, com override do Codex: roda no Codex com o modelo do override, sem o esforço da ficha, e a sessão diz que é o secundário', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Override Claude', model: 'sonnet', effort: 'high' }, true))!.profile;
    const f = fakeCodex();
    const { m, calls } = managerWith(svc, f);
    const cid = await m.send('proj-id', null, p.id, 'oi', undefined, [], [], false, undefined, SECUNDARIO);
    await tick();
    expect(calls[0]!.cmd).toBe('codex');
    expect(optionOf(calls[0]!.args, '-m')).toBe('gpt-6-sol');
    expect(configOf(calls[0]!.args, 'model_reasoning_effort')).toBeUndefined(); // effort ausente = padrão do Codex, não o "high" da ficha
    // No Windows as instruções da ficha vão no começo do prompt (ver instructionsInArgv): confere só o fim da mensagem.
    expect(f.last().prompt().endsWith('oi')).toBe(true);
    const snap = await m.snapshot('proj-id', cid);
    expect(snap.fallback).toEqual({ engine: 'codex', model: 'gpt-6-sol' });
    expect(snap.live?.state).toMatchObject({ model: 'gpt-6-sol' });
    expect(snap.live?.state.effort ?? null).toBeNull();
    // A ficha no disco segue a de Claude: o override não grava nada nela.
    const after = (await readProfile(projectPath, p.id))!;
    expect(after.engine).toBeUndefined();
    expect(after).toMatchObject({ model: 'sonnet', effort: 'high' });
    await acabaTurno(f.last());
    await m.stopAll();
  });

  it('continue e reabrir mantêm o motor: a mensagem seguinte, com a sessão fechada, sai no Codex com o mesmo modelo', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Override Continue', model: 'sonnet' }, true))!.profile;
    const f = fakeCodex();
    const { m, calls } = managerWith(svc, f);
    const cid = await m.send('proj-id', null, p.id, 'primeira', undefined, [], [], false, undefined, SECUNDARIO);
    await tick();
    await acabaTurno(f.last());
    // Continue: a mensagem seguinte retoma a thread no Codex, com o mesmo modelo.
    await m.send('proj-id', cid, p.id, 'segunda');
    await tick();
    expect(f.runs[1]!.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(optionOf(f.last().args, '-m')).toBe('gpt-6-sol');
    await acabaTurno(f.last());
    // Reabrir: fechou tudo; a mensagem reabre a sessão com o override guardado (não pelo motor da ficha).
    await m.stopAll();
    await m.send('proj-id', cid, p.id, 'terceira');
    await tick();
    expect(calls.every((c) => c.cmd === 'codex')).toBe(true);
    expect(optionOf(f.last().args, '-m')).toBe('gpt-6-sol');
    await acabaTurno(f.last());
    await m.stopAll();
  });

  it('setOverride numa conversa da ficha: o continue, com a sessão fechada, sai no motor do override (ponta a ponta)', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Override Setado', model: 'sonnet' }, true))!.profile;
    const f = fakeCodex();
    const { m, calls } = managerWith(svc, f);
    const cid = await m.send('proj-id', null, p.id, 'primeira');
    await tick();
    expect(calls[0]!.cmd).toBe('claude');
    // Fecha o processo do Claude (o fake não sai sozinho) e a conversa fica fechada.
    f.last().child.emit('exit', 0);
    await tick();
    await m.stopAll();
    // Depois do override (o que o boot faz para a tarefa que trocou de motor), o continue da conversa segue nele.
    m.setOverride(cid, SECUNDARIO);
    // Sem esperar: o continue só termina quando o turno acaba, e o fake de Claude não fecha o turno.
    void m.continueChat('proj-id', cid, p.id);
    // Espera o spawn (com a suíte cheia, 15 ms não bastam): até 1,5 s, conferindo a cada tick.
    for (let i = 0; i < 100 && calls.length < 2; i++) await tick();
    expect(calls.at(-1)!.cmd).toBe('codex');
    expect(optionOf(f.last().args, '-m')).toBe('gpt-6-sol');
    await acabaTurno(f.last());
    await m.stopAll();
  });

  it('a trava de consumo confere o motor da conversa: Claude→Codex não cai na trava do Claude; Codex→Claude respeita a do Claude', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const high = async (): Promise<AccountUsage> => ({ tapInstalled: true, updatedAt: future, limits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: future }] });
    const svc = service({ readUsage: high });
    const claude = (await svc.hire('proj-id', { ...base, name: 'Trava Override Claude' }, true))!.profile;
    // Ficha Claude com o Claude estourado: a conversa no Codex passa; a no Claude é barrada.
    await expect(svc.checkUsage('proj-id', { staffId: claude.id, engine: 'codex' })).resolves.toBeUndefined();
    await expect(svc.checkUsage('proj-id', { staffId: claude.id })).rejects.toBeInstanceOf(UsageStopError);
    // Ficha Codex (fora da trava do Claude), com override Claude: a trava do Claude vale para essa conversa.
    const codex = (await svc.hire('proj-id', { ...base, name: 'Trava Override Codex', engine: 'codex' }, true))!.profile;
    await expect(svc.checkUsage('proj-id', { staffId: codex.id })).resolves.toBeUndefined();
    await expect(svc.checkUsage('proj-id', { staffId: codex.id, engine: 'claude' })).rejects.toBeInstanceOf(UsageStopError);
  });

  it('pré-checagem da troca: as barreiras da conversa no motor do override, sem gravar nada (Claude estourado não barra o Codex; Codex desligado barra)', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const high = async (): Promise<AccountUsage> => ({ tapInstalled: true, updatedAt: future, limits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: future }] });
    const svc = service({ readUsage: high });
    const p = (await svc.hire('proj-id', { ...base, name: 'Pre Checagem' }, true))!.profile;
    await expect(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO)).resolves.toBeUndefined();
    await expect(svc.assertOverrideRunnable('proj-id', p.id, { engine: 'claude', model: 'sonnet' })).rejects.toBeInstanceOf(UsageStopError);
    const off = service({ readUsage: noUsage, codexEnabled: async () => false });
    await expect(off.assertOverrideRunnable('proj-id', p.id, SECUNDARIO)).rejects.toThrow(/desligado nas configurações/);
    // Nada gravado: a ficha segue a de Claude.
    expect((await readProfile(projectPath, p.id))!.engine).toBeUndefined();
  });

  it('override com autonomia: a conversa abre no modo dele, não no da ficha', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Modo Override', autonomy: 'plan' }, true))!.profile;
    const f = fakeCodex();
    const { m, calls } = managerWith(svc, f);
    await m.send('proj-id', null, p.id, 'oi', undefined, [], [], false, undefined, { engine: 'claude', model: 'sonnet', autonomy: 'acceptEdits' });
    await tick();
    expect(calls[0]!.cmd).toBe('claude');
    expect(optionOf(calls[0]!.args, '--permission-mode')).toBe('acceptEdits');
    f.last().child.emit('exit', 0);
    await tick();
    await m.stopAll();
  });

  it('sem override nada muda: a conversa segue na ficha (Claude, com o modelo e o esforço dela)', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Sem Override', model: 'sonnet', effort: 'high' }, true))!.profile;
    const f = fakeCodex();
    const { m, calls } = managerWith(svc, f);
    const cid = await m.send('proj-id', null, p.id, 'oi');
    await tick();
    expect(calls[0]!.cmd).toBe('claude');
    expect(optionOf(calls[0]!.args, '--model')).toBe('sonnet');
    expect(optionOf(calls[0]!.args, '--effort')).toBe('high');
    expect((await m.snapshot('proj-id', cid)).fallback).toBeUndefined();
    f.last().child.emit('exit', 0);
    await m.stopAll();
  });

  it('com override, o plano B não roda: o modelo que a conta recusa vira o erro da conversa, sem catálogo nem segunda execução', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Override Sem Plano B', model: 'sonnet' }, true))!.profile;
    const f = fakeCodex();
    let consultou = false;
    const { m } = managerWith(svc, f, async () => {
      consultou = true;
      return [{ slug: 'gpt-6-sol' }];
    });
    const cid = await m.send('proj-id', null, p.id, 'oi', undefined, [], [], false, undefined, { engine: 'codex', model: 'gpt-6.1-sol' });
    await tick();
    for (const ev of await fixture('falha-modelo')) f.last().emit(ev);
    await tick();
    f.last().close(1);
    await tick();
    await tick();
    expect(f.runs).toHaveLength(1);
    expect(consultou).toBe(false);
    expect((await m.snapshot('proj-id', cid)).live!.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error', text: 'modelo secundário gpt-6.1-sol recusado pelo Codex' });
    expect(m.isBusy(cid)).toBe(false);
    await m.stopAll();
  });

  it('trocar modelo ou esforço numa conversa do secundário é recusado, e a ficha não recebe a escolha', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Override Ajustes', model: 'sonnet' }, true))!.profile;
    const f = fakeCodex();
    const { m } = managerWith(svc, f);
    const cid = await m.send('proj-id', null, p.id, 'oi', undefined, [], [], false, undefined, SECUNDARIO);
    await tick();
    await expect(m.settings('proj-id', cid, p.id, { model: 'gpt-6-luna' })).rejects.toThrow('motor secundário');
    await expect(m.settings('proj-id', cid, p.id, { effort: 'low' })).rejects.toThrow('motor secundário');
    expect((await readProfile(projectPath, p.id))!.sessions.some((s) => s.id === cid && s.model)).toBe(false);
    await acabaTurno(f.last());
    await m.stopAll();
  });
});

describe('montagem do secundário na ficha (chatSpawn)', () => {
  it('ficha do Codex no secundário Claude: roda fora da sandbox, em aceitar edições (o padrão); a ficha segue no Codex', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Override Codex Ficha', engine: 'codex', model: 'gpt-6-sol' }, true))!.profile;
    const spawn = (await svc.chatSpawn('proj-id', null, p.id, undefined, { engine: 'claude', model: 'sonnet' }))!;
    expect(spawn.engine).toBeUndefined();
    expect(optionOf(spawn.args, '--model')).toBe('sonnet');
    expect(optionOf(spawn.args, '--permission-mode')).toBe('acceptEdits');
    expect(spawn.args).not.toContain('--effort');
    expect(await readProfile(projectPath, p.id)).toMatchObject({ engine: 'codex', autonomy: 'acceptEdits', model: 'gpt-6-sol' });
  });

  it('secundário Claude de ficha Codex: no máximo aceitar edições e no teto da ficha (plano e manual ficam como estão)', async () => {
    const svc = service();
    const modoDe = async (autonomy: 'plan' | 'manual' | 'auto', o: { autonomy?: 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'bypassPermissions' } = {}) => {
      const p = (await svc.hire('proj-id', { ...base, name: `Teto ${autonomy} ${o.autonomy ?? 'padrao'}`, engine: 'codex', autonomy }, true))!.profile;
      const spawn = (await svc.chatSpawn('proj-id', null, p.id, undefined, { engine: 'claude', model: 'sonnet', ...o }))!;
      return optionOf(spawn.args, '--permission-mode');
    };
    expect(await modoDe('plan')).toBe('plan'); // ficha de plano: fica de plano, mesmo sem o modo da conversa
    expect(await modoDe('plan', { autonomy: 'acceptEdits' })).toBe('plan');
    expect(await modoDe('manual', { autonomy: 'auto' })).toBe('manual'); // ficha manual: fica manual
    expect(await modoDe('auto')).toBe('acceptEdits'); // padrão
    expect(await modoDe('auto', { autonomy: 'bypassPermissions' })).toBe('acceptEdits'); // sem sandbox: nunca acima de aceitar edições
    expect(await modoDe('auto', { autonomy: 'auto' })).toBe('acceptEdits');
    expect(await modoDe('auto', { autonomy: 'manual' })).toBe('manual'); // modo desconhecido (manual) segue manual
  });

  it('o esforço ultra do secundário Claude é recusado (só existe no Codex)', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Override Ultra', model: 'sonnet' }, true))!.profile;
    await expect(svc.chatSpawn('proj-id', null, p.id, undefined, { engine: 'claude', model: 'sonnet', effort: 'ultra' })).rejects.toThrow('O esforço ultra só existe no Codex');
  });
});
