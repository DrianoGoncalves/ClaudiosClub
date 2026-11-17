// Visualização de um .md no editor de arquivos: o mesmo renderizador do chat (HTML cru vira texto, links só http/https/mailto,
// imagem remota não carrega). Link para outro arquivo do projeto parte da pasta do próprio .md e abre no editor.
import { Markdown, OpenFileContext } from '../chat/markdown';
import { parentOf } from './newEntry';
import { PreviewFrame } from './PreviewFrame';

export function MarkdownPreview({
  path,
  text,
  onOpen,
  onSave,
}: {
  path: string;
  text: string;
  onOpen: (relPath: string) => void;
  onSave: () => void;
}) {
  return (
    <PreviewFrame path={path} onSave={onSave}>
      <OpenFileContext.Provider value={{ baseDir: parentOf(path), open: onOpen }}>
        <Markdown text={text} />
      </OpenFileContext.Provider>
    </PreviewFrame>
  );
}
