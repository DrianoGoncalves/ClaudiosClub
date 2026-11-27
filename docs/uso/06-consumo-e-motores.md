# Consumo e motores

- **Consumo** é a parte da assinatura já usada. O Club mostra e pode parar antes de passar do limite.
- **Motor** é o programa que roda um funcionário: **Claude** ou **Codex (GPT)**. A escolha é por ficha.

## Barras de consumo (topo do quadro)

- Linha **Claude**: barras **5h** e **7d**, com a porcentagem e o tempo até reiniciar.
- Cores: verde abaixo de 70%, amarelo de 70% a 89%, vermelho a partir de 90%.
- Na barra **7d**, o fundo da barra tem uma listra que mostra o ritmo: quanto da cota ainda resta por dia até reiniciar. Verde: 14% por dia ou mais (sobra). Amarelo: de 7% a menos de 14% (aperta). Vermelho: abaixo de 7% (apertado). Nas últimas 24 h o texto passa a "restam N% até reiniciar".
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
| **Otimizar assinatura** | Nas 72 h antes do reset da cota de 7 dias, se no seu ritmo ia sobrar cota (30% faltando 3 dias, caindo até 10% no último dia), as conversas vão para o Opus em esforço máximo e os agents pensam mais, até a folga acabar. Espera se o limite de 5 h passar de 50%. As respostas ficam mais lentas. |
| **Orçamento por projeto** | Porcentagem da cota de 7 dias que cada projeto pode usar. Passando dela, o Club pergunta antes de conversar nesse projeto. Vazio = sem orçamento. |

## Motor por ficha

- Na ficha do funcionário, campo **Motor**: **Claude** ou **Codex (GPT)**.
- **Codex (GPT)** roda numa sandbox: só o projeto, sem internet. Precisa de **Usar o Codex (GPT)** ligado. Com ele desligado, a conversa de quem roda no Codex não abre.
- **SSH** vale nos dois motores: quem roda no Codex também opera servidores, pelo mesmo MCP `myco-ssh` do Club (ver **Servidores (SSH e FTP)** em `02-funcionarios.md`). Nessa conversa o Codex fica sem busca na web e sem o Chrome.
- **FTP** só funciona no Claude. Com conexão FTP marcada na ficha, o botão do Codex fica desligado: para escolher o Codex, tire as conexões FTP na aba **Projeto**.

## Codex no Windows: o terminal e a política de senha

No Windows, a sandbox do Codex roda os comandos de terminal por usuários locais do próprio Windows (`CodexSandboxOffline` e `CodexSandboxOnline`) e troca a senha deles a cada preparação. Se a política de senha do Windows exige uma **duração mínima da senha** maior que 0 dia, o Windows recusa a troca (erros 2224 e 2245) e **nenhum comando de terminal do Codex roda** nesta máquina. O funcionário só diz que o terminal está bloqueado; no texto do erro aparece `helper_user_create_or_update_failed`.

- **Como você fica sabendo:** o Club lê a política (só lê, com `net accounts`) ao abrir uma conversa do Codex e ao salvar uma ficha do Codex, e também quando o erro aparece num comando. Achando o problema, mostra "O terminal dos funcionários no Codex não funciona nesta máquina" de dois jeitos: um item **erro** em **Inbox** e um balão vermelho, o mesmo aviso, em toda conversa de quem roda no Codex (a conversa do Claude não vê). Só no Windows, e só quando há ficha ou conversa do Codex. O item é da máquina, sem projeto nem conversa: clicar na linha não abre nada, o que se faz está no próprio aviso.
- **Como resolver:** abra o PowerShell **como administrador** (botão direito no PowerShell → **Executar como administrador**) e rode `net accounts /minpwage:0`. O aviso traz esse comando com o botão **Copiar**; sem administrador o Windows nega o comando. Se o navegador não deixar copiar, o aviso diz para selecionar o comando e usar Ctrl+C. Depois, o aviso some sozinho na próxima conferência (ao abrir uma conversa do Codex, com até 10 minutos de intervalo) e o terminal volta; mande uma mensagem nova ao funcionário.
- **O Club não roda o comando por você:** ele muda a política de segurança da máquina e exige administrador. Só o botão **Copiar** existe.
- **Computador de domínio** (empresa, escola): a política de grupo pode desfazer a mudança e o erro volta. Peça a quem administra a rede para liberar a duração mínima da senha.
- **A duração já está em 0:** o aviso diz isso e não traz comando. O motivo é outra regra de senha do Windows (tamanho mínimo, histórico): rode `net accounts` e confira com quem administra a máquina.
- **Não deu para ler a política:** o aviso diz que a causa mais comum é a duração mínima da senha, pede para rodar `net accounts` e, se a duração mínima for maior que 0, rodar o comando como administrador.
- **Ignorar:** o **×** na caixa (ou **Ignorar** no balão) tira o aviso dos dois lugares. Ele só volta se a política passar a 0 e falhar de novo. O aviso vive só na memória do Club: um reinício refaz a conferência.

