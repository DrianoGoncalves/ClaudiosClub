import { isClosed, type Task } from '../../../shared/model';

// Cancelar ou apagar uma tarefa de que outras dependem: a conta pura por trás do diálogo (árvore de dependentes, o que aparece, o mapa
// `dependents` que vai ao servidor, e quando o apagar pode confirmar). Sem React: o diálogo (TaskCloseDialog) só desenha.

/** O que fazer com uma tarefa que espera por esta (os mesmos valores de `dependents` no servidor). */
export type DepChoice = 'release' | 'cancel' | 'wait';
/** O mapa do corpo do pedido: id da dependente → escolha. */
export type DepMap = Record<string, DepChoice>;
/** O que a pessoa já escolheu na tela, por id; sem entrada = ainda não mexeu. */
export type DepPicks = Record<string, DepChoice>;
/** Cancelar tem padrão (continuar esperando); apagar obriga a escolher nas diretas (a bloqueadora some, não há o que esperar). */
export type DepMode = 'cancel' | 'delete';

export type DepTask = Pick<Task, 'id' | 'title' | 'status' | 'staffId' | 'blockedBy'>;

/**
 * Uma dependente na árvore. `direct`: espera a tarefa direto (sempre à mostra, em `depth` 1). `parents`: as bloqueadoras DELA dentro da
 * árvore (outras dependentes abertas da mesma tarefa; fora a raiz), em ordem de linha. Em `dependentRows` (a conta estática) `parentId` é a
 * primeira delas e `depth`, o nível mais raso; em `visibleRows` são o de onde ela aparece de fato. `children`: quantas dependentes de baixo esperam por ela
 * (em `visibleRows`, só as que ainda estão escondidas).
 */
export interface DepRow {
  task: DepTask;
  direct: boolean;
  depth: number;
  parentId: string | null;
  parents: string[];
  children: number;
}

/**
 * Todas as dependentes abertas de `rootId`, diretas e indiretas (por `blockedBy`), em pré-ordem (cada uma logo antes das que esperam por ela,
 * sob a primeira bloqueadora que a segura no nível mais raso). Tarefa encerrada (pronta ou cancelada) não espera mais ninguém e não entra. Cada tarefa
 * aparece uma vez (quem espera por duas não se repete), mas guarda TODAS as bloqueadoras dela na árvore (`parents`). A árvore não depende do que
 * foi escolhido: o que aparece, e sob quem, é decidido por `visibleRows`.
 */
export function dependentRows(rootId: string, tasks: readonly DepTask[]): DepRow[] {
  const open = tasks.filter((t) => !isClosed(t));
  const kids = new Map<string, DepTask[]>();
  const seen = new Set([rootId]);
  // Largura primeiro: assim a tarefa que espera por duas fica no nível mais raso.
  for (let level = [rootId]; level.length; ) {
    const next: string[] = [];
    for (const id of level) {
      const mine = open.filter((t) => !seen.has(t.id) && t.blockedBy?.includes(id));
      for (const t of mine) seen.add(t.id);
      kids.set(id, mine);
      next.push(...mine.map((t) => t.id));
    }
    level = next;
  }
  const order: DepRow[] = [];
  const walk = (id: string, depth: number) => {
    for (const task of kids.get(id) ?? []) {
      order.push({ task, direct: depth === 1, depth, parentId: depth === 1 ? null : id, parents: [], children: 0 });
      walk(task.id, depth + 1);
    }
  };
  walk(rootId, 1);
  // Todas as bloqueadoras de cada uma dentro da árvore (a raiz não conta), em ordem de linha.
  const at = new Map(order.map((r, i) => [r.task.id, i]));
  for (const row of order) row.parents = (row.task.blockedBy ?? []).filter((id) => id !== row.task.id && at.has(id)).sort((a, b) => at.get(a)! - at.get(b)!);
  for (const row of order) row.children = order.filter((r) => !r.direct && r.parents.includes(row.task.id)).length;
  return order;
}

/** As escolhas que a linha oferece: apagar não deixa "continuar esperando" nas diretas; o resto tem as três. */
export function optionsOf(row: DepRow, mode: DepMode): DepChoice[] {
  return mode === 'delete' && row.direct ? ['release', 'cancel'] : ['wait', 'release', 'cancel'];
}

