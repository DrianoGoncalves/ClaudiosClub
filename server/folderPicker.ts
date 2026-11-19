import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// "Novo projeto → pasta que já existe": abre a janela nativa de escolher pasta NA MÁQUINA DO SERVIDOR e devolve o caminho. O navegador não
// entrega o caminho absoluto de uma pasta (showDirectoryPicker devolve só um handle), então quem abre a janela é o servidor local.
//
// Nada que venha do cliente entra no comando: `pickFolder` não recebe corpo, caminho inicial nem texto da tela. O script do Windows, o do
// macOS e os argumentos do Linux são constantes deste arquivo; o que volta é só lido (nunca executado) e conferido como caminho absoluto.
// Um seletor por vez (o segundo pedido com um aberto é recusado) e, passado o prazo, o processo é morto e a resposta é "cancelado".
// Sem a ferramenta do sistema (zenity/kdialog no Linux, sem tela, PowerShell ausente), a resposta é "unsupported" e a tela cai no campo de texto.

/** O que a rota devolve: o caminho escolhido, a janela fechada sem escolher (ou o prazo), ou que este computador não abre a janela. */
export type PickFolderResult = { path: string } | { cancelled: true } | { unsupported: true };

/** Já há um seletor aberto (a rota responde 409). */
export class PickerBusyError extends Error {
  readonly code = 'busy';
  constructor() {
    super('já há uma janela de escolher pasta aberta: escolha nela ou feche-a');
  }
}

/** Prazo da janela aberta: passou, o processo morre e a resposta é "cancelado". */
export const PICK_TIMEOUT_MS = 5 * 60_000;
const TITLE = 'Escolha a pasta do projeto';
/** O que lemos da saída do processo (um caminho tem poucos KB; o resto é descartado). */
const MAX_OUT = 64 * 1024;

