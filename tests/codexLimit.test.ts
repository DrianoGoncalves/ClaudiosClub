import { mkdirSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexUsage, UsageLimit } from '../shared/model';
import { AutoContinue } from '../server/chat/autoContinue';
import { parseCodexFailure } from '../server/chat/codexEvents';
import { ChatManager } from '../server/chat/manager';
import { RETRY_MS, SLACK_MS } from '../server/chat/usageLimit';
import { codexLimitHit } from '../server/codexUsage';
import { readUsage } from '../server/usage';

// Limite do Codex: a hora de voltar é a que o leitor do Codex dá (ou 30 min), o motor vai junto na pendência e a trava de
// consumo confere o motor da conversa. Erro que não é cota (autenticação, limite por minuto, contexto) não agenda nada.

const HOUR = 3_600_000;
const tick = () => new Promise((r) => setTimeout(r, 15));
const iso = (ms: number) => new Date(ms).toISOString();

/** Cada `spawn` é uma execução do `codex exec` falsa: `emit` simula o stdout. */
function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void }> = [];
  const spawnImpl = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on('data', () => {});
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 5000 + runs.length });
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n') });
    return child as never;
  };
  return { spawnImpl, last: () => runs[runs.length - 1]! };
}

const usageOf = (limits: UsageLimit[]): CodexUsage => ({ connected: true, reason: null, detail: null, limits, updatedAt: null, version: null, upgradeCommand: null });

let root: string;
let n = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-limit-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** O erro de cota do plano; `resets` é o `resets_in_seconds` que o Codex manda (ausente se não passar). */
const limitMsg = (resets?: unknown) =>
  JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', ...(resets !== undefined && { resets_in_seconds: resets }) } });
