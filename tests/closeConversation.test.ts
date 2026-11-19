import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { AutoContinue } from '../server/chat/autoContinue';
import { ChatManager, CloseRefusedError, type ChatManagerOptions } from '../server/chat/manager';
import { CodexProcess } from '../server/chat/codexProcess';
import { isAlive } from '../server/chat/registry';
import { CLOSED_BY_YOU, TaskService } from '../server/tasks';

// Fechar a conversa (rota /api/chat/:id/close e o arquivar): parada fecha na hora e os MCPs filhos morrem; trabalhando pede confirmação e
// confere a ação cortada como o reinício; a tarefa vai para Aguardar antes da saída (sem entrega, sem erro); arquivar fecha o processo.
// Claude e Codex. Processos falsos, e dois de verdade (árvore com filho) para provar que o filho morre.

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-close-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-17T10:00:00Z');
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(15);

/** O claude falso: sai quando o stdin fecha (como o de verdade), com código 1 (o `taskkill` do Windows). `stuck`: ignora o fechamento. */
function fakeClaude(pid: number, stuck = false) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid });
  const written: Array<{ type?: string; message?: { content?: Array<{ text?: string }> } }> = [];
  stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
  if (!stuck) stdin.on('end', () => setImmediate(() => proc.emit('exit', 1)));
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  const texts = () => written.filter((w) => w.type === 'user').flatMap((w) => (w.message?.content ?? []).map((c) => c.text ?? ''));
  return { proc, emit, texts };
}
type Fake = ReturnType<typeof fakeClaude>;

const toolUse = (id: string, name: string, input: object) => ({ type: 'assistant', message: { id: `m-${id}`, model: 'claude', content: [{ type: 'tool_use', id, name, input }] } });
const turnEnd = { type: 'result', is_error: false, result: 'pronto' };

function build(extra: Partial<ChatManagerOptions> = {}) {
  const dir = path.join(root, `m-${++n}`);
  const procs: Fake[] = [];
  const m: ChatManager = new ChatManager({
    transcriptsDir: dir,
    usageFile: path.join(dir, 'usage.json'),
    listLive: async () => [],
    resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: '.', args: [] }),
    spawnImpl: () => {
      const f = fakeClaude(4242 + procs.length);
      procs.push(f);
      return f.proc as never;
    },
    log: () => {},
    ...extra,
  });
  /** Abre a conversa `sid` (de `staffId`, no projeto `projectId`) e deixa o turno dela rodando. */
  const open = async (sid = 'sx', staffId = 'ana', projectId = 'p') => {
    await m.send(projectId, sid, staffId, 'faça a tarefa');
    return procs.at(-1)!;
  };
  /** O mesmo, com o turno já terminado: parada. */
  const idle = async (sid = 'sx', staffId = 'ana', projectId = 'p') => {
    const f = await open(sid, staffId, projectId);
    f.emit(turnEnd);
    await tick();
    return f;
  };
  return { m, procs, dir, open, idle };
}

