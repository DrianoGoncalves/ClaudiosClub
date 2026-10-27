import { useEffect, useMemo, useRef, useState } from 'react';
import type { Autonomy, ChatAttachment, ChatItem, Effort, SendPriority, UiLevel } from '../../../shared/model';
import { api } from '../api';
import { ImageIcon } from '../icons';
import { shrinkImage } from '../lib/shrinkImage';
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
}

/** Conversa com o funcionário dentro do MyCo, sem terminal. */
export function ChatView({ projectId, sessionId, staffId, name, autonomy, disabled, onSessionStarted, level = 'advanced', fichaModel = null, fichaEffort = null }: Props) {
  const chat = useChat(projectId, sessionId, staffId);
  const todos = useMemo(() => todosFrom(chat.items), [chat.items]);
  useEffect(() => {
    if (chat.sessionId && chat.sessionId !== sessionId) onSessionStarted?.(chat.sessionId);
  }, [chat.sessionId, sessionId, onSessionStarted]);
  const [draft, setDraft] = useState('');
  const [showTools, setShowTools] = useState(() => readFlag(TOOLS_KEY));
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
    if (room <= 0) return setImageError(`No máximo ${MAX_IMAGES} imagens por mensagem.`);
    try {
      const shrunk = await Promise.all(valid.slice(0, room).map((f) => shrinkImage(f, CHAT_IMAGE_MAX)));
      setImages((prev) => [...prev, ...shrunk].slice(0, MAX_IMAGES));
      if (valid.length > room) setImageError(`No máximo ${MAX_IMAGES} imagens por mensagem.`);
    } catch {
      setImageError('Não foi possível ler a imagem.');
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
      if (bad.length) setImageError(`Não dá para anexar ${bad.map((f) => f.name).join(', ')}: só imagem, texto ou PDF.`);
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

  const blocked = disabled ?? (chat.elsewhere ? 'aberta em outro lugar' : null);

  return (
    <section className="chat">
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {chat.loading && <p className="muted small chat-empty">Carregando a conversa…</p>}
        {!chat.loading && visible.length === 0 && (
          <p className="muted small chat-empty">
            {sessionId ? 'Nenhuma mensagem nesta sessão ainda.' : `Comece a conversa: ${name} lê a ficha e a memória antes de responder.`}
          </p>
        )}
        {visible.map((item) => (
          <Item key={item.id} item={item} onAnswer={chat.answer} executeAs={executeAs} onChangesRequested={() => input.current?.focus()} />
        ))}
        {busy && !streaming && !pending && (
          <div className="chat-typing" aria-live="polite">
            {chat.state?.compacting ? 'compactando a conversa' : `${name} está trabalhando`}
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
                Ficou um processo desta conversa de antes do MyCo reiniciar
                {chat.elsewhere.status ? ` (${STATUS_TEXT[chat.elsewhere.status] ?? chat.elsewhere.status})` : ''}. Ninguém mais
                fala com ele.
              </p>
              <p className="muted small">
                Trazer encerra esse processo e retoma a conversa aqui.
                {chat.elsewhere.status === 'busy' ? ' Ele está no meio de um turno: o que estava fazendo para.' : ''}
              </p>
            </>
          ) : (
            <>
              <p>
                Esta sessão está aberta {chat.elsewhere.entrypoint === 'claude-desktop' ? 'no app do Claude' : 'num terminal'}
                {chat.elsewhere.status ? ` (${STATUS_TEXT[chat.elsewhere.status] ?? chat.elsewhere.status})` : ''}. Conversar daqui ao
                mesmo tempo criaria uma cópia da sessão.
              </p>
              <p className="muted small">
                {chat.elsewhere.entrypoint === 'claude-desktop'
                  ? 'Feche a sessão no app do Claude (arquive ou feche o app) e clique em trazer.'
                  : 'Feche a sessão lá (digite /exit ou feche a janela) e clique em trazer.'}
              </p>
            </>
          )}
          <button className="btn-primary" onClick={() => void chat.recheck()}>
            Trazer para o MyCo
          </button>
        </div>
      )}

      {chat.error && <p className="error small">{chat.error}</p>}

      <TodoPanel todos={todos} name={name} />

      {(images.length > 0 || files.length > 0 || imageError) && (
        <div className="chat-images">
          {images.map((src, i) => (
            <span key={i} className="chat-image">
              <img src={src} alt={`Imagem ${i + 1}`} />
              <button type="button" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} title="Tirar esta imagem" aria-label="Tirar imagem">
                ×
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <span key={`f${i}`} className="chat-file small">
              {f.name}
              <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} title="Tirar este arquivo" aria-label={`Tirar ${f.name}`}>
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
          placeholder={
            blocked
              ? `Conversa indisponível: ${blocked}`
              : `Mensagem para ${name} (Enter envia, Shift+Enter quebra linha, / comandos, @ arquivos, Ctrl+V cola um print)`
          }
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
          <label className="btn-secondary chat-attach" title="Anexar imagem, texto ou PDF (ou cole com Ctrl+V)">
            <ImageIcon />
            <span className="sr-only">Anexar arquivo</span>
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
            <button className="btn-secondary" onClick={() => void chat.interrupt()} title="Interrompe o turno atual">
              Parar
            </button>
          )}
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={(!draft.trim() && !images.length && !files.length) || !!blocked || pending}
            title={pending ? 'Responda o pedido de permissão primeiro' : busy ? PRIORITY_HELP[whileBusy] : undefined}
          >
            {busy ? PRIORITY_BUTTON[whileBusy] : 'Enviar'}
          </button>
        </div>
      </div>

      <div className="chat-footer">
        <ContextMeter context={chat.context} />
        {staffId && (
          <ChatSettingsBar
            level={level}
            state={chat.state}
            fichaModel={fichaModel}
            fichaEffort={fichaEffort}
            disabled={!!blocked}
            onChange={chat.settings}
          />
        )}
        {!staffId && chat.state?.running && chat.state.permissionMode && (
          <span className="muted small" title={`Modo de permissão em vigor nesta conversa (${chat.state.permissionMode})`}>
            {MODE_TEXT[chat.state.permissionMode] ?? chat.state.permissionMode}
          </span>
        )}
        {chat.state?.running && !!chat.state.background?.length && (
          <span className="muted small" title={chat.state.background.map((t) => t.label).join('\n')}>
            {chat.state.background.length} em segundo plano
          </span>
        )}
        <span className="chat-footer-actions">
          {/* Liga/desliga no padrão dos botões do DS (pressionado = ligado), ao lado de "Compactar". */}
          <button
            type="button"
            className="btn-secondary btn-toggle"
            aria-pressed={showTools}
            onClick={() => {
              setShowTools(!showTools);
              writeFlag(TOOLS_KEY, !showTools);
            }}
            title="Mostra as leituras, buscas e comandos que o funcionário fez"
          >
            Detalhar
          </button>
          <button
            className="btn-secondary"
            onClick={() => void chat.compact()}
            disabled={!chat.sessionId || busy || !!blocked}
            title="Resume o início da conversa para liberar contexto (/compact)"
          >
            {chat.state?.compacting ? 'Compactando…' : 'Compactar'}
          </button>
        </span>
      </div>
    </section>
  );
}

