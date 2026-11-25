import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatItem, LiveSession, StaffProfile, TurnCapHit } from '../shared/model';
import { AutoContinue, type AutoContinueEvent, type AutoContinueOptions, type Pending, type RetryInfo } from '../server/chat/autoContinue';
import { RETRY_TEXT } from '../server/chat/items';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { CodexProcess } from '../server/chat/codexProcess';
import { backoffMs, classifyTurnError, MAX_RETRY_AFTER_MS, retryField, retryNotice, TurnRetryLedger, type TurnEnd } from '../server/chat/turnRetry';
import { TaskService } from '../server/tasks';
import { removeTemp } from './support/tmp';

// Retomada automática de turno que falhou por causa passageira (Claude e Codex): classificação do erro, backoff com jitter, teto por turno
// original (em disco), ação externa cortada, Parar/mensagem/teto/reinício e a ligação com o card (fica em "fazendo" durante a espera).

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-turn-retry-'));
});
afterAll(() => removeTemp(root));

const T0 = Date.parse('2026-11-17T10:00:00Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Os gerentes dos testes: settle espera as decisões de retomada em andamento (a gravação em disco pode demorar sob carga). */
const managers: ChatManager[] = [];
/** Deixa os eventos do processo falso correrem e espera as decisões de retomada que eles abriram. */
const settle = async () => {
  await sleep(20);
  for (const m of managers) for (const sid of ['s1', 's9', 'cx']) await m.settledRetry(sid);
  await sleep(5);
};

const E529 = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

describe('classifyTurnError: só o erro do turno, só o que passa', () => {
  const transient = (text: string, extra: { status?: number | null; kind?: string | null } = {}) => classifyTurnError({ text, ...extra });

  it('sobrecarga, 5xx, limite de taxa e falha de conexão são passageiros (Claude)', () => {
    expect(transient(E529)).toMatchObject({ label: 'API sobrecarregada' });
    expect(transient('API Error: Repeated 529 Overloaded errors')).not.toBeNull();
    expect(transient('API Error: 500 Internal server error')).toMatchObject({ label: 'erro 500 da API' });
    for (const s of [502, 503, 504]) expect(transient(`API Error: ${s} upstream`)).not.toBeNull();
    expect(transient('API Error: 429 {"error":{"type":"rate_limit_error","message":"This request would exceed the rate limit of 30,000 input tokens per minute"}}')).toMatchObject({ label: 'limite de taxa da API' });
    for (const t of ['Request timed out', 'connection error', 'fetch failed', 'read ECONNRESET', 'socket hang up']) expect(transient(t)).not.toBeNull();
    // O status e o tipo que o claude põe no evento valem sem texto.
    expect(transient('', { status: 503 })).not.toBeNull();
    expect(transient('erro', { kind: 'server_error' })).not.toBeNull();
  });

  it('o Codex dá o erro como JSON no texto (status e tipo dentro) ou como frase', () => {
    expect(transient(JSON.stringify({ type: 'error', status: 503, error: { type: 'server_error', message: 'The server had an error' } }))).not.toBeNull();
    expect(transient(JSON.stringify({ type: 'error', status: 429, error: { type: 'rate_limit_error', message: 'Rate limit reached for requests. Please try again in 6s.' } }))).toMatchObject({ retryAfterMs: 6_000 });
    expect(transient('exceeded retry limit, last status: 503 Service Unavailable')).not.toBeNull();
    expect(transient('stream disconnected before completion: error sending request')).not.toBeNull();
    expect(transient("We're currently experiencing high demand, which may cause temporary errors.")).toMatchObject({ label: 'API com muita demanda' });
  });

  it('autenticação, permissão, cobrança, pedido inválido, modelo, conteúdo, configuração e limite de uso ficam de fora', () => {
    const no = [
      'API Error: 401 Invalid API key',
      'API Error: 403 forbidden',
      'Credit balance is too low',
      'API Error: 400 {"error":{"type":"invalid_request_error","message":"bad"}}',
      'Prompt is too long',
      "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
      JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'model_not_found', message: 'x' } }),
      'API Error: 429 You have exceeded your current quota',
      "You've hit your weekly limit · resets Mon 9am",
      '5-hour limit reached ∙ resets 3pm',
      'Claude AI usage limit reached|1731873600',
      JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }),
      'Execution error',
      'o codex saiu com código 1',
      'não foi possível iniciar o codex: spawn ENOENT',
    ];
    for (const t of no) expect(transient(t), t).toBeNull();
    // Status que não é de servidor, mesmo com um texto que lembra sobrecarga.
    expect(transient('overloaded', { status: 400 })).toBeNull();
  });

  it('Retry-After: a espera pedida (em segundos, ms ou "try again in") sobe o backoff; passando de 15 min não é falha passageira', () => {
    expect(transient('API Error: 429 rate_limit retry-after: 45')).toMatchObject({ retryAfterMs: 45_000 });
    expect(transient('API Error: 503 {"retry_after_ms": 1500}')).toMatchObject({ retryAfterMs: 1_500 });
    expect(transient('API Error: 429 rate limit. Try again in 2 minutes')).toMatchObject({ retryAfterMs: 120_000 });
    expect(transient('API Error: 529 overloaded')).toMatchObject({ retryAfterMs: null });
    expect(transient(`API Error: 429 rate limit retry-after: ${MAX_RETRY_AFTER_MS / 1000 + 1}`)).toBeNull();
  });
});

describe('backoffMs: 30 s, 2 min, 8 min, com ±20%', () => {
  it('sem variação são os degraus; os extremos do sorteio dão ±20%; da 4ª em diante fica em 8 min', () => {
    expect([1, 2, 3].map((a) => backoffMs(a, () => 0.5))).toEqual([30_000, 120_000, 480_000]);
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 1)).toBe(36_000);
    expect(backoffMs(3, () => 0)).toBe(384_000);
    expect(backoffMs(3, () => 1)).toBe(576_000);
    expect(backoffMs(9, () => 0.5)).toBe(480_000);
    for (let i = 0; i < 50; i++) {
      const v = backoffMs(2);
      expect(v).toBeGreaterThanOrEqual(96_000);
      expect(v).toBeLessThanOrEqual(144_000);
    }
  });
});

describe('TurnRetryLedger: o orçamento do turno original, em disco', () => {
  it('a 1ª tentativa abre o turno; as seguintes somam no mesmo id; sobrevive ao reiniciar; clear fecha', async () => {
    const file = path.join(root, `ledger-${++n}.json`);
    const a = new TurnRetryLedger(file);
    expect(a.get('s1')).toBeNull();
    const first = a.take('s1', T0);
    const second = a.take('s1', T0 + 1);
    expect(first).toMatchObject({ attempts: 1 });
    expect(second).toMatchObject({ attempts: 2, turnId: first.turnId });
    await a.flush();

    const b = new TurnRetryLedger(file);
    expect(b.get('s1')).toEqual(second);
    expect(b.clear('s1')).toBe(true);
    expect(b.clear('s1')).toBe(false);
    await b.flush();
    expect(new TurnRetryLedger(file).get('s1')).toBeNull();
  });

  it('arquivo estragado ou entradas inválidas: começa vazio, sem lançar', async () => {
    const file = path.join(root, `ledger-${++n}.json`);
    await fs.writeFile(file, '{ não é json');
    expect(new TurnRetryLedger(file).get('s1')).toBeNull();
    await fs.writeFile(file, JSON.stringify({ sessions: { ok: { turnId: 't', attempts: 2, at: 1 }, ruim: { turnId: '', attempts: -1 }, x: 7 } }));
    const l = new TurnRetryLedger(file);
    expect(l.get('ok')).toEqual({ turnId: 't', attempts: 2, at: 1 });
    expect(l.get('ruim')).toBeNull();
  });
});

