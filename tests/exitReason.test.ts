import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_REPORT_TTL_MS,
  diagnoseExit,
  journalOomEvidence,
  markCleanStop,
  markSessionClean,
  readLastExit,
  readSession,
  saveLastExit,
  writeSession,
  type DiagnoseContext,
  type SessionMarker,
} from '../server/exitReason';
import { writeLogSnapshot } from '../scripts/lib';
import { logScript } from '../server/startPage';
import { removeTemp } from './support/tmp';

// Em 27/11/2026 o systemd-oomd matou o Claudio’s Club inteiro (vigia incluído) e o log ficou mudo das 08:56 às 09:39: ninguém soube por quê. Na subida seguinte o vigia
// lê o marcador que o anterior deixou (`run/daemon.session.json`): se ele ainda diz "no ar", a saída não foi limpa, e o motivo vai para o log e para a página de início.

const T = (hhmm: string) => Date.parse(`2026-11-27T${hhmm}:00Z`);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const UNIT = 'app-claudios-1795779754569.scope';

const marker = (o: Partial<SessionMarker> = {}): SessionMarker => ({
  pid: 25_330,
  startedAt: new Date(T('08:40')).toISOString(),
  lastBeat: new Date(T('09:24')).toISOString(),
  unit: UNIT,
  clean: false,
  freePct: 40,
  pressure: 1,
  ...o,
});

/** Agora = 09:39; o computador ligou às 07:00. `evidence` é o que o journal devolve. */
function ctx(o: { evidence?: { at: number; by: 'oomd' | 'kernel' } | null | 'throw'; uptimeSec?: number; selfPid?: number } = {}): DiagnoseContext & { asked: Array<[string, number]> } {
  const asked: Array<[string, number]> = [];
  return {
    now: T('09:39'),
    uptimeSec: o.uptimeSec ?? 2 * 3600 + 39 * 60,
    selfPid: o.selfPid ?? 99_999,
    clock,
    asked,
    oomEvidence: async (unit, since) => {
      asked.push([unit, since]);
      if (o.evidence === 'throw') throw new Error('journalctl: sem acesso');
      return o.evidence ?? null;
    },
  };
}

describe('diagnoseExit: a saída anterior foi limpa?', () => {
  it('primeira subida (sem marcador), parada limpa ou o marcador deste mesmo processo: nada a dizer', async () => {
    expect(await diagnoseExit(null, ctx())).toBeNull();
    expect(await diagnoseExit(marker({ clean: true }), ctx())).toBeNull();
    expect(await diagnoseExit(marker({ pid: 99_999 }), ctx({ selfPid: 99_999 }))).toBeNull();
  });

  it('o sistema matou o escopo por falta de memória (o journal tem o kill): motivo, hora do kill e aviso na página', async () => {
    const c = ctx({ evidence: { at: T('09:25'), by: 'oomd' } });
    const r = await diagnoseExit(marker(), c);
    expect(r).toMatchObject({ cause: 'oom', at: new Date(T('09:25')).toISOString(), banner: true, unit: UNIT });
    expect(r!.message).toContain('encerrado pelo sistema por falta de memória');
    expect(r!.message).toContain('systemd-oomd');
    expect(r!.message).toContain('09:25');
    // Procurou pelo escopo que o vigia anterior registrou, a partir da subida dele.
    expect(c.asked).toEqual([[UNIT, T('08:40')]]);
  });

  it('o kernel matou (OOM killer): diz isso', async () => {
    const r = await diagnoseExit(marker(), ctx({ evidence: { at: T('09:25'), by: 'kernel' } }));
    expect(r!.message).toContain('o kernel');
    expect(r!.cause).toBe('oom');
  });

  it('sem registro do sistema, mas a memória estava curta no último sinal: "provavelmente falta de memória", com os números', async () => {
    const low = await diagnoseExit(marker({ freePct: 3.1, pressure: 12 }), ctx());
    expect(low).toMatchObject({ cause: 'memory-low', banner: true });
    expect(low!.message).toContain('provavelmente falta de memória');
    expect(low!.message).toContain('3.1% da RAM livre');
    expect(low!.message).toContain('09:24');
    const pressed = await diagnoseExit(marker({ freePct: 40, pressure: 72.9 }), ctx());
    expect(pressed!.cause).toBe('memory-low');
    expect(pressed!.message).toContain('pressão de memória 72.9%');
  });

  it('sem nenhum indício: "parou sem aviso", com o último sinal (nunca silêncio)', async () => {
    const r = await diagnoseExit(marker(), ctx());
    expect(r).toMatchObject({ cause: 'unknown', banner: true, at: new Date(T('09:24')).toISOString() });
    expect(r!.message).toContain('a saída anterior não foi limpa');
    expect(r!.message).toContain('motivo não identificado');
  });

  it('o computador reiniciou desde o último sinal: vai para o log, sem aviso na página (todo login depois de desligar a máquina seria aviso)', async () => {
    // Ligou às 09:30; o último sinal é das 09:24.
    const c = ctx({ uptimeSec: 9 * 60, evidence: { at: T('09:25'), by: 'oomd' } });
    const r = await diagnoseExit(marker(), c);
    expect(r).toMatchObject({ cause: 'reboot', banner: false });
    expect(r!.message).toContain('reiniciado ou desligado');
    expect(c.asked).toEqual([]);
  });

  it('journal sem acesso (erro) ou escopo desconhecido: segue pelos outros indícios', async () => {
    expect((await diagnoseExit(marker(), ctx({ evidence: 'throw' })))!.cause).toBe('unknown');
    const c = ctx({ evidence: { at: T('09:25'), by: 'oomd' } });
    expect((await diagnoseExit(marker({ unit: null }), c))!.cause).toBe('unknown');
    expect(c.asked).toEqual([]);
  });
});

