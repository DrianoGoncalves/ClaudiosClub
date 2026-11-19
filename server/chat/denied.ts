import type { DeniedLayer, DenialInfo } from '../../shared/model';
import { denialNotice } from './denial';
import { scanSecrets } from './secrets';

// Ferramenta barrada por uma regra de permissão, no formato único que o manager recebe dos dois motores (alerta "ação barrada" da caixa, ver
// `ChatManager.deniedHits`). O texto e as camadas do Claude são os de denial.ts (que não muda); aqui só entra o que é do Codex e a escolha do que mostrar.

/** O que o processo reporta a cada negação (ver `ChatProcessOptions.onDenied`). `text` é o do aviso no chat. */
export interface DeniedInfo {
  tool: string;
  layer: DeniedLayer;
  reason?: string;
  hint: DenialInfo['hint'];
  text: string;
}

/**
 * Negação do Claude Code (a classificação e o texto são os do aviso no chat). O alerta vai para a caixa e para a notificação do sistema, que o chat não é: um motivo que
 * traz algo com cara de segredo (o texto do erro da ferramenta, cortado em 120 caracteres) sai sem o motivo, e o texto é refeito sem ele.
 */
export function claudeDenied(tool: string, d: DenialInfo): DeniedInfo {
  const safe: DenialInfo = d.reason && scanSecrets(d.reason).length ? { layer: d.layer, hint: d.hint } : d;
  return { tool, layer: safe.layer, ...(safe.reason && { reason: safe.reason }), hint: safe.hint, text: denialNotice(tool, safe) };
}

/**
 * Recusa da sandbox do Codex: o item chegou com `status: 'declined'` (comando ou edição). `readOnly`: a sandbox da conversa só lê (plano, aprovação manual);
 * então a saída é mudar a autonomia (`autonomy`). Na de escrita, a recusa é de algo fora da pasta de trabalho: sem dica.
 */
export function sandboxDenied(tool: string, readOnly: boolean): DeniedInfo {
  return {
    tool,
    layer: 'sandbox',
    hint: readOnly ? 'autonomy' : null,
    text: readOnly
      ? `\`${tool}\` recusado pela sandbox do Codex: a conversa roda só com leitura (plano ou aprovação manual).`
      : `\`${tool}\` recusado pela sandbox do Codex: fora da pasta de trabalho ou da rede liberada.`,
  };
}

/**
 * O Codex recusou este item (`command_execution` ou `file_change` concluído com `status: 'declined'`)? Devolve o nome da ferramenta no chat; senão null.
 *
 * LIMITE (spike no Codex 0.169.0, Windows, `-s read-only`, `approval_policy="never"`): a escrita barrada pela sandbox de leitura NÃO vem como `declined`. O comando de shell
 * chega com `status: "failed"`, `exit_code: 1` e o texto do SO, localizado ("O acesso ao caminho … foi negado", `UnauthorizedAccessException`), e a recusa do `apply_patch`
 * nem aparece como item no `--json`. Falha com "acesso negado" também sai de causa que não é regra (arquivo preso por outro processo), então não se chuta pelo texto do SO.
 * A recusa do `apply_patch` se lê no rollout (`codexRolloutDenial`); a do shell não tem mensagem do Codex (só o texto do SO), então segue sem alerta. O `declined`
 * explícito segue valendo (o Codex o define para comando e edição recusados) mas NÃO foi observado ao vivo.
 */
export function codexDeclinedTool(phase: string, raw: unknown): string | null {
  if (phase !== 'completed' || !raw || typeof raw !== 'object') return null;
  const item = raw as { type?: unknown; status?: unknown };
  if (item.status !== 'declined') return null;
  return item.type === 'command_execution' ? 'Bash' : item.type === 'file_change' ? 'Edit' : null;
}

