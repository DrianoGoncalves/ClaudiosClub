import type { Engine } from '../../../shared/model';
import { t } from '../i18n';
import type { PlanImpasse } from './planImpasse';

type AgentsKey =
  | 'staff.planImpasse.agentsOne'
  | 'staff.planImpasse.agentsOther'
  | 'staff.planImpasse.agentsPlaybookOne'
  | 'staff.planImpasse.agentsPlaybookOther'
  | 'staff.planImpasse.agentsCodexOne'
  | 'staff.planImpasse.agentsCodexOther';

/**
 * O parágrafo de agents do aviso, um por origem: o que o roteiro chama só sai trocando o roteiro (ou a autonomia), e desmarcar na lista não limpa o aviso; o que
 * está marcado direto na lista (só o Claude tem a lista) sai da ficha. Um agent que as duas coisas trazem fica no do roteiro: ao trocá-lo, se ainda estiver marcado,
 * o aviso passa a dizer para tirá-lo da ficha.
 */
export function agentNotes(impasse: PlanImpasse, engine: Engine): Array<{ key: AgentsKey; names: string[] }> {
  const listed = impasse.agents.filter((name) => !impasse.playbookAgents.includes(name));
  const kind = (names: string[], one: AgentsKey, other: AgentsKey): AgentsKey => (names.length === 1 ? one : other);
  const notes: Array<{ key: AgentsKey; names: string[] }> = [];
  if (listed.length) notes.push({ key: kind(listed, 'staff.planImpasse.agentsOne', 'staff.planImpasse.agentsOther'), names: listed });
  const called = impasse.playbookAgents;
  if (called.length) {
    const codex = engine === 'codex';
    notes.push({
      key: kind(called, codex ? 'staff.planImpasse.agentsCodexOne' : 'staff.planImpasse.agentsPlaybookOne', codex ? 'staff.planImpasse.agentsCodexOther' : 'staff.planImpasse.agentsPlaybookOther'),
      names: called,
    });
  }
  return notes;
}

/** Aviso da ficha: "Só planeja" com agent que edita ou MCP (ou navegador) em "Livre" marcado. Só informa; salvar segue liberado. */
export function PlanImpasseNote({ impasse, engine }: { impasse: PlanImpasse; engine: Engine }) {
  const vars = { plan: t('staff.autonomyPlanLabel'), free: t('staff.mcpAccessFree'), readonly: t('staff.mcpAccessReadonly') };
  const mcps = [...impasse.mcps, ...(impasse.browser ? [t('staff.planImpasse.browser')] : [])];
  return (
    <div className="person-note plan-impasse small" role="note">
      <p>
        <strong>{t('staff.planImpasse.title', vars)}</strong>
      </p>
      {agentNotes(impasse, engine).map((note) => (
        <p key={note.key}>{t(note.key, { ...vars, names: note.names.join(', ') })}</p>
      ))}
      {mcps.length > 0 && <p>{t('staff.planImpasse.mcps', { ...vars, names: mcps.join(', ') })}</p>}
    </div>
  );
}
