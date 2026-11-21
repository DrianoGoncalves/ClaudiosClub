import { useState } from 'react';
import { ApiError, FileApiError, filesApi, isPairingError } from '../api';
import { t } from '../i18n';
import { TerminalFilledIcon } from '../icons';

/** A frase do erro de abrir o terminal, pelo status/código (o texto do servidor vem em pt e não se traduz). Vazio = recusa de pareamento: o aviso do App já explica. */
export function openTerminalErrorText(e: unknown): string {
  if (isPairingError(e)) return '';
  if (e instanceof FileApiError) {
    if (e.code === 'no-display') return t('detail.terminalNoDisplay');
    if (e.code === 'no-terminal') return t('detail.terminalNoTerminal');
    if (e.code === 'folder-missing' || e.status === 404) return t('detail.terminalGone');
    if (e.status === 403) return t('detail.terminalForbidden');
  }
  if (e instanceof ApiError && e.code === 'offline') return e.message;
  return t('detail.terminalFailed');
}

/** Botão do painel do projeto: abre um terminal do computador na pasta do projeto. Só ícone (o painel é estreito); o nome fica no aria-label e no title. */
export function OpenTerminalButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = async () => {
    setBusy(true);
    setError('');
    try {
      await filesApi.openTerminal(projectId);
    } catch (e) {
      setError(openTerminalErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn-secondary btn-icon" disabled={busy} onClick={() => void open()} aria-label={t('detail.terminal')} title={t('detail.terminalTitle')}>
        <TerminalFilledIcon size={16} />
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
