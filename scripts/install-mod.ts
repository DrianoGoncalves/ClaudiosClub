import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Instala (ou remove, com --uninstall) o mod myco-tap para todas as sessões do Claude Code:
// copia mod/myco-tap para ~/.claude/mods/myco-tap e acrescenta essa pasta ao
// CLAUDE_CODE_PLUGIN_DIRS do ~/.claude/settings.json, depois de um backup do arquivo.
// Idempotente. Vale para sessões iniciadas depois da instalação.

const MOD = 'myco-tap';
const SOURCE = path.resolve(import.meta.dirname, '..', 'mod', MOD);
const CLAUDE_HOME = process.env.MYCO_CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
const TARGET = path.join(CLAUDE_HOME, 'mods', MOD);
const SETTINGS = path.join(CLAUDE_HOME, 'settings.json');
const BACKUPS = path.join(process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco'), 'backups');
const FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts'];

const uninstall = process.argv.includes('--uninstall');

const raw = await fs.readFile(SETTINGS, 'utf8').catch(() => '{}');
const settings = JSON.parse(raw) as { env?: Record<string, string> } & Record<string, unknown>;
const dirs = (settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter).filter(Boolean);
const same = (a: string) => path.resolve(a).toLowerCase() === TARGET.toLowerCase();
const nextDirs = uninstall ? dirs.filter((d) => !same(d)) : dirs.some(same) ? dirs : [...dirs, TARGET];

if (uninstall) {
  await fs.rm(TARGET, { recursive: true, force: true });
} else {
  for (const f of FILES) {
    await fs.mkdir(path.dirname(path.join(TARGET, f)), { recursive: true });
    await fs.copyFile(path.join(SOURCE, f), path.join(TARGET, f));
  }
}

if (nextDirs.join(path.delimiter) !== dirs.join(path.delimiter)) {
  await fs.mkdir(BACKUPS, { recursive: true });
  const backup = path.join(BACKUPS, `settings.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(backup, raw, 'utf8');

  const env = { ...(settings.env ?? {}) };
  if (nextDirs.length) env.CLAUDE_CODE_PLUGIN_DIRS = nextDirs.join(path.delimiter);
  else delete env.CLAUDE_CODE_PLUGIN_DIRS;
  const next = { ...settings, env };
  if (!Object.keys(env).length) delete (next as Record<string, unknown>).env;

  const tmp = `${SETTINGS}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, SETTINGS);
  console.log(`settings.json atualizado (backup em ${backup})`);
} else {
  console.log('settings.json já estava certo; nada alterado');
}

console.log(uninstall ? `${MOD} removido de ${TARGET}` : `${MOD} instalado em ${TARGET}`);
console.log(`CLAUDE_CODE_PLUGIN_DIRS = ${nextDirs.join(path.delimiter) || '(vazio)'}`);
console.log('Vale para as sessões do Claude Code iniciadas a partir de agora.');
