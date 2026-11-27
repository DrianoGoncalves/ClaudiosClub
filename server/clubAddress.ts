// Endereço do Claudio’s Club (a porta e os nomes pelos quais o navegador chega aqui, ver LOCAL_HOSTNAMES em index.ts).
// O navegador dos funcionários não abre nenhum deles: lá está a tela do dono, já pareada, e um clique do agente aprovaria
// permissões, planos e mesclas no lugar dele. No Claude o bloqueio é o hook scripts/hooks/club-guard.mjs (ele lê a mesma
// MYCO_PORT, herdada do servidor); no Codex, o `--blocked-origins` do Playwright MCP (ver codexChromeOf em staff/launch.ts).
//
// Além da porta do servidor, vale toda origem local que sirva a tela dele: o Vite do `npm run dev` (127.0.0.1:5173, com proxy de /api para o
// servidor) abre a mesma tela, e o cookie do pareamento vale para o host em qualquer porta. Quem serve a tela grava a origem ao subir
// (scripts/hooks/club-origins.mjs; o servidor em index.ts, o Vite no vite.config.ts) e o bloqueio lê esse registro, sem sondar porta.
// A prévia de interface (npm run preview:ui, 127.0.0.1:5199, sem servidor) e uma instância isolada com MYCO_HOME próprio não entram.

import { registeredPorts, registerOrigin } from '../scripts/hooks/club-origins.mjs';

export const CLUB_PORT = Number(process.env.MYCO_PORT ?? 4848);

/** As portas (fora a do servidor) onde há uma origem registrada e viva que serve a tela do Club (o Vite do dev). Lê o registro agora. */
export function registeredClubPorts(): number[] {
  return registeredPorts().filter((p) => p !== CLUB_PORT);
}

/** O servidor registra a origem que serve (ao abrir a porta). Devolve quem apaga o registro; `null` se não gravou (não derruba o servidor). */
export function registerClubServer(port = CLUB_PORT): (() => void) | null {
  return registerOrigin({ kind: 'server', port });
}

/**
 * Origens que o Playwright MCP recusa (formato do `--blocked-origins`, separadas por `;`). O cookie do pareamento vale para o
 * nome em qualquer porta (`claudio.localhost:*`, também o Vite do `npm run dev`); `localhost` e `127.0.0.1` só na porta do
 * Club e nas de `extraPorts` (as origens registradas que servem a tela, ver `registeredClubPorts`), para o funcionário seguir testando
 * o próprio projeto neles. O 127.0.0.2 (sandbox do Codex) nunca conta como a tela. Lista fixa na hora de subir o MCP: um Vite que abre
 * depois não está nela (no Claude o hook relê o registro a cada chamada).
 */
export function clubBlockedOrigins(port = CLUB_PORT, extraPorts: readonly number[] = []): string {
  const ports = [port, ...[...new Set(extraPorts)].filter((p) => p !== port)];
  return ['http://claudio.localhost:*', 'http://myco.localhost:*', ...ports.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`])].join(';');
}
