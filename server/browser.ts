import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CHROME_EXTENSION_URL, type BrowserStatus } from '../shared/model';

// Pré-requisitos do Claude in Chrome (`--chrome`), conferidos sem abrir o navegador:
//   - a extensão instalada em algum perfil do Chrome (ou Edge/Brave, que usam a mesma loja)
//   - a ponte do CLI (native messaging host), registrada quando o `claude --chrome` roda pela 1ª vez

export const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
export const EXTENSION_URL = CHROME_EXTENSION_URL;
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

/**
 * Chrome de uma conversa: o da ficha, mas só com a extensão instalada (a ponte não conta: o próprio `claude --chrome`
 * registra na 1ª vez). Sem como saber (null ou erro na checagem), vale a ficha. A ficha salva não muda.
 */
export async function effectiveBrowser(wanted: boolean, status: () => Promise<BrowserStatus | null> = browserStatus): Promise<boolean> {
  if (!wanted) return false;
  const extension = await Promise.resolve()
    .then(status)
    .then((s) => s?.extension ?? null, () => null);
  return extension !== false;
}

/** Procura a pasta da extensão nos perfis (Default, Profile 1…). null = não dá para saber neste sistema. */
async function hasExtension(): Promise<boolean | null> {
  const roots =
    process.platform === 'win32'
      ? BROWSERS.map(([vendor, name]) => path.join(process.env.LOCALAPPDATA ?? '', vendor, name, 'User Data'))
      : process.platform === 'darwin'
        ? [path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'Google', 'Chrome')]
        : LINUX_CONFIG_DIRS.map((dir) => path.join(process.env.HOME ?? '', '.config', dir));
  for (const root of roots) {
    for (const profile of await fs.readdir(root).catch(() => [] as string[])) {
      if (await fs.stat(path.join(root, profile, 'Extensions', EXTENSION_ID)).then((s) => s.isDirectory(), () => false)) return true;
    }
  }
  return false;
}

/** Pastas de configuração dos navegadores baseados no Chromium no Linux (cada uma tem seus perfis). */
const LINUX_CONFIG_DIRS = ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'];

/**
 * A ponte fica registrada como manifesto em NativeMessagingHosts: no Windows é uma chave do registro (HKCU); no Linux,
 * um arquivo em ~/.config/<navegador>/NativeMessagingHosts. No macOS não conferimos.
 */
async function hasBridge(): Promise<boolean | null> {
  if (process.platform === 'linux') {
    for (const dir of LINUX_CONFIG_DIRS) {
      const manifest = path.join(process.env.HOME ?? '', '.config', dir, 'NativeMessagingHosts', `${HOST_NAME}.json`);
      if (await fs.stat(manifest).then((s) => s.isFile(), () => false)) return true;
    }
    return false;
  }
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    execFile('reg', ['query', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`], { windowsHide: true, timeout: 5000 }, (err) =>
      resolve(!err),
    );
  });
}
