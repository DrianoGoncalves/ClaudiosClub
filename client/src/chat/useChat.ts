import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Autonomy,
  ChatAttachment,
  ChatCommand,
  ChatEvent,
  ChatItem,
  ChatSnapshot,
  ChatState,
  CodexEffort,
  ContextUsage,
  EngineOverride,
  SendPriority,
} from '../../../shared/model';
import { api, ApiError, withUsageConfirm, type PermissionOpts } from '../api';
import { t } from '../i18n';
import { applyLive, liveOnlyNotices, mergeItems } from './chatWindow';
import { afterSnapshot, planReconnect, streamNeed } from './reconnect';
import { announceSent } from './usageNotice';

// Estado de uma conversa: histórico do transcript + o que chega ao vivo pelo SSE.

export interface ChatView {
  sessionId: string | null;
  items: ChatItem[];
  state: ChatState | null;
  context: ContextUsage | null;
  elsewhere: ChatSnapshot['elsewhere'];
  /** A conversa roda no motor secundário da ficha (o principal estava no limite); null = no da ficha. */
  fallback: EngineOverride | null;
  loading: boolean;
  error: string | null;
  /** false = não foi enviada (erro ou trava de consumo recusada). */
  send: (text: string, priority?: SendPriority, images?: string[], files?: ChatAttachment[]) => Promise<boolean>;
  compact: () => Promise<void>;
  interrupt: () => Promise<void>;
  /**
   * `executeAs`: ao aprovar um plano, a autonomia com que ele executa; `message`: o que ele lê ao
   * negar; `reject`: recusar o plano de vez (sem `message`); `remember`: aprovar de vez, nesta
   * conversa ou no projeto; `answers`: as respostas de uma pergunta com opções.
   */
  answer: (requestId: string, allow: boolean, opts?: PermissionOpts) => Promise<void>;
  /** Modelo, esforço e autonomia desta conversa, na hora. */
  settings: (s: { model?: string; effort?: CodexEffort; autonomy?: Autonomy }) => Promise<void>;
  /** Comandos "/" da sessão (ou os últimos vistos no projeto, antes de abrir). */
  commands: ChatCommand[];
  /** Trazer: órfã, retoma aqui; aberta em outro lugar, cria uma cópia aqui (com o histórico) e troca para ela. A original segue lá. */
  recheck: () => Promise<void>;
  /** Assumir aqui: encerra a sessão aberta em outro lugar (que não está trabalhando) e retoma a conversa aqui. */
  takeOver: () => Promise<void>;
}

/** Sem processo ou sem conexão: o que estava "trabalhando" não fica preso assim na tela. */
const stopped = (s: ChatState | null): ChatState | null => (s ? { ...s, running: false, busy: false, compacting: false } : s);

