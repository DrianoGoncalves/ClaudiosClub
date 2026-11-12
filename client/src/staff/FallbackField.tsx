import { useId } from 'react';
import type { CodexEffort, Engine, ServerInfo } from '../../../shared/model';
import { effortLabel } from '../format';
import { t } from '../i18n';
import { codexBlockedByServers, useCodexCatalog } from './codexEngine';
import { engineName, fallbackEfforts, fallbackHelpKeys, keepFallbackEffort, otherEngine, type FallbackDraft } from './fallbackEngine';
import { MODEL_OPTIONS } from './templates';

/**
 * Motor secundário da ficha: o que a tarefa usa quando o principal bate o limite de uso. Opcional; o motor é sempre o outro (não
 * se escolhe), o modelo é texto com sugestões e o esforço vale só os do motor.
 */
export function FallbackField({
  main,
  servers,
  serverList,
  draft,
  onChange,
}: {
  /** O motor principal da ficha, como está no formulário. */
  main: Engine;
  /** Servidores marcados na ficha: com conexão FTP entre eles o Codex não pode ser o secundário (SSH pode). */
  servers: readonly string[];
  /** Conexões do projeto (para saber quais das marcadas são FTP); null = ainda carregando. */
  serverList: readonly Pick<ServerInfo, 'name' | 'source'>[] | null;
  draft: FallbackDraft;
  onChange: (next: FallbackDraft) => void;
}) {
  const engine = otherEngine(main);
  const listId = useId();
  const catalog = useCodexCatalog(draft.on && engine === 'codex');
  const blocked = engine === 'codex' && codexBlockedByServers(servers, serverList);
  const suggestions =
    engine === 'codex' ? (catalog?.models ?? []).map((m) => ({ value: m.slug, label: m.displayName })) : MODEL_OPTIONS.filter((m) => m.value);
  const efforts = fallbackEfforts(engine, draft.model, catalog?.models ?? null);
  const example = suggestions[0]?.value;
  return (
    <fieldset className="fallback-field">
      <legend>{t('staff.fallbackLabel')}</legend>
      <div className="templates">
        <button
          type="button"
          className="btn-secondary btn-toggle"
          aria-pressed={draft.on}
          disabled={blocked && !draft.on}
          onClick={() => onChange({ ...draft, on: !draft.on })}
        >
          {t('staff.fallbackToggle')}
        </button>
      </div>
      {blocked ? (
        <p className={draft.on ? 'badge warn' : 'muted small'} role="note">
          {t('staff.fallbackServers', { tools: t('detail.tabProject') })}
        </p>
      ) : (
        !draft.on && <p className="muted small">{t('staff.fallbackOff')}</p>
      )}
      {draft.on && (
        <>
          {fallbackHelpKeys(main).map((key) => (
            <p key={key} className="muted small">
              {t(key, { mode: t('staff.autonomyEditsLabel') })}
            </p>
          ))}
          <p className="small fallback-engine">
            <span className="muted">{t('staff.engineLabel')}</span> <b>{t(engineName(engine))}</b>
            <span className="muted"> · {t('staff.fallbackEngineHint')}</span>
          </p>
          <div className="grid2">
            <label>
              {t('staff.modelLabel')}
              <input
                value={draft.model}
                list={listId}
                maxLength={60}
                autoComplete="off"
                spellCheck={false}
                placeholder={example ? t('staff.fallbackModelExample', { example }) : undefined}
                aria-required="true"
                onChange={(e) => {
                  const model = e.target.value;
                  onChange({ ...draft, model, effort: keepFallbackEffort(draft.effort, fallbackEfforts(engine, model, catalog?.models ?? null)) });
                }}
              />
              <datalist id={listId}>
                {suggestions.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              {t('staff.effortLabel')}
              <select value={draft.effort} onChange={(e) => onChange({ ...draft, effort: e.target.value as '' | CodexEffort })}>
                <option value="">{t('staff.fallbackEffortDefault')}</option>
                {efforts.map((v) => (
                  <option key={v} value={v}>
                    {effortLabel(v)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
    </fieldset>
  );
}
