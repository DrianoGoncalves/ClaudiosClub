import fs from 'node:fs';
import path from 'node:path';
import {
  DAILY,
  LINUX_MENU_DESKTOP,
  MENU_SHORTCUT,
  ROOT,
  TSX,
  createWindowsShortcut,
  desktopEntry,
  execArg,
  linuxAppsDir,
  linuxScriptPath,
  registerLink,
  unregisterLink,
  writeLinuxScript,
} from './lib';

// Atalho OPCIONAL do Claudio’s Club no menu de programas. O link myco://, que o botão "Iniciar" da página de início
// (scripts/start.html) usa, não depende disto: ele se registra sozinho no setup e a cada subida (registerLink, em
// scripts/lib.ts). Só no seu usuário, sem administrador.
// O atalho roda `daily.ts open`: sobe se preciso e abre o navegador já pareado (código de uso único, ver
// server/pairing.ts). Atalho antigo (abria scripts/start.html): rode de novo `npm run launcher`.
//   npm run launcher           cria o atalho (e confere o link)
//   npm run launcher:remove    tira o atalho e o link (o botão Iniciar para até a próxima subida)
// Windows: atalho no Menu Iniciar. Linux: .desktop em ~/.local/share/applications.
// macOS: ainda sem atalho (precisaria de um app empacotado); use npm run daily:start.

const NAME = 'Claudio’s Club';
const NODE = process.execPath;
const OPEN_CMD = [NODE, TSX, DAILY, 'open'];

const quote = (s: string) => `"${s}"`;

function installWindows(): void {
  createWindowsShortcut({
    link: MENU_SHORTCUT,
    target: NODE,
    args: OPEN_CMD.slice(1).map(quote).join(' '),
    cwd: ROOT,
    description: `${NAME}: abre o escritório (e o liga, se estiver parado)`,
    // O console do Node só aparece na barra de tarefas, pelo segundo que leva para abrir o navegador.
    minimized: true,
  });
  console.log('Atalho criado no Menu Iniciar.');
}

function installLinux(): void {
  const dir = linuxAppsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, LINUX_MENU_DESKTOP),
    desktopEntry({
      Name: NAME,
      Comment: 'Abre o escritório (e o liga, se estiver parado)',
      Exec: execArg(writeLinuxScript('abrir', OPEN_CMD)),
      Categories: 'Development;',
    }),
  );
  console.log(`Atalho criado em ${dir}.`);
}

function remove(): void {
  unregisterLink();
  if (process.platform === 'win32') fs.rmSync(MENU_SHORTCUT, { force: true });
  else if (process.platform === 'linux') {
    fs.rmSync(path.join(linuxAppsDir(), LINUX_MENU_DESKTOP), { force: true });
    fs.rmSync(linuxScriptPath('abrir'), { force: true });
  }
  console.log('Atalho e link myco:// removidos. O link volta sozinho na próxima subida: o botão Iniciar depende dele.');
}

if (process.argv.includes('--remove')) {
  remove();
} else if (process.platform === 'win32' || process.platform === 'linux') {
  registerLink();
  if (process.platform === 'win32') installWindows();
  else installLinux();
} else {
  console.log('No macOS ainda não há atalho. Use npm run daily:start e abra http://claudio.localhost:4848.');
}