const TOOLS_KEY = 'myco.chat.showTools';

const STATUS_TEXT: Record<string, string> = { busy: 'trabalhando', idle: 'parada', waiting: 'esperando resposta' };

const PRIORITY_BUTTON: Record<SendPriority, string> = { next: 'Enviar', later: 'Pôr na fila', now: 'Enviar agora' };
const PRIORITY_HELP: Record<SendPriority, string> = {
  next: 'Entra no trabalho em andamento, entre uma ferramenta e outra, sem parar (muda no menu config)',
  later: 'Espera ele terminar e vira a próxima mensagem (muda no menu config)',
  now: 'Interrompe o que ele está fazendo e responde já (muda no menu config)',
};
const QUEUED_TEXT: Record<SendPriority, string> = { next: 'mandada durante o trabalho', later: 'na fila', now: 'interrompeu' };

/** Modo que o Claude Code reporta → o nome da autonomia na ficha. */
const MODE_TEXT: Record<string, string> = {
  default: 'pede aprovação',
  acceptEdits: 'edita sozinho',
  plan: 'só planeja',
  auto: 'automático',
  dontAsk: 'não pergunta (nega o que não está liberado)',
  bypassPermissions: 'sem nenhuma checagem',
};

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // sem armazenamento: vale só nesta aba
  }
}

