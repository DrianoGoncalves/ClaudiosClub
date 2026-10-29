import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Autonomy, ChatAttachment, ChatItem, Effort, SendPriority, UiLevel } from '../../../shared/model';
import { api } from '../api';
import { FileDiffIcon, ImageIcon, SendIcon } from '../icons';
import { t, locale } from '../i18n';
import { shrinkImage } from '../lib/shrinkImage';
import {
  applySuggestion,
  ChatSettingsBar,
  commandSuggestions,
  isAttachable,
  modelLabel,
  readAttachment,
  SuggestionList,
  TodoPanel,
  todosFrom,
  triggerOf,
  useFileSuggestions,
} from './ChatExtras';
import { ChangesPanel } from './ChangesPanel';
import { useChatDetail } from './chatDetail';
import { Markdown } from './markdown';

/** Prints no chat: até 4 por mensagem, com o lado maior em até 1568 px (o que o Claude lê sem reduzir). */
const MAX_IMAGES = 4;
const CHAT_IMAGE_MAX = 1568;
import { useChat } from './useChat';

interface Props {
  projectId: string;
  sessionId: string | null;
  staffId: string | null;
  name: string;
  /** Autonomia da ficha: com que ele executa um plano aprovado ("só planeja" executa como "edita sozinho"). */
  autonomy?: Autonomy | null;
  /** Sem ficha e sem sessão não há com quem conversar. */
  disabled?: string | null;
  /** A primeira mensagem criou a sessão (o quadro precisa saber). */
  onSessionStarted?: (sessionId: string) => void;
  /** Nível de uso: os ajustes da conversa mudam de cara. */
  level?: UiLevel;
  /** Modelo e esforço da ficha (o que vale até você trocar na conversa). */
  fichaModel?: string | null;
  fichaEffort?: Effort | null;
  /** Topo compacto do funcionário (montado pelo EmployeePanel); o "⋯" fica à direita dele. */
  top?: ReactNode;
  /** O que o "Mais" mostra (vem do EmployeePanel): extras da aba Conversa e as abas do funcionário. */
  more?: { conversation?: ReactNode; tabs?: MoreTab[] };
}

/** Uma aba do "Mais" (Ficha, Expediente, Rotinas, Ações…). */
export interface MoreTab {
  id: string;
  label: string;
  content: ReactNode;
}