describe('AutoContinue: a 3ª instância (retomada)', () => {
  const make = (over: Partial<AutoContinueOptions> = {}) => {
    const clock = { t: T0 };
    const sent: Pending[] = [];
    const events: AutoContinueEvent[] = [];
    const file = path.join(root, `ac-${++n}.json`);
    const ac = new AutoContinue({ file, enabled: async () => true, stopHit: async () => null, knownResets: async () => [], send: async (p) => void sent.push(p), now: () => clock.t, spacingMs: 0, log: () => {}, ...over });
    ac.subscribe((e) => events.push(e));
    const pending = (o: Partial<Pending> = {}): Pending => ({
      projectId: 'p',
      sessionId: 's1',
      staffId: 'ana',
      at: T0 + 30_000,
      resetsAt: T0 + 30_000,
      text: 'texto',
      retry: { turnId: 't1', attempt: 1, max: 3, kind: 'transient', error: 'API sobrecarregada' },
      ...o,
    });
    return { ac, clock, sent, events, file, pending };
  };

  it('a tentativa e o turno vão para o disco e voltam; pendência sem `retry` (limite, despertador) segue como era', async () => {
    const a = make();
    await a.ac.schedule(a.pending());
    await a.ac.schedule(a.pending({ sessionId: 's2', retry: undefined }));
    const b = make({ file: a.file });
    expect((await b.ac.get('s1'))!.retry).toEqual({ turnId: 't1', attempt: 1, max: 3, kind: 'transient', error: 'API sobrecarregada' });
    expect((await b.ac.get('s2'))!.retry).toBeUndefined();
    await fs.writeFile(a.file, JSON.stringify({ pending: [{ ...JSON.parse(JSON.stringify(a.pending())), at: new Date(T0).toISOString(), resetsAt: new Date(T0).toISOString(), retry: { attempt: 0 } }] }));
    const c = make({ file: a.file });
    expect((await c.ac.get('s1'))!.retry).toBeUndefined(); // `retry` estragado: a pendência vale, sem a tentativa
  });

  it('`current` diz se a pendência que o envio recebeu ainda vale: some quando cancelada ou trocada, e com o agendador parado', async () => {
    const a = make({
      send: async (p) => {
        expect(a.ac.current(p)).toBe(true);
        await a.ac.cancel('s1', 'user');
        expect(a.ac.current(p)).toBe(false);
      },
    });
    await a.ac.schedule(a.pending({ at: T0 }));
    await a.ac.tick();
    expect(a.events.map((e) => e.type)).toEqual(['cancelled']); // cancelada no meio do envio: nem `sent` nem `failed` por cima
  });

  it('envio que falha com o servidor reiniciando (`stop`) não perde a pendência: volta no boot; sem reiniciar, `failed` como sempre', async () => {
    const a = make({
      send: async () => {
        a.ac.stop();
        throw new Error('o Claudio’s Club está reiniciando');
      },
    });
    await a.ac.schedule(a.pending({ at: T0 }));
    await a.ac.tick();
    expect(a.events).toEqual([]);
    expect(await a.ac.get('s1')).not.toBeNull();

    const b = make({
      send: async () => {
        throw new Error('boom');
      },
    });
    await b.ac.schedule(b.pending({ at: T0 }));
    await b.ac.tick();
    expect(b.events.map((e) => e.type)).toEqual(['failed']);
    expect(await b.ac.get('s1')).toBeNull();
  });

  it('opção desligada: não agenda; as marcadas saem (dropped)', async () => {
    let on = true;
    const a = make({ enabled: async () => on });
    await a.ac.schedule(a.pending());
    on = false;
    expect(await a.ac.schedule(a.pending({ sessionId: 's2' }))).toBe(false);
    await a.ac.tick();
    expect(a.events.map((e) => e.type)).toEqual(['dropped']);
    expect(await a.ac.list()).toEqual([]);
  });
});

// ---- Claude pelo ChatManager ----

function fakeClaude(pid = 4242) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid });
  const written: Array<{ type?: string; message?: { content?: Array<{ text?: string }> } }> = [];
  stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  /** O que o claude recebeu como mensagem do usuário, na ordem. */
  const texts = () => written.filter((w) => w.type === 'user').flatMap((w) => (w.message?.content ?? []).map((c) => c.text ?? ''));
  return { proc, emit, texts };
}
type Fake = ReturnType<typeof fakeClaude>;

/** Erro do turno: o `result` do claude. */
const failed = (text = E529, status: number | null = 529) => ({ type: 'result', is_error: true, subtype: 'success', result: text, ...(status !== null && { api_error_status: status }) });
const ok = { type: 'result', is_error: false, result: 'pronto' };
const toolUse = (id: string, name: string, input: object) => ({ type: 'assistant', message: { id: `m-${id}`, model: 'claude', content: [{ type: 'tool_use', id, name, input }] } });

interface Opts {
  enabled?: boolean;
  files?: { retries: string; ledger: string; wake: string; limit: string };
  /** Ligação extra com o aviso de ociosidade (o servidor liga o `TaskService` aqui). */
  onIdle?: (sessionId: string, projectId: string, staffId: string | null, reason: 'turn' | 'background' | 'exit') => void;
}

/** O gerente com as quatro instâncias do servidor (limite, despertador, retomada) e o orçamento, cada um com o seu arquivo. */
function build(opts: Opts = {}, dirIn?: string) {
  const dir = dirIn ?? path.join(root, `m-${++n}`);
  const clock = { t: T0 };
  const procs: Fake[] = [];
  const state = { enabled: opts.enabled ?? true, listLive: async (): Promise<LiveSession[]> => [] };
  const idle: Array<Promise<boolean>> = [];
  const mk = (name: string, send: (p: Pending) => Promise<void>, enabled = async () => true) =>
    new AutoContinue({ file: path.join(dir, `${name}.json`), enabled, stopHit: async () => null, knownResets: async () => [], send, now: () => clock.t, spacingMs: 0, log: () => {} });
  const retries = mk('turn-retries', (p) => m.retryChat(p), async () => state.enabled);
  const wakeups = mk('wakeups', async () => {});
  const limit = mk('auto-continue', async () => {});
  const ledger = new TurnRetryLedger(path.join(dir, 'turn-retry.json'));
  const events: AutoContinueEvent[] = [];
  retries.subscribe((e) => events.push(e));
  const m: ChatManager = new ChatManager({
    transcriptsDir: dir,
    usageFile: path.join(dir, 'usage.json'),
    listLive: () => state.listLive(),
    resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: '.', args: [] }),
    spawnImpl: () => {
      const f = fakeClaude(4242 + procs.length);
      procs.push(f);
      return f.proc as never;
    },
    retries,
    retryLedger: ledger,
    autoContinue: limit,
    wakeups,
    random: () => 0.5, // sem variação: 30 s, 2 min, 8 min
    now: () => clock.t,
    // O fim do turno: o que a tarefa pergunta já no instante da ociosidade.
    onIdle: (sid, pid, staffId, reason) => {
      if (reason === 'turn') idle.push(m.awaitingLimit(sid));
      opts.onIdle?.(sid, pid, staffId, reason);
    },
    log: () => {},
  });
  managers.push(m);
  /** Um turno do funcionário `ana` na conversa `s1`. */
  const start = async (sid = 's1') => {
    await m.send('p', sid, 'ana', 'faça a tarefa');
    return procs.at(-1)!;
  };
  /** A hora da retomada marcada. */
  const dueAt = async (sid = 's1') => (await retries.get(sid))?.at ?? null;
  /** Anda o relógio até a retomada e deixa o agendador mandar. */
  const fire = async () => {
    clock.t = (await dueAt()) ?? clock.t;
    await retries.tick();
    await settle();
  };
  return { m, retries, wakeups, limit, ledger, procs, clock, state, events, idle, start, dueAt, fire, dir };
}
type H = ReturnType<typeof build>;

const capOf = (h: H, sid = 's1'): TurnCapHit | null => h.m.turnCapOf(sid);

