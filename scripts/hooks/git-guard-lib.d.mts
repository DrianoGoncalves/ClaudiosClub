// Tipos de git-guard-lib.mjs (o servidor e os testes importam o .mjs; o hook roda ele direto, sem build).

/** A resposta do hook de PreToolUse (só os campos que o Claude Code e o Codex aceitam). */
export interface GitGuardResponse {
  hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string };
}

/** O comando (texto de uma chamada de terminal) pode ter git? Sem isso o hook nem lê o comando. */
export const MAY_BE_GIT: RegExp;
/** Decide o evento de uma chamada de ferramenta: a resposta `deny`, ou null (não responde). `projectPath`: o checkout principal do projeto. */
export function guard(ev: unknown, projectPath: string | undefined): GitGuardResponse | null;
/** Erro inesperado: outra ferramenta, não responde; senão, bloqueia. */
export function failClosed(raw: string): GitGuardResponse | null;
export function unavailable(): GitGuardResponse;
