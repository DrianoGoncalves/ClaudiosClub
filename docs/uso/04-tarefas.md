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
| **A fazer** | Deve ser iniciada. Com responsável, começa sozinha (ou entra na fila dele). Sem responsável, espera. Para não começar, deixe em **Aguardar**. |
| **Fazendo** | Trabalhando. Inclui as tarefas com plano para aprovar (selo **Plano para aprovar**). |
| **Revisão** | Ele terminou um turno. Confira a entrega. Cartão com subtarefa aberta não vem para cá (veja **Subtarefas**). |
| **Finalizado** | Revisão concluída. |

- Para mudar de coluna, arraste o cartão, ou no detalhe use **Mover para a coluna** (opções "mover: ...").
- Em **Finalizado**, tarefa sem mudança há mais de 7 dias vai para **Ver arquivadas (n)**. Mudar de coluna tira do arquivo.
- O selo **Não publicado** aparece em **Finalizado** nos projetos com funcionário que tem servidor. Ele não some quando o deploy é pedido.

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
- Arrastar ou mover um cartão com responsável para **A fazer** faz o mesmo que **Começar**: começa na hora, ou entra na fila dele.
- Cada funcionário faz uma tarefa por vez. A posição aparece no cartão ("2º na fila de Beakman") e no detalhe. Para mudar a ordem, veja **Ordem da fila** abaixo.
- Quando ele fica livre, o Club manda primeiro os ajustes guardados e depois a próxima da fila.
- **tirar da fila** desfaz a entrada na fila.
- Mensagem enviada à conversa de uma tarefa enquanto ele está ocupado fica guardada ("{n} ajuste esperando") e vai quando ele termina.
- Se o consumo estiver no limite na hora de começar, a tarefa fica na fila e tenta de novo.
- Na coluna **A fazer**, todo aviso de espera do cartão ("Esperando: …", "Aguardando recursos", ajuste guardado e dúvida com o gestor) aparece em laranja: é o motivo de a tarefa não andar. Nas outras colunas, inclusive **Aguardar** (selos e o campo do motivo), os avisos ficam neutros. O amarelo segue sendo o que depende de você.
- A **posição na fila** ("2º na fila de Beakman") não é aviso: fica no visual padrão, sem laranja, em qualquer coluna.
- O "Esperando: …" some quando a tarefa de que ela depende é aprovada pelo revisor (mesmo que ainda falte mesclar a worktree): sobra só a posição na fila. A tarefa só começa quando a dependência fica **Finalizada**.
- Se a conversa parar no meio do trabalho (por exemplo, o servidor reiniciou), o Club retoma uma vez. Se parar de novo, a tarefa vai para **Revisão** com "conversa parou sem terminar" no histórico.
- Exceção: se ela parou no meio de uma ação que mexe fora do projeto (push, deploy, comando no servidor, MCP que escreve), o Club não retoma sozinho, porque não dá para saber se a ação aconteceu. A tarefa vai para **Aguardar** com o motivo, e a conversa aparece em **precisa de mim**. Confira e mande uma mensagem para seguir.
- Fora o reinício do servidor (acima), se a conversa cair por falha passageira (API sobrecarregada, erro 5xx, limite de taxa, queda de conexão) ou o processo cair no meio do turno, o Club retoma sozinho, com espera crescente (30 s, 2 min e 8 min, com uma variação de até 20%) e até 3 tentativas (1, quando o processo caiu sem causa conhecida). Se o próprio erro pede uma espera maior, vale a maior, até 15 min; acima disso não é falha passageira e não retoma. Enquanto a retomada está marcada, a tarefa fica em **Fazendo** e o cartão ganha o selo **Retomando em 42s · 2/3** (a tentativa 2 de 3). Passou da hora e ainda aparece: **Retomando agora**, o envio está em curso. O selo não é laranja: o laranja é só da coluna **A fazer**. Passando o mouse, o selo traz o motivo e a hora; no detalhe da tarefa, a frase inteira.
- O selo some quando a retomada sai, quando você manda uma mensagem na conversa (isso cancela a retomada) ou quando as tentativas acabam. Acabando as tentativas, ou se a conversa parou no meio de uma ação que mexe fora do projeto, a tarefa vai para **Aguardar** como na exceção acima, e a conversa aparece em **precisa de mim**. O que é e o que não é retomado sozinho, e o aviso no chat, estão no capítulo 03 (**Retomada automática**). Para desligar: **Configurações** → **Conversa** → **Retomar sozinho quando a conversa cair por falha passageira** (nível **Avançado**; padrão ligado).
- O responsável só pode ser trocado antes de começar. Depois, aparece "A tarefa já começou com este funcionário".