describe('Claude: erro passageiro do turno', () => {
  it('erro 529: a espera é registrada antes da ociosidade, a retomada marca 30 s e na hora manda o texto fixo', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();

    expect(await h.dueAt()).toBe(T0 + 30_000);
    expect((await h.retries.get('s1'))!.retry).toMatchObject({ attempt: 1, max: 3, kind: 'transient', error: 'API sobrecarregada' });
    // `awaitingLimit` perguntado no instante do fim do turno (onIdle) já vê a espera: a tarefa não vai para revisão.
    expect(await Promise.all(h.idle)).toEqual([true]);
    expect(await h.m.awaitingLimit('s1')).toBe(true);
    expect(await h.m.retryOf('s1')).toEqual({ attempt: 1, max: 3, at: new Date(T0 + 30_000).toISOString(), kind: 'transient', error: 'API sobrecarregada' });
    expect(capOf(h)).toBeNull();
    // O aviso na conversa diz a tentativa e a hora.
    const notice = (await h.m.snapshot('p', 's1')).live?.items.find((i) => i.kind === 'notice' && i.id.startsWith('n:retry:'));
    expect(notice).toMatchObject({ tone: 'warn', text: expect.stringContaining('tentativa 1 de 3') });

    h.clock.t = T0 + 29_000;
    await h.retries.tick();
    expect(p.texts()).toEqual(['faça a tarefa']);
    await h.fire();
    expect(p.texts()).toEqual(['faça a tarefa', RETRY_TEXT]);
    expect(await h.retries.get('s1')).toBeNull();
    expect(await h.m.awaitingLimit('s1')).toBe(false);
    expect(h.ledger.get('s1')).toMatchObject({ attempts: 1 });
    expect(h.events.map((e) => e.type)).toEqual(['sent']);
  });

  it('teto de 3 por turno original: 30 s, 2 min, 8 min; a 4ª falha segura a conversa (caixa e tarefa em Aguardar), sem 4ª retomada', async () => {
    const h = build();
    const p = await h.start();
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = h.clock.t;
      p.emit(failed());
      await settle();
      waits.push((await h.dueAt())! - before);
      expect((await h.retries.get('s1'))!.retry).toMatchObject({ attempt: i + 1, max: 3 });
      await h.fire();
    }
    expect(waits).toEqual([30_000, 120_000, 480_000]);
    expect(p.texts()).toEqual(['faça a tarefa', RETRY_TEXT, RETRY_TEXT, RETRY_TEXT]);

    p.emit(failed());
    await settle();
    await h.m.settledRetry('s1');
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toMatchObject({ kind: 'retry', why: 'exhausted', attempts: 3, error: 'API sobrecarregada' });
    expect(h.m.turnCaps()).toEqual([expect.objectContaining({ sessionId: 's1', kind: 'retry', why: 'exhausted' })]);
    expect(await h.m.awaitingLimit('s1')).toBe(false);
    h.clock.t += 3_600_000;
    await h.retries.tick();
    expect(p.texts()).toHaveLength(4); // nada saiu depois do teto
  });

  it('o "continue" automático não abre orçamento novo; só um turno que termina bem zera, e então a próxima falha volta a 30 s', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    await h.fire();
    p.emit(failed());
    await settle();
    expect((await h.retries.get('s1'))!.retry).toMatchObject({ attempt: 2 }); // a mensagem da plataforma seguiu no mesmo turno original
    await h.fire();
    expect(h.ledger.get('s1')).toMatchObject({ attempts: 2 });

    p.emit(ok);
    await settle();
    expect(h.ledger.get('s1')).toBeNull();
    const before = h.clock.t;
    p.emit(failed());
    await settle();
    expect((await h.retries.get('s1'))!.retry).toMatchObject({ attempt: 1 });
    expect((await h.dueAt())! - before).toBe(30_000);
  });

  it('Retry-After maior que o backoff vale', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed('API Error: 429 rate limit retry-after: 90', 429));
    await settle();
    expect(await h.dueAt()).toBe(T0 + 90_000);
  });

  it('erro passageiro seguido da saída do processo: uma retomada só, e ela reabre a conversa', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    p.proc.emit('exit', 1); // o claude sai com código 1 depois do erro (turno já terminado: não é queda no meio dele)
    await settle();
    expect((await h.retries.list()).map((x) => x.retry!.attempt)).toEqual([1]);
    expect(h.ledger.get('s1')).toMatchObject({ attempts: 1 });
    await h.fire();
    expect(h.procs).toHaveLength(2); // a conversa reabriu
    expect(h.procs[1]!.texts()).toEqual([RETRY_TEXT]);
  });

  it('erro que não é passageiro (auth, cobrança, pedido), erro sem sinal e texto de ferramenta: nada marcado, nada segurado', async () => {
    const h = build();
    const p = await h.start();
    for (const [text, status] of [['API Error: 401 Invalid API key', 401], ['Credit balance is too low', null], ['API Error: 400 invalid_request_error', 400], ['Execution error', null]] as const) {
      p.emit(failed(text, status));
      await settle();
      expect(await h.retries.get('s1'), text).toBeNull();
      expect(capOf(h), text).toBeNull();
      await h.m.send('p', 's1', 'ana', 'outra'); // mensagem sua: turno novo
    }
    // A saída de uma ferramenta que fala de 529 não é o erro do turno: o turno termina bem e nada fica marcado.
    p.emit(toolUse('t1', 'Bash', { command: 'curl https://api.exemplo.com' }));
    p.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'HTTP 529 overloaded_error', is_error: true }] } });
    p.emit(ok);
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toBeNull();
  });

  it('o limite de uso segue o fluxo dele: nada na retomada, e a espera do limite continua valendo para a tarefa', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed("You've hit your limit · resets 3pm", 429));
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(await h.limit.get('s1')).not.toBeNull();
    expect(await h.m.awaitingLimit('s1')).toBe(true);
  });

  it('Parar (interrupt) antes do erro, e fechamento nosso: o turno que acabou por vontade nossa não retoma', async () => {
    const h = build();
    const p = await h.start();
    h.m.interrupt('s1');
    p.emit(failed()); // o erro chega depois do Parar
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toBeNull();

    const h2 = build();
    const p2 = await h2.start();
    h2.m.stop('s1');
    p2.emit(failed());
    p2.proc.emit('exit', 1); // o taskkill do Windows sai com código 1
    await settle();
    expect(await h2.retries.get('s1')).toBeNull();
    expect(capOf(h2)).toBeNull();
  });

  it('opção desligada: nada é marcado nem segurado (o turno termina como antes)', async () => {
    const h = build({ enabled: false });
    const p = await h.start();
    p.emit(failed());
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toBeNull();
    expect(await h.m.awaitingLimit('s1')).toBe(false);
    p.proc.emit('exit', null);
  });

  it('conversa sem ficha (sua) não retoma sozinha', async () => {
    const h = build();
    await h.m.send('p', 's9', null, 'oi');
    h.procs.at(-1)!.emit(failed());
    await settle();
    expect(await h.retries.get('s9')).toBeNull();
  });
});

describe('Claude: o processo morreu no meio do turno', () => {
  it('saída por sinal: causa desconhecida, 1 tentativa só; a 2ª queda segura a conversa', async () => {
    const h = build();
    const p = await h.start();
    p.proc.emit('exit', null, 'SIGKILL');
    await settle();
    expect((await h.retries.get('s1'))!.retry).toMatchObject({ attempt: 1, max: 1, kind: 'unknown', error: 'o processo caiu sem aviso' });
    expect(await h.dueAt()).toBe(T0 + 30_000);
    expect(await Promise.all(h.idle)).toEqual([]); // processo que cai não é "fim de turno"; a ociosidade é a de saída
    await h.fire();
    const p2 = h.procs.at(-1)!;
    expect(p2).not.toBe(p);
    expect(p2.texts()).toEqual([RETRY_TEXT]);

    p2.proc.emit('exit', 1); // cai de novo no meio do turno retomado
    await settle();
    await h.m.settledRetry('s1');
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toMatchObject({ kind: 'retry', why: 'exhausted', attempts: 1, error: 'o processo caiu sem aviso' });
  });

  it('queda sem causa depois de duas retomadas por erro passageiro: sem 1 tentativa sobrando', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    await h.fire();
    p.emit(failed());
    await settle();
    await h.fire();
    p.proc.emit('exit', 137); // o turno retomado cai sem causa
    await settle();
    await h.m.settledRetry('s1');
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toMatchObject({ kind: 'retry', why: 'exhausted', attempts: 2 });
  });

  it('processo que sai sem estar no meio de um turno (ocioso) não é queda', async () => {
    const h = build();
    const p = await h.start();
    p.emit(ok);
    await settle();
    p.proc.emit('exit', 1);
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toBeNull();
  });

  it('ação com efeito fora do projeto cortada (git push sem resultado): não retoma, vai para a caixa e a tarefa para Aguardar', async () => {
    const h = build();
    const p = await h.start();
    p.emit(toolUse('t1', 'Bash', { command: 'git push origin main' }));
    p.proc.emit('exit', null, 'SIGKILL');
    await settle();
    await h.m.settledRetry('s1');
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toEqual({ kind: 'retry', why: 'cut', action: 'git push origin main', error: 'o processo caiu sem aviso' });
    expect(h.m.turnCaps()).toHaveLength(1);
    h.clock.t += 3_600_000;
    await h.retries.tick();
    expect(h.procs).toHaveLength(1); // ninguém reabriu a conversa
  });

  it('o mesmo no erro passageiro: ferramenta de servidor (ssh) em andamento → não retoma; ferramenta local (Edit) em andamento → retoma', async () => {
    const h = build();
    const p = await h.start();
    p.emit(toolUse('t1', 'Bash', { command: 'ssh deploy@srv "systemctl restart app"' }));
    p.emit(failed());
    await settle();
    await h.m.settledRetry('s1');
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toMatchObject({ kind: 'retry', why: 'cut', action: expect.stringContaining('ssh') });

    const h2 = build();
    const q = await h2.start();
    q.emit(toolUse('t1', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }));
    q.emit(failed());
    await settle();
    expect(await h2.retries.get('s1')).not.toBeNull();
    expect(capOf(h2)).toBeNull();
  });

  it('o cut que o fechamento intencional já tratava segue valendo: parada nossa não gera retomada', async () => {
    const h = build();
    const p = await h.start();
    p.emit(toolUse('t1', 'Bash', { command: 'git push' }));
    h.m.stop('s1');
    p.proc.emit('exit', 1);
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toBeNull();
  });
});

