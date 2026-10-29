import { useEffect, useState } from 'react';
import type { Autonomy, ChatAttachment, ChatCommand, ChatItem, ChatState, Effort, UiLevel } from '../../../shared/model';
import { effortLabel } from '../format';
import { t } from '../i18n';

// Pedaços da conversa que vieram do app do Claude: a lista de tarefas do funcionário, os ajustes
// da conversa (modelo, esforço, autonomia), o menu de "/" e "@" e os anexos de arquivo.

// ---- Lista de tarefas (TaskCreate / TaskUpdate do Claude Code) ----

export interface TodoItem {
  id: string;
  subject: string;
  status: string;
}

const parse = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Monta a lista a partir das ferramentas da conversa: a criação traz o id na resposta. */
export function todosFrom(items: ChatItem[]): TodoItem[] {
  const out = new Map<string, TodoItem>();
  for (const it of items) {
    if (it.kind !== 'tool' || it.result === null) continue;
    const input = parse(it.input) ?? {};
    if (it.name === 'TaskCreate') {
      const id = /#(\d+)/.exec(it.result)?.[1];
      if (id && typeof input.subject === 'string') out.set(id, { id, subject: input.subject, status: 'pending' });
    } else if (it.name === 'TaskUpdate') {
      const id = String(input.taskId ?? '');
      const t = out.get(id);
      if (!t) continue;
      if (input.status === 'deleted') out.delete(id);
      else out.set(id, { ...t, ...(typeof input.status === 'string' && { status: input.status }), ...(typeof input.subject === 'string' && { subject: input.subject }) });
    }
  }
  return [...out.values()];
}

