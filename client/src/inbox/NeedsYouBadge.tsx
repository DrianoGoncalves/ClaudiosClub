import { toneClass } from './alertTone';
import { needsYouText, type NeedsYou } from './needsYou';

/**
 * Selo "precisa de você" (tom `action`) dos cartões de tarefa, funcionário e projeto: ponto amarelo e o texto, ou só o ponto e a contagem (`compact`).
 * O motivo vai no `aria-label` e no `title` (o texto visível é curto). Sem pendência, não desenha nada.
 */
export function NeedsYouBadge({ needs, compact = false }: { needs: NeedsYou | null | undefined; compact?: boolean }) {
  if (!needs) return null;
  const { text, label } = needsYouText(needs);
  return (
    <span className={`needs-badge ${toneClass('action')}${compact ? ' is-compact' : ''}`} role="img" aria-label={label} title={label}>
      <span className="needs-dot" aria-hidden="true" />
      {compact ? needs.count > 1 && <span aria-hidden="true">{needs.count}</span> : <span aria-hidden="true">{text}</span>}
    </span>
  );
}
