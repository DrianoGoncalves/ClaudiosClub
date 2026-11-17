// Visualização de um .json no editor de arquivos: árvore recolhível. Todo valor entra como texto (nunca HTML, nunca link), e cada
// objeto/lista só desenha os filhos quando está aberto, em páginas: arquivo grande não cria milhares de elementos de uma vez.
import { useMemo, useState, type ReactElement } from 'react';
import { t } from '../i18n';
import { PreviewFrame } from './PreviewFrame';
import { PAGE, STRING_MAX, isContainer, opensAll, parseJson, type JsonContainer, type JsonValue } from './jsonView';

export function JsonPreview({ path, text, onSave }: { path: string; text: string; onSave: () => void }) {
  const parsed = useMemo(() => parseJson(text), [text]);
  const openAll = useMemo(() => parsed.ok && opensAll(parsed.value), [parsed]);
  return (
    <PreviewFrame path={path} onSave={onSave}>
      {parsed.ok ? (
        <ul className="json-tree">
          <JsonNode value={parsed.value} depth={0} openAll={openAll} />
        </ul>
      ) : parsed.empty ? (
        <p className="muted">{t('files.jsonEmpty')}</p>
      ) : (
        <div className="json-error" role="alert">
          <p className="json-error-title">
            {t('files.jsonInvalid')}
            {parsed.line !== null && parsed.column !== null && ` · ${t('files.jsonAt', { line: parsed.line, column: parsed.column })}`}
          </p>
          <p className="json-error-msg mono">{parsed.message}</p>
          <p className="muted small">{t('files.jsonInvalidHint')}</p>
        </div>
      )}
    </PreviewFrame>
  );
}

/** `name`: a chave (objeto) ou o índice (lista) deste valor; sem nome só na raiz. */
function JsonNode({ name, value, depth, openAll }: { name?: string | number; value: JsonValue; depth: number; openAll: boolean }) {
  return isContainer(value) ? <JsonBranch name={name} value={value} depth={depth} openAll={openAll} /> : <LeafRow name={name} value={value} />;
}

/** Linha sem filhos (valor simples, ou objeto/lista vazio): sem seta, mas alinhada com as que têm. */
function LeafRow({ name, value }: { name?: string | number; value: JsonValue }) {
  return (
    <li className="json-row">
      <span className="json-caret" aria-hidden="true" />
      <Label name={name} />
      <Leaf value={value} />
    </li>
  );
}

function Label({ name }: { name?: string | number }) {
  if (name === undefined) return null;
  return (
    <>
      {typeof name === 'number' ? <span className="json-index">{name}</span> : <span className="json-key">{JSON.stringify(name)}</span>}
      <span className="json-punct">: </span>
    </>
  );
}

function JsonBranch({ name, value, depth, openAll }: { name?: string | number; value: JsonContainer; depth: number; openAll: boolean }) {
  const [open, setOpen] = useState(openAll || depth === 0);
  const [shown, setShown] = useState(PAGE);
  const list = Array.isArray(value);
  const keys = useMemo(() => (list ? null : Object.keys(value)), [list, value]);
  const total = list ? value.length : keys!.length;
  const count = t(list ? (total === 1 ? 'files.jsonItemsOne' : 'files.jsonItemsOther') : total === 1 ? 'files.jsonKeysOne' : 'files.jsonKeysOther', { n: total });
  if (total === 0) return <LeafRow name={name} value={value} />;
  const visible = Math.min(shown, total);
  const children: ReactElement[] = [];
  if (open) {
    for (let i = 0; i < visible; i++) {
      const key = keys ? keys[i]! : i;
      children.push(<JsonNode key={key} name={key} value={(value as Record<string | number, JsonValue>)[key]!} depth={depth + 1} openAll={openAll} />);
    }
  }
  return (
    <li className="json-row">
      <button type="button" className="json-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="json-caret" aria-hidden="true" />
        <Label name={name} />
        <span className="json-punct">{list ? (open ? '[' : '[…]') : open ? '{' : '{…}'}</span>
        <span className="json-count">{count}</span>
      </button>
      {open && (
        <ul>
          {children}
          {visible < total && (
            <li className="json-row">
              <button type="button" className="btn-secondary json-more" onClick={() => setShown((s) => s * 2)}>
                {t('files.jsonMore', { n: total - visible })}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** Valor sem filhos. O texto sai pelo JSON.stringify: as aspas e os escapes ficam à vista (a cor não é a única pista do tipo). */
function Leaf({ value }: { value: JsonValue }) {
  const [full, setFull] = useState(false);
  if (typeof value === 'string') {
    const cut = !full && value.length > STRING_MAX;
    return (
      <>
        <span className="json-string">{JSON.stringify(cut ? value.slice(0, STRING_MAX) : value)}</span>
        {cut && (
          <button type="button" className="btn-secondary json-more" onClick={() => setFull(true)}>
            {t('files.jsonShowAll', { n: value.length - STRING_MAX })}
          </button>
        )}
      </>
    );
  }
  if (typeof value === 'number') return <span className="json-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="json-bool">{String(value)}</span>;
  if (value === null) return <span className="json-null">null</span>;
  return <span className="json-punct">{Array.isArray(value) ? '[]' : '{}'}</span>;
}
