import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolAdapter } from '../server/adapters/types';
import { CodexProcess } from '../server/chat/codexProcess';
import { ChatManager } from '../server/chat/manager';
import {
  CodexPasswordPolicy,
  isPasswordPolicyFailure,
  parseMinPasswordAge,
  PASSWORD_POLICY_FIX,
  PASSWORD_POLICY_ID,
  POLICY_FAIL_TTL_MS,
  POLICY_OK_TTL_MS,
} from '../server/codexPasswordPolicy';
import type { RunResult, Runner } from '../server/folderPicker';
import { codexSandboxInboxItem } from '../server/inboxItems';
import { StaffService, type StaffServiceOptions } from '../server/staff/service';
import type { AccountUsage, Project } from '../shared/model';
import { removeTemp } from './support/tmp';

// O sandbox do Codex no Windows quebra quando a política local de senha tem "duração mínima" > 0 (código 2224/2245): o Club avisa a caixa do dono, com o comando, e nunca o roda.
// Nada aqui roda `net accounts` de verdade: o programa é falso e o sistema é injetado.

/** `net accounts` de uma máquina pt-BR, como o console o devolve (acentos quebrados pela página de código; só importa a ordem das linhas e o número). */
const rows = (minAge: string, rest = ['42', '7', '24', 'Nunca', '30', '30', 'ESTA��O de trabalho']) =>
  ['For�ar logoff do usu�rio ap�s expira��o depois de:          Nunca', `Dura��o m�nima da senha (dias):                             ${minAge}`, ...['Dura��o m�xima da senha (dias)', 'Comprimento m�nimo da senha', 'Dura��o do hist�rico de senhas', 'Limite de prote��o', 'Dura��o da prote��o (minutos)', 'Janela de observa��o de prote��o (minutos)', 'Fun��o do computador'].map((label, i) => `${label}:                  ${rest[i]}`), 'Comando conclu�do com �xito.', ''].join('\r\n');
const EN = [
  'Force user logoff how long after time expires?:       Never',
  'Minimum password age (days):                          1',
  'Maximum password age (days):                          42',
  'Minimum password length:                              7',
  'Length of password history maintained:                24',
  'Lockout threshold:                                    Never',
  'Lockout duration (minutes):                           30',
  'Lockout observation window (minutes):                 30',
  'Computer role:                                        WORKSTATION',
  'The command completed successfully.',
].join('\n');

const ERRO = 'helper_user_create_or_update_failed: failed to create/update user CodexSandboxOffline, code 2245';

describe('parseMinPasswordAge: a duração mínima, sem depender do idioma', () => {
  it('valor 0 e valor maior que 0, em pt-BR (acentos quebrados, CRLF) e em inglês', () => {
    expect(parseMinPasswordAge(rows('0'))).toBe(0);
    expect(parseMinPasswordAge(rows('1'))).toBe(1);
    expect(parseMinPasswordAge(rows('14'))).toBe(14);
    expect(parseMinPasswordAge(EN)).toBe(1);
    expect(parseMinPasswordAge(EN.replace('age (days):                          1', 'age (days):                          0'))).toBe(0);
  });

  it('saída ilegível vira null: vazia, lixo, linhas a menos, valor que não é número', () => {
    expect(parseMinPasswordAge('')).toBeNull();
    expect(parseMinPasswordAge('o sistema não pode encontrar o arquivo especificado.')).toBeNull();
    expect(parseMinPasswordAge('Erro de sistema 5: acesso negado.')).toBeNull();
    expect(parseMinPasswordAge(EN.split('\n').slice(0, 5).join('\n'))).toBeNull();
    expect(parseMinPasswordAge(rows('Nunca'))).toBeNull();
    expect(parseMinPasswordAge(rows('-1'))).toBeNull();
    expect(parseMinPasswordAge(rows('1,5'))).toBeNull();
  });

  it('não lê o rótulo: um idioma qualquer com a mesma ordem de linhas dá o mesmo número', () => {
    const ja = EN.split('\n').map((l, i) => (i < 9 ? l.replace(/^[^:]*:/, `項目${i}:`) : l)).join('\n');
    expect(parseMinPasswordAge(ja)).toBe(1);
  });
});

