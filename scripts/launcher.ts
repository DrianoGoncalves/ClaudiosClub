import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DAILY, START_PAGE, TSX, createWindowsShortcut, execArg, linuxAppsDir, linuxScriptPath, writeLinuxScript } from './lib';

// Atalho do Claudio’s Club no menu de programas e o link myco:// que o botão "Iniciar" da página de início
// (scripts/start.html) usa para subir o Claudio’s Club em segundo plano. Só no seu usuário, sem administrador.
// O link não recebe nada de fora: quem o chama só consegue ligar o Claudio’s Club, e o navegador pergunta antes.
//   npm run launcher           instala
//   npm run launcher:remove    remove
// Windows: atalho no Menu Iniciar e registro myco:// em HKCU. Linux: .desktop em ~/.local/share/applications.
// macOS: ainda sem atalho (precisaria de um app empacotado); use npm run daily:start.

const NAME = 'Claudio’s Club';
const NODE = process.execPath;
// O link vai para `daily.ts link <url>`, que só aceita ações de uma lista fixa (start, setup).
const LINK_CMD = [NODE, TSX, DAILY, 'link'];
const DESKTOP_MENU = 'claudios.desktop';
const DESKTOP_URL = 'claudios-url.desktop';
const URL_KEY = 'HKCU\\Software\\Classes\\myco';

const quote = (s: string) => `"${s}"`;

function desktopEntry(fields: Record<string, string>): string {
  return ['[Desktop Entry]', 'Type=Application', 'Terminal=false', ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n';
}

function installWindows(): void {
  const reg = (args: string[]) => spawnSync('reg', args, { windowsHide: true, stdio: 'ignore' });
  reg(['add', URL_KEY, '/ve', '/d', `URL:${NAME}`, '/f']);
  reg(['add', URL_KEY, '/v', 'URL Protocol', '/d', '', '/f']);
  reg(['add', `${URL_KEY}\\shell\\open\\command`, '/ve', '/d', [...LINK_CMD, '%1'].map(quote).join(' '), '/f']);
  createWindowsShortcut({
    link: path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`),
    target: START_PAGE,
    description: `${NAME}: abre o escritório (ou o botão para iniciar, se estiver parado)`,
  });
  console.log('Link myco:// registrado e atalho criado no Menu Iniciar.');
}

function installLinux(): void {
  const dir = linuxAppsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, DESKTOP_MENU),
    desktopEntry({
      Name: NAME,
      Comment: 'Abre o escritório (ou o botão para iniciar, se estiver parado)',
      Exec: `xdg-open ${execArg(START_PAGE)}`,
      Categories: 'Development;',
    }),
  );
  fs.writeFileSync(
    path.join(dir, DESKTOP_URL),
    desktopEntry({
      Name: `${NAME} (iniciar)`,
      // Chamado pelo navegador (xdg-open): o comando, o PATH do terminal e a pasta ficam no script.
      Exec: `${execArg(writeLinuxScript('iniciar', LINK_CMD, true))} %u`,
      NoDisplay: 'true',
      MimeType: 'x-scheme-handler/myco;',
    }),
  );
  // Sem xdg-mime ou update-desktop-database o atalho continua valendo; só o link myco:// pode precisar de um relogin.
  spawnSync('xdg-mime', ['default', DESKTOP_URL, 'x-scheme-handler/myco'], { stdio: 'ignore' });
  spawnSync('update-desktop-database', [dir], { stdio: 'ignore' });
  console.log(`Atalho e link myco:// criados em ${dir}.`);
}

function remove(): void {
  if (process.platform === 'win32') {
    spawnSync('reg', ['delete', URL_KEY, '/f'], { windowsHide: true, stdio: 'ignore' });
    fs.rmSync(path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`), { force: true });
  } else if (process.platform === 'linux') {
    fs.rmSync(path.join(linuxAppsDir(), DESKTOP_MENU), { force: true });
    fs.rmSync(path.join(linuxAppsDir(), DESKTOP_URL), { force: true });
    fs.rmSync(linuxScriptPath('iniciar'), { force: true });
  }
  console.log('Atalho e link myco:// removidos.');
}

if (process.argv.includes('--remove')) {
  remove();
} else if (process.platform === 'win32') {
  installWindows();
} else if (process.platform === 'linux') {
  installLinux();
} else {
  console.log('No macOS ainda não há atalho. Use npm run daily:start e abra http://claudio.localhost:4848.');
}