describe('ChatManager.close: conversa parada', () => {
  it('fecha na hora, sem erro mesmo com a saída em código 1 (taskkill), e uma segunda vez não há o que fechar', async () => {
    const h = build();
    await h.idle();
    expect(await h.m.close('sx')).toEqual({ closed: true, interrupted: false });
    expect(h.m.runningSessionIds()).toEqual([]);
    expect(h.m.attention()).toEqual([]);
    expect(await h.m.close('sx')).toEqual({ closed: false, interrupted: false });
    expect(await h.m.close('nao-existe')).toEqual({ closed: false, interrupted: false });
  });

  it('não avisa a tarefa (`beforeClose` só vale para conversa trabalhando)', async () => {
    const before = vi.fn(async () => {});
    const h = build({ beforeClose: before });
    await h.idle();
    await h.m.close('sx');
    expect(before).not.toHaveBeenCalled();
  });

  it('a conversa volta quando precisarem: a mensagem que o ajuste guardado manda reabre o processo', async () => {
    const h = build();
    await h.idle();
    await h.m.close('sx');
    await h.m.send('p', 'sx', 'ana', 'use o banco novo');
    expect(h.procs).toHaveLength(2);
    expect(h.procs[1]!.texts()).toEqual(['use o banco novo']);
    expect(h.m.runningSessionIds()).toEqual(['sx']);
  });

  it('o despertador agendado não é cancelado ao fechar, e na hora dele reabre a conversa', async () => {
    const clock = { t: T0 };
    const wakeups = new AutoContinue({ file: path.join(root, `wake-${++n}.json`), enabled: async () => true, stopHit: async () => null, knownResets: async () => [], send: (p) => h.m.wakeChat(p), now: () => clock.t, spacingMs: 0, log: () => {} });
    const h = build({ wakeups, now: () => clock.t });
    await h.idle();
    await wakeups.schedule({ projectId: 'p', sessionId: 'sx', staffId: 'ana', at: T0 + MIN, resetsAt: T0 + MIN, text: 'acorde e confira o deploy' });
    await h.m.close('sx');
    expect(await wakeups.get('sx')).toMatchObject({ sessionId: 'sx', at: T0 + MIN });
    clock.t = T0 + MIN + 1;
    await wakeups.tick();
    await vi.waitFor(() => expect(h.procs).toHaveLength(2));
    expect(h.procs[1]!.texts()).toContain('acorde e confira o deploy');
  });
});