function ContextMeter({ context }: { context: { used: number; window: number; percent: number } | null }) {
  if (!context) return <span className="muted small">contexto: —</span>;
  const level = context.percent >= 80 ? 'high' : context.percent >= 60 ? 'mid' : 'low';
  const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.0', '')}M` : `${Math.round(n / 1000)}k`);
  return (
    <span className={`meter meter-${level}`} title={`${context.used.toLocaleString('pt-BR')} de ${context.window.toLocaleString('pt-BR')} tokens`}>
      <span className="meter-label">contexto</span>
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${Math.min(100, context.percent)}%` }} />
      </span>
      <span className="meter-value">{context.percent}%</span>
      <span className="meter-reset">
        {k(context.used)}/{k(context.window)}
      </span>
    </span>
  );
}

type Answer = (id: string, allow: boolean, opts?: { message?: string; executeAs?: Autonomy; remember?: 'session' | 'project' }) => Promise<void>;

function Item({
  item,
  onAnswer,
  executeAs,
  onChangesRequested,
}: {
  item: ChatItem;
  onAnswer: Answer;
  executeAs: Autonomy;
  onChangesRequested: () => void;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg msg-user">
          {item.images ? (
            <span className="msg-images">
              <ImageIcon size={12} /> {item.images === 1 ? '1 imagem' : `${item.images} imagens`}
            </span>
          ) : null}
          {item.files?.length ? <span className="msg-images">anexos: {item.files.join(', ')}</span> : null}
          {item.text}
          {item.queued && <span className="msg-queued">{QUEUED_TEXT[item.queued]}</span>}
          {item.held && <span className="msg-queued">guardada pelo MyCo: {item.held}</span>}
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
            {item.result === null && <span className="muted small"> · rodando…</span>}
          </summary>
          {item.input && <pre className="tool-io">{item.input}</pre>}
          {item.result !== null && <pre className="tool-io">{item.result || '(sem saída)'}</pre>}
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
  plan: 'só planeja',
  manual: 'pedindo aprovação',
  acceptEdits: 'editando sozinho',
  auto: 'no automático',
  bypassPermissions: 'sem travas',
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
    await onAnswer(requestId, false, { message: 'O usuário quer mudanças no plano. Pergunte o que mudar e espere a resposta dele.' });
    setBusy(false);
    onChangesRequested();
  };
  return (
    <div className={`permission permission-plan permission-${item.status}`}>
      <p className="permission-title">
        <b>Plano pronto</b> <span className="muted small">{item.status === 'pending' ? 'para você aprovar' : item.status === 'allowed' ? 'aprovado' : 'devolvido'}</span>
      </p>
      <div className="plan-body">
        <Markdown text={plan} />
      </div>
      {item.status === 'pending' ? (
        <div className="actions">
          <button className="btn-primary" disabled={busy} onClick={() => void approve()} title={`Ele executa ${AUTONOMY_SHORT[executeAs]}`}>
            Aprovar e executar
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void changes()} title="Ele continua só planejando; escreva o que mudar">
            Pedir mudanças
          </button>
          <span className="muted small">executa {AUTONOMY_SHORT[executeAs]}</span>
        </div>
      ) : (
        <p className="small muted">{item.status === 'allowed' ? `Aprovado: executando ${AUTONOMY_SHORT[executeAs]}` : 'Devolvido para mudanças'}</p>
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
        Pede permissão: <b>{item.tool}</b>
      </p>
      <p className="mono small">{item.summary}</p>
      {item.description && <p className="small">{item.description}</p>}
      <details>
        <summary className="small">detalhes</summary>
        <pre className="tool-io">{item.input}</pre>
      </details>
      {item.status === 'pending' ? (
        <div className="actions">
          <button className="btn-primary" disabled={busy} onClick={() => void answer(true)}>
            Aprovar
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => void answer(true, 'session')}
            title="Aprova e não pergunta mais isso nesta conversa"
          >
            Sempre nesta conversa
          </button>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => void answer(true, 'project')}
            title="Aprova e libera de vez no projeto (fica em .claude/settings.local.json)"
          >
            Sempre neste projeto
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => void answer(false)}>
            Negar
          </button>
        </div>
      ) : (
        <p className="small muted">
          {item.status === 'allowed'
            ? item.remembered === 'session'
              ? 'Aprovado de vez nesta conversa'
              : item.remembered === 'project'
                ? 'Aprovado de vez neste projeto'
                : 'Aprovado'
            : 'Negado'}
        </p>
      )}
    </div>
  );
}
