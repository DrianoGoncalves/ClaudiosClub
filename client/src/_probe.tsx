import { createRoot } from 'react-dom/client';
import '@fontsource/caveat/400.css';
import '@fontsource/caveat/700.css';
import type { StaffProfile, Task } from '../../shared/model';
import { TasksBoard } from './tasks/TasksBoard';
import './styles.css';
import { initTheme, setThemePref } from './theme';

const q = new URLSearchParams(location.search);
initTheme();
setThemePref(q.get('theme') === 'dark' ? 'dark' : 'light');

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const base = { description: '', sessionId: null, plan: null, branch: null, pr: null, history: [], createdAt: ago(300) } as const;
const mk = (over: Partial<Task> & Pick<Task, 'id' | 'title' | 'status'>): Task =>
  ({ ...base, staffId: 's-den', updatedAt: ago(5), ...over }) as unknown as Task;

const kids = [
  { id: 't-aaaaaa', title: 'Tela: selo de peso na ficha', status: 'doing', staffId: 's-bel' },
  { id: 't-bbbbbb', title: 'Servidor: rota de subtarefas', status: 'todo', staffId: 's-bee' },
  { id: 't-cccccc', title: 'Docs do fluxo', status: 'done', staffId: 's-bel' },
] as const;

const tasks: Task[] = [
  mk({
    id: 't-card01',
    title: 'Orquestrar a entrega da v0.7',
    status: 'doing',
    sessionId: 'sess-1',
    awaitingSubtasks: { since: ago(12) },
    subtasks: kids.map(({ id, title, status, staffId }) => ({ id, title, status, staffId })),
  } as Partial<Task> & Pick<Task, 'id' | 'title' | 'status'>),
  ...kids.map((k) => mk({ ...k, parentTaskId: 't-card01', sessionId: k.status === 'doing' ? 'sess-2' : null } as never)),
  mk({ id: 't-plain1', title: 'Corrigir o foco do modal', status: 'review' }),
];

const staff = [
  { id: 's-den', name: 'Denzel', role: 'Orquestrador(a)', reportsTo: [], servers: [] },
  { id: 's-bel', name: 'Belchior', role: 'Design system', reportsTo: ['s-den'], servers: [] },
  { id: 's-bee', name: 'Beakman', role: 'Back-end', reportsTo: ['s-den'], servers: [] },
] as unknown as StaffProfile[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
window.fetch = async (input) => {
  const url = String(input);
  if (/\/api\/projects\/[^/]+\/tasks$/.test(url)) return json(tasks);
  return json({}, 404);
};

createRoot(document.getElementById('root')!).render(
  <TasksBoard
    projectId="p-1"
    projectName="MyCo"
    staff={staff}
    costs={null}
    onClose={() => {}}
    onOpenStaff={() => {}}
    onChanged={() => {}}
    initialTaskId={q.get('open')}
  />,
);
