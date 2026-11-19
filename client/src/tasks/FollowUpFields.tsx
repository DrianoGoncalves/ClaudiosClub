import type { FollowUp } from '../../../shared/model';
import { t } from '../i18n';
import { sizeText } from './followUpNotice';

// O follow-up com os campos que o revisor preenche, para quem decide: selo da recomendação (vale fazer / opcional), título leigo, "Se não fizer: …", tamanho, quem faria e o
// achado técnico recolhido. Serve ao balão da conversa (chat/FollowUpNotice.tsx) e ao detalhe do card. Tudo texto puro: o conteúdo é de outro funcionário.

/** "Vale fazer" ou "Opcional": o texto basta para ler sem cor; a borda sólida ou tracejada o reforça. */
export function RecommendationBadge({ recommendation }: { recommendation?: FollowUp['recommendation'] }) {
  if (recommendation !== 'worth' && recommendation !== 'optional') return null;
  return <span className={`task-badge small fu-rec is-${recommendation}`}>{t(recommendation === 'worth' ? 'tasks.fuRecWorth' : 'tasks.fuRecOptional')}</span>;
}

export interface FieldsProps {
  recommendation?: FollowUp['recommendation'];
  title: string;
  impact?: string;
  size?: FollowUp['size'];
  /** Quem faria, já como nome; null/ausente = o revisor não sugeriu (ou a ficha saiu do projeto). */
  who?: string | null;
  /** "Achado de Fulano há 5 min": quem registrou e quando. */
  by: string;
  /** O achado inteiro, no "Detalhes técnicos" (fechado). */
  text: string;
}

export function FollowUpFieldsView({ recommendation, title, impact, size, who, by, text }: FieldsProps) {
  const sizeLabel = sizeText(size);
  return (
    <div className="fu-fields">
      <p className="fu-head">
        <RecommendationBadge recommendation={recommendation} />
        <b className="fu-title">{title}</b>
      </p>
      {impact && (
        <p className="small fu-impact">
          <b>{t('tasks.fuImpact')}</b> {impact}
        </p>
      )}
      <p className="muted small fu-meta">
        {sizeLabel && <span>{t('tasks.fuMetaSize', { size: sizeLabel })}</span>}
        {who && <span>{t('tasks.fuMetaWho', { name: who })}</span>}
        <span>{by}</span>
      </p>
      <details className="fu-details">
        <summary>{t('tasks.fuDetails')}</summary>
        <p className="fu-text">{text}</p>
      </details>
    </div>
  );
}
