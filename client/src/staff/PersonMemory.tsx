import { useState } from 'react';
import { api, isPairingError, type PersonMemory as Memory } from '../api';
import { t } from '../i18n';
import { MEMORY_MAX_BYTES, MEMORY_MAX_LINES, memoryUsage } from './memoryUsage';

// Memória pessoal: uma por pessoa, vale em todos os projetos dela (as outras fichas com o mesmo personId). Fica na
// aba Ficha, com gravação à parte da ficha. Só carrega quando se abre: ler garante o personId (um POST).

const NOTE = { fallback: 'mem.fallback', tampered: 'mem.tampered', unavailable: 'mem.unavailable' } as const;

export function PersonMemory({ projectId, staffId, name }: { projectId: string; staffId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Memory | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const { personId: id } = await api.personOf(projectId, staffId);
      const memory = await api.personMemory(id);
      setPersonId(id);
      setSaved(memory);
      setText(memory.text);
    } catch (err) {
      setOpen(false);
      if (!isPairingError(err)) setError((err as Error).message || t('mem.loadError'));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!personId) return;
    setBusy(true);
    setDone(false);
    setError(null);
    try {
      const memory = await api.savePersonMemory(personId, text);
      setSaved(memory);
      setText(memory.text);
      setDone(true);
    } catch (err) {
      if (!isPairingError(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const usage = memoryUsage(text);
  const note = saved && saved.status in NOTE ? NOTE[saved.status as keyof typeof NOTE] : null;
  // Arquivo mexido por fora: mesmo sem editar dá para gravar a versão mostrada como a nova.
  const unchanged = text === (saved?.text ?? '') && !note;
  // Dentro do <form> da ficha: o que se digita aqui não conta como ficha mexida (data-skip-dirty).
  return (
    <fieldset className="person-memory" data-skip-dirty>
      <legend>{t('mem.title')}</legend>
      <p className="muted small">{t('mem.hint', { name })}</p>
      {!open && (
        <p>
          <button type="button" className="btn-secondary" onClick={() => void load()}>
            {t('mem.edit')}
          </button>
        </p>
      )}
      {open && loading && <p className="muted small">{t('mem.loading')}</p>}
      {open && !loading && saved && (
        <>
          {note && (
            <p className="person-note" role="note">
              {t(note)}
            </p>
          )}
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDone(false);
            }}
            rows={6}
            aria-label={t('mem.label', { name })}
            aria-describedby={`mem-count-${staffId}`}
          />
          <p id={`mem-count-${staffId}`} className={`small ${usage.fits ? 'muted' : 'error'}`}>
            {t('mem.count', { lines: usage.lines, maxLines: MEMORY_MAX_LINES, bytes: usage.bytes, maxBytes: MEMORY_MAX_BYTES })}
            {!usage.fits && ` · ${t('mem.over')}`}
          </p>
          <div className="actions">
            <button type="button" className="btn-secondary" disabled={busy || unchanged || !usage.fits} onClick={() => void save()}>
              {busy ? t('mem.saving') : t('mem.save')}
            </button>
            <span className="muted small" role="status">
              {done ? t('mem.saved') : ''}
            </span>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </fieldset>
  );
}