// A queda com agent ou comando em segundo plano: o transcript do agent (`<sessão>/subagents`, ao lado do `.jsonl` da conversa) e o comando
// decidem. Só no projeto: retoma e o card segue em "fazendo"; ação externa, ilegível ou sem como conferir: Aguardar + caixa, como antes.
describe('Claude: queda com agent ou comando em segundo plano', () => {
  const bg = (...tasks: object[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
  const agent = (id: string, description: string) => ({ task_id: id, task_type: 'local_agent', subagent_type: 'executor', description });
  const shell = (id: string) => ({ task_id: id, task_type: 'local_bash', description: 'Full test suite' });
  const result = (id: string, content: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  /** O Agent do pai, ainda sem resultado: o executor em primeiro plano que o turno estava esperando (a f1e83e2e às 04:19Z). */
  const delegate = (id: string, description: string) => toolUse(id, 'Agent', { subagent_type: 'executor', description, prompt: 'faça', run_in_background: false });
  const call = (agentId: string, name: string, input: object) =>
    JSON.stringify({ isSidechain: true, agentId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${Math.random()}`, name, input, caller: { type: 'direct' } }] } });
  const LOCAL = (agentId: string) => [
    call(agentId, 'Read', { file_path: 'server/chat/manager.ts' }),
    call(agentId, 'Edit', { file_path: 'tests/x.test.ts', old_string: 'a', new_string: 'b' }),
    call(agentId, 'PowerShell', { command: 'npx tsc --noEmit' }),
    call(agentId, 'PowerShell', { command: 'npx vitest run tests/x.test.ts' }),
  ];
  /** Os subagents da conversa `s1` do projeto `p`, onde o gerente os procura. */
  async function subagents(h: H, agents: Record<string, { description: string; lines: string[]; toolUseId?: string }>) {
    const dir = path.join(h.dir, 'p', 's1', 'subagents');
    await fs.mkdir(dir, { recursive: true });
    for (const [id, a] of Object.entries(agents)) {
      await fs.writeFile(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'executor', isBuiltIn: false, description: a.description, toolUseId: a.toolUseId ?? `tu-${id}`, spawnDepth: 1, requestShape: 'foreground' }));
      await fs.writeFile(path.join(dir, `agent-${id}.jsonl`), `${a.lines.join('\n')}\n`);
    }
  }
  const dies = async (h: H, p: Fake) => {
    p.proc.emit('exit', null, 'SIGKILL');
    await settle();
    await h.m.settledRetry('s1');
  };

  it('dois executores só no projeto (a f1e83e2e): retoma sozinho, sem caixa; o texto fixo chega na conversa', async () => {
    const h = build();
    const p = await h.start();
    p.emit(delegate('tu-a1', 'Testes: agents Codex e ficha'));
    p.emit(delegate('tu-a2', 'Observabilidade subagents Codex'));
    p.emit(bg(agent('a1dc631202b197a06', 'Testes: agents Codex e ficha'), agent('a32a98b6b5b4d1d74', 'Observabilidade subagents Codex')));
    await subagents(h, {
      a1dc631202b197a06: { description: 'Testes: agents Codex e ficha', lines: LOCAL('a1dc631202b197a06'), toolUseId: 'tu-a1' },
      a32a98b6b5b4d1d74: { description: 'Observabilidade subagents Codex', lines: LOCAL('a32a98b6b5b4d1d74'), toolUseId: 'tu-a2' },
    });
    await settle();
    await dies(h, p);
    expect((await h.retries.get('s1'))!.retry).toMatchObject({ attempt: 1, max: 1, kind: 'unknown', error: 'o processo caiu sem aviso' });
    expect(capOf(h)).toBeNull();
    expect(await h.m.awaitingLimit('s1')).toBe(true);
    await h.fire();
    expect(h.procs.at(-1)!.texts()).toEqual([RETRY_TEXT]);
  });

  it('agent em segundo plano (já lançado, sem Agent aberto) só no projeto: retoma', async () => {
    const h = build();
    const p = await h.start();
    p.emit(bg(agent('abg1', 'Servidor: cor da sala')));
    await subagents(h, { abg1: { description: 'Servidor: cor da sala', lines: LOCAL('abg1') } });
    await settle();
    await dies(h, p);
    expect(await h.retries.get('s1')).not.toBeNull();
    expect(capOf(h)).toBeNull();
  });

  it('um dos agents fez git push: não retoma, vai para a caixa com o rótulo do agent', async () => {
    const h = build();
    const p = await h.start();
    p.emit(bg(agent('abg1', 'Servidor: cor da sala'), agent('abg2', 'Deploy da sala')));
    await subagents(h, {
      abg1: { description: 'Servidor: cor da sala', lines: LOCAL('abg1') },
      abg2: { description: 'Deploy da sala', lines: [...LOCAL('abg2'), call('abg2', 'PowerShell', { command: 'git push origin main' })] },
    });
    await settle();
    await dies(h, p);
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toEqual({ kind: 'retry', why: 'cut', action: 'em segundo plano: executor: Deploy da sala', error: 'o processo caiu sem aviso' });
    expect(h.m.turnCaps()).toHaveLength(1);
    h.clock.t += 3_600_000;
    await h.retries.tick();
    expect(h.procs).toHaveLength(1);
  });

  it('agent sem transcript, ilegível ou cortado no meio: como antes (caixa)', async () => {
    const withoutFile = build();
    const a = await withoutFile.start();
    a.emit(bg(agent('abg1', 'Servidor')));
    await settle();
    await dies(withoutFile, a);
    expect(capOf(withoutFile)).toMatchObject({ kind: 'retry', why: 'cut', action: 'em segundo plano: executor: Servidor' });

    const cutLine = build();
    const b = await cutLine.start();
    b.emit(bg(agent('abg1', 'Servidor')));
    await subagents(cutLine, { abg1: { description: 'Servidor', lines: [...LOCAL('abg1'), '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Bash","input":{"command":"git pu'] } });
    await settle();
    await dies(cutLine, b);
    expect(await cutLine.retries.get('s1')).toBeNull();
    expect(capOf(cutLine)).toMatchObject({ kind: 'retry', why: 'cut' });
  });

  it('comando em segundo plano só de teste: retoma; com push/ssh, ou sem a chamada que o abriu, não', async () => {
    const ok = build();
    const a = await ok.start();
    a.emit(toolUse('t1', 'PowerShell', { command: 'npx vitest run 2>&1 | Select-String FAIL', run_in_background: true }));
    a.emit(result('t1', 'Command running in background with ID: brl07nnit. Output is being written to: C:\\tmp\\tasks\\brl07nnit.output. You will be notified when it completes.'));
    a.emit(bg(shell('brl07nnit')));
    await settle();
    await dies(ok, a);
    expect(await ok.retries.get('s1')).not.toBeNull();
    expect(capOf(ok)).toBeNull();

    const push = build();
    const b = await push.start();
    b.emit(toolUse('t1', 'Bash', { command: 'npx vitest run && git push origin main', run_in_background: true }));
    b.emit(result('t1', 'Command running in background with ID: bpush0001. Output is being written to: C:\\tmp\\tasks\\bpush0001.output.'));
    b.emit(bg(shell('bpush0001')));
    await settle();
    await dies(push, b);
    expect(await push.retries.get('s1')).toBeNull();
    expect(capOf(push)).toEqual({ kind: 'retry', why: 'cut', action: 'em segundo plano: Full test suite', error: 'o processo caiu sem aviso' });

    const stray = build();
    const c = await stray.start();
    c.emit(bg(shell('bdesconhecido')));
    await settle();
    await dies(stray, c);
    expect(capOf(stray)).toMatchObject({ kind: 'retry', why: 'cut', action: 'em segundo plano: Full test suite' });
  });

  it('o que sobrou em segundo plano é local, mas uma ferramenta externa ficou sem resultado: segura pela ferramenta', async () => {
    const h = build();
    const p = await h.start();
    p.emit(bg(agent('abg1', 'Servidor')));
    await subagents(h, { abg1: { description: 'Servidor', lines: LOCAL('abg1') } });
    p.emit(toolUse('t9', 'Bash', { command: 'git push origin main' })); // sem resultado
    await settle();
    await dies(h, p);
    expect(capOf(h)).toEqual({ kind: 'retry', why: 'cut', action: 'git push origin main', error: 'o processo caiu sem aviso' });
  });

  it('Codex: sem transcript de subagent nem formato de comando para conferir, qualquer tarefa em segundo plano segue incerta', async () => {
    const h = build();
    await h.start();
    // Codex não mostra o agent em disco: mesmo com um transcript que pareceria local ao lado da conversa, não é lido.
    await subagents(h, { abg1: { description: 'Servidor', lines: LOCAL('abg1') } });
    const cutOf = (h.m as unknown as { cutOf: (p: string, s: string, items: ChatItem[], awaiting: boolean, bg: object[], engine: 'claude' | 'codex') => Promise<string | null> }).cutOf.bind(h.m);
    const task = { id: 'abg1', kind: 'agent', label: 'executor: Servidor' };
    expect(await cutOf('p', 's1', [], false, [task], 'codex')).toBe('em segundo plano: executor: Servidor');
    expect(await cutOf('p', 's1', [], false, [task], 'claude')).toBeNull(); // o mesmo transcript, pelo Claude, passa
    expect(await cutOf('p', 's1', [], false, [], 'codex')).toBeNull(); // nada em segundo plano: como sempre
  });
});

describe('o card quando a conversa cai com agent ou comando em segundo plano', () => {
  const agent = (id: string, description: string) => ({ task_id: id, task_type: 'local_agent', subagent_type: 'executor', description });
  const line = (name: string, input: object) => JSON.stringify({ isSidechain: true, type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu-${Math.random()}`, name, input }] } });

  /** O gerente de verdade ligado a um `TaskService` como o servidor liga (fim de turno, decisão assentada, motivo, retomada marcada). */
  function wired() {
    const ref: { svc?: TaskService; done: Array<Promise<void>> } = { done: [] };
    const h = build({ onIdle: (sid, pid, staffId) => void ref.done.push(ref.svc!.onIdle(sid, pid, staffId)) });
    const dir = path.join(root, `card-${++n}`);
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => (id === 'ana' ? staff('ana', 'Ana') : null),
      send: async () => 's1',
      branchFor: async () => null,
      isWorking: () => false,
      sendTo: async (_p, sessionId) => sessionId,
      lastText: () => 'feito',
      awaitingLimit: (sid) => h.m.awaitingLimit(sid),
      settleRetry: (sid) => h.m.settledRetry(sid),
      turnCap: (sid) => h.m.turnCapOf(sid),
      retryOf: (sid) => h.m.retryOf(sid),
    });
    ref.svc = svc;
    const make = async () => {
      const t = (await svc.create('p', { title: 'Codex agents', staffId: 'ana', reviewerId: null }))!;
      await svc.start('p', t.id);
      return t.id;
    };
    const get = async (id: string) => (await svc.list('p'))!.find((x) => x.id === id)!;
    return { h, make, get, done: () => Promise.all(ref.done) };
  }

  it('executor só no projeto: a tarefa segue em "fazendo" com a retomada marcada, sem Aguardar', async () => {
    const w = wired();
    const id = await w.make();
    const p = await w.h.start();
    p.emit(toolUse('tu-1', 'Agent', { subagent_type: 'executor', description: 'Testes', prompt: 'x', run_in_background: false }));
    p.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [agent('a1dc631202b197a06', 'Testes')] });
    const dir = path.join(w.h.dir, 'p', 's1', 'subagents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'agent-a1dc631202b197a06.meta.json'), JSON.stringify({ agentType: 'executor', description: 'Testes', toolUseId: 'tu-1', spawnDepth: 1 }));
    await fs.writeFile(path.join(dir, 'agent-a1dc631202b197a06.jsonl'), `${[line('Read', { file_path: 'a.ts' }), line('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }), line('PowerShell', { command: 'npx vitest run tests/a.test.ts' })].join('\n')}\n`);
    await settle();
    p.proc.emit('exit', null, 'SIGKILL');
    await settle();
    await w.done();
    expect(await w.get(id)).toMatchObject({ status: 'doing', retry: expect.objectContaining({ attempt: 1, kind: 'unknown' }) });
    await w.h.fire();
    expect(w.h.procs.at(-1)!.texts()).toEqual([RETRY_TEXT]);
    expect((await w.get(id)).status).toBe('doing');
  });

  it('executor com ação externa (ou sem como conferir): Aguardar com o motivo, como antes', async () => {
    const w = wired();
    const id = await w.make();
    const p = await w.h.start();
    p.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [agent('abg1', 'Deploy')] });
    const dir = path.join(w.h.dir, 'p', 's1', 'subagents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'agent-abg1.meta.json'), JSON.stringify({ agentType: 'executor', description: 'Deploy', toolUseId: 'tu-9', spawnDepth: 1 }));
    await fs.writeFile(path.join(dir, 'agent-abg1.jsonl'), `${[line('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }), line('Bash', { command: 'ssh deploy@vps "systemctl restart app"' })].join('\n')}\n`);
    await settle();
    p.proc.emit('exit', null, 'SIGKILL');
    await settle();
    await w.done();
    expect(await w.get(id)).toMatchObject({ status: 'waiting', waitReason: expect.stringContaining('em segundo plano: executor: Deploy') });
    expect(await w.h.retries.get('s1')).toBeNull();
  });
});

