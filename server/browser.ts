import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserStatus } from '../shared/model';

// Pré-requisitos do Claude in Chrome (`--chrome`), conferidos sem abrir o navegador:
//   - a extensão instalada em algum perfil do Chrome (ou Edge/Brave, que usam a mesma loja)
//   - a ponte do CLI (native messaging host), registrada quando o `claude --chrome` roda pela 1ª vez

export const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
export const EXTENSION_URL = `https://chromewebstore.google.com/detail/claude/${EXTENSION_ID}`;
const HOST_NAME = 'com.anthropic.claude_code_browser_extension';

const BROWSERS = [
  ['Google', 'Chrome'],
  ['Microsoft', 'Edge'],
  ['BraveSoftware', 'Brave-Browser'],
] as const;

let cache: { at: number; value: BrowserStatus } | null = null;

export async function browserStatus(fresh = false): Promise<BrowserStatus> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value;
  const [extension, bridge] = await Promise.all([hasExtension(), hasBridge()]);
  const value: BrowserStatus = { extension, bridge, installUrl: EXTENSION_URL };
  cache = { at: Date.now(), value };
  return value;
}

/** Procura a pasta da extensão nos perfis (Default, Profile 1…). null = não dá para saber neste sistema. */
async function hasExtension(): Promise<boolean | null> {
  const roots =
    process.platform === 'win32'
      ? BROWSERS.map(([vendor, name]) => path.join(process.env.LOCALAPPDATA ?? '', vendor, name, 'User Data'))
      : process.platform === 'darwin'
        ? [path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Google', 'Chrome')]
        : [path.join(process.env.HOME ?? '', '.config', 'google-chrome')];
  for (const root of roots) {
    for (const profile of await fs.readdir(root).catch(() => [] as string[])) {
      if (await fs.stat(path.join(root, profile, 'Extensions', EXTENSION_ID)).then((s) => s.isDirectory(), () => false)) return true;
    }
  }
  return false;
}

/** A ponte fica registrada no Windows em HKCU\…\NativeMessagingHosts; nos outros sistemas, não conferimos. */
function hasBridge(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`], { windowsHide: true, timeout: 5000 }, (err) =>
      resolve(!err),
    );
  });
}
