# Consumo e motores

- **Consumo** é a parte da assinatura já usada. O Club mostra e pode parar antes de passar do limite.
- **Motor** é o programa que roda um funcionário: **Claude** ou **Codex (GPT)**. A escolha é por ficha.

## Barras de consumo (topo do quadro)

- Linha **Claude**: barras **5h** e **7d**, com a porcentagem e o tempo até reiniciar.
- Cores: verde abaixo de 50%, amarelo de 50% a 69%, vermelho a partir de 70%.
- Passe o mouse para ver "reinicia em {tempo}" (ou "reiniciou") e "lido {tempo atrás}". O link abre o uso do Claude numa nova aba.
- Sinal "+" no ícone do Claude: a **Otimizar assinatura** está ativa (ver a tabela de travas abaixo).
- Sem leitura, aparece uma destas mensagens:
  - "consumo: instale o myco-tap": rode `npm run mod:install`.
  - "consumo: abra uma sessão nova no app": abra uma sessão nova no app e mande uma mensagem.
- Linha **Codex**: as mesmas barras 5h e 7d. Só aparece com **Usar o Codex (GPT)** ligado.

## Travas e limites (Configurações, grupo **Consumo**)

| Item | O que faz |
| --- | --- |
| **Trava de consumo: 5 horas** e **Trava de consumo: 7 dias** | Passando da porcentagem definida, o Club pergunta antes de conversar ou abrir sessão. Vazio = sem trava. Cada ficha pode ter a sua. |
| **Continuar sozinho quando o limite de uso voltar** | Se o limite acabar no meio de uma conversa, ela manda "continue" assim que o limite voltar. |
| **Otimizar assinatura** | Nas 48 h antes do reset da cota de 7 dias, se no seu ritmo ia sobrar 30% ou mais, as conversas vão para o Opus em esforço máximo e os agents pensam mais, até a folga acabar. Espera se o limite de 5 h passar de 50%. As respostas ficam mais lentas. |
| **Orçamento por projeto** | Porcentagem da cota de 7 dias que cada projeto pode usar. Passando dela, o Club pergunta antes de conversar nesse projeto. Vazio = sem orçamento. |

## Motor por ficha

- Na ficha do funcionário, campo **Motor**: **Claude** ou **Codex (GPT)**.
- **Codex (GPT)** roda numa sandbox: só o projeto, sem internet. Precisa de **Usar o Codex (GPT)** ligado. Com ele desligado, a conversa de quem roda no Codex não abre.
- Quem tem servidor na ficha não pode rodar no Codex. Para escolher o Codex, tire os servidores na aba **Projeto**.

## Motor secundário (troca ao bater o limite)

- Na ficha, seção **Motor secundário (quando o principal bater o limite)**: ligue **Usar motor secundário** e informe o modelo.
- O secundário é sempre o outro motor.
- Sem secundário, a tarefa espera o limite do principal voltar.
- Conta como limite do principal tanto o limite de uso do provedor quanto a trava de 5 h ou 7 dias. O orçamento do projeto não conta.

Quando o principal estoura o limite:

| Momento | O que acontece |
| --- | --- |
| A tarefa começa com o principal no limite | Começa direto no secundário ("Começou direto no motor secundário..."), se o secundário estiver disponível. Senão, fica na fila até o limite baixar. |
| O limite estoura no meio do trabalho | Passa para o secundário numa conversa nova, com o resumo da anterior ("Trocou no meio..."). |

A troca **não acontece** (a tarefa espera) quando:

- o limite do principal volta em menos de 15 minutos;
- o secundário também está no limite;
- não dá para ler o limite do secundário (sem leitura, não troca às cegas);
- a tarefa já trocou de motor uma vez (não troca de novo).

Sinais na tela:

- No chat: o aviso **Conversa no motor secundário** (com **Não avisar nesta sessão**) e o selo **No motor secundário: {motor} · {modelo}**.
- No cartão da tarefa: o selo **no secundário: {motor} · {modelo}**. O tooltip mostra o motivo e a data da troca.
- Se a ficha trocar o secundário depois, a conversa volta ao motor principal.

## Segunda opinião do Codex (tarefas)

- No cartão da tarefa, seção **Código, revisão e deploy**, aparece **Pedir ao Codex** (ou **Pedir de novo**).
- Só aparece com **Usar o Codex (GPT)** ligado, com o Codex instalado e logado, e quando a tarefa tem mudanças.
- O Codex revisa o diff ("O Codex está revisando… leva alguns minutos"). Vai só o diff, sem arquivos de segredo, e gasta a cota do seu ChatGPT.
- O resultado fica no cartão, em **O que o Codex achou**.

## Ranking

- O botão **Ranking** no topo do quadro abre o painel lateral.
- Aba **Gastos** ("Quem mais gasta"): a parte de cada um no consumo total. Serve para comparar; as sessões rodam pela assinatura.
- Aba **Economia** ("Quem mais economiza"): estimativa, comparada com o chefe fazendo tudo no modelo dele.
- **Período**: **Hoje**, **7 dias**, **1 mês**, **Últimos 3 meses** (padrão) ou **Tudo**.
- Enquanto os transcripts são lidos, aparece "Ainda lendo os transcripts: os números vão crescer."
- Na aba **Gastos**, a linha de quem tem ficha tem um botão de lupa, **Analisar o custo de {nome}**. Conversa sem ficha (**Freela**) só leva ao nó no quadro.

## Revisão de custo

Pelo ranking, a lupa analisa o período escolhido. A análise só lê: não usa IA e não altera nada. Ela olha a ficha, a memória, as tarefas e as conversas do funcionário no período.

1. O painel mostra os números: **Conversas**, **Chamadas**, **Maior contexto**, **Cache lido**, **Saída**, **Memória**, **Tarefas** e **Ficha**.
2. Os achados aparecem por prioridade: **Prioridade alta**, **Prioridade média** e **Prioridade baixa**.
3. Achados com caixa marcada têm ajuste que o Club sabe aplicar. As caixas vêm marcadas. Os demais são só sugestão.
4. **Aplicar sugestões (n)** abre a confirmação "Isto vai mudar em {nome}:". Use **Confirmar e aplicar** ou **Voltar**.
5. Depois de aplicar, aparecem **Aplicado (n)**, com link para a tarefa criada (se houver), e **Não aplicado (n)**, com o motivo.

Achados possíveis (título na tela):

- Contexto muito longo
- Aviso de contexto ignorado
- Modelo pesado em implementação
- Sem modelo definido na ficha
- Memória grande
- Saídas de ferramenta grandes
- Leituras repetidas
- Agents herdando o modelo caro
- Retrabalho

O que cada ajuste mexe:

- **Ficha**: troca o modelo e/ou o esforço do funcionário.
- **Regra**: acrescenta uma regra à ficha (a ficha tem limite de 50 regras).
- **Tarefa**: cria e começa uma tarefa (por exemplo, **Compactar a memória**), com o ID dela no resultado.

Motivos de "não aplicado":

- "não dispara mais": o achado sumiu na análise nova.
- "sem ajuste automático": é só sugestão.
- "já aplicado".
- "limite de regras da ficha".

Regras importantes:

- Só se aplica pela tela do projeto. O funcionário não aplica a própria revisão.
- Modelo, esforço e regras valem para todas as cópias da pessoa em outros projetos. A conversa aberta dela recebe o aviso de ficha atualizada.
- Sem achados no período: "Nada a ajustar no período".
