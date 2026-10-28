import { PLAYBOOK_AGENTS } from '../../../shared/agentPresets';
import type { Autonomy, Playbook } from '../../../shared/model';
import { t } from '../i18n';

// Opções do questionário do funcionário. Os cargos (modelos de ficha) ficam em shared/roles.ts e
// nas configurações (config → Cargos), onde dá para editar os prontos e criar os seus.

/**
 * Roteiros de orquestração. Os passos em si vão para a ficha (server/staff/ficha.ts); aqui ficam
 * o nome, a explicação e os agents (shared/agentPresets.ts) que cada um usa.
 */
export const PLAYBOOK_OPTIONS: { value: Playbook; label: string; help: string; agents: string[] }[] = [
  {
    value: 'plan-big-execute-small',
    label: t('staff.playbookBigSmallLabel'),
    help: t('staff.playbookBigSmallHelp'),
    agents: PLAYBOOK_AGENTS['plan-big-execute-small'],
  },
  {
    value: 'scout-then-build',
    label: t('staff.playbookScoutLabel'),
    help: t('staff.playbookScoutHelp'),
    agents: PLAYBOOK_AGENTS['scout-then-build'],
  },
  {
    value: 'review-gate',
    label: t('staff.playbookReviewLabel'),
    help: t('staff.playbookReviewHelp'),
    agents: PLAYBOOK_AGENTS['review-gate'],
  },
];

export const AUTONOMY_OPTIONS: { value: Autonomy; label: string; help: string }[] = [
  { value: 'plan', label: t('staff.autonomyPlanLabel'), help: t('staff.autonomyPlanHelp') },
  { value: 'manual', label: t('staff.autonomyManualLabel'), help: t('staff.autonomyManualHelp') },
  { value: 'acceptEdits', label: t('staff.autonomyEditsLabel'), help: t('staff.autonomyEditsHelp') },
  {
    value: 'auto',
    label: t('staff.autonomyAutoLabel'),
    help: t('staff.autonomyAutoHelp'),
  },
  {
    value: 'bypassPermissions',
    label: t('staff.autonomyBypassLabel'),
    help: t('staff.autonomyBypassHelp'),
  },
];

export const MODEL_OPTIONS = [
  { value: '', label: t('staff.modelDefault') },
  { value: 'opus', label: t('staff.modelOpus') },
  { value: 'sonnet', label: t('staff.modelSonnet') },
  { value: 'haiku', label: t('staff.modelHaiku') },
  { value: 'fable', label: t('staff.modelFable') },
];

export const EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
