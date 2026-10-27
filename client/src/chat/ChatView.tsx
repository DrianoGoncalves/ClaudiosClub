import { useEffect, useRef, useState } from 'react';
import type { Autonomy, ChatItem, SendPriority } from '../../../shared/model';
import { api } from '../api';
import { ImageIcon } from '../icons';
import { shrinkImage } from '../lib/shrinkImage';
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
}

/** Conversa com o funcionário dentro do MyCo, sem terminal. */
export function ChatView({ projectId, sessionId, staffId, name, autonomy, disabled, onSessionStarted }: Props) {
  const chat = useChat(projectId, sessionId, staffId);
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

  const submit = async () => {
    const text = draft.trim();
    if ((!text && !images.length) || pending) return;
    const sent = images;
    setDraft('');
    setImages([]);
    // Não foi (erro, ou a trava de consumo recusada): o texto e as imagens voltam para a caixa.
    if (!(await chat.send(text, undefined, sent))) {
      setDraft((d) => d || text);
      setImages((cur) => (cur.length ? cur : sent));
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

      {(images.length > 0 || imageError) && (
        <div className="chat-images">
          {images.map((src, i) => (
            <span key={i} className="chat-image">
              <img src={src} alt={`Imagem ${i + 1}`} />
              <button type="button" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} title="Tirar esta imagem" aria-label="Tirar imagem">
                ×
              </button>
            </span>
          ))}
          {imageError && <span className="error small">{imageError}</span>}
        </div>
      )}

      <div className="chat-input">
        <textarea
          ref={input}
          value={draft}
          placeholder={blocked ? `Conversa indisponível: ${blocked}` : `Mensagem para ${name} (Enter envia, Shift+Enter quebra linha, Ctrl+V cola um print)`}
          disabled={!!blocked}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.some((f) => f.type.startsWith('image/'))) return;
            e.preventDefault();
            void addImages(files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="chat-actions">
          <label className="btn-secondary chat-attach" title="Anexar imagem (ou cole com Ctrl+V)">
            <ImageIcon />
            <span className="sr-only">Anexar imagem</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              disabled={!!blocked}
              onChange={(e) => {
                void addImages([...(e.target.files ?? [])]);
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
            disabled={(!draft.trim() && !images.length) || !!blocked || pending}
            title={pending ? 'Responda o pedido de permissão primeiro' : busy ? PRIORITY_HELP[whileBusy] : undefined}
          >
            {busy ? PRIORITY_BUTTON[whileBusy] : 'Enviar'}
          </button>
        </div>
      </div>

      <div className="chat-footer">
        <ContextMeter context={chat.context} />
        {chat.state?.running && chat.state.permissionMode && (
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

type Answer = (id: string, allow: boolean, opts?: { message?: string; executeAs?: Autonomy }) => Promise<void>;

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
          {item.text}
          {item.queued && <span className="msg-queued">{QUEUED_TEXT[item.queued]}</span>}
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
  const answer = async (allow: boolean) => {
    setBusy(true);
    await onAnswer(requestId, allow);
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
          <button className="btn-secondary" disabled={busy} onClick={() => void answer(false)}>
            Negar
          </button>
        </div>
      ) : (
        <p className="small muted">{item.status === 'allowed' ? 'Aprovado' : 'Negado'}</p>
      )}
    </div>
  );
}
