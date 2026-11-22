import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommitWaitingSummary, InboxItem, InboxKind, TurnNotice } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';
import { pollVisible } from '../usePoll';
import { inboxText, inboxWho } from './inboxText';
import { isResolved } from './resolved';

// A caixa "precisa de mim": o que espera você em todas as salas, lida a cada poucos segundos.
// Com "avisar no sistema" ligado, cada item novo vira uma notificação do sistema (só o que é novo:
// o id de cada item é estável enquanto ele existir).

const NOTIFY_KEY = 'myco.notify';
const POLL_MS = 5000;
const POLL_HIDDEN_MS = 30_000;

const KIND_TITLE: Record<InboxKind, string> = {
  plan: t('inbox.titlePlan'),
  permission: t('inbox.titlePermission'),
  secret: t('inbox.titleSecret'),
  waiting: t('inbox.titleWaiting'),
  error: t('inbox.titleError'),
  routine: t('inbox.titleRoutine'),
  orphan: t('inbox.titleOrphan'),
  usage: t('inbox.titleUsage'),
  blocked: t('inbox.titleBlocked'),
  notStarted: t('inbox.titleNotStarted'),
  question: t('inbox.titleQuestion'),
  stuck: t('inbox.titleStuck'),
  followUp: t('inbox.titleFollowUp'),
  denied: t('inbox.titleDenied'),
};

export interface InboxView {
  items: InboxItem[];
  /** Notificações do sistema ligadas (e permitidas pelo navegador). */
  notify: boolean;
  /** null = o navegador não oferece notificações. */
  canNotify: boolean;
  setNotify: (on: boolean) => Promise<void>;
  /** Avisos de commit parcial que esperam outro card fechar: só ciência, não são item nem entram na contagem. Servidor sem a rota (ou erro): null. */
  commitWaiting?: CommitWaitingSummary | null;
  /** Tira um aviso que só informa: segredo ("já troquei"), rotina que não rodou ("ok, vi") ou erro ("ignorar"). */
  dismiss: (item: InboxItem, opts?: { notSecret?: boolean }) => Promise<void>;
  /** Relê a caixa agora (depois de uma ação sobre a tarefa de um item: liberar, cancelar, começar). */
  refresh: () => Promise<void>;
}

export function useInbox(onOpen: (item: InboxItem) => void): InboxView {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [commitWaiting, setCommitWaiting] = useState<CommitWaitingSummary | null>(null);
  const canNotify = typeof Notification !== 'undefined';
  const [notify, setNotifyState] = useState(() => canNotify && readFlag(NOTIFY_KEY) && Notification.permission === 'granted');
  const seen = useRef<Set<string> | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  /** Hora da última leitura dos turnos que terminaram (o servidor manda só os de depois). */
  const turnsSince = useRef(new Date().toISOString());
  const tickRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const [next, done, waiting] = await Promise.all([api.inbox().catch(() => null), api.turns(turnsSince.current).catch(() => null), api.commitWaiting().catch(() => null)]);
      if (stopped) return;
      setCommitWaiting((prev) => (JSON.stringify(prev) === JSON.stringify(waiting) ? prev : waiting));
      if (done?.length) {
        turnsSince.current = done.reduce((max, d) => (d.at > max ? d.at : max), turnsSince.current);
        // "Terminou" só incomoda quando você não está olhando para o Claudio’s Club.
        if (notifyRef.current && !watching()) for (const d of done) showDone(d, open.current, next ?? []);
      }
      if (!next) return;
      setItems((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      // Na primeira leitura nada é "novo": avisar de tudo ao abrir a página seria só barulho.
      if (seen.current && notifyRef.current) {
        for (const item of next) if (!seen.current.has(item.id) && !isResolved(item)) show(item, open.current);
      }
      seen.current = new Set(next.map((i) => i.id));
    };
    tickRef.current = tick;
    void tick();
    // Aba escondida: não para (avisos do sistema e contador do título dependem dele), só desacelera.
    const stop = pollVisible(() => void tick(), POLL_MS, POLL_HIDDEN_MS);
    return () => {
      stopped = true;
      stop();
    };
  }, []);

  const setNotify = useCallback(
    async (on: boolean) => {
      if (!canNotify) return;
      // Pedir a permissão só funciona a partir de um clique da pessoa.
      const ok = on && (Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted');
      setNotifyState(ok);
      writeFlag(NOTIFY_KEY, ok);
    },
    [canNotify],
  );

  /** Tira da caixa: rotina vista, segredo trocado (ou que não é segredo), pergunta vista sem responder, sessão esperando em outro lugar, erro ignorado. */
  const dismiss = useCallback(async (item: InboxItem, opts: { notSecret?: boolean } = {}) => {
    await dismissCall(item, opts).catch(() => {});
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }, []);

  const refresh = useCallback(() => tickRef.current(), []);

  return { items, commitWaiting, notify, canNotify, setNotify, dismiss, refresh };
}

/** A rota de dispensar de cada tipo de item (o erro, `error:`/`cap:`, e a ação barrada, `denied:`, vão pelo id inteiro; o segredo e a rotina, sem o prefixo). */
export function dismissCall(item: InboxItem, opts: { notSecret?: boolean } = {}): Promise<{ ok: boolean }> {
  const id = item.id.replace(/^(secret|routine):/, '');
  if (item.kind === 'waiting' && item.id.startsWith('question:')) return api.dismissQuestion(item.sessionId);
  if (item.id.startsWith('waiting:')) return api.dismissWaiting(item.sessionId);
  if (item.kind === 'routine') return api.dismissRoutineAlert(id);
  if (item.kind === 'error') return api.dismissError(item.id);
  if (item.kind === 'denied') return api.dismissDenied(item.id);
  return api.dismissSecret(id, opts.notSecret);
}

/** A pessoa está com o Claudio’s Club na frente (aba visível e janela com foco). */
function watching(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** `inbox`: os avisos de agora; se a conversa tem um (a pergunta em que o turno parou), o clique abre no mesmo ponto dele. */
function showDone(d: TurnNotice, onOpen: (item: InboxItem) => void, inbox: InboxItem[]) {
  try {
    const n = new Notification(t('inbox.doneTitle', { name: d.name }), {
      body: d.text ?? (d.projectName ? t('inbox.inProject', { project: d.projectName }) : t('inbox.turnEnded')),
      tag: `done:${d.id}`,
    });
    n.onclick = () => {
      window.focus();
      const target = inbox.find((i) => i.sessionId === d.sessionId && (i.itemId || i.quote));
      onOpen({
        id: d.id,
        kind: 'waiting',
        projectId: d.projectId,
        projectName: d.projectName,
        sessionId: d.sessionId,
        staffId: d.staffId,
        name: d.name,
        summary: '',
        at: d.at,
        ...(target && { itemId: target.itemId, quote: target.quote }),
      });
      n.close();
    };
  } catch {
    // sem permissão ou sem janela: o quadro já mostra que ele parou
  }
}

function show(item: InboxItem, onOpen: (item: InboxItem) => void) {
  try {
    const n = new Notification(`${inboxWho(item)} ${KIND_TITLE[item.kind]}`, { body: inboxText(item), tag: item.id });
    n.onclick = () => {
      window.focus();
      onOpen(item);
      n.close();
    };
  } catch {
    // o navegador recusou (sem permissão, sem janela): segue só com a caixa
  }
}

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
