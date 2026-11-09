import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadedMark, pendingChanges, pendingRestartCheck } from '../server/pendingRestart';

// "Mudanças pendentes" (GET /api/server): o código no disco está à frente do que está no ar?

let root: string;
const f = (rel: string) => path.join(root, rel);
const write = (rel: string, body = '', at = Date.now() - 60_000) => {
  fs.mkdirSync(path.dirname(f(rel)), { recursive: true });
  fs.writeFileSync(f(rel), body);
  fs.utimesSync(f(rel), at / 1000, at / 1000);
};
const touch = (rel: string, at = Date.now()) => fs.utimesSync(f(rel), at / 1000, at / 1000);

/** Uma instalação empacotada e em dia: fontes há 60 s, pacotes e build há 30 s. */
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pending-'));
  const old = Date.now() - 60_000;
  const built = Date.now() - 30_000;
  write('server/index.ts', '', old);
  write('shared/model.ts', '', old);
  write('scripts/lib.ts', '', old);
  write('client/App.tsx', '', old);
  write('server/ftp-mcp.ts', '', old);
  write('server/gpt-mcp.ts', '', old);
  write('package-lock.json', '{}', old);
  write('dist/server.inputs.json', JSON.stringify(['server/index.ts', 'shared/model.ts', 'scripts/lib.ts']), built);
  write('dist/server.mjs', '', built);
  write('dist/ftp-mcp.inputs.json', JSON.stringify(['server/ftp-mcp.ts']), built);
  write('dist/ftp-mcp.mjs', '', built);
  write('dist/gpt-mcp.inputs.json', JSON.stringify(['server/gpt-mcp.ts']), built);
  write('dist/gpt-mcp.mjs', '', built);
  write('dist/client/assets/a.js', '', built);
  write('dist/client/index.html', '<script src="/assets/a.js"></script>', built);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const check = () => pendingChanges({ root, mark: loadedMark(f('dist/server.mjs'), Date.now()) });

describe('pendingRestart', () => {
  it('tudo em dia: false', () => {
    expect(check()).toEqual({ pendingRestart: false, pendingReasons: [] });
  });

  it('servidor: um arquivo do pacote mudou depois do build no ar', () => {
    touch('shared/model.ts');
    // shared/ também é do cliente.
    expect(check()).toEqual({ pendingRestart: true, pendingReasons: ['server', 'client'] });
  });

  it('servidor: o pacote foi refeito (npm run build) depois da subida', () => {
    const mark = loadedMark(f('dist/server.mjs'), Date.now());
    touch('dist/server.mjs');
    expect(pendingChanges({ root, mark }).pendingReasons).toEqual(['server']);
  });

  it('servidor: arquivo do pacote apagado conta como mudança', () => {
    fs.rmSync(f('scripts/lib.ts'));
    expect(check().pendingReasons).toEqual(['server']);
  });

  it('cliente: só a tela mudou', () => {
    touch('client/App.tsx');
    expect(check()).toEqual({ pendingRestart: true, pendingReasons: ['client'] });
  });

  it('MCP de FTP: pacote velho', () => {
    touch('server/ftp-mcp.ts');
    expect(check().pendingReasons).toEqual(['ftpMcp']);
  });

  it('MCP do GPT: pacote velho', () => {
    touch('server/gpt-mcp.ts');
    expect(check().pendingReasons).toEqual(['gptMcp']);
  });

  it('pelo tsx (sem pacote no ar): o marco é a hora da subida', () => {
    const startedAt = Date.now() - 10_000;
    expect(loadedMark(f('server/index.ts'), startedAt)).toBe(startedAt);
    expect(pendingChanges({ root, mark: startedAt }).pendingRestart).toBe(false);
    touch('server/index.ts');
    expect(pendingChanges({ root, mark: startedAt }).pendingReasons).toEqual(['server']);
  });

  it('sem a lista do pacote: confere server/, shared/ e scripts/', () => {
    fs.rmSync(f('dist/server.inputs.json'));
    const mark = loadedMark(f('dist/server.mjs'), Date.now());
    expect(pendingChanges({ root, mark }).pendingRestart).toBe(false);
    touch('scripts/lib.ts');
    expect(pendingChanges({ root, mark }).pendingReasons).toEqual(['server']);
  });

  it('cache: confere de novo só depois do ttl', () => {
    let clock = 0;
    const pending = pendingRestartCheck({ root, entry: f('dist/server.mjs'), startedAt: Date.now() }, 30_000, () => clock);
    expect(pending().pendingRestart).toBe(false);
    touch('server/index.ts');
    clock = 29_999;
    expect(pending().pendingRestart).toBe(false);
    clock = 30_000;
    expect(pending()).toEqual({ pendingRestart: true, pendingReasons: ['server'] });
  });
});