## Agents da ficha no Codex

Os agents da ficha (os do projeto e os da conta, em `.claude/agents`) rodam no Codex como **subagents**.

- O Club grava a definição de cada agent numa pasta da conversa. A sandbox nega o acesso a essa pasta: o agent não lê nem troca a própria definição.
- O **modelo** do agent não vale no Codex (o apelido do Claude não existe lá): o subagent usa o modelo da conversa. O **esforço** vem do agent, se ele diz; senão do modelo dele (Haiku: baixo, Sonnet: médio, Opus: alto). Com modelo desconhecido, o subagent segue o esforço da conversa.
- **Somente leitura é só instrução.** O agent sem ferramenta de escrita nem de terminal (como o **Pesquisador**) recebe a ordem de só ler. Mas no Codex ele roda na mesma sandbox de quem o chamou e **consegue escrever**: não conte com isso como trava de proteção.
- Os agents do roteiro da ficha (**Executor**, **Executor rápido**, **Pesquisador**, **Revisor**, conforme o roteiro) são criados na hora, se faltarem. Na ficha, **Quem ajuda neste roteiro** mostra, para cada um, "modelo da conversa" e o esforço.
- No Codex, a diferença entre o **Executor** (implementa) e o **Executor rápido** (tarefa mecânica) é só o esforço (Medium e Low): o modelo é o da conversa. Para o Codex gastar menos, o ganho está no esforço, não no modelo.
- Agent que a ficha pede e não existe em `.claude/agents` fica de fora: a ficha da conversa lista os que faltam e manda o funcionário avisar você.
- Precisa de subagents no Codex instalado (recurso `multi_agent`). Sem ele, os agents não rodam.

## Motor secundário (troca ao bater o limite)

- Na ficha, seção **Motor secundário (quando o principal bater o limite)**: ligue **Usar motor secundário** e informe o modelo.
- O secundário é sempre o outro motor.
- Sem secundário, a tarefa espera o limite do principal voltar.
- Conta como limite do principal tanto o limite de uso do provedor quanto a trava de 5 h ou 7 dias. O orçamento do projeto não conta.

Quando o principal estoura o limite:

| Momento | O que acontece |
| --- | --- |
| A tarefa começa com o principal no limite | Começa direto no secundário ("Começou direto no motor secundário..."), se o secundário estiver disponível e a pré-checagem passar. Senão, fica na fila até o limite baixar. |
| O limite estoura no meio do trabalho | Passa para o secundário numa conversa nova, com o resumo da anterior ("Trocou no meio..."), se a pré-checagem passar. Senão, segue como antes e espera o limite voltar. |
| Você manda uma mensagem no chat | Passa para o secundário numa conversa nova, se a pré-checagem passar. Senão, a mensagem fica barrada com o aviso de limite de sempre. |

A troca **não acontece** (a tarefa espera) quando:

- o limite do principal volta em menos de 15 minutos;
- o secundário também está no limite;
- não dá para ler o limite do secundário (sem leitura, não troca às cegas);
- a tarefa já está no secundário (não troca de novo enquanto estiver lá; depois de voltar ao principal, uma nova troca segue as mesmas regras);
- a **pré-checagem** do secundário não passa (ver abaixo).

### Volta ao motor principal

A troca **não é definitiva**. A tarefa que foi para o secundário volta sozinha ao principal, **em conversa nova**, na próxima vez em que o funcionário retoma o trabalho dela com o principal liberado. O limite liberar não move nada por si: a volta espera uma retomada. Contam como retomada: a vez dela na fila de **A fazer**, uma conversa que parou no meio do turno, o reinício do servidor e a reprovação feita pelo revisor automático (sem ação sua), e o ajuste que você manda na conversa para reprovar e a resposta a uma dúvida (ações suas).