describe('isPasswordPolicyFailure: o erro do usuário do sandbox na saída do Codex', () => {
  it('reconhece o erro do helper e o código do Windows junto do usuário do sandbox', () => {
    expect(isPasswordPolicyFailure(ERRO)).toBe(true);
    expect(isPasswordPolicyFailure('helper_user_create_or_update_failed')).toBe(true);
    expect(isPasswordPolicyFailure('failed to create/update user CodexSandboxOnline, code 2224')).toBe(true);
    expect(isPasswordPolicyFailure('erro 2245 ao atualizar CodexSandboxOffline')).toBe(true);
  });

  it('o código sozinho, o usuário sozinho e outras falhas do sandbox não valem', () => {
    expect(isPasswordPolicyFailure('exit code 2245')).toBe(false);
    expect(isPasswordPolicyFailure('porta 22450 aberta')).toBe(false);
    expect(isPasswordPolicyFailure('CodexSandboxOffline')).toBe(false);
    expect(isPasswordPolicyFailure('Failed to create unified exec process: orchestrator_helper_incomplete')).toBe(false);
    expect(isPasswordPolicyFailure('')).toBe(false);
  });
});

/** O `net.exe` falso: devolve `out` (ou o resultado dado) e guarda cada chamada. */
function fakeNet(first: Partial<RunResult> | string = rows('1')) {
  let next: Partial<RunResult> | string = first;
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = typeof next === 'string' ? { stdout: next } : next;
    return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false, ...r };
  };
  return { run, calls, set: (v: Partial<RunResult> | string) => void (next = v) };
}

function policy(o: { net?: ReturnType<typeof fakeNet>; platform?: NodeJS.Platform; clock?: { t: number } } = {}) {
  const net = o.net ?? fakeNet();
  const clock = o.clock ?? { t: 1_000_000 };
  const logs: string[] = [];
  const p = new CodexPasswordPolicy({ platform: o.platform ?? 'win32', run: net.run, now: () => clock.t, env: { SystemRoot: 'C:\\Windows' }, log: (l) => logs.push(l) });
  return { p, net, clock, logs };
}

