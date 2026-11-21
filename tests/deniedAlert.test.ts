import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexProcess } from '../server/chat/codexProcess';
import { classifyDenial, denialNotice } from '../server/chat/denial';
import { codexDeclinedTool, denialWeight, type DeniedInfo } from '../server/chat/denied';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { deniedInboxItem } from '../server/inboxItems';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Alerta "ação barrada" (InboxKind 'denied'): conversa de TAREFA com ferramenta negada gera um item por conversa e por turno, agrupado, nos dois motores.
// O texto e as camadas do Claude são os de denial.ts (que não muda); aqui se confere o item, o agrupamento, a dispensa e o limite do Codex.

const CLASSIFIER = 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Deploy]. Ask the user before continuing.';
const CLUB_SSH = 'Permission to use PowerShell with command ssh deploy@10.0.0.5 "ls" has been denied.';
const SETTINGS = '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>';
const SAFETY = `Remove-Item on system path '"x":'' is blocked. This path is protected from removal.`;
const NO_VERDICT = 'The server-side auto mode classifier gave no verdict (error). Try again.';

const tick = () => new Promise((r) => setTimeout(r, 20));

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-denied-'));
});
afterAll(() => removeTemp(root));

/** Processo falso do claude: `emit` escreve uma linha no stdout dele. */
function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
  stdin.on('finish', () => proc.emit('exit', 0));
  return { spawnImpl: () => proc as never, emit: (ev: object) => stdout.write(JSON.stringify(ev) + '\n') };
}

