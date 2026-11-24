// Os textos fixos da entrega: o que o funcionário recebe ao começar a tarefa (formato da entrega e as 2 linhas de escopo), o que o gestor declara no
// critério de pronto e a rubrica do revisor. Valem para todos os projetos e funcionários, nos dois motores: o texto é o mesmo (nada aqui depende do motor).
// Sem importações: o brief (`tasks.ts`) e a ficha (`staff/ficha.ts`) leem daqui, e a mesma frase não pode divergir entre eles.

/** A lista de arquivos do pedido é orientação, não limite. */
export const SCOPE_LINE =
  'A lista de arquivos do pedido é orientação, não limite: criar um helper ou um teste novo ligado à tarefa pode, com uma linha de justificativa na entrega; mudança fora do assunto da tarefa, não.';

/** Premissa do pedido que o código desmente: pergunta antes, não adapta por conta própria. */
export const PREMISE_LINE =
  'Se a premissa do pedido não bate com o código (o comportamento descrito já é outro no HEAD, o arquivo citado não existe etc.), mande a DÚVIDA antes de implementar, em vez de adaptar o pedido por conta própria.';

/** O fim da tarefa: a última mensagem é a entrega, neste formato e nesta ordem (igual no texto de início, na retomada e no handoff). */
export const DELIVERY_FORMAT = [
  'Quando terminar, a sua última mensagem é a entrega, curta e neste formato fixo, nesta ordem (o Claudio’s Club já anexa o critério de aceite e roda o tsc e os testes relacionados aos arquivos que você alterou, com comando, código de saída, contagem e a comparação com a base: não os copie nem os redigite):',
  '1. Critério de pronto: um item por linha, pelo NÚMERO ou por um trecho curto dele (sem copiar o texto do item), com feito, não feito ou parcial (e o motivo, se não for feito).',
  '2. Testes do tema: só os que VOCÊ rodou além dos relacionados que o Club anexa: os arquivos e a contagem (passaram e falharam), sem colar a saída; se não rodou nenhum além deles, escreva "só os relacionados".',
  '3. Prints: o caminho absoluto de cada um, com a hora, quando o critério pedir.',
  '4. O que ficou de fora e por quê.',
].join('\n');

/** As linhas que fecham o texto da tarefa (início, retomada na fila e handoff de troca de motor), na ordem em que entram. */
export const BRIEF_RULES: string[] = [SCOPE_LINE, PREMISE_LINE, DELIVERY_FORMAT];

/** Ficha do gestor: as provas exigidas vão no critério de pronto, só elas. */
export const REQUIRED_PROOFS_LINE =
  'Provas exigidas: o critério de pronto (acceptance) diz quais provas a entrega precisa trazer (ex.: prints em 360, claro e escuro; teste de X; docs/uso), e só elas. A revisão cobra o que o critério pede: falta de prova exigida reprova, prova que o critério não pede não. O tsc e os testes relacionados aos arquivos alterados o Claudio’s Club roda e anexa ao pedido de revisão (com comando, saída, contagem e a comparação com a base): não exija o executor de digitá-los no critério de pronto. A entrega chega em formato fixo, sem repetir o que o Claudio’s Club já anexa (cada item do critério pelo número, com feito, não feito ou parcial, sem copiar o texto; testes do tema com arquivos e contagem, sem a saída; caminho absoluto e hora de cada print quando o critério pedir; o que ficou de fora).';

/** A rubrica única do revisor (pedido de revisão e ficha do gestor): o que reprova e o que não reprova. */
export const REVIEW_RUBRIC = [
  'Rubrica da revisão (a mesma para quem revisa):',
  '- Reprova (🔴): bug, regressão, falha de segurança, item do critério de pronto não cumprido e falta de prova que o critério exige.',
  '- Não reprova (no máximo 🟡 ou 🟢): prova que o critério não pede (se valer a pena, vira follow-up) e arquivo fora da lista do pedido quando é do assunto (a lista é orientação, não limite); só escopo fora do assunto reprova.',
  '- Provas do Claudio’s Club (tsc e testes relacionados, anexados ao pedido): o executor não as redigita, e a falta delas no relato dele não reprova. Só falha NOVA (que não já falhava na base) e que vem dos arquivos da tarefa conta contra a entrega; erro de tsc ou falha de teste que já existia na base ou que não vem dos arquivos da tarefa é no máximo 🟡. Prova marcada "indisponível" ou "não se aplica" não reprova e não consome rodada.',
  '- Na dúvida sobre a premissa do pedido (o código já é outro, o arquivo citado não existe), pergunte em vez de reprovar.',
].join('\n');