describe('journalOomEvidence', () => {
  const line = (id: string, usec: number) => JSON.stringify({ __REALTIME_TIMESTAMP: String(usec), MESSAGE_ID: id, MESSAGE: 'x' }) + '\n';

  it('pergunta ao journal do usuário pelo escopo e pelos dois avisos de OOM, e devolve a hora do registro', async () => {
    let args: string[] = [];
    const run = async (a: string[]) => ((args = a), line('d989611b15e44c9dbf31e3c81256e4ed', 1_795_782_310_028_213));
    const e = await journalOomEvidence(UNIT, T('08:40'), run);
    expect(e).toEqual({ at: 1_795_782_310_028.213, by: 'oomd' });
    expect(args).toContain('--user');
    expect(args).toContain(`USER_UNIT=${UNIT}`);
    expect(args).toContain('MESSAGE_ID=d989611b15e44c9dbf31e3c81256e4ed');
    expect(args).toContain('MESSAGE_ID=fe6faa94e7774663a0da52717891d8ef');
    expect(await journalOomEvidence(UNIT, 0, async () => line('fe6faa94e7774663a0da52717891d8ef', 1_000_000))).toMatchObject({ by: 'kernel' });
  });

  it('vazio, lixo, falha ou nome de unidade estranho: sem evidência (e nome estranho nem chega ao journalctl)', async () => {
    expect(await journalOomEvidence(UNIT, 0, async () => '')).toBeNull();
    expect(await journalOomEvidence(UNIT, 0, async () => 'não é json\n')).toBeNull();
    expect(await journalOomEvidence(UNIT, 0, async () => Promise.reject(new Error('timeout')))).toBeNull();
    let called = false;
    expect(await journalOomEvidence('x; rm -rf /.scope', 0, async () => ((called = true), ''))).toBeNull();
    expect(await journalOomEvidence('naoescopo', 0, async () => ((called = true), ''))).toBeNull();
    expect(called).toBe(false);
  });
});

