import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Autonomy, ChatAttachment, ChatItem, CodexEffort, Engine, EngineOverride, SendPriority, UiLevel } from '../../../shared/model';
import { alertError, api, isPairingError, type PermissionOpts } from '../api';
import { ArrowDownIcon, FileDiffIcon, ImageIcon, McpIcon, SendIcon, StopIcon } from '../icons';
import { t, locale } from '../i18n';
import { shrinkImage } from '../lib/shrinkImage';
import { ChatFallbackBadge } from '../staff/FallbackBadge';
import {
  applySuggestion,
  ChatSettingsBar,
  commandSuggestions,
  isAttachable,
  readAttachment,
  SuggestionList,
  TodoPanel,
  todosFrom,
  triggerOf,
  useFileSuggestions,
} from './ChatExtras';
import { ChangesPanel } from './ChangesPanel';
import { useChatDetail } from './chatDetail';
import type { ChatFocus } from './chatFocus';
import { MoreTabs } from './MoreTabs';
import { MsgTime } from './MsgTime';
import { QuestionCard } from './QuestionCard';
import { useChatFocus } from './useChatFocus';
import { useOpenAt } from './useOpenAt';
import { Markdown, OpenFileContext, type OpenFileApi, looksLikeMarkdown, useCopy } from './markdown';
import { systemMessageText } from './systemMessage';
import { ToolInput } from './ToolInput';
import { clockHM, secondsLeft } from './wakeCountdown';

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
  /** Modelo e esforço que a conversa usa ao abrir (o da conversa > o da ficha > o último escolhido no chat); vale até o processo informar o dele. */
  fichaModel?: string | null;
  fichaEffort?: CodexEffort | null;
  /** Quem roda o funcionário (a ficha): no Codex o seletor de modelo e esforço mostra os do Codex. */
  engine?: Engine;
  /** Topo compacto do funcionário (montado pelo EmployeePanel); o "⋯" fica à direita dele. */
  top?: ReactNode;
  /** Abas do "Mais" (vêm do EmployeePanel): só coisas do funcionário; os ajustes da conversa ficam abaixo da caixa. */
  moreTabs?: MoreTab[];
  /** Clique num aviso da caixa "precisa de mim": rola até o balão que o causou e o destaca. */
  focus?: ChatFocus | null;
  /** O alvo foi atendido (ou o balão não apareceu a tempo): pode ser largado. */
  onFocusDone?: () => void;
  /** A conversa tem aviso na caixa "precisa de mim" (pergunta, permissão…): abre no fim, e não na sua última mensagem. */
  awaiting?: boolean;
  /** Caminho absoluto do projeto: arquivo citado dentro dele abre no editor. */
  projectRoot?: string;
  /** Abre um arquivo do projeto (relativo) no editor de arquivos; sem ele, os caminhos da resposta são só texto. */
  onOpenFile?: (path: string) => void;
}

/**
 * Uma aba do "Mais" (Ficha, Projeto, Desempenho, Ações…). Com função, o conteúdo recebe como trocar de aba:
 * a ficha usa para levar a quem a salva com um campo obrigatório vazio até a aba dele.
 */
export interface MoreTab {
  id: string;
  label: string;
  content: ReactNode | ((select: (id: string) => void) => ReactNode);
}

