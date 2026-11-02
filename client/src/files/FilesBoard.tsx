// Arquivos do projeto: árvore à esquerda (cada pasta é lida ao abrir), editor à direita que salva só pelo botão "Salvar" (ou Ctrl+S).
// No celular, uma coisa por vez: a árvore, e ao abrir um arquivo o editor ocupa a tela (volta pelo "‹ Arquivos").
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { FileApiError, filesApi, type FileEntry } from '../api';
import { t } from '../i18n';
import { FileIcon, FolderIcon, LockIcon } from '../icons';

const CodeEditor = lazy(() => import('./CodeEditor'));

type Dir = { entries: FileEntry[] } | { error: string } | 'loading';
/** Arquivo aberto: `content` é o que está no editor, `saved` o que está no disco (na versão `mtimeMs`). */
interface Doc {
  path: string;
  content: string;
  saved: string;
  mtimeMs: number;
}
type Opened = { path: string; state: 'loading' } | { path: string; state: 'blocked'; reason: string } | { path: string; state: 'ok'; doc: Doc; rev: number };
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

const byKind = (a: FileEntry, b: FileEntry) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);

function blockedReason(err: unknown): string {
  if (err instanceof FileApiError) {
    if (err.status === 403) return t('files.forbidden');
    if (err.status === 404) return t('files.notFound');
    if (err.status === 413) return t('files.tooBig');
    if (err.status === 415) return t('files.binary');
  }
  return (err as Error).message;
}

