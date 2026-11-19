import { useRef, useState } from 'react';
import type { InboxItem } from '../../../shared/model';
import { filesApi } from '../api';
import { t } from '../i18n';
import { sandboxOf } from '../inbox/codexSandbox';
import { inboxText } from '../inbox/inboxText';
import { SandboxFix } from '../inbox/SandboxFix';
import { isLocalPage } from '../office/folderPick';
import { fixNoteOf, fixTargetOf, runFix, type FixNote } from './fixSecret';
import { secretFileOf } from './secretAlerts';
import { SecretVerdictRow } from './SecretVerdictRow';

/**
 * O aviso de segredo da caixa "precisa de mim" como balão na conversa onde ele apareceu: a mesma frase e o mesmo "ignorar".
 * Com o palpite do servidor (`secret.verdict`), traz o selo (real ou falso positivo), a dica mascarada e o "por quê?" (ver `SecretVerdictRow`);
 * em "possível credencial exposta" o botão se chama "Já troquei", não "Ignorar". Quando o servidor diz em que arquivo o segredo está (`secret.file`), o balão mostra o caminho e o botão "Corrigir" ao lado do Ignorar:
 * arquivo comum abre na aba Arquivos do projeto (na linha do segredo, se o servidor a mandou); arquivo de segredo (.env, chave) abre fora do Club, no editor de texto do computador, e o conteúdo nunca aparece na tela (ver `fixSecret`).
 * Só existe na tela: não é mensagem da conversa, o modelo nunca vê. O valor do segredo não chega aqui (o item só traz tipo, contexto, origem, caminho, o palpite e a dica mascarada: no máximo 4 caracteres do valor).
 * O aviso de erro da caixa (`kind: 'error'`) usa o mesmo balão, em vermelho e com a frase do servidor, e o mesmo "Ignorar" (o servidor guarda o carimbo do erro dispensado); sem `onIgnore`, não há botão.
 */
export function SecretNotice({ item, onIgnore, onOpenFile }: { item: InboxItem; onIgnore?: (item: InboxItem) => Promise<void>; onOpenFile?: (path: string, line?: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixNote, setFixNote] = useState<FixNote | null>(null);
  // Trava síncrona do clique duplo: o estado só vale depois do próximo render.
  const fixLock = useRef(false);
  const ignore = async () => {
    setBusy(true);
    try {
      await onIgnore?.(item);
    } finally {
      setBusy(false);
    }
  };
  const target = item.kind === 'error' ? null : fixTargetOf(item, !!onOpenFile);
  const fix = async () => {
    if (!target || fixLock.current) return;
    fixLock.current = true;
    setFixing(true);
    setFixNote(null);
    try {
      const outcome = await runFix(target, { projectId: item.projectId, local: isLocalPage(window.location.hostname), openEditor: filesApi.openEditor, openFiles: onOpenFile });
      setFixNote(fixNoteOf(outcome));
    } finally {
      fixLock.current = false;
      setFixing(false);
    }
  };
  return (
    <SecretNoticeView
      item={item}
      busy={busy}
      onIgnore={onIgnore ? () => void ignore() : undefined}
      onFix={target ? () => void fix() : undefined}
      fixBusy={fixing}
      fixNote={fixNote}
    />
  );
}

/**
 * O balão sem estado (testável sem navegador): `busy` trava o Ignorar enquanto o servidor responde; sem `onIgnore`, o botão não aparece.
 * `onFix` é o "Corrigir" (só existe se há arquivo e um jeito de abri-lo); `fixBusy` o trava enquanto abre; `fixNote` é a frase depois do clique.
 */
export function SecretNoticeView({
  item,
  busy,
  onIgnore,
  onFix,
  fixBusy = false,
  fixNote = null,
}: {
  item: InboxItem;
  busy: boolean;
  onIgnore?: () => void;
  onFix?: () => void;
  fixBusy?: boolean;
  fixNote?: FixNote | null;
}) {
  const isError = item.kind === 'error';
  const file = isError ? null : secretFileOf(item);
  // Possível credencial exposta: o botão não diz "Ignorar" (não sugere deixar pra lá); o que ele faz é o mesmo do "já troquei".
  const exposed = !isError && item.secret?.verdict === 'exposed';
  // Aviso da máquina (terminal do Codex quebrado pela política de senha do Windows): leva o comando para copiar, e o "ignorar" tem texto próprio.
  const sandbox = isError ? sandboxOf(item) : null;
  return (
    <div className={`permission secret-notice${isError ? ' is-error' : ''}`} role="alert" data-item-id={item.id}>
      <p className="small">{inboxText(item)}</p>
      {sandbox && <SandboxFix alert={sandbox} />}
      {!isError && <SecretVerdictRow item={item} />}
      {file && (
        <p className="small secret-file">
          <code>{file.path}</code>
          {file.blocked && <span className="muted"> · {t('chat.secretFileBlocked')}</span>}
        </p>
      )}
      {(onIgnore || (file && onFix)) && (
        <div className="actions">
          {file && onFix && (
            <button type="button" className="btn-secondary" disabled={fixBusy} title={t(file.blocked ? 'chat.secretOpenEditorTitle' : 'chat.secretOpenFileTitle', { path: file.path })} onClick={onFix}>
              {t('chat.secretOpenFile')}
            </button>
          )}
          {onIgnore && (
            <button type="button" className="btn-secondary" disabled={busy} title={t(sandbox ? 'inbox.sandbox.dismissTitle' : isError ? 'chat.errorIgnoreTitle' : exposed ? 'chat.secretIgnoreExposedTitle' : 'chat.secretIgnoreTitle')} onClick={onIgnore}>
              {t(exposed ? 'chat.secretIgnoreExposed' : 'chat.secretIgnore')}
            </button>
          )}
        </div>
      )}
      {fixNote && (
        <p className={`small secret-fix-note${fixNote.ok ? '' : ' error'}`} role={fixNote.ok ? 'status' : 'alert'}>
          {fixNote.text}
        </p>
      )}
    </div>
  );
}