- **Liberado** é a mesma régua da troca: sem limite de uso do provedor e abaixo da trava de 5 h ou 7 dias. Sem leitura do limite do principal, a tarefa fica no secundário.
- A conversa nova abre no principal com o resumo da anterior (o mesmo da ida) e com o que chegou agora (o ajuste, a resposta). A antiga é encerrada, e o "continue" ou o despertador dela são cancelados.
- Nunca no meio de um turno: com a conversa trabalhando, a volta espera a próxima retomada.
- Não volta: cartão registrado automaticamente, tarefa encerrada e ficha em modo plano fora de **Planejando**.
- Ajuste com print, ou enviado por outro funcionário, **não vai pela conversa nova** (ela abre só com texto): o ajuste segue na conversa do secundário, e quem espera é a volta, que fica para a próxima retomada.
- Se a conversa nova não abrir (erro do motor), a tarefa segue no secundário e o histórico diz por quê.
- Se o principal bater o limite de novo depois da volta, a tarefa pode trocar outra vez, pela regra de sempre. A volta é uma por retomada: não há vai e vem.

### Pré-checagem do secundário

Antes de trocar, o Club confere, sem abrir nada, se a conversa nova abriria no secundário. Só troca se tudo passar:

- a ficha está íntegra e passa nas regras dela, e o secundário não passou da trava de consumo dele;
- se o secundário é o Codex: ele está ligado e instalado, o modelo está no catálogo da sua conta, tem subagents e todos os agents da ficha existem para ele (ver **Agents da ficha no Codex**);
- se o secundário é o Codex: a sandbox abre. No Windows, não troca com **outra conversa do Codex rodando** (duas ao mesmo tempo derrubam a sandbox uma da outra). Depois de uma falha real da sandbox, o Club segura novas conferências por 5 minutos.

Se a pré-checagem não passa, a tarefa **não cai no secundário**: espera o limite do principal baixar e avisa.

- A fila confere de novo a cada rodada. Se passar (por exemplo, a outra conversa do Codex terminou), a tarefa troca e começa no secundário. Se o limite baixar antes, ela começa no principal.
- No meio do trabalho, a conversa fica no principal e continua quando o limite voltar. O histórico da tarefa anota "troca para {motor} não feita: {motivo}; segue como antes".

Sinais na tela:

- No chat: o aviso **Conversa no motor secundário** (com **Não avisar nesta sessão**) e o selo **No motor secundário: {motor} · {modelo}**.
- No cartão da tarefa: o selo **no secundário: {motor} · {modelo}**. O tooltip mostra o motivo e a data da troca.
- Quando a tarefa volta ao principal, o selo do secundário **some** e entra o selo **voltou ao principal: {motor}** (borda contínua; o do secundário é tracejado), enquanto a tarefa estiver aberta. O detalhe da tarefa escreve a volta (**Voltou ao {motor} em {data e hora}: o limite liberou…**), e o **Histórico** traz a nota "motor principal liberado: voltou ao {motor} em conversa nova, com o resumo da anterior". Se a conversa nova não abriu, a nota diz o motivo e o selo do secundário continua.
- Se a ficha trocar o secundário depois, a conversa volta ao motor principal.
- Tarefa que espera sem trocar: no cartão, o selo **Sem troca: espera o limite do {motor} voltar** (laranja em **A fazer**, neutro nas outras colunas). O tooltip e o detalhe da tarefa dizem o motor que não serve, o motivo (**sandbox indisponível**, **agents indisponíveis**, **modelo indisponível** ou **a troca não abre**, com a mensagem do servidor) e a hora em que o limite volta. O selo some quando o limite passa ou a tarefa começa.
- Na caixa de avisos, a tarefa aparece como parada, sem botão: é só informação (**Volta sozinha, sem ação sua**) e some sozinha quando o limite baixa.

## Segunda opinião do Codex (tarefas)

- No cartão da tarefa, seção **Código, revisão e deploy**, aparece **Pedir ao Codex** (ou **Pedir de novo**).
- Só aparece com **Usar o Codex (GPT)** ligado, com o Codex instalado e logado, e quando a tarefa tem mudanças.
- O Codex revisa o diff ("O Codex está revisando… leva alguns minutos"). Vai só o diff, sem arquivos de segredo, e gasta a cota do seu ChatGPT.
- O resultado fica no cartão, em **O que o Codex achou**.

## Ranking

- O botão **RH e ranking** (ícone de pessoas) no topo do quadro abre o painel lateral, com as abas **RH**, **Gastos** e **Economia**.
- Aba **Gastos** ("Quem mais gasta"): a parte de cada um no consumo total. Serve para comparar; as sessões rodam pela assinatura.
- Aba **Economia** ("Quem mais economiza"): estimativa, comparada com o chefe fazendo tudo no modelo dele.
- **Período**: **Hoje** (padrão), **7 dias**, **1 mês**, **Últimos 3 meses** ou **Tudo**.
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