## Ordem da fila

A fila de cada funcionário anda na ordem em que os cartões entraram, até alguém reordenar. Quem entra depois vai para o fim. Em **A fazer**, cada cartão da fila mostra a posição ("1º na fila de Beakman"). A posição conta também os cartões bloqueados e os esperando nova tentativa: eles são pulados na hora de começar, mas não perdem o lugar.

| Quem | O que pode na ordem da fila |
| --- | --- |
| **Você** | Qualquer cartão da fila de qualquer funcionário: levar ao topo, subir ou descer um lugar, ou pôr no lugar de outro cartão. |
| **O gestor** (o funcionário que pediu o cartão) | Só os cartões que ele pediu, e só subir ou descer um lugar entre eles. Passar na frente de um cartão que outra pessoa pediu é só seu. |
| **O funcionário que faz a tarefa** | Não muda a ordem: só sugere (subir, descer ou ir ao topo, com o motivo). A sugestão vira aviso na conversa de quem pediu o cartão e nota no histórico dele, e a ordem não muda. Cartão pedido por você: ele diz a sugestão a você na conversa. |

- **Botões**: sob cada cartão da fila, três botões: **Subir para o topo da fila**, **Subir um lugar na fila** e **Descer um lugar na fila**. No detalhe do cartão eles aparecem com texto, ao lado de "Posição na fila de Beakman: 2 de 4". É o caminho do celular, onde arrastar não basta. O que já está no limite fica desligado (o primeiro não sobe, o último não desce).
- **Arrastar** (no computador): arraste um cartão para cima de outro cartão da **mesma** fila, e ele toma a posição do outro (o alvo ganha uma borda tracejada azul). Cartão de outro funcionário não aceita: a fila de cada um é separada. Soltar na coluna, fora de um cartão, continua só mudando de coluna.
- Só cartão que está na fila tem ordem: em **A fazer**, com responsável, esperando a vez dele. Cartão em **Aguardar**, fora da fila ("tirar da fila"), sem responsável ou já em andamento não tem botões. Sozinho na fila, também não.
- **Histórico**: cada movimento deixa uma nota no histórico do cartão movido, com quem mexeu e de onde para onde ("fila de Beakman reordenada por você: posição 3 → 1 de 4"; no caso do gestor, o nome dele). A sugestão do funcionário também aparece lá ("Beakman sugeriu passar para o topo da fila: …").
- Se a ordem mudou enquanto você olhava (o quadro relê a cada 5 segundos), o Club recusa o que já não vale ("já é o primeiro da fila", "a tarefa saiu da fila") e a mensagem aparece no quadro; nada é movido pela metade.
- Ao tirar o cartão da fila, mudar de coluna ou trocar o responsável, ele perde a posição e, ao voltar, entra no fim.

## Plano para aprovar

Se a ficha do funcionário está em **Só planeja**, ao começar a tarefa vai para **Planejando**. No quadro ela aparece em **Fazendo**, com o selo **Plano para aprovar**. Você decide no cartão de plano do chat:

| Botão | Efeito |
| --- | --- |
| **Aprovar e executar** | Vai para **Fazendo** e executa. O plano fica guardado no cartão (**Plano aprovado**). |
| **Pedir mudanças** | Continua só planejando. Escreva o que mudar. |
| **Recusar plano** | Não executa. A tarefa vai para **Aguardar**, e quem pediu a tarefa é avisado. |

