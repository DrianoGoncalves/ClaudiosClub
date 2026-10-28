import { useState } from 'react';
import type { AppConfig, Company, ProjectColor } from '../../../shared/model';
import { api } from '../api';
import { BackgroundPicker, RoomColorPicker, useSystemTheme } from '../board/colors';
import { t } from '../i18n';

/** Configurações → Empresas: nome e cor de cada aba; remover deixa os projetos dela sem empresa. */
export function CompaniesEditor({
  companies,
  projectCompanies,
  onConfig,
}: {
  companies: Company[];
  projectCompanies: Record<string, string>;
  onConfig: (config: AppConfig) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const theme = useSystemTheme();
  const run = async (fn: () => Promise<AppConfig>) => {
    setError(null);
    try {
      onConfig(await fn());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const count = (id: string) => Object.values(projectCompanies).filter((c) => c === id).length;

  return (
    <div className="companies-editor">
      {!companies.length && <p className="muted small">{t('office.companyNone')}</p>}
      <ul className="room-colors">
        {companies.map((c) => (
          <li key={c.id}>
            <input
              className="company-rename"
              defaultValue={c.name}
              maxLength={40}
              aria-label={c.name}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== c.name) void run(() => api.saveCompany({ id: c.id, name: next, color: c.color }));
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <span className="muted small">{t('office.companyProjects', { n: count(c.id) })}</span>
            <RoomColorPicker
              small
              label={t('office.companyColor')}
              value={c.color}
              onChange={(color: ProjectColor | null) => run(() => api.saveCompany({ id: c.id, name: c.name, color }))}
            />
            <button
              type="button"
              className="link small"
              onClick={() => window.confirm(t('office.companyRemoveConfirm', { name: c.name })) && void run(() => api.removeCompany(c.id))}
            >
              {t('office.companyRemove')}
            </button>
            {/* Fundo do quadro na aba dela, no tema do sistema agora (o outro tema se escolhe ao trocar). */}
            <span className="company-bg">
              <span className="muted small">{t(theme === 'light' ? 'office.companyBgLight' : 'office.companyBgDark')}</span>
              <BackgroundPicker
                theme={theme}
                value={c.background[theme]}
                onChange={(hex) => run(() => api.saveCompany({ id: c.id, name: c.name, background: { [theme]: hex } }))}
              />
            </span>
          </li>
        ))}
      </ul>
      <form
        className="company-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(() => api.saveCompany({ name: name.trim(), color: null })).then(() => setName(''));
        }}
      >
        <input value={name} maxLength={40} placeholder={t('office.companyNamePlaceholder')} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn-secondary" disabled={!name.trim()}>
          {t('office.companyAdd')}
        </button>
      </form>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Configurações → Projeto demo: cria (uma vez) e abre a sala dele. */
export function DemoButton({ onOpen }: { onOpen: (projectId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api.createDemo();
            onOpen(r.projectId);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t('office.demoWorking') : t('office.demoCreate')}
      </button>
      {error && <p className="error small">{error}</p>}
    </>
  );
}