describe('Claude: Parar, mensagem sua e teto invalidam a retomada', () => {
  it('Parar durante o backoff: a retomada some, o orçamento recomeça e nada é mandado', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    expect(await h.retries.get('s1')).not.toBeNull();
    h.m.stop('s1');
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(h.ledger.get('s1')).toBeNull();
    await vi.waitFor(() => expect(h.events.map((e) => e.type)).toEqual(['cancelled'])); // o aviso sai depois de gravar o arquivo
    h.clock.t += 3_600_000;
    await h.retries.tick();
    expect(p.texts()).toEqual(['faça a tarefa']);
  });

  it('interrupção (cancelar a tarefa) durante o backoff: o mesmo', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    h.m.interrupt('s1');
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    await vi.waitFor(() => expect(h.events).toEqual([expect.objectContaining({ type: 'cancelled', by: 'user' })]));
  });

  it('Parar no meio do envio assíncrono: a conversa chega a abrir, mas a mensagem não é escrita', async () => {
    const h = build();
    const p = await h.start();
    p.proc.emit('exit', null, 'SIGKILL'); // fechada: o envio reabre a conversa (passa por `listLive`)
    await settle();
    h.clock.t = (await h.dueAt())!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.state.listLive = async () => {
      await gate;
      return [];
    };
    const sending = h.retries.tick(); // o envio fica preso em `listLive`
    await settle();
    h.m.stop('s1'); // Parar chega no meio do envio
    release();
    await sending;
    await settle();
    expect(h.procs.flatMap((f) => f.texts()).filter((t) => t === RETRY_TEXT)).toEqual([]);
    expect(await h.retries.get('s1')).toBeNull();
    await vi.waitFor(() => expect(h.events.map((e) => e.type)).toEqual(['cancelled'])); // sem `sent` nem `failed` por cima
  });

  it('mensagem sua no meio do envio assíncrono também vale: a retomada desiste e o orçamento recomeça', async () => {
    const h = build();
    const p = await h.start();
    p.proc.emit('exit', 1);
    await settle();
    h.clock.t = (await h.dueAt())!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let hold = true;
    h.state.listLive = async () => {
      if (hold) await gate;
      return [];
    };
    const sending = h.retries.tick();
    await settle();
    hold = false;
    // Sua mensagem anula a retomada na hora (síncrono) e divide a abertura que ela já começou (`opening`): só termina quando essa abertura sai.
    const mine = h.m.send('p', 's1', 'ana', 'outra coisa');
    release();
    await mine;
    await sending;
    await settle();
    const texts = h.procs.flatMap((f) => f.texts());
    expect(texts).toContain('outra coisa');
    expect(texts).not.toContain(RETRY_TEXT);
    expect(h.ledger.get('s1')).toBeNull();
  });

  it('mensagem sua depois de esgotar: turno original novo (o aviso da caixa sai e a retomada volta a valer)', async () => {
    const h = build();
    const p = await h.start();
    p.proc.emit('exit', null, 'SIGKILL');
    await settle();
    await h.fire();
    h.procs.at(-1)!.proc.emit('exit', 1);
    await settle();
    await h.m.settledRetry('s1');
    expect(capOf(h)).toMatchObject({ why: 'exhausted' });

    await h.m.send('p', 's1', 'ana', 'tente de novo');
    expect(capOf(h)).toBeNull();
    h.procs.at(-1)!.emit(failed());
    await settle();
    expect((await h.retries.get('s1'))!.retry).toMatchObject({ attempt: 1 });
  });

  it('teto de ferramentas/minutos do turno (turnCapped): a retomada marcada sai junto', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    expect(await h.retries.get('s1')).not.toBeNull();
    h.m.holdCut('s1', 'git push'); // o mesmo caminho do corte do reinício e do teto
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(capOf(h)).toMatchObject({ kind: 'restart' });
  });
});

