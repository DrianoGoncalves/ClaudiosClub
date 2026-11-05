import { type DragEvent, useEffect, useRef, useState } from 'react';
import type { ProjectAttachment } from '../../../shared/model';
import { attachmentsApi, isPairingError } from '../api';
import { locale, t } from '../i18n';
import { FileIcon } from '../icons';
import { DEFAULT_MAX_BYTES, formatBytes, pastedName, splitBySize } from './attachmentFiles';

/**
 * Anexos do projeto (prints, docs): enviar pelo botão, arrastando ou colando (Ctrl+V com a área em foco).
 * Miniatura só de raster (previewable); o resto é link de download, nunca aberto na página.
 */
export function Attachments({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectAttachment[] | null>(null);
  const [maxBytes, setMaxBytes] = useState(DEFAULT_MAX_BYTES);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const depth = useRef(0);

  const load = () =>
    attachmentsApi.list(projectId).then(
      (r) => {
        setItems(r.attachments);
        setMaxBytes(r.maxBytes);
      },
      (e: Error) => {
        setItems([]);
        setErrors([e.message]);
      },
    );

  useEffect(() => {
    setItems(null);
    setErrors([]);
    setNote(null);
    void load();
  }, [projectId]);

  const send = async (files: File[], named: (f: File) => string = (f) => f.name) => {
    if (!files.length || busy) return;
    const { ok, empty, tooBig } = splitBySize(files, maxBytes);
    const errs = [
      ...empty.map((f) => t('detail.attachEmpty', { name: named(f) })),
      ...tooBig.map((f) => t('detail.attachTooBig', { name: named(f), max: formatBytes(maxBytes, locale()) })),
    ];
    const renamed: string[] = [];
    setBusy(true);
    setNote(null);
    // Um por vez: o servidor numera nomes repetidos e a ordem fica a do envio.
    for (const f of ok) {
      try {
        const r = await attachmentsApi.upload(projectId, f, named(f));
        if (r.renamed) renamed.push(r.name);
      } catch (e) {
        // Recusa por pareamento: os próximos também seriam recusados, e o aviso do App explica.
        if (isPairingError(e)) break;
        errs.push(`${named(f)}: ${(e as Error).message}`);
      }
    }
    setErrors(errs);
    if (renamed.length) setNote(t('detail.attachRenamed', { names: renamed.join(', ') }));
    if (ok.length) await load();
    setBusy(false);
  };

  const remove = async (a: ProjectAttachment) => {
    if (!window.confirm(t('detail.attachDeleteConfirm', { name: a.name }))) return;
    setBusy(true);
    try {
      await attachmentsApi.remove(projectId, a.name);
      setErrors([]);
      await load();
    } catch (e) {
      if (!isPairingError(e)) setErrors([`${a.name}: ${(e as Error).message}`]);
    } finally {
      setBusy(false);
    }
  };

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  return (
    <section className="section">
      <h3>{t('detail.attachments')}</h3>
      <div
        className={`attach-drop${over ? ' is-over' : ''}`}
        tabIndex={0}
        aria-label={t('detail.attachDropLabel')}
        aria-busy={busy}
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          depth.current++;
          setOver(true);
        }}
        onDragOver={(e) => hasFiles(e) && e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setOver(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          void send([...e.dataTransfer.files]);
        }}
        onPaste={(e) => {
          const pasted = [...e.clipboardData.files];
          if (!pasted.length) return;
          e.preventDefault();
          const now = new Date();
          void send(pasted, (f) => pastedName(f.name, f.type, now));
        }}
      >
        <label className="btn-secondary file-btn">
          {busy ? t('detail.attachSending') : t('detail.attachAdd')}
          <input
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void send(files);
            }}
          />
        </label>
        <span className="muted small">{t('detail.attachHint', { max: formatBytes(maxBytes, locale()) })}</span>
      </div>
      {errors.map((m, i) => (
        <p key={i} className="error small" role="alert">
          {m}
        </p>
      ))}
      {note && <p className="muted small">{note}</p>}
      {items === null ? (
        <p className="muted small">{t('detail.attachLoading')}</p>
      ) : items.length === 0 ? (
        <p className="muted small">{t('detail.attachNone')}</p>
      ) : (
        <ul className="rows attach-list">
          {items.map((a) => {
            const url = attachmentsApi.fileUrl(projectId, a.name, a.mtimeMs);
            // Raster abre numa aba nova; o resto baixa (o servidor manda `attachment` e CSP sandbox).
            const link = a.previewable ? { target: '_blank', rel: 'noopener noreferrer' } : { download: a.name };
            return (
              <li key={a.name} className="row attach-row">
                <a className="attach-thumb" href={url} {...link} tabIndex={-1} aria-hidden="true">
                  {a.previewable ? <img src={url} alt="" loading="lazy" /> : <FileIcon size={18} />}
                </a>
                <span className="attach-text">
                  <a className="attach-name" href={url} {...link} title={a.previewable ? t('detail.attachOpen') : t('detail.attachDownload')}>
                    {a.name}
                  </a>
                  <span className="row-meta muted">
                    {formatBytes(a.size, locale())} · {new Date(a.mtimeMs).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => void remove(a)}
                  aria-label={t('detail.attachDeleteLabel', { name: a.name })}
                >
                  {t('detail.attachDelete')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
