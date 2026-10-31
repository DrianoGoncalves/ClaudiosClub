// Editor de código (CodeMirror 6). Só entra por import dinâmico (FilesBoard): fica fora do bundle inicial,
// e cada linguagem é outro pedaço, baixado quando o primeiro arquivo dela abre.
import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/** Linguagem pela extensão do arquivo; null = texto puro. */
async function languageFor(path: string): Promise<Extension | null> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: ext === 'jsx' });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'html':
    case 'htm':
      return (await import('@codemirror/lang-html')).html();
    case 'md':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'php':
      return (await import('@codemirror/lang-php')).php();
    case 'py':
      return (await import('@codemirror/lang-python')).python();
    default:
      return null;
  }
}

// Cores das canetas (tokens): valem nos dois temas sem um tema escuro à parte.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: 'var(--pen-purple)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--pen-green)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--pen-orange)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--pen-blue)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--pen-teal)' },
  { tag: [tags.tagName, tags.heading], color: 'var(--pen-red)', fontWeight: '600' },
  { tag: [tags.attributeName, tags.propertyName], color: 'var(--pen-yellow)' },
  { tag: [tags.link, tags.url], color: 'var(--ink-blue)', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'var(--card)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, Consolas, monospace', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ink-blue) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--ink-blue) 10%, transparent)', color: 'var(--ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--ink-blue) 28%, transparent) !important',
  },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--ink-green) 25%, transparent)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'var(--highlight)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)', borderColor: 'var(--line)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)' },
  '&.cm-focused': { outline: 'none' },
});

/**
 * Editor de um arquivo. O texto inicial só vale na montagem: para outro arquivo (ou recarregar do disco),
 * o pai troca a `key`. `onChange` recebe o texto inteiro a cada mudança; `onSave` = Ctrl/Cmd+S.
 */
export default function CodeEditor({
  path,
  initial,
  onChange,
  onSave,
  label,
}: {
  path: string;
  initial: string;
  onChange: (text: string) => void;
  onSave: () => void;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  // As funções mudam a cada render do pai; o editor chama sempre a mais nova.
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    const language = new Compartment();
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          keymap.of([
            indentWithTab,
            { key: 'Mod-s', preventDefault: true, run: () => (handlers.current.onSave(), true) },
          ]),
          language.of([]),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => u.docChanged && handlers.current.onChange(u.state.doc.toString())),
        ],
      }),
    });
    let alive = true;
    languageFor(path).then(
      (lang) => alive && lang && view.dispatch({ effects: language.reconfigure(lang) }),
      () => undefined, // sem destaque, o editor continua funcionando
    );
    return () => {
      alive = false;
      view.destroy();
    };
    // Montado uma vez por arquivo (o pai troca a key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="files-cm" ref={host} />;
}