describe('Claude: reinício, despertador, limite e órfãs', () => {
  it('reinício com pendência: a retomada e o orçamento voltam do disco e o boot manda na hora marcada', async () => {
    const a = build();
    const p = await a.start();
    p.emit(failed());
    await settle();
    await a.ledger.flush();
    a.retries.stop(); // o servidor reinicia: as pendências ficam no disco

    const b = build({}, a.dir);
    expect((await b.retries.get('s1'))!.retry).toMatchObject({ attempt: 1 });
    expect(b.ledger.get('s1')).toMatchObject({ attempts: 1 });
    b.clock.t = T0 + 30_000;
    await b.retries.tick();
    await settle();
    expect(b.procs.at(-1)!.texts()).toEqual([RETRY_TEXT]);
    // O orçamento seguiu: a próxima falha do mesmo turno é a tentativa 2, não uma nova 1.
    b.procs.at(-1)!.emit(failed());
    await settle();
    expect((await b.retries.get('s1'))!.retry).toMatchObject({ attempt: 2 });
  });

  it('retomada do reinício (resume.ts) da mesma conversa tira a retomada marcada: um "continue" só', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    expect(await h.retries.get('s1')).not.toBeNull();
    await h.m.resumeChat({ projectId: 'p', sessionId: 's1', staffId: 'ana', engine: 'claude', cwd: '.', hadPending: false });
    expect(await h.retries.get('s1')).toBeNull();
    expect(h.events).toEqual([expect.objectContaining({ type: 'cancelled', by: 'resume' })]);
    h.clock.t += 3_600_000;
    await h.retries.tick();
    expect(h.procs.flatMap((f) => f.texts()).filter((t) => t === RETRY_TEXT)).toEqual([]);
  });

  it('turno que termina bem enquanto havia retomada marcada (voltou por outro caminho): a marcada sai e o orçamento zera', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    await h.m.send('p', 's1', 'ana', 'e então?'); // sua mensagem tira a retomada
    p.emit(ok);
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(h.ledger.get('s1')).toBeNull();
  });

  it('o "continue" do limite de uso já marcado volta à conversa: sem retomada própria', async () => {
    const h = build();
    const p = await h.start();
    await h.limit.schedule({ projectId: 'p', sessionId: 's1', staffId: 'ana', at: T0 + 3_600_000, resetsAt: T0 + 3_600_000 });
    p.emit(failed());
    await settle();
    expect(await h.retries.get('s1')).toBeNull();
    expect(h.ledger.get('s1')).toBeNull(); // nada gasto do orçamento
    expect(await h.m.awaitingLimit('s1')).toBe(true); // a do limite segura a tarefa
  });

  it('despertador que vence antes da retomada a dispensa; um que vence depois não impede a retomada', async () => {
    const h = build();
    const p = await h.start();
    await h.wakeups.schedule({ projectId: 'p', sessionId: 's1', staffId: 'ana', at: T0 + 10_000, resetsAt: T0 + 10_000, text: 'olhe o deploy' });
    p.emit(failed());
    await settle();
    expect(await h.retries.get('s1')).toBeNull();

    const h2 = build();
    const q = await h2.start();
    await h2.wakeups.schedule({ projectId: 'p', sessionId: 's1', staffId: 'ana', at: T0 + 3_600_000, resetsAt: T0 + 3_600_000, text: 'olhe o deploy' });
    q.emit(failed());
    await settle();
    expect(await h2.retries.get('s1')).not.toBeNull();
    expect(await h2.wakeups.get('s1')).not.toBeNull(); // o despertador continua dele
  });

  it('órfã do quadro (tasks.orphan) só espera: `awaitingLimit` cobre a retomada marcada e deixa de cobrir depois do envio', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    expect(await h.m.awaitingLimit('s1')).toBe(true);
    await h.fire();
    expect(await h.m.awaitingLimit('s1')).toBe(false);
  });

  it('a retomada não manda segunda mensagem numa conversa que já voltou a trabalhar por outro caminho', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    // Um despertador (da plataforma, `auto`) já pôs a conversa para trabalhar antes da hora.
    await h.m.wakeChat({ projectId: 'p', sessionId: 's1', staffId: 'ana', at: T0, resetsAt: T0, text: 'olhe o deploy' });
    expect(h.m.isBusy('s1')).toBe(true);
    await h.fire();
    expect(p.texts()).toEqual(['faça a tarefa', 'olhe o deploy']);
  });
});

// ---- Codex ----

const profile = { cwd: '/proj', sessionId: 'sess-1', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };

function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void; stderr: (t: string) => void; close: (code?: number | null) => void; prompt: () => string }> = [];
  const spawnImpl = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let prompt = '';
    stdin.on('data', (d: Buffer) => void (prompt += d.toString()));
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 5000 + runs.length });
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), stderr: (t) => void stderr.write(t), close: (code = 0) => void child.emit('close', code), prompt: () => prompt });
    return child as never;
  };
  return { runs, spawnImpl, last: () => runs.at(-1)! };
}

function codexBuild() {
  const f = fakeCodex();
  const dir = path.join(root, `c-${++n}`);
  const clock = { t: T0 };
  const retries = new AutoContinue({ file: path.join(dir, 'turn-retries.json'), enabled: async () => true, stopHit: async () => null, knownResets: async () => [], send: (p) => m.retryChat(p), now: () => clock.t, spacingMs: 0, log: () => {} });
  const ledger = new TurnRetryLedger(path.join(dir, 'turn-retry.json'));
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
    retries,
    retryLedger: ledger,
    random: () => 0.5,
    now: () => clock.t,
    log: () => {},
  });
  managers.push(m);
  const start = async () => {
    const sid = await m.send('p', 'cx', 'cris', 'faça a tarefa');
    await settle();
    f.last().emit({ type: 'turn.started' });
    return sid;
  };
  const fire = async () => {
    clock.t = (await retries.get('cx'))!.at;
    await retries.tick();
    await settle();
  };
  return { f, m, retries, ledger, clock, start, fire };
}