## Entrega e revisão

- Quando o turno dele termina, a tarefa vai para **Revisão** sozinha, exceto se ainda houver subtarefa aberta (veja **Subtarefas**). Se o código está numa worktree, o Club faz um commit com o título da tarefa.
- Mensagem sua na conversa da tarefa, com ela em **Revisão**, volta a tarefa para **Fazendo**.
- A seção **Código, revisão e deploy** mostra o que mudou, o **Resumo da entrega** e o diff.
- **Aprovar entrega** (em **Revisão**) manda a tarefa direto para **Finalizado**. Esse botão não roda testes nem mescla.

### Delegar revisão (manual)

Na seção **Revisão**, escolha **Quem revisa** e clique em **Delegar revisão** (ou **Delegar nova revisão**). O revisor responde com APROVADO ou REPROVADO na primeira linha.

- Aprovada: vai para **Finalizado**. Se o código ainda está numa worktree sem mesclar, fica em **Revisão** ("aprovada; falta mesclar a worktree").
- Reprovada: os ajustes voltam para quem fez, e a tarefa volta para **Fazendo**. Se ele estiver ocupado, o ajuste fica guardado e a tarefa segue em **Revisão**.
- O revisor não muda o código: só revisa.

### Revisão automática

- Com **Revisão automática** marcada na tarefa, ao entregar, o revisor escolhido revisa sozinho, com o mesmo veredito. Para todas as tarefas do projeto de uma vez, use o revisor padrão do quadro (abaixo).
- O Club faz no máximo **3** revisões automáticas por tarefa (o cartão mostra `n/3`). Depois disso, o que sobrar fica com você, anotado no histórico.
- Precisa de outro funcionário no projeto. Se quem pediu a tarefa é o revisor, ele recebe só o resultado.
- Quando um funcionário passa várias tarefas a outros, ele só é avisado das aprovadas quando todas as tarefas que ele pediu fecharem: aí recebe uma única mensagem com a lista. O quadro mostra cada aprovação normalmente.
- Reprovação, limite de revisões, bloqueio e falha avisam na hora.

### Revisor padrão do quadro

Cada projeto tem, no topo do quadro de tarefas, **Revisão automática do quadro** (recolhida; o título já diz se está ligada e quem revisa). Dentro: o botão **Ligada/Desligada** e **Responsável pela revisão**, um funcionário do projeto. Ao ligar, vale o último responsável gravado (ou o primeiro da lista, se ele saiu do projeto). A escolha fica no próprio projeto e vale para as tarefas que chegarem em **Revisão** depois.

Quem revisa cada tarefa em **Revisão**:

1. O revisor apontado na tarefa (**Revisão automática** + **Quem revisa** no formulário ou no detalhe). Esse tem prioridade sobre o quadro.
2. Senão, com o quadro ligado, o responsável do quadro revisa o que **outro** funcionário fez.
3. Se o responsável do quadro foi quem fez a tarefa, ela fica com você: o cartão ganha o selo amarelo **Você aprova ou reprova** e o detalhe explica o porquê. Aprove com **Aprovar entrega**; para reprovar, mande o ajuste na conversa da tarefa (ela volta para **Fazendo**).
4. Com o quadro desligado e sem revisor na tarefa, nada muda: ninguém revisa sozinho, e você decide (ou usa **Delegar revisão**).

O limite de **3** revisões automáticas por tarefa vale também aqui; passando dele, o que sobrar fica com você (mesmo selo).

### Card registrado automaticamente

Quando um funcionário altera código do projeto numa conversa que não é de nenhuma tarefa, o Club cria sozinho um card para registrar o trabalho:

- Nasce em **Fazendo**, ligado à conversa, e vai para **Revisão** quando o turno termina. O cartão leva o selo discreto **Registrado automaticamente**.
- O detalhe mostra **Arquivos alterados nesta conversa (n)**, na ordem em que foram editados, sem o que fica em `.myco/` nem o que está fora do projeto. A lista para em 300 arquivos.
- A revisão segue a regra acima (revisor do quadro, ou você).
- **Só alteração de código é detectada**: o Club vê as edições feitas pelas ferramentas de edição do funcionário. O que mudou só pelo terminal (`sed`, `node -e`, scripts) não gera card nem entra na lista.

## Dúvida do funcionário

Em tarefa pedida por um gestor, o funcionário que não consegue decidir sozinho escreve uma linha `DÚVIDA:` ou faz uma pergunta com opções. A tarefa não entrega enquanto a dúvida está aberta, e o cartão ganha o selo **Dúvida**:

| Selo | Com quem está |
| --- | --- |
| **Dúvida · aguardando {gestor}** (neutro) | Com quem pediu a tarefa. Ele responde pela própria conversa; você não precisa fazer nada. |
| **Dúvida · aguardando você** (amarelo) | É sua: o gestor passou a decisão para você, ou não respondeu a tempo (ver abaixo). |

### Responder pelo cartão

Abra o cartão da tarefa. O bloco **Dúvida do funcionário** (com borda amarela quando é com você) mostra a pergunta e como responder:

- **Dúvida escrita**: escreva no campo **Sua resposta** (até 2000 caracteres) e clique em **Responder**.
- **Dúvida por opções**: marque uma opção em cada pergunta (nas que dizem "Dá para marcar mais de uma opção", quantas quiser) e clique em **Responder**. O botão só liga com todas as perguntas respondidas. Se nenhuma opção serve, responda na conversa do funcionário.
- A resposta fecha a dúvida (o bloco passa a "Respondida por você") e chega ao funcionário na conversa da tarefa. Se ele estiver ocupado com outra tarefa, ela espera a vez dele, como um ajuste guardado.
- Se o gestor respondeu primeiro, o bloco mostra a resposta dele e o Club avisa que já foi respondida: ninguém responde duas vezes.
- Sem o navegador pareado, o botão não funciona e aparece o aviso de pareamento (ver 01).
- Só o bloco com o selo **aguardando você** tem o campo. Com o gestor, ele é só leitura.

### O funcionário não fica parado esperando você

Enquanto a dúvida está com você (**aguardando você**), o cartão mostra o que isso faz com a fila do funcionário:

| Aviso no cartão | O que significa |
| --- | --- |
| **Pausada, espera a sua resposta** (caixa pontilhada), com "{funcionário} seguiu para “{tarefa}”" | Nada foi editado ainda. A tarefa espera você sem prender o funcionário, e a próxima de **A fazer** dele começa. Se não há outra, o aviso diz que ele está sem outra tarefa. |
| **Ocupando {funcionário} até você responder** (caixa contínua), com "Já há edição nesta tarefa" | Ele já editou arquivo nesta tarefa e fica nela até você responder, para não largar no meio. |

- A regra vale só para dúvida **com você**. Dúvida com o gestor (selo neutro) segue ocupando o funcionário como antes.
- **Ter worktree não libera**: a worktree é do funcionário, não da tarefa. O que decide é ter ou não edição.
- **Só edição vista pelo Club conta**: o Club enxerga as ferramentas de edição do funcionário. Quem mudou arquivo só pelo terminal (`sed`, `node -e`, scripts) não aparece como edição, e a tarefa é tratada como "nada editado" e pausa.
- Se a sua resposta chega com o funcionário já em outra tarefa, ela fica guardada (selo de ajuste guardado) e vai antes da próxima da fila dele, quando ele ficar livre.
- O mesmo aviso aparece no topo do detalhe da tarefa, com o texto da regra ao passar o mouse.

## Subtarefas

Um funcionário que delega pela própria conversa (por exemplo, o orquestrador pedindo trabalho a outros) cria **subtarefas** do cartão em que está trabalhando.

