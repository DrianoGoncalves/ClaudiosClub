import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Autonomy,
  ChatAttachment,
  ChatCommand,
  ChatEvent,
  ChatItem,
  ChatSnapshot,
  ChatState,
  ContextUsage,
  Effort,
  SendPriority,
} from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { t } from '../i18n';

// Estado de uma conversa: histórico do transcript + o que chega ao vivo pelo SSE.

export interface ChatView {
  sessionId: string | null;
  items: ChatItem[];
  state: ChatState | null;
  context: ContextUsage | null;
  elsewhere: ChatSnapshot['elsewhere'];
  loading: boolean;
  error: string | null;
  /** false = não foi enviada (erro ou trava de consumo recusada). */
  send: (text: string, priority?: SendPriority, images?: string[], files?: ChatAttachment[]) => Promise<boolean>;
  compact: () => Promise<void>;
  interrupt: () => Promise<void>;
  /**
   * `executeAs`: ao aprovar um plano, a autonomia com que ele executa; `message`: o que ele lê ao
   * negar; `remember`: aprovar de vez, nesta conversa ou no projeto.
   */
  answer: (requestId: string, allow: boolean, opts?: { message?: string; executeAs?: Autonomy; remember?: 'session' | 'project' }) => Promise<void>;
  /** Modelo, esforço e autonomia desta conversa, na hora. */
  settings: (s: { model?: string; effort?: Effort; autonomy?: Autonomy }) => Promise<void>;
  /** Comandos "/" da sessão (ou os últimos vistos no projeto, antes de abrir). */
  commands: ChatCommand[];
  /** Confere de novo se a sessão ainda está aberta em outro lugar. */
  recheck: () => Promise<void>;
}