export function FilesBoard({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose: () => void }) {
  const [dirs, setDirs] = useState<Record<string, Dir>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [opened, setOpened] = useState<Opened | null>(null);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  /** mtimeMs do disco no 409; enquanto houver, o salvar fica desligado. */
  const [conflict, setConflict] = useState<number | null>(null);
  /** No celular: true = mostra o editor no lugar da árvore. */
  const [editing, setEditing] = useState(false);
  /** Há mudança que ainda não foi para o disco (`content !== saved`). */
  const [dirty, setDirty] = useState(false);

  const doc = useRef<Doc | null>(null);
  const conflictRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const inflight = useRef<Promise<void> | null>(null);
  const rev = useRef(0);

  const loadDir = useCallback(
    (path: string) => {
      setDirs((d) => ({ ...d, [path]: 'loading' }));
      filesApi.tree(projectId, path).then(
        (r) => setDirs((d) => ({ ...d, [path]: { entries: [...r.entries].sort(byKind) } })),
        (e: Error) => setDirs((d) => ({ ...d, [path]: { error: e.message } })),
      );
    },
    [projectId],
  );

  useEffect(() => loadDir(''), [loadDir]);

  const markConflict = (m: number | null) => {
    conflictRef.current = m;
    setConflict(m);
  };

  /** Só chama o setState quando o valor muda, para não renderizar a cada tecla. */
  const markDirty = (v: boolean) => {
    if (dirtyRef.current === v) return;
    dirtyRef.current = v;
    setDirty(v);
  };

  /** Grava o que mudou (se mudou), só por ação da pessoa. Uma escrita por vez; o que for digitado durante ela fica como não salvo. */
  const flush = useCallback(async (): Promise<void> => {
    if (inflight.current) await inflight.current;
    const d = doc.current;
    if (!d || d.content === d.saved || conflictRef.current !== null) return;
    const content = d.content;
    setStatus('saving');
    setSaveError(null);
    inflight.current = filesApi
      .write(projectId, d.path, content, d.mtimeMs)
      .then(
        (r) => {
          d.saved = content;
          d.mtimeMs = r.mtimeMs;
          if (doc.current !== d) return;
          markDirty(d.content !== d.saved);
          setStatus(d.content === content ? 'saved' : 'idle');
        },
        (e: unknown) => {
          if (doc.current !== d) return;
          if (e instanceof FileApiError && e.status === 409) {
            markConflict(e.mtimeMs ?? 0);
            setStatus('conflict');
          } else {
            setSaveError((e as Error).message);
            setStatus('error');
          }
        },
      )
      .finally(() => {
        inflight.current = null;
      });
    await inflight.current;
  }, [projectId]);

  const edit = (text: string) => {
    const d = doc.current;
    if (!d) return;
    d.content = text;
    markDirty(text !== d.saved);
    if (conflictRef.current !== null) return;
    if (text === d.saved) setStatus('saved');
  };

  /** Pode sair do arquivo atual? Não salva sozinho: com conflito ou mudança pendente, só se a pessoa aceitar perdê-la. */
  const leave = async (): Promise<boolean> => {
    if (inflight.current) await inflight.current;
    if (conflictRef.current !== null) return window.confirm(t('files.discardConflict'));
    const d = doc.current;
    if (d && d.content !== d.saved) return window.confirm(t('files.unsavedLeave'));
    return true;
  };

  const load = async (path: string) => {
    doc.current = null;
    markConflict(null);
    markDirty(false);
    setStatus('idle');
    setSaveError(null);
    setOpened({ path, state: 'loading' });
    try {
      const r = await filesApi.read(projectId, path);
      const d: Doc = { path, content: r.content, saved: r.content, mtimeMs: r.mtimeMs };
      doc.current = d;
      setOpened({ path, state: 'ok', doc: d, rev: ++rev.current });
    } catch (e) {
      setOpened({ path, state: 'blocked', reason: blockedReason(e) });
    }
  };

  const openFile = async (entry: FileEntry) => {
    setEditing(true);
    if (opened?.path === entry.path) return;
    if (!(await leave())) return;
    if (entry.locked) {
      doc.current = null;
      markConflict(null);
      markDirty(false);
      setStatus('idle');
      setOpened({ path: entry.path, state: 'blocked', reason: t('files.locked') });
      return;
    }
    await load(entry.path);
  };

  const toggleDir = (path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    const dir = dirs[path];
    // Lê na primeira vez e tenta de novo se deu erro; enquanto carrega, não pede outra vez.
    if (!dir || (dir !== 'loading' && 'error' in dir)) loadDir(path);
  };

  const close = useCallback(async () => {
    if (await leave()) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, flush]);

  const keepMine = () => {
    const d = doc.current;
    if (!d || conflict === null) return;
    d.mtimeMs = conflict;
    markConflict(null);
    void flush();
  };

  useEffect(() => {
    // Esc que o editor já usou (fechar a busca) não fecha a tela.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && void close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  // Fechar a aba com mudança pendente: o navegador pergunta. Nada é salvo sem a pessoa pedir.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const d = doc.current;
      if (d && d.content !== d.saved) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && void close()}>
      <div className="modal files-modal" role="dialog" aria-label={t('files.dialogLabel', { name: projectName })}>
        <header className="tasks-head">
          <h2>{t('files.title', { name: projectName })}</h2>
          <button className="drawer-close in-head" onClick={() => void close()} aria-label={t('files.close')}>
            ×
          </button>
        </header>
        <div className={`files-body ${editing && opened ? 'is-editing' : ''}`}>
          <nav className="files-tree" aria-label={t('files.treeLabel')}>
            <TreeLevel path="" depth={0} dirs={dirs} expanded={expanded} current={opened?.path ?? null} onDir={toggleDir} onFile={(f) => void openFile(f)} />
          </nav>
          <section className="files-editor">
            {!opened ? (
              <p className="muted files-pick">{t('files.pick')}</p>
            ) : (
              <>
                <div className="files-bar">
                  <button className="btn-secondary files-back" onClick={() => setEditing(false)}>
                    ‹ {t('files.back')}
                  </button>
                  <span className="files-path mono" title={opened.path}>
                    {opened.path}
                  </span>
                  {opened.state === 'ok' && (
                    <>
                      <SaveState status={status} dirty={dirty} error={saveError} onRetry={() => void flush()} />
                      <button
                        className={`files-save ${dirty ? 'btn-primary' : 'btn-secondary'}`}
                        title={t('files.saveHint')}
                        disabled={!dirty || status === 'saving' || conflict !== null}
                        onClick={() => void flush()}
                      >
                        {t('files.save')}
                      </button>
                    </>
                  )}
                </div>
                {conflict !== null && (
                  <div className="files-conflict" role="alert">
                    <p>{t('files.conflict')}</p>
                    <p className="actions">
                      <button className="btn-primary" onClick={() => void load(opened.path)}>
                        {t('files.reload')}
                      </button>
                      <button className="btn-secondary" onClick={keepMine}>
                        {t('files.keepMine')}
                      </button>
                    </p>
                  </div>
                )}
                {opened.state === 'loading' && <p className="muted files-pick">{t('files.loading')}</p>}
                {opened.state === 'blocked' && <p className="files-blocked">{opened.reason}</p>}
                {opened.state === 'ok' && (
                  <Suspense fallback={<p className="muted files-pick">{t('files.loadingEditor')}</p>}>
                    <CodeEditor
                      key={`${opened.path}:${opened.rev}`}
                      path={opened.path}
                      initial={opened.doc.content}
                      label={opened.path}
                      onChange={edit}
                      onSave={() => void flush()}
                    />
                  </Suspense>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function SaveState({ status, dirty, error, onRetry }: { status: SaveStatus; dirty: boolean; error: string | null; onRetry: () => void }) {
  if (status === 'error')
    return (
      <button className="files-status is-error" role="status" title={error ?? undefined} onClick={onRetry}>
        {t('files.saveError')} · {t('files.retry')}
      </button>
    );
  const text = status === 'saving' ? t('files.saving') : dirty ? t('files.unsaved') : status === 'saved' ? t('files.saved') : '';
  return (
    <span className={`files-status is-${dirty && status === 'saved' ? 'idle' : status}`} role="status">
      {text}
    </span>
  );
}

function TreeLevel({
  path,
  depth,
  dirs,
  expanded,
  current,
  onDir,
  onFile,
}: {
  path: string;
  depth: number;
  dirs: Record<string, Dir>;
  expanded: Set<string>;
  current: string | null;
  onDir: (path: string) => void;
  onFile: (entry: FileEntry) => void;
}) {
  const dir = dirs[path];
  const pad = { '--depth': depth } as React.CSSProperties;
  if (!dir || dir === 'loading')
    return (
      <p className="muted small files-note" style={pad}>
        {t('files.loading')}
      </p>
    );
  if ('error' in dir)
    return (
      <p className="error small files-note" style={pad}>
        {dir.error}
      </p>
    );
  if (dir.entries.length === 0)
    return (
      <p className="muted small files-note" style={pad}>
        {t('files.empty')}
      </p>
    );
  return (
    <ul className="files-list" role={depth === 0 ? 'tree' : 'group'}>
      {dir.entries.map((e) => {
        const open = e.type === 'dir' && expanded.has(e.path);
        return (
          <li key={e.path} role="treeitem" aria-expanded={e.type === 'dir' ? open : undefined} aria-selected={current === e.path}>
            <button
              className={`files-item ${current === e.path ? 'is-current' : ''} ${e.locked ? 'is-locked' : ''}`}
              style={pad}
              onClick={() => (e.type === 'dir' ? onDir(e.path) : onFile(e))}
              title={e.path}
            >
              <span className="files-caret" aria-hidden="true">
                {e.type === 'dir' ? (open ? '▾' : '▸') : ''}
              </span>
              {e.type === 'dir' ? <FolderIcon /> : e.locked ? <LockIcon /> : <FileIcon />}
              <span className="files-name">{e.name}</span>
            </button>
            {open && <TreeLevel path={e.path} depth={depth + 1} dirs={dirs} expanded={expanded} current={current} onDir={onDir} onFile={onFile} />}
          </li>
        );
      })}
    </ul>
  );
}
