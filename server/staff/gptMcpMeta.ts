// Parte leve do MCP do GPT: o que ele diz sem abrir o Codex (nome, versão, protocolos, instruções e o catálogo de ferramentas). Só constantes e
// built-ins do node: a entrada (gptMcpLite.ts) responde `initialize`, `ping` e `tools/list` daqui, sem carregar o resto (gptMcp.ts, que traz o
// zod, a configuração, o motor do Codex…), e só abre o resto quando alguém pergunta ao GPT. O gptMcp.ts reexporta tudo isto.
import { GPT_MCP_NAME, GPT_TOOL_NAME } from '../../shared/model';

export { GPT_MCP_NAME, GPT_TOOL_NAME };
export const VERSION = '1.0.0';
export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const INSTRUCTIONS =
  'Opinião do GPT (OpenAI, pelo Codex) do Claudio’s Club: só leitura; pesquisa na web se "Permitir acesso à internet" estiver ligado nas Configurações. Use em decisão que pesa e compare a resposta com a sua.';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const DEFAULT_EFFORT = 'high';

export const TOOLS = [
  {
    name: GPT_TOOL_NAME,
    description:
      'Pergunta ao GPT (OpenAI, pelo Codex) uma opinião independente: decisão que pesa (arquitetura, escolher entre caminhos, trade-off) ou revisão de algo arriscado. ' +
      'O GPT lê o projeto (pasta da sessão) em só leitura e não altera nada; pesquisa na web só se "Permitir acesso à internet" estiver ligado nas Configurações. Ele não vê esta conversa, então ponha a decisão, as opções em termos neutros e o que já se sabe (caminhos de arquivo, restrições); a sua preferência vai em hipotese. ' +
      'Demora de 15 s a alguns minutos e gasta a cota ChatGPT do usuário: use em decisão que pesa, não em dúvida pequena. A resposta começa com um veredito (CONCORDO, CONCORDO COM RESSALVAS ou DISCORDO): mostre ao usuário o veredito e as divergências em 1-2 linhas, mesmo com ressalvas, e se discordarem mostre as duas posições.',
    inputSchema: {
      type: 'object',
      properties: {
        pergunta: { type: 'string', description: 'A decisão ou o que revisar, com as opções em termos neutros, sem a sua preferência (ela vai em hipotese). O GPT não vê esta conversa.' },
        hipotese: { type: 'string', description: 'A sua preferência ou conclusão, separada da pergunta: o GPT vai atacá-la, não tomá-la como fato. Opcional.' },
        contexto: { type: 'string', description: 'O que já se sabe: objetivo, arquivos (caminho), restrições, o que já foi decidido. Opcional.' },
        esforco: { type: 'string', enum: [...EFFORTS], description: `Quanto o GPT pensa (padrão ${DEFAULT_EFFORT}). Mais alto demora mais.` },
      },
      required: ['pergunta'],
    },
  },
];

/** A resposta ao `initialize`: o protocolo pedido, se este servidor o conhece; senão o mais novo. */
export function initializeResult(asked: unknown) {
  return {
    protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: GPT_MCP_NAME, version: VERSION },
    instructions: INSTRUCTIONS,
  };
}

/** Lê `--chave valor` dos argumentos. */
export function argOf(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}