export function useChat(projectId: string, initialSessionId: string | null, staffId: string | null): ChatView {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [history, setHistory] = useState<ChatItem[]>([]);
  const [live, setLive] = useState<ChatItem[]>([]);
  /** Suas mensagens que o MyCo guardou até ele terminar outra tarefa. */
  const [held, setHeld] = useState<ChatItem[]>([]);
  const [state, setState] = useState<ChatState | null>(null);
  const [baseContext, setBaseContext] = useState<ContextUsage | null>(null);
  const [elsewhere, setElsewhere] = useState<ChatSnapshot['elsewhere']>(null);
  const [knownCommands, setKnownCommands] = useState<ChatCommand[]>([]);
  const [loading, setLoading] = useState(!!initialSessionId);
  const [error, setError] = useState<string | null>(null);
  const source = useRef<EventSource | null>(null);
  const seq = useRef(0);

  const apply = useCallback((e: ChatEvent) => {
    seq.current = Math.max(seq.current, e.seq);
    if (e.type === 'state') setState(e.state);
    else if (e.type === 'item') {
      setLive((items) => {
        const i = items.findIndex((x) => x.id === e.item.id);
        if (i === -1) return [...items, e.item];
        const next = items.slice();
        next[i] = e.item;
        return next;
      });
    } else if (e.type === 'delta') {
      setLive((items) =>
        items.map((x) => (x.id === e.id && x.kind === 'assistant' ? { ...x, text: x.text + e.text } : x)),
      );
    }
  }, []);

  const openStream = useCallback(
    (sid: string) => {
      source.current?.close();
      // Sempre do começo do processo: cada item chega primeiro como "criado" (o que zera o texto) e
      // depois as deltas, então repetir não duplica. E um processo novo recomeça a numeração.
      seq.current = 0;
      const es = new EventSource(`/api/chat/${sid}/stream?after=0`);
      es.onmessage = (m) => apply(JSON.parse(m.data) as ChatEvent);
      // Sem processo (fechou por inatividade, ou o claude saiu), o servidor responde 404 e o navegador desiste.
      // Aí o "trabalhando" não fica preso na tela; a próxima mensagem abre o processo e o stream de novo.
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED || source.current !== es) return;
        source.current = null;
        setState((s) => (s ? { ...s, running: false, busy: false, compacting: false } : s));
      };
      source.current = es;
    },
    [apply],
  );

  const load = useCallback(
    async (sid: string) => {
      const snap = await api.chat(projectId, sid);
      setHistory(snap.history);
      setHeld(snap.held ?? []);
      setKnownCommands(snap.commands ?? []);
      setBaseContext(snap.context);
      setElsewhere(snap.elsewhere);
      if (snap.live) {
        seq.current = 0;
        setLive([]);
        setState(snap.live.state);
        openStream(sid);
      }
      return snap;
    },
    [projectId, openStream],
  );

  useEffect(() => {
    setSessionId(initialSessionId);
    setHistory([]);
    setLive([]);
    setHeld([]);
    setState(null);
    setError(null);
    seq.current = 0;
    if (!initialSessionId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    load(initialSessionId)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      source.current?.close();
      source.current = null;
    };
  }, [initialSessionId, load]);

  // Com mensagem guardada, relê de tempos em tempos: quando ele fica livre, ela vai e a conversa
  // volta a andar (às vezes num processo novo, que o stream antigo não acompanha).
  const waiting = held.length > 0;
  useEffect(() => {
    if (!waiting || !sessionId) return;
    const t = setInterval(async () => {
      const snap = await api.chat(projectId, sessionId).catch(() => null);
      if (snap && !snap.held?.length) void load(sessionId).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [waiting, sessionId, projectId, load]);

  const ensureStream = (sid: string) => {
    if (!source.current || source.current.readyState === EventSource.CLOSED) openStream(sid);
  };

  const send = async (text: string, priority?: SendPriority, images: string[] = [], files: ChatAttachment[] = []) => {
    setError(null);
    try {
      const r = await withUsageConfirm((force) => api.chatSend(projectId, { sessionId, staffId, text, force, priority, images, files }));
      if (!r) return false;
      if (r.sessionId !== sessionId) setSessionId(r.sessionId);
      if (r.held) {
        const item: ChatItem = { kind: 'user', id: `h:${Date.now()}`, text, at: new Date().toISOString(), held: r.held, ...(images.length && { images: images.length }) };
        setHeld((h) => [...h, item]);
        return true;
      }
      ensureStream(r.sessionId);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const compact = async () => {
    if (!sessionId) return;
    setError(null);
    try {
      if (!(await withUsageConfirm((force) => api.chatCompact(projectId, sessionId, staffId, force)))) return;
      ensureStream(sessionId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const interrupt = async () => {
    if (sessionId) await api.chatInterrupt(sessionId).catch(() => {});
  };

  const answer = async (requestId: string, allow: boolean, opts?: { message?: string; executeAs?: Autonomy; remember?: 'session' | 'project' }) => {
    if (sessionId) await api.chatPermission(sessionId, requestId, allow, opts).catch((e: Error) => setError(e.message));
  };

  const settings = async (s: { model?: string; effort?: Effort; autonomy?: Autonomy }) => {
    setError(null);
    try {
      const r = await api.chatSettings(projectId, { sessionId, staffId, ...s });
      if (r.sessionId !== sessionId) setSessionId(r.sessionId);
      ensureStream(r.sessionId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Processo órfão do MyCo: encerra e retoma aqui. Aberta de verdade em outro lugar: diz que continua lá. */
  const recheck = async () => {
    if (!sessionId) return;
    setError(null);
    try {
      if (elsewhere?.orphan) await api.chatAdopt(sessionId);
      const snap = await load(sessionId);
      if (snap.elsewhere && !snap.elsewhere.orphan) {
        setError(
          t('chat.stillOpen', {
            where: t(snap.elsewhere.entrypoint === 'claude-desktop' ? 'chat.whereDesktop' : 'chat.whereElsewhere'),
            pid: snap.elsewhere.pid,
          }),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return {
    sessionId,
    items: [...history, ...live, ...held],
    state,
    context: state?.context ?? baseContext,
    elsewhere,
    loading,
    error: error ?? state?.error ?? null,
    send,
    compact,
    interrupt,
    answer,
    settings,
    commands: state?.commands?.length ? state.commands : knownCommands,
    recheck,
  };
}
