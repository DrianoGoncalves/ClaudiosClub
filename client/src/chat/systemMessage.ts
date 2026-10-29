// Mensagens que a plataforma manda na conversa no lugar do usuário (entrega de tarefa, aviso de
// contexto…). Chegam como mensagem do usuário, com um prefixo no começo: "[MyCo] …" hoje, e
// "[Claudio’s Club] …" (aspa reta ou curva) quando o nome mudar no servidor.

const PREFIX = /^\s*\[(?:MyCo|Claudio['’]s Club)\][ \t]*/;

/** O texto sem o prefixo, se for mensagem automática da plataforma; senão, null. */
export function systemMessageText(text: string): string | null {
  const m = PREFIX.exec(text);
  return m ? text.slice(m[0].length) : null;
}
