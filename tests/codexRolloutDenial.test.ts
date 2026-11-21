import { EventEmitter } from 'node:events';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodexSubagentWatch } from '../server/chat/codexSubagents';
import { codexRolloutDenial } from '../server/chat/denied';
import { ChatManager } from '../server/chat/manager';
import { removeTemp } from './support/tmp';

// Alerta "ação barrada" do Codex pelo ROLLOUT (follow-up f-a69470 da t-4ea7e3): no Codex 0.169 o `apply_patch` recusado pela sandbox só de leitura não sai no `--json`; fica no rollout,
// no `function_call_output` da chamada, como o bloco "Script error:\npatch rejected: <motivo>". O shell com "acesso negado" do SO NÃO é sinal (mesmo texto de arquivo preso).
// A fixture é o trecho REAL do spike (Codex 0.169.0, Windows, `-s read-only`, `approval_policy="never"`: `echo oi > x.txt` e `apply_patch` de `y.txt`); só o usuário e a pasta temporária
// foram trocados. As variações marcadas "sintética" mudam o formato de propósito: não há amostra real delas.

const REAL = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'rollout-apply-patch-recusado.jsonl'), 'utf8').split('\n').filter(Boolean);
const [CALL, CALL_OUT, WAIT, WAIT_OUT] = REAL as [string, string, string, string];
const THREAD = '01a1ef05-71ac-7310-af0c-327362cdbc27';

/** Uma saída de chamada no formato do rollout (blocos `input_text`), para as variações sintéticas. */
const outputLine = (blocks: unknown, type = 'function_call_output') =>
  JSON.stringify({ timestamp: '2026-11-18T14:18:46.286Z', type: 'response_item', payload: { type, call_id: 'call_x', output: blocks } });
const textBlocks = (...texts: string[]) => texts.map((text) => ({ type: 'input_text', text }));
const PATCH_REJECTED = 'Script error:\npatch rejected: writing is blocked by read-only sandbox; rejected by user approval settings';

describe('codexRolloutDenial: fixture real do rollout', () => {
  it('a saída do `wait` com o apply_patch recusado é recusa por sandbox (edição), com a sandbox de leitura', () => {
    expect(codexRolloutDenial(WAIT_OUT)).toEqual({ kind: 'denied', tool: 'Edit', readOnly: true });
  });

  it('as outras linhas do mesmo trecho (a chamada, o "script running", o `wait`) não são recusa', () => {
    // a chamada traz o texto do apply_patch, mas não é saída
    expect(CALL).toContain('apply_patch');
    for (const line of [CALL, CALL_OUT, WAIT]) expect(codexRolloutDenial(line)).toBeNull();
  });

  it('shell com "acesso negado" do SO e SEM a mensagem do Codex NÃO é recusa (mesmo texto de arquivo preso por outro processo)', () => {
    const o = JSON.parse(WAIT_OUT) as { payload: { output: Array<{ text: string }> } };
    const shellOnly = JSON.stringify({ ...o, payload: { ...o.payload, output: o.payload.output.filter((b) => !b.text.startsWith('Script error')) } });
    expect(shellOnly).toContain('UnauthorizedAccessException');
    expect(shellOnly).toContain('foi negado');
    expect(shellOnly).not.toContain('patch rejected');
    expect(codexRolloutDenial(shellOnly)).toBeNull();
  });
});