/** Fechada por padrão: uma linha com o progresso e a tarefa em andamento; abrir mostra a lista toda. */
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(false);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const doing = todos.find((t) => t.status === 'in_progress');
  return (
    <div className="chat-todos">
      <button type="button" className="chat-todos-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chat-todos-line">
          {t('chat.tasks', { done, total: todos.length })}
          {doing && ` · ${doing.subject}`}
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul>
          {todos.map((t) => (
            <li key={t.id} className={`todo todo-${t.status}`}>
              <span className="todo-mark" aria-hidden="true">
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}
              </span>
              {t.subject}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Ajustes da conversa ----

const MODELS = [
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' },
];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const AUTONOMIES: Array<{ value: Autonomy; label: string }> = [
  { value: 'plan', label: t('chat.autoPlan') },
  { value: 'manual', label: t('chat.autoManual') },
  { value: 'acceptEdits', label: t('chat.autoEdits') },
  { value: 'auto', label: t('chat.autoAuto') },
  { value: 'bypassPermissions', label: t('chat.autoBypass') },
];
/** Modo que o Claude Code reporta → autonomia da ficha. */
const MODE_AUTONOMY: Record<string, Autonomy> = { default: 'manual', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', bypassPermissions: 'bypassPermissions' };

/** No simples: três jeitos de trabalhar, cada um com modelo e esforço. */
const PACES = [
  { id: 'fast', label: t('chat.paceFast'), model: 'haiku', effort: 'low' as Effort, help: t('chat.paceFastHelp') },
  { id: 'balanced', label: t('chat.paceBalanced'), model: 'sonnet', effort: 'medium' as Effort, help: t('chat.paceBalancedHelp') },
  { id: 'careful', label: t('chat.paceCareful'), model: 'opus', effort: 'high' as Effort, help: t('chat.paceCarefulHelp') },
];

/** "claude-sonnet-5-5" → "sonnet". */
const aliasOf = (model: string | null | undefined) => MODELS.find((m) => model?.includes(m.value))?.value ?? '';
/** "claude-sonnet-5-5" → "Sonnet" (vazio se não for um dos quatro). */
export const modelLabel = (model: string | null | undefined) => MODELS.find((m) => model?.includes(m.value))?.label ?? '';

export function ChatSettingsBar({
  level,
  state,
  fichaModel,
  fichaEffort,
  disabled,
  onChange,
}: {
  level: UiLevel;
  state: ChatState | null;
  fichaModel: string | null;
  fichaEffort: Effort | null;
  disabled: boolean;
  onChange: (s: { model?: string; effort?: Effort; autonomy?: Autonomy }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const model = aliasOf(state?.model) || aliasOf(fichaModel);
  const effort = (state?.effort as Effort | null) ?? fichaEffort ?? '';
  const autonomy = state?.permissionMode ? MODE_AUTONOMY[state.permissionMode] : undefined;
  const run = async (s: Parameters<typeof onChange>[0]) => {
    setBusy(true);
    try {
      await onChange(s);
    } finally {
      setBusy(false);
    }
  };
  const off = disabled || busy;
  const hint = t('chat.settingsHint');

  if (level === 'simple') {
    const pace = model === 'haiku' ? 'fast' : model === 'sonnet' ? 'balanced' : model ? 'careful' : '';
    const asks = !autonomy || autonomy === 'manual' || autonomy === 'plan';
    return (
      <span className="chat-settings" title={hint}>
        <span className="segmented">
          {PACES.map((p) => (
            <button key={p.id} type="button" className="btn-toggle" aria-pressed={pace === p.id} disabled={off} title={p.help} onClick={() => void run({ model: p.model, effort: p.effort })}>
              {p.label}
            </button>
          ))}
        </span>
        <span className="segmented">
          <button type="button" className="btn-toggle" aria-pressed={asks} disabled={off} title={t('chat.askBeforeHelp')} onClick={() => void run({ autonomy: 'manual' })}>
            {t('chat.askBefore')}
          </button>
          <button
            type="button"
            className="btn-toggle"
            aria-pressed={!asks}
            disabled={off}
            title={t('chat.autoHelp')}
            onClick={() => void run({ autonomy: 'auto' })}
          >
            {t('chat.autoDo')}
          </button>
        </span>
      </span>
    );
  }
  return (
    <span className="chat-settings" title={hint}>
      <select aria-label={t('chat.modelAria')} value={model} disabled={off} onChange={(e) => void run({ model: e.target.value })}>
        {!model && <option value="">{t('chat.modelPlaceholder')}</option>}
        {MODELS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <select aria-label={t('chat.effortAria')} value={effort} disabled={off} onChange={(e) => void run({ effort: e.target.value as Effort })}>
        {!effort && <option value="">{t('chat.effortPlaceholder')}</option>}
        {EFFORTS.map((e) => (
          <option key={e} value={e}>
            {t('chat.effortOption', { e: effortLabel(e) })}
          </option>
        ))}
      </select>
      <select aria-label={t('chat.autonomyAria')} value={autonomy ?? ''} disabled={off} onChange={(e) => void run({ autonomy: e.target.value as Autonomy })}>
        {!autonomy && <option value="">{t('chat.autonomyPlaceholder')}</option>}
        {AUTONOMIES.map((a) => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>
    </span>
  );
}

// ---- Menu de "/" e "@" ----

export type Trigger = { kind: 'command' | 'file'; query: string } | null;

/** O que está sendo digitado no fim da caixa: "/coman" no começo, ou "@caminho" em qualquer lugar. */
export function triggerOf(draft: string): Trigger {
  const cmd = /^\/(\S*)$/.exec(draft);
  if (cmd) return { kind: 'command', query: cmd[1]! };
  const at = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  return at ? { kind: 'file', query: at[1]! } : null;
}

export interface Suggestion {
  value: string;
  label: string;
  detail?: string;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function commandSuggestions(commands: ChatCommand[], query: string): Suggestion[] {
  const q = fold(query);
  const starts = commands.filter((c) => fold(c.name).startsWith(q));
  const contains = commands.filter((c) => !fold(c.name).startsWith(q) && fold(`${c.name} ${c.description}`).includes(q));
  return [...starts, ...contains].slice(0, 12).map((c) => ({ value: c.name, label: `/${c.name}`, detail: c.description }));
}

/** Arquivos do projeto para o "@", com uma pausa curta enquanto digita. */
export function useFileSuggestions(projectId: string, trigger: Trigger, search: (projectId: string, q: string) => Promise<string[]>): Suggestion[] {
  const [files, setFiles] = useState<string[]>([]);
  const query = trigger?.kind === 'file' ? trigger.query : null;
  useEffect(() => {
    if (query === null) return setFiles([]);
    let alive = true;
    const t = setTimeout(() => void search(projectId, query).then((f) => alive && setFiles(f), () => alive && setFiles([])), 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [projectId, query, search]);
  return files.map((f) => ({ value: f, label: f }));
}

/** Aplica a escolha: "/comando " no lugar do que foi digitado, ou "@caminho " no lugar do "@…". */
export function applySuggestion(draft: string, trigger: NonNullable<Trigger>, value: string): string {
  if (trigger.kind === 'command') return `/${value} `;
  return draft.replace(/@([^\s@]*)$/, `@${value} `);
}

export function SuggestionList({ items, active, onPick }: { items: Suggestion[]; active: number; onPick: (s: Suggestion) => void }) {
  if (!items.length) return null;
  return (
    <ul className="chat-suggest" role="listbox">
      {items.map((s, i) => (
        <li key={s.value}>
          <button
            type="button"
            role="option"
            aria-selected={i === active}
            className={i === active ? 'is-active' : ''}
            // mousedown: escolhe antes de a caixa de texto perder o foco.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(s);
            }}
          >
            <span className="mono">{s.label}</span>
            {s.detail && <span className="muted small"> {s.detail}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---- Anexos de arquivo (além das imagens) ----

/** Texto até 200 KB vai como texto; PDF até 8 MB, em base64 (o servidor recusa acima de ~3 MB por arquivo). */
const MAX_TEXT = 200_000;
const MAX_PDF = 2_900_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|sql|x-sh))/;
const TEXT_EXT = /\.(txt|md|csv|json|ya?ml|xml|html?|css|scss|js|jsx|ts|tsx|php|py|rb|go|rs|java|cs|sql|sh|ps1|ini|toml|env\.example|log)$/i;

export function isAttachable(f: File): boolean {
  return f.type === 'application/pdf' || TEXT_TYPES.test(f.type) || TEXT_EXT.test(f.name);
}

export async function readAttachment(f: File): Promise<ChatAttachment> {
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
    if (f.size > MAX_PDF) throw new Error(t('chat.pdfTooBig', { name: f.name }));
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error(t('chat.readFail', { name: f.name })));
      r.readAsDataURL(f);
    });
    return { name: f.name, mediaType: 'application/pdf', data: url.slice(url.indexOf(',') + 1) };
  }
  if (f.size > MAX_TEXT) throw new Error(t('chat.textTooBig', { name: f.name }));
  return { name: f.name, mediaType: 'text/plain', data: await f.text() };
}
