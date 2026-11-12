import { useEffect, useState } from 'react';
import type { Autonomy, CodexEffort, Engine, ServerInfo } from '../../../shared/model';
import { api, type CodexModelsState } from '../api';
import { t } from '../i18n';

// A escolha do motor (Claude ou Codex/GPT) na ficha e no chat: o que aparece, o que vale em cada motor e como o modelo e o esforço
// seguem a troca. Lógica pura (testada em tests/codexFicha.test.ts); as regras que valem de verdade são as do servidor.

export type CodexCatalog = CodexModelsState['models'];

/** Os esforços que a ficha guarda, do menor ao maior (o servidor só aceita estes; o catálogo do Codex pode trazer outros). */
export const CODEX_EFFORTS: readonly CodexEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Esforços do Claude: os mesmos, sem o `ultra` (só existe no Codex). */
const CLAUDE_EFFORTS: readonly CodexEffort[] = CODEX_EFFORTS.filter((e) => e !== 'ultra');

/** Alias ou id de modelo do Claude (o mesmo critério de `codexModelOrNull`, em server/chat/codexArgs.ts): não vale para o Codex. */
const CLAUDE_MODEL = /^(claude-|opus|sonnet|haiku|fable|mythos|inherit|default)/i;
export const isClaudeModel = (model: string | null | undefined): boolean => !!model && CLAUDE_MODEL.test(model);

/** O campo "Motor" só aparece com o Codex ligado nas configurações, ou quando a ficha já é do Codex (para dar para voltar ao Claude). */
export function showEngineField(codexReview: boolean | null | undefined, engine: Engine): boolean {
  return codexReview === true || engine === 'codex';
}

/**
 * Quem tem conexão FTP marcada na ficha não pode rodar no Codex (o SSH pode, pelo MCP myco-ssh): o botão do Codex fica desligado.
 * Sem a lista de conexões (ainda carregando), nenhuma conta como FTP: o servidor confere de novo ao salvar.
 */
export const codexBlockedByServers = (servers: readonly string[], list: readonly Pick<ServerInfo, 'name' | 'source'>[] | null): boolean =>
  !!list && list.some((s) => s.source === 'ftp' && servers.includes(s.name));

/** Escrita SSH só se oferece na conexão SSH marcada (o campo da ficha é um subconjunto de `servers`). */
export const canWriteSsh = (s: Pick<ServerInfo, 'name' | 'protocol'>, servers: readonly string[]): boolean =>
  s.protocol === 'ssh' && servers.includes(s.name);

/** `Claude` fica sem `engine` na ficha (como sempre foi); só quem volta do Codex manda `claude` de forma explícita. */
export function engineToSend(engine: Engine, saved: Engine | undefined): Engine | undefined {
  if (engine === 'codex') return 'codex';
  return saved === 'codex' ? 'claude' : undefined;
}

/** Os esforços que o modelo aceita, do menor ao maior. Sem modelo escolhido, nenhum (o Codex usa o modelo padrão dele, que a lista não diz qual é). */
export function effortsOfModel(catalog: CodexCatalog, slug: string): CodexEffort[] {
  const accepted = catalog.find((m) => m.slug === slug)?.efforts ?? [];
  return CODEX_EFFORTS.filter((e) => accepted.includes(e));
}

/** O esforço que o Codex usa nesse modelo quando a ficha não escolhe (só se for um dos que a ficha guarda). */
export function defaultEffortOf(catalog: CodexCatalog, slug: string): CodexEffort | null {
  const d = catalog.find((m) => m.slug === slug)?.defaultEffort;
  return CODEX_EFFORTS.find((e) => e === d) ?? null;
}

/** Trocou o modelo: o esforço fica se o novo modelo também aceita; senão limpa (ex.: `ultra` num modelo que vai só até `max`). */
export function pickCodexModel(catalog: CodexCatalog, slug: string, effort: '' | CodexEffort): { model: string; effort: '' | CodexEffort } {
  return { model: slug, effort: effort && effortsOfModel(catalog, slug).includes(effort) ? effort : '' };
}

/**
 * Trocou o motor: o modelo nunca serve ao outro (alias do Claude × slug do Codex), então limpa. O esforço do Codex depende do modelo
 * (que acabou de sair), então limpa também; voltando para o Claude, os níveis comuns ficam e o `ultra` sai.
 */
export function switchEngine(to: Engine, current: { model: string; effort: '' | CodexEffort }): { model: string; effort: '' | CodexEffort } {
  if (to === 'codex') return { model: '', effort: '' };
  return { model: '', effort: CLAUDE_EFFORTS.includes(current.effort as CodexEffort) ? current.effort : '' };
}

/** No chat, trocar o modelo não pode deixar um esforço que ele não aceita: fica o atual, ou o padrão do modelo, ou o menor. */
export function chatEffortFor(catalog: CodexCatalog, slug: string, current: string | null | undefined): CodexEffort | undefined {
  const efforts = effortsOfModel(catalog, slug);
  if (!efforts.length || efforts.includes(current as CodexEffort)) return undefined;
  return defaultEffortOf(catalog, slug) ?? efforts[0];
}

/** O que cada autonomia vira na sandbox do Codex: só ler o projeto, ou poder editá-lo. Sem internet nos dois. */
export function codexAutonomyHelp(autonomy: Autonomy): string {
  switch (autonomy) {
    case 'plan':
      return t('staff.codexAutonomyPlanHelp');
    case 'manual':
      return t('staff.codexAutonomyManualHelp');
    case 'acceptEdits':
      return t('staff.codexAutonomyEditsHelp');
    case 'auto':
      return t('staff.codexAutonomyAutoHelp');
    case 'bypassPermissions':
      return t('staff.codexAutonomyBypassHelp');
  }
}

/** O catálogo do Codex (GET /api/codex/models) para os seletores; só busca quando `enabled`. Erro vira lista vazia com o motivo. */
export function useCodexCatalog(enabled: boolean): CodexModelsState | null {
  const [catalog, setCatalog] = useState<CodexModelsState | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api.codexModels().then(
      (c) => alive && setCatalog(c),
      (err: Error) => alive && setCatalog({ models: [], reason: err.message }),
    );
    return () => {
      alive = false;
    };
  }, [enabled]);
  return catalog;
}
