import { useState, type ReactNode } from 'react';
import { ActionBar, type BarAction, type MenuItem } from '../lib/ActionBar';
import { askConfirm } from '../lib/dialogStore';
import { t } from '../i18n';
import { ClockIcon, FolderIcon, PauseIcon, TasksIcon, UserPlusIcon } from '../icons';

// As barras de ações dos painéis do funcionário e do projeto: o ActionBar com a primária certa por estado (a regra de hierarquia é dele).
// Só muda onde ficam e qual é a principal; quando cada ação aparece é a regra de sempre.

export interface BarPlan {
  primary: BarAction | null;
  secondary: MenuItem[];
  more: MenuItem[];
}

/** Arquivar ⇄ desarquivar, com o estado de envio e o erro (o ActionBar só desenha). `confirm`: pergunta antes de arquivar e pinta de vermelho (desarquivar não pergunta). */
export function useArchiveAction(o: { archived: boolean; onArchive: (v: boolean) => Promise<void>; what: string; label: string; restoreLabel: string; confirm: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const click = async () => {
    if (o.confirm && !o.archived && !(await askConfirm(t('detail.archiveConfirm', { what: o.what })))) return;
    setBusy(true);
    setError(null);
    try {
      await o.onArchive(!o.archived);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const action: BarAction = {
    id: 'archive',
    label: o.archived ? o.restoreLabel : o.label,
    title: o.archived ? t('detail.showOnBoard', { what: o.what }) : t('detail.hideFromBoard', { what: o.what }),
    danger: o.confirm && !o.archived,
    busy,
    onClick: () => void click(),
  };
  return { action, error };
}

export interface ProjectBarState {
  /** A pasta do projeto existe: sem ela só dá para arquivar. */
  exists: boolean;
  archived: boolean;
  paused: boolean;
  onHire: () => void;
  onTasks?: (() => void) | undefined;
  onSchedules?: (() => void) | undefined;
  onFiles?: (() => void) | undefined;
  onTogglePause?: (() => void) | undefined;
  /** O botão de abrir o terminal (tem estado e erro próprios). */
  terminal?: ReactNode;
  archive: BarAction;
}

/**
 * Painel do projeto. Primária por estado: arquivado → Desarquivar (única saída); pausado → Retomar (é o que o dono quer quando vê a faixa);
 * senão Contratar funcionário (a próxima ação natural). Arquivar fica no "⋯", em vermelho e com confirmação.
 */
export function projectBarPlan(s: ProjectBarState): BarPlan {
  const hire = (iconOnly: boolean): BarAction => ({ id: 'hire', label: t('detail.hireEmployee'), icon: <UserPlusIcon />, iconOnly, onClick: s.onHire });
  const nav = (id: string, label: string, title: string, icon: ReactNode, onClick?: () => void): MenuItem[] =>
    onClick ? [{ id, label, title, icon, iconOnly: true, onClick }] : [];
  const places: MenuItem[] = [
    ...nav('tasks', t('detail.tasks'), t('detail.boardTasksTitle'), <TasksIcon size={16} />, s.onTasks),
    ...nav('schedules', t('schedules.open'), t('schedules.openTitle'), <ClockIcon size={16} />, s.onSchedules),
    ...nav('files', t('files.open'), t('files.openTitle'), <FolderIcon size={16} />, s.onFiles),
    ...(s.terminal ? [{ id: 'terminal', node: s.terminal }] : []),
  ];
  if (s.archived) return { primary: { ...s.archive, danger: false, label: t('detail.unarchiveProject') }, secondary: s.exists ? places : [], more: [] };
  const archive: MenuItem = { ...s.archive, label: t('detail.archiveProject') };
  if (!s.exists) return { primary: null, secondary: [], more: [archive] };
  if (s.paused && s.onTogglePause) {
    return {
      primary: { id: 'resume', label: t('tasks.projectResumeBtn'), title: t('tasks.projectResumeTitle'), onClick: s.onTogglePause },
      secondary: [hire(true), ...places],
      more: [archive],
    };
  }
  const pause: MenuItem[] = s.onTogglePause
    ? [{ id: 'pause', label: t('tasks.projectPauseBtn'), title: t('tasks.projectPauseTitle'), icon: <PauseIcon size={16} />, iconOnly: true, onClick: s.onTogglePause }]
    : [];
  return { primary: hire(false), secondary: [...places, ...pause], more: [archive] };
}

export interface EmployeeBarState {
  hasSheet: boolean;
  archived: boolean;
  temporary: boolean;
  canHire: boolean;
  onHireSub: () => void;
  archive: BarAction;
}

/**
 * Aba Ações do funcionário. Primária só quando há o que destrava: funcionário arquivado (com ficha) volta ao quadro. Fora disso a ação
 * principal do painel é a conversa, e aqui Contratar subordinado é secundária e Arquivar fica no "⋯" (vermelho, com confirmação).
 * O temporário arquivado tem Restaurar/Efetivar no aviso dele, então aqui o restaurar é secundário.
 */
export function employeeBarPlan(s: EmployeeBarState): BarPlan {
  const hireSub: MenuItem[] = s.canHire ? [{ id: 'hire-sub', label: t('detail.hireSub'), onClick: s.onHireSub }] : [];
  if (s.archived) {
    const restore: BarAction = { ...s.archive, danger: false, label: s.temporary ? t('detail.restoreEmployee') : t('detail.unarchiveEmployee') };
    return s.hasSheet && !s.temporary ? { primary: restore, secondary: hireSub, more: [] } : { primary: null, secondary: [...hireSub, restore], more: [] };
  }
  return { primary: null, secondary: hireSub, more: [{ ...s.archive, label: t('detail.archiveEmployee') }] };
}

/** O rodapé que gruda embaixo do painel (o mesmo vidro do rodapé da tarefa), com o erro da ação de baixo. */
export function PanelFoot({ children, error }: { children: ReactNode; error?: string | null | undefined }) {
  return (
    <footer className="panel-foot">
      {children}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </footer>
  );
}

export function PlanBar({ plan, error }: { plan: BarPlan; error?: string | null | undefined }) {
  return (
    <PanelFoot error={error}>
      <ActionBar label={t('detail.tabActions')} moreLabel={t('chat.moreOptions')} primary={plan.primary} secondary={plan.secondary} more={plan.more} />
    </PanelFoot>
  );
}