export interface RunResult {
  /** Código de saída; `null` quando morreu por sinal (o prazo). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** O prazo estourou e o processo foi morto por nós. */
  timedOut: boolean;
  /** O programa não existe neste computador (ENOENT). */
  missing: boolean;
}
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export interface PickOptions {
  /** Os testes trocam (para cobrir os três sistemas sem abrir janela). */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runner?: Runner;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/** Uma ferramenta candidata: o comando e como ler o que ela devolveu (`null` = falhou, tenta a próxima). */
export interface Tool {
  cmd: string;
  args: string[];
  read: (r: RunResult, platform: NodeJS.Platform) => PickFolderResult | null;
}

// ---- Windows: IFileOpenDialog (a janela do Explorador, com o campo de caminho) por um PowerShell -STA ----
//
// O dono da janela é um formulário TopMost de 1 pixel: sem ele a janela abre atrás do navegador, porque o servidor não é o app em primeiro
// plano. O caminho volta em base64 do UTF-8 (a saída do PowerShell 5.1 usa a página de código do console e estragaria os acentos).

const WINDOWS_CSHARP = `
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class MycoFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialogCoClass { }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr hwndOwner);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, uint fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hAfter, int x, int y, int cx, int cy, uint flags);

    private const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
    private const uint FOS_PICKFOLDERS = 0x20;
    private const uint FOS_FORCEFILESYSTEM = 0x40;
    private const uint FOS_PATHMUSTEXIST = 0x800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    // Este processo não é o app em primeiro plano (o navegador é) e o Windows nega o pedido de foco a quem não é: ligar a entrada ao
    // dono do foco por um instante o libera, sem mandar tecla nenhuma ao navegador.
    private static void Front(IntPtr hWnd)
    {
        uint pid;
        uint owner = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint mine = GetCurrentThreadId();
        bool attached = owner != 0 && owner != mine && AttachThreadInput(mine, owner, true);
        SetForegroundWindow(hWnd);
        if (attached) AttachThreadInput(mine, owner, false);
    }

    // O caminho escolhido, ou null se a janela foi fechada sem escolher.
    public static string Pick(string title)
    {
        // A tela onde está o mouse (a do navegador, em quem usa mais de um monitor).
        Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
        using (Form owner = new Form())
        using (Timer center = new Timer())
        {
            owner.FormBorderStyle = FormBorderStyle.None;
            owner.ShowInTaskbar = false;
            owner.TopMost = true;
            owner.StartPosition = FormStartPosition.Manual;
            owner.Bounds = new Rectangle(area.Left + area.Width / 2, area.Top + area.Height / 2, 1, 1);
            owner.Opacity = 0;
            owner.Show();
            Front(owner.Handle);
            owner.Activate();

            // A janela abre colada no dono (de 1 pixel) e ainda muda de tamanho: vai para o meio da tela a cada tamanho novo, até ele parar
            // (o laço modal dela bombeia este relógio).
            int lastW = -1, lastH = -1, stable = 0;
            center.Interval = 30;
            center.Tick += delegate
            {
                IntPtr found = FindWindow("#32770", title);
                RECT r;
                if (found == IntPtr.Zero || !GetWindowRect(found, out r)) return;
                int w = r.Right - r.Left, h = r.Bottom - r.Top;
                if (w == lastW && h == lastH)
                {
                    if (++stable >= 3) center.Stop();
                    return;
                }
                lastW = w;
                lastH = h;
                stable = 0;
                int x = area.Left + (area.Width - w) / 2;
                int y = area.Top + (area.Height - h) / 2;
                SetWindowPos(found, IntPtr.Zero, Math.Max(area.Left, x), Math.Max(area.Top, y), 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                Front(found);
            };
            center.Start();

            IFileDialog dialog = (IFileDialog)new FileOpenDialogCoClass();
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                dialog.SetTitle(title);
                int hr = dialog.Show(owner.Handle);
                if (hr == ERROR_CANCELLED) return null;
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                IShellItem item;
                dialog.GetResult(out item);
                string chosen;
                item.GetDisplayName(SIGDN_FILESYSPATH, out chosen);
                return chosen;
            }
            finally
            {
                Marshal.ReleaseComObject(dialog);
            }
        }
    }
}
`;

/** O script do PowerShell: constante (nada do cliente). Exportado para os testes conferirem o que roda. */
export function windowsScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @\'',
    WINDOWS_CSHARP.trim(),
    "'@",
    `$p = [MycoFolderPicker]::Pick('${TITLE}')`,
    "if ($null -eq $p) { [Console]::Out.WriteLine('CANCEL') }",
    "else { [Console]::Out.WriteLine('OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p))) }",
    '',
  ].join('\r\n');
}

/** powershell.exe do sistema (não o primeiro do PATH). */
function powershell(env: NodeJS.ProcessEnv): string {
  const sys = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(sys) ? sys : 'powershell.exe';
}

// ---- como ler o que voltou ----