describe('Codex: turn.failed, execução que cai e parada', () => {
  const E503 = JSON.stringify({ type: 'error', status: 503, error: { type: 'server_error', message: 'Service Unavailable' } });

  it('turn.failed com 503: retomada marcada em 30 s; na hora a execução seguinte recebe o texto fixo; teto de 3', async () => {
    const h = codexBuild();
    await h.start();
    for (let i = 0; i < 3; i++) {
      h.f.last().emit({ type: 'turn.failed', error: { message: E503 } });
      await settle();
      expect((await h.retries.get('cx'))!.retry).toMatchObject({ attempt: i + 1, max: 3, kind: 'transient', error: 'erro 503 da API' });
      expect(await h.m.awaitingLimit('cx')).toBe(true);
      const runs = h.f.runs.length;
      h.f.last().close(1); // o codex sai com 1 depois do turn.failed: já tratado, não é queda
      await h.fire();
      expect(h.f.runs).toHaveLength(runs + 1);
      expect(h.f.last().prompt()).toContain(RETRY_TEXT);
      h.f.last().emit({ type: 'turn.started' });
    }
    h.f.last().emit({ type: 'turn.failed', error: { message: E503 } });
    await settle();
    await h.m.settledRetry('cx');
    expect(await h.retries.get('cx')).toBeNull();
    expect(h.m.turnCapOf('cx')).toMatchObject({ kind: 'retry', why: 'exhausted', attempts: 3 });
    h.f.last().close(1);
  });

  it('`error` solto sem turn.failed não conta como erro do turno; a execução que fecha sem terminar é queda sem causa (1 tentativa)', async () => {
    const h = codexBuild();
    await h.start();
    h.f.last().emit({ type: 'error', message: E503 }); // sozinho, não basta
    await settle();
    expect(await h.retries.get('cx')).toBeNull();
    h.f.last().close(1); // fechou sem turn.completed nem turn.failed
    await settle();
    expect((await h.retries.get('cx'))!.retry).toMatchObject({ attempt: 1, max: 1, kind: 'unknown' });
    await h.fire();
    h.f.last().emit({ type: 'turn.started' });
    h.f.last().close(137); // a execução retomada cai também
    await settle();
    await h.m.settledRetry('cx');
    expect(await h.retries.get('cx')).toBeNull();
    expect(h.m.turnCapOf('cx')).toMatchObject({ kind: 'retry', why: 'exhausted', attempts: 1 });
  });

  it('ação externa em andamento na execução que caiu: não retoma (vai para a caixa)', async () => {
    const h = codexBuild();
    await h.start();
    h.f.last().emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/usr/bin/bash -lc 'git push origin main'", aggregated_output: '', exit_code: null, status: 'in_progress' } });
    h.f.last().close(1);
    await settle();
    await h.m.settledRetry('cx');
    expect(await h.retries.get('cx')).toBeNull();
    expect(h.m.turnCapOf('cx')).toMatchObject({ kind: 'retry', why: 'cut', action: 'git push origin main' });
  });

  it('erro que não é passageiro (auth, modelo, limite de uso) e turno que termina bem: nada marcado; o sucesso zera o orçamento', async () => {
    const h = codexBuild();
    await h.start();
    h.f.last().emit({ type: 'turn.failed', error: { message: JSON.stringify({ type: 'error', status: 401, error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided' } }) } });
    await settle();
    expect(await h.retries.get('cx')).toBeNull();
    h.f.last().close(1);

    await h.m.send('p', 'cx', 'cris', 'de novo');
    await settle();
    h.f.last().emit({ type: 'turn.started' });
    h.f.last().emit({ type: 'turn.failed', error: { message: JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }) } });
    await settle();
    expect(await h.retries.get('cx')).toBeNull();
    h.f.last().close(1);

    await h.m.send('p', 'cx', 'cris', 'mais uma');
    await settle();
    h.f.last().emit({ type: 'turn.started' });
    h.f.last().emit({ type: 'turn.failed', error: { message: E503 } });
    await settle();
    expect(h.ledger.get('cx')).toMatchObject({ attempts: 1 });
    h.f.last().close(1);
    await h.fire();
    h.f.last().emit({ type: 'turn.started' });
    h.f.last().emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
    await settle();
    expect(h.ledger.get('cx')).toBeNull();
    h.f.last().close(0);
  });

  it('turno parado por nós (Parar) não vira queda nem erro: nenhum evento de retomada', async () => {
    const events: TurnEnd[] = [];
    const f = fakeCodex();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onTurnEnd: (e) => events.push(e), kill: (child) => void child.emit('close', 1) });
    chat.start();
    chat.send('oi');
    await settle();
    f.last().emit({ type: 'error', message: 'erro de antes do fechamento' });
    chat.interrupt(); // Parar: o codex sai com código 1 (taskkill)
    await settle();
    expect(events).toEqual([]);
    chat.send('de novo');
    await settle();
    f.last().emit({ type: 'turn.completed' });
    await settle();
    expect(events).toEqual([{ kind: 'ok' }]);
    f.last().close(0);
    await chat.stopAndWait();
  });

  it('falha ao abrir ou preparar o codex (configuração) nunca é queda: nenhum evento', async () => {
    const events: TurnEnd[] = [];
    const chat = new CodexProcess({
      ...profile,
      spawnImpl: () => {
        throw new Error('spawn codex ENOENT');
      },
      onTurnEnd: (e) => events.push(e),
    });
    chat.start();
    chat.send('oi');
    await settle();
    expect(events).toEqual([]);
    await chat.stopAndWait();
  });
});

// ---- aviso da retomada: o campo `retry` ----

type Notice = Extract<ChatItem, { kind: 'notice' }>;
/** Os avisos da retomada que a conversa mostra agora (o item é trocado no lugar: um por retomada). */
const retryNotices = async (m: ChatManager, sid: string): Promise<Notice[]> =>
  ((await m.snapshot('p', sid)).live?.items ?? []).filter((i): i is Notice => i.kind === 'notice' && i.id.startsWith('n:retry:'));

describe('aviso da retomada: o campo `retry` (a tela não precisa ler a frase)', () => {
  const info: RetryInfo = { turnId: 't', attempt: 1, max: 3, kind: 'transient', error: 'API sobrecarregada' };

  it('retryField: só o que faz sentido em cada estado; `at` só na espera; `error` cortado em 300', () => {
    expect(retryField('waiting', info, { at: T0 + 30_000, error: info.error })).toEqual({ state: 'waiting', attempt: 1, max: 3, at: T0 + 30_000, error: 'API sobrecarregada' });
    expect(retryField('sent', info)).toEqual({ state: 'sent', attempt: 1, max: 3 });
    expect(retryField('cancelled')).toEqual({ state: 'cancelled' });
    expect(retryField('dropped', info)).toEqual({ state: 'dropped', attempt: 1, max: 3 });
    expect(retryField('failed', undefined, { error: 'x'.repeat(400) }).error).toHaveLength(300);
    expect(retryField('failed')).toEqual({ state: 'failed' });
  });

  it('Claude: espera com tentativa, teto e o instante da volta em epoch ms; depois o mesmo aviso vira "retomou"; o texto segue igual', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();

    const [waiting, ...rest] = await retryNotices(h.m, 's1');
    expect(rest).toEqual([]);
    expect(waiting!.retry).toEqual({ state: 'waiting', attempt: 1, max: 3, at: T0 + 30_000, error: 'API sobrecarregada' });
    expect(waiting!.retry!.at).toBe((await h.retries.get('s1'))!.at); // o instante da pendência, em ms (UTC), não a hora do texto
    expect(waiting!.text).toBe(retryNotice.waiting(T0 + 30_000, info, 'API sobrecarregada'));
    expect(waiting!.tone).toBe('warn');

    await h.fire();
    const after = await retryNotices(h.m, 's1');
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(waiting!.id);
    expect(after[0]!.retry).toEqual({ state: 'sent', attempt: 1, max: 3 });
    expect(after[0]!.text).toBe(retryNotice.sent(info));
  });

  it('Claude: 2ª tentativa: o backoff maior (2 min) sai em `at`, a partir da hora em que a falha veio', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    await h.fire();
    p.emit(failed());
    await settle();
    // O "retomou" da 1ª fica na conversa; a 2ª espera é um aviso novo.
    const [first, second, ...rest] = await retryNotices(h.m, 's1');
    expect(rest).toEqual([]);
    expect(first!.retry).toEqual({ state: 'sent', attempt: 1, max: 3 });
    expect(second!.retry).toEqual({ state: 'waiting', attempt: 2, max: 3, at: h.clock.t + 120_000, error: 'API sobrecarregada' });
  });

  it('Claude: cancelada (Parar/mensagem), desligada e o envio que falhou: cada um com o estado dele', async () => {
    const h = build();
    const p = await h.start();
    p.emit(failed());
    await settle();
    h.m.interrupt('s1');
    await vi.waitFor(async () => expect((await retryNotices(h.m, 's1'))[0]!.retry).toEqual({ state: 'cancelled', attempt: 1, max: 3 }));
    expect((await retryNotices(h.m, 's1'))[0]).toMatchObject({ text: retryNotice.cancelled, tone: 'info' });

    const d = build();
    const q = await d.start();
    q.emit(failed());
    await settle();
    d.state.enabled = false; // a opção desligou com a retomada marcada
    await d.retries.tick();
    await vi.waitFor(async () => expect((await retryNotices(d.m, 's1'))[0]!.retry).toEqual({ state: 'dropped', attempt: 1, max: 3 }));
    expect((await retryNotices(d.m, 's1'))[0]).toMatchObject({ text: retryNotice.dropped, tone: 'warn' });

    const f = build();
    const r = await f.start();
    r.emit(failed());
    await settle();
    const send = vi.spyOn(ChatProcess.prototype, 'send').mockImplementationOnce(() => {
      throw new Error('o processo não respondeu');
    });
    try {
      await f.fire();
    } finally {
      send.mockRestore();
    }
    const [failedNotice] = await retryNotices(f.m, 's1');
    expect(failedNotice!.retry).toEqual({ state: 'failed', attempt: 1, max: 3, error: 'o processo não respondeu' });
    expect(failedNotice).toMatchObject({ text: retryNotice.failed('o processo não respondeu'), tone: 'warn' });
  });

  it('conversa fechada (reinício): o aviso que vem do histórico traz o `retry` da pendência guardada', async () => {
    const a = build();
    const p = await a.start();
    p.emit(failed());
    await settle();
    await a.ledger.flush();
    a.retries.stop();

    const b = build({}, a.dir);
    const snap = await b.m.snapshot('p', 's1');
    expect(snap.live).toBeNull();
    const notice = snap.history.find((i): i is Notice => i.kind === 'notice' && i.id.startsWith('n:retry:'));
    expect(notice?.retry).toEqual({ state: 'waiting', attempt: 1, max: 3, at: T0 + 30_000, error: 'API sobrecarregada' });
    expect(notice?.text).toBe(retryNotice.waiting(T0 + 30_000, info, 'API sobrecarregada'));
    // O que vai pelo fio (SSE/JSON) mantém o campo.
    expect(JSON.parse(JSON.stringify(notice)).retry).toEqual(notice!.retry);
  });

  it('Codex: a espera e a retomada saem com o mesmo campo (paridade)', async () => {
    const h = codexBuild();
    await h.start();
    h.f.last().emit({ type: 'turn.failed', error: { message: JSON.stringify({ type: 'error', status: 503, error: { type: 'server_error', message: 'Service Unavailable' } }) } });
    await settle();

    const [waiting, ...rest] = await retryNotices(h.m, 'cx');
    expect(rest).toEqual([]);
    expect(waiting!.retry).toEqual({ state: 'waiting', attempt: 1, max: 3, at: T0 + 30_000, error: 'erro 503 da API' });
    expect(waiting!.text).toBe(retryNotice.waiting(T0 + 30_000, { ...info, error: 'erro 503 da API' }, 'erro 503 da API'));

    h.f.last().close(1);
    await h.fire();
    const [sent] = await retryNotices(h.m, 'cx');
    expect(sent!.id).toBe(waiting!.id);
    expect(sent!.retry).toEqual({ state: 'sent', attempt: 1, max: 3 });
    h.f.last().emit({ type: 'turn.started' });
    h.f.last().emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
    await settle();
    h.f.last().close(0);
  });
});

