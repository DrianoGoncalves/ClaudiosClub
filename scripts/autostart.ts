import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAEMON, ROOT, createWindowsShortcut } from './lib';

// Sobe o vigia do Claudio’s Club sozinho a cada login (sem janela, religando se cair). O log fica em
// ~/.myco/logs/server.log. Não precisa de administrador.
//   npm run autostart          cria
//   npm run autostart:remove   remove
// Windows: atalho na pasta Inicializar (fica minimizado). Linux: ~/.config/autostart (XDG). macOS: LaunchAgent.

const NAME = 'Claudio’s Club';
const NODE = process.execPath;
const ARGS = ['--import', 'tsx', DAEMON];
const LABEL = 'com.claudioclub.daemon';
const LINUX_FILE = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'autostart', 'claudios.desktop');
const MAC_FILE = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const quote = (s: string) => `"${s}"`;
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function installWindows(): void {
  createWindowsShortcut({
    link: path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.lnk`),
    target: NODE,
    args: [...ARGS.slice(0, 2), quote(DAEMON)].join(' '),
    cwd: ROOT,
    description: `${NAME} em segundo plano (vigia: religa se cair)`,
    minimized: true,
  });
  console.log('Atalho criado na pasta Inicializar. O Claudio’s Club sobe sozinho no próximo login.');
}

function installLinux(): void {
  fs.mkdirSync(path.dirname(LINUX_FILE), { recursive: true });
  // O login gráfico não herda o PATH do terminal: levamos o atual, para o `claude` continuar sendo achado.
  const exec = ['env', `PATH=${process.env.PATH ?? ''}`, quote(NODE), ...ARGS.map((a) => (a === DAEMON ? quote(a) : a))].join(' ');
  fs.writeFileSync(
    LINUX_FILE,
    ['[Desktop Entry]', 'Type=Application', `Name=${NAME} (vigia)`, `Exec=${exec}`, `Path=${ROOT}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true'].join('\n') + '\n',
  );
  console.log(`Atalho criado em ${LINUX_FILE}. O Claudio’s Club sobe sozinho no próximo login.`);
}

function installMac(): void {
  fs.mkdirSync(path.dirname(MAC_FILE), { recursive: true });
  const args = [NODE, ...ARGS].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  fs.writeFileSync(
    MAC_FILE,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(process.env.PATH ?? '')}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`,
  );
  const uid = process.getuid?.() ?? 0;
  spawnSync('launchctl', ['bootout', `gui/${uid}`, MAC_FILE], { stdio: 'ignore' });
  const load = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, MAC_FILE], { encoding: 'utf8' });
  if (load.status !== 0) console.log(`Plist criado em ${MAC_FILE}, mas o launchctl não carregou: ${load.stderr.trim()}`);
  else console.log('LaunchAgent criado. O Claudio’s Club sobe sozinho no próximo login.');
}

function remove(): void {
  if (process.platform === 'win32') {
    fs.rmSync(path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.lnk`), { force: true });
  } else if (process.platform === 'linux') {
    fs.rmSync(LINUX_FILE, { force: true });
  } else {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}`, MAC_FILE], { stdio: 'ignore' });
    fs.rmSync(MAC_FILE, { force: true });
  }
  console.log('Início automático removido.');
  console.log('Se o Claudio’s Club estiver rodando agora, pare com: npm run daily:stop');
}

if (process.argv.includes('--remove')) {
  remove();
} else if (process.platform === 'win32') {
  installWindows();
} else if (process.platform === 'linux') {
  installLinux();
} else {
  installMac();
}
console.log('Estado e log: npm run daily:status · Parar: npm run daily:stop · Endereço: http://claudio.localhost:4848');
