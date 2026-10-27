import { useEffect, useMemo, useRef, useState } from 'react';
import type { Board, Task } from '../../../shared/model';
import { api } from '../api';

// Ctrl+K: pular para um funcionário, um projeto ou uma tarefa digitando parte do nome. Setas
// escolhem, Enter abre, Esc fecha.

export type JumpTarget =
  | { kind: 'staff'; projectId: string; staffId: string; sessionId?: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string };

interface Item {
  key: string;
  kind: 'funcionário' | 'projeto' | 'tarefa' | 'conversa';
  title: string;
  detail: string;
  target: JumpTarget;
}

const MAX = 12;
/** Sem acento e sem caixa: "joao" acha "João". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function QuickJump({ board, taskProjects, onJump }: { board: Board; taskProjects: string[]; onJump: (t: JumpTarget) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [tasks, setTasks] = useState<Array<Task & { projectId: string }>>([]);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // As tarefas vêm na hora de abrir (só dos projetos que têm alguma).
  const projectsKey = taskProjects.join('\n');
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    let alive = true;
    void Promise.all(taskProjects.map((id) => api.tasks(id).then((t) => (t ?? []).map((x) => ({ ...x, projectId: id })), () => []))).then(
      (all) => alive && setTasks(all.flat()),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectsKey]);

  const projectName = (id: string) => board.projects.find((p) => p.id === id)?.name ?? id;
  const items = useMemo<Item[]>(() => {
    const staff: Item[] = board.staff.map((s) => ({
      key: `s:${s.projectId}:${s.id}`,
      kind: 'funcionário',
      title: s.name,
      detail: `${s.role} · ${projectName(s.projectId)}`,
      target: { kind: 'staff', projectId: s.projectId, staffId: s.id },
    }));
    const projects: Item[] = board.projects
      .filter((p) => p.exists && !p.worktreeOf)
      .map((p) => ({ key: `p:${p.id}`, kind: 'projeto', title: p.name, detail: p.path, target: { kind: 'project', projectId: p.id } }));
    const taskItems: Item[] = tasks.map((t) => ({
      key: `t:${t.projectId}:${t.id}`,
      kind: 'tarefa',
      title: t.title,
      detail: `${projectName(t.projectId)}${t.staffId ? ` · ${board.staff.find((s) => s.id === t.staffId)?.name ?? ''}` : ''}`,
      target: { kind: 'task', projectId: t.projectId, taskId: t.id },
    }));
    return [...staff, ...projects, ...taskItems];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, tasks]);

  // A partir de 3 letras, também o que foi dito nas conversas dos funcionários.
  const [hits, setHits] = useState<Item[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 3) return setHits([]);
    let alive = true;
    const t = setTimeout(
      () =>
        void api.search(q).then(
          (found) =>
            alive &&
            setHits(
              found.map((h) => ({
                key: `c:${h.sessionId}:${h.at}`,
                kind: 'conversa',
                title: `${h.staffName}${h.title ? ` · ${h.title}` : ''}`,
                detail: h.snippet,
                target: { kind: 'staff', projectId: h.projectId, staffId: h.staffId, sessionId: h.sessionId },
              })),
            ),
          () => alive && setHits([]),
        ),
      250,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, query]);

  const words = fold(query).split(/\s+/).filter(Boolean);
  const named = words.length ? items.filter((i) => words.every((w) => fold(`${i.title} ${i.detail} ${i.kind}`).includes(w))) : items;
  const shown = [...named.slice(0, MAX), ...hits].slice(0, MAX + 8);

  useEffect(() => {
    list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const go = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    onJump(item.target);
  };
  return (
    <div className="modal-backdrop quick-jump-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="quick-jump" role="dialog" aria-label="Ir para">
        <input
          autoFocus
          value={query}
          placeholder="Ir para um funcionário, projeto, tarefa ou algo dito numa conversa…"
          aria-label="Ir para"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              go(shown[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
        <ul ref={list} className="quick-jump-list">
          {shown.map((item, i) => (
            <li key={item.key}>
              <button type="button" className={i === active ? 'is-active' : ''} onMouseEnter={() => setActive(i)} onClick={() => go(item)}>
                <span className="quick-jump-kind">{item.kind}</span>
                <span className="quick-jump-title">{item.title}</span>
                <span className="muted small quick-jump-detail">{item.detail}</span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="muted small quick-jump-empty">Nada com “{query.trim()}”.</li>}
        </ul>
      </div>
    </div>
  );
}
