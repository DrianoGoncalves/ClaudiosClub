// O peso dos MCPs na ficha, dito em memória do computador por conversa aberta. Só entra aqui o que foi medido (17/11, Windows); o que não foi
// medido aparece sem número, nunca com um chute.

/** Faixa em MB (mínimo e máximo medidos). Um valor só = o mesmo nos dois. */
export type MbRange = readonly [min: number, max: number];

export const WEIGHT_MB = {
  /** O programa do próprio Claude, um por conversa aberta (não é MCP: é a base de toda conversa). */
  claude: [200, 290],
  /** O navegador de verdade (Playwright), só enquanto a conversa usa o navegador (sobe na 1ª chamada e cai ao ficar ocioso). */
  browser: [80, 120],
  /** O proxy preguiçoso do navegador limpo (`myco-navegador`): fica aberto em toda conversa com "Usar o navegador" marcado (`server/navegadorMcp.ts:10`). */
  browserProxy: [54, 54],
  /** O recurso de perguntar ao GPT (`myco-gpt`), nas conversas do Claude com o GPT ligado nas Configurações. */
  gpt: [20, 45],
  /** O acesso aos servidores (`myco-ssh`). FTP não foi medido. */
  ssh: [2, 2],
} as const satisfies Record<string, MbRange>;

/** Minutos parada até o Club fechar a conversa sozinho (`ChatManager.reap`, server/chat/manager.ts). */
export const CLOSE_IDLE_MIN = 15;
/** Minutos sem usar até o navegador limpo se fechar sozinho (`IDLE_MS`, server/navegadorMcp.ts). */
export const BROWSER_IDLE_MIN = 10;

/** Os números para o texto: `{min}` e `{max}` (faixa), `{mb}` (valor único). */
export const rangeParams = ([min, max]: MbRange): { min: number; max: number; mb: number } => ({ min, max, mb: max });