describe('CodexPasswordPolicy: a checagem prévia', () => {
  it('duração mínima > 0 levanta o aviso (source check); 0 não levanta', async () => {
    const a = policy();
    await a.p.check();
    expect(a.p.current()).toMatchObject({ minPasswordAgeDays: 1, source: 'check' });
    const b = policy({ net: fakeNet(rows('0')) });
    await b.p.check();
    expect(b.p.current()).toBeNull();
  });

  it('só LÊ: roda `net accounts` e nada mais, nunca `/minpwage` (o Club não altera a política)', async () => {
    const { p, net } = policy();
    await p.check();
    await p.noteFailure();
    expect(net.calls.length).toBeGreaterThan(0);
    for (const c of net.calls) {
      expect(c.cmd).toBe('C:\\Windows\\System32\\net.exe');
      expect(c.args).toEqual(['accounts']);
    }
  });

  it('falha na leitura = sem aviso, só log: saída ilegível, código de saída, prazo, programa ausente, runner que lança', async () => {
    for (const bad of [{ stdout: 'lixo' }, { code: 1, stdout: rows('1') }, { code: null, timedOut: true }, { code: null, missing: true }] as Array<Partial<RunResult>>) {
      const t = policy({ net: fakeNet(bad) });
      await t.p.check();
      expect(t.p.current()).toBeNull();
      expect(t.logs.length).toBeGreaterThan(0);
    }
    const logs: string[] = [];
    const boom = new CodexPasswordPolicy({
      platform: 'win32',
      run: async () => {
        throw new Error('spawn quebrou');
      },
      log: (l) => logs.push(l),
    });
    await expect(boom.check()).resolves.toBeUndefined();
    expect(boom.current()).toBeNull();
    expect(logs.join('\n')).toMatch(/spawn quebrou/);
  });

  it('cache: não roda a cada chamada; depois do prazo lê de novo (10 min; 2 min se a leitura falhou)', async () => {
    const t = policy();
    await t.p.check();
    await t.p.check();
    await t.p.check();
    expect(t.net.calls).toHaveLength(1);
    t.clock.t += POLICY_OK_TTL_MS - 1;
    await t.p.check();
    expect(t.net.calls).toHaveLength(1);
    t.clock.t += 2;
    await t.p.check();
    expect(t.net.calls).toHaveLength(2);

    const f = policy({ net: fakeNet({ stdout: 'lixo' }) });
    await f.p.check();
    f.clock.t += POLICY_FAIL_TTL_MS - 1;
    await f.p.check();
    expect(f.net.calls).toHaveLength(1);
    f.clock.t += 2;
    await f.p.check();
    expect(f.net.calls).toHaveLength(2);
  });

  it('chamadas ao mesmo tempo dividem uma leitura só', async () => {
    const t = policy();
    await Promise.all([t.p.check(), t.p.check(), t.p.check(), t.p.noteFailure()]);
    expect(t.net.calls).toHaveLength(1);
  });

  it('o aviso fica como resolvido quando a checagem seguinte passa (0); mudou de valor, atualiza o mesmo aviso', async () => {
    const t = policy();
    await t.p.check();
    const at = t.p.current()!.at;
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
    t.net.set(rows('3'));
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 3, at });
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
    t.net.set(rows('0'));
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 3, at, resolvedAt: new Date(t.clock.t).toISOString() });
    // Leitura em 0 de novo não muda a hora em que o aviso passou.
    const resolvedAt = t.p.current()!.resolvedAt;
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()!.resolvedAt).toBe(resolvedAt);
  });
});

describe('CodexPasswordPolicy: fora do Windows nada roda', () => {
  it.each(['linux', 'darwin'] as const)('%s: a checagem não lê, o erro na saída não levanta aviso e a caixa fica vazia', async (platform) => {
    const t = policy({ platform });
    await t.p.check();
    await t.p.noteFailure();
    expect(t.net.calls).toHaveLength(0);
    expect(t.p.current()).toBeNull();
    expect(t.logs).toEqual([]);
  });
});