- **Subtarefa** é a tarefa pedida pela conversa de trabalho de um cartão. Tarefa pedida de outra conversa, ou criada por você na tela, não é subtarefa. O Club grava o vínculo sozinho na criação, e ele não se edita.
- Enquanto houver subtarefa **aberta** (fora de **Finalizado** e **Cancelada**), o cartão **não vai para Revisão**: o fim de turno dele o deixa em **Fazendo**, aguardando, e ele **não ocupa a fila** do funcionário (a próxima de **A fazer** começa, como na dúvida com você). Subtarefa cancelada conta como fechada.
- Quando a última fecha, o resultado chega à conversa do cartão e, no fim de turno seguinte, ele vai para **Revisão**. Mensagem sua na conversa do cartão desfaz a espera: ele volta a trabalhar.

| Onde | O que aparece |
| --- | --- |
| **Cartão que aguarda** | Selo **Aguardando N subtarefas** (pontilhado, sem laranja) e, logo abaixo, um link por subtarefa aberta, com título e status. |
| **Subtarefa** | Selo **Subtarefa de “Cartão”** e, logo abaixo, o link para o cartão de origem, com título e status. |
| **Detalhe** | Bloco com todas as subtarefas (as fechadas também), "2 de 3 abertas" e, se o cartão aguarda, a regra acima. Na subtarefa, o bloco **Subtarefa do card** com o link de origem. |

- Clicar num link abre o detalhe daquela tarefa, no mesmo painel (no celular, no lugar do detalhe atual).
- O selo **Aguardando** só aparece depois que o funcionário termina o turno com subtarefa aberta. Antes disso, o cartão segue em **Fazendo** e o detalhe só lista as subtarefas.
- Se o cartão de origem foi apagado, a subtarefa mostra só o código dele e "fora do quadro".

## A fila se recupera sozinha

A fila não precisa de você para andar. Quando uma entrega falha por um motivo passageiro (limite de consumo, envio que não chegou, conversa fechada), o Club tenta de novo sozinho, com espera crescente (1, 2, 4, 8 e depois 15 minutos, com uma pequena variação). Só chama você quando o motivo não passa sozinho ou quando o prazo abaixo estoura.

| O que travou | O que o Club faz sozinho | Quando chama você |
| --- | --- | --- |
| **Dúvida que não chegou ao gestor** | Tenta de novo no ritmo acima, sem contar como uma dúvida nova. | Em 30 minutos sem chegar, ou na hora se a falha não passa sozinha (por exemplo, a tarefa já teve 3 dúvidas): vira **aguardando você**. O Club segue tentando o gestor; quem responder primeiro fecha. |
| **Dúvida sem resposta do gestor** | Espera. | Passados 30 minutos: vira **aguardando você**. |
| **Revisão automática que não começou** | Tenta começar de novo no ritmo acima. | Em 30 minutos sem começar: item **parada**. |
| **Revisão sem veredito**, ou revisor que parou | Pede o veredito de novo uma vez, depois de uns 10 minutos. | Se o revisor responde de novo sem veredito, ou 30 minutos depois do novo pedido: item **parada**. |
| **Ajuste guardado que não chega** | Não trava a fila: o funcionário segue com a próxima tarefa, e o ajuste é tentado de novo (a falha repetida entra uma vez só no histórico). | Depois de 5 falhas: item **parada**. |
| **Aviso ao gestor** (quando ele passou várias tarefas e espera todas fecharem) | Tarefa parada não segura o aviso. Ele sai no máximo 2 horas depois, e o que falhar no envio é reenviado. | Nunca. |
| **Conversa esperando o limite de consumo, e a leitura do limite falha** | Depois de 3 falhas seguidas, deixa de esperar e retoma. | Nunca. |

Tarefa **em Aguardar** nunca anda sozinha: se outra depende dela, o item pede que você decida.

### O que aparece em "precisa de mim"

Cada item abre o cartão da tarefa e traz a ação. Sem **×**: o item some sozinho quando o problema acaba.

