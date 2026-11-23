import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatItem, StaffProfile } from '../shared/model';
import { isClaudeModelNotFound } from '../server/chat/modelNotFound';
import { ChatProcess } from '../server/chat/process';
import { buildClaudeArgs } from '../server/staff/ficha';
import { fitModelObsolete, readProfile, saveModelObsolete, saveProfile, staffDir } from '../server/staff/store';
import { removeTemp } from './support/tmp';

// Os dois formatos que o claude 2.1.310 manda para um modelo inexistente (medidos com `--model claude-inexistente-9-9`).
const REFUSAL_TEXT = "There's an issue with the selected model (claude-inexistente-9-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
const assistantRefusal = {
  type: 'assistant',
  error: 'model_not_found',
  is_api_error_message: true,
  api_error_status: 404,
  message: { model: '<synthetic>', content: [{ type: 'text', text: REFUSAL_TEXT }] },
};
const resultRefusal = { type: 'result', is_error: true, api_error_status: 404, result: REFUSAL_TEXT, terminal_reason: 'api_error' };

describe('isClaudeModelNotFound', () => {
  it('reconhece os dois eventos medidos (assistant com model_not_found e result 404 com o texto)', () => {
    expect(isClaudeModelNotFound(assistantRefusal)).toBe(true);
    expect(isClaudeModelNotFound(resultRefusal)).toBe(true);
  });

  it('não confunde outro 404, outro erro ou texto solto com modelo inexistente', () => {
    expect(isClaudeModelNotFound({ type: 'result', is_error: true, api_error_status: 404, result: 'Not Found: recurso sumiu' })).toBe(false);
    expect(isClaudeModelNotFound({ type: 'result', is_error: true, api_error_status: 500, result: REFUSAL_TEXT })).toBe(false);
    expect(isClaudeModelNotFound({ type: 'assistant', error: 'rate_limit' })).toBe(false);
    expect(isClaudeModelNotFound({ type: 'result', is_error: true, result: 'You\'ve hit your limit · resets 3pm' })).toBe(false);
    expect(isClaudeModelNotFound(null)).toBe(false);
    expect(isClaudeModelNotFound('issue with the selected model')).toBe(false);
  });
});

describe('modelObsolete: store', () => {
  let dir: string;
  const at = '2026-01-01T00:00:00.000Z';
  const profile = (over: Partial<StaffProfile> = {}): StaffProfile =>
    ({
      id: 'ana-1',
      projectId: 'p',
      name: 'Ana',
      role: 'Deploy',
      portrait: null,
      reportsTo: [],
      mission: 'Publicar',
      firstTask: '',
      autonomy: 'manual',
      agents: [],
      skills: [],
      mcps: null,
      knowledge: [],
      rules: [],
      doneWhen: '',
      engine: 'claude',
      model: 'opus',
      effort: null,
      canHire: false,
      playbook: null,
      worktree: false,
      servers: [],
      browser: false,
      sessions: [],
      createdAt: at,
      updatedAt: at,
      ...over,
    }) as StaffProfile;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelobs-'));
    await fs.mkdir(staffDir(dir), { recursive: true });
  });
  afterAll(() => removeTemp(dir));

  it('grava a marca quando a ficha usa esse modelo e esse motor', async () => {
    await saveProfile(dir, profile({ id: 'g-1' }));
    await saveModelObsolete(dir, 'g-1', 'opus', 'claude');
    const p = await readProfile(dir, 'g-1');
    expect(p?.modelObsolete).toEqual({ model: 'opus', engine: 'claude', at: expect.any(String) });
  });

  it('não grava quando a ficha usa outro modelo ou outro motor', async () => {
    await saveProfile(dir, profile({ id: 'g-2', model: 'sonnet' }));
    await saveModelObsolete(dir, 'g-2', 'opus', 'claude');
    expect((await readProfile(dir, 'g-2'))?.modelObsolete).toBeUndefined();
    await saveProfile(dir, profile({ id: 'g-3', engine: 'codex', model: 'gpt-6-sol' }));
    await saveModelObsolete(dir, 'g-3', 'gpt-6-sol', 'claude');
    expect((await readProfile(dir, 'g-3'))?.modelObsolete).toBeUndefined();
  });

  it('a mesma marca gravada de novo mantém a data da primeira', async () => {
    await saveProfile(dir, profile({ id: 'g-4', modelObsolete: { model: 'opus', engine: 'claude', at: at } }));
    await saveModelObsolete(dir, 'g-4', 'opus', 'claude');
    expect((await readProfile(dir, 'g-4'))?.modelObsolete?.at).toBe(at);
  });

  it('ficha com marca inválida no arquivo lê sem a marca (não derruba a ficha)', async () => {
    await saveProfile(dir, profile({ id: 'g-5', modelObsolete: { model: 'x; y', engine: 'claude', at } as never }));
    const p = await readProfile(dir, 'g-5');
    expect(p).not.toBeNull();
    expect(p?.modelObsolete).toBeUndefined();
  });

  it('fitModelObsolete some com a marca quando o modelo ou o motor mudam, e mantém quando não', () => {
    const marca = { model: 'opus', engine: 'claude' as const, at };
    expect(fitModelObsolete(profile({ modelObsolete: marca })).modelObsolete).toEqual(marca);
    expect('modelObsolete' in fitModelObsolete(profile({ modelObsolete: marca, model: 'sonnet' }))).toBe(false);
    expect('modelObsolete' in fitModelObsolete(profile({ modelObsolete: marca, engine: 'codex', model: 'opus' }))).toBe(false);
    expect('modelObsolete' in fitModelObsolete(profile({ modelObsolete: marca, model: null }))).toBe(false);
  });
});

