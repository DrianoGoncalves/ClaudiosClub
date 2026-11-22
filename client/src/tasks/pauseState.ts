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

/** O title do selo: o título da faixa e a frase curta do que a pausa faz (na de versão, também quem ligou). */
export function pausedTip(pause: ProjectPause, now: number): string {
  if (isVersionPause(pause)) return `${pauseHeading(pause, now)}. ${versionBy(pause)}. ${t('tasks.versionPausedBody', { time: clockHM(Date.parse(pause.until)) })}`;
  return `${pausedHeading(pause, now)}. ${t('tasks.projectPausedShort')}`;
}

/** Prazos que a tela oferece para a pausa de versão (minutos); o padrão é o do servidor (30). O servidor aceita de 1 a 120. */
export const VERSION_PAUSE_OPTIONS = [15, 30, 60, 120] as const;
export const VERSION_PAUSE_DEFAULT = 30;

export const isVersionPause = (pause: ProjectPause | null | undefined): pause is ProjectPause & { mode: 'version'; until: string } => pause?.mode === 'version' && !!pause.until;

/** "45 min", "1 h", "1 h 05 min": o prazo ou o que falta, em minutos inteiros (arredonda para cima, nunca "0 min"). */
export function minutesLabel(minutes: number): string {
  const m = Math.max(1, Math.ceil(minutes));
  if (m < 60) return `${m} min`;
  const rest = m % 60;
  return rest ? `${Math.floor(m / 60)} h ${String(rest).padStart(2, '0')} min` : `${Math.floor(m / 60)} h`;
}

/** "faltam 24 min" da pausa de versão; "termina agora" quando o prazo já passou (o servidor a tira na próxima leitura); vazio se não é de versão. */
export function versionLeft(pause: ProjectPause | null | undefined, now: number): string {
  if (!isVersionPause(pause)) return '';
  const ms = Date.parse(pause.until) - now;
  if (!Number.isFinite(ms)) return '';
  return ms <= 0 ? t('tasks.versionPausedLeftNow') : t('tasks.versionPausedLeft', { left: minutesLabel(ms / 60_000) });
}

/** "Ligada por Fulano" (funcionário com a permissão) ou "Ligada por você" (o dono, pela tela). */
export function versionBy(pause: ProjectPause): string {
  return t('tasks.versionPausedBy', { who: pause.by?.name ?? t('tasks.versionPausedByOwner') });
}

/** O título do selo/da faixa: "Pausa de versão · faltam 24 min" (comum: "Projeto pausado desde …"). */
export function pauseHeading(pause: ProjectPause, now: number): string {
  return isVersionPause(pause) ? t('tasks.versionPausedHeading', { left: versionLeft(pause, now) }) : pausedHeading(pause, now);
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

/** O erro de ligar/encerrar a pausa de versão: o status decide a frase (403 não é a tela, 404 projeto sumiu, 409 já há outra pausa); vazio = pareamento. */
export function versionErrorText(e: unknown, starting: boolean): string {
  if (isPairingError(e)) return '';
  if (e instanceof ApiError) {
    if (e.status === 403) return t('tasks.versionPauseForbidden');
    if (e.status === 404) return t('tasks.projectPauseGone');
    if (e.status === 409) return t('tasks.versionPauseConflict');
    if (e.code === 'offline') return e.message;
  }
  return t(starting ? 'tasks.versionPauseFailed' : 'tasks.versionPauseEndFailed');
}

export interface PauseView {
  /** undefined = ainda lendo ou servidor sem as rotas (nada aparece); null = rodando. */
  pause: ProjectPause | null | undefined;
  busy: boolean;
  error: string | null;
}

const samePause = (a: ProjectPause | null | undefined, b: ProjectPause | null | undefined) =>
  a === b || (!!a && !!b && a.at === b.at && a.mode === b.mode && a.until === b.until && a.by?.staffId === b.by?.staffId);

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
  /** Uma gravação: marca ocupado, descarta leituras em voo, mostra o estado novo (undefined = desistiu: nada muda) ou o erro, e avisa `onChanged` se gravou. */
  const write = async (run: () => Promise<ProjectPause | null | undefined>): Promise<void> => {
    epoch++;
    show({ busy: true, error: null });
    let patch: Partial<PauseView> = {};
    let changed = false;
    try {
      const next = await run();
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
  };
  /** Erro da API de versão já no idioma da tela (mensagem vazia = pareamento). */
  const fail = (starting: boolean) => (e: unknown): never => {
    throw new Error(versionErrorText(e, starting));
  };
  const endVersion = async (): Promise<void> => {
    if (view.busy || !isVersionPause(view.pause)) return;
    return write(async () => (await api.endVersionPause(opts.projectId).catch(fail(false))).paused);
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
    /** Pausa ou retoma. Sem o estado lido, ou com uma gravação em curso, não faz nada (sem segundo clique no meio da gravação). Desistir na pergunta não muda nada. Na pausa de versão, encerra-a (`endVersion`). */
    async toggle(): Promise<void> {
      if (view.busy || view.pause === undefined) return;
      if (isVersionPause(view.pause)) return endVersion();
      return write(async () => changePause(opts.projectId, opts.name, view.pause !== null));
    },
    /** Liga a pausa de versão por `minutes`. Só com o projeto rodando (lido e sem pausa); sem pergunta: o prazo escolhido já é o pedido. */
    async startVersion(minutes: number): Promise<void> {
      if (view.busy || view.pause !== null) return;
      return write(async () => (await api.startVersionPause(opts.projectId, minutes).catch(fail(true))).paused);
    },
    /** Encerra a pausa de versão antes do prazo (a fila volta ao normal). */
    endVersion,
  };
}
