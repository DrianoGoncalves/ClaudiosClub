import { useRef, useState } from 'react';
import type { StaffProfile } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';

// Equipe em arquivo, na aba Equipe do projeto: exporta as fichas escolhidas (e as skills da biblioteca que usam) num JSON
// para baixar, e importa um JSON desses como fichas novas. O servidor confere tudo (tudo ou nada) e devolve avisos do que mudou.

/** O teto do arquivo no servidor (MAX_TEAM_BYTES em server/staff/teamExport.ts): acima disso nem vale enviar. */
export const MAX_TEAM_FILE_BYTES = 3 * 1024 * 1024;

/** `equipe-meu-projeto-2026-11-13.json`: sem acento nem caractere que o sistema de arquivos recusa. */
export function teamFileName(projectName: string, now: Date): string {
  const slug = projectName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `equipe-${slug || 'projeto'}-${now.toISOString().slice(0, 10)}.json`;
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** O que a importação fez: quantas fichas nasceram e os avisos (autonomia rebaixada, MCP descartado, skill que já existia…). */
export function ImportResult({ created, warnings }: { created: number; warnings: string[] }) {
  return (
    <div role="status" className="team-file-result">
      <p>{t(created === 1 ? 'detail.teamFileDoneOne' : 'detail.teamFileDoneOther', { n: created })}</p>
      {warnings.length > 0 && (
        <div className="person-note small">
          <b>{t('detail.teamFileWarnings', { n: warnings.length })}</b>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function TeamFile({
  projectId,
  projectName,
  staff,
  onImported,
}: {
  projectId: string;
  projectName: string;
  /** As fichas do projeto (as que o quadro mostra na equipe). */
  staff: StaffProfile[];
  /** Fichas novas entraram: o quadro relê. */
  onImported: () => void;
}) {
  // Quem foi desmarcado; ficha nova (depois de importar) já nasce marcada.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; warnings: string[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const picked = staff.filter((s) => !off.has(s.id));
  const toggle = (id: string, on: boolean) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });

  const exportTeam = async () => {
    setBusy('export');
    setError(null);
    setResult(null);
    try {
      download(teamFileName(projectName, new Date()), await api.exportTeam(projectId, picked.map((s) => s.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const importTeam = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setResult(null);
    if (file.size > MAX_TEAM_FILE_BYTES) return setError(t('detail.teamFileTooBig'));
    setBusy('import');
    try {
      let body: unknown;
      try {
        body = JSON.parse(await file.text());
      } catch {
        throw new Error(t('detail.teamFileNotJson'));
      }
      const out = await api.importTeam(projectId, body);
      if (!out) throw new Error(t('detail.teamFileNoProject'));
      setResult({ created: out.created.length, warnings: out.warnings });
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      // Escolher o mesmo arquivo de novo (depois de consertar algo) tem de disparar o change outra vez.
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section className="section team-file">
      <h3>{t('detail.teamFileTitle')}</h3>
      <p className="muted small">{t('detail.teamFileIntro')}</p>
      <p className="small">{t('detail.teamFileNot')}</p>
      {staff.length > 0 && (
        <details className="collapse">
          <summary>{t('detail.teamFilePick', { n: picked.length, total: staff.length })}</summary>
          <ul className="team-file-pick">
            {staff.map((s) => (
              <li key={s.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!off.has(s.id)}
                    onChange={(e) => toggle(s.id, e.target.checked)}
                  />
                  <span>
                    {s.name} <span className="muted small">{s.role}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="actions">
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== null || picked.length === 0}
          title={picked.length === 0 ? t('detail.teamFileNoStaff') : t('detail.teamFileExportTitle')}
          onClick={() => void exportTeam()}
        >
          {busy === 'export' ? t('detail.teamFileExporting') : t('detail.teamFileExport')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy !== null} title={t('detail.teamFileImportTitle')} onClick={() => input.current?.click()}>
          {busy === 'import' ? t('detail.teamFileImporting') : t('detail.teamFileImport')}
        </button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label={t('detail.teamFileImport')}
          onChange={(e) => void importTeam(e.target.files?.[0])}
        />
      </p>
      <p className="muted small">{t('detail.teamFileImportNote')}</p>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {result && <ImportResult created={result.created} warnings={result.warnings} />}
    </section>
  );
}