/** Caminho absoluto, de uma linha, sem a barra final (menos na raiz); senão `null`. Nunca vira comando: só é devolvido à tela. */
export function cleanPath(raw: string, platform: NodeJS.Platform): string | null {
  const api = platform === 'win32' ? path.win32 : path.posix;
  let p = raw.replace(/[\r\n]+$/, '');
  if (!p || /[\u0000-\u001f\u007f]/.test(p) || !api.isAbsolute(p)) return null;
  const root = api.parse(p).root;
  while (p.length > root.length && /[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

/** Windows: `OK:<base64 do UTF-8>` (escolheu), `CANCEL` (fechou a janela); qualquer outra coisa é falha. */
export function readWindows(r: RunResult, platform: NodeJS.Platform = 'win32'): PickFolderResult | null {
  if (r.code !== 0) return null;
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes('CANCEL')) return { cancelled: true };
  const ok = lines.find((l) => /^OK:[A-Za-z0-9+/=]+$/.test(l));
  if (!ok) return null;
  const p = cleanPath(Buffer.from(ok.slice(3), 'base64').toString('utf8'), platform);
  return p ? { path: p } : null;
}

/** macOS (osascript): sai 0 com o caminho; cancelar é erro -128 ("User canceled"), com código 1. */
export function readMac(r: RunResult, platform: NodeJS.Platform = 'darwin'): PickFolderResult | null {
  if (r.code === 0) {
    const p = cleanPath(r.stdout, platform);
    return p ? { path: p } : null;
  }
  return /\(-128\)|user canceled/i.test(r.stderr) ? { cancelled: true } : null;
}

/** Sem tela (o zenity/kdialog sai com 1 e reclama no stderr): é falha, não cancelamento. */
const NO_DISPLAY = /cannot open display|no display|unable to init|could not connect|failed to connect|display.*not set/i;

/** zenity e kdialog: sai 0 com o caminho; fechar a janela sai 1 sem nada na saída (avisos do GTK no stderr não contam). */
export function readLinux(r: RunResult, platform: NodeJS.Platform = 'linux'): PickFolderResult | null {
  if (r.code === 0) {
    const p = cleanPath(r.stdout, platform);
    return p ? { path: p } : null;
  }
  return r.code === 1 && !r.stdout.trim() && !NO_DISPLAY.test(r.stderr) ? { cancelled: true } : null;
}

/** As ferramentas deste sistema, na ordem em que tentamos; vazio = não dá para abrir janela (sem tela, sistema desconhecido). */
export function toolsFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): Tool[] {
  if (platform === 'win32') {
    const encoded = Buffer.from(windowsScript(), 'utf16le').toString('base64');
    return [{ cmd: powershell(env), args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], read: readWindows }];
  }
  if (platform === 'darwin') {
    // Dentro do System Events para a janela vir à frente do navegador.
    const script = ['tell application "System Events"', 'activate', `set p to POSIX path of (choose folder with prompt "${TITLE}")`, 'end tell', 'return p'];
    return [{ cmd: 'osascript', args: script.flatMap((line) => ['-e', line]), read: readMac }];
  }
  if (platform === 'linux') {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return [];
    return [
      { cmd: 'zenity', args: ['--file-selection', '--directory', `--title=${TITLE}`], read: readLinux },
      { cmd: 'kdialog', args: ['--getexistingdirectory', '--title', TITLE], read: readLinux },
    ];
  }
  return [];
}

// ---- rodar ----

/** Roda o programa; no prazo, mata o processo (sem shell: os argumentos vão como estão). */
export const runTool: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    const done = (r: Partial<RunResult>) => resolve({ code: null, stdout: '', stderr: '', timedOut: false, missing: false, ...r });
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return done({ missing: (err as NodeJS.ErrnoException).code === 'ENOENT', stderr: String(err) });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = (stdout + d).slice(0, MAX_OUT)));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(0, MAX_OUT)));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ missing: err.code === 'ENOENT', stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
  });

let open = false;

/**
 * Abre a janela de escolher pasta e devolve o que a pessoa fez. `PickerBusyError` se já há uma aberta (checado antes de qualquer espera, então dois
 * pedidos juntos nunca abrem duas). Falha da ferramenta (sem tela, erro do sistema) passa à próxima e, esgotadas, vira `unsupported`; o motivo vai ao log.
 */
export async function pickFolder(o: PickOptions = {}): Promise<PickFolderResult> {
  if (open) throw new PickerBusyError();
  open = true;
  try {
    const platform = o.platform ?? process.platform;
    const run = o.runner ?? runTool;
    const timeoutMs = o.timeoutMs ?? PICK_TIMEOUT_MS;
    for (const tool of toolsFor(platform, o.env ?? process.env)) {
      const r = await run(tool.cmd, tool.args, timeoutMs);
      if (r.missing) continue;
      if (r.timedOut) return { cancelled: true };
      const result = tool.read(r, platform);
      if (result) return result;
      // A mensagem do sistema pode ter o caminho do usuário: só a 1ª linha, e só no log do servidor.
      o.log?.(`${path.basename(tool.cmd)} falhou (código ${r.code}): ${r.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? ''}`);
    }
    return { unsupported: true };
  } finally {
    open = false;
  }
}