describe('modelObsolete: abertura da conversa (ficha.ts)', () => {
  const opts = { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: 'M', firstPrompt: null, strictMcp: false };
  const base = (over: Partial<StaffProfile>): StaffProfile =>
    ({ id: 'ana-1', projectId: 'p', name: 'Ana', role: 'Deploy', mission: 'Publicar', firstTask: '', reportsTo: [], skills: [], agents: [], knowledge: [], rules: [], doneWhen: '', servers: [], browser: false, mcps: null, autonomy: 'manual', model: 'opus', effort: null, canHire: false, playbook: null, worktree: false, sessions: [], createdAt: '', updatedAt: '', engine: 'claude', ...over }) as StaffProfile;

  it('com o modelo marcado como obsoleto, não passa --model (abre no padrão)', () => {
    const args = buildClaudeArgs(base({ modelObsolete: { model: 'opus', engine: 'claude', at: '2026-01-01T00:00:00.000Z' } }), opts);
    expect(args).not.toContain('--model');
  });

  it('sem marca, ou com a marca de outro modelo, passa --model normalmente', () => {
    expect(buildClaudeArgs(base({}), opts)).toEqual(expect.arrayContaining(['--model', 'opus']));
    const outro = buildClaudeArgs(base({ model: 'sonnet', modelObsolete: { model: 'opus', engine: 'claude', at: '2026-01-01T00:00:00.000Z' } }), opts);
    expect(outro).toEqual(expect.arrayContaining(['--model', 'sonnet']));
  });
});

/** Processo falso (como em chat.test.ts): o que o Claudio’s Club escreve no stdin fica em `written`; `emit` simula o stdout do claude. */
function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4243, kill: () => proc.emit('exit', 0) });
  const written: Array<{ type?: string; uuid?: string; request?: { subtype?: string; model?: string }; message?: { content?: unknown[] } }> = [];
  stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
  const spawnImpl = () => proc as never;
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { written, spawnImpl, emit };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('ChatProcess: modelo inexistente no Claude', () => {
  const text = (s: string) => [{ type: 'text', text: s }];
  const notices = (chat: ChatProcess) => chat.snapshot().items.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice');

  it('uma vez: põe o padrão, manda a mesma mensagem de novo e avisa; a conversa segue ocupada', async () => {
    const f = fakeClaude();
    const gone: string[] = [];
    const chat = new ChatProcess({ sessionId: 'mg1', cwd: '.', args: [], model: 'claude-inexistente-9-9', spawnImpl: f.spawnImpl, onModelUnavailable: (m) => gone.push(m) });
    chat.start();
    chat.send('faça X');
    await tick();
    f.emit(resultRefusal);
    await tick();

    expect(f.written.some((w) => w.type === 'control_request' && w.request?.subtype === 'set_model' && w.request.model === 'default')).toBe(true);
    const users = f.written.filter((w) => w.type === 'user');
    expect(users.map((u) => u.message?.content)).toEqual([text('faça X'), text('faça X')]);
    expect(gone).toEqual(['claude-inexistente-9-9']);
    expect(notices(chat).some((n) => n.tone === 'warn' && n.text.includes('segue no modelo padrão'))).toBe(true);
    expect(notices(chat).some((n) => n.tone === 'error')).toBe(false);
    expect(chat.snapshot().state.busy).toBe(true);
  });

  it('a segunda recusa não repete: vira o erro da conversa e a mensagem não sai de novo', async () => {
    const f = fakeClaude();
    const gone: string[] = [];
    const chat = new ChatProcess({ sessionId: 'mg2', cwd: '.', args: [], model: 'claude-inexistente-9-9', spawnImpl: f.spawnImpl, onModelUnavailable: (m) => gone.push(m) });
    chat.start();
    chat.send('faça X');
    await tick();
    f.emit(resultRefusal);
    await tick();
    f.emit(resultRefusal);
    await tick();

    expect(f.written.filter((w) => w.type === 'user')).toHaveLength(2);
    expect(gone).toHaveLength(1);
    expect(notices(chat).some((n) => n.tone === 'error')).toBe(true);
    expect(chat.snapshot().state.busy).toBe(false);
  });

  it('outro erro 404 não troca de modelo nem reenvia', async () => {
    const f = fakeClaude();
    const gone: string[] = [];
    const chat = new ChatProcess({ sessionId: 'mg3', cwd: '.', args: [], model: 'claude-inexistente-9-9', spawnImpl: f.spawnImpl, onModelUnavailable: (m) => gone.push(m) });
    chat.start();
    chat.send('faça X');
    await tick();
    f.emit({ type: 'result', is_error: true, api_error_status: 404, result: 'Not Found: recurso sumiu' });
    await tick();

    expect(f.written.filter((w) => w.type === 'user')).toHaveLength(1);
    expect(f.written.some((w) => w.request?.subtype === 'set_model')).toBe(false);
    expect(gone).toEqual([]);
    expect(notices(chat).some((n) => n.tone === 'error')).toBe(true);
  });
});
