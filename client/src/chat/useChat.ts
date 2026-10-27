import { useCallback, useEffect, useRef, useState } from 'react';
import type { Autonomy, ChatEvent, ChatItem, ChatSnapshot, ChatState, ContextUsage, SendPriority } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';

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
  send: (text: string, priority?: SendPriority, images?: string[]) => Promise<boolean>;
  compact: () => Promise<void>;
  interrupt: () => Promise<void>;
  /** `executeAs`: ao aprovar um plano, a autonomia com que ele executa; `message`: o que ele lê ao negar. */
  answer: (requestId: string, allow: boolean, opts?: { message?: string; executeAs?: Autonomy }) => Promise<void>;
  /** Confere de novo se a sessão ainda está aberta em outro lugar. */
  recheck: () => Promise<void>;
}

export function useChat(projectId: string, initialSessionId: string | null, staffId: string | null): ChatView {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [history, setHistory] = useState<ChatItem[]>([]);
  const [live, setLive] = useState<ChatItem[]>([]);
  const [state, setState] = useState<ChatState | null>(null);
  const [baseContext, setBaseContext] = useState<ContextUsage | null>(null);
  const [elsewhere, setElsewhere] = useState<ChatSnapshot['elsewhere']>(null);
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

  const ensureStream = (sid: string) => {
    if (!source.current || source.current.readyState === EventSource.CLOSED) openStream(sid);
  };

  const send = async (text: string, priority?: SendPriority, images: string[] = []) => {
    setError(null);
    try {
      const r = await withUsageConfirm((force) => api.chatSend(projectId, { sessionId, staffId, text, force, priority, images }));
      if (!r) return false;
      if (r.sessionId !== sessionId) setSessionId(r.sessionId);
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

  const answer = async (requestId: string, allow: boolean, opts?: { message?: string; executeAs?: Autonomy }) => {
    if (sessionId) await api.chatPermission(sessionId, requestId, allow, opts).catch((e: Error) => setError(e.message));
  };

  /** Processo órfão do MyCo: encerra e retoma aqui. Aberta de verdade em outro lugar: diz que continua lá. */
  const recheck = async () => {
    if (!sessionId) return;
    setError(null);
    try {
      if (elsewhere?.orphan) await api.chatAdopt(sessionId);
      const snap = await load(sessionId);
      if (snap.elsewhere && !snap.elsewhere.orphan) {
        setError(`Ainda está aberta ${snap.elsewhere.entrypoint === 'claude-desktop' ? 'no app do Claude' : 'em outro lugar'} (processo ${snap.elsewhere.pid}). Feche lá e tente de novo.`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return {
    sessionId,
    items: [...history, ...live],
    state,
    context: state?.context ?? baseContext,
    elsewhere,
    loading,
    error: error ?? state?.error ?? null,
    send,
    compact,
    interrupt,
    answer,
    recheck,
  };
}