const USAGE_LIMIT = limitMsg();
const AUTH = JSON.stringify({ type: 'error', status: 401, error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key provided' } });

/**
 * Gerente com o Codex (ficha `cris`) e o agendador dele. `stops` guarda (ficha, motor) de cada conferência da trava.
 * `claudeLimits`: o consumo do Claude já estourado, gravado no usage.json que o gerente lê.
 */
function setup(over: { codexLimits?: () => Promise<CodexUsage | null>; claudeLimits?: UsageLimit[] } = {}) {
  const f = fakeCodex();
  const dir = path.join(root, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const stops: Array<[string | null, string]> = [];
  const file = path.join(dir, 'auto-continue.json');
  const usageFile = path.join(dir, 'usage.json');
  if (over.claudeLimits) writeFileSync(usageFile, JSON.stringify({ updatedAt: iso(Date.now()), sessionId: 'claude-x', limits: over.claudeLimits }));
  const ac = new AutoContinue({
    file,
    enabled: async () => true,
    stopHit: async (_p, staffId, engine) => {
      stops.push([staffId, engine]);
      return null;
    },
    knownResets: async () => [],
    send: async () => {},
    spacingMs: 0,
    log: () => {},
  });
  const m = new ChatManager({
    transcriptsDir: dir,
    usageFile,
    listLive: async () => [],
    resolve: async (_p, sessionId, staffId) =>
      staffId === 'cris'
        ? {
            sessionId: sessionId ?? `codex-${n}`,
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
              secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') },
              threadId: null,
              threadFile: path.join(dir, 'codex-thread.json'),
              mycoUrl: 'http://127.0.0.2:4848',
            },
          }
        : null,
    spawnImpl: f.spawnImpl,
    autoContinue: ac,
    codexLimits: over.codexLimits,
    log: () => {},
  });
  return { f, ac, m, file, usageFile, stops };
}

/** Uma mensagem no Codex que termina com `msg` em `turn.failed`; devolve a conversa, depois do agendamento (se houver). */
async function failTurn(s: ReturnType<typeof setup>, msg: string) {
  const sid = await s.m.send('p', null, 'cris', 'oi');
  await tick();
  s.f.last().emit({ type: 'turn.started' });
  s.f.last().emit({ type: 'turn.failed', error: { message: msg } });
  await tick();
  await s.m.awaitingLimit(sid);
  return sid;
}

describe('codexLimitHit: o Codex está no limite agora? até quando?', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const lim = (kind: string, percentUsed: number, resetsAt: string | null): UsageLimit => ({ kind, percentUsed, resetsAt });

  it('janela em 100% com reset no futuro: devolve o reset e a janela (mesmo formato do Claude)', () => {
    expect(codexLimitHit(usageOf([lim('five_hour', 100, iso(now + HOUR))]), now)).toEqual({ resetsAt: now + HOUR, window: 'five_hour' });
  });

  it('entre as esgotadas, vale a que volta por último (a conversa só anda com todas livres)', () => {
    const usage = usageOf([lim('five_hour', 100, iso(now + HOUR)), lim('seven_day', 100, iso(now + 5 * HOUR))]);
    expect(codexLimitHit(usage, now)).toEqual({ resetsAt: now + 5 * HOUR, window: 'seven_day' });
  });

  it('nada a dizer: abaixo de 100%, reset já passado, reset desconhecido, sem leitura', () => {
    expect(codexLimitHit(usageOf([lim('five_hour', 99, iso(now + HOUR))]), now)).toBeNull();
    expect(codexLimitHit(usageOf([lim('five_hour', 100, iso(now - 1000))]), now)).toBeNull();
    expect(codexLimitHit(usageOf([lim('five_hour', 100, null)]), now)).toBeNull();
    expect(codexLimitHit(null, now)).toBeNull();
    expect(codexLimitHit(undefined, now)).toBeNull();
  });
});

describe('classificação: só a cota do plano agenda o "continue"', () => {
  it('limite de uso do plano: limit true, com a mensagem em português', () => {
    const hit = parseCodexFailure(limitMsg(7200));
    expect(hit.limit).toBe(true);
    expect(hit.resetsIn).toBe(7200);
    expect(hit.text).toMatch(/^Limite de uso do Codex atingido \(volta em 2 h\): The usage limit has been reached\./);
    expect(parseCodexFailure("You've hit your usage limit. Try again later.").limit).toBe(true);
  });

  it('limite por minuto (429 passageiro, "limit reached" também) e cota da API: erro, sem agendar', () => {
    expect(parseCodexFailure('{"type":"error","status":429,"error":{"type":"rate_limit_exceeded","message":"Rate limit reached for requests. Please try again in 20s"}}').limit).toBe(false);
    expect(parseCodexFailure('Rate limit reached for gpt-6-sol on requests per min (RPM). Please try again in 20s.').limit).toBe(false);
    expect(parseCodexFailure('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan"}}').limit).toBe(false);
  });

  it('autenticação, contexto cheio e rede: erro, sem agendar', () => {
    expect(parseCodexFailure(AUTH)).toEqual({ text: 'Incorrect API key provided', limit: false });
    expect(parseCodexFailure('Context limit reached: /compact to continue').limit).toBe(false);
    expect(parseCodexFailure('context_length_exceeded: input too long').limit).toBe(false);
    expect(parseCodexFailure('fetch failed: ECONNRESET').limit).toBe(false);
  });
});

describe('ChatManager: limite do Codex agenda o "continue"', () => {
  it('agenda com o reset que o leitor do Codex deu (+ folga), e grava o motor na pendência', async () => {
    const reset = Math.floor((Date.now() + HOUR) / 1000) * 1000;
    const s = setup({ codexLimits: async () => usageOf([{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(reset) }]) });
    const sid = await failTurn(s, USAGE_LIMIT);
    expect(await s.ac.get(sid)).toMatchObject({ projectId: 'p', staffId: 'cris', resetsAt: reset, at: reset + SLACK_MS, engine: 'codex' });
  });

  it('o reset do próprio erro (resets_in_seconds) vem antes do leitor; valor inválido (negativo, NaN, mais de 8 dias) cai para o leitor', async () => {
    const readerReset = Math.floor((Date.now() + 2 * HOUR) / 1000) * 1000;
    const reader = async () => usageOf([{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(readerReset) }]);
    const before = Date.now();
    const s = setup({ codexLimits: reader });
    const own = await s.ac.get(await failTurn(s, limitMsg(3600)));
    expect(own?.resetsAt).toBeGreaterThanOrEqual(before + HOUR);
    expect(own?.resetsAt).toBeLessThanOrEqual(Date.now() + HOUR);
    for (const bad of [-5, 'NaN', 8 * 86_400 + 1]) {
      const s = setup({ codexLimits: reader });
      expect((await s.ac.get(await failTurn(s, limitMsg(bad))))?.resetsAt).toBe(readerReset);
    }
  });

  it('sem reset conhecido (leitor vazio, janela só em uso, leitor sem resposta): 30 min', async () => {
    const readers: Array<(() => Promise<CodexUsage | null>) | undefined> = [
      async () => usageOf([]),
      async () => usageOf([{ kind: 'five_hour', percentUsed: 80, resetsAt: iso(Date.now() + HOUR) }]),
      async () => null,
      undefined,
    ];
    for (const codexLimits of readers) {
      const s = setup({ codexLimits });
      const before = Date.now();
      const p = await s.ac.get(await failTurn(s, USAGE_LIMIT));
      expect(p?.resetsAt).toBeGreaterThanOrEqual(before + RETRY_MS);
      expect(p?.resetsAt).toBeLessThanOrEqual(Date.now() + RETRY_MS);
      expect(p?.at).toBe(p?.resetsAt);
    }
  });

  it('reset do leitor já passado não serve: 30 min', async () => {
    const s = setup({ codexLimits: async () => usageOf([{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(Date.now() - 1000) }]) });
    const before = Date.now();
    const p = await s.ac.get(await failTurn(s, USAGE_LIMIT));
    expect(p?.resetsAt).toBeGreaterThanOrEqual(before + RETRY_MS);
  });

  it('o uso do Claude no limite não entra na hora de voltar do Codex (nem o reset dele)', async () => {
    const claudeReset = Date.now() + 10 * 60_000;
    const s = setup({ claudeLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(claudeReset) }], codexLimits: async () => usageOf([]) });
    // Controle: o consumo do Claude está lido e estourado (é o que o Claude usaria para voltar).
    expect((await readUsage(s.usageFile)).limits[0]).toMatchObject({ percentUsed: 100, resetsAt: iso(claudeReset) });
    const before = Date.now();
    const p = await s.ac.get(await failTurn(s, USAGE_LIMIT));
    expect(p?.resetsAt).not.toBe(claudeReset);
    expect(p?.resetsAt).toBeGreaterThanOrEqual(before + RETRY_MS);
  });

  it('erro de autenticação não agenda nada: a conversa mostra o erro e não há "continue" pendente', async () => {
    const s = setup({ codexLimits: async () => usageOf([{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(Date.now() + HOUR) }]) });
    const sid = await failTurn(s, AUTH);
    expect(await s.ac.get(sid)).toBeNull();
    const items = (await s.m.snapshot('p', sid)).live!.items;
    expect(items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error', text: 'Incorrect API key provided' });
  });

  it('erro de limite por minuto (429 passageiro) também não agenda', async () => {
    const s = setup();
    expect(await s.ac.get(await failTurn(s, '{"type":"error","status":429,"error":{"type":"rate_limit_exceeded","message":"Rate limit reached for requests"}}'))).toBeNull();
  });
});