const use = (id: string, name: string, parent?: string) => ({ type: 'assistant', ...(parent && { parent_tool_use_id: parent }), message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input: {} }] } });
const fail = (id: string, text: string, parent?: string, isError = true) => ({ type: 'user', ...(parent && { parent_tool_use_id: parent }), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
const denied = (id: string, name: string) => ({ type: 'system', subtype: 'permission_denied', tool_name: name, tool_use_id: id });
const endTurn = { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1 };

// ---- Claude: o que o processo reporta ----

describe('Claude: ferramenta negada vai para onDenied (o mesmo texto do aviso no chat)', () => {
  function chat() {
    const seen: Array<DeniedInfo & { turn: string }> = [];
    const c = new ChatProcess({ sessionId: 's-den', cwd: '.', args: [], onDenied: (d, turn) => seen.push({ ...d, turn }) });
    return { c, seen };
  }

  it('evento de negação + resultado do classificador: ferramenta, camada, motivo, dica e o texto do aviso', () => {
    const { c, seen } = chat();
    c.handle(use('t1', 'Bash'));
    c.handle(denied('t1', 'Bash'));
    expect(seen).toEqual([]); // só o evento: o texto que diz quem barrou vem no resultado
    c.handle(fail('t1', CLASSIFIER));
    expect(seen).toEqual([
      { tool: 'Bash', layer: 'classifier', reason: 'Production Deploy', hint: 'autonomy', text: denialNotice('Bash', classifyDenial(CLASSIFIER)), turn: expect.any(String) },
    ]);
    // É o mesmo texto que o chat mostra.
    expect(c.snapshot().items.find((i) => i.kind === 'notice')).toMatchObject({ text: seen[0]!.text });
  });

  it('bloqueio do Club (sem evento) leva a dica de servidores; camada sem motivo não inventa um', () => {
    const { c, seen } = chat();
    c.handle(use('t1', 'PowerShell'));
    c.handle(fail('t1', CLUB_SSH));
    c.handle(use('t2', 'Edit'));
    c.handle(fail('t2', SETTINGS));
    expect(seen.map(({ tool, layer, hint }) => ({ tool, layer, hint }))).toEqual([
      { tool: 'PowerShell', layer: 'club', hint: 'servers' },
      { tool: 'Edit', layer: 'settings', hint: null },
    ]);
    expect(seen[0]).not.toHaveProperty('reason');
  });

  it('erro comum (sem evento) e resultado sem erro não são negação; erro de texto desconhecido COM o evento é', () => {
    const { c, seen } = chat();
    c.handle(use('t1', 'Read'));
    c.handle(fail('t1', 'arquivo não encontrado'));
    c.handle(use('t2', 'Read'));
    c.handle(fail('t2', CLASSIFIER, undefined, false));
    expect(seen).toEqual([]);
    c.handle(use('t3', 'Read'));
    c.handle(denied('t3', 'Read'));
    c.handle(fail('t3', 'texto novo que não conheço'));
    expect(seen).toEqual([expect.objectContaining({ tool: 'Read', layer: 'other', reason: 'texto novo que não conheço', hint: null, text: 'Read: permissão negada (texto novo que não conheço)' })]);
  });

  it('as negações de um turno levam a mesma chave; o turno seguinte, outra', () => {
    const { c, seen } = chat();
    c.handle({ type: 'system', subtype: 'init', model: 'm' });
    c.handle(use('t1', 'Bash'));
    c.handle(fail('t1', CLUB_SSH));
    c.handle(use('t2', 'Edit'));
    c.handle(fail('t2', SETTINGS));
    c.handle(endTurn);
    c.handle({ type: 'system', subtype: 'init', model: 'm' });
    c.handle(use('t3', 'Bash'));
    c.handle(fail('t3', CLUB_SSH));
    expect(seen).toHaveLength(3);
    expect(seen[0]!.turn).toBe(seen[1]!.turn);
    expect(seen[2]!.turn).not.toBe(seen[0]!.turn);
  });

  it('motivo com cara de segredo não vai para o alerta (caixa e notificação do sistema): sai sem o motivo, o chat não muda', () => {
    const { c, seen } = chat();
    const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    c.handle(use('t1', 'Bash'));
    c.handle(denied('t1', 'Bash'));
    c.handle(fail('t1', `chave inválida ${secret}`));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ layer: 'other', text: 'Bash: permissão negada' });
    expect(seen[0]).not.toHaveProperty('reason');
    expect(JSON.stringify(seen)).not.toContain('AbCdEfGh');
  });

  it('quem recebe falhar não derruba a leitura do stream', () => {
    const c = new ChatProcess({
      sessionId: 's-den',
      cwd: '.',
      args: [],
      onDenied: () => {
        throw new Error('caixa quebrou');
      },
    });
    c.handle(use('t1', 'Bash'));
    expect(() => c.handle(fail('t1', CLUB_SSH))).not.toThrow();
    expect(c.snapshot().items.find((i) => i.kind === 'notice')).toBeDefined();
  });

  it('subagent: a negação do texto reconhecível conta, com o nome da ferramenta dele; erro comum e resultado sem chamada não, e a conversa principal não muda', () => {
    const { c, seen } = chat();
    c.handle(use('s1', 'Bash', 'agent-1'));
    c.handle(fail('s1', CLUB_SSH, 'agent-1'));
    c.handle(use('s2', 'Read', 'agent-1'));
    c.handle(fail('s2', 'arquivo não encontrado', 'agent-1'));
    c.handle(use('s3', 'Edit', 'agent-1'));
    c.handle(fail('s3', SETTINGS, 'agent-1', false)); // sem erro
    c.handle(fail('sem-chamada', CLUB_SSH, 'agent-1'));
    expect(seen.map((d) => [d.tool, d.layer])).toEqual([['Bash', 'club']]);
    expect(c.snapshot().items).toEqual([]);
  });
});

// ---- Codex: só a recusa explícita da sandbox ----