describe('CodexPasswordPolicy: o erro visto no turno', () => {
  it('levanta o aviso (source turn) com leitura fresca, mesmo com a checagem em cache', async () => {
    const t = policy({ net: fakeNet(rows('0')) });
    await t.p.check(); // cache: 0
    t.net.set(rows('2')); // a política mudou desde a leitura em cache
    await t.p.noteFailure();
    expect(t.net.calls).toHaveLength(2);
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 2, source: 'turn' });
  });

  it('dedupe: um aviso por máquina; o erro repetido (todo comando falha) não lê nem avisa de novo', async () => {
    const t = policy();
    for (let i = 0; i < 5; i++) await t.p.noteFailure();
    expect(t.net.calls).toHaveLength(1);
    const first = t.p.current();
    await t.p.check();
    await t.p.noteFailure();
    expect(t.p.current()).toBe(first);
  });

  it('a leitura mostra 0: o aviso sai mesmo assim (a causa é outra regra de senha) e a checagem em 0 não o apaga', async () => {
    const t = policy({ net: fakeNet(rows('0')) });
    await t.p.noteFailure();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 0, source: 'turn' });
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).not.toBeNull();
  });

  it('a leitura falhou: o aviso sai sem o valor (null)', async () => {
    const t = policy({ net: fakeNet({ stdout: 'lixo' }) });
    await t.p.noteFailure();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: null, source: 'turn' });
  });

  it('aviso que nasceu de leitura que falhou (null) fica resolvido quando a checagem seguinte lê 0; leitura que falha de novo não o marca', async () => {
    const t = policy({ net: fakeNet({ stdout: 'lixo' }) });
    await t.p.noteFailure();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: null });
    t.clock.t += POLICY_FAIL_TTL_MS + 1;
    await t.p.check(); // segue ilegível: sem informação nova, o aviso fica
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: null });
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
    t.net.set(rows('0'));
    t.clock.t += POLICY_FAIL_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: null, resolvedAt: expect.any(String) });
    expect(t.net.calls).toHaveLength(3);
  });

  it('aviso nascido de leitura null: leitura >0 o atualiza (com o comando) e o 0 depois o marca como resolvido', async () => {
    const t = policy({ net: fakeNet({ stdout: 'lixo' }) });
    await t.p.noteFailure();
    t.net.set(rows('2'));
    t.clock.t += POLICY_FAIL_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 2, source: 'turn' });
    t.net.set(rows('0'));
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 2, resolvedAt: expect.any(String) });
  });

  it('resolvido pelo 0 e o erro seguiu: o próximo erro do turno levanta um aviso novo, agora com 0 (outra regra) e sem a marca, e esse a checagem em 0 não marca', async () => {
    const t = policy({ net: fakeNet({ stdout: 'lixo' }) });
    await t.p.noteFailure();
    t.net.set(rows('0'));
    t.clock.t += POLICY_FAIL_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ resolvedAt: expect.any(String) });
    await t.p.noteFailure();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 0, source: 'turn' });
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 0 });
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
  });

  it('erro do turno com a política já corrigida: aviso levantado com >0 fica resolvido quando a checagem passar', async () => {
    const t = policy();
    await t.p.noteFailure();
    expect(t.p.current()).not.toBeNull();
    expect(t.p.current()).not.toHaveProperty('resolvedAt');
    t.net.set(rows('0'));
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ resolvedAt: expect.any(String) });
  });
});

describe('CodexPasswordPolicy: ignorar', () => {
  it('ignora pelo id; id errado ou sem aviso = false (tela velha)', async () => {
    const t = policy();
    expect(t.p.dismiss(PASSWORD_POLICY_ID)).toBe(false);
    await t.p.check();
    expect(t.p.dismiss('codexsandbox:outro')).toBe(false);
    expect(t.p.current()).not.toBeNull();
    expect(t.p.dismiss(PASSWORD_POLICY_ID)).toBe(true);
    expect(t.p.current()).toBeNull();
    expect(t.p.dismiss(PASSWORD_POLICY_ID)).toBe(false);
  });

  it('ignorado não volta (checagem nem erro do turno) enquanto a política seguir falhando; passou e falhou de novo, volta', async () => {
    const t = policy();
    await t.p.check();
    t.p.dismiss(PASSWORD_POLICY_ID);
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    await t.p.noteFailure();
    expect(t.p.current()).toBeNull();
    // A política foi corrigida (0): vale de novo para a próxima vez.
    t.net.set(rows('0'));
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toBeNull();
    t.net.set(rows('1'));
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check();
    expect(t.p.current()).toMatchObject({ minPasswordAgeDays: 1, source: 'check' });
  });

  it('ignorar um aviso do turno com a causa em 0 também silencia o erro repetido', async () => {
    const t = policy({ net: fakeNet(rows('0')) });
    await t.p.noteFailure();
    expect(t.p.dismiss(PASSWORD_POLICY_ID)).toBe(true);
    t.clock.t += POLICY_OK_TTL_MS + 1;
    await t.p.check(); // lê 0, mas nunca esteve acima de 0: o "ignorado" fica
    await t.p.noteFailure();
    expect(t.p.current()).toBeNull();
  });
});

