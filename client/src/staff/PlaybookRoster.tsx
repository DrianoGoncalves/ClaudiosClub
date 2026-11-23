import { t } from '../i18n';
import type { RosterRow } from './agentRoles';

// Quem ajuda no roteiro da ficha: cada agent com o papel (implementa, mecânico, só lê, confere) e o modelo.
// O que falta no projeto é criado na hora em que a conversa abre (server/staff/playbookAgents.ts).

// `forRole`: no cargo (config da empresa) não há projeto, então não diz se o agent já existe: mostra o pronto e a nota própria.
export function PlaybookRoster({ rows, forRole = false }: { rows: RosterRow[]; forRole?: boolean }) {
  return (
    <div className="roster" role="group" aria-label={t('staff.rosterTitle')}>
      <p className="roster-title">{t('staff.rosterTitle')}</p>
      <ul>
        {rows.map((r) => (
          <li key={r.name}>
            <span className="roster-head">
              <b className="mono">{r.name}</b>
              <span className="badge">{r.brief}</span>
              {!forRole && <span className="muted small">{r.created ? t('staff.rosterCreated') : t('staff.rosterHave')}</span>}
            </span>
            {r.role && <span className="muted small">{r.role}</span>}
          </li>
        ))}
      </ul>
      <p className="muted small">{forRole ? t('staff.rosterRoleNote') : t('staff.rosterNote')}</p>
    </div>
  );
}
