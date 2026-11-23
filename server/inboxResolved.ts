import { promises as fs } from 'node:fs';
import { isClosed, type InboxItem, type Task } from '../shared/model';
import { pendingChangesForView } from './autoCommit';

// Aviso de erro da caixa "precisa de mim" que o dono nem sabia que podia ignorar porque o problema já passou (`InboxItem.resolvedAt`). Só os tipos com sinal confiável ganham a marca:
//   - commit automático (`commit:`): nenhum arquivo da tarefa tem mudança pendente no git (já commitado, ou desfeito); depois de visto, fica resolvido (outra tarefa mexer nos mesmos arquivos não o reabre);
//   - fila desligada (`guardoff:`): o `hooks.json` da conta sumiu; se o arquivo voltar, volta a pendente (é problema de novo);
//   - teto do turno (`cap:`): a tarefa da conversa foi encerrada (pronta ou cancelada);
//   - sandbox do Codex (`codexsandbox:`): a marca vem da própria política (ver `CodexPasswordPolicy`); aqui só vale o prazo.
// `error:<sessão>` fica sem marca: o item some sozinho (a conversa volta, ou o ChatManager a larga). O resto (leitura 0 na origem do sandbox, commit sem lista confiável, teto sem tarefa ligada) fica como estava.
// Nada é gravado: a marca é calculada na leitura da caixa, e o relógio do prazo fica na memória (um reinício o reinicia).

/** Quanto o item resolvido fica na caixa, depois da primeira vez que o servidor o viu assim. */
export const RESOLVED_KEEP_MS = 24 * 60 * 60_000;
/** O git é consultado de novo (item de commit ainda pendente) só depois deste tempo: a caixa é lida a cada poucos segundos. */
export const COMMIT_CHECK_TTL_MS = 30_000;
/** Git lento não segura a caixa: passou deste prazo, o item segue pendente e a próxima consulta tenta de novo. */
export const CHECK_DEADLINE_MS = 5_000;

export interface ResolverDeps {
  now?: () => number;
  /** Quantos arquivos da tarefa seguem com mudança no git (null = não dá para dizer); os testes trocam. */
  pending?: (dir: string, files: string[] | undefined) => Promise<number | null>;
  /** O arquivo existe? (os testes trocam) */
  exists?: (file: string) => Promise<boolean>;
}

interface Entry {
  /** Quando foi visto resolvido (ms); null = pendente. */
  since: number | null;
  /** A última consulta cara (git), para o cache. */
  checkedAt: number;
  /** A última leitura da caixa que passou por aqui (ver `sweep`). */
  last: number;
}

/** Espera `work` até `ms`; passou do prazo, devolve `fallback` e deixa `work` terminar sozinho (nunca lança). */
export async function settleWithin<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolvidos depois dos pendentes (use como primeiro critério da ordem da caixa). */
export const resolvedLast = (a: InboxItem, b: InboxItem): number => Number(!!a.resolvedAt) - Number(!!b.resolvedAt);

export class InboxResolver {
  /** A ocorrência do aviso (`id` + `at`: outra ocorrência é outro aviso) → o que se sabe dela. */
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: ResolverDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Começa uma leitura da caixa: devolve o marco para o `sweep` do fim dela. */
  begin(): number {
    return this.now();
  }

  /** Fim da leitura que começou em `startedAt`: esquece o que ela não viu (o aviso saiu da caixa, foi ignorado ou virou outra ocorrência). Leituras que se cruzam não se atrapalham. */
  sweep(startedAt: number): void {
    for (const [key, e] of this.entries) if (e.last < startedAt) this.entries.delete(key);
  }

  private entry(item: InboxItem): Entry {
    const key = `${item.id}@${item.at ?? ''}`;
    let e = this.entries.get(key);
    if (!e) {
      e = { since: null, checkedAt: 0, last: 0 };
      this.entries.set(key, e);
    }
    e.last = this.now();
    return e;
  }

  /** O item com a marca (`resolvedAt` = a primeira vez visto resolvido), sem ela se `since` é null, ou null quando passou do prazo (sai da caixa). */
  private apply(item: InboxItem, since: number | null): InboxItem | null {
    if (since === null) return item;
    if (this.now() - since > RESOLVED_KEEP_MS) return null;
    return { ...item, resolvedAt: new Date(since).toISOString() };
  }

  /** Commit automático (`commitInboxItem`): resolvido quando os arquivos da tarefa já não têm mudança no git; depois de visto, fica. `dir` é a raiz do projeto. */
  async commit(item: InboxItem, dir: string, task: Pick<Task, 'changedFiles'>): Promise<InboxItem | null> {
    const e = this.entry(item);
    if (e.since === null && this.now() - e.checkedAt >= COMMIT_CHECK_TTL_MS) {
      e.checkedAt = this.now();
      const pending = this.deps.pending ?? pendingChangesForView;
      if ((await settleWithin(pending(dir, task.changedFiles), CHECK_DEADLINE_MS, null)) === 0) e.since = this.now();
    }
    return this.apply(item, e.since);
  }

  /** Fila de validação desligada (`heavyGuardOffInboxItem`): resolvido quando o `hooks.json` sumiu; se voltar, volta a pendente. */
  async guardOff(item: InboxItem): Promise<InboxItem | null> {
    const e = this.entry(item);
    const file = item.heavyGuardOff?.file;
    const exists = this.deps.exists ?? ((f: string) => fs.access(f).then(() => true, () => false));
    const gone = !!file && !(await exists(file));
    e.since = gone ? (e.since ?? this.now()) : null;
    return this.apply(item, e.since);
  }

  /** Teto do turno (`cap:`): resolvido quando a tarefa da conversa foi encerrada (`task`: a tarefa que tem esta conversa, ou undefined se nenhuma tem: sem sinal). */
  cap(item: InboxItem, task: Pick<Task, 'status'> | undefined): InboxItem | null {
    const e = this.entry(item);
    e.since = task && isClosed(task) ? (e.since ?? this.now()) : null;
    return this.apply(item, e.since);
  }

  /** Sandbox do Codex: o item já vem com `resolvedAt` da política (quando passou); aqui só o prazo. */
  codexSandbox(item: InboxItem): InboxItem | null {
    const at = item.resolvedAt ? Date.parse(item.resolvedAt) : NaN;
    return Number.isFinite(at) && this.now() - at > RESOLVED_KEEP_MS ? null : item;
  }
}
