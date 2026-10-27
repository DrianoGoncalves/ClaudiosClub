import { promises as fs } from 'node:fs';
import path from 'node:path';

// ~/.myco/run/<sessão>/ guarda o que o MyCo gera para abrir uma sessão: a config de MCP da ficha
// (que pode ter tokens nas variáveis de ambiente dos servidores) e o start.cmd do terminal. Depois
// que a sessão abriu, nada disso é relido: pastas paradas há mais de alguns dias são apagadas.
// Só pastas com nome de sessão (UUID); arquivos soltos como chats.json ficam.

const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RUN_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

/** Apaga as pastas de sessão mais velhas que `maxAgeMs`; devolve quantas saíram. */
export async function cleanRunDir(dir: string, maxAgeMs = RUN_MAX_AGE_MS, now = Date.now()): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !SESSION_DIR.test(e.name)) continue;
    const full = path.join(dir, e.name);
    const st = await fs.stat(full).catch(() => null);
    if (!st || now - st.mtimeMs < maxAgeMs) continue;
    await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}
