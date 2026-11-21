import type { StaffProfile } from '../../../shared/model';
import { Portrait, portraitUrl } from '../board/nodes';

// Quem revisa, no cartão e no painel: o retrato do organograma (foto, ou iniciais sem foto), menor, e o nome. Substitui o ícone de revisão.

type Reviewer = Pick<StaffProfile, 'id' | 'name' | 'portrait' | 'updatedAt'>;

/** `staff` é a lista do projeto; quem não está nela (ficha apagada) aparece só com o id, em iniciais. */
export function ReviewerChip({ id, staff, projectId }: { id: string; staff: ReadonlyArray<Reviewer>; projectId: string }) {
  const s = staff.find((x) => x.id === id);
  const name = s?.name ?? id;
  return (
    <span className="reviewer-chip">
      <Portrait id={id} label={name} src={s?.portrait ? portraitUrl(projectId, s) : null} size={22} variant="busy" />
      <span className="reviewer-chip-name">{name}</span>
    </span>
  );
}
