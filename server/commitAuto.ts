import type { Task, TaskCommitLeft } from '../shared/model';
import { deriveCommitLeft, keyOfLeft, leftKey } from './commitLeft';

// O commit das sobras refeito SOZINHO quando o card que as travava fecha (TaskService.leftoversSoon chama; o botão é `redoLeftovers`, e os dois dividem `redoDone`). Aqui só o que o quadro diz, sem git:
// quais sobras o automático pode levar. Só o motivo `shared` (outro card as barrava); owner, staged, conflict e blocked ficam para o dono pelo botão. O resto (o git agora, a escrita sua no editor, o
// commit em si) é conferido na vez do projeto, em `redoDone`.

export interface AutoCtx {
  /** O `at` da entrega "pronto" da tarefa (`doneAtOf`). */
  doneAt: (t: Task) => string;
  /** O commit automático desta tarefa está rodando agora (a vaga de escrita ainda é dela). */
  busy: (id: string) => boolean;
}

/** Os cards que barravam o arquivo no commit automático (`TaskCommitLeft.by`, ids separados por vírgula). */
const blockersOf = (l: TaskCommitLeft): string[] => (l.by ?? '').split(', ').filter(Boolean);

/** O aviso de `t` ainda é do automático: entrega atual pronta e com sobras, que o dono não ignorou, e que o automático ainda não tentou para estas sobras (uma tentativa por `leftKey`, sem laço). */
function due(t: Task, ctx: AutoCtx): boolean {
  const c = t.commit;
  return t.status === 'done' && !t.merged && !!c && c.for === ctx.doneAt(t) && c.alert && !c.ack && c.status !== 'failed' && c.left.length > 0 && c.auto?.key !== leftKey(c);
}

/**
 * O card que barrava já terminou e o commit dele saiu do jeito de sempre? Pronto (cancelado ou apagado não conta: pode ter deixado mudança no disco), com o commit da entrega atual já gravado e fora
 * da fila (senão o automático correria à frente do commit dele, que leva o arquivo inteiro), que não falhou e não recusou este arquivo.
 */
function released(b: Task | undefined, key: string, ctx: AutoCtx): boolean {
  const c = b?.commit;
  return !!b && b.status === 'done' && !!c && c.for === ctx.doneAt(b) && c.status !== 'failed' && !ctx.busy(b.id) && !c.left.some((l) => keyOfLeft(l.path) === key);
}

/**
 * Das sobras de `t` (`commit.left`), as que o commit automático pode levar pelo quadro: motivo `shared`, todos os cards que as barravam prontos (`released`), nenhum card aberto tocando o arquivo,
 * nenhum cancelado que o tocou e o arquivo sem outro motivo de agora (segredo). Vazio quando não há o que fazer sozinho (o aviso fica `waiting` ou `ready`, como sempre).
 */
export function autoLeft(t: Task, all: readonly Task[], ctx: AutoCtx): TaskCommitLeft[] {
  if (!due(t, ctx)) return [];
  const view = deriveCommitLeft(t, all, null);
  if (!view) return [];
  const files = new Map(view.files.map((f) => [keyOfLeft(f.path), f]));
  return t.commit!.left.filter((l) => {
    const ids = l.why === 'shared' ? blockersOf(l) : [];
    const key = keyOfLeft(l.path);
    const f = files.get(key);
    return !!ids.length && !!f && f.why === 'shared' && f.redo && !f.by.length && !f.cancelledBy?.length && ids.every((id) => released(all.find((o) => o.id === id), key, ctx));
  });
}
