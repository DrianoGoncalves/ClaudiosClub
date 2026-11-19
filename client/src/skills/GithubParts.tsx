import type { ReactNode } from 'react';
import type { GithubAlert, GithubDiffItem, GithubFile } from '../api';
import { t, type MsgKey } from '../i18n';
import { alertRows, formatSize, patchLines, shortSha } from './githubSkill';

// Peças de tela comuns à prévia de instalação e à verificação de atualização: alertas, lista de arquivos e diff.
// Texto do repositório (SKILL.md, caminhos, patch, mensagens) entra sempre como texto, nunca como HTML ou link.

/** O servidor marca termos com crase (`hooks`): um par com texto dentro vira <code>; crase solta (a sintaxe ```! do aviso) fica como veio. */
function withCode(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/).map((part, i) => (i % 2 === 1 ? <code key={i}>{part.slice(1, -1)}</code> : part));
}

export const LEVEL_LABEL: Record<GithubAlert['level'], MsgKey> = { danger: 'gh.levelDanger', warn: 'gh.levelWarn', info: 'gh.levelInfo' };

/** Os alertas, do mais grave ao menos; o nível vai escrito (não só em cor). Sem nenhum: diz que a leitura continua sendo sua. */
export function AlertList({ alerts }: { alerts: GithubAlert[] }) {
  return (
    <section className="gh-alerts" aria-label={t('gh.alertsTitle', { n: alerts.length })}>
      <h3>{t('gh.alertsTitle', { n: alerts.length })}</h3>
      {alerts.length === 0 ? (
        <p className="muted small">{t('gh.noAlerts')}</p>
      ) : (
        <ul className="plain">
          {alertRows(alerts).map((r, i) =>
            r.kind === 'one' ? (
              <li key={`${r.alert.code}:${r.alert.file ?? ''}:${i}`} className={`gh-alert is-${r.alert.level}`}>
                <strong className="gh-level">{t(LEVEL_LABEL[r.alert.level])}</strong>
                <span>{withCode(r.alert.message)}</span>
              </li>
            ) : (
              <li key={`group:${r.code}`} className={`gh-alert is-${r.level}`}>
                <strong className="gh-level">{t(LEVEL_LABEL[r.level])}</strong>
                <span>
                  {t(r.code === 'executable' ? 'gh.groupExecutable' : 'gh.groupBinary', { n: r.files.length })}
                  <span className="gh-group-files gh-scroll mono">{r.files.join(' · ')}</span>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** Todos os arquivos da pasta, com o tamanho; script e binário levam a etiqueta. */
export function FileList({ files, totalBytes }: { files: GithubFile[]; totalBytes: number }) {
  return (
    <section className="gh-files-box">
      <h3>{t('gh.filesTitle', { n: files.length, size: formatSize(totalBytes) })}</h3>
      <ul className="plain gh-files gh-scroll">
        {files.map((f) => (
          <li key={f.path}>
            <span className="mono">{f.path}</span>
            <span className="muted small">{formatSize(f.size)}</span>
            {f.executable && <span className="badge gh-flag">{t('gh.flagScript')}</span>}
            {f.binary && <span className="badge gh-flag">{t('gh.flagBinary')}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_LABEL: Record<GithubDiffItem['status'], MsgKey> = { added: 'gh.statusAdded', removed: 'gh.statusRemoved', changed: 'gh.statusChanged' };

/** O diff de um arquivo: texto em linhas (+ entra, − sai), binário só com tamanho, grande demais com aviso. */
function DiffBody({ item }: { item: GithubDiffItem }) {
  if (item.binary) {
    const size = (s?: { size: number }) => (s ? formatSize(s.size) : '—');
    return <p className="muted small">{t('gh.diffBinary', { before: size(item.before), after: size(item.after) })}</p>;
  }
  if (item.tooLarge || item.patch === null || item.patch === undefined) return <p className="muted small">{t('gh.diffTooLarge')}</p>;
  if (item.patch === '') return <p className="muted small">{t('gh.diffEmpty')}</p>;
  return (
    <pre className="gh-diff gh-scroll" tabIndex={0} aria-label={item.path}>
      {patchLines(item.patch).map((l, i) => (
        <span key={i} className={`gh-line is-${l.kind}`}>
          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : l.kind === 'ctx' ? '  ' : ''}
          {l.text}
        </span>
      ))}
    </pre>
  );
}

/** Todos os arquivos que mudam, um bloco cada. Poucos arquivos (ou o SKILL.md) abrem já; muitos ficam fechados. */
export function DiffList({ diff }: { diff: GithubDiffItem[] }) {
  if (diff.length === 0) return <p className="muted small">{t('gh.diffNone')}</p>;
  return (
    <div className="gh-diffs">
      {diff.map((d) => (
        <details key={d.path} open={d.path === 'SKILL.md' || diff.length <= 3}>
          <summary>
            <span className="mono">{d.path}</span>
            <span className={`badge gh-status is-${d.status}`}>{t(STATUS_LABEL[d.status])}</span>
          </summary>
          <DiffBody item={d} />
        </details>
      ))}
    </div>
  );
}

/** O commit curto, em fonte de código, para copiar e comparar. */
export const Sha = ({ sha }: { sha: string }) => <code className="gh-sha">{shortSha(sha)}</code>;