describe('trava de consumo: o motor da conversa é o que se confere', () => {
  it('a pendência do Codex e a do Claude chegam à trava com o motor delas', async () => {
    const s = setup();
    const past = Date.now() - 1000;
    await s.ac.schedule({ projectId: 'p', sessionId: 'x-codex', staffId: 'cris', at: past, resetsAt: past, engine: 'codex' });
    await s.ac.schedule({ projectId: 'p', sessionId: 'x-claude', staffId: 'ana', at: past, resetsAt: past });
    await s.ac.tick();
    await s.ac.tick();
    expect(s.stops).toEqual([
      ['cris', 'codex'],
      ['ana', 'claude'],
    ]);
  });

  it('o motor vai para o disco e volta igual (sobrevive a reiniciar o servidor)', async () => {
    const s = setup();
    const at = Date.now() + HOUR;
    await s.ac.schedule({ projectId: 'p', sessionId: 'x-disco', staffId: 'cris', at, resetsAt: at, engine: 'codex' });
    const saved = JSON.parse(await fs.readFile(s.file, 'utf8')) as { pending: Array<{ sessionId: string; engine?: string }> };
    expect(saved.pending.find((p) => p.sessionId === 'x-disco')?.engine).toBe('codex');
    const again = new AutoContinue({ file: s.file, enabled: async () => true, stopHit: async () => null, knownResets: async () => [], send: async () => {}, log: () => {} });
    expect(await again.get('x-disco')).toMatchObject({ engine: 'codex' });
  });
});