describe('Codex: a recusa da sandbox (status declined) vai para onDenied; falha comum não', () => {
  const secrets = { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' };
  function codex(over: Partial<ConstructorParameters<typeof CodexProcess>[0]> = {}) {
    const seen: Array<DeniedInfo & { turn: string }> = [];
    const c = new CodexProcess({ cwd: '/proj', sessionId: 'cx', permissionMode: 'default', secrets, onDenied: (d, turn) => seen.push({ ...d, turn }), ...over });
    c.start();
    return { c, seen };
  }
  const cmd = (id: string, status: string, out = '', exit: number | null = null) => ({ id, type: 'command_execution', command: "bash -lc 'echo oi > x.txt'", aggregated_output: out, exit_code: exit, status });
  const change = (id: string, status: string) => ({ id, type: 'file_change', changes: [{ path: '/proj/a.ts', kind: 'update' }], status });

  it('plano/manual (sandbox só de leitura): comando e edição recusados viram o alerta, com a dica de mudar a autonomia', () => {
    const { c, seen } = codex();
    c.handle({ type: 'item.completed', item: cmd('i0', 'declined') });
    c.handle({ type: 'item.completed', item: change('i1', 'declined') });
    expect(seen.map(({ tool, layer, hint }) => ({ tool, layer, hint }))).toEqual([
      { tool: 'Bash', layer: 'sandbox', hint: 'autonomy' },
      { tool: 'Edit', layer: 'sandbox', hint: 'autonomy' },
    ]);
    expect(seen[0]!.text).toBe('`Bash` recusado pela sandbox do Codex: a conversa roda só com leitura (plano ou aprovação manual).');
    expect(seen[0]).not.toHaveProperty('reason');
    expect(seen[0]!.turn).toBe(seen[1]!.turn);
  });

  it('sandbox de escrita: a recusa é de algo fora da pasta de trabalho (sem dica); `readOnly` força a de leitura', () => {
    const w = codex({ permissionMode: 'acceptEdits' });
    w.c.handle({ type: 'item.completed', item: change('i0', 'declined') });
    expect(w.seen).toEqual([expect.objectContaining({ tool: 'Edit', layer: 'sandbox', hint: null, text: '`Edit` recusado pela sandbox do Codex: fora da pasta de trabalho ou da rede liberada.' })]);
    const r = codex({ permissionMode: 'acceptEdits', readOnly: true });
    r.c.handle({ type: 'item.completed', item: cmd('i0', 'declined') });
    expect(r.seen).toEqual([expect.objectContaining({ layer: 'sandbox', hint: 'autonomy' })]);
  });

  it('limite: comando que falha com "permissão negada" no texto NÃO é tratado como recusa (pode ser outra coisa); andamento, sucesso e outros tipos também não', () => {
    const { c, seen } = codex();
    c.handle({ type: 'item.completed', item: cmd('i0', 'failed', 'bash: x.txt: Read-only file system', 1) });
    c.handle({ type: 'item.completed', item: cmd('i1', 'failed', 'Permission denied', 126) });
    c.handle({ type: 'item.started', item: cmd('i2', 'declined') });
    c.handle({ type: 'item.updated', item: cmd('i3', 'declined') });
    c.handle({ type: 'item.completed', item: cmd('i4', 'completed', 'oi', 0) });
    c.handle({ type: 'item.completed', item: change('i5', 'failed') });
    c.handle({ type: 'item.completed', item: change('i6', 'completed') });
    c.handle({ type: 'item.completed', item: { id: 'i7', type: 'mcp_tool_call', server: 'x', tool: 'y', status: 'declined' } });
    expect(seen).toEqual([]);
  });

  it('codexDeclinedTool: só o item concluído, comando ou edição, com status declined', () => {
    expect(codexDeclinedTool('completed', cmd('a', 'declined'))).toBe('Bash');
    expect(codexDeclinedTool('completed', change('a', 'declined'))).toBe('Edit');
    expect(codexDeclinedTool('started', cmd('a', 'declined'))).toBeNull();
    expect(codexDeclinedTool('completed', cmd('a', 'failed'))).toBeNull();
    expect(codexDeclinedTool('completed', null)).toBeNull();
    expect(codexDeclinedTool('completed', 'declined')).toBeNull();
  });
});

describe('qual negação o alerta mostra', () => {
  it('safety (o agente costuma contornar) e classifierError (falha passageira) pesam menos que uma regra que barra de verdade', () => {
    expect(denialWeight('safety')).toBeLessThan(denialWeight('classifierError'));
    for (const layer of ['classifier', 'club', 'settings', 'other', 'sandbox'] as const) expect(denialWeight('classifierError')).toBeLessThan(denialWeight(layer));
  });
});

// ---- o item ----

describe('deniedInboxItem: o contrato do item', () => {
  const w = { projectId: 'p1', projectName: 'Site', sessionId: 'sx', staffId: 'ana', name: 'Ana' };
  const shown: DeniedInfo = { tool: 'Bash', layer: 'classifier', reason: 'Production Deploy', hint: 'autonomy', text: denialNotice('Bash', classifyDenial(CLASSIFIER)) };

  it('um item de conversa com tarefa, ferramenta, camada, motivo, hint e o texto do aviso', () => {
    const item = deniedInboxItem({ id: 'denied:sx:ab12cd34', sessionId: 'sx', taskId: 't-a1b2c3', taskTitle: 'Tela', shown, count: 1, tools: ['Bash'], at: '2026-11-18T10:00:00.000Z' }, w);
    expect(item).toEqual({
      id: 'denied:sx:ab12cd34',
      kind: 'denied',
      ...w,
      summary: `“Tela”: ${shown.text}`,
      at: '2026-11-18T10:00:00.000Z',
      denied: { taskId: 't-a1b2c3', taskTitle: 'Tela', tool: 'Bash', layer: 'classifier', reason: 'Production Deploy', hint: 'autonomy', text: shown.text, count: 1, tools: ['Bash'] },
    });
  });

  it('várias negações no turno: a contagem entra no resumo; sem motivo, o campo não existe', () => {
    const { reason: _r, ...bare } = shown;
    const item = deniedInboxItem({ id: 'denied:sx:k', sessionId: 'sx', taskId: 't-a1b2c3', taskTitle: 'Tela', shown: { ...bare, layer: 'club', hint: 'servers' }, count: 3, tools: ['Bash', 'Edit'], at: 'x' }, w);
    expect(item.summary.endsWith('(+2 neste turno)')).toBe(true);
    expect(item.denied).toMatchObject({ count: 3, tools: ['Bash', 'Edit'], hint: 'servers' });
    expect(item.denied).not.toHaveProperty('reason');
  });
});

// ---- o manager: um item por conversa e por turno ----

describe('ChatManager: ação barrada em conversa de tarefa', () => {
  function manager(extra: Partial<ConstructorParameters<typeof ChatManager>[0]> = {}) {
    const claudes: Array<ReturnType<typeof fakeClaude>> = [];
    const codex: { run: { emit: (ev: object) => void; close: () => void } | null } = { run: null };
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      denialTask: async (sid) => (sid.startsWith('sx') || sid === 'sess-codex' ? { taskId: 't-a1b2c3', title: 'Tela' } : null),
      resolve: async (_p, sid, staffId) =>
        staffId === 'cris'
          ? {
              sessionId: sid ?? 'sess-codex',
              cwd: root,
              args: [],
              engine: 'codex' as const,
              codex: {
                autonomy: 'manual' as const,
                model: null,
                effort: null,
                instructions: 'Ficha',
                writableRoots: [],
                readOnlyPaths: [],
                agents: [],
                secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') },
                threadId: null,
                threadFile: path.join(root, 'codex-thread.json'),
                mycoUrl: 'http://127.0.0.2:4848',
              },
            }
          : { sessionId: sid ?? 'sx', cwd: root, args: ['--permission-mode', 'acceptEdits'] },
      spawnImpl: (cmd) => {
        if (cmd !== 'codex') {
          claudes.push(fakeClaude());
          return claudes.at(-1)!.spawnImpl();
        }
        const stdout = new PassThrough();
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 6000 });
        codex.run = { emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: () => void child.emit('close', 0) };
        return child as never;
      },
      log: () => {},
      ...extra,
    });
    return { m, claudes, codex };
  }

  it('várias negações no turno: UM item, com a contagem e as ferramentas; o item mostra a primeira', async () => {
    const { m, claudes } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    const f = claudes[0]!;
    f.emit(use('t1', 'Bash'));
    f.emit(denied('t1', 'Bash'));
    f.emit(fail('t1', CLASSIFIER));
    f.emit(use('t2', 'Edit'));
    f.emit(fail('t2', SETTINGS));
    f.emit(use('t3', 'Bash'));
    f.emit(fail('t3', CLASSIFIER));
    await tick();
    const hits = m.deniedHits();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      sessionId: 'sx',
      taskId: 't-a1b2c3',
      taskTitle: 'Tela',
      count: 3,
      tools: ['Bash', 'Edit'],
      shown: { tool: 'Bash', layer: 'classifier', reason: 'Production Deploy', hint: 'autonomy' },
    });
    expect(hits[0]!.id).toMatch(/^denied:sx:[0-9a-f]{8}$/);
  });

  it('a checagem safety e o erro passageiro do classificador não escondem a regra que barra de verdade (e não a trocam depois)', async () => {
    const { m, claudes } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    const f = claudes[0]!;
    f.emit(use('t1', 'PowerShell'));
    f.emit(fail('t1', SAFETY));
    f.emit(use('t2', 'Bash'));
    f.emit(denied('t2', 'Bash'));
    f.emit(fail('t2', NO_VERDICT));
    await tick();
    expect(m.deniedHits()[0]).toMatchObject({ count: 2, shown: { layer: 'classifierError', tool: 'Bash' } });
    f.emit(use('t3', 'PowerShell'));
    f.emit(fail('t3', CLUB_SSH));
    f.emit(use('t4', 'PowerShell'));
    f.emit(fail('t4', SAFETY));
    await tick();
    expect(m.deniedHits()[0]).toMatchObject({ count: 4, tools: ['PowerShell', 'Bash'], shown: { layer: 'club', hint: 'servers' } });
  });

  it('turno novo com negação troca o item (a conversa nunca tem mais de um); o id muda, então volta a avisar', async () => {
    const { m, claudes } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    const f = claudes[0]!;
    f.emit(use('t1', 'Bash'));
    f.emit(fail('t1', CLUB_SSH));
    await tick();
    const first = m.deniedHits()[0]!;
    f.emit(endTurn);
    await tick();
    expect(m.deniedHits()).toHaveLength(1); // o item não some sozinho no fim do turno: o dono precisa vê-lo
    await m.send('p', 'sx', 'ana', 'tente de novo');
    f.emit(use('t2', 'Edit'));
    f.emit(fail('t2', SETTINGS));
    await tick();
    const hits = m.deniedHits();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).not.toBe(first.id);
    expect(hits[0]).toMatchObject({ count: 1, tools: ['Edit'], shown: { layer: 'settings' } });
  });

  it('dispensar: o item sai, o resto do mesmo turno não o traz de volta, e o turno seguinte avisa de novo', async () => {
    const { m, claudes } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    const f = claudes[0]!;
    f.emit(use('t1', 'Bash'));
    f.emit(fail('t1', CLUB_SSH));
    await tick();
    const id = m.deniedHits()[0]!.id;
    expect(m.dismissDenied('denied:sx:nao-existe')).toBe(false);
    expect(m.dismissDenied('sx')).toBe(false);
    expect(m.dismissDenied(id)).toBe(true);
    expect(m.deniedHits()).toEqual([]);
    expect(m.dismissDenied(id)).toBe(false); // já dispensado (tela velha)

    f.emit(use('t2', 'Edit'));
    f.emit(fail('t2', SETTINGS));
    await tick();
    expect(m.deniedHits()).toEqual([]);

    f.emit(endTurn);
    await m.send('p', 'sx', 'ana', 'outra');
    f.emit(use('t3', 'Edit'));
    f.emit(fail('t3', SETTINGS));
    await tick();
    expect(m.deniedHits()).toHaveLength(1);
    expect(m.deniedHits()[0]!.id).not.toBe(id);
  });

  it('conversa que não é de tarefa (livre, card automático, revisão) ou sem a opção: nenhum item', async () => {
    const free = manager({ denialTask: async () => null });
    await free.m.send('p', 'sx', 'ana', 'rode');
    free.claudes[0]!.emit(use('t1', 'Bash'));
    free.claudes[0]!.emit(fail('t1', CLUB_SSH));
    await tick();
    expect(free.m.deniedHits()).toEqual([]);

    const bare = manager({ denialTask: undefined });
    await bare.m.send('p', 'sx', 'ana', 'rode');
    bare.claudes[0]!.emit(use('t1', 'Bash'));
    bare.claudes[0]!.emit(fail('t1', CLUB_SSH));
    await tick();
    expect(bare.m.deniedHits()).toEqual([]);

    // Uma conversa livre ao lado de uma de tarefa não mistura.
    const mixed = manager();
    await mixed.m.send('p', 'sx', 'ana', 'rode');
    await mixed.m.send('p', 'livre', 'ana', 'rode');
    mixed.claudes[1]!.emit(use('t1', 'Bash'));
    mixed.claudes[1]!.emit(fail('t1', CLUB_SSH));
    await tick();
    expect(mixed.m.deniedHits()).toEqual([]);
  });

  it('subagent (o executor do roteiro): a negação dele também gera o item do turno', async () => {
    const { m, claudes } = manager();
    await m.send('p', 'sx', 'ana', 'rode');
    claudes[0]!.emit(use('s1', 'Bash', 'agent-1'));
    claudes[0]!.emit(fail('s1', CLUB_SSH, 'agent-1'));
    await tick();
    expect(m.deniedHits()).toEqual([expect.objectContaining({ count: 1, tools: ['Bash'], shown: expect.objectContaining({ layer: 'club', hint: 'servers' }) })]);
  });

  it('Codex: a recusa da sandbox gera o mesmo item (um por turno, agrupado); falha comum não', async () => {
    const { m, codex } = manager();
    await m.send('p', null, 'cris', 'crie o relatório');
    for (let i = 0; i < 50 && !codex.run; i++) await tick(); // o Codex abre depois de preparar a execução
    const cmd = (id: string, status: string, exit: number | null = null) => ({ id, type: 'command_execution', command: 'echo oi > x', aggregated_output: '', exit_code: exit, status });
    codex.run!.emit({ type: 'item.completed', item: cmd('i0', 'failed', 1) });
    await tick();
    expect(m.deniedHits()).toEqual([]);
    codex.run!.emit({ type: 'item.completed', item: cmd('i1', 'declined') });
    codex.run!.emit({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: path.join(root, 'a.ts'), kind: 'update' }], status: 'declined' } });
    await tick();
    expect(m.deniedHits()).toEqual([
      expect.objectContaining({
        sessionId: 'sess-codex',
        taskId: 't-a1b2c3',
        count: 2,
        tools: ['Bash', 'Edit'],
        shown: expect.objectContaining({ tool: 'Bash', layer: 'sandbox', hint: 'autonomy' }),
      }),
    ]);
    codex.run!.emit({ type: 'turn.completed', usage: {} });
    codex.run!.close();
    await tick();
  });
});