/** A escolha de uma linha: a da pessoa, ou o padrão ('wait'; no apagar, as diretas não têm padrão: null). */
export function choiceOf(row: DepRow, picks: DepPicks, mode: DepMode): DepChoice | null {
  return picks[row.task.id] ?? (optionsOf(row, mode).includes('wait') ? 'wait' : null);
}

/**
 * As linhas à mostra: as diretas sempre; uma de baixo aparece quando pelo menos uma das bloqueadoras dela (`parents`) está à mostra e em
 * "Cancelar junto" (senão nenhuma muda de estado por causa dela). Cada uma aparece UMA vez, sob a primeira dessas bloqueadoras na ordem da lista
 * (`parentId` e `depth` já são os de lá). Pré-ordem: cada uma logo antes das que ela abriu. Só segue por "Cancelar junto" a partir das diretas,
 * então ciclo nos dados não trava nem cria linha sem origem.
 */
export function visibleRows(rows: readonly DepRow[], picks: DepPicks, mode: DepMode): DepRow[] {
  const below = new Map<string, DepRow[]>();
  for (const r of rows) if (!r.direct) for (const p of r.parents) below.set(p, [...(below.get(p) ?? []), r]);
  const placed = new Map<string, { depth: number; parentId: string | null }>();
  const order: DepRow[] = [];
  const place = (row: DepRow, depth: number, parentId: string | null) => {
    placed.set(row.task.id, { depth, parentId });
    order.push(row);
    if (choiceOf(row, picks, mode) !== 'cancel') return;
    for (const kid of below.get(row.task.id) ?? []) if (!placed.has(kid.task.id)) place(kid, depth + 1, row.task.id);
  };
  for (const row of rows) if (row.direct) place(row, 1, null);
  return order.map((row) => ({
    ...row,
    ...placed.get(row.task.id)!,
    children: (below.get(row.task.id) ?? []).filter((kid) => !placed.has(kid.task.id)).length,
  }));
}

/**
 * O `dependents` do pedido: só as linhas à mostra, e só "liberar" e "cancelar junto". "Continuar esperando" (o padrão) fica de fora de
 * propósito: sem entrada, a tarefa segue esperando e aparece na caixa "precisa de mim" para ser decidida depois; com 'wait' explícito o
 * servidor a marcaria como vista e esconderia o aviso por uns dias. Escolha de linha que sumiu (nenhuma bloqueadora dela está em "Cancelar junto") também não vai.
 */
export function dependentsMap(rows: readonly DepRow[], picks: DepPicks, mode: DepMode): DepMap {
  const out: DepMap = {};
  for (const row of visibleRows(rows, picks, mode)) {
    const c = choiceOf(row, picks, mode);
    if (c && c !== 'wait') out[row.task.id] = c;
  }
  return out;
}

/** Apagar só confirma com TODAS as diretas decididas (liberar ou cancelar junto): é o que o servidor exige para não barrar com 409. */
export function deleteReady(rows: readonly DepRow[], picks: DepPicks): boolean {
  return rows.filter((r) => r.direct).every((r) => picks[r.task.id] === 'release' || picks[r.task.id] === 'cancel');
}

/** "Aplicar a todas": a mesma escolha em todas as linhas à mostra. "Cancelar junto" abre as de baixo, então vale para a árvore inteira; as outras só mexem nas diretas. */
export function applyToAll(rows: readonly DepRow[], choice: DepChoice): DepPicks {
  const out: DepPicks = {};
  for (const r of rows) if (choice === 'cancel' || r.direct) out[r.task.id] = choice;
  return out;
}

/** Cancelar não desfaz o que já foi feito: a tarefa em andamento (arquivos alterados), mesclada ou com deploy pedido deixa isso como está (o diálogo avisa). */
export function leavesWorkBehind(task: Pick<Task, 'status' | 'merged' | 'deploy'>): boolean {
  return task.status === 'doing' || task.status === 'planning' || !!task.merged || !!task.deploy;
}

/** Quem cancelou, para o cartão e o detalhe: 'user' (a tela) é "você"; o resto é o id do funcionário (o nome, se a ficha ainda existe). */
export function cancelledByName(by: string | undefined, nameOf: (id: string) => string | null, you: string): string {
  if (!by || by === 'user') return you;
  return nameOf(by) ?? by;
}
