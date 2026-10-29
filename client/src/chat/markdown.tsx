import { type ReactNode, memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, ElementContent } from 'hast';
import { ImageIcon } from '../icons';
import { t } from '../i18n';

// Markdown das respostas da IA no padrão GFM (tabelas, listas aninhadas, tarefas, riscado, código),
// montado como elementos React pelo react-markdown: nada vira HTML cru. HTML escrito na resposta
// aparece como texto; links só http, https e mailto; imagens remotas viram link (não carregam).
// Markdown incompleto durante o streaming (bloco de código ou tabela abertos) segue o CommonMark:
// o bloco aberto vai até o fim do texto e fecha sozinho quando o resto chega.

/** Endereço permitido em link/imagem; qualquer outro vira '' e o link sai como texto. */
export function safeUrl(url: string): string {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : '';
}

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
      <pre className="md-code">{children}</pre>
    </div>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const url = safeUrl(href ?? '');
    return url ? (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="md-link-off">{children}</span>
    );
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
      <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS} urlTransform={safeUrl}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Texto do usuário que já vem em markdown (bloco de código, tabela, título): renderiza como tal. */
export const looksLikeMarkdown = (text: string): boolean =>
  /```|^\s*\|.*\|\s*$|^#{1,6}\s\S/m.test(text);
