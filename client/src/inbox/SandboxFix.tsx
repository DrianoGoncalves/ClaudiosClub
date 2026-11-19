import { useCopy } from '../chat/markdown';
import { t } from '../i18n';
import type { SandboxAlert } from './codexSandbox';

/**
 * O que o dono faz para destravar o terminal do Codex (aviso da política de senha do Windows): o comando com botão de copiar, a nota "rode como administrador" e a nota de que, em
 * máquina de domínio, a política de grupo pode desfazer a mudança. Só copia: o Club nunca roda o comando. Sem comando (a duração mínima já é 0, a causa é outra regra de senha)
 * não há o que copiar, e a frase do aviso já diz o que conferir. Usado na caixa "precisa de mim" e no balão da conversa do Codex.
 */
export function SandboxFix({ alert, className = '' }: { alert: SandboxAlert; className?: string }) {
  const [copied, copy, failed] = useCopy();
  const command = alert.command;
  if (!command) return null;
  return (
    <div className={`sandbox-fix ${className}`.trim()}>
      <p className="small">{t(alert.days === null ? 'inbox.sandbox.runCheck' : 'inbox.sandbox.run')}</p>
      <div className="sandbox-cmd">
        <code className="mono">{command}</code>
        <button type="button" className="btn-secondary" title={t('inbox.sandbox.copyTitle')} onClick={() => copy(command)}>
          {copied ? t('chat.mdCopied') : t('chat.mdCopy')}
        </button>
      </div>
      {failed && (
        <p className="small sandbox-error" role="alert">
          {t('inbox.sandbox.copyFailed')}
        </p>
      )}
      <p className="small sandbox-note">{t('inbox.sandbox.admin')}</p>
      <p className="small sandbox-note">{t('inbox.sandbox.domain')}</p>
    </div>
  );
}
