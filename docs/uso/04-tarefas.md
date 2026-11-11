# Tarefas

Tarefa é um pedido de trabalho para um funcionário. Cada tarefa tem uma conversa própria com ele, e o quadro mostra em que pé ela está.

## Abrir o quadro

- No painel do projeto, botão **Tarefas**.
- No nó do projeto no quadro, o selo de tarefas em revisão também abre o quadro.
- O título é "Tarefas · {nome do projeto}". O quadro relê as tarefas a cada 5 segundos.
- Fecha pelo **×** ou com Esc. Com um cartão aberto, Esc fecha só o cartão.
- No cabeçalho: **Agendamentos** (ver 05) e **Nova tarefa**.

## Colunas

| Coluna | O que quer dizer |
| --- | --- |
| **Aguardar** | Parada. Não começa sozinha nem entra na fila. O campo **Motivo (opcional)** fica no cartão. |
| **A fazer** | Na fila. Começa sozinha quando o funcionário entrega a atual. |
| **Fazendo** | Trabalhando. Inclui as tarefas com plano para aprovar (selo **Plano para aprovar**). |
| **Revisão** | Ele terminou um turno. Confira a entrega. |
| **Pronto** | Entregue e conferido. |

- Para mudar de coluna, arraste o cartão, ou no detalhe use **Mover para a coluna** (opções "mover: ...").
- Em **Pronto**, tarefa sem mudança há mais de 7 dias vai para **Ver arquivadas (n)**. Mudar de coluna tira do arquivo.
- O selo **Não publicado** aparece em **Pronto** nos projetos com funcionário que tem servidor. Ele não some quando o deploy é pedido.

## Criar tarefa

1. Clique em **Nova tarefa**.
2. Preencha **Título** (até 120 caracteres), **O que precisa ser feito** e **Quem cuida**.
3. Opcional: marque **Revisão automática** e escolha **Quem revisa** (outro funcionário do projeto).
4. Escolha:
   - **Criar e começar**: cria e manda para ele numa conversa nova. Precisa de **Quem cuida**. Se ele estiver ocupado, a tarefa entra na fila dele.
   - **Só criar**: cria em **Aguardar**.
   - **Cancelar**: não cria nada.

## Começar e fila

- Cartão sem conversa: botão **Começar**. Com o funcionário ocupado, o botão vira **Pôr na fila**.
- Cada funcionário faz uma tarefa por vez. A posição aparece no cartão ("na fila · 1ª") e no detalhe.
- Quando ele fica livre, o Club manda primeiro os ajustes guardados e depois a próxima da fila.
- **tirar da fila** desfaz a entrada na fila.
- Mensagem enviada à conversa de uma tarefa enquanto ele está ocupado fica guardada ("{n} ajuste esperando") e vai quando ele termina.
- Se o consumo estiver no limite na hora de começar, a tarefa fica na fila e tenta de novo.
- Se a conversa parar no meio do trabalho (por exemplo, o servidor reiniciou), o Club retoma uma vez. Se parar de novo, a tarefa vai para **Revisão** com "conversa parou sem terminar" no histórico.
- O responsável só pode ser trocado antes de começar. Depois, aparece "A tarefa já começou com este funcionário".

## Plano para aprovar

Se a ficha do funcionário está em **Só planeja**, ao começar a tarefa vai para **Planejando**. No quadro ela aparece em **Fazendo**, com o selo **Plano para aprovar**. Você decide no cartão de plano do chat:

| Botão | Efeito |
| --- | --- |
| **Aprovar e executar** | Vai para **Fazendo** e executa. O plano fica guardado no cartão (**Plano aprovado**). |
| **Pedir mudanças** | Continua só planejando. Escreva o que mudar. |
| **Recusar plano** | Não executa. A tarefa vai para **Aguardar**, e quem pediu a tarefa é avisado. |

## Entrega e revisão

- Quando o turno dele termina, a tarefa vai para **Revisão** sozinha. Se o código está numa worktree, o Club faz um commit com o título da tarefa.
- Mensagem sua na conversa da tarefa, com ela em **Revisão**, volta a tarefa para **Fazendo**.
- A seção **Código, revisão e deploy** mostra o que mudou, o **Resumo da entrega** e o diff.
- **Aprovar entrega** (em **Revisão**) manda a tarefa direto para **Pronto**. Esse botão não roda testes nem mescla.

### Delegar revisão (manual)

Na seção **Revisão**, escolha **Quem revisa** e clique em **Delegar revisão** (ou **Delegar nova revisão**). O revisor responde com APROVADO ou REPROVADO na primeira linha.

- Aprovada: vai para **Pronto**. Se o código ainda está numa worktree sem mesclar, fica em **Revisão** ("aprovada; falta mesclar a worktree").
- Reprovada: os ajustes voltam para quem fez, e a tarefa volta para **Fazendo**. Se ele estiver ocupado, o ajuste fica guardado e a tarefa segue em **Revisão**.
- O revisor não muda o código: só revisa.

### Revisão automática

- Com **Revisão automática** marcada, ao entregar, o revisor escolhido revisa sozinho, com o mesmo veredito.
- O Club faz no máximo **2** revisões automáticas por tarefa. Depois disso, o que sobrar fica com você, anotado no histórico.
- Atenção: o cartão mostra `n/3` e a opção diz "até 3 rodadas", mas o limite que vale é 2.
- Precisa de outro funcionário no projeto. Se quem pediu a tarefa é o revisor, ele recebe só o resultado.

## Testes, mesclar e deploy

- **Rodar testes**: aparece se o projeto tem comando de teste (`npm test`, `composer test` ou `phpunit`). O cartão mostra **Testes** com "passaram" ou "falharam". Se falhou, **Saída dos testes** mostra o fim do log.
- **Mesclar em {base}** (só com código em worktree): pede confirmação, roda os testes e mescla. Teste vermelho desfaz a mescla. Se não há teste para rodar, o Club pergunta se mescla mesmo assim. Depois de mesclada, a tarefa vai para **Pronto** e mostra "mesclada em ... (commit)".
- **Pedir deploy** (em tarefa **Pronto** ou mesclada): escolha **Quem faz o deploy**. Só aparecem funcionários com servidor na ficha. O checklist pede backup, estado antes e depois, e runbook. Ele pede confirmação antes de qualquer passo que não tem volta.
- **Pedir ao Codex** (segunda opinião): aparece só com **Usar o Codex (GPT)** ligado. Ver 06.

## Editar, apagar e id

- Editáveis: **Título**, **Descrição**, **Quem cuida**, **Revisão automática**, **Quem revisa** e **PR** (link https). O botão **Salvar** aparece quando título, descrição ou PR mudam.
- **Apagar tarefa** pede confirmação. A conversa continua com o funcionário.
- Se o funcionário é excluído, as tarefas abertas dele ficam sem responsável ("responsável excluído" no histórico).
- O **ID da tarefa** aparece no cartão e no topo do detalhe. Tem o formato `t-` seguido de 6 caracteres hexadecimais. É o código para citar numa dúvida.
- **Histórico** lista cada mudança, marcada como "automático" ou "você".