describe('ChatManager.close: conversa trabalhando', () => {
  it('sem confirmação recusa (`working`), nada fecha e a tarefa não é avisada', async () => {
    const before = vi.fn(async () => {});
    const h = build({ beforeClose: before });
    await h.open();
    const err = await h.m.close('sx').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseRefusedError);
    expect(err).toMatchObject({ code: 'working', action: undefined });
    expect(h.m.runningSessionIds()).toEqual(['sx']);
    expect(before).not.toHaveBeenCalled();
  });

  it('confirmada, com ação que só mexe no projeto (edição, teste): a tarefa é avisada ANTES da saída, e a saída não vira erro', async () => {
    const order: string[] = [];
    const h = build({
      beforeClose: async (sid) => void order.push(`antes:${sid}`),
      onIdle: (sid, _p, _s, reason) => void order.push(`${reason}:${sid}`),
    });
    const f = await h.open();
    f.emit(toolUse('t1', 'Edit', { file_path: 'a.ts' }));
    f.emit(toolUse('t2', 'Bash', { command: 'npx vitest run' })); // rodando, sem resultado: é o que o fechamento corta
    await tick();
    expect(await h.m.close('sx', { confirm: true })).toEqual({ closed: true, interrupted: true });
    expect(order).toEqual(['antes:sx', 'exit:sx']);
    expect(h.m.runningSessionIds()).toEqual([]);
    expect(h.m.attention()).toEqual([]); // sem "o claude saiu com código 1"
    expect(h.m.turnCapOf('sx')).toBeNull(); // nem "parou no meio": fechou porque você pediu
  });

  it('confirmada, mas a ação que ficaria pela metade mexe fora do projeto (push, deploy, MCP que escreve): não fecha e diz qual', async () => {
    const before = vi.fn(async () => {});
    const h = build({ beforeClose: before });
    const f = await h.open();
    f.emit(toolUse('t1', 'Bash', { command: 'git push origin main' }));
    await tick();
    const err = await h.m.close('sx', { confirm: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseRefusedError);
    expect(err).toMatchObject({ code: 'uncertain', action: 'git push origin main' });
    expect((err as Error).message).toContain('git push origin main');
    expect(h.m.runningSessionIds()).toEqual(['sx']);
    expect(before).not.toHaveBeenCalled();
    // O turno acaba: sem ação pela metade, fecha.
    f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    f.emit(turnEnd);
    await tick();
    expect(await h.m.close('sx')).toEqual({ closed: true, interrupted: false });
  });

  it('o corte de MCP que escreve também recusa; o que só lê não', async () => {
    const h = build();
    const f = await h.open();
    f.emit(toolUse('t1', 'mcp__myco-ssh__ssh_exec', { command: 'systemctl restart nginx' }));
    await tick();
    await expect(h.m.close('sx', { confirm: true })).rejects.toMatchObject({ code: 'uncertain' });
    f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    f.emit(toolUse('t2', 'mcp__myco-ssh__ssh_ler', { path: '/etc/hosts' }));
    await tick();
    expect(await h.m.close('sx', { confirm: true })).toEqual({ closed: true, interrupted: true });
  });

  it('pedido de permissão sem resposta conta como trabalhando; a ferramenta que espera a permissão não rodou, então não é corte', async () => {
    const h = build();
    const f = await h.open();
    f.emit(turnEnd);
    await tick();
    f.emit(toolUse('t1', 'Bash', { command: 'git push' }));
    f.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1', input: { command: 'git push' } } });
    await tick();
    await expect(h.m.close('sx')).rejects.toMatchObject({ code: 'working' });
    expect(await h.m.close('sx', { confirm: true })).toEqual({ closed: true, interrupted: true });
  });

  it('algo em segundo plano (agent, comando) é incerto mesmo confirmado, e sai da lista quando termina', async () => {
    const h = build();
    const f = await h.open();
    f.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', subagent_type: 'executor', description: 'Servidor: cor da sala' }] });
    f.emit(turnEnd); // o turno acabou, o executor continua
    await tick();
    await expect(h.m.close('sx')).rejects.toMatchObject({ code: 'working' });
    await expect(h.m.close('sx', { confirm: true })).rejects.toMatchObject({ code: 'uncertain', action: 'em segundo plano: executor: Servidor: cor da sala' });
    expect(h.m.runningSessionIds()).toEqual(['sx']);
    f.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await tick();
    expect(await h.m.close('sx')).toEqual({ closed: true, interrupted: false });
  });

  describe('subagents (a mesma checagem do reinício)', () => {
    const DESC = 'Codex agents: geração';
    const agentUse = (id: string) => toolUse(id, 'Agent', { subagent_type: 'executor', description: DESC });
    const subCall = (name: string, input: unknown) => JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'ms', content: [{ type: 'tool_use', id: 'tsub', name, input }] } });
    /** O transcript do subagent da chamada `toolUseId`, onde o Claude Code o grava: ao lado do transcript da sessão. */
    async function subagent(dir: string, sessionId: string, toolUseId: string, lines: string[]) {
      const sub = path.join(dir, 'p', sessionId, 'subagents');
      await fs.mkdir(sub, { recursive: true });
      await fs.writeFile(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'executor', toolUseId, spawnDepth: 1 }));
      await fs.writeFile(path.join(sub, 'agent-a1.jsonl'), `${lines.join('\n')}\n`);
    }

    it('o subagent que só editou e rodou teste não impede; o que deu push, ou sem transcript, sim', async () => {
      const h = build();
      await subagent(h.dir, 'sa', 'toolu_a', [subCall('Edit', { file_path: 'a.ts' }), subCall('PowerShell', { command: 'npx tsc --noEmit' })]);
      await subagent(h.dir, 'sb', 'toolu_b', [subCall('Edit', { file_path: 'a.ts' }), subCall('Bash', { command: 'git push' })]);
      for (const sid of ['sa', 'sb', 'sc']) {
        const f = await h.open(sid);
        f.emit(agentUse(`toolu_${sid.slice(1)}`));
      }
      await tick();
      expect(await h.m.close('sa', { confirm: true })).toEqual({ closed: true, interrupted: true });
      await expect(h.m.close('sb', { confirm: true })).rejects.toMatchObject({ code: 'uncertain', action: DESC });
      await expect(h.m.close('sc', { confirm: true })).rejects.toMatchObject({ code: 'uncertain', action: DESC }); // sem transcript do subagent
      expect(h.m.runningSessionIds().sort()).toEqual(['sb', 'sc']);
    });
  });

  it('o processo que não sai a tempo não deixa a rota esperando: erro, e a conversa segue aberta', async () => {
    const stuck: Fake[] = [];
    const h = build({
      closeWaitMs: 60,
      spawnImpl: () => {
        const f = fakeClaude(7000 + stuck.length, true);
        stuck.push(f);
        return f.proc as never;
      },
    });
    await h.m.send('p', 'sx', 'ana', 'oi');
    stuck[0]!.emit(turnEnd);
    await tick();
    await expect(h.m.close('sx')).rejects.toThrow('não fechou a tempo');
    expect(h.m.runningSessionIds()).toEqual(['sx']);
    stuck[0]!.proc.emit('exit', 0); // sai depois: sem pendência solta
    await tick();
    expect(h.m.runningSessionIds()).toEqual([]);
  });
});

