// O registro das origens locais que servem a tela de um servidor REAL do Claudio’s Club, para o navegador dos funcionários não abri-las
// (o incidente de 21/11: com claudio.localhost barrado, um funcionário abriu http://127.0.0.1:5173, o Vite do `npm run dev` com proxy de
// /api para o servidor, e navegou nas Configurações; o cookie do pareamento vale para o host em qualquer porta).
//
// Quem serve a tela grava a origem que serve ao subir, em `<MYCO_HOME>/run/origins/<tipo>-<porta>.json`:
//   - o servidor do Club (`server`, a porta dele; server/index.ts);
//   - o Vite do `npm run dev` / `npx vite` (`vite`, a porta em que ele abriu e a do servidor para onde o /api vai; vite.config.ts).
// O hook (club-guard.mjs) lê esta pasta a cada chamada de navegador; o lançamento da conversa a lê para o `--blocked-origins` do Playwright
// (Codex e navegador limpo; lista fixa na hora de subir, ver clubBlockedOrigins em server/clubAddress.ts).
//
// Só vale o registro de quem ainda está vivo (o `pid` existe): quem caiu sem limpar não barra a porta para sempre.
// O que NÃO entra: a prévia de interface (vite.preview.config.ts, 127.0.0.1:5199, sem proxy nem servidor), uma instância isolada com
// MYCO_HOME próprio (grava na pasta dela, que este hook não lê) e o servidor/Vite de outro projeto. Só built-ins do node: este arquivo
// vai na cópia dos hooks da conversa (launch.ts) e é importado pelo Vite.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A pasta do registro: `<MYCO_HOME>/run/origins`. O MYCO_HOME de teste ou de uma instância isolada a separa da real (como a fila pesada, heavyQueue.ts). */
export function originsDir(env = process.env) {
  return path.join(env.MYCO_HOME ?? path.join(os.homedir(), '.myco'), 'run', 'origins');
}

/** O processo existe? (`EPERM` = existe, de outro usuário.) */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * @param {{ kind: 'server' | 'vite'; port: number; proxyTo?: number }} origin
 * @param {string} [dir]
 * @returns {(() => void) | null}
 *
 * Grava a origem que este processo serve e devolve quem a apaga (também ao sair). `kind`: `server` ou `vite`; `proxyTo`: a porta do servidor para onde
 * o Vite repassa a API. Nunca lança: o registro é uma camada a mais, e falhar em gravar não pode derrubar o servidor nem o Vite (devolve `null`).
 */
export function registerOrigin({ kind, port, proxyTo }, dir = originsDir()) {
  if ((kind !== 'server' && kind !== 'vite') || !validPort(port)) return null;
  const file = path.join(dir, `${kind}-${port}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ kind, port, ...(validPort(proxyTo) ? { proxyTo } : {}), pid: process.pid, startedAt: new Date().toISOString() }));
    renameSync(tmp, file);
  } catch {
    return null;
  }
  let done = false;
  const unregister = () => {
    if (done) return;
    done = true;
    try {
      // Só o dono apaga: se outro processo tomou a porta depois, o registro dele fica.
      if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) rmSync(file, { force: true });
    } catch {
      // já não existe, ou ilegível: nada a limpar
    }
  };
  process.once('exit', unregister);
  return unregister;
}

/**
 * @param {string} [dir]
 * @param {(pid: number) => boolean} [alive]
 * @returns {Array<{ kind: 'server' | 'vite'; port: number; proxyTo?: number; pid: number }>}
 *
 * As origens registradas e vivas (`{ kind, port, proxyTo?, pid }`). Arquivo ilegível, de formato errado ou de processo morto não conta (o de
 * processo morto é apagado). Sem a pasta: lista vazia. Nunca lança.
 */
export function registeredOrigins(dir = originsDir(), alive = pidAlive) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {Array<{ kind: 'server' | 'vite'; port: number; proxyTo?: number; pid: number }>} */
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8'));
      if ((rec?.kind !== 'server' && rec?.kind !== 'vite') || !validPort(rec.port)) continue;
      if (!alive(rec.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      out.push({ kind: rec.kind, port: rec.port, ...(validPort(rec.proxyTo) ? { proxyTo: rec.proxyTo } : {}), pid: rec.pid });
    } catch {
      // arquivo ilegível: ignora
    }
  }
  return out;
}

/**
 * As portas registradas e vivas, sem repetição.
 * @param {string} [dir]
 * @param {(pid: number) => boolean} [alive]
 * @returns {number[]}
 */
export function registeredPorts(dir = originsDir(), alive = pidAlive) {
  return [...new Set(registeredOrigins(dir, alive).map((o) => o.port))].sort((a, b) => a - b);
}
