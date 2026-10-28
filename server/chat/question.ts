// Pergunta no fim de uma resposta: o funcionário terminou o turno perguntando algo a você no texto
// ("Quer que eu faça o commit?"), sem pedido de permissão. Olha as últimas linhas, e não só a
// última, porque depois da pergunta pode vir uma nota (a de certeza, por exemplo). Um "?" dentro de
// bloco de código não conta.

const MAX = 160;

/** A pergunta das últimas linhas da resposta, sem Markdown, ou null. */
export function finalQuestion(text: string | null): string | null {
  if (!text) return null;
  const lines = text
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(-3).reverse()) {
    if (!/\?[*_)"'»]*$/.test(line) || line.startsWith('|')) continue;
    const plain = line.replace(/[*_`]/g, '').replace(/^[-#>\s]+/, '').trim();
    return plain.length > MAX ? `${plain.slice(0, MAX - 1)}…` : plain;
  }
  return null;
}