describe('codexRolloutDenial: o formato', () => {
  it('motivo "outside of the project" (mensagem do binário 0.169; sintética: sem amostra real): recusa sem ser a de leitura', () => {
    const line = outputLine(textBlocks('Script failed\nWall time 0.5 seconds\nOutput:\n', 'Script error:\npatch rejected: writing outside of the project; rejected by user approval settings'));
    expect(codexRolloutDenial(line)).toEqual({ kind: 'denied', tool: 'Edit', readOnly: false });
  });

  it('serve também ao `custom_tool_call_output`, e a saída em texto puro (sintética)', () => {
    expect(codexRolloutDenial(outputLine(textBlocks(PATCH_REJECTED), 'custom_tool_call_output'))).toMatchObject({ kind: 'denied' });
    expect(codexRolloutDenial(outputLine(PATCH_REJECTED))).toMatchObject({ kind: 'denied' });
    expect(codexRolloutDenial(outputLine(textBlocks(PATCH_REJECTED.replace('\n', '\r\n'))))).toMatchObject({ kind: 'denied' });
  });

  it('pessoa recusando ("patch rejected by user") não é regra: sem alerta e sem log', () => {
    expect(codexRolloutDenial(outputLine(textBlocks('Script error:\npatch rejected by user')))).toBeNull();
  });

  it('o que não é saída de chamada, ou não tem a recusa no começo do bloco, é ignorado em silêncio', () => {
    const msg = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
    expect(codexRolloutDenial(msg('o apply_patch voltou "patch rejected: writing is blocked by read-only sandbox"'))).toBeNull();
    // um comando que imprime a frase: fica dentro do JSON do `output`, não no começo do texto
    expect(codexRolloutDenial(outputLine(textBlocks(JSON.stringify({ exit_code: 0, output: PATCH_REJECTED }))))).toBeNull();
    expect(codexRolloutDenial(outputLine(textBlocks('Script error:\nTypeError: tools.x is not a function')))).toBeNull();
    expect(codexRolloutDenial('{"type":"session_meta","payload":{}}')).toBeNull();
    expect(codexRolloutDenial('')).toBeNull();
  });

  it('formato desconhecido ou mudado (sintético): não vira recusa, devolve `unknown` com um motivo fixo (sem o conteúdo da linha)', () => {
    const unknown = (line: string) => {
      const r = codexRolloutDenial(line);
      expect(r).toMatchObject({ kind: 'unknown' });
      return (r as { why: string }).why;
    };
    // motivo que o Codex não tinha: não se chuta
    expect(unknown(outputLine(textBlocks('Script error:\npatch rejected: segredo-no-meio sk-live-123 por outra razão')))).toContain('motivo de recusa fora dos conhecidos');
    // o Codex mudou o prefixo, ou a mensagem não vem mais no começo do bloco
    expect(unknown(outputLine(textBlocks('Error:\npatch rejected: writing is blocked by read-only sandbox')))).toContain('fora do formato');
    expect(unknown(outputLine(textBlocks('Script error: patch rejected: writing is blocked by read-only sandbox')))).toContain('fora do formato');
    // a saída deixou de ser lista de blocos de texto
    expect(unknown(outputLine({ text: PATCH_REJECTED }))).toContain('saída da chamada');
    expect(unknown(outputLine([{ type: 'input_text', text: PATCH_REJECTED }, { type: 'input_image' }]))).toContain('saída da chamada');
    // JSON quebrado, mas com a frase
    expect(unknown(WAIT_OUT.slice(0, WAIT_OUT.indexOf('patch rejected') + 20))).toContain('não é JSON');
    // o `why` é fixo: nada do conteúdo da linha (que pode ser de um script do modelo) vai para o log
    expect(unknown(outputLine(textBlocks('Script error:\npatch rejected: outro motivo sk-live-123')))).not.toContain('sk-live');
  });
});

