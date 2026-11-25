import { useState } from 'react';
import { activeProfile, PROFILE_IDS, PROFILES, profileChanges, profilePatch, type ProfileChange, type ProfileId, type ProfileValues } from '../../../shared/configProfiles';
import type { AppConfig } from '../../../shared/model';
import { api } from '../api';
import { locale, t, type MsgKey } from '../i18n';
import { askConfirm, showAlert } from '../lib/dialogStore';

// Perfil de uso (ver shared/configProfiles.ts): um botão por perfil, o ativo marcado (ou "Personalizado" quando nenhum bate). Antes de aplicar, a confirmação
// lista cada item que muda, de → para. Grava pelo mesmo `saveConfig` dos itens soltos.

const NAME: Record<ProfileId | 'custom', MsgKey> = {
  balanced: 'profile.balanced',
  economy: 'profile.economy',
  light: 'profile.light',
  quality: 'profile.quality',
  custom: 'profile.custom',
};
const DESC: Record<ProfileId | 'custom', MsgKey> = {
  balanced: 'profile.balancedDesc',
  economy: 'profile.economyDesc',
  light: 'profile.lightDesc',
  quality: 'profile.qualityDesc',
  custom: 'profile.customDesc',
};
/** O nome de cada item, o mesmo título que ele tem nas Configurações. */
const LABEL: Record<ProfileChange['key'], MsgKey> = {
  aiTitles: 'toolbar.aiTitlesTitle',
  optimizeQuota: 'toolbar.optimizeTitle',
  contextSwitch: 'office.ctxTitle',
  'usageStop.fiveHour': 'toolbar.stop5hTitle',
  'usageStop.sevenDay': 'toolbar.stop7dTitle',
  maxTurnTools: 'toolbar.turnToolsTitle',
  maxTurnMinutes: 'toolbar.turnMinutesTitle',
  resourceGate: 'toolbar.queueGateTitle',
  minFreeRamGb: 'toolbar.queueRamTitle',
  cpuGate: 'toolbar.queueCpuTitle',
  maxActiveChats: 'toolbar.queueChatsTitle',
};
const CTX: Record<string, MsgKey> = { auto: 'office.ctxAuto', suggest: 'office.ctxSuggest', off: 'office.ctxOff' };

const num = (n: number) => n.toLocaleString(locale());

/** O valor como a pessoa lê: ligado/desligado, %, GB, minutos, "sem teto". */
function shown(key: ProfileChange['key'], v: unknown): string {
  if (typeof v === 'boolean') return t(v ? 'ss.on' : 'ss.off');
  if (key === 'contextSwitch') return t(CTX[String(v)] ?? 'office.ctxSuggest');
  if (v === null || v === undefined) return t('profile.off');
  const n = Number(v);
  if (key === 'usageStop.fiveHour' || key === 'usageStop.sevenDay') return `${num(n)}%`;
  if (key === 'maxActiveChats') return n === 0 ? t('profile.noCap') : num(n);
  if (n === 0) return t('profile.off');
  if (key === 'minFreeRamGb') return `${num(n)} GB`;
  if (key === 'maxTurnMinutes') return `${num(n)} min`;
  return num(n);
}

/** Uma linha da confirmação: "Título: de → para". */
export const changeLine = (c: ProfileChange): string => `${t(LABEL[c.key])}: ${shown(c.key, c.from)} → ${shown(c.key, c.to)}`;

export function ProfilePicker({ values, onConfig }: { values: ProfileValues; onConfig: (c: AppConfig) => void }) {
  const [busy, setBusy] = useState(false);
  const current = activeProfile(values);
  const pick = async (id: ProfileId) => {
    const changes = profileChanges(values, PROFILES[id]);
    if (!changes.length) return void showAlert(t('profile.same', { name: t(NAME[id]) }));
    const list = changes.map((c) => `• ${changeLine(c)}`).join('\n');
    if (!(await askConfirm(t('profile.confirm', { name: t(NAME[id]), list }), t('profile.apply')))) return;
    setBusy(true);
    try {
      onConfig(await api.saveConfig(profilePatch(id)));
    } catch (err) {
      void showAlert(t('profile.failed', { error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="profile-picker">
      <div className="segmented profile-options" role="group" aria-label={t('profile.title')}>
        {PROFILE_IDS.map((id) => (
          <button key={id} type="button" className="btn-secondary btn-toggle" aria-pressed={current === id} disabled={busy} onClick={() => void pick(id)}>
            {t(NAME[id])}
          </button>
        ))}
      </div>
      {current && (
        <p className="muted small profile-desc">
          {current === 'custom' && <span className="badge">{t('profile.custom')}</span>} {t(DESC[current])}
        </p>
      )}
    </div>
  );
}
