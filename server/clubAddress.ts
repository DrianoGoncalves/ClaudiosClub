// Endereço do Claudio’s Club (a porta e os nomes pelos quais o navegador chega aqui, ver LOCAL_HOSTNAMES em index.ts).
// O navegador dos funcionários não abre nenhum deles: lá está a tela do dono, já pareada, e um clique do agente aprovaria
// permissões, planos e mesclas no lugar dele. No Claude o bloqueio é o hook scripts/hooks/club-guard.mjs (ele lê a mesma
// MYCO_PORT, herdada do servidor); no Codex, o `--blocked-origins` do Playwright MCP (ver codexChromeOf em staff/launch.ts).

export const CLUB_PORT = Number(process.env.MYCO_PORT ?? 4848);

/**
 * Origens que o Playwright MCP recusa (formato do `--blocked-origins`, separadas por `;`). O cookie do pareamento vale para o
 * nome em qualquer porta (`claudio.localhost:*`, também o Vite do `npm run dev`); `localhost` e `127.0.0.1` só na porta do
 * Club, para o funcionário seguir testando o próprio projeto neles. O 127.0.0.2 (sandbox do Codex) nunca conta como a tela.
 */
export function clubBlockedOrigins(port = CLUB_PORT): string {
  return ['http://claudio.localhost:*', 'http://myco.localhost:*', `http://localhost:${port}`, `http://127.0.0.1:${port}`].join(';');
}