describe('codexSandboxInboxItem: o contrato do item da caixa', () => {
  const at = '2026-11-19T10:00:00.000Z';

  it('duração > 0: kind error, id fixo, sem projeto nem conversa, com o comando, "administrador" e a nota do domínio', () => {
    const item = codexSandboxInboxItem({ minPasswordAgeDays: 1, source: 'check', at });
    expect(item).toMatchObject({
      id: 'codexsandbox:password-policy',
      kind: 'error',
      projectId: '',
      projectName: '',
      sessionId: '',
      staffId: null,
      name: 'Sandbox do Codex',
      at,
      codexSandbox: { cause: 'password-policy', source: 'check', minPasswordAgeDays: 1, command: 'net accounts /minpwage:0', domainNote: true },
    });
    expect(item.summary).toContain('net accounts /minpwage:0');
    expect(item.summary).toMatch(/administrador/);
    expect(item.summary).toMatch(/domínio/);
    expect(item.summary).toMatch(/1 dia\b/);
    expect(codexSandboxInboxItem({ minPasswordAgeDays: 3, source: 'turn', at }).summary).toMatch(/3 dias/);
  });

  it('leitura 0: não manda rodar o comando (a causa é outra regra); sem leitura: manda conferir antes', () => {
    const zero = codexSandboxInboxItem({ minPasswordAgeDays: 0, source: 'turn', at });
    expect(zero.summary).not.toContain('/minpwage');
    expect(zero.codexSandbox).toMatchObject({ minPasswordAgeDays: 0, source: 'turn', command: PASSWORD_POLICY_FIX });
    const unknown = codexSandboxInboxItem({ minPasswordAgeDays: null, source: 'turn', at });
    expect(unknown.summary).toMatch(/confira com net accounts/);
    expect(unknown.summary).toContain('net accounts /minpwage:0');
    expect(unknown.summary).toMatch(/domínio/);
  });
});

// ---- o erro na saída do Codex (CodexProcess) ----

function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void; close: (code?: number | null) => void }> = [];
  const spawnImpl = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 8100 + runs.length });
    stdin.on('data', () => {});
    runs.push({ emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'), close: (code = 0) => void child.emit('close', code) });
    return child as never;
  };
  return { runs, spawnImpl: spawnImpl as never, last: () => runs[runs.length - 1]! };
}
const tick = () => new Promise((r) => setTimeout(r, 15));
const profile = { cwd: '/proj', sessionId: 'pp-1', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };

/** Roda uma execução do Codex que emite `events` e termina; devolve quantas vezes o aviso foi pedido. */
async function seen(events: object[], over: Partial<ConstructorParameters<typeof CodexProcess>[0]> = {}) {
  const f = fakeCodex();
  let n = 0;
  const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onPasswordPolicyFailure: () => void n++, ...over });
  chat.start();
  chat.send('rode algo');
  await tick();
  for (const ev of events) f.last().emit(ev);
  await tick();
  f.last().emit({ type: 'turn.completed', usage: {} });
  f.last().close(0);
  await tick();
  return n;
}
const cmd = (over: object) => ({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'dir', aggregated_output: ERRO, ...over } });

