// Hook UserPromptSubmit do Claudio’s Club: a cada mensagem do usuário, lembra o estilo de comunicação da pessoa
// (o arquivo style.txt da conversa, gravado em server/staff/launch.ts a partir de personalityReminder).
//   argv[2]: caminho absoluto do style.txt.
// Lê o arquivo e responde em JSON no stdout com o texto em additionalContext. Qualquer erro, ou arquivo vazio:
// não responde nada, e a mensagem do usuário segue normalmente (o hook nunca bloqueia).
import { readFileSync } from 'node:fs';

try {
  const texto = readFileSync(process.argv[2], 'utf8');
  if (texto.trim()) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: texto } }));
  }
} catch {
  // sem arquivo ou sem leitura: sem resposta
}
