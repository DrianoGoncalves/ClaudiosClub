import type { Session, StaffProfile, UncommittedConversation, UncommittedFile, UncommittedReport } from '../shared/model';
import { touchedFiles } from './chatChanges';
import { changedFiles } from './taskCode';

// Arquivos sem commit do projeto, agrupados pela conversa que os editou. "Quem editou" é o mesmo
// critério do "o que mudou" de uma conversa (chatChanges.ts), no working tree principal. Só as
// conversas com atividade recente são lidas: a lista de sessões já traz `updatedAt`, então as
// antigas nem abrem o transcript. Só leitura (git status/diff), nada de escrita no git.

export const RECENT_DAYS = 14;
const DAY_MS = 86_400_000;
/** Worktrees das fichas (staff/worktree.ts) moram dentro do projeto: o trabalho delas não conta aqui. */
const WORKTREES = '.claude/worktrees/';

export interface UncommittedInput {
  projectPath: string;
  /** Sessões do projeto (getProjectSessions): `updatedAt` decide quais entram. */
  sessions: Session[];
  /** Fichas do projeto: ligam a sessão ao funcionário. */
  staff: StaffProfile[];
  /** Onde está o transcript de uma sessão. */
  transcriptOf: (sessionId: string) => Promise<string>;
  now?: Date;
}

export async function uncommittedByConversation(input: UncommittedInput): Promise<UncommittedReport> {
  const since = (input.now ?? new Date()).getTime() - RECENT_DAYS * DAY_MS;
  const dirty = (await changedFiles(input.projectPath, 'HEAD')).filter((f) => !f.path.startsWith(WORKTREES));
  const status = new Map(dirty.map((f) => [f.path, f.status]));

  const owner = new Map<string, StaffProfile>();
  for (const s of input.staff) for (const x of s.sessions) owner.set(x.id, s);

  // Sem nada sem commit, não há o que cruzar: nenhum transcript é lido.
  // Conversas recentes, exceto as de funcionário com worktree própria (o trabalho dele não está aqui).
  const recent = dirty.length ? input.sessions.filter((s) => Date.parse(s.updatedAt) >= since && !owner.get(s.id)?.worktree) : [];
  const found = await Promise.all(
    recent.map(async (s) => {
      const staff = owner.get(s.id) ?? null;
      const touched = (await touchedFiles(await input.transcriptOf(s.id), input.projectPath)).filter((p) => status.has(p));
      return {
        sessionId: s.id,
        staffId: staff?.id ?? null,
        name: staff?.name ?? s.topic ?? s.title ?? s.id.slice(0, 8),
        topic: s.topic,
        touched,
      };
    }),
  );

  // Arquivo → ids das conversas que o editaram (dentro da janela).
  const editors = new Map<string, string[]>();
  for (const c of found) for (const p of c.touched) editors.set(p, [...(editors.get(p) ?? []), c.sessionId]);
  const nameOf = new Map(found.map((c) => [c.sessionId, c.name]));
  const fileOf = (sessionId: string, path: string): UncommittedFile => ({
    path,
    status: status.get(path) ?? 'M',
    also: (editors.get(path) ?? []).filter((id) => id !== sessionId).map((id) => nameOf.get(id) ?? id),
  });

  const conversations: UncommittedConversation[] = found
    .filter((c) => c.touched.length)
    .map((c) => ({
      sessionId: c.sessionId,
      staffId: c.staffId,
      name: c.name,
      topic: c.topic,
      files: c.touched.map((p) => fileOf(c.sessionId, p)),
    }));
  const unowned: UncommittedFile[] = dirty.filter((f) => !editors.has(f.path)).map((f) => ({ path: f.path, status: f.status, also: [] }));
  return { total: dirty.length, recentDays: RECENT_DAYS, conversations, unowned };
}