describe('CodexProcess: o erro do usuário do sandbox na saída de uma ferramenta', () => {
  it('comando que falhou (status failed, ou código de saída ≠ 0) com o erro avisa', async () => {
    expect(await seen([cmd({ status: 'failed', exit_code: null })])).toBe(1);
    expect(await seen([cmd({ status: 'completed', exit_code: 1 })])).toBe(1);
    expect(await seen([cmd({ status: 'failed', exit_code: 1 })])).toBe(1);
  });

  it('todo comando falhando igual chama a cada um (o dedupe é de quem recebe)', async () => {
    expect(await seen([cmd({ id: 'a', status: 'failed' }), cmd({ id: 'b', status: 'failed' }), cmd({ id: 'c', status: 'failed' })])).toBe(3);
  });

  it('o aviso do Codex (item error) e o erro do turno (turn.failed) também valem', async () => {
    expect(await seen([{ type: 'item.completed', item: { id: 'item_1', type: 'error', message: ERRO } }])).toBe(1);
    expect(await seen([{ type: 'turn.failed', error: { message: ERRO } }])).toBe(1);
  });

  it('o mesmo texto num comando que deu certo (um grep no código) não avisa; falha por outro motivo também não', async () => {
    expect(await seen([cmd({ status: 'completed', exit_code: 0 })])).toBe(0);
    expect(await seen([cmd({ status: 'failed', exit_code: 1, aggregated_output: 'No such file or directory' })])).toBe(0);
    expect(await seen([cmd({ status: 'failed', aggregated_output: 'Failed to create unified exec process: orchestrator_helper_incomplete' })])).toBe(0);
    expect(await seen([{ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'dir', aggregated_output: ERRO, status: 'failed' } }])).toBe(0);
  });

  it('a conversa segue igual: o comando aparece com a falha e quem recebe que lança não derruba o turno', async () => {
    const f = fakeCodex();
    const chat = new CodexProcess({
      ...profile,
      spawnImpl: f.spawnImpl,
      onPasswordPolicyFailure: () => {
        throw new Error('quem recebe falhou');
      },
    });
    chat.start();
    chat.send('rode algo');
    await tick();
    f.last().emit(cmd({ status: 'failed' }));
    f.last().emit({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: 'pronto' } });
    await tick();
    f.last().emit({ type: 'turn.completed', usage: {} });
    f.last().close(0);
    await tick();
    const items = chat.snapshot().items;
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ isError: true });
    expect(items.some((i) => i.kind === 'assistant' && i.text === 'pronto')).toBe(true);
  });

  it('sem o callback (testes, outros usos) nada muda', async () => {
    expect(await seen([cmd({ status: 'failed' })], { onPasswordPolicyFailure: undefined })).toBe(0);
  });
});

// ---- as pontas: ChatManager (abrir conversa Codex) e StaffService (salvar ficha) ----

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-pwpolicy-'));
  await fs.mkdir(path.join(root, 'proj'), { recursive: true });
});
afterAll(() => removeTemp(root));

describe('ChatManager: a conversa do Codex abre e leva o aviso adiante', () => {
  function manager(engine: 'codex' | 'claude', extra: Partial<ConstructorParameters<typeof ChatManager>[0]> = {}) {
    const f = fakeCodex();
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) =>
        engine === 'codex'
          ? {
              sessionId: sid ?? 'sess-pp',
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
                heavyGuard: null,
                secrets: { projectPath: root, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-myco') },
                threadId: null,
                threadFile: path.join(root, 'thread-pp.json'),
                mycoUrl: 'http://127.0.0.2:4848',
              },
            }
          : { sessionId: sid ?? 'sess-claude', cwd: root, args: ['--model', 'opus'] },
      spawnImpl: f.spawnImpl,
      log: () => {},
      ...extra,
    });
    return { m, f };
  }
  const opened = async (f: ReturnType<typeof fakeCodex>) => {
    for (let i = 0; i < 100 && f.runs.length < 1; i++) await tick();
    expect(f.runs).toHaveLength(1);
  };

  it('abrir conversa Codex pede a checagem prévia; conversa do Claude não pede; callback que lança não impede abrir', async () => {
    let opens = 0;
    const codex = manager('codex', { onCodexOpen: () => void opens++ });
    await codex.m.send('p', null, 'cris', 'oi');
    await opened(codex.f);
    expect(opens).toBe(1);
    codex.f.last().emit({ type: 'turn.completed', usage: {} });
    codex.f.last().close(0);
    await tick();

    const claude = manager('claude', { onCodexOpen: () => void opens++ });
    await claude.m.send('p', null, 'cris', 'oi').catch(() => {});
    expect(opens).toBe(1);

    const boom = manager('codex', {
      onCodexOpen: () => {
        throw new Error('checagem quebrou');
      },
    });
    await boom.m.send('p', null, 'cris', 'oi');
    await opened(boom.f);
    boom.f.last().emit({ type: 'turn.completed', usage: {} });
    boom.f.last().close(0);
    await tick();
  });

  it('o erro do usuário do sandbox numa conversa chega a onCodexPasswordPolicyFailure', async () => {
    let hits = 0;
    const { m, f } = manager('codex', { onCodexPasswordPolicyFailure: () => void hits++ });
    await m.send('p', null, 'cris', 'rode algo');
    await opened(f);
    f.last().emit(cmd({ status: 'failed' }));
    await tick();
    expect(hits).toBe(1);
    f.last().emit({ type: 'turn.completed', usage: {} });
    f.last().close(0);
    await tick();
  });
});

