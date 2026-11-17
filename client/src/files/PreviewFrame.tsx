// Moldura da visualização de um arquivo (Markdown, JSON): região rolável, com nome, que no lugar do CodeMirror ainda salva com Ctrl+S.
import type { ReactNode } from 'react';
import { t } from '../i18n';

export function PreviewFrame({ path, onSave, children }: { path: string; onSave: () => void; children: ReactNode }) {
  return (
    <div
      className="files-preview"
      tabIndex={0}
      role="region"
      aria-label={t('files.previewLabel', { path })}
      // Sem o CodeMirror em foco, o Ctrl+S abriria o "salvar página" do navegador.
      onKeyDown={(e) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
        e.preventDefault();
        onSave();
      }}
    >
      {children}
    </div>
  );
}