export function useChat(projectId: string, initialSessionId: string | null, staffId: string | null, name: string): ChatView {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [history, setHistory] = useState<ChatItem[]>([]);
  const [live, setLive] = useState<ChatItem[]>([]);
  /** Suas mensagens que o Claudio’s Club guardou até ele terminar outra tarefa. */
  const [held, setHeld] = useState<ChatItem[]>([]);
  const [state, setState] = useState<ChatState | null>(null);
  const [baseContext, setBaseContext] = useState<ContextUsage | null>(null);
  const [elsewhere, setElsewhere] = useState<ChatSnapshot['elsewhere']>(null);
  const [fallback, setFallback] = useState<EngineOverride | null>(null);
  const [knownCommands, setKnownCommands] = useState<ChatCommand[]>([]);
  const [loading, setLoading] = useState(!!initialSessionId);
  const [error, setError] = useState<string | null>(null);
  /** Servidor fora do ar (erro `offline` numa chamada): o efeito de polling abaixo espera ele voltar. */
  const [offline, setOffline] = useState(false);
  /** A conexão com a conversa caiu e a tela está tentando de novo (ou esperando a rede voltar). */
  const [lost, setLost] = useState(false);
  const source = useRef<EventSource | null>(null);
  /** De que sessão é o stream aberto, e desde quando está aberto (null: ainda não respondeu). */
  const streamSid = useRef<string | null>(null);
  const openedAt = useRef<number | null>(null);
  /** Falhas seguidas ao reconectar (ver planReconnect): o tempo de espera cresce com elas. */
  const failures = useRef(0);
  /** Sobe a cada troca de sessão e na saída da tela: o que ainda estava a caminho (snapshot, timer) não vale mais. */
  const epoch = useRef(0);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.code === 'offline') setOffline(true);
    setError((e as Error).message);
  }, []);

  const apply = useCallback((e: ChatEvent) => {
    if (e.type === 'state') setState(e.state);
    else setLive((items) => applyLive(items, e));
  }, []);

  /** Relê o snapshot e reabre o stream (preenchido abaixo, depois de `load`): é o que se faz quando a conexão cai. */
  const resync = useRef<(sid: string) => void>(() => {});
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Sessão cuja reconexão espera o navegador voltar a ter rede (evento `online`). */
  const paused = useRef<string | null>(null);

  const cancelRetry = useCallback(() => {
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    paused.current = null;
  }, []);

  /** Fecha o stream e cancela o que está agendado ou a caminho: ao trocar de sessão e ao sair da tela. */
  const stop = useCallback(() => {
    epoch.current++;
    source.current?.close();
    source.current = null;
    streamSid.current = null;
    openedAt.current = null;
    cancelRetry();
  }, [cancelRetry]);

  /**
   * A conexão caiu, ou a leitura do snapshot falhou: agenda a releitura com espera crescente (1 s, 2, 4… até 30 s) ou, sem
   * rede, espera o `online`. Enquanto não volta, o "trabalhando" não fica preso na tela: aparece o aviso de conexão perdida.
   */
  const reconnect = useCallback(
    (sid: string, openedForMs: number | null) => {
      cancelRetry();
      const plan = planReconnect(failures.current, typeof navigator === 'undefined' || navigator.onLine !== false, openedForMs);
      failures.current = plan.failures;
      if (plan.lost) {
        setLost(true);
        setState(stopped);
      }
      if (plan.kind === 'wait-online') {
        paused.current = sid;
        return;
      }
      retry.current = setTimeout(() => {
        retry.current = null;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) paused.current = sid;
        else resync.current(sid);
      }, plan.delay);
    },
    [cancelRetry],
  );

  const openStream = useCallback(
    (sid: string, after: number) => {
      source.current?.close();
      cancelRetry();
      // `after`: o `seq` do snapshot que acabou de ser lido (os itens dele já estão em `live`, o stream continua dali). Não há
      // abertura do zero: sem snapshot a tela não sabe o que o processo já passou do limite de itens da memória do servidor.
      const es = new EventSource(`/api/chat/${sid}/stream?after=${after}`);
      streamSid.current = sid;
      openedAt.current = null;
      es.onopen = () => {
        if (source.current === es) openedAt.current = Date.now();
      };
      es.onmessage = (m) => apply(JSON.parse(m.data) as ChatEvent);
      es.onerror = () => {
        if (source.current !== es) return;
        // Sem processo (fechou por inatividade, ou o claude saiu), o servidor responde 404 e o navegador desiste.
        // Aí o "trabalhando" não fica preso na tela; a próxima mensagem abre o processo e o stream de novo.
        if (es.readyState === EventSource.CLOSED) {
          source.current = null;
          setState(stopped);
          return;
        }
        // A conexão caiu e o navegador reabriria sozinho com o mesmo `after`: as deltas já aplicadas viriam de novo (o texto
        // dobraria) e o que saiu do log enquanto isso se perderia. Fecha e relê o snapshot, que traz tudo no ponto certo.
        es.close();
        source.current = null;
        reconnect(sid, openedAt.current === null ? null : Date.now() - openedAt.current);
      };
      source.current = es;
    },
    [apply, cancelRetry, reconnect],
  );

  /** Lê o snapshot e, havendo processo, abre o stream depois dele. null: a tela já passou para outra sessão enquanto lia. */
  const load = useCallback(
    async (sid: string) => {
      const ep = epoch.current;
      const snap = await api.chat(projectId, sid);
      if (ep !== epoch.current) return null;
      setHistory(snap.history);
      setHeld(snap.held ?? []);
      setKnownCommands(snap.commands ?? []);
      setBaseContext(snap.context);
      setElsewhere(snap.elsewhere);
      setFallback(snap.fallback ?? null);
      const after = afterSnapshot(snap);
      if (after !== null && snap.live) {
        // Os itens do snapshot e o `seq` são da mesma foto do histórico: o stream abre depois dele, sem faltar nem repetir nada.
        setLive(snap.live.items);
        setState(snap.live.state);
        openStream(sid, after);
      }
      return snap;
    },
    [projectId, openStream],
  );

  /** Falha ao ler o snapshot: mostra o erro; fora do ar, quem espera é o efeito de `offline`; os demais tentam de novo com espera. */
  const loadFailed = useCallback(
    (sid: string, e: unknown) => {
      fail(e);
      if (!(e instanceof ApiError && e.code === 'offline')) reconnect(sid, null);
    },
    [fail, reconnect],
  );

  useEffect(() => {
    resync.current = (sid) => {
      load(sid)
        .then((snap) => {
          if (!snap) return;
          setLost(false);
          setError(null);
          if (snap.live) return;
          // O processo se foi: o transcript já tem tudo (o histórico veio inteiro), então o que sobrou ao vivo só repetiria.
          // Ficam só os avisos que existem apenas ao vivo (o erro com que terminou, uma negação): ver liveOnlyNotices.
          setLive((items) => liveOnlyNotices(items, snap.history));
          setState(stopped);
        })
        .catch((e) => loadFailed(sid, e));
    };
  }, [load, loadFailed]);

  // Sem rede, a reconexão espera aqui: quando o navegador avisa que voltou, relê já (sem esperar o tempo da vez).
  useEffect(() => {
    const onOnline = () => {
      const sid = paused.current;
      if (!sid) return;
      paused.current = null;
      resync.current(sid);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // Já trazida para cá antes: segue na cópia, com as mensagens que você mandou aqui, em vez da original.
  const loadFollowingCopy = useCallback(
    async (sid: string) => {
      const snap = await load(sid);
      if (!snap?.copy) return;
      setSessionId(snap.copy);
      await load(snap.copy);
    },
    [load],
  );

  useEffect(() => {
    setSessionId(initialSessionId);
    setHistory([]);
    setLive([]);
    setHeld([]);
    setState(null);
    setFallback(null);
    setError(null);
    setOffline(false);
    setLost(false);
    failures.current = 0;
    // O cleanup vale também para a tela que começou sem sessão (a primeira mensagem abre o stream): ao sair, nada fica agendado.
    if (!initialSessionId) {
      setLoading(false);
      return stop;
    }
    setLoading(true);
    loadFollowingCopy(initialSessionId)
      .catch(fail)
      .finally(() => setLoading(false));
    return stop;
  }, [initialSessionId, loadFollowingCopy, stop, fail]);

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

  // Servidor fora do ar: confere /api/health a cada 2 s; ao responder, relê a conversa (o load reabre o stream).
  useEffect(() => {
    if (!offline || !sessionId) return;
    const t = setInterval(async () => {
      const up = await fetch('/api/health').then((r) => r.ok, () => false);
      if (!up) return;
      clearInterval(t);
      setOffline(false);
      setError(null);
      void loadFollowingCopy(sessionId).catch((e) => loadFailed(sessionId, e));
    }, 2000);
    return () => clearInterval(t);
  }, [offline, sessionId, loadFollowingCopy, loadFailed]);

  // Sem stream aberto para esta sessão, passa pelo snapshot (que abre o stream depois do `seq` dele): abrir do zero só traria os
  // itens que o servidor ainda guarda, e o meio da conversa (que esta tela talvez nem tenha lido) ficaria faltando.
  const ensureStream = (sid: string) => {
    if (streamNeed(source.current?.readyState ?? null, streamSid.current, sid) === 'keep') return;
    cancelRetry();
    resync.current(sid);
  };

  const send = async (text: string, priority?: SendPriority, images: string[] = [], files: ChatAttachment[] = []) => {
    setError(null);
    try {
      const r = await withUsageConfirm((force) => api.chatSend(projectId, { sessionId, staffId, text, force, priority, images, files }));
      if (!r) return false;
      announceSent(projectId, name, r);
      // O servidor encerrou o órfão para mandar a mensagem: a conversa já está aqui.
      if (elsewhere?.orphan) setElsewhere(null);
      if (r.sessionId !== sessionId) {
        // Seguiu numa conversa nova (o assunto da anterior tinha fechado): a tela passa para ela.
        if (sessionId) {
          // Fecha o stream e cancela a reconexão agendada (ou a leitura a caminho): ela reabriria a sessão antiga por cima da nova.
          stop();
          setHistory([]);
          setLive([]);
          setHeld([]);
          setState(null);
          setLost(false);
        }
        setSessionId(r.sessionId);
      }
      if (r.held) {
        const item: ChatItem = { kind: 'user', id: `h:${Date.now()}`, text, at: new Date().toISOString(), held: r.held, ...(images.length && { images: images.length }) };
        setHeld((h) => [...h, item]);
        return true;
      }
      ensureStream(r.sessionId);
      return true;
    } catch (e) {
      fail(e);
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
      fail(e);
    }
  };

  const interrupt = async () => {
    if (sessionId) await api.chatInterrupt(sessionId).catch(() => {});
  };

  const answer = async (requestId: string, allow: boolean, opts?: PermissionOpts) => {
    if (sessionId) await api.chatPermission(sessionId, requestId, allow, opts).catch(fail);
  };

  const settings = async (s: { model?: string; effort?: CodexEffort; autonomy?: Autonomy }) => {
    setError(null);
    try {
      const r = await api.chatSettings(projectId, { sessionId, staffId, ...s });
      if (r.sessionId !== sessionId) setSessionId(r.sessionId);
      ensureStream(r.sessionId);
    } catch (e) {
      fail(e);
    }
  };

  /**
   * "Trazer". Processo órfão do Claudio’s Club: encerra e retoma aqui. Aberta de verdade em outro lugar:
   * cria uma cópia aqui, com o histórico, e troca para ela. A original segue lá, sem sincronizar.
   */
  const recheck = async () => {
    if (!sessionId) return;
    setError(null);
    try {
      if (elsewhere?.orphan) {
        await api.chatAdopt(sessionId);
        await load(sessionId);
      } else if (elsewhere) {
        const r = await api.chatBring(projectId, sessionId, staffId);
        setSessionId(r.sessionId);
        // Carrega já: a prop sessionId do pai pode demorar a acompanhar (aí o efeito de troca recarrega de novo).
        await load(r.sessionId);
      } else {
        await load(sessionId);
      }
    } catch (e) {
      fail(e);
    }
  };

  const takeOver = async () => {
    if (!sessionId) return;
    setError(null);
    try {
      await api.chatTakeOver(projectId, sessionId);
      await load(sessionId);
    } catch (e) {
      fail(e);
    }
  };

  return {
    sessionId,
    items: mergeItems(history, live, held),
    state,
    context: state?.context ?? baseContext,
    elsewhere,
    fallback,
    loading,
    error: error ?? state?.error ?? (lost ? t('chat.reconnecting') : null),
    send,
    compact,
    interrupt,
    answer,
    settings,
    commands: state?.commands?.length ? state.commands : knownCommands,
    recheck,
    takeOver,
  };
}
