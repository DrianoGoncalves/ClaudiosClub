// Tipos de heavy-lock.mjs (o servidor importa o .mjs; o hook roda ele direto, sem build).

export const LOCK_FILE: string;

/** O que fica no arquivo da trava. */
export interface HeavyHolder {
  /** A chamada que a pegou (quem pega solta com a mesma). */
  key: string;
  /** Quem pediu: a conversa (`<id>` ou `<id>:<agent>`), ou null (o servidor). */
  owner: string | null;
  /** O processo que a segura enquanto vale; morto = órfã. */
  pid: number;
  label: string;
  since: number;
  /** Depois disto a trava é órfã, mesmo com o processo vivo. */
  expiresAt: number;
}

export interface AcquireOptions {
  dir: string;
  key: string;
  owner?: string | null;
  pid: number;
  label?: string;
  leaseMs: number;
  maxWaitMs: number;
  pollMs?: number;
  /** Chamada uma vez, quando a trava está com outro e vai esperar. */
  onWait?: (holder: HeavyHolder) => void;
  now?: () => number;
  alive?: (pid: number) => boolean;
}

export interface AcquireResult {
  acquired: boolean;
  waitedMs: number;
  /** Com `acquired: false`, quem segurava ao fim da espera. */
  holder: HeavyHolder | null;
}

export function pidAlive(pid: number): boolean;
export function currentHolder(dir: string, o?: { now?: number; alive?: (pid: number) => boolean }): Promise<HeavyHolder | null>;
export function acquire(o: AcquireOptions): Promise<AcquireResult>;
export function release(dir: string, key: string): Promise<void>;
/** O comando (texto de uma chamada de terminal) espera a vez na fila de validação pesada? Qualquer rodada de testes, ou o tsc do projeto. */
export function isHeavyCommand(command: unknown, depth?: number): boolean;
/** O comando roda a suíte inteira de testes (sem arquivo nem filtro) ou o tsc do projeto? */
export function isFullSuiteCommand(command: unknown, depth?: number): boolean;
