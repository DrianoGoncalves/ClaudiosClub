import { type ReactNode, createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent } from 'hast';
import { ImageIcon } from '../icons';
import { t } from '../i18n';
import { looksLikeFilePath, projectRelativePath } from './filePath';

// Markdown das respostas da IA no padrão GFM (tabelas, listas aninhadas, tarefas, riscado, código),
// montado como elementos React pelo react-markdown: nada vira HTML cru. HTML escrito na resposta
// aparece como texto; links só http, https e mailto; imagens remotas viram link (não carregam).
// Com OpenFileContext (o chat), caminho de arquivo do projeto vira botão que abre no editor do Club.
// Markdown incompleto durante o streaming (bloco de código ou tabela abertos) segue o CommonMark:
// o bloco aberto vai até o fim do texto e fecha sozinho quando o resto chega.

/** Endereço permitido em link/imagem; qualquer outro vira '' e o link sai como texto. */
export function safeUrl(url: string): string {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : '';
}

/** Abrir um arquivo do projeto no editor (`relPath`, com "/"). Sem context, o caminho sai como texto. */
export interface OpenFileApi {
  projectRoot?: string;
  open: (relPath: string) => void;
}
export const OpenFileContext = createContext<OpenFileApi | null>(null);

/** Dentro de bloco de código ou de link: o código fica só `<code>` (sem botão de arquivo nem de copiar, nem botão dentro de link). */
const InCodeBlock = createContext(false);

/** urlTransform: caminho de arquivo passa até o componente `a` (que decide com o projeto); o resto segue `safeUrl`. */
const transformUrl = (url: string): string => safeUrl(url) || (looksLikeFilePath(url) ? url.trim() : '');

type MdNode = { type: string; children?: MdNode[] };

/** Plugin remark: HTML cru da resposta vira texto (mostra `<b>` em vez de interpretar). */
function htmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === 'html') node.type = 'text';
    node.children?.forEach(walk);
  };
  return walk;
}

const hastText = (n: ElementContent): string =>
  n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(hastText).join('') : '';

/** Copia para a área de transferência; `copied` fica true por 1,5s para o botão confirmar. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return [copied, copy];
}

function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  const code = node ? node.children.map(hastText).join('').replace(/\n$/, '') : '';
  const first = node?.children[0];
  const classes = first?.type === 'element' ? first.properties.className : undefined;
  const lang = Array.isArray(classes)
    ? classes.map(String).find((c) => c.startsWith('language-'))?.slice('language-'.length)
    : undefined;
  const [copied, doCopy] = useCopy();
  const copy = () => doCopy(code);
  return (
    <div className="md-code-wrap">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className="md-copy" title={t('chat.mdCopyHelp')} onClick={copy}>
          {copied ? t('chat.mdCopied') : t('chat.mdCopy')}
        </button>
      </div>
      <pre className="md-code">
        <InCodeBlock.Provider value={true}>{children}</InCodeBlock.Provider>
      </pre>
    </div>
  );
}

/** Código inline (fora de bloco) que não é caminho de arquivo: clicar copia o texto puro. */
function InlineCopy({ node, className, children }: { node?: Element; className?: string; children?: ReactNode }) {
  const text = typeof children === 'string' ? children : node ? hastText(node) : '';
  const [copied, doCopy] = useCopy();
  return (
    <>
      <button
        type="button"
        className={copied ? 'md-inline-copy is-copied' : 'md-inline-copy'}
        title={copied ? t('chat.mdCopied') : t('chat.mdInlineCopyHelp')}
        onClick={() => doCopy(text)}
      >
        <code className={className}>{children}</code>
      </button>
      <span className="sr-only" aria-live="polite">{copied ? t('chat.mdCopied') : ''}</span>
    </>
  );
}

/** Caminho do projeto clicável: botão (nunca `<a href>`), que abre no editor de arquivos. */
function FileButton({ api, path, className, children }: { api: OpenFileApi; path: string; className: string; children: ReactNode }) {
  return (
    <button type="button" className={className} title={t('chat.mdFileHelp')} onClick={() => api.open(path)}>
      {children}
    </button>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const api = useContext(OpenFileContext);
    const url = safeUrl(href ?? '');
    const rel = !url && api && href ? projectRelativePath(href, api.projectRoot) : null;
    const inner = <InCodeBlock.Provider value={true}>{children}</InCodeBlock.Provider>;
    if (url)
      return (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      );
    if (api && rel) return <FileButton api={api} path={rel} className="md-file">{inner}</FileButton>;
    return <span className="md-link-off">{children}</span>;
  },
  code: ({ node, className, children }) => {
    const api = useContext(OpenFileContext);
    const inBlock = useContext(InCodeBlock);
    const rel = api && !inBlock && typeof children === 'string' ? projectRelativePath(children, api.projectRoot) : null;
    if (api && rel) return <FileButton api={api} path={rel} className="md-file">{children}</FileButton>;
    if (inBlock) return <code className={className}>{children}</code>;
    return <InlineCopy node={node} className={className}>{children}</InlineCopy>;
  },
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? safeUrl(src) : '';
    const label = (
      <>
        <ImageIcon size={12} /> {alt || t('chat.mdImage')}
      </>
    );
    return url ? (
      <a className="md-img" href={url} target="_blank" rel="noopener noreferrer" title={t('chat.mdImageHelp')}>
        {label}
      </a>
    ) : (
      <span className="md-img">{label}</span>
    );
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  pre: CodeBlock,
};

const REMARK = [remarkGfm, htmlAsText];

// memo: no streaming só a última mensagem muda; as outras não são reprocessadas a cada pedaço.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS} urlTransform={transformUrl}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Texto do usuário que já vem em markdown (bloco de código, tabela, título): renderiza como tal. */
export const looksLikeMarkdown = (text: string): boolean =>
  /```|^\s*\|.*\|\s*$|^#{1,6}\s\S/m.test(text);