| Rótulo | O que quer dizer | Ação |
| --- | --- | --- |
| **dúvida** | A dúvida de uma tarefa está **aguardando você**. Mostra a tarefa e a primeira pergunta. | **Responder**: abre o cartão, onde se responde. |
| **parada** | A revisão não começou ou ficou sem veredito, ou o ajuste não chegou ao funcionário. | **Revisar** (abre o cartão: aprove com **Aprovar entrega**, ou mande o ajuste na conversa para reprovar) ou **Reenviar ajuste** (age na hora, sem abrir o cartão: zera as falhas e tenta de novo; o item some se o ajuste chegou). |
| **bloqueada** | Uma tarefa espera outra que não anda. | Se a outra se recupera sozinha, nada a fazer. Se só você resolve, o link abre o cartão da tarefa que segura: **Responder** (dúvida com você), **Revisar**, **Ver ajuste** (o reenvio é no item **parada** dela) ou **Decidir** (a que segura está em **Aguardar**, no limite de revisões automáticas ou sem responsável). Se ela foi cancelada: **Liberar**, **Cancelar junto** ou **Continuar esperando** (some por 7 dias). |
| **não começou** | Cartão em **A fazer** parado há mais de 2 dias, fora da fila e sem bloqueio. | **Começar** ou **Cancelar**. |

Clicar no item abre o quadro de tarefas do projeto já no cartão. Com **avisar no sistema** ligado, cada item novo também vira uma notificação.

## Testes, mesclar e deploy

- **Rodar testes**: aparece se o projeto tem comando de teste (`npm test`, `composer test` ou `phpunit`). O cartão mostra **Testes** com "passaram" ou "falharam". Se falhou, **Saída dos testes** mostra o fim do log.
- **Mesclar em {base}** (só com código em worktree): pede confirmação, roda os testes e mescla. Teste vermelho desfaz a mescla. Se não há teste para rodar, o Club pergunta se mescla mesmo assim. Depois de mesclada, a tarefa vai para **Finalizado** e mostra "mesclada em ... (commit)".
- **Pedir deploy** (em tarefa **Finalizado** ou mesclada): escolha **Quem faz o deploy**. Só aparecem funcionários com servidor na ficha. O checklist pede backup, estado antes e depois, e runbook. Ele pede confirmação antes de qualquer passo que não tem volta.
- **Pedir ao Codex** (segunda opinião): aparece só com **Usar o Codex (GPT)** ligado. Ver 06.

## Cancelar tarefa

Cancelar fecha a tarefa sem entrega: ela não conta como pronta, o histórico e a conversa ficam guardados, e dá para **Reabrir** (volta para **A fazer**, sem começar sozinha). Quem depende dela continua esperando: cancelada bloqueia.

**Cancelar não desfaz nada.** Arquivos já alterados, branch, worktree, mescla e deploy já publicado continuam como estão. Se a tarefa estava em andamento, o turno em andamento é interrompido (e o da revisão ou do deploy, se houver).

### Quem pode cancelar o quê

| Quem | O que pode |
| --- | --- |
| **Você** | Qualquer tarefa que não esteja pronta nem cancelada, pelo botão **Cancelar tarefa** no detalhe. O motivo é opcional, e para cada tarefa que espera por ela você escolhe **Liberar**, **Cancelar junto** ou **Continuar esperando**. |
| **O funcionário que faz a tarefa** | A própria, e só pela conversa da tarefa (por exemplo, quando você pede lá). Também aceita o pedido de cancelamento (abaixo), cancelando, ou o recusa dizendo por quê. |
| **Quem pediu a tarefa** (o gestor) | A que **nunca começou** (sem conversa, plano, entrega nem ajuste guardado: em **Aguardar** ou **A fazer** sem ter andado), direto e com motivo obrigatório. A que **já começou** ele não cancela: pede o cancelamento a quem a faz. |
| **O revisor e qualquer outro funcionário** | Nada. Não há botão de cancelar para eles. |