describe('CodexSubagentWatch: onLine', () => {
  let dir: string;
  let parent: string;
  let lines: string[];
  let watch: CodexSubagentWatch;
  let findCalls: number;
  const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const until = (fn: () => void) => vi.waitFor(fn, { timeout: 2000, interval: 10 });

  async function open(intervalMs: number) {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-line-'));
    parent = path.join(dir, 'pai.jsonl');
    await fs.writeFile(parent, '{"type":"session_meta","payload":{}}\n');
    lines = [];
    findCalls = 0;
    watch = new CodexSubagentWatch({
      find: async () => {
        findCalls++;
        return parent;
      },
      readFirstLine: async () => null,
      onChange: () => {},
      onLine: (l) => lines.push(l),
      intervalMs,
    });
    watch.start('pai');
    await until(() => expect(findCalls).toBeGreaterThan(0));
    await tick(); // a 1ª volta (retomada: começa do fim) já passou
  }
  afterEach(async () => {
    watch.stop();
    await removeTemp(dir);
  });

  it('entrega cada linha completa nova (sem as que já estavam), e a pela metade espera o resto', async () => {
    await open(10);
    expect(lines).toEqual([]); // o session_meta de antes da retomada não volta
    await fs.appendFile(parent, WAIT_OUT.slice(0, 80));
    await tick();
    expect(lines).toEqual([]);
    await fs.appendFile(parent, WAIT_OUT.slice(80) + '\n\n' + CALL + '\n');
    await until(() => expect(lines).toEqual([WAIT_OUT, CALL]));
  });

  it('`stop()` lê o que sobrou até o fim do arquivo: a linha dos últimos instantes do turno não se perde', async () => {
    await open(60_000); // sem 2ª volta antes do stop
    await fs.appendFile(parent, WAIT_OUT + '\n');
    await tick();
    expect(lines).toEqual([]);
    watch.stop();
    await until(() => expect(lines).toEqual([WAIT_OUT]));
  });

  it('um `onLine` que lança não derruba o vigia', async () => {
    await open(10);
    watch.stop();
    let n = 0;
    watch = new CodexSubagentWatch({
      find: async () => parent,
      readFirstLine: async () => null,
      onChange: () => {},
      onLine: () => {
        n++;
        throw new Error('quem escuta quebrou');
      },
      intervalMs: 10,
    });
    watch.start('pai');
    await tick();
    await fs.appendFile(parent, CALL + '\n');
    await until(() => expect(n).toBe(1));
    await fs.appendFile(parent, CALL + '\n');
    await until(() => expect(n).toBe(2));
  });
});

// ---- ponta a ponta: o rollout de uma conversa de tarefa do Codex vira o item "ação barrada" ----

