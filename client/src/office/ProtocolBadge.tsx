import type { ConnectionProtocol } from '../../../shared/model';
import { t } from '../i18n';

/** Protocolo da conexão; FTP puro em aviso (sem criptografia). Usado também na ficha. */
export function ProtocolBadge({ protocol }: { protocol: ConnectionProtocol }) {
  return (
    <span className={protocol === 'ftp' ? 'badge warn' : 'badge'} title={protocol === 'ftp' ? t('office.connFtpPlain') : undefined}>
      {t(`office.proto.${protocol}`)}
    </span>
  );
}
