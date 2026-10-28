import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxItem, TurnNotice } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';

// A caixa "precisa de mim": o que espera você em todas as salas, lida a cada poucos segundos.
// Com "avisar no sistema" ligado, cada item novo vira uma notificação do sistema (só o que é novo:
// o id de cada item é estável enquanto ele existir).

const NOTIFY_KEY = 'myco.notify';
const POLL_MS = 5000;

const KIND_TITLE: Record<InboxItem['kind'], string> = {
  plan: t('inbox.titlePlan'),
  permission: t('inbox.titlePermission'),
  secret: t('inbox.titleSecret'),
  waiting: t('inbox.titleWaiting'),
  error: t('inbox.titleError'),
  routine: t('inbox.titleRoutine'),
  orphan: t('inbox.titleOrphan'),
};

export interface InboxView {
  items: InboxItem[];
  /** Notificações do sistema ligadas (e permitidas pelo navegador). */
  notify: boolean;
  /** null = o navegador não oferece notificações. */
  canNotify: boolean;
  setNotify: (on: boolean) => Promise<void>;
  /** Tira um aviso que só informa: segredo ("já troquei") ou rotina que não rodou ("ok, vi"). */
  dismiss: (item: InboxItem, opts?: { notSecret?: boolean }) => Promise<void>;
}

export function useInbox(onOpen: (item: InboxItem) => void): InboxView {
  const [items, setItems] = useState<InboxItem[]>([]);
  const canNotify = typeof Notification !== 'undefined';
  const [notify, setNotifyState] = useState(() => canNotify && readFlag(NOTIFY_KEY) && Notification.permission === 'granted');
  const seen = useRef<Set<string> | null>(null);
  const open = useRef(onOpen);
  open.current = onOpen;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  /** Hora da última leitura dos turnos que terminaram (o servidor manda só os de depois). */
  const turnsSince = useRef(new Date().toISOString());

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const [next, done] = await Promise.all([api.inbox().catch(() => null), api.turns(turnsSince.current).catch(() => null)]);
      if (stopped) return;
      if (done?.length) {
        turnsSince.current = done.reduce((max, d) => (d.at > max ? d.at : max), turnsSince.current);
        // "Terminou" só incomoda quando você não está olhando para o MyCo.
        if (notifyRef.current && !watching()) for (const d of done) showDone(d, open.current);
      }
      if (!next) return;
      setItems((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      // Na primeira leitura nada é "novo": avisar de tudo ao abrir a página seria só barulho.
      if (seen.current && notifyRef.current) {
        for (const item of next) if (!seen.current.has(item.id)) show(item, open.current);
      }
      seen.current = new Set(next.map((i) => i.id));
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
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

  /** Tira da caixa: rotina vista, segredo trocado (ou que não é segredo), pergunta vista sem responder. */
  const dismiss = useCallback(async (item: InboxItem, opts: { notSecret?: boolean } = {}) => {
    const id = item.id.replace(/^(secret|routine):/, '');
    const call = item.id.startsWith('question:')
      ? api.dismissQuestion(item.sessionId)
      : item.kind === 'routine'
        ? api.dismissRoutineAlert(id)
        : api.dismissSecret(id, opts.notSecret);
    await call.catch(() => {});
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }, []);

  return { items, notify, canNotify, setNotify, dismiss };
}

/** A pessoa está com o MyCo na frente (aba visível e janela com foco). */
function watching(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function showDone(d: TurnNotice, onOpen: (item: InboxItem) => void) {
  try {
    const n = new Notification(t('inbox.doneTitle', { name: d.name }), {
      body: d.text ?? (d.projectName ? t('inbox.inProject', { project: d.projectName }) : t('inbox.turnEnded')),
      tag: `done:${d.id}`,
    });
    n.onclick = () => {
      window.focus();
      onOpen({ id: d.id, kind: 'waiting', projectId: d.projectId, projectName: d.projectName, sessionId: d.sessionId, staffId: d.staffId, name: d.name, summary: '', at: d.at });
      n.close();
    };
  } catch {
    // sem permissão ou sem janela: o quadro já mostra que ele parou
  }
}

function show(item: InboxItem, onOpen: (item: InboxItem) => void) {
  try {
    const n = new Notification(`${item.name} ${KIND_TITLE[item.kind]}`, { body: item.summary, tag: item.id });
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