describe('ChatManager.closeForArchive: arquivar também fecha o processo', () => {
  it('conversa parada: fecha; trabalhando sem confirmação: recusa; com confirmação: fecha; sem processo: nada', async () => {
    const h = build();
    await h.idle('s1');
    expect(await h.m.closeForArchive({ kind: 'conversation', id: 's1' })).toEqual({ closed: 1, working: 0 });
    await h.open('s2');
    await expect(h.m.closeForArchive({ kind: 'conversation', id: 's2' })).rejects.toMatchObject({ code: 'working' });
    expect(h.m.runningSessionIds()).toEqual(['s2']);
    expect(await h.m.closeForArchive({ kind: 'session', id: 's2' }, true)).toEqual({ closed: 1, working: 0 }); // sessão sem ficha (freela): o mesmo caminho
    expect(await h.m.closeForArchive({ kind: 'conversation', id: 's3' })).toEqual({ closed: 0, working: 0 });
  });

  it('trabalhando com efeito incerto: recusa mesmo confirmada (quem chama não arquiva)', async () => {
    const h = build();
    const f = await h.open('s1');
    f.emit(toolUse('t1', 'Bash', { command: 'ssh deploy@vps ./release.sh' }));
    await tick();
    await expect(h.m.closeForArchive({ kind: 'conversation', id: 's1' }, true)).rejects.toMatchObject({ code: 'uncertain' });
    expect(h.m.runningSessionIds()).toEqual(['s1']);
  });

  it('funcionário (`staff:<id>`): fecha as conversas paradas dele, deixa as que trabalham e as dos outros', async () => {
    const h = build();
    await h.idle('a1', 'ana', 'p');
    await h.idle('a2', 'ana', 'q'); // a ficha de arquivar vale para o funcionário em qualquer projeto
    await h.open('a3', 'ana', 'p'); // trabalhando
    await h.idle('b1', 'bia', 'p');
    expect(await h.m.closeForArchive({ kind: 'session', id: 'staff:ana' })).toEqual({ closed: 2, working: 1 });
    expect(h.m.runningSessionIds().sort()).toEqual(['a3', 'b1']);
  });

  it('projeto: fecha as conversas paradas dele (de qualquer funcionário, ou sem ficha) e só elas', async () => {
    const h = build();
    await h.idle('a1', 'ana', 'p');
    await h.idle('b1', 'bia', 'p');
    await h.open('c1', 'ana', 'p');
    await h.idle('d1', 'ana', 'q');
    expect(await h.m.closeForArchive({ kind: 'project', id: 'p' })).toEqual({ closed: 2, working: 1 });
    expect(h.m.runningSessionIds().sort()).toEqual(['c1', 'd1']);
  });
});