/** O que uma linha do rollout diz sobre uma recusa: `denied` = alerta; `unknown` = parece recusa mas o formato não é o conhecido (sem alerta, só log; `why` é fixo, sem o conteúdo). */
export type RolloutDenial = { kind: 'denied'; tool: 'Edit'; readOnly: boolean } | { kind: 'unknown'; why: string };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

/**
 * O `apply_patch` recusado pelo próprio Codex (Codex 0.169: sandbox só de leitura ou fora da pasta do projeto, com a política de aprovação que não pergunta) NÃO sai no
 * `--json`; ele só fica no rollout, na saída da chamada (`function_call_output`/`custom_tool_call_output`), como um bloco de texto que COMEÇA com
 * `Script error:\npatch rejected: <motivo>`. Os motivos do binário são "writing is blocked by read-only sandbox; rejected by user approval settings" e "writing outside of
 * the project; rejected by user approval settings"; `patch rejected by user` é uma pessoa recusando (não é regra) e não alerta.
 *
 * Sem alerta de propósito: o shell com "acesso negado" do SO (`out-file : O acesso ao caminho … foi negado`) vem no mesmo tipo de linha, mas sem mensagem do Codex, e o mesmo
 * texto sai de arquivo preso por outro processo. Só vale o bloco no começo do texto (um comando que imprime a frase fica dentro do JSON do `output`, não no começo).
 * Limite: o bloco vem de um `throw` do script do modo código; um script do modelo que lance a mesma frase passa (alerta falso na própria conversa, sem efeito além do aviso), por
 * isso o item usa só o texto fixo de `sandboxDenied` e o log só o `why` fixo, nunca o conteúdo da linha.
 *
 * Devolve null para o que não é recusa (a grande maioria das linhas); `unknown` quando a linha parece recusa mas o formato não é o conhecido (quem chama registra e segue).
 */
export function codexRolloutDenial(line: string): RolloutDenial | null {
  if (!line.includes('patch rejected')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { kind: 'unknown', why: 'linha com "patch rejected" que não é JSON' };
  }
  const top = rec(obj);
  const payload = rec(top.payload);
  if (top.type !== 'response_item' || (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output')) return null;
  const out = payload.output;
  const texts = typeof out === 'string' ? [out] : Array.isArray(out) ? out.map((b) => rec(b).text) : null;
  if (!texts || (Array.isArray(out) && texts.some((t) => typeof t !== 'string'))) return { kind: 'unknown', why: 'saída da chamada em formato desconhecido' };
  let seen = false;
  for (const text of texts as string[]) {
    // Parece recusa: a frase abre uma linha do bloco, ou o bloco é um "Script error" que a traz (formato mudado). Um comando que a imprime fica dentro do JSON do `output`: não entra.
    if (!/^patch rejected/m.test(text) && !(text.startsWith('Script error') && text.includes('patch rejected'))) continue;
    seen = true;
    if (/^Script error:\r?\npatch rejected by user\s*$/.test(text)) return null;
    const m = /^Script error:\r?\npatch rejected: ([^\r\n]+)\s*$/.exec(text);
    if (!m) continue;
    const reason = m[1]!;
    if (!/sandbox|approval/i.test(reason)) return { kind: 'unknown', why: 'motivo de recusa fora dos conhecidos (nem sandbox nem política de aprovação)' };
    return { kind: 'denied', tool: 'Edit', readOnly: /read-only/i.test(reason) };
  }
  return seen ? { kind: 'unknown', why: 'bloco "patch rejected" fora do formato "Script error:\\npatch rejected: <motivo>"' } : null;
}

/**
 * Qual negação de um turno o item mostra. `safety` (checagem embutida do Claude Code, que o agente costuma contornar) e `classifierError` (falha passageira) valem menos
 * que uma regra que barra de verdade: uma negação só troca a mostrada se for de mais peso (empate: fica a primeira, o item não muda sob o olho de quem lê).
 */
export function denialWeight(layer: DeniedLayer): number {
  return layer === 'safety' ? 0 : layer === 'classifierError' ? 1 : 2;
}