// ---- a tarefa da conversa ----

describe('TaskService.denialTask: só o trabalho (e o deploy) de uma tarefa comum', () => {
  async function board(dirName: string) {
    const dir = path.join(root, dirName);
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    const people: Record<string, StaffProfile> = {
      'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
      'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    };
    let k = 0;
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId) => `${staffId}-${++k}`,
      sendTo: async (_p, session) => session,
      branchFor: async () => null,
      isWorking: () => false,
      isSessionWorking: () => false,
      lastText: () => null,
      notify: async () => {},
      hasAsk: () => false,
      answerAsk: () => false,
      awaitingLimit: async () => false,
      apiUrl: 'http://127.0.0.1:4848',
    });
    return { dir, svc, get: async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)! };
  }

  it('trabalho: a tarefa e o título; revisão, conversa livre e card automático: null', async () => {
    const b = await board('denial-task');
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await b.svc.start('p', t.id);
    const work = (await b.get(t.id)).sessionId!;
    expect(await b.svc.denialTask(work)).toEqual({ taskId: t.id, title: 'Tela' });

    await b.svc.onTurnDone(work);
    const review = (await b.get(t.id)).review!.sessionId;
    expect(review).toBeTruthy();
    expect(await b.svc.denialTask(review)).toBeNull(); // a revisão só lê por desenho: negar escrita é o esperado

    expect(await b.svc.denialTask('conversa-livre')).toBeNull();

    await b.svc.onCodeEdit({ sessionId: 'direta-1', projectId: 'p', staffId: 'ana-1', engine: 'claude', cwd: b.dir, files: [path.join(b.dir, 'src', 'a.ts')], request: 'conserte' });
    expect((await b.svc.list('p'))!.some((x) => x.autoCreated && x.sessionId === 'direta-1')).toBe(true);
    expect(await b.svc.denialTask('direta-1')).toBeNull(); // o card automático é só registro: a conversa segue direta
  });
});

// ---- a fiação no servidor ----

describe('index.ts: o alerta chega ao GET /api/inbox e a dispensa só vale pela tela', () => {
  it('rota de dispensar: só do navegador, valida o id antes de tudo; o getInbox lê os alertas e a tarefa vem do TaskService', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const start = src.indexOf('/^\\/api\\/denied\\/dismiss$/');
    expect(start).toBeGreaterThan(0);
    const route = src.slice(start, src.indexOf('\n  ],', start));
    expect(route).toContain('async ({ body, fromBrowser })');
    expect(route.indexOf('if (!fromBrowser) throw new BadRequest')).toBeGreaterThan(0);
    expect(route.indexOf('if (!fromBrowser)')).toBeLessThan(route.indexOf('parse('));
    expect(route).toMatch(/regex\(\/\^denied:/);
    expect(route).toContain('chats.dismissDenied(b.id)');
    expect(src).toContain('for (const d of chats.deniedHits())');
    expect(src).toContain('out.push(deniedInboxItem(d, w))');
    expect(src).toContain('denialTask: (sessionId) => tasks.denialTask(sessionId),');
    expect(src).toMatch(/INBOX_ORDER: Record<InboxKind, number> = \{[^}]*denied: \d+/);
  });
});
