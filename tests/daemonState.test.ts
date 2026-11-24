import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { daemonState, runningDaemon, type DaemonProbe } from '../scripts/lib';

// O vigia registrado no arquivo de PID. Em 24/11/2026, com o HDD saturado, a leitura da linha de comando passou do prazo: o vigia vivo pareceu parado, o
// daily:stop apagou o arquivo e o daily:start subiu um segundo vigia, com o primeiro segurando a porta.

const probe = (o: { pid?: unknown; alive?: boolean; cmd?: string; noFile?: boolean }): DaemonProbe => ({
  readPid: () => {
    if (o.noFile) throw new Error('ENOENT');
    return o.pid;
  },
  alive: () => o.alive ?? true,
  cmdline: () => o.cmd ?? '',
});
const DAEMON_CMD = '"C:\\Program Files\\nodejs\\node.exe" C:\\www\\MyCo\\dist\\daemon.mjs --port 4848';

describe('daemonState', () => {
  it('vivo e com a linha de comando do daemon: rodando', () => {
    expect(daemonState(10_000, probe({ pid: 1344, cmd: DAEMON_CMD }))).toEqual({ state: 'running', pid: 1344 });
  });

  it('sem arquivo, PID morto ou PID reaproveitado por outro programa: parado', () => {
    expect(daemonState(10_000, probe({ noFile: true }))).toEqual({ state: 'stopped', pid: null });
    expect(daemonState(10_000, probe({ pid: 1344, alive: false, cmd: DAEMON_CMD }))).toEqual({ state: 'stopped', pid: null });
    expect(daemonState(10_000, probe({ pid: 1344, cmd: 'C:\\Windows\\notepad.exe' }))).toEqual({ state: 'stopped', pid: null });
    expect(daemonState(10_000, probe({ pid: 'x' }))).toEqual({ state: 'stopped', pid: null });
  });

  it('vivo, mas a linha de comando não pôde ser lida (PowerShell passou do prazo): desconhecido, não parado', () => {
    expect(daemonState(10_000, probe({ pid: 1344, cmd: '' }))).toEqual({ state: 'unknown', pid: 1344 });
    expect(daemonState(10_000, probe({ pid: 1344, cmd: '  \r\n' }))).toEqual({ state: 'unknown', pid: 1344 });
  });

  it('o prazo pedido chega à leitura da linha de comando (o stop tenta de novo com mais folga)', () => {
    const seen: number[] = [];
    daemonState(30_000, { readPid: () => 7, alive: () => true, cmdline: (_p, ms) => (seen.push(ms), DAEMON_CMD) });
    expect(seen).toEqual([30_000]);
  });
});

describe('runningDaemon: quem decide se sobe outro vigia', () => {
  it('desconhecido conta como rodando: na dúvida, não sobe um segundo vigia por cima', () => {
    expect(runningDaemon(probe({ pid: 1344, cmd: '' }))).toBe(1344);
    expect(runningDaemon(probe({ pid: 1344, cmd: DAEMON_CMD }))).toBe(1344);
    expect(runningDaemon(probe({ noFile: true }))).toBeNull();
  });
});

describe('daily.ts', () => {
  it('o stop só encerra o que confirmou ser o vigia e não apaga o registro na dúvida; o start não sobe outro com a porta respondendo', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'scripts', 'daily.ts'), 'utf8');
    const stop = src.slice(src.indexOf('function stop(): void'), src.indexOf('async function status()'));
    expect(stop).toContain("if (d.state === 'unknown') d = daemonState(30_000);");
    const unknownBranch = stop.slice(stop.indexOf("if (d.state === 'unknown') {"), stop.indexOf('const pid = d.pid;'));
    expect(unknownBranch).not.toMatch(/rmSync|stopProcess/);
    const start = src.slice(src.indexOf('async function start('), src.indexOf('function stop(): void'));
    expect(start.indexOf('if (await isUp())')).toBeGreaterThan(0);
    expect(start.indexOf('if (await isUp())')).toBeLessThan(start.indexOf('spawn('));
  });
});