// ---- processo Claude, direto ----

describe('ChatProcess: o que o gancho onTurnEnd recebe', () => {
  const claude = () => {
    const f = fakeClaude();
    const ends: TurnEnd[] = [];
    const chat = new ChatProcess({ sessionId: 's1', cwd: 'C:\\proj', args: [], spawnImpl: () => f.proc as never, onTurnEnd: (e) => ends.push(e) });
    chat.start();
    return { f, chat, ends };
  };

  it('erro do turno: o texto do resultado, o status e o tipo da mensagem sintética; com as ferramentas sem resultado', async () => {
    const { f, chat, ends } = claude();
    chat.send('rode');
    f.emit({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 500, message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500' }] } });
    f.emit(toolUse('t1', 'Bash', { command: 'ls' }));
    f.emit({ type: 'result', is_error: true, result: 'API Error: 500 Internal server error' });
    await settle();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: 'failed', error: { text: 'API Error: 500 Internal server error', status: 500, kind: 'server_error' }, awaitingAnswer: false, background: [] });
    const items = (ends[0] as Exclude<TurnEnd, { kind: 'ok' }>).items;
    expect(items.some((i) => i.kind === 'tool' && i.id === 't:t1' && i.result === null)).toBe(true);
  });

  it('o resultado traz `api_error_status` quando a mensagem sintética não veio', async () => {
    const { f, chat, ends } = claude();
    chat.send('rode');
    f.emit({ type: 'result', is_error: true, result: 'falha', api_error_status: 503 });
    await settle();
    expect(ends[0]).toMatchObject({ kind: 'failed', error: { text: 'falha', status: 503 } });
  });

  it('mensagem na fila do próprio claude: o trabalho segue, sem evento de falha; o fim sem erro é `ok`', async () => {
    const { f, chat, ends } = claude();
    chat.send('um');
    chat.send('dois', 'later');
    f.emit({ type: 'result', is_error: true, result: E529 });
    await settle();
    expect(ends).toEqual([]);
    f.emit({ type: 'result', is_error: false });
    await settle();
    expect(ends).toEqual([{ kind: 'ok' }]);
  });

  it('turno interrompido por você: sem evento, mesmo que o erro venha com outro subtipo', async () => {
    const { f, chat, ends } = claude();
    chat.send('um');
    chat.interrupt();
    f.emit({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'interrompido' });
    await settle();
    chat.send('dois');
    chat.interrupt();
    f.emit({ type: 'result', is_error: true, subtype: 'success', result: E529 });
    await settle();
    expect(ends).toEqual([]);
  });

  it('saída no meio do turno: `lost` com ocupação, pedido pendente e ferramentas, lidos antes de limpar; ocioso ou parado por nós: nada', async () => {
    const a = claude();
    a.chat.send('rode');
    a.f.emit(toolUse('t1', 'Bash', { command: 'git push' }));
    a.f.proc.emit('exit', null, 'SIGKILL');
    await settle();
    expect(a.ends).toHaveLength(1);
    expect(a.ends[0]).toMatchObject({ kind: 'lost', error: { text: expect.stringContaining('SIGKILL') } });
    expect((a.ends[0] as Exclude<TurnEnd, { kind: 'ok' }>).items.some((i) => i.kind === 'tool' && i.result === null)).toBe(true);

    const b = claude();
    b.f.proc.emit('exit', 1); // ocioso
    await settle();
    expect(b.ends).toEqual([]);

    const c = claude();
    c.chat.send('rode');
    c.chat.stop();
    c.f.proc.emit('exit', 1);
    await settle();
    expect(c.ends).toEqual([]);

    const d = claude();
    d.chat.send('rode');
    d.f.proc.emit('error', new Error('spawn claude ENOENT')); // não abriu: configuração, não queda
    await settle();
    expect(d.ends).toEqual([]);
  });
});

// ---- o card do quadro ----

const staff = (id: string, name: string) => ({ id, name, autonomy: 'acceptEdits', worktree: false, servers: [], engine: 'claude' }) as unknown as StaffProfile;

/** O serviço de tarefas com os ganchos da retomada (o que o servidor liga); `state` é o que o gerente de conversas diria. */
function board(dirName: string, state: { awaiting: boolean; cap: TurnCapHit | null; settle?: () => void; retry?: object | null }) {
  const dir = path.join(root, dirName);
  let k = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? staff('ana-1', 'Ana') : null),
    send: async () => `s-${++k}`,
    branchFor: async () => null,
    isWorking: () => false,
    sendTo: async (_p, sessionId) => sessionId,
    lastText: () => 'feito',
    awaitingLimit: async () => state.awaiting,
    settleRetry: async () => state.settle?.(),
    turnCap: () => state.cap,
    retryOf: async () => (state.retry ?? null) as never,
  });
  const make = async () => {
    const t = (await svc.create('p', { title: 'Relatório', staffId: 'ana-1', reviewerId: null }))!;
    await svc.start('p', t.id);
    return { id: t.id, work: (await svc.list('p'))!.find((x) => x.id === t.id)!.sessionId! };
  };
  const get = async (id: string) => (await svc.list('p'))!.find((x) => x.id === id)!;
  return { svc, make, get };
}

describe('o card durante a retomada', () => {
  it('com a retomada marcada, o fim do turno não manda para revisão: o card segue em "fazendo" e expõe a tentativa e a hora', async () => {
    const retry = { attempt: 1, max: 3, at: new Date(T0 + 30_000).toISOString(), kind: 'transient', error: 'API sobrecarregada' };
    const b = board(`b-${++n}`, { awaiting: true, cap: null, retry });
    const { id, work } = await b.make();
    await b.svc.onTurnDone(work);
    expect(await b.get(id)).toMatchObject({ status: 'doing', retry });
    // Sem retomada marcada (saiu, foi cancelada), o turno vale como fim, como antes.
    const c = board(`b-${++n}`, { awaiting: false, cap: null });
    const made = await c.make();
    await c.svc.onTurnDone(made.work);
    const done = await c.get(made.id);
    expect(done.status).toBe('review');
    expect(done.retry).toBeUndefined();
  });

  it('esgotou ou ação externa cortada: a tarefa vai para Aguardar com o motivo, depois de a decisão assentar', async () => {
    const hit: TurnCapHit = { kind: 'retry', why: 'cut', action: 'git push origin main', error: 'o processo caiu sem aviso' };
    const state = { awaiting: false, cap: null as TurnCapHit | null, settle: () => void (state.cap = hit) }; // a decisão só termina em `settleRetry`
    const b = board(`b-${++n}`, state);
    const { id, work } = await b.make();
    await b.svc.onTurnDone(work);
    expect(await b.get(id)).toMatchObject({ status: 'waiting', waitReason: expect.stringContaining('git push origin main') });
  });
});
