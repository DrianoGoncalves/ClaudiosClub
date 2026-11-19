import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { createFolderPicker, PICK_IDLE, PICK_NOTE_TEXT, type FolderPicker, type PickView } from './folderPick';

/** O estado do "Procurar…". Vive no formulário (não no campo) para a janela aberta não se perder se a pessoa trocar de aba do formulário. */
export function useFolderPicker(onPath: (path: string) => void): FolderPick {
  const [view, setView] = useState<PickView>(PICK_IDLE);
  const picker = useRef<FolderPicker | null>(null);
  const fill = useRef(onPath);
  fill.current = onPath;

  useEffect(() => {
    const p = createFolderPicker({ call: api.pickFolder, onPath: (path) => fill.current(path), onView: setView });
    picker.current = p;
    return () => {
      p.dispose();
      picker.current = null;
    };
  }, []);

  return { view, run: () => void picker.current?.pick() };
}

export interface FolderPick {
  view: PickView;
  run: () => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  pick: FolderPick;
  /** A janela só abre no computador do servidor: sem ele (página por outro endereço) fica só o campo. */
  canPick: boolean;
}

/** "Caminho da pasta": o campo (sempre editável) e, ao lado, o botão que abre a janela de escolher pasta. */
export function FolderField({ value, onChange, pick, canPick }: Props) {
  const id = useId();
  const noteId = `${id}-note`;
  const { view } = pick;
  const note = canPick && view.note ? t(PICK_NOTE_TEXT[view.note]) : null;

  return (
    <div className="path-field">
      <label htmlFor={id}>{t('office.npPath')}</label>
      <div className="path-row">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={400}
          required
          autoFocus
          className="mono"
          placeholder={t('office.npPathPlaceholder')}
          aria-describedby={note ? noteId : undefined}
        />
        {canPick && (
          <button
            type="button"
            className="btn-secondary"
            onClick={pick.run}
            disabled={view.busy || view.unsupported}
            aria-busy={view.busy || undefined}
            title={t('office.npBrowseTitle')}
          >
            {view.busy ? t('office.npBrowseWorking') : t('office.npBrowse')}
          </button>
        )}
      </div>
      {note && (
        <p id={noteId} role="status" className={view.note === 'failed' ? 'error' : 'muted small'}>
          {note}
        </p>
      )}
    </div>
  );
}