describe('marcador e relatório em disco', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-exit-'));
  });
  afterEach(() => removeTemp(dir));

  it('grava por arquivo temporário (nunca meio escrito), lê de volta, e marcador estragado ou incompleto é "sem marcador"', async () => {
    const file = path.join(dir, 'daemon.session.json');
    expect(readSession(file)).toBeNull();
    writeSession(file, marker());
    expect(readSession(file)).toEqual(marker());
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await fs.writeFile(file, '{"pid": 12');
    expect(readSession(file)).toBeNull();
    await fs.writeFile(file, JSON.stringify({ pid: 1, startedAt: 'x', lastBeat: 'y', clean: false }));
    expect(readSession(file)).toBeNull();
  });

  it('parada limpa: o marcador diz "limpo" e a subida seguinte não estranha; marcador ausente não dá erro', async () => {
    const file = path.join(dir, 'daemon.session.json');
    markSessionClean(file);
    writeSession(file, marker());
    markSessionClean(file, new Date(T('09:30')));
    expect(readSession(file)).toMatchObject({ clean: true, lastBeat: new Date(T('09:30')).toISOString() });
    expect(await diagnoseExit(readSession(file), ctx())).toBeNull();
  });

  it('da saída não limpa até a página de início: marcador → diagnóstico → relatório → log.js', async () => {
    const sessionFile = path.join(dir, 'daemon.session.json');
    const exitFile = path.join(dir, 'last-exit.json');
    // O vigia anterior morreu (SIGKILL do oomd): o marcador ficou "no ar".
    writeSession(sessionFile, marker());
    const report = await diagnoseExit(readSession(sessionFile), ctx({ evidence: { at: T('09:25'), by: 'oomd' } }));
    saveLastExit(exitFile, report);
    const shown = readLastExit(exitFile, T('09:40'));
    expect(shown?.message).toContain('encerrado pelo sistema por falta de memória');
    // A página lê `exit` dentro do log.js (o service worker já o guarda para o servidor parado).
    const js = logScript([], new Date(T('09:40')), shown);
    const log = JSON.parse(js.replace(/^window\.claudioLog = /, '').replace(/;$/, '')) as { exit: { cause: string; message: string } | null };
    expect(log.exit).toMatchObject({ cause: 'oom', message: expect.stringContaining('09:25') });
    // Subida seguinte limpa: o aviso some.
    saveLastExit(exitFile, null);
    expect(readLastExit(exitFile, T('09:41'))).toBeNull();
    expect(JSON.parse(logScript([]).replace(/^window\.claudioLog = /, '').replace(/;$/, ''))).toMatchObject({ exit: null });
  });

  it('só vai para a página o que pede aviso e é de menos de 24 h; reinício do computador fica só no log', async () => {
    const exitFile = path.join(dir, 'last-exit.json');
    const unknown = await diagnoseExit(marker(), ctx());
    saveLastExit(exitFile, unknown);
    expect(readLastExit(exitFile, T('09:40'))?.cause).toBe('unknown');
    expect(readLastExit(exitFile, T('09:39') + EXIT_REPORT_TTL_MS + 1_000)).toBeNull();
    const reboot = await diagnoseExit(marker(), ctx({ uptimeSec: 60 }));
    saveLastExit(exitFile, reboot);
    expect(readLastExit(exitFile, T('09:40'))).toBeNull();
    await fs.writeFile(exitFile, 'lixo');
    expect(readLastExit(exitFile, T('09:40'))).toBeNull();
  });
});

