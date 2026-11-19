import type { ProjectPause } from '../../../shared/model';
import { api, ApiError, isPairingError } from '../api';
import { clockHM } from '../chat/wakeCountdown';
import { locale, t } from '../i18n';
import { askConfirm } from '../lib/dialogStore';

// Projeto pausado (ver server/projectPause.ts): nada novo começa sozinho; o que já roda termina o turno e para. Aqui o que não depende da tela (os textos, o erro
// no idioma, o estado com as ações) e o único caminho que muda a pausa (confirma, grava), usado pelo quadro de tarefas, pelo cabeçalho da sala e pelo painel do projeto.

/** "desde hoje às 14:32" / "desde 17/11, 14:32"; vazio se não há pausa ou o horário não lê. */
export function pauseSince(pause: ProjectPause | null | undefined, now: number): string {
  const at = pause ? Date.parse(pause.at) : NaN;
  if (!Number.isFinite(at)) return '';
  const today = new Date(now).toDateString() === new Date(at).toDateString();
  const when = today
    ? t('tasks.projectPausedToday', { time: clockHM(at) })
    : new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return t('tasks.projectPausedSince', { when });
}

/** "Projeto pausado desde hoje às 14:32" (sem o horário, só "Projeto pausado"). */
export function pausedHeading(pause: ProjectPause, now: number): string {
  return [t('tasks.projectPausedBanner'), pauseSince(pause, now)].filter(Boolean).join(' ');
}

/** O title do selo: o título da faixa e a frase curta do que a pausa faz. */
export function pausedTip(pause: ProjectPause, now: number): string {
  return `${pausedHeading(pause, now)}. ${t('tasks.projectPausedShort')}`;
}

/**
 * O erro de pausar/retomar no idioma da tela. O texto que o servidor manda vem em pt-BR e não é traduzido, então só o status decide a frase: 403 (não é você, pelo
 * Club), 404 (o projeto sumiu), sem resposta (a frase de "servidor fora do ar" que a api já traduz) e o resto (disco, servidor sem a rota) numa frase genérica.
 * Vazio = recusa por pareamento: o aviso do App já explica, e repetir aqui seria ruído (como `alertError`).
 */
export function pauseErrorText(e: unknown, pausing: boolean): string {
  if (isPairingError(e)) return '';
  if (e instanceof ApiError) {
    if (e.status === 403) return t('tasks.projectPauseForbidden');
    if (e.status === 404) return t('tasks.projectPauseGone');
    if (e.code === 'offline') return e.message;
  }
  return t(pausing ? 'tasks.projectPauseFailed' : 'tasks.projectResumeFailed');
}

/**
 * Pausa o projeto, ou o retoma se `paused` (o estado de agora) for true. Pausar pergunta antes (o texto explica o que a pausa faz); retomar não: é voltar ao normal.
 * Devolve o estado novo (null = rodando) ou undefined se você desistiu na pergunta. A falha sobe como `Error` já no idioma da tela (`pauseErrorText`; mensagem vazia = pareamento).
 */
export async function changePause(projectId: string, name: string, paused: boolean): Promise<ProjectPause | null | undefined> {
  if (!paused && !(await askConfirm(t('tasks.projectPauseConfirm', { name })))) return undefined;
  try {
    return (await api.setProjectPause(projectId, !paused)).paused;
  } catch (e) {
    throw new Error(pauseErrorText(e, !paused));
  }
}

export interface PauseView {
  /** undefined = ainda lendo ou servidor sem as rotas (nada aparece); null = rodando. */
  pause: ProjectPause | null | undefined;
  busy: boolean;
  error: string | null;
}

const samePause = (a: ProjectPause | null | undefined, b: ProjectPause | null | undefined) => a === b || (!!a && !!b && a.at === b.at);

/**
 * O estado e as ações da pausa de um projeto, sem React (o hook `useProjectPause` só liga isto à tela, e é isto que os testes exercitam): `onView` recebe cada
 * estado novo; `onChanged` avisa quando uma gravação deu certo (o App relê o resumo das salas).
 */
export function createPauseController(opts: { projectId: string; name: string; initial?: ProjectPause | null; onView: (view: PauseView) => void; onChanged: () => void }) {
  let view: PauseView = { pause: opts.initial, busy: false, error: null };
  /** Sobe a cada gravação (no começo e no fim): a leitura que saiu antes dela e voltou depois traz o estado velho e é descartada. */
  let epoch = 0;
  const show = (patch: Partial<PauseView>) => {
    view = { ...view, ...patch };
    opts.onView(view);
  };
  return {
    get view(): PauseView {
      return view;
    },
    /** Lê a pausa do servidor. Falha (404 de servidor sem as rotas, rede fora) deixa como está: sem leitura o botão não aparece. Estado igual ao que já está: nada muda na tela. */
    async read(): Promise<void> {
      const mine = epoch;
      let next: ProjectPause | null;
      try {
        next = (await api.projectPause(opts.projectId)).paused;
      } catch {
        return;
      }
      if (mine !== epoch || samePause(view.pause, next)) return;
      show({ pause: next });
    },
    /** Pausa ou retoma. Sem o estado lido, ou com uma gravação em curso, não faz nada (sem segundo clique no meio da gravação). Desistir na pergunta não muda nada. */
    async toggle(): Promise<void> {
      if (view.busy || view.pause === undefined) return;
      epoch++;
      show({ busy: true, error: null });
      let patch: Partial<PauseView> = {};
      let changed = false;
      try {
        const next = await changePause(opts.projectId, opts.name, view.pause !== null);
        if (next !== undefined) {
          epoch++;
          patch = { pause: next };
          changed = true;
        }
      } catch (e) {
        patch = { error: (e as Error).message || null };
      }
      show({ busy: false, ...patch });
      if (changed) opts.onChanged();
    },
  };
}
