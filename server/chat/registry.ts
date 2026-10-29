import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { writeAtomic } from '../staff/store';

// Processos de conversa que o Claudio’s Club abriu: ~/.myco/run/chats.json. O arquivo sobrevive ao reinício
// do servidor (o `tsx watch` reinicia a cada arquivo salvo, e no Windows o `claude` filho não morre
// junto), para o Claudio’s Club reconhecer os que ficaram órfãos: vivos, mas sem ninguém do outro lado.

export interface ChatRecord {
  sessionId: string;
  pid: number;
  /** Pid do servidor do Claudio’s Club que abriu o processo. */
  server: number;
  startedAt: string;
}

export class ChatRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<Record<string, ChatRecord>> {
    const raw = await fs.readFile(this.file, 'utf8').catch(() => null);
    try {
      const data = raw ? (JSON.parse(raw) as unknown) : {};
      return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, ChatRecord>) : {};
    } catch {
      return {};
    }
  }

  add(rec: ChatRecord) {
    return this.mutate((all) => ({ ...all, [rec.sessionId]: rec }));
  }

  /** Só tira se ainda for o mesmo processo (a conversa pode ter reaberto com outro pid). */
  remove(sessionId: string, pid: number) {
    return this.mutate((all) => {
      if (all[sessionId]?.pid !== pid) return all;
      const { [sessionId]: _gone, ...rest } = all;
      return rest;
    });
  }

  /** Uma escrita por vez: dois processos saindo juntos não se atropelam. */
  private mutate(fn: (all: Record<string, ChatRecord>) => Record<string, ChatRecord>): Promise<void> {
    const next = this.queue.then(async () => writeAtomic(this.file, JSON.stringify(fn(await this.read()), null, 2) + '\n'));
    this.queue = next.catch(() => {});
    return next;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Encerra o processo e os filhos dele (servidores MCP, comandos em andamento). */
export function killTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // já saiu
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}