describe('a fiação do vigia e do daily stop', () => {
  const root = path.join(__dirname, '..');

  it('o vigia lê o marcador anterior ANTES de gravar o seu, renova a cada 30 s e só marca limpo na parada de verdade', async () => {
    const src = await fs.readFile(path.join(root, 'scripts', 'daemon.ts'), 'utf8');
    const iRead = src.indexOf('readSession(SESSION_FILE)');
    const iFirstBeat = src.indexOf('beat();');
    expect(iRead).toBeGreaterThan(0);
    expect(iFirstBeat).toBeGreaterThan(iRead);
    expect(src).toContain('setInterval(beat, 30_000)');
    // O diagnóstico roda em paralelo e a espera por ele tem teto (journalctl pode demorar até 5 s).
    expect(src).toContain('const diagnosis = diagnoseExit(previous');
    // Limpo só depois de o laço terminar por pedido de parada; erro no vigia não passa por aqui.
    expect(src.indexOf('beat(true);')).toBeGreaterThan(src.indexOf('await supervise('));
    expect(src.indexOf('beat(true);')).toBeLessThan(src.indexOf("log('parado');"));
    expect(src.match(/beat\(true\)/g)).toHaveLength(1);
    // O relatório é gravado antes da linha no log (o snapshot da página sai junto com ela).
    expect(src.indexOf('saveLastExit(LAST_EXIT_FILE, report)')).toBeLessThan(src.indexOf('if (report) log(report.message)'));
    // O vigia espera o relatório (até 3 s) ANTES de subir o servidor: a página de início o lê no instante em que o Club passa a responder.
    expect(src.indexOf('await Promise.race([diagnosis, sleep(3_000)])')).toBeGreaterThan(src.indexOf('const diagnosis = diagnoseExit('));
    expect(src.indexOf('await Promise.race([diagnosis, sleep(3_000)])')).toBeLessThan(src.indexOf('await supervise('));
  });

  it('a parada limpa do vigia apaga o aviso ANTES da linha "parado" (é ela que regrava o log.js da página de início)', async () => {
    const src = await fs.readFile(path.join(root, 'scripts', 'daemon.ts'), 'utf8');
    const iClean = src.indexOf('beat(true);');
    const iErase = src.indexOf('saveLastExit(LAST_EXIT_FILE, null);');
    expect(iErase).toBeGreaterThan(iClean);
    expect(iErase).toBeLessThan(src.indexOf("log('parado');"));
    expect(iErase).toBeGreaterThan(src.indexOf('await supervise('));
    // Só nesse ponto (o fim do laço): nenhum outro caminho do vigia apaga o aviso.
    expect(src.match(/saveLastExit\(LAST_EXIT_FILE, null\)/g)).toHaveLength(1);
  });

  it('o vigia se põe no escopo antes de gravar PID e marcador (o processo é trocado por exec e recomeça)', async () => {
    const src = await fs.readFile(path.join(root, 'scripts', 'daemon.ts'), 'utf8');
    expect(src.indexOf('enterOwnScope();')).toBeGreaterThan(src.indexOf('runningDaemon()'));
    expect(src.indexOf('enterOwnScope();')).toBeLessThan(src.indexOf('fs.writeFileSync(PID_FILE'));
    expect(src.indexOf('enterOwnScope();')).toBeLessThan(src.indexOf('readSession(SESSION_FILE)'));
  });

  it('daily stop marca a parada como limpa (no Windows o taskkill /F não deixa o vigia fazê-lo)', async () => {
    const src = await fs.readFile(path.join(root, 'scripts', 'daily.ts'), 'utf8');
    const stop = src.slice(src.indexOf('function stop(): void'), src.indexOf('/** Depois de parar'));
    expect(stop).toContain('markCleanStop(SESSION_FILE, LAST_EXIT_FILE)');
    // Só depois de o vigia ter saído de fato: o caso "não deu para confirmar" retorna antes e não marca nada.
    expect(stop.indexOf('markCleanStop(SESSION_FILE, LAST_EXIT_FILE)')).toBeGreaterThan(stop.indexOf('stopProcess(pid)'));
    // E antes de o log.js ser regravado (o `writeLogSnapshot` do fim do script).
    expect(stop.indexOf('markCleanStop(')).toBeLessThan(stop.indexOf("appendLog('daily'"));
  });
});