/** Conversa com o funcionário dentro do Claudio’s Club, sem terminal. */
export function ChatView({ projectId, sessionId, staffId, name, autonomy, disabled, onSessionStarted, level = 'advanced', fichaModel = null, fichaEffort = null, engine = 'claude', top, moreTabs = [], focus = null, onFocusDone, awaiting = false, projectRoot, onOpenFile }: Props) {
  const chat = useChat(projectId, sessionId, staffId, name);
  const todos = useMemo(() => todosFrom(chat.items), [chat.items]);
  useEffect(() => {
    if (chat.sessionId && chat.sessionId !== sessionId) onSessionStarted?.(chat.sessionId);
  }, [chat.sessionId, sessionId, onSessionStarted]);
  const [draft, setDraft] = useState('');
  const [showTools] = useChatDetail();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  // Rolou para cima: aparece a seta para voltar ao fim.
  const [away, setAway] = useState(false);
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

  // Ao abrir (ou trocar de conversa) sem pendência, a última mensagem enviada a ele fica no topo e a resposta logo
  // abaixo, para ler do começo; com pendência, ou vindo de um aviso que aponta um balão, começa pelo fim.
  const opening = useOpenAt({
    list,
    stick,
    items: chat.items,
    loading: chat.loading,
    atEnd: pending || awaiting || (focus?.sessionId === sessionId && !!(focus.itemId || focus.quote)),
    onAway: setAway,
  });
  // Acompanha o fim da conversa, a menos que a pessoa tenha rolado para cima (ou ela esteja aberta na mensagem).
  // Antes da pintura: com as mensagens chegando juntas (o SSE repete o processo aberto), o fim não fica para trás.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current && !opening.holding()) el.scrollTop = el.scrollHeight;
  }, [chat.items, busy, showTools]);
  // Vindo de um aviso, rola até o balão dele (depois de abrir no fim) e não deixa o fim puxar de volta.
  const focusing = useChatFocus({ list, stick, items: chat.items, loading: chat.loading, sessionId, focus, onDone: onFocusDone, onAway: setAway });

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
    focusing.release(); // mandou mensagem: volta a acompanhar o fim
    opening.release();
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

  // Órfão do Claudio’s Club não trava: a próxima mensagem já retoma a conversa aqui.
  const blocked = disabled ?? (chat.elsewhere && !chat.elsewhere.orphan ? t('chat.openElsewhereShort') : null);
  // Ao abrir o painel, o cursor já vai para a caixa de mensagem (uma vez, assim que ela estiver liberada).
  const focused = useRef(false);
  useEffect(() => {
    if (blocked || focused.current) return;
    focused.current = true;
    input.current?.focus({ preventScroll: true });
  }, [blocked]);
  const [showChanges, setShowChanges] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  // "Mais": abre com o foco no painel; ao fechar, o foco volta para o "⋯".
  const [moreOpen, setMoreOpen] = useState(false);
  // Avisos de limite (e do despertador) já cancelados aqui: numa conversa fechada o aviso só some ao recarregar o histórico.
  const [autoCancelled, setAutoCancelled] = useState<ReadonlySet<string>>(new Set());
  const [moreTab, setMoreTab] = useState(moreTabs[0]?.id ?? '');
  const moreBtn = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (moreOpen) moreRef.current?.focus();
  }, [moreOpen]);
  // Vindo de um aviso, mostra a conversa (e não o "Mais" aberto por cima dela).
  useEffect(() => {
    if (focus) setMoreOpen(false);
  }, [focus]);
  const closeMore = () => {
    setMoreOpen(false);
    moreBtn.current?.focus();
  };

  /** "Voltar até aqui": mostra o que volta, pede confirmação e desfaz as edições desde aquela mensagem. */
  const rewind = async (uuid: string) => {
    const sid = chat.sessionId;
    if (!sid) return;
    const p = await api
      .chatRewind(projectId, sid, staffId, uuid, true)
      .catch((e: Error) => (isPairingError(e) ? null : { canRewind: false, files: [], insertions: 0, deletions: 0, error: e.message }));
    if (!p) return;
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
    await api.chatRewind(projectId, sid, staffId, uuid, false).catch(alertError);
  };

  const activeTab = moreTabs.find((tab) => tab.id === moreTab) ?? moreTabs[0];
  const showMcp = level === 'advanced' && !!chat.state?.running && !!chat.sessionId;
  const showDiff = !!staffId && !!chat.sessionId;
  const background = chat.state?.running && chat.sessionId ? (chat.state.background ?? []) : [];

  // O callback do pai muda a cada render; o context recebe um `open` fixo (lê o atual por ref) para não re-renderizar as mensagens à toa.
  const openRef = useRef(onOpenFile);
  useLayoutEffect(() => {
    openRef.current = onOpenFile;
  });
  const open = useMemo(() => (path: string) => openRef.current?.(path), []);
  const canOpen = !!onOpenFile;
  const fileLinks = useMemo<OpenFileApi | null>(() => (canOpen ? { projectRoot, open } : null), [canOpen, projectRoot, open]);

  return (
    <OpenFileContext.Provider value={fileLinks}>
      <section className="chat">
        <div className="chat-top">
          {top}
          {activeTab && (
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
          )}
        </div>
        {chat.fallback && <ChatFallbackBadge fallback={chat.fallback} />}
        {moreOpen && activeTab && (
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
              <button type="button" className="drawer-close in-head" onClick={closeMore} aria-label={t('chat.close')}>
                ×
              </button>
            </div>
            <MoreTabs tabs={moreTabs} active={activeTab.id} onActive={setMoreTab} label={t('chat.moreOptions')} />
          </div>
        )}
        <div
          className="chat-list"
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (stick.current) focusing.release();
            setAway(!stick.current);
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
              fallback={chat.fallback}
              onAnswer={chat.answer}
              executeAs={executeAs}
              onChangesRequested={() => input.current?.focus()}
              onRewind={staffId && chat.sessionId && !blocked ? (uuid) => void rewind(uuid) : undefined}
              autoCancelled={autoCancelled.has(item.id)}
              onCancelAutoContinue={
                chat.sessionId
                  ? () =>
                      void api
                        .chatCancelAutoContinue(projectId, chat.sessionId!)
                        .then(() => setAutoCancelled((s) => new Set(s).add(item.id)))
                        .catch(alertError)
                  : undefined
              }
              onCancelWake={
                chat.sessionId
                  ? () =>
                      void api
                        .chatCancelWake(projectId, chat.sessionId!)
                        .then(() => setAutoCancelled((s) => new Set(s).add(item.id)))
                        .catch(alertError)
                  : undefined
              }
            />
          ))}
          {busy && !streaming && !pending && (
            <div className="chat-typing" aria-live="polite">
              {chat.state?.compacting ? t('chat.compactingChat') : t('chat.working', { name })}
              <span className="bn-working" />
              {doing && !showTools && <span className="chat-doing mono" title={doing}>{doing}</span>}
            </div>
          )}
          {away && (
            <button
              type="button"
              className="chat-bottom"
              aria-label={t('chat.scrollBottom')}
              title={t('chat.scrollBottom')}
              onClick={() => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })}
            >
              <ArrowDownIcon />
            </button>
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
                <p className="muted small">{t('chat.copyHere')}</p>
              </>
            )}
            <button className="btn-primary" onClick={() => void chat.recheck()}>
              {t('chat.bringToMyco')}
            </button>
            {!chat.elsewhere.orphan && chat.elsewhere.entrypoint !== 'claude-desktop' && (chat.elsewhere.status === 'waiting' || chat.elsewhere.status === 'idle') && (
              <button className="btn-secondary" onClick={() => window.confirm(t('chat.takeOverConfirm')) && void chat.takeOver()}>
                {t('chat.takeOver')}
              </button>
            )}
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
              <button
                className="btn-secondary chat-stop"
                onClick={() => void chat.interrupt()}
                aria-label={t('chat.stop')}
                title={`${t('chat.stop')}: ${t('chat.stopHelp')}`}
              >
                <StopIcon />
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

        {bgOpen && background.length > 0 && (
          <ul className="chat-extra small">
            {background.map((task) => (
              <li key={task.id}>
                <span className="muted">{task.kind === 'agent' ? 'agent' : task.kind === 'shell' ? t('chat.kindShell') : task.kind}</span> {task.label}{' '}
                <button type="button" className="link small" onClick={() => void api.chatStopTask(chat.sessionId!, task.id).catch(alertError)}>
                  {t('chat.stopTask')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {mcpOpen && chat.sessionId && <McpMenu projectId={projectId} sessionId={chat.sessionId} staffId={staffId} />}

        {/* Ajustes só desta conversa, logo abaixo da caixa (os gerais ficam na ficha). Sem ficha, a conversa só precisa existir. */}
        <div className="chat-status">
          {(staffId || chat.sessionId) && (
            <ChatSettingsBar
              level={level}
              state={chat.state}
              // Na conversa do motor secundário, o seletor mostra o motor, o modelo e o esforço dela (sem esforço = o padrão do motor), não os da ficha.
              fichaModel={chat.fallback ? chat.fallback.model : fichaModel}
              fichaEffort={chat.fallback ? (chat.fallback.effort ?? null) : fichaEffort}
              engine={chat.fallback?.engine ?? engine}
              fichaAutonomy={autonomy}
              disabled={!!blocked}
              onChange={chat.settings}
            />
          )}
          <ContextMeter context={chat.context} />
          {chat.sessionId && (
            <button type="button" className="chat-chip" onClick={() => void chat.compact()} disabled={busy || !!blocked} title={t('chat.compactHelp')}>
              {chat.state?.compacting ? t('chat.compacting') : t('chat.compact')}
            </button>
          )}
          {background.length > 0 && (
            <button
              type="button"
              className="chat-chip btn-toggle"
              aria-pressed={bgOpen}
              title={`${background.map((task) => task.label).join('\n')}\n\n${t('chat.clickToStop')}`}
              onClick={() => setBgOpen(!bgOpen)}
            >
              {t('chat.background', { n: background.length })}
            </button>
          )}
          {/* Botões de ícone, redondos e juntos no fim da linha: MCPs e o que mudou. */}
          {(showMcp || showDiff) && (
            <span className="chat-icon-btns">
              {showMcp && (
                <button
                  type="button"
                  className="btn-secondary chat-icon-btn btn-toggle"
                  aria-pressed={mcpOpen}
                  onClick={() => setMcpOpen(!mcpOpen)}
                  aria-label="MCPs"
                  title={t('chat.mcpsHelp')}
                >
                  <McpIcon size={16} />
                </button>
              )}
              {showDiff && (
                <button type="button" className="btn-secondary chat-icon-btn" onClick={() => setShowChanges(true)} aria-label={t('chat.changes')} title={t('chat.changesHelp')}>
                  <FileDiffIcon size={16} />
                </button>
              )}
            </span>
          )}
        </div>
        {showChanges && chat.sessionId && <ChangesPanel projectId={projectId} sessionId={chat.sessionId} staffId={staffId} name={name} onClose={() => setShowChanges(false)} />}
      </section>
    </OpenFileContext.Provider>
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

/** Rosquinha do contexto usado (como no app do Claude): a cor muda a partir de 60% e 80%; os números ficam no tooltip. */
function ContextMeter({ context }: { context: { used: number; window: number; percent: number } | null }) {
  const percent = context ? Math.min(100, Math.max(0, context.percent)) : 0;
  const level = percent >= 80 ? 'high' : percent >= 60 ? 'mid' : 'low';
  const label = context
    ? `${t('chat.context')} ${context.percent}% · ${t('chat.tokensOf', { used: context.used.toLocaleString(locale()), window: context.window.toLocaleString(locale()) })}`
    : t('chat.contextNone');
  return (
    <span className={`context-ring meter-${level}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle className="context-ring-track" cx="10" cy="10" r="8" pathLength="100" />
        {context && <circle className="context-ring-fill" cx="10" cy="10" r="8" pathLength="100" strokeDasharray={`${percent} 100`} />}
      </svg>
    </span>
  );
}

/** Resposta da IA com "Copiar" (o texto em markdown, como veio) no canto, no hover/foco. */
function AssistantMessage({ id, text, at, fallback }: { id: string; text: string; at: string | null; fallback: EngineOverride | null }) {
  const [copied, copy] = useCopy();
  return (
    <div className="msg msg-assistant" data-item-id={id}>
      <button type="button" className="msg-rewind msg-copy" title={t('chat.msgCopyHelp')} onClick={() => copy(text)}>
        {copied ? t('chat.mdCopied') : t('chat.mdCopy')}
      </button>
      <Markdown text={text} />
      <MsgTime at={at} fallback={fallback} />
    </div>
  );
}

type Answer = (id: string, allow: boolean, opts?: PermissionOpts) => Promise<void>;

function Item({
  item,
  fallback,
  onAnswer,
  executeAs,
  onChangesRequested,
  onRewind,
  onCancelAutoContinue,
  onCancelWake,
  autoCancelled,
}: {
  item: ChatItem;
  fallback: EngineOverride | null;
  onAnswer: Answer;
  executeAs: Autonomy;
  onChangesRequested: () => void;
  /** "Voltar até aqui" nas suas mensagens (as que têm o id do transcript). */
  onRewind?: (uuid: string) => void;
  /** "Cancelar" no aviso de limite de uso: desfaz o "continue" agendado. */
  onCancelAutoContinue?: () => void;
  /** "Cancelar" no aviso do despertador. */
  onCancelWake?: () => void;
  /** O "continue" (ou o despertador) deste aviso já foi cancelado nesta tela. */
  autoCancelled?: boolean;
}) {
  switch (item.kind) {
    case 'user': {
      // Aviso automático da plataforma (entrega de tarefa, contexto…): à esquerda, neutro, com badge.
      const system = systemMessageText(item.text);
      // Colega que delegou: no tom do funcionário (escuro), mas à direita, como quem fala com ele.
      const kind = system !== null ? 'msg-system' : item.fromStaff ? 'msg-staff' : 'msg-user';
      return (
        <div className={`msg ${kind}`} data-item-id={item.id}>
          {system !== null && (
            <span className="badge dim msg-system-badge" title={t('chat.systemMessageHelp')}>
              {t('chat.systemMessage')}
            </span>
          )}
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
          {system !== null ? <Markdown text={system} /> : looksLikeMarkdown(item.text) ? <Markdown text={item.text} /> : item.text}
          {item.queued && <span className="msg-queued">{QUEUED_TEXT[item.queued]}</span>}
          {item.held && <span className="msg-queued">{t('chat.heldByMyco', { why: item.held })}</span>}
          <MsgTime at={item.at} />
        </div>
      );
    }
    case 'assistant':
      return item.text ? <AssistantMessage id={item.id} text={item.text} at={item.at} fallback={fallback} /> : null;
    case 'tool':
      return (
        <details className={`tool ${item.isError ? 'tool-error' : ''}`} data-item-id={item.id}>
          <summary>
            <span className="tool-name">{item.name}</span> <span className="tool-summary">{item.summary}</span>
            {item.result === null && <span className="muted small"> · {t('chat.running')}</span>}
          </summary>
          {item.input && <ToolInput tool={item.name} input={item.input} />}
          {item.result !== null && <pre className="tool-io">{item.result || t('chat.noOutput')}</pre>}
        </details>
      );
    case 'permission':
      return item.plan !== undefined ? (
        <PlanCard item={item} plan={item.plan} onAnswer={onAnswer} executeAs={executeAs} onChangesRequested={onChangesRequested} />
      ) : item.questions ? (
        <QuestionCard item={item} questions={item.questions} onAnswer={onAnswer} />
      ) : (
        <PermissionCard item={item} onAnswer={onAnswer} />
      );
    case 'notice':
      if (item.wake) return <WakeNotice item={item} cancelled={!!autoCancelled} onCancel={onCancelWake} />;
      return (
        <div className={`chat-notice chat-notice-${item.tone}`} data-item-id={item.id}>
          {item.action === 'cancel-auto-continue' && autoCancelled ? t('chat.autoContinueCancelled') : item.text}
          {item.action === 'cancel-auto-continue' && !autoCancelled && onCancelAutoContinue && (
            <>
              {' '}
              <button type="button" className="link" onClick={onCancelAutoContinue}>
                {t('chat.cancelAutoContinue')}
              </button>
            </>
          )}
        </div>
      );
  }
}

/**
 * Aviso do despertador. Esperando, mostra "Volta a olhar em 10:32h (90s)" e a contagem desce sozinha, de segundo em
 * segundo (o intervalo sai quando o aviso deixa de esperar ou a tela fecha); o servidor só manda o instante (`wakeAt`).
 */
function WakeNotice({ item, cancelled, onCancel }: { item: Extract<ChatItem, { kind: 'notice' }>; cancelled: boolean; onCancel?: () => void }) {
  const waiting = item.wake === 'waiting' && !cancelled;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting, item.wakeAt]);
  const at = item.wakeAt ?? now;
  const text =
    cancelled || item.wake === 'cancelled'
      ? t('chat.wakeCancelled')
      : item.wake === 'waiting'
        ? t('chat.wakeWaiting', { time: clockHM(at), secs: secondsLeft(at, now) })
        : item.wake === 'sent'
          ? t('chat.wakeSent', { time: clockHM(at) })
          : item.text;
  return (
    <div className={`chat-notice chat-notice-${item.tone}`} data-item-id={item.id}>
      {text}
      {waiting && onCancel && (
        <>
          {' '}
          <button type="button" className="link" onClick={onCancel}>
            {t('chat.cancelAutoContinue')}
          </button>
        </>
      )}
    </div>
  );
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
  // Como o dono negou, só neste cartão: o servidor devolve "denied" para os dois casos.
  const [denied, setDenied] = useState<'changes' | 'reject' | null>(null);
  const requestId = item.id.replace(/^p:/, '');
  const approve = async () => {
    setBusy(true);
    await onAnswer(requestId, true, { executeAs });
    setBusy(false);
  };
  const changes = async () => {
    setBusy(true);
    setDenied('changes');
    // Vai ao agente: fica em português de propósito (é o prompt que ele lê, não a interface).
    await onAnswer(requestId, false, { message: 'O usuário quer mudanças no plano. Pergunte o que mudar e espere a resposta dele.' });
    setBusy(false);
    onChangesRequested();
  };
  const reject = async () => {
    setBusy(true);
    setDenied('reject');
    await onAnswer(requestId, false, { reject: true });
    setBusy(false);
  };
  const rejected = item.status === 'denied' && denied === 'reject';
  return (
    <div className={`permission permission-plan permission-${item.status}`} data-item-id={item.id}>
      <p className="permission-title">
        <b>{t('chat.planReady')}</b>{' '}
        <span className="muted small">
          {item.status === 'pending' ? t('chat.planPending') : item.status === 'allowed' ? t('chat.planApproved') : rejected ? t('chat.planRejectedShort') : t('chat.planReturned')}
        </span>
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
          <button className="btn-secondary is-danger" disabled={busy} onClick={() => void reject()} title={t('chat.rejectPlanHelp')}>
            {t('chat.rejectPlan')}
          </button>
          <span className="muted small">{t('chat.runsHow', { how: AUTONOMY_SHORT[executeAs] })}</span>
        </div>
      ) : (
        <p className="small muted">
          {item.status === 'allowed' ? t('chat.approvedRunning', { how: AUTONOMY_SHORT[executeAs] }) : rejected ? t('chat.planRejected') : t('chat.returnedForChanges')}
        </p>
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
  // O servidor ignora "sempre" na pergunta com opções (AskUserQuestion): o botão não aparece para ela.
  const canRemember = item.tool !== 'AskUserQuestion';
  return (
    <div className={`permission permission-${item.status}`} data-item-id={item.id}>
      <p className="permission-title">
        {t('chat.asksPermission')} <b>{item.tool}</b>
      </p>
      <p className="mono small">{item.summary}</p>
      {item.description && <p className="small">{item.description}</p>}
      <details>
        <summary className="small">{t('chat.details')}</summary>
        <ToolInput tool={item.tool} input={item.input} />
      </details>
      {item.status === 'pending' ? (
        <div className="actions">
          <button className="btn-primary" disabled={busy} onClick={() => void answer(true)}>
            {t('chat.approve')}
          </button>
          {canRemember && (
            <button className="btn-secondary" disabled={busy} onClick={() => void answer(true, 'session')} title={t('chat.alwaysHereHelp')}>
              {t('chat.alwaysHere')}
            </button>
          )}
          {canRemember && (
            <button className="btn-secondary" disabled={busy} onClick={() => void answer(true, 'project')} title={t('chat.alwaysProjectHelp')}>
              {t('chat.alwaysProject')}
            </button>
          )}
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