// ---- processos de verdade: o filho (o MCP) tem de morrer junto ----

const TREE = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[1], String(kid.pid));
process.stdin.on('data', () => console.log(JSON.stringify({ type: 'result', is_error: false })));
setInterval(() => {}, 1000);
`;

/** Um "claude" de verdade (node) com um filho (o "MCP") que não sai quando o stdin fecha: só encerrar a árvore o derruba. */
function treeSpawn(pidFile: string) {
  return (_cmd: string, _args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) =>
    spawn(process.execPath, ['-e', TREE, pidFile], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }) as never;
}

const kidOf = async (pidFile: string) => {
  let pid = 0;
  await vi.waitFor(async () => {
    pid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
  });
  return pid;
};
const gone = (pid: number) => vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 8_000, interval: 50 });

describe('o processo e o MCP filho morrem de verdade', () => {
  it('Claude parado que não sai sozinho: a árvore inteira cai (CLI e MCP)', async () => {
    const pidFile = path.join(root, `kid-${++n}.pid`);
    const h = build({ spawnImpl: treeSpawn(pidFile), stopGraceMs: 150, closeWaitMs: 8_000 });
    await h.m.send('p', 'sx', 'ana', 'oi');
    const kid = await kidOf(pidFile);
    try {
      await vi.waitFor(() => expect(h.m.isWorking('sx')).toBe(false), { timeout: 5_000 });
      expect(isAlive(kid)).toBe(true);
      expect(await h.m.close('sx')).toEqual({ closed: true, interrupted: false });
      expect(h.m.runningSessionIds()).toEqual([]);
      await gone(kid);
    } finally {
      try {
        process.kill(kid, 'SIGKILL');
      } catch {
        // já morreu
      }
    }
  }, 30_000);

  it('Codex com execução em andamento (confirmada): a execução e o filho dela caem', async () => {
    const pidFile = path.join(root, `kid-${++n}.pid`);
    const profile = { cwd: root, sessionId: 'sess-1', permissionMode: 'default', secrets: { projectPath: root, home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };
    const chat = new CodexProcess({ ...profile, spawnImpl: treeSpawn(pidFile) as never });
    chat.start();
    chat.send('oi');
    const kid = await kidOf(pidFile);
    try {
      expect(chat.working).toBe(true);
      expect(isAlive(kid)).toBe(true);
      await chat.stopAndWait();
      expect(chat.snapshot().state).toMatchObject({ running: false, error: null });
      await gone(kid);
    } finally {
      try {
        process.kill(kid, 'SIGKILL');
      } catch {
        // já morreu
      }
    }
  }, 30_000);
});

// ---- Codex pelo gerente: a mesma regra ----

function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void; close: (code?: number | null) => void; child: EventEmitter }> = [];
  const spawnImpl = () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    stdin.on('data', () => {});
    // Sem pid: o gerente não tenta encerrar um processo de verdade; quem fecha a execução é o teste.
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough() });
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: (code = 0) => void child.emit('close', code), child });
    return child as never;
  };
  return { runs, spawnImpl, last: () => runs.at(-1)! };
}

function codexBuild(extra: Partial<ChatManagerOptions> = {}) {
  const f = fakeCodex();
  const dir = path.join(root, `c-${++n}`);
  const m: ChatManager = new ChatManager({
    transcriptsDir: dir,
    usageFile: path.join(dir, 'usage.json'),
    listLive: async () => [],
    resolve: async (_p, sid) => ({
      sessionId: sid ?? 'codex-1',
      cwd: root,
      args: [],
      engine: 'codex',
      codex: {
        autonomy: 'acceptEdits',
        model: 'gpt-6-sol',
        effort: 'high',
        instructions: 'Ficha',
        writableRoots: [],
        readOnlyPaths: [],
        agents: [],
        secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') },
        threadId: 'thread-0001-aaaa',
        threadFile: path.join(dir, 'codex-thread.json'),
        mycoUrl: 'http://127.0.0.2:4848',
      },
    }),
    spawnImpl: f.spawnImpl,
    log: () => {},
    ...extra,
  });
  /** O turno do Codex rodando (a execução aberta). */
  const open = async (sid = 'cx') => {
    await m.send('p', sid, 'cris', 'faça a tarefa');
    await vi.waitFor(() => expect(f.runs.length).toBeGreaterThan(0));
    f.last().emit({ type: 'turn.started' });
    await tick();
  };
  const item = (id: string, type: string, extra: object) => f.last().emit({ type: 'item.started', item: { id, type, status: 'in_progress', ...extra } });
  return { f, m, open, item };
}

describe('Codex: a mesma regra de fechar', () => {
  it('parado (turno terminou, sem processo entre as mensagens): fecha a conversa', async () => {
    const h = codexBuild();
    await h.open();
    h.f.last().emit({ type: 'turn.completed' });
    h.f.last().close(0);
    await vi.waitFor(() => expect(h.m.isWorking('cx')).toBe(false));
    expect(await h.m.close('cx')).toEqual({ closed: true, interrupted: false });
    expect(h.m.runningSessionIds()).toEqual([]);
    expect(h.m.attention()).toEqual([]);
  });

  it('trabalhando sem confirmação: recusa; com confirmação e ação local: avisa a tarefa antes, fecha e não vira erro', async () => {
    const order: string[] = [];
    const h = codexBuild({ beforeClose: async (sid) => void order.push(`antes:${sid}`), onIdle: (sid, _p, _s, reason) => void order.push(`${reason}:${sid}`) });
    await h.open();
    h.item('i1', 'command_execution', { command: 'npx vitest run', aggregated_output: '', exit_code: null });
    await tick();
    await expect(h.m.close('cx')).rejects.toMatchObject({ code: 'working' });
    expect(h.m.runningSessionIds()).toEqual(['cx']);
    const closing = h.m.close('cx', { confirm: true });
    await tick();
    h.f.last().close(1); // a execução cai (o fechamento a encerra)
    expect(await closing).toEqual({ closed: true, interrupted: true });
    // O Codex ainda diz "fim do turno" ao ser parado (como no Parar): o que importa é que a tarefa foi avisada antes de qualquer fim.
    expect(order[0]).toBe('antes:cx');
    expect(order.at(-1)).toBe('exit:cx');
    expect(h.m.attention()).toEqual([]);
    expect(h.m.runningSessionIds()).toEqual([]);
  });

  it('com efeito fora do projeto pela metade (push): recusa mesmo confirmada, com a ação', async () => {
    const before = vi.fn(async () => {});
    const h = codexBuild({ beforeClose: before });
    await h.open();
    h.item('i1', 'command_execution', { command: 'git push origin main', aggregated_output: '', exit_code: null });
    await tick();
    await expect(h.m.close('cx', { confirm: true })).rejects.toMatchObject({ code: 'uncertain', action: 'git push origin main' });
    expect(h.m.runningSessionIds()).toEqual(['cx']);
    expect(before).not.toHaveBeenCalled();
    h.f.last().close(0); // limpa a execução
  });

  it('arquivar a conversa e o funcionário também fecha a do Codex', async () => {
    const h = codexBuild();
    await h.open();
    h.f.last().emit({ type: 'turn.completed' });
    h.f.last().close(0);
    await vi.waitFor(() => expect(h.m.isWorking('cx')).toBe(false));
    expect(await h.m.closeForArchive({ kind: 'session', id: 'staff:cris' })).toEqual({ closed: 1, working: 0 });
    expect(h.m.runningSessionIds()).toEqual([]);
  });
});

// ---- a tarefa: para Aguardar, sem entrega e sem erro ----

const people: Record<string, StaffProfile> = {
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
};

/** O serviço de tarefas com um gerente de conversas de verdade (processos falsos) ligado como o servidor liga (`beforeClose`, `onIdle`, `isWorking`). */
async function wired(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const chatDir = path.join(dir, 'chats');
  const procs: Fake[] = [];
  const m: ChatManager = new ChatManager({
    transcriptsDir: chatDir,
    usageFile: path.join(chatDir, 'usage.json'),
    listLive: async () => [],
    resolve: async (_p, sid) => ({ sessionId: sid ?? 'new', cwd: '.', args: [] }),
    spawnImpl: () => {
      const f = fakeClaude(4242 + procs.length);
      procs.push(f);
      return f.proc as never;
    },
    beforeClose: (sid) => svc.parkClosed(sid),
    onIdle: (sid, pid, staffId) => void svc.onIdle(sid, pid, staffId).catch(() => {}),
    log: () => {},
  });
  let k = 0;
  const svc: TaskService = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (p, staffId, text) => {
      const sid = `w-${++k}`;
      await m.send(p, sid, staffId, text);
      return sid;
    },
    branchFor: async () => null,
    isWorking: (p, staffId, except) => m.staffWorking(p, staffId, except),
    isSessionWorking: (sid) => m.isWorking(sid),
    sendTo: async (p, sid, staffId, text) => {
      await m.send(p, sid, staffId, text);
      return sid;
    },
    lastText: (sid) => m.lastAssistantText(sid),
    closing: () => m.isClosing(),
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  /** Uma tarefa da Ana, começada: a conversa de trabalho abre e o turno roda. */
  const task = async (title: string) => {
    const t = (await svc.create('p', { title, description: 'Exportar CSV', staffId: 'ana-1', reviewerId: null }))!;
    await svc.start('p', t.id);
    return { id: t.id, work: (await get(t.id)).sessionId! };
  };
  return { m, svc, get, task, procs };
}

describe('a tarefa da conversa fechada', () => {
  it('fechada no meio do turno (confirmado): o card vai para Aguardar com a nota, e a saída do processo não o entrega para revisão nem vira erro', async () => {
    const w = await wired('w-doing');
    const { id, work } = await w.task('Relatório');
    expect(await w.get(id)).toMatchObject({ status: 'doing' });
    await expect(w.m.close(work)).rejects.toMatchObject({ code: 'working' });
    expect(await w.get(id)).toMatchObject({ status: 'doing' }); // recusada: nada mudou
    expect(await w.m.close(work, { confirm: true })).toEqual({ closed: true, interrupted: true });
    await sleep(60); // o `onIdle('exit')` do processo chega ao serviço de tarefas
    const t = await w.get(id);
    expect(t).toMatchObject({ status: 'waiting', waitReason: CLOSED_BY_YOU, queuedAt: null, runId: null });
    expect(t.history.at(-1)).toMatchObject({ status: 'waiting', by: 'you', note: 'conversa fechada por você' });
    expect(w.m.attention()).toEqual([]);
    // O tick (a órfã) não a retoma: ela só volta quando você a pôr em "A fazer".
    await w.svc.tick(new Date(Date.now() + 3_600_000));
    expect((await w.get(id)).status).toBe('waiting');
    expect(w.procs).toHaveLength(1);
  });

  it('o controle: fechar pelo `stop` antigo (sem o aviso) entrega o card para revisão como se tivesse terminado', async () => {
    const w = await wired('w-stop');
    const { id, work } = await w.task('Relatório');
    w.m.stop(work);
    await vi.waitFor(async () => expect((await w.get(id)).status).toBe('review'), { timeout: 3_000 });
  });

  it('a fila do funcionário anda: a próxima tarefa dele começa quando a conversa fechada sai', async () => {
    const w = await wired('w-fila');
    const a = await w.task('Relatório');
    const b = (await w.svc.create('p', { title: 'Próxima', staffId: 'ana-1', reviewerId: null }))!;
    await w.svc.start('p', b.id);
    expect(await w.get(b.id)).toMatchObject({ status: 'todo' }); // espera a vez da Ana
    await w.m.close(a.work, { confirm: true });
    await vi.waitFor(async () => expect((await w.get(b.id)).status).toBe('doing'), { timeout: 3_000 });
    expect((await w.get(a.id)).status).toBe('waiting');
  });

  it('o card de uma tarefa em "A fazer" (planejando) com a conversa trabalhando também vai para Aguardar', async () => {
    const w = await wired('w-planning');
    const { id, work } = await w.task('Relatório');
    const file = path.join(root, 'w-planning', '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    await fs.writeFile(file, JSON.stringify(all.map((t) => (t.id === id ? { ...t, status: 'planning' } : t))));
    expect(await w.svc.parkClosed(work)).toMatchObject({ status: 'waiting', waitReason: CLOSED_BY_YOU });
  });

  it('fica como está: dúvida aberta (a conversa só espera a resposta), revisão, card automático e conversa sem tarefa', async () => {
    const w = await wired('w-fica');
    const { id, work } = await w.task('Relatório');
    const file = path.join(root, 'w-fica', '.myco', 'tasks.json');
    const patch = async (fn: (t: Record<string, unknown>) => Record<string, unknown>) => {
      const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
      await fs.writeFile(file, JSON.stringify(all.map((t) => (t.id === id ? fn(t) : t))));
    };
    // Dúvida aberta com o gestor: a resposta reabre a conversa.
    await patch((t) => ({ ...t, question: { id: 'q1', status: 'open', text: 'posso apagar?', askedAt: new Date().toISOString() } }));
    expect(await w.svc.parkClosed(work)).toBeNull();
    expect((await w.get(id)).status).toBe('doing');
    // Em revisão (já entregue): não é "fazendo".
    await patch((t) => ({ ...t, question: undefined, status: 'review' }));
    expect(await w.svc.parkClosed(work)).toBeNull();
    expect((await w.get(id)).status).toBe('review');
    // Conversa que não é de tarefa nenhuma.
    expect(await w.svc.parkClosed('direta-1')).toBeNull();
  });
});

describe('as rotas (contrato)', () => {
  it('fechar: só do navegador pareado, corpo só com `confirm`, e a recusa sai como 409 com `code` (e `action` se houver)', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const route = /\/close\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(route).toContain("if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club')");
    expect(route).toContain('chats.close(sid!, { confirm: b.confirm })');
    expect(src).toContain('const CloseBody = z.object({ confirm: z.boolean().optional() }).strict();');
    expect(src).toMatch(/err instanceof CloseRefusedError\) return send\(res, 409, \{ error: err\.message, code: err\.code, \.\.\.\(err\.action && \{ action: err\.action \}\) \}\)/);
    // Antes do mapa genérico de ChatError (que também é 409, mas sem `code`).
    expect(src.indexOf('err instanceof CloseRefusedError')).toBeLessThan(src.indexOf('err instanceof ChatError ||'));
  });

  it('arquivar: fecha ANTES de gravar (a recusa não arquiva), só ao arquivar (desarquivar não fecha), e o corpo aceita `confirm`', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const route = /\^\\\/api\\\/archive\$\/,([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(route).toContain('ArchiveBody.safeParse(body)');
    expect(route).toContain('req.archived ? await chats.closeForArchive(req, confirm) : null');
    expect(route.indexOf('closeForArchive')).toBeLessThan(route.indexOf('setArchived(req)'));
    expect(src).toContain('const ArchiveBody = ArchiveRequest.extend({ confirm: z.boolean().optional() });');
  });

  it('o gancho do servidor liga `beforeClose` ao `tasks.parkClosed`', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(src).toMatch(/beforeClose: async \(sid\) => \{\s*await tasks\.parkClosed\(sid\);/);
  });
});
