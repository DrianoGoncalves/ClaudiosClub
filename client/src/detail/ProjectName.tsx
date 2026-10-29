import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

// Nome do projeto no cabeçalho: muda só o apelido exibido; a pasta (dica e caminho) continua a mesma.

export function ProjectName({
  name,
  folder,
  onRename,
}: {
  /** Nome exibido (o apelido, ou a pasta). */
  name: string;
  /** Nome da pasta: volta a ele quando o apelido some. */
  folder: string;
  onRename: (name: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft !== null) input.current?.select();
  }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => {
    setDraft(null);
    setError(null);
  };

  const run = async (next: string | null) => {
    try {
      await onRename(next);
      cancel();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = () => {
    if (draft === null) return;
    const value = draft.trim();
    if (value === name) return cancel();
    // Vazio ou igual à pasta: não há apelido, então o nome volta a ser o da pasta.
    return run(value === '' || value === folder ? null : value);
  };

  if (draft !== null) {
    return (
      <span className="project-name-edit">
        <input
          ref={input}
          className="project-name-input"
          value={draft}
          maxLength={60}
          placeholder={folder}
          aria-label={t('detail.projectNameLabel')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
        />
        {error && <span className="error project-name-error">{error}</span>}
      </span>
    );
  }

  return (
    <span className="project-name">
      <button className="project-name-btn" onClick={() => setDraft(name)} title={t('detail.projectNameTitle', { name: folder })}>
        {name}
      </button>
      {name !== folder && (
        <button className="link project-name-reset" onClick={() => void run(null)}>
          {t('detail.projectNameReset')}
        </button>
      )}
      {error && <span className="error project-name-error">{error}</span>}
    </span>
  );
}
