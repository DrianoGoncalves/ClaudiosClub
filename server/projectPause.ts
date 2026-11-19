import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { ProjectPause } from '../shared/model';
import { writeAtomic } from './atomicWrite';

// Projeto pausado: nada começa sozinho nele (a fila, a revisão automática, as rotinas, o despertador, o "continue", a retomada do reinício e a troca de motor);
// o que já roda termina o turno e para ali, e as ações manuais do dono seguem valendo. O estado é por projeto, em `~/.myco/paused-projects.json` (da máquina, não do
// repositório: pausar é decisão de quem paga o consumo aqui), e sobrevive a reinício. Um só lugar responde "este projeto está pausado?": todo ponto de partida
// automática pergunta a este arquivo (`isPaused`), e nenhum guarda cópia.

const Entry = z.object({ at: z.string().datetime() });

export class ProjectPauses {
  private loading: Promise<Map<string, ProjectPause>> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = (line) => console.warn(`[pausa] ${line}`),
  ) {}

  /** Está pausado agora? Lê o arquivo na primeira pergunta e responde da memória depois. */
  async isPaused(projectId: string): Promise<boolean> {
    return (await this.load()).has(projectId);
  }

  /** O estado do projeto: null = rodando. */
  async get(projectId: string): Promise<ProjectPause | null> {
    const found = (await this.load()).get(projectId);
    return found ? { ...found } : null;
  }

  /** Pausa (de novo não muda o horário em que parou). Grava antes de responder: se não gravou, não pausou e o erro sobe. */
  async pause(projectId: string, now = new Date()): Promise<ProjectPause> {
    const map = await this.load();
    const had = map.get(projectId);
    if (had) return { ...had };
    const entry: ProjectPause = { at: now.toISOString() };
    map.set(projectId, entry);
    try {
      await this.save(map);
    } catch (err) {
      map.delete(projectId);
      throw err;
    }
    return { ...entry };
  }

  /** Despausa. Devolve se estava pausado. */
  async resume(projectId: string): Promise<boolean> {
    const map = await this.load();
    const had = map.get(projectId);
    if (!had) return false;
    map.delete(projectId);
    try {
      await this.save(map);
    } catch (err) {
      map.set(projectId, had);
      throw err;
    }
    return true;
  }

  /** Os projetos pausados, para a listagem de resumo. */
  async all(): Promise<Record<string, ProjectPause>> {
    return Object.fromEntries([...(await this.load())].map(([id, p]) => [id, { ...p }]));
  }

  private load(): Promise<Map<string, ProjectPause>> {
    this.loading ??= this.read().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  /**
   * Arquivo ausente = nenhum pausado. Estragado: a cópia fica em `.bad` e o log conta (como o resto do que o Club guarda em disco); entrada por entrada, uma
   * torta não leva as outras. Erro de leitura que não é "ausente" (permissão, disco) sobe: pausa que não dá para ler não vira "tudo rodando" calado, a pergunta
   * falha e quem pergunta (a fila, o tick) tenta de novo na próxima rodada.
   */
  private async read(): Promise<Map<string, ProjectPause>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      // ENOTDIR: um pedaço do caminho é arquivo (Linux); o de pausas também não existe.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return new Map();
      throw err;
    }
    let list: unknown;
    try {
      list = (JSON.parse(raw.replace(/^﻿/, '')) as { projects?: unknown } | null)?.projects;
      if (!list || typeof list !== 'object' || Array.isArray(list)) throw new Error('falta o mapa "projects"');
    } catch (err) {
      const bad = `${this.file}.bad`;
      await fs.rename(this.file, bad).catch(() => {});
      this.log(`${this.file} estragado (${err instanceof Error ? err.message : String(err)}); guardado em ${bad}: nenhum projeto aparece pausado, pause de novo`);
      return new Map();
    }
    const map = new Map<string, ProjectPause>();
    for (const [id, value] of Object.entries(list as Record<string, unknown>)) {
      const e = Entry.safeParse(value);
      if (e.success) map.set(id, { at: e.data.at });
      else this.log(`entrada de ${id} em ${this.file} inválida, ignorada`);
    }
    return map;
  }

  /** Gravações em fila: duas seguidas não se atropelam. Falha sobe para quem pediu (a pausa que não gravou não vale). */
  private save(map: Map<string, ProjectPause>): Promise<void> {
    const body = { version: 1, projects: Object.fromEntries(map) };
    const run = this.saving.then(() => writeAtomic(this.file, JSON.stringify(body, null, 2) + '\n'));
    this.saving = run.catch(() => {});
    return run;
  }
}