describe('ChatManager + Codex: apply_patch recusado no rollout gera o item de ação barrada', () => {
  let root: string;
  let home: string;
  let savedHome: string | undefined;
  let n = 0;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-rollout-den-'));
    home = path.join(root, 'codex-home');
    savedHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
  });
  afterAll(async () => {
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
    await removeTemp(root);
  });

  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  /** Uma conversa Codex de tarefa em `manual` (sandbox só de leitura), com o rollout da conversa numa pasta temporária (cada teste, um thread). */
  async function session() {
    const thread = `${THREAD.slice(0, -4)}${String(1000 + n++)}`;
    const dir = path.join(home, 'sessions', '2026', '11', '18');
    await fs.mkdir(dir, { recursive: true });
    const rollout = path.join(dir, `rollout-2026-11-18T11-17-54-${thread}.jsonl`);
    await fs.writeFile(rollout, '{"type":"session_meta","payload":{}}\n');
    const codex: { run: { emit: (ev: object) => void; close: () => void } | null } = { run: null };
    const logs: string[] = [];
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      denialTask: async (sid) => (sid === 'sess-codex' ? { taskId: 't-a1b2c3', title: 'Tela' } : null),
      resolve: async (_p, sid) => ({
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
      }),
      spawnImpl: () => {
        const stdout = new PassThrough();
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 6000 });
        codex.run = { emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: () => void child.emit('close', 0) };
        return child as never;
      },
      log: (l) => logs.push(l),
    });
    await m.send('p', null, 'cris', 'crie o relatório');
    for (let i = 0; i < 50 && !codex.run; i++) await tick(); // o Codex abre depois de preparar a execução
    const append = (...l: string[]) => fs.appendFile(rollout, l.join('\n') + '\n');
    const finish = async () => {
      codex.run!.emit({ type: 'turn.completed', usage: {} });
      codex.run!.close();
      await tick();
    };
    return { m, codex, logs, thread, append, finish };
  }
  const started = (s: Awaited<ReturnType<typeof session>>) => s.codex.run!.emit({ type: 'thread.started', thread_id: s.thread });

  it('apply_patch recusado na sandbox de leitura: UM item, o mesmo do `declined` (Edit, sandbox, dica de autonomia); o shell com acesso negado do SO ao lado não conta', async () => {
    const s = await session();
    await s.append(CALL, CALL_OUT, WAIT, WAIT_OUT);
    started(s); // conversa nova: o vigia lê o rollout desde o início
    await vi.waitFor(() => expect(s.m.deniedHits()).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(s.m.deniedHits()).toEqual([
      expect.objectContaining({
        sessionId: 'sess-codex',
        taskId: 't-a1b2c3',
        taskTitle: 'Tela',
        count: 1,
        tools: ['Edit'],
        shown: expect.objectContaining({ tool: 'Edit', layer: 'sandbox', hint: 'autonomy', text: '`Edit` recusado pela sandbox do Codex: a conversa roda só com leitura (plano ou aprovação manual).' }),
      }),
    ]);
    expect(s.logs.filter((l) => l.includes('rollout do Codex'))).toEqual([]);
    await s.finish();
  });

  it('shell com "acesso negado" do SO (sem a mensagem do Codex): nenhum item e nenhum log', async () => {
    const s = await session();
    const o = JSON.parse(WAIT_OUT) as { payload: { output: Array<{ text: string }> } };
    o.payload.output = o.payload.output.filter((b) => !b.text.startsWith('Script error'));
    await s.append(CALL, CALL_OUT, WAIT, JSON.stringify(o));
    started(s);
    await tick(200);
    expect(s.m.deniedHits()).toEqual([]);
    expect(s.logs.filter((l) => l.includes('rollout do Codex'))).toEqual([]);
    await s.finish();
    expect(s.m.deniedHits()).toEqual([]);
  });

  it('formato desconhecido (sintético): nenhum item e UMA linha de log por conversa, sem o conteúdo da linha', async () => {
    const s = await session();
    const odd = (text: string) => outputLine(textBlocks(`Script error:\npatch rejected: ${text}`));
    await s.append(odd('por um motivo novo sk-live-abcdefghijklmnop'), odd('outro motivo novo'));
    started(s);
    await vi.waitFor(() => expect(s.logs.filter((l) => l.includes('rollout do Codex'))).toHaveLength(1), { timeout: 3000, interval: 20 });
    await tick(100);
    const logged = s.logs.filter((l) => l.includes('rollout do Codex'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe('sess-codex: rollout do Codex: motivo de recusa fora dos conhecidos (nem sandbox nem política de aprovação); sem alerta de ação barrada');
    expect(logged[0]).not.toContain('sk-live-abcdefghijklmnop');
    expect(s.m.deniedHits()).toEqual([]);
    await s.finish();
  });

  it('duas recusas no mesmo turno: um item só, com a contagem', async () => {
    const s = await session();
    await s.append(WAIT_OUT, WAIT_OUT);
    started(s);
    await vi.waitFor(() => expect(s.m.deniedHits()).toHaveLength(1), { timeout: 3000, interval: 20 });
    await vi.waitFor(() => expect(s.m.deniedHits()[0]).toMatchObject({ count: 2, tools: ['Edit'] }), { timeout: 3000, interval: 20 });
    await s.finish();
  });

  it('a recusa gravada nos últimos instantes do turno (antes da próxima volta do vigia) também vira item', async () => {
    const s = await session();
    started(s);
    await tick(150); // a 1ª volta já leu o rollout vazio; a próxima só viria em 1,5 s
    await s.append(WAIT_OUT);
    expect(s.m.deniedHits()).toEqual([]);
    await s.finish(); // turn.completed: o `stop()` do vigia lê o que sobrou
    await vi.waitFor(() => expect(s.m.deniedHits()).toEqual([expect.objectContaining({ count: 1, tools: ['Edit'] })]), { timeout: 3000, interval: 20 });
  });
});