describe('parada limpa: o aviso "Por que parou" de uma saída anterior some (quem parou foi o usuário)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-clean-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    return removeTemp(dir);
  });

  /** Um vigia que morreu por baixo, o seguinte que anotou o motivo, e o log.js da página de início com ele. */
  async function withNotice() {
    const files = { session: path.join(dir, 'daemon.session.json'), exit: path.join(dir, 'last-exit.json'), log: path.join(dir, 'server.log'), snapshot: path.join(dir, 'log.js') };
    await fs.writeFile(files.log, '[2026-11-27 09:39:40] [vigia] iniciando em /x (porta 4848)\n');
    writeSession(files.session, marker({ pid: 7, clean: false }));
    const report = await diagnoseExit(readSession(files.session), ctx({ evidence: { at: T('09:25'), by: 'oomd' } }));
    saveLastExit(files.exit, report);
    // O vigia novo grava o seu marcador (no ar) por cima do anterior.
    writeSession(files.session, marker({ pid: 8, clean: false }));
    return files;
  }
  const snapshotExit = async (file: string) => {
    const t = await fs.readFile(file, 'utf8');
    return (JSON.parse(t.replace(/^window\.claudioLog = /, '').replace(/;$/, '')) as { exit: unknown }).exit;
  };

  it('antes de parar o aviso está no log.js; markCleanStop (o `daily stop`) o apaga, marca limpo, e o log.js seguinte vem sem ele', async () => {
    const f = await withNotice();
    await writeLogSnapshot({ log: f.log, snapshot: f.snapshot, lastExit: f.exit });
    expect(await snapshotExit(f.snapshot)).toMatchObject({ cause: 'oom' });

    markCleanStop(f.session, f.exit, new Date(T('09:50')));

    expect(readSession(f.session)).toMatchObject({ clean: true });
    await expect(fs.access(f.exit)).rejects.toThrow();
    expect(readLastExit(f.exit, T('09:50'))).toBeNull();
    // O log.js que o `daily stop` grava logo depois (e o do vigia, depois de "parado").
    await writeLogSnapshot({ log: f.log, snapshot: f.snapshot, lastExit: f.exit });
    expect(await snapshotExit(f.snapshot)).toBeNull();
    expect(logScript([], new Date(), readLastExit(f.exit))).toContain('"exit":null');
  });

  it('o caminho do vigia (beat(true) + apagar o relatório) deixa o mesmo estado; parar de novo, ou sem aviso nenhum, não dá erro', async () => {
    const f = await withNotice();
    // O que scripts/daemon.ts faz no fim do laço: marcador limpo e o relatório apagado, antes da linha "parado".
    writeSession(f.session, { ...marker({ pid: 8 }), clean: true });
    saveLastExit(f.exit, null);
    expect(readLastExit(f.exit, T('09:50'))).toBeNull();
    await writeLogSnapshot({ log: f.log, snapshot: f.snapshot, lastExit: f.exit });
    expect(await snapshotExit(f.snapshot)).toBeNull();
    expect(() => markCleanStop(f.session, f.exit)).not.toThrow();
    expect(() => markCleanStop(path.join(dir, 'nao-existe.json'), path.join(dir, 'tambem-nao.json'))).not.toThrow();
  });

  it('a rota /log.js do servidor também deixa de levar o aviso depois da parada limpa', async () => {
    vi.stubEnv('MYCO_HOME', dir);
    vi.resetModules();
    const { serveStartFiles } = await import('../server/startPage');
    await fs.mkdir(path.join(dir, 'run'), { recursive: true });
    await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
    const exitFile = path.join(dir, 'run', 'last-exit.json');
    saveLastExit(exitFile, { cause: 'unknown', at: new Date().toISOString(), lastBeat: new Date().toISOString(), unit: null, message: 'a saída anterior não foi limpa: x', banner: true, detectedAt: new Date().toISOString() });
    const get = async () => {
      let body = '';
      const res = { writeHead: () => undefined, end: (b: string) => void (body = b) };
      await serveStartFiles('/log.js', res as never);
      return JSON.parse(body.replace(/^window\.claudioLog = /, '').replace(/;$/, '')) as { exit: { message: string } | null };
    };
    expect((await get()).exit?.message).toContain('não foi limpa');
    markCleanStop(path.join(dir, 'run', 'daemon.session.json'), exitFile);
    expect((await get()).exit).toBeNull();
  });
});