/** Conversa com o funcionário dentro do Claudio’s Club, sem terminal. */
export function ChatView({ projectId, sessionId, staffId, name, autonomy, disabled, onSessionStarted, level = 'advanced', fichaModel = null, fichaEffort = null, top, more }: Props) {
  const chat = useChat(projectId, sessionId, staffId);
  const todos = useMemo(() => todosFrom(chat.items), [chat.items]);
  useEffect(() => {
    if (chat.sessionId && chat.sessionId !== sessionId) onSessionStarted?.(chat.sessionId);
  }, [chat.sessionId, sessionId, onSessionStarted]);
  const [draft, setDraft] = useState('');
  const [showTools] = useChatDetail();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const executeAs: Autonomy = !autonomy || autonomy === 'plan' ? 'acceptEdits' : autonomy;

  const busy = chat.state?.busy ?? false;
  const pending = chat.items.some((i) => i.kind === 'permission' && i.status === 'pending');
  // Por padrão a conversa mostra só o que importa entre você e o funcionário: as ferramentas
  // (Read, Grep, comandos…) ficam escondidas; pedidos de permissão e avisos continuam.
  const visible = showTools ? chat.items : chat.items.filter((i) => i.kind !== 'tool');
  const last = chat.items.at(-1);
  const streaming = busy && last?.kind === 'assistant' && !!last.text;
  // Enquanto trabalha, uma linha discreta diz o que ele está fazendo agora.
  const doing = busy && last?.kind === 'tool' && last.result === null ? `${last.name} ${last.summary}` : null;

  // Acompanha o fim da conversa, a menos que a pessoa tenha rolado para cima.
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, busy, showTools]);
  // Ao abrir (ou trocar de conversa), começa pela última mensagem.
  useEffect(() => {
    const el = list.current;
    if (!chat.loading && el) {
      stick.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }, [chat.loading]);

  // Mensagem com o funcionário trabalhando: quem decide é o servidor, pela config geral (menu
  // config); aqui só o texto do botão. Relê quando ele começa a trabalhar, para pegar a mudança.
  const [whileBusy, setWhileBusy] = useState<SendPriority>('next');
  useEffect(() => {
    if (busy) api.config().then((c) => setWhileBusy(c.sendWhileBusy), () => {});
  }, [busy]);

  // Prints colados (Ctrl+V) ou anexados: reduzidos no navegador e mandados junto com o texto.
  const [images, setImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const addImages = async (files: File[]) => {
    setImageError(null);
    const valid = files.filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
    if (!valid.length) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) return setImageError(t('chat.maxImages', { max: MAX_IMAGES }));
    try {
      const shrunk = await Promise.all(valid.slice(0, room).map((f) => shrinkImage(f, CHAT_IMAGE_MAX)));
      setImages((prev) => [...prev, ...shrunk].slice(0, MAX_IMAGES));
      if (valid.length > room) setImageError(t('chat.maxImages', { max: MAX_IMAGES }));
    } catch {
      setImageError(t('chat.imageReadFail'));
    }
  };

  // Arquivos de texto e PDF anexados (o funcionário lê junto com a mensagem).
  const [files, setFiles] = useState<ChatAttachment[]>([]);
  const addFiles = async (list: File[]) => {
    const pictures = list.filter((f) => f.type.startsWith('image/'));
    const docs = list.filter((f) => !f.type.startsWith('image/'));
    if (pictures.length) await addImages(pictures);
    if (!docs.length) return;
    setImageError(null);
    const bad = docs.filter((f) => !isAttachable(f));
    try {
      const read = await Promise.all(docs.filter(isAttachable).map(readAttachment));
      setFiles((prev) => [...prev, ...read].slice(0, 5));
      if (bad.length) setImageError(t('chat.cantAttach', { names: bad.map((f) => f.name).join(', ') }));
    } catch (e) {
      setImageError((e as Error).message);
    }
  };

  // "/" no começo abre os comandos da sessão; "@" abre os arquivos do projeto.
  const trigger = triggerOf(draft);
  const fileHits = useFileSuggestions(projectId, trigger, api.files);
  const suggestions = trigger?.kind === 'command' ? commandSuggestions(chat.commands, trigger.query) : trigger?.kind === 'file' ? fileHits : [];
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const showSuggest = !!trigger && suggestions.length > 0 && dismissed !== draft;
  useEffect(() => setPick(0), [trigger?.kind, trigger?.query]);
  const choose = (value: string) => {
    if (!trigger) return;
    setDraft(applySuggestion(draft, trigger, value));
    input.current?.focus();
  };

  const submit = async () => {
    const text = draft.trim();
    if ((!text && !images.length && !files.length) || pending) return;
    const sent = images;
    const sentFiles = files;
    setDraft('');
    setImages([]);
    setFiles([]);
    // Não foi (erro, ou a trava de consumo recusada): o texto e os anexos voltam para a caixa.
    if (!(await chat.send(text, undefined, sent, sentFiles))) {
      setDraft((d) => d || text);
      setImages((cur) => (cur.length ? cur : sent));
      setFiles((cur) => (cur.length ? cur : sentFiles));
    }
  };

  const blocked = disabled ?? (chat.elsewhere ? t('chat.openElsewhereShort') : null);
  const [showChanges, setShowChanges] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  // "Mais": abre com o foco no painel; ao fechar, o foco volta para o "⋯".
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreTab, setMoreTab] = useState('conversa');
  /** Os chips da linha de status abrem o "Mais" direto na aba da conversa. */
  const openConversationMore = () => {
    setMoreTab('conversa');
    setMoreOpen(true);
  };
  const moreBtn = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (moreOpen) moreRef.current?.focus();
  }, [moreOpen]);
  const closeMore = () => {
    setMoreOpen(false);
    moreBtn.current?.focus();
  };
  // Linha de status: a autonomia aparece sempre (é informação de segurança); sem processo, vale a da ficha.
  const mode = chat.state?.permissionMode ?? (autonomy ? MODE_OF_AUTONOMY[autonomy] : null);
  const modeAlert = mode === 'bypassPermissions' ? 'is-danger' : mode === 'auto' ? 'is-warn' : '';
  const effort = chat.state?.effort ?? fichaEffort;

  /** "Voltar até aqui": mostra o que volta, pede confirmação e desfaz as edições desde aquela mensagem. */
  const rewind = async (uuid: string) => {
    const sid = chat.sessionId;
    if (!sid) return;
    const p = await api.chatRewind(projectId, sid, staffId, uuid, true).catch((e: Error) => ({ canRewind: false, files: [], insertions: 0, deletions: 0, error: e.message }));
    if (!p.canRewind) {
      window.alert(p.error ? t('chat.rewindNoError', { error: p.error }) : t('chat.rewindNo'));
      return;
    }
    if (!p.files.length) {
      window.alert(t('chat.rewindNoChanges'));
      return;
    }
    const list = p.files.map((f) => `• ${f}`).join('\n');
    if (
      !window.confirm(
        t('chat.rewindConfirm', {
          files: p.files.length === 1 ? t('chat.filesOne') : t('chat.filesOther', { n: p.files.length }),
          ins: p.insertions,
          del: p.deletions,
          list,
        }),
      )
    )
      return;
    await api.chatRewind(projectId, sid, staffId, uuid, false).catch((e: Error) => window.alert(e.message));
  };

  // "Mais": uma aba para a conversa e as do funcionário (Ficha, Expediente…), num lugar só.
  const conversationTab = (
    <>
      {chat.state?.running && chat.sessionId && !!chat.state.background?.length && (
        <ul className="chat-extra small">
          {chat.state.background.map((task) => (
            <li key={task.id}>
              <span className="muted">{task.kind === 'agent' ? 'agent' : task.kind === 'shell' ? t('chat.kindShell') : task.kind}</span> {task.label}{' '}
              <button type="button" className="link small" onClick={() => void api.chatStopTask(chat.sessionId!, task.id).catch((e: Error) => window.alert(e.message))}>
                {t('chat.stopTask')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {staffId && <ChatSettingsBar level={level} state={chat.state} fichaModel={fichaModel} fichaEffort={fichaEffort} disabled={!!blocked} onChange={chat.settings} />}
      <div className="chat-more-row">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void chat.compact()}
          disabled={!chat.sessionId || busy || !!blocked}
          title={t('chat.compactHelp')}
        >
          {chat.state?.compacting ? t('chat.compacting') : t('chat.compact')}
        </button>
        {level === 'advanced' && chat.state?.running && chat.sessionId && (
          <button type="button" className="btn-secondary btn-toggle" aria-pressed={mcpOpen} onClick={() => setMcpOpen(!mcpOpen)} title={t('chat.mcpsHelp')}>
            MCPs
          </button>
        )}
        {more?.conversation}
      </div>
      {mcpOpen && chat.sessionId && <McpMenu projectId={projectId} sessionId={chat.sessionId} staffId={staffId} />}
    </>
  );
  const moreTabs: MoreTab[] = [{ id: 'conversa', label: t('chat.tabConversation'), content: conversationTab }, ...(more?.tabs ?? [])];
  const activeTab = moreTabs.find((tab) => tab.id === moreTab) ?? moreTabs[0]!;

  return (
    <section className="chat">
      <div className="chat-top">
        {top}
        <button
          type="button"
          ref={moreBtn}
          className="btn-secondary chat-more-btn"
          aria-label={t('chat.moreOptions')}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          title={t('chat.moreOptions')}
          onClick={() => setMoreOpen(true)}
        >
          ⋯
        </button>
      </div>
      {moreOpen && (
        <div
          className="chat-more"
          role="dialog"
          aria-labelledby="chat-more-title"
          tabIndex={-1}
          ref={moreRef}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeMore();
          }}
        >
          <div className="chat-more-head">
            <h3 id="chat-more-title">{t('chat.moreOptions')}</h3>
            <button type="button" className="btn-secondary" onClick={closeMore}>
              {t('chat.close')}
            </button>
          </div>
          <div className="tabs" role="tablist" aria-label={t('chat.moreOptions')}>
            {moreTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`more-tab-${tab.id}`}
                aria-selected={moreTab === tab.id}
                aria-controls="chat-more-panel"
                className={`tab ${moreTab === tab.id ? 'is-active' : ''}`}
                onClick={() => setMoreTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="chat-more-sec" role="tabpanel" id="chat-more-panel" aria-labelledby={`more-tab-${activeTab.id}`}>
            {activeTab.content}
          </div>
        </div>
      )}
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {chat.loading && <p className="muted small chat-empty">{t('chat.loadingChat')}</p>}
        {!chat.loading && visible.length === 0 && (
          <p className="muted small chat-empty">{sessionId ? t('chat.noMessages') : t('chat.startChat', { name })}</p>
        )}
        {visible.map((item) => (
          <Item
            key={item.id}
            item={item}
            onAnswer={chat.answer}
            executeAs={executeAs}
            onChangesRequested={() => input.current?.focus()}
            onRewind={staffId && chat.sessionId && !blocked ? (uuid) => void rewind(uuid) : undefined}
          />
        ))}
        {busy && !streaming && !pending && (
          <div className="chat-typing" aria-live="polite">
            {chat.state?.compacting ? t('chat.compactingChat') : t('chat.working', { name })}
            <span className="bn-working" />
            {doing && !showTools && <span className="chat-doing mono">{doing}</span>}
          </div>
        )}
      </div>

      {chat.elsewhere && (
        <div className="chat-elsewhere">
          {chat.elsewhere.orphan ? (
            <>
              <p>
                {t('chat.orphanProc', {
                  status: chat.elsewhere.status ? ` (${STATUS_TEXT[chat.elsewhere.status] ?? chat.elsewhere.status})` : '',
                })}
              </p>
              <p className="muted small">
                {t('chat.bringHere')}
                {chat.elsewhere.status === 'busy' ? t('chat.stoppedMidTurn') : ''}
              </p>
            </>
          ) : (
            <>
              <p>
                {t('chat.sessionOpen', {
                  where: t(chat.elsewhere.entrypoint === 'claude-desktop' ? 'chat.whereDesktop' : 'chat.whereTerminal'),
                  status: chat.elsewhere.status ? ` (${STATUS_TEXT[chat.elsewhere.status] ?? chat.elsewhere.status})` : '',
                })}
              </p>
              <p className="muted small">{t(chat.elsewhere.entrypoint === 'claude-desktop' ? 'chat.closeDesktop' : 'chat.closeTerminal')}</p>
            </>
          )}
          <button className="btn-primary" onClick={() => void chat.recheck()}>
            {t('chat.bringToMyco')}
          </button>
        </div>
      )}

      {chat.error && <p className="error small">{chat.error}</p>}

      <TodoPanel todos={todos} />

      {(images.length > 0 || files.length > 0 || imageError) && (
        <div className="chat-images">
          {images.map((src, i) => (
            <span key={i} className="chat-image">
              <img src={src} alt={t('chat.imageAlt', { n: i + 1 })} />
              <button type="button" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} title={t('chat.removeImage')} aria-label={t('chat.removeImageAria')}>
                ×
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <span key={`f${i}`} className="chat-file small">
              {f.name}
              <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} title={t('chat.removeFile')} aria-label={t('chat.removeNamed', { name: f.name })}>
                ×
              </button>
            </span>
          ))}
          {imageError && <span className="error small">{imageError}</span>}
        </div>
      )}

      <div className="chat-input">
        {showSuggest && <SuggestionList items={suggestions} active={pick} onPick={(s) => choose(s.value)} />}
        <textarea
          ref={input}
          value={draft}
          placeholder={blocked ? t('chat.unavailable', { why: blocked }) : t('chat.placeholder', { name })}
          title={blocked ? undefined : t('chat.inputHelp')}
          disabled={!!blocked}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (!pasted.length) return;
            e.preventDefault();
            void addFiles(pasted);
          }}
          onKeyDown={(e) => {
            if (showSuggest) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                e.preventDefault();
                choose(suggestions[pick]!.value);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(draft);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="chat-actions">
          <label className="btn-secondary chat-attach" title={t('chat.attachHelp')}>
            <ImageIcon />
            <span className="sr-only">{t('chat.attachFile')}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.md,.csv,.json,.yml,.yaml,.ts,.tsx,.js,.php,.py,.sql,.log"
              multiple
              disabled={!!blocked}
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </label>
          {busy && (
            <button className="btn-secondary chat-stop" onClick={() => void chat.interrupt()} title={t('chat.stopHelp')}>
              {t('chat.stop')}
            </button>
          )}
          <button
            className="btn-primary chat-send"
            onClick={() => void submit()}
            disabled={(!draft.trim() && !images.length && !files.length) || !!blocked || pending}
            aria-label={busy ? PRIORITY_BUTTON[whileBusy] : t('chat.send')}
            title={pending ? t('chat.answerFirst') : busy ? `${PRIORITY_BUTTON[whileBusy]}: ${PRIORITY_HELP[whileBusy]}` : t('chat.sendEnter')}
          >
            <SendIcon />
          </button>
        </div>
      </div>

      <div className="chat-status">
        {mode && (
          <button
            type="button"
            className={`chat-chip ${modeAlert}`}
            onClick={openConversationMore}
            title={t('chat.modeTitle', {
              info: chat.state?.permissionMode ? t('chat.modeInForce', { mode }) : t('chat.autonomyFromProfile'),
            })}
          >
            {MODE_TEXT[mode] ?? mode}
          </button>
        )}
        <button type="button" className="chat-chip" onClick={openConversationMore} title={t('chat.modelHelp')}>
          {modelLabel(chat.state?.model) || modelLabel(fichaModel) || t('chat.defaultModel')}
          {effort ? t('chat.effortShort', { e: effort }) : ''}
        </button>
        <ContextMeter context={chat.context} />
        {chat.state?.running && !!chat.state.background?.length && (
          <button
            type="button"
            className="link small"
            title={`${chat.state.background.map((task) => task.label).join('\n')}\n\n${t('chat.clickToStop')}`}
            onClick={openConversationMore}
          >
            {t('chat.background', { n: chat.state.background.length })}
          </button>
        )}
        {staffId && chat.sessionId && (
          <button
            type="button"
            className="btn-secondary chat-changes"
            onClick={() => setShowChanges(true)}
            aria-label={t('chat.changes')}
            title={t('chat.changesHelp')}
          >
            <FileDiffIcon />
          </button>
        )}
      </div>
      {showChanges && chat.sessionId && <ChangesPanel projectId={projectId} sessionId={chat.sessionId} staffId={staffId} name={name} onClose={() => setShowChanges(false)} />}
    </section>
  );
}

/** MCPs só desta conversa: liga e desliga sem mexer na ficha. */
function McpMenu({ projectId, sessionId, staffId }: { projectId: string; sessionId: string; staffId: string | null }) {
  const [list, setList] = useState<Array<{ name: string; status: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.chatMcp(projectId, sessionId, staffId).then(setList, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, staffId]);
  const toggle = async (name: string, enabled: boolean) => {
    setError(null);
    try {
      await api.chatMcpToggle(projectId, sessionId, staffId, name, enabled);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <ul className="chat-extra small">
      {!list && !error && <li className="muted">{t('chat.readingMcps')}</li>}
      {list?.length === 0 && <li className="muted">{t('chat.noMcps')}</li>}
      {list?.map((m) => (
        <li key={m.name}>
          <label className="check">
            <input type="checkbox" checked={m.status !== 'disabled'} onChange={(e) => void toggle(m.name, e.target.checked)} /> {m.name}
            <span className="muted"> {m.status}</span>
          </label>
        </li>
      ))}
      {error && <li className="error">{error}</li>}
    </ul>
  );
}

const STATUS_TEXT: Record<string, string> = { busy: t('chat.stBusy'), idle: t('chat.stIdle'), waiting: t('chat.stWaiting') };

const PRIORITY_BUTTON: Record<SendPriority, string> = { next: t('chat.send'), later: t('chat.prioLater'), now: t('chat.prioNow') };
const PRIORITY_HELP: Record<SendPriority, string> = {
  next: t('chat.prioNextHelp'),
  later: t('chat.prioLaterHelp'),
  now: t('chat.prioNowHelp'),
};
const QUEUED_TEXT: Record<SendPriority, string> = { next: t('chat.queuedNext'), later: t('chat.queuedLater'), now: t('chat.queuedNow') };

/** Modo que o Claude Code reporta → o nome da autonomia na ficha. */
const MODE_TEXT: Record<string, string> = {
  default: t('chat.modeAsk'),
  acceptEdits: t('chat.modeEdits'),
  plan: t('chat.modePlan'),
  auto: t('chat.modeAuto'),
  dontAsk: t('chat.modeDontAsk'),
  bypassPermissions: t('chat.modeBypass'),
};
/** Autonomia da ficha → modo do Claude Code (vale antes de a conversa abrir). */
const MODE_OF_AUTONOMY: Record<Autonomy, string> = {
  plan: 'plan',
  manual: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  bypassPermissions: 'bypassPermissions',
};

/** Compacto: "contexto 42%"; a barrinha só aparece a partir de 60%. Os números completos ficam no tooltip. */
function ContextMeter({ context }: { context: { used: number; window: number; percent: number } | null }) {
  if (!context) return <span className="muted small">{t('chat.contextNone')}</span>;
  const level = context.percent >= 80 ? 'high' : context.percent >= 60 ? 'mid' : 'low';
  return (
    <span
      className={`meter meter-${level}`}
      title={t('chat.tokensOf', { used: context.used.toLocaleString(locale()), window: context.window.toLocaleString(locale()) })}
    >
      <span className="meter-label">{t('chat.context')}</span>
      {context.percent >= 60 && (
        <span className="meter-track">
          <span className="meter-fill" style={{ width: `${Math.min(100, context.percent)}%` }} />
        </span>
      )}
      <span className="meter-value">{context.percent}%</span>
    </span>
  );
}

type Answer = (id: string, allow: boolean, opts?: { message?: string; executeAs?: Autonomy; remember?: 'session' | 'project' }) => Promise<void>;

function Item({
  item,
  onAnswer,
  executeAs,
  onChangesRequested,
  onRewind,
}: {
  item: ChatItem;
  onAnswer: Answer;
  executeAs: Autonomy;
  onChangesRequested: () => void;
  /** "Voltar até aqui" nas suas mensagens (as que têm o id do transcript). */
  onRewind?: (uuid: string) => void;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg msg-user">
          {onRewind && item.uuid && !item.held && (
            <button type="button" className="msg-rewind" title={t('chat.rewindHelp')} onClick={() => onRewind(item.uuid!)}>
              {t('chat.rewindHere')}
            </button>
          )}
          {item.images ? (
            <span className="msg-images">
              <ImageIcon size={12} /> {item.images === 1 ? t('chat.imagesOne') : t('chat.imagesOther', { n: item.images })}
            </span>
          ) : null}
          {item.files?.length ? <span className="msg-images">{t('chat.attachments', { files: item.files.join(', ') })}</span> : null}
          {item.text}
          {item.queued && <span className="msg-queued">{QUEUED_TEXT[item.queued]}</span>}
          {item.held && <span className="msg-queued">{t('chat.heldByMyco', { why: item.held })}</span>}
        </div>
      );
    case 'assistant':
      return item.text ? (
        <div className="msg msg-assistant">
          <Markdown text={item.text} />
        </div>
      ) : null;
    case 'tool':
      return (
        <details className={`tool ${item.isError ? 'tool-error' : ''}`}>
          <summary>
            <span className="tool-name">{item.name}</span> <span className="tool-summary">{item.summary}</span>
            {item.result === null && <span className="muted small"> · {t('chat.running')}</span>}
          </summary>
          {item.input && <pre className="tool-io">{item.input}</pre>}
          {item.result !== null && <pre className="tool-io">{item.result || t('chat.noOutput')}</pre>}
        </details>
      );
    case 'permission':
      return item.plan !== undefined ? (
        <PlanCard item={item} plan={item.plan} onAnswer={onAnswer} executeAs={executeAs} onChangesRequested={onChangesRequested} />
      ) : (
        <PermissionCard item={item} onAnswer={onAnswer} />
      );
    case 'notice':
      return <div className={`chat-notice chat-notice-${item.tone}`}>{item.text}</div>;
  }
}

const AUTONOMY_SHORT: Record<Autonomy, string> = {
  plan: t('chat.shortPlan'),
  manual: t('chat.shortManual'),
  acceptEdits: t('chat.shortEdits'),
  auto: t('chat.shortAuto'),
  bypassPermissions: t('chat.shortBypass'),
};

/**
 * Fim do modo plano: o plano formatado, para aprovar (e ele passa a executar com a autonomia da
 * ficha) ou pedir mudanças (ele continua só planejando e espera o que você escrever).
 */
function PlanCard({
  item,
  plan,
  onAnswer,
  executeAs,
  onChangesRequested,
}: {
  item: Extract<ChatItem, { kind: 'permission' }>;
  plan: string;
  onAnswer: Answer;
  executeAs: Autonomy;
  onChangesRequested: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const requestId = item.id.replace(/^p:/, '');
  const approve = async () => {
    setBusy(true);
    await onAnswer(requestId, true, { executeAs });
    setBusy(false);
  };
  const changes = async () => {
    setBusy(true);
    // Vai ao agente: fica em português de propósito (é o prompt que ele lê, não a interface).
    await onAnswer(requestId, false, { message: 'O usuário quer mudanças no plano. Pergunte o que mudar e espere a resposta dele.' });
    setBusy(false);
    onChangesRequested();
  };
  return (
    <div className={`permission permission-plan permission-${item.status}`}>
      <p className="permission-title">
        <b>{t('chat.planReady')}</b>{' '}
        <span className="muted small">{item.status === 'pending' ? t('chat.planPending') : item.status === 'allowed' ? t('chat.planApproved') : t('chat.planReturned')}</span>
      </p>
      <div className="plan-body">
        <Markdown text={plan} />
      </div>
      {item.status === 'pending' ? (
        <div className="actions">
          <button className="btn-primary" disabled={busy} onClick={() => void approve()} title={t('chat.runsTitle', { how: AUTONOMY_SHORT[executeAs] })}>
            {t('chat.approveRun')}
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void changes()} title={t('chat.askChangesHelp')}>
            {t('chat.askChanges')}
          </button>
          <span className="muted small">{t('chat.runsHow', { how: AUTONOMY_SHORT[executeAs] })}</span>
        </div>
      ) : (
        <p className="small muted">{item.status === 'allowed' ? t('chat.approvedRunning', { how: AUTONOMY_SHORT[executeAs] }) : t('chat.returnedForChanges')}</p>
      )}
    </div>
  );
}

function PermissionCard({ item, onAnswer }: { item: Extract<ChatItem, { kind: 'permission' }>; onAnswer: Answer }) {
  const [busy, setBusy] = useState(false);
  const requestId = item.id.replace(/^p:/, '');
  const answer = async (allow: boolean, remember?: 'session' | 'project') => {
    setBusy(true);
    await onAnswer(requestId, allow, remember ? { remember } : undefined);
    setBusy(false);
  };
  return (
    <div className={`permission permission-${item.status}`}>
      <p className="permission-title">
        {t('chat.asksPermission')} <b>{item.tool}</b>
      </p>
      <p className="mono small">{item.summary}</p>
      {item.description && <p className="small">{item.description}</p>}
      <details>
        <summary className="small">{t('chat.details')}</summary>
        <pre className="tool-io">{item.input}</pre>
      </details>
      {item.status === 'pending' ? (
        <div className="actions">
          <button className="btn-primary" disabled={busy} onClick={() => void answer(true)}>
            {t('chat.approve')}
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void answer(true, 'session')} title={t('chat.alwaysHereHelp')}>
            {t('chat.alwaysHere')}
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void answer(true, 'project')} title={t('chat.alwaysProjectHelp')}>
            {t('chat.alwaysProject')}
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void answer(false)}>
            {t('chat.deny')}
          </button>
        </div>
      ) : (
        <p className="small muted">
          {item.status === 'allowed'
            ? item.remembered === 'session'
              ? t('chat.approvedHere')
              : item.remembered === 'project'
                ? t('chat.approvedProject')
                : t('chat.approved')
            : t('chat.denied')}
        </p>
      )}
    </div>
  );
}
