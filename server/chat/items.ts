// Conversão de blocos do Claude Code (transcript ou stream-json, que têm o mesmo formato de
// mensagem) em itens da conversa do MyCo.

const MAX_INPUT = 2_000;
const MAX_RESULT = 4_000;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} caracteres a mais)` : text;
}

/** Resumo de uma chamada de ferramenta: o argumento que identifica o que ela faz. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof i[k] === 'string' && i[k]) return String(i[k]);
    return '';
  };
  const first = pick('file_path', 'path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'prompt', 'skill');
  return first.split('\n')[0]!.slice(0, 160) || name;
}

export function inputText(input: unknown): string {
  try {
    return clip(typeof input === 'string' ? input : JSON.stringify(input, null, 2), MAX_INPUT);
  } catch {
    return '';
  }
}

/** Conteúdo de um tool_result: texto direto ou lista de blocos. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return clip(content, MAX_RESULT);
  if (Array.isArray(content)) {
    const parts = content.map((b) => {
      const block = b as { type?: string; text?: string };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : block.type ? `[${block.type}]` : '';
    });
    return clip(parts.filter(Boolean).join('\n'), MAX_RESULT);
  }
  return '';
}

/**
 * Texto que o Claude Code injeta como se fosse do usuário (lembretes do sistema, saída de
 * comandos locais, avisos). Não é o que a pessoa digitou: fica fora da conversa.
 */
export function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<system-reminder>') ||
    t.startsWith('<local-command') ||
    t.startsWith('<command-') ||
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted') ||
    // Aviso do próprio Claude Code de que uma tarefa em segundo plano terminou (não é você falando).
    t.startsWith('<task-notification>')
  );
}
