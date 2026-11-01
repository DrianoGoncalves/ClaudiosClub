// Ranking de funcionários: quem entra na lista (ficha ou fantasma do projeto) e as contas do período
// (gasto e economia) a partir do `SavingsReport`. Funções puras, sem React.
import type { AppConfig, Board, SavingsReport, SessionSavings } from '../../shared/model';
import { ghostNodeId, staffNodeId } from './board/layout';
import { t } from './i18n';

/** Uma linha possível do ranking: a ficha de um funcionário, ou o fantasma de um projeto (conversas sem ficha). */
export interface RankingGroup {
  /** Nó do quadro a selecionar ao clicar. */
  nodeId: string;
  name: string;
  /** `cargo · projeto` (o fantasma mostra só o projeto). */
  detail: string;
  /** Projeto arquivado, funcionário arquivado, ou (fantasma) todas as conversas avulsas arquivadas. */
  archived: boolean;
  sessionIds: string[];
}

export interface RankingRow extends Omit<RankingGroup, 'sessionIds'> {
  /** US$ no período: tudo que o funcionário gastou, subagents incluídos. */
  usd: number;
  /** Parte de `usd` gasta pelos subagents. */
  executorUsd: number;
  discardedUsd: number;
  /** Subagents com gasto no período. */
  runs: number;
  /** Economia em US$ (negativa = ficou mais caro): só as sessões com preço. */
  savedUsd: number;
  /** O que essas mesmas sessões custariam com o modelo do planejador fazendo tudo. */
  baseUsd: number;
  /** `savedUsd / baseUsd`; null se nenhuma sessão tinha preço. */
  savedPct: number | null;
}

/** Todos os funcionários, arquivados inclusive: os dados do período decidem quem aparece. */
export function rankingGroups(board: Board, config: AppConfig | null): RankingGroup[] {
  const archivedProjects = new Set(config?.archived.projects ?? []);
  const archivedSessions = new Set(config?.archived.sessions ?? []);
  const out: RankingGroup[] = [];
  for (const p of board.projects) {
    const projectArchived = archivedProjects.has(p.id);
    const staff = board.staff.filter((s) => s.projectId === p.id);
    // Sessão em duas fichas: fica com a última, como no quadro (layout.ts), para não somar duas vezes.
    const ownedBy = new Map<string, string>();
    for (const st of staff) for (const s of st.sessions) ownedBy.set(s.id, st.id);
    for (const st of staff) {
      out.push({
        nodeId: staffNodeId(p.id, st.id),
        name: st.name,
        detail: `${st.role} · ${p.name}`,
        archived: projectArchived || archivedSessions.has(`staff:${st.id}`),
        sessionIds: [...new Set(st.sessions.map((s) => s.id))].filter((id) => ownedBy.get(id) === st.id),
      });
    }
    // As conversas sem ficha somam no funcionário fantasma do projeto.
    const loose = (board.sessions[p.id] ?? []).filter((s) => !ownedBy.has(s.id));
    if (loose.length > 0) {
      out.push({
        nodeId: ghostNodeId(p.id),
        name: t('detail.ghostName'),
        detail: p.name,
        archived: projectArchived || loose.every((s) => archivedSessions.has(s.id)),
        sessionIds: loose.map((s) => s.id),
      });
    }
  }
  return out;
}

/** Soma o período de cada grupo (casando pelo id da sessão); só quem gastou, do maior gasto ao menor. */
export function rankingRows(groups: RankingGroup[], report: SavingsReport): RankingRow[] {
  const bySession = new Map<string, SessionSavings>(report.sessions.map((s) => [s.sessionId, s]));
  const rows: RankingRow[] = [];
  for (const g of groups) {
    const row: RankingRow = { nodeId: g.nodeId, name: g.name, detail: g.detail, archived: g.archived, usd: 0, executorUsd: 0, discardedUsd: 0, runs: 0, savedUsd: 0, baseUsd: 0, savedPct: null };
    for (const id of g.sessionIds) {
      const s = bySession.get(id);
      if (!s) continue;
      row.usd += s.usd;
      row.executorUsd += s.executorUsd;
      row.discardedUsd += s.discardedUsd;
      row.runs += s.runs;
      if (s.asPlannerUsd !== null) {
        row.savedUsd += s.asPlannerUsd - s.usd;
        row.baseUsd += s.asPlannerUsd;
      }
    }
    if (row.usd <= 0) continue;
    row.savedPct = row.baseUsd > 0 ? row.savedUsd / row.baseUsd : null;
    rows.push(row);
  }
  return rows.sort((a, b) => b.usd - a.usd);
}

/** A aba Economia: quem usou subagents, do que mais economizou ao que mais gastou a mais. */
export function savingsList(rows: RankingRow[]): RankingRow[] {
  return rows.filter((r) => r.runs > 0).sort((a, b) => b.savedUsd - a.savedUsd);
}

/** Total da equipe inteira (a % é sobre tudo que ela gastaria só com o modelo do chefe); null sem preço. */
export function teamSavings(rows: RankingRow[]): { savedUsd: number; savedPct: number } | null {
  const savedUsd = rows.reduce((sum, r) => sum + r.savedUsd, 0);
  const baseUsd = rows.reduce((sum, r) => sum + r.baseUsd, 0);
  return baseUsd > 0 ? { savedUsd, savedPct: savedUsd / baseUsd } : null;
}

/** Diferença abaixo de meio centavo é arredondamento, não prejuízo. */
export const isLoss = (savedUsd: number) => savedUsd < -0.005;
