import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Dica opcional da página de início (scripts/start.html), só no Windows: tirar da verificação em tempo real do Windows Defender as pastas que o Club, o git e os
// testes abrem o tempo todo. No HDD, o antivírus abrindo cada arquivo pesa no disco. O Club só mostra o comando (com Copiar): quem roda é o dono, no PowerShell
// como administrador. Nunca roda nada sozinho, e a leitura do estado atual (`Get-MpPreference`) é só leitura.

export interface DefenderPath {
  path: string;
  /** Já está fora da verificação (ela mesma ou uma pasta acima). null: não deu para ler as exclusões atuais. */
  excluded: boolean | null;
}

export interface DefenderGroup {
  paths: DefenderPath[];
  /** O comando que o dono copia e roda como administrador. */
  cmd: string;
  /** O comando que desfaz. */
  undo: string;
}

export interface DefenderTip {
  /** Risco baixo: os transcripts das conversas (só texto) e o histórico do git do Club. */
  recommended: DefenderGroup;
  /** Mais ganho, mais risco: o node_modules é código de terceiros baixado do npm. */
  optional: DefenderGroup;
  /** false: não deu para ler as exclusões atuais (sem permissão ou sem Defender); a página avisa para conferir antes. */
  excludedKnown: boolean;
}

/** Aspas simples do PowerShell: nada dentro é interpretado (`$`, crase); a aspa simples se escreve dobrada. */
export const psQuote = (p: string): string => `'${p.replaceAll("'", "''")}'`;

export function exclusionCommand(paths: readonly string[], verb: 'Add' | 'Remove' = 'Add'): string {
  return `${verb}-MpPreference -ExclusionPath ${paths.map(psQuote).join(', ')}`;
}

const norm = (p: string) => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** `p` está fora da verificação: a própria pasta ou uma acima dela está nas exclusões. */
export function isExcluded(p: string, excluded: readonly string[]): boolean {
  const target = norm(p);
  return excluded.some((e) => {
    const ex = norm(e);
    return target === ex || target.startsWith(`${ex}\\`);
  });
}

/** As pastas sugeridas para esta instalação: `home` é a pasta do usuário, `root` a do Claudio’s Club. */
export function defenderTip(home: string, root: string, excluded: readonly string[] | null): DefenderTip {
  const group = (paths: string[]): DefenderGroup => ({
    paths: paths.map((p) => ({ path: p, excluded: excluded ? isExcluded(p, excluded) : null })),
    cmd: exclusionCommand(paths),
    undo: exclusionCommand(paths, 'Remove'),
  });
  return {
    recommended: group([path.win32.join(home, '.claude', 'projects'), path.win32.join(root, '.git')]),
    optional: group([path.win32.join(root, 'node_modules')]),
    excludedKnown: excluded !== null,
  };
}

/**
 * As exclusões de pasta do Defender hoje, só lendo. Sem permissão o Windows responde "N/A: Must be an administrator…" (ou nada, sem Defender): null, e a página
 * avisa para conferir antes de rodar.
 */
export function readDefenderExclusions(): string[] | null {
  // Pelo caminho completo: nem todo processo tem o WindowsPowerShell no PATH (o de um app ou de um atalho, por exemplo).
  const ps = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', '(Get-MpPreference).ExclusionPath -join "`n"'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (r.error || r.status !== 0) return null;
  const lines = (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => /^N\/A\b|administrator/i.test(l))) return null;
  return lines.filter((l) => /^[a-z]:\\/i.test(l) || l.startsWith('\\\\'));
}