O botão **Cancelar tarefa** e o diálogo dele não mudaram: é o único caminho da tela, e fica disponível em toda tarefa aberta, mesmo com um pedido de cancelamento esperando.

### Pedido de cancelamento

Quando o gestor quer cancelar uma tarefa que já começou, ele manda um pedido com o motivo (obrigatório). O pedido chega na conversa de quem faz a tarefa, que decide:

- **Aceita**: cancela a tarefa. O pedido passa a **aceito**.
- **Recusa**: diz por quê. O pedido passa a **recusado**, a tarefa segue e o gestor é avisado. Ele só pede de novo depois de uns 10 minutos.
- A tarefa fica pronta antes de alguém decidir: o pedido fica **sem efeito**.
- Você cancelando pela tela também aceita o pedido que estiver esperando ("Aceito por você").
- Cada tarefa tem no máximo um pedido esperando decisão. Se quem faz a tarefa está em outra, o pedido espera a vez dele; se a entrega falhar, o Club tenta de novo sozinho. Reabrir a tarefa limpa o pedido.

O que aparece no quadro:

| Onde | O que mostra |
| --- | --- |
| Selo **Pedido de cancelamento de {gestor}** (neutro) no cartão | Há um pedido esperando a decisão de quem faz a tarefa. Passando o mouse, o motivo. Você não precisa fazer nada. |
| Selo **Cancelamento recusado** (neutro) no cartão | Quem faz a tarefa recusou. Passando o mouse, o porquê. |
| Bloco **Pedido de cancelamento** no detalhe (tracejado enquanto espera, contínuo depois de decidido) | Quem pediu e há quanto tempo (a data e a hora ao passar o mouse), o **motivo**, onde o pedido está (já na conversa de quem faz, esperando a vez dele, ou entrega falhou), e a decisão: **aceito**, **recusado** (com o **porquê**) ou **sem efeito**. Esperando ou recusado, lembra que você pode cancelar já. |

Os selos não ficam laranja nem amarelo: a decisão é de quem faz a tarefa. O amarelo continua sendo o que depende de você.

### Cancelada por quem pediu

Tarefa cancelada vai para o grupo recolhido **Canceladas (n)**, no fim de **Finalizado**. O cartão mostra **Cancelada por {nome}** e o motivo; o detalhe, o nome, a data e o motivo. Quando quem cancelou foi um funcionário, o nome vem com o papel: **(quem pediu a tarefa)** ou **(quem fazia a tarefa)**. Se foi você, aparece "você".

### Possível duplicata

Ao criar uma tarefa pela tela com título parecido (as mesmas palavras, ou 80% delas em comum, com pelo menos 3 palavras) ao mesmo responsável nos últimos 10 minutos, o quadro mostra o aviso amarelo **Possível duplicata**, com a tarefa parecida, a coluna dela e quando foi criada.

- **A tarefa nova foi criada mesmo assim.** O aviso não impede nada: com **Criar e começar**, a nova já começou.
- **Ver** abre a parecida; **Ver a nova** abre a que você acabou de criar. Se foi engano, cancele uma das duas em **Cancelar tarefa**.
- **Entendi** fecha o aviso. Ele também sai ao clicar em **Nova tarefa** de novo. Tarefa de rotina e card registrado automaticamente não entram na comparação.

## Editar, apagar e id

- Editáveis: **Título**, **Descrição**, **Quem cuida**, **Revisão automática**, **Quem revisa** e **PR** (link https). O botão **Salvar** aparece quando título, descrição ou PR mudam.
- **Apagar tarefa** pede confirmação. A conversa continua com o funcionário.
- Se o funcionário é excluído, as tarefas abertas dele ficam sem responsável ("responsável excluído" no histórico).
- O **ID da tarefa** aparece no cartão e no topo do detalhe. Tem o formato `t-` seguido de 6 caracteres hexadecimais. É o código para citar numa dúvida.
- **Histórico** lista cada mudança, marcada como "automático" ou "você".