describe('StaffService: salvar ficha do Codex pede a checagem prévia', () => {
  const project = (): Project => ({ id: 'proj-id', path: path.join(root, 'proj'), name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null });
  const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
  const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
  const service = (over: Partial<StaffServiceOptions> = {}) =>
    new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage, codexEnabled: async () => true, ...over });
  const base = { role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false };

  it('contratar e editar com engine codex pedem; ficha do Claude não pede; callback que lança não derruba o salvar', async () => {
    let n = 0;
    const svc = service({ onCodexProfile: () => void n++ });
    await svc.hire('proj-id', { ...base, name: 'Pp Claude' }, true);
    expect(n).toBe(0);
    const codex = (await svc.hire('proj-id', { ...base, name: 'Pp Codex', engine: 'codex' }, true))!.profile;
    expect(n).toBe(1);
    await svc.update('proj-id', codex.id, { ...base, name: 'Pp Codex', mission: 'Outra' });
    expect(n).toBe(2);
    const claude = (await svc.hire('proj-id', { ...base, name: 'Pp Vira Codex' }, true))!.profile;
    expect(n).toBe(2);
    await svc.update('proj-id', claude.id, { ...base, name: 'Pp Vira Codex', engine: 'codex' });
    expect(n).toBe(3);
    await svc.update('proj-id', claude.id, { ...base, name: 'Pp Vira Codex', engine: 'claude' });
    expect(n).toBe(3);

    const boom = service({
      onCodexProfile: () => {
        throw new Error('checagem quebrou');
      },
    });
    await expect(boom.hire('proj-id', { ...base, name: 'Pp Boom', engine: 'codex' }, true)).resolves.toMatchObject({ profile: { engine: 'codex' } });
  });
});

describe('a fiação do servidor (index.ts)', () => {
  it('a política nasce uma vez e liga a ficha, a conversa, a saída do Codex, a caixa e o ignorar', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(src.match(/new CodexPasswordPolicy\(/g)).toHaveLength(1);
    expect(src).toContain('onCodexProfile: () => void codexPolicy.check(),');
    expect(src).toContain('onCodexOpen: () => void codexPolicy.check(),');
    expect(src).toContain('onCodexPasswordPolicyFailure: () => void codexPolicy.noteFailure(),');
    expect(src).toContain('resolver.codexSandbox(codexSandboxInboxItem(sandbox))');
    expect(src).toContain('codexPolicy.dismiss(b.id)');
    expect(src).toMatch(/regex\(\/\^\(error\|cap\|commit\|guardoff\|codexsandbox\|board\):/);
    // O Club nunca muda a política: nenhum arquivo do servidor roda o comando que ele sugere.
    for (const file of ['codexPasswordPolicy.ts', 'index.ts', path.join('chat', 'codexProcess.ts'), path.join('chat', 'manager.ts')]) {
      const text = await fs.readFile(path.join(__dirname, '..', 'server', file), 'utf8');
      expect(text, file).not.toMatch(/(?:run|spawn|exec\w*)\([^)]*minpwage/i);
    }
  });
});
