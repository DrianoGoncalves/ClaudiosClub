# Tarefas

Tarefa é um pedido de trabalho para um funcionário. Cada tarefa tem uma conversa própria com ele, e o quadro mostra em que pé ela está.

## Abrir o quadro

- No painel do projeto, botão **Tarefas**.
- No nó do projeto no quadro, o selo de tarefas em revisão também abre o quadro.
- O título é "Tarefas · {nome do projeto}". O quadro relê as tarefas a cada 5 segundos.
- Fecha pelo **×** ou com Esc. Com um cartão aberto, Esc fecha só o cartão.
- No cabeçalho: **Pausar projeto** (ao lado do título; veja **Pausar o projeto**), **Agendamentos** (ver 05) e **Nova tarefa**.

## Card = código

O quadro mostra só **trabalho de código**: um card é uma entrega em arquivos do projeto, e é isso que vai para revisão.

- **O plano é uma fase do card**, não outro card. Com a ficha em **Só planeja**, o plano aparece no próprio cartão, em **Fazendo** (selo **Plano para aprovar**), e você decide no cartão de plano do chat.
- **Pergunta e análise vão por conversa.** Para tirar uma dúvida, pedir uma análise ou discutir uma ideia, converse com o funcionário; não crie um card para isso.
- **O follow-up do revisor também fica na conversa**: aparece como balão na conversa de trabalho da tarefa, não como card (veja **Follow-up de revisão**).
- Um card que termina o turno **sem editar nenhum arquivo** não vai para revisão: fica marcado **Sem código** (veja **Card sem código**).

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
- Exceção: se ela parou no meio de uma ação que mexe fora do projeto (push, deploy, comando no servidor, MCP que escreve), o Club não retoma sozinho, porque não dá para saber se a ação aconteceu. A tarefa vai para **Aguardar** com o motivo, e a conversa aparece em **Inbox**. Confira e mande uma mensagem para seguir.
- Fora o reinício do servidor (acima), se a conversa cair por falha passageira (API sobrecarregada, erro 5xx, limite de taxa, queda de conexão) ou o processo cair no meio do turno, o Club retoma sozinho, com espera crescente (30 s, 2 min e 8 min, com uma variação de até 20%) e até 3 tentativas (1, quando o processo caiu sem causa conhecida). Se o próprio erro pede uma espera maior, vale a maior, até 15 min; acima disso não é falha passageira e não retoma. Enquanto a retomada está marcada, a tarefa fica em **Fazendo** e o cartão ganha o selo **Retomando em 42s · 2/3** (a tentativa 2 de 3). Passou da hora e ainda aparece: **Retomando agora**, o envio está em curso. O selo não é laranja: o laranja é só da coluna **A fazer**. Passando o mouse, o selo traz o motivo e a hora; no detalhe da tarefa, a frase inteira.
- O selo some quando a retomada sai, quando você manda uma mensagem na conversa (isso cancela a retomada) ou quando as tentativas acabam. Acabando as tentativas, ou se a conversa parou no meio de uma ação que mexe fora do projeto, a tarefa vai para **Aguardar** como na exceção acima, e a conversa aparece em **Inbox**. O que é e o que não é retomado sozinho, e o aviso no chat, estão no capítulo 03 (**Retomada automática**). Para desligar: **Configurações** → **Conversa** → **Retomar sozinho quando a conversa cair por falha passageira** (nível **Avançado**; padrão ligado).
- O responsável só pode ser trocado antes de começar. Depois, aparece "A tarefa já começou com este funcionário".

## Ordem da fila

A fila de cada funcionário anda na ordem em que os cartões entraram, até alguém reordenar. Quem entra depois vai para o fim. Em **A fazer**, cada cartão da fila mostra a posição ("1º na fila de Beakman"). A posição conta também os cartões bloqueados e os esperando nova tentativa: eles são pulados na hora de começar, mas não perdem o lugar.

| Quem | O que pode na ordem da fila |
| --- | --- |
| **Você** | Qualquer cartão da fila de qualquer funcionário: arrastar até a posição que quiser (ao topo, ao fim ou no meio). |
| **O gestor** (o funcionário que pediu o cartão) | Só os cartões que ele pediu, e só subir ou descer um lugar entre eles. Passar na frente de um cartão que outra pessoa pediu é só seu. |
| **O funcionário que faz a tarefa** | Não muda a ordem: só sugere (subir, descer ou ir ao topo, com o motivo). A sugestão vira aviso na conversa de quem pediu o cartão e nota no histórico dele, e a ordem não muda. Cartão pedido por você: ele diz a sugestão a você na conversa. |

- **Arrastar**: a ordem muda arrastando o cartão até a posição, sem botões. Leve-o sobre outro cartão da **mesma** fila: na metade de cima dele, o cartão entra **antes**; na de baixo, **depois**. Um traço azul na borda do alvo mostra onde ele vai entrar, e o cartão arrastado fica esmaecido. Cartão de outro funcionário não aceita (a fila de cada um é separada), nem o lugar onde o cartão já está. Soltar na coluna, fora de um cartão, continua só mudando de coluna. No celular, segure o cartão um instante e arraste; o navegador do aparelho é quem decide se aceita esse gesto.
- **Teclado**: com o cartão em foco (Tab), **Alt + ↑** sobe um lugar na fila e **Alt + ↓** desce um lugar. É o único caminho sem arrastar.
- No detalhe do cartão aparece "Posição na fila de Beakman: 2 de 4", só para consulta; a ordem se muda no quadro.
- Só cartão que está na fila tem ordem: em **A fazer**, com responsável, esperando a vez dele. Cartão em **Aguardar**, fora da fila ("tirar da fila"), sem responsável ou já em andamento não se reordena. Sozinho na fila, também não.
- **Histórico**: cada movimento deixa uma nota no histórico do cartão movido, com quem mexeu e de onde para onde ("fila de Beakman reordenada por você: posição 3 → 1 de 4"; no caso do gestor, o nome dele). A sugestão do funcionário também aparece lá ("Beakman sugeriu passar para o topo da fila: …").
- Se a ordem mudou enquanto você olhava (o quadro relê a cada 5 segundos), o Club recusa o que já não vale ("já é o primeiro da fila", "a tarefa saiu da fila") e a mensagem aparece no quadro; nada é movido pela metade.
- Ao tirar o cartão da fila, mudar de coluna ou trocar o responsável, ele perde a posição e, ao voltar, entra no fim.

## Pausar o projeto

Fila grande e você quer o time parado para focar em outro projeto? **Pausar projeto** segura tudo o que começaria sozinho, em um clique (mais a confirmação).

- **Onde pausar**: no quadro de tarefas, o botão **Pausar projeto** fica ao lado do título (no celular, só o ícone de pausa, as duas barras). No painel do projeto, o ícone de pausa fica entre Arquivos e Arquivar.
- **Onde retomar**: os mesmos dois (o botão vira **Retomar projeto**) e o botão de play no cabeçalho da sala no quadro, ao lado do selo de tarefas. Esse botão só aparece com o projeto pausado.
- **Confirmação**: ao pausar, o Club pergunta e explica o que vai acontecer. Retomar não pergunta.
- **O que para**: nada novo começa sozinho. A fila de cada funcionário, as rotinas, os despertadores, o "continue" do limite de uso, a retomada depois do reinício do servidor e a troca de motor esperam. Mensagens de um funcionário ou de uma decisão automática para outro (o ajuste de uma reprovação, a resposta do gestor) também esperam.
- **A revisão continua**: a entrega que já chegou em **Revisão** é revisada normalmente, mesmo pausado, e o veredito fica gravado. Só o ajuste de uma reprovação espera para ir ao funcionário; ao retomar, ele segue.
- **O que está rodando**: termina o turno atual e para ali. Nada é interrompido no meio e a tarefa fica onde está (em **Fazendo**, por exemplo).
- **O que continua valendo**: as suas ações. Conversar com um funcionário, mover um cartão e **Começar** seguem funcionando.
- **Como aparece**: faixa azul no topo do quadro ("Projeto pausado desde hoje às 14:32" e o que isso faz), selo **Pausado** no cabeçalho da sala no quadro (abaixo do nome) e no painel do projeto, e o botão vira **Retomar projeto** (ícone de play, em azul cheio). O selo também aparece com o projeto sem nenhuma tarefa aberta.
- **Retomar**: a fila segue na ordem de antes e a rodada começa na hora. O "continue", os despertadores e as rotinas saem no próximo ciclo deles.
- **Fica gravado**: a pausa sobrevive ao reinício do servidor. Vale para esta máquina (não vai para o repositório) e é do projeto inteiro, não de um funcionário.
- **Só você**: só o navegador do Club pausa ou retoma. Funcionário e conversa de tarefa recebem recusa (403). A única exceção é a pausa de versão, abaixo.
- **Se der erro** (sem conexão com o servidor, projeto que sumiu, falha ao gravar): o Club mostra um aviso no idioma da tela e o estado fica como estava.

## Versão

O botão **Versão**, no cabeçalho do quadro, abre a página da versão (tela cheia, por cima do quadro). Ela tem duas abas: **Versão** e **Histórico**.

- **Abrir**: marque as tarefas pendentes (Aguardar, A fazer, Fazendo, Revisão) que entram. As bloqueadoras abertas de cada uma entram junto, marcadas como **dependência**. O número vem sugerido a partir da última tag (ex.: depois de `v1.5.1`, `1.5.2`); dá para trocar. Uma versão aberta por projeto, até 50 tarefas.
- **Card de manual e doc**: marcado por padrão. Escolha quem cuida dele. Ele fica em **Aguardar** e entra na fila sozinho quando as outras tarefas da versão ficam prontas.
- **Enquanto a versão está aberta**: só as tarefas dela saem da fila. As de fora esperam em **A fazer** com a nota "fora da versão". As que já estavam em **Fazendo** ou **Revisão** terminam, mas **a mescla delas espera**: o checkout é um só, e a mescla levaria código não marcado para a versão. O seu **Começar** continua valendo. Uma faixa no quadro mostra "Versão X aberta · N de M prontas".
- **Atenção, funcionário sem worktree**: a tarefa de fora que já estava em **Fazendo** sem worktree muda o checkout direto, sem mescla para segurar. O que ela entregar antes da preparação entra na versão.
- **Reprovada**: fica na versão e volta para ajuste, como sempre. A página mostra quantas vezes voltou e o botão **Tirar**.
- **Cancelada**: sai da conta sozinha. Se outra tarefa da versão depende dela, essa fica **Travada** e a versão não fecha até você tirar a dependente ou resolver a dependência.
- **Pôr e tirar**: até preparar, **Pôr mais tarefas na versão** e **Tirar** mudam o escopo. Tirar uma bloqueadora de que outra tarefa da versão ainda depende é recusado.
- **Hotfix**: em **Pôr mais tarefas na versão**, **Furar como hotfix** deixa uma tarefa urgente começar e mesclar com a versão aberta, sem que a versão espere por ela. Se ficar pronta antes da preparação, entra no changelog marcada como `[hotfix]`.
- **Preparar (sozinho)**: quando todas ficam em **Pronto** (com worktree, isso já inclui a mescla), o Club roda as provas, sobe o número no `package.json` e no `package-lock.json` e faz o commit local "Versão X" só desses dois arquivos. A partir daí a fila e as mesclas de fora voltam a andar. O build não roda aqui: ele mexeria no `dist/` e reiniciaria o servidor do `daily:start`.
- **As provas**: a checagem de tipos do projeto (o script `typecheck`, ou o `tsc`) e, com vitest, só os testes relacionados aos arquivos de código mudados desde a última tag. Sem tag, com nomes de arquivo fora do comum ou com mais de 400 arquivos, roda a suíte inteira. A comparação com o baseline (falha antiga não contar) vem com a t-7b0e91.
- **Se a preparação falhar** (tipos ou testes vermelhos, ou `package.json` mexido sem commit): nada é commitado, o motivo e a saída aparecem na página e num aviso da caixa, e o Club não tenta de novo sozinho. Use **Tentar de novo** ou **Preparar sem as provas** (fica registrado).
- **Descartar a preparação**: antes de publicar, um commit novo volta só o número no `package.json` e no lock (o resto desses arquivos fica). A versão volta a ficar aberta, com a trava. Nada de reset nem de reescrever história; depois de publicada, não dá.
- **Publicar (push e PR)**: com confirmação. Envia o commit da versão para a branch `release/X` no GitHub (nunca force, nunca a `main`) e abre o PR para a `main`, com os títulos das tarefas no corpo. Commits feitos depois da preparação não vão juntos. A mescla do PR é sempre sua.
- **Criar tag vX**: depois de mesclar o PR no GitHub. O Club confere que o PR foi mesclado, cria a tag anotada no commit da mescla (com o changelog e quem publicou) e a envia. **É a tag que publica a versão**: as instalações do Club passam a ver a atualização. A versão fecha aqui.
- **Quem publica** (no topo da página, vale para o projeto): é o portão `publish` da **política de fluxo** do projeto, gravado junto com os outros portões (fora do projeto, onde o agente não grava). **Só você** (o padrão, e o do preset Manual); **o funcionário abre o PR e a tag espera o seu ok** (preset Supervisionado); ou **ele publica o PR e a tag sozinho**, e você é avisado (preset Automático). Uma política escolhida antes deste portão vale como "só você" até você escolher de novo. Mudar o portão aqui deixa a política como "personalizada". O funcionário precisa da permissão **Pode versionar e fazer deploy** na ficha e de autonomia auto ou sem travas. Ele só pede pela API; quem roda o git é o servidor, com as mesmas travas do myco-git. **Desligar publicação por funcionários** volta ao "Só você" na hora e recusa um pedido de tag pendente.
- **Pedido de tag**: no modo do meio, a tag pedida pelo funcionário aparece na página (**Aprovar e criar a tag** ou **Recusar pedido**) e na caixa.
- **Rastro**: cada passo (abrir, escopo, hotfix, preparar, descartar, publicar, pedir e criar a tag) fica no **Registro** da versão, com quem fez. Publicações e preparações automáticas viram aviso na caixa por 7 dias. A tag guarda quem publicou.
- **Cancelar versão**: a fila e as mesclas de fora voltam. Um commit de versão já feito fica (para desfazê-lo, descarte antes).
- **Histórico**: a lista das versões publicadas (as tags `vX.Y.Z`), da mais nova para a mais velha, com data, commit e, ao abrir, o resumo e as tarefas que entraram. Versões de antes desta ferramenta aparecem sem a lista de tarefas.
- **Só você**: abrir, mudar, hotfix, preparar, descartar, o modo e cancelar são só pelo navegador do Club. Funcionário recebe recusa (403); publicar e a tag seguem o modo acima.
- **Status do CI**: com o PR publicado, a página mostra o CI do PR e, depois da mescla, o do commit da mescla, com as checagens. No **Histórico**, ao abrir uma versão, aparece o CI do commit dela. No detalhe do cartão com PR do repositório do projeto, também. O Club lê do GitHub só quando você abre a tela (e de minuto em minuto enquanto o CI roda), com o login do `gh` desta máquina. Sem login ou sem rede, aparece "status do CI indisponível".
- **A tag espera o CI**: com o CI do commit da mescla vermelho ou rodando, a tag é recusada. Com o status indisponível, só você cria a tag, com **Criar a tag sem conferir o CI** (confira no GitHub antes).
- **Deploy como código**: com `.github/workflows/deploy.yml` no projeto (contrato em `docs/deploy.md`) e o origin no GitHub, o **Pedir deploy** do cartão dispara esse workflow com o commit mesclado da tarefa, e a aba **Histórico** traz **Deploy de vX** (a tag mais nova) e **Voltar para vY (versão anterior)**, que dispara com a tag anterior. Escolha o ambiente: staging ou produção, e produção pede o seu ok. O Club acompanha a execução só enquanto ela roda e mostra o resultado (no ar, falhou) com o link do log, no cartão e na versão, e avisa na caixa quando termina. Usa o login do `gh` desta máquina (com a permissão "workflow"); o disparo vai uma vez só, e se a rede cair no meio, confira no GitHub antes de repetir. Sem o workflow, ou fora do GitHub, o **Pedir deploy** segue pela conversa com o funcionário de infra, como antes. Só você dispara.
- **CI**: um PR por versão. O CI do repositório já cancela a rodada anterior da mesma branch e pula os passos pesados quando só muda documentação (sem `paths-ignore`, que travaria PR só de docs: a `main` exige o check "test").

### Pausa de versão (pela API)

A pausa com prazo continua existindo para o funcionário com a permissão **Pode versionar e fazer deploy**, pela API. Ela não aparece mais como controle no quadro; quando alguém a liga, a faixa e o selo abaixo aparecem e o botão **Encerrar pausa** a desliga.

- **O que barra**: o mesmo que a pausa comum: nada novo começa (fila, início de tarefa, rotinas, despertadores, troca de motor).
- **O que deixa terminar**: o turno em andamento, a revisão da entrega e o ajuste de um cartão em **Fazendo**, **Planejando** ou **Revisão**, como numa reprovação.
- **Saída**: sai sozinha no prazo ou quando **Encerrar pausa** é usado; a fila segue como na retomada da pausa comum. A saída vira um aviso na caixa por 24 horas.
- **Como aparece**: faixa com "Pausa de versão · faltam N min", quem ligou e a hora em que sai, e selo **Pausa de versão** com o tempo restante.
- **Quem liga**: você, pelo Club, e o funcionário com a permissão **Pode versionar e fazer deploy** (pede o prazo, de 1 a 120 minutos). Quem encerra: você ou quem ligou; outro funcionário recebe recusa (403).
- **Com pausa comum ligada**: a pausa de versão é recusada (409) e a comum segue; o mesmo vale para a pausa de versão de outra pessoa. A pausa comum não muda.

## Plano para aprovar

Se a ficha do funcionário está em **Só planeja**, ao começar a tarefa vai para **Planejando**. No quadro ela aparece em **Fazendo**, com o selo **Plano para aprovar**. Você decide no cartão de plano do chat:

| Botão | Efeito |
| --- | --- |
| **Aprovar e executar** | Vai para **Fazendo** e executa. O plano fica guardado no cartão (**Plano aprovado**). |
| **Pedir mudanças** | Continua só planejando. Escreva o que mudar. |
| **Recusar plano** | Não executa. A tarefa vai para **Aguardar**, e quem pediu a tarefa é avisado. |

### Plano primeiro (card que pede o plano antes de editar)

Quem cria a tarefa pela API manda `"planFirst": true` (ou `false` para dispensar; o campo também se edita antes de a tarefa começar). Sem o campo, o Club reconhece na descrição frases como "comece pelo plano" ou "plano primeiro". O funcionário, em qualquer ficha que edita e nos dois motores (Claude e Codex), termina o turno com o plano escrito e sem editar arquivos. Esse plano **não é uma entrega**: o card vai para **Planejando** com o plano pendente de quem pediu, sem abrir revisão, sem contar rodada e sem registrar reprovação.

- **Pedida por um gestor:** o plano chega na conversa em que ele pediu, com os dois caminhos. Ele decide com `POST /api/projects/<projeto>/tasks/<id>/plan`: `{"decision": "approve"}` (o card segue em **Fazendo**, no mesmo card, com o plano guardado em **Plano aprovado**; `note` opcional acrescenta uma observação) ou `{"decision": "reject", "reason": "<o que ajustar>"}` (o motivo vai ao funcionário, o card volta a **Fazendo** e ele entrega o plano de novo). Só quem pediu e o usuário decidem (403 para os outros; 409 se o card não espera plano).
- **Pedida por você, ou se o aviso ao gestor não chegou em 30 minutos:** o plano vira um item de **card parado** na caixa de entrada, com o começo do plano. A decisão é a mesma rota (a tela de botões para este caso é uma tarefa à parte).
- Uma mensagem na conversa do card também devolve o funcionário ao trabalho, mas só a aprovação grava o plano. O card segue ocupando o funcionário até a decisão, como o cartão de plano de cima.
- Quem só planeja (**Só planeja**) continua pelo cartão de plano do chat, como acima.

## Selo "Precisa de você" no cartão

Cartão parado por uma ação sua na caixa de entrada ganha o selo amarelo **Precisa de você**, com o motivo ao passar o mouse e para leitores de tela (plano para aprovar, pedido de permissão, dúvida, revisão que não andou, ajuste que não chega ao funcionário, card sem código, espera por outra tarefa parada). É o mesmo amarelo dos avisos de "precisa de você" da caixa. Clicar no cartão abre o detalhe, onde está a ação. O selo some sozinho quando você resolve o item. Ação que é do gestor (dúvida por opções antes de chegar a você) não mostra o selo; aviso da caixa que não trava o cartão também não. O mesmo selo aparece no cabeçalho do projeto (com a contagem de tudo da sala que espera você) e no cartão do funcionário (só ponto e número, com o motivo ao passar o mouse): vêm dos avisos da caixa que pedem uma decisão sua (plano, permissão, resposta, dúvida, tarefa parada, follow-up); erro, segredo e rotina não contam. Com um plano esperando, a ação principal do painel da tarefa abre a conversa onde você o aprova.

## Esperando sua permissão

Quando a conversa de uma tarefa em **Fazendo** pede uma permissão e espera você responder, o cartão ganha o selo laranja **Esperando sua permissão: <ferramenta>** e o botão **Responder no chat**, que abre a conversa já no cartão do pedido (o detalhe da tarefa tem o mesmo botão). Passados 15 minutos o selo vira **Parada: esperando sua permissão: <ferramenta> · há N min**, com borda mais grossa, e o gestor que pediu a tarefa recebe um aviso, só informativo: a permissão é sua. O selo some quando você permite ou nega.

- Pergunta com opções não entra aqui (o gestor a responde), e o Codex não tem cartão de permissão.
- Tarefa com plano para aprovar já mostra **Plano para aprovar**: o selo de permissão só aparece nela depois dos 15 minutos.
- O card registrado automaticamente não mostra o selo: a conversa é sua, você está nela.

## Entrega e revisão

- Quando o turno dele termina, a tarefa vai para **Revisão** sozinha, exceto se ainda houver subtarefa aberta (veja **Subtarefas**). Se o código está numa worktree, o Club faz um commit com o título da tarefa.
- Mensagem sua na conversa da tarefa, com ela em **Revisão**, volta a tarefa para **Fazendo**.
- A seção **Código, revisão e deploy** mostra o que mudou, o **Resumo da entrega** e o diff.
- No detalhe da tarefa, **Custo da tarefa**, **Bloqueada por** e **Código, revisão e deploy** abrem recolhidas, cada uma com um resumo de uma linha: o custo total; quantas tarefas bloqueiam esta e quantas seguem em aberto; o veredito (ou quem está revisando) e os testes. Clique no título, ou use **Enter** ou **Espaço** nele, para abrir.
- **Aprovar entrega** (em **Revisão**) manda a tarefa direto para **Finalizado**. Esse botão não roda testes nem mescla.

### Delegar revisão (manual)

Na seção **Revisão**, escolha **Quem revisa** e clique em **Delegar revisão** (ou **Delegar nova revisão**). O revisor responde com APROVADO ou REPROVADO na primeira linha.

Quando a revisão automática para (o item **parada** em **Inbox**), o mesmo pedido sai da caixa, sem abrir o cartão: o link **Delegar revisão** no item abre o seletor com os mesmos funcionários do cartão (o responsável da tarefa não entra), e o botão **Delegar revisão** dentro do seletor faz o pedido. Cada caso tem o seu botão: revisão parada → **Revisar** (abre o cartão) e **Delegar revisão** (pede ali mesmo); ajuste que não chegou ao funcionário → **Reenviar ajuste**, sem atalho de revisão. Se já há uma revisão pedida e sem resposta, o cartão não deixa escolher outro revisor, e a caixa também não mostra o atalho; uma revisão substituída por uma entrega nova não conta como pedida.

- Aprovada: vai para **Finalizado**. Se o código ainda está numa worktree sem mesclar, fica em **Revisão** ("aprovada; falta mesclar a worktree").
- Reprovada: os ajustes voltam para quem fez, e a tarefa volta para **Fazendo**. Se ele estiver ocupado, o ajuste fica guardado e a tarefa segue em **Revisão**.
- O revisor não muda o código: só revisa.

#### Como a reprovação chega (itens numerados)

- **Itens numerados**: o revisor que reprova lista cada bloqueador (🔴) numa linha própria, com id fixo (**R1**, **R2**…), o `arquivo:linha`, o problema e **como provar** que foi corrigido. Quem fez a tarefa recebe esses itens no topo do ajuste, como lista para conferir, e o texto do revisor vem depois. Nenhum 🔴 é cortado do texto do revisor; só trecho sem 🔴 sai se o texto for grande, e o aviso diz quanto. Na lista guardada no card, cada campo do item é resumido (arquivo até 200 caracteres; problema e prova até 600), sem aviso.
- **Resposta item a item**: o Club pede que, ao terminar, o funcionário responda uma linha por item (`R1: feito — onde e a prova` ou `R1: não feito — por quê`), sem pular nenhum. O Club guarda essa resposta na tarefa para a próxima revisão e avisa o revisor de qual item ficou sem citação. Sem a lista (veja **Sem o bloco**), a linha começa pelo `arquivo:linha` do 🔴 em vez do id.
- **Dúvida sobre um item**: se um item é ambíguo ou contradiz o pedido, o funcionário não o implementa; faz o que não depende dele e termina com `DÚVIDA: R2 — …`. Essa dúvida vai ao **revisor que reprovou**, e só ele responde (mantém o item ou o reformula; se a decisão é sua, ele pode passá-la a você); ela não vai a quem pediu a tarefa. Só vai ao revisor se a dúvida **começa** pelo id do item (sem a lista, pelo 🔴) e acontece no turno de ajuste, antes da resposta; se o revisor é quem pediu a tarefa, a dúvida já ia a ele.
- **Rodada seguinte**: na nova revisão, o Club entrega ao revisor os itens anteriores e a resposta do funcionário, e **pede que ele confira esses primeiro** (`R1: RESOLVIDO` ou `NÃO RESOLVIDO`). O Club pede também que item não resolvido volte com o **mesmo id** e que os novos sigam a numeração (se um id já usado e fechado reaparecer, o Club só anota um aviso). A regra de item **novo** é um **pedido ao revisor**, não um filtro do Club: ele deve reprovar por item novo só se for bug, regressão, falha de segurança ou critério de aceite descumprido, e tratar preferência nova (estilo, outro jeito de fazer) como follow-up. O Club não recusa nem separa os 🔴 por tipo.
- **Sem o bloco**: se o revisor não trouxer a lista, ou ela vier fora do formato, o texto dele segue como escreveu, com o motivo, e os 🔴 são os que aparecem nele. A reprovação vale do mesmo jeito.
- O card guarda as últimas **10** reprovações.

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

#### Concluir sozinho quando o revisor aprovar

Logo abaixo do revisor, no mesmo painel, a linha **Concluir sozinho quando o revisor aprovar** é o portão **conclusão** da **política de fluxo** do projeto (a mesma do **Quem publica** da página de versões; fica gravada fora do projeto, onde o agente não grava, e só muda por esta tela).

- **Ligada**: aprovada pelo revisor, a tarefa vai para **Finalizado** e a worktree é mesclada no projeto principal **sem o seu clique**. Sem isto, todo aprovado com worktree fica em **Revisão** com "falta mesclar".
- **Desligada**: o revisor continua revisando, mas a tarefa aprovada espera a sua aprovação. Nada é concluído nem mesclado sem você.
- **Ao ligar a revisão automática ou escolher o revisor**, a linha vem **ligada por padrão**, mas só se você ainda não tinha escolhido: uma escolha sua já gravada (inclusive desligada) nunca é sobrescrita. Se a gravação falhar, o revisor fica gravado e a linha mostra o erro e o valor real.
- **Valor padrão do projeto**: enquanto você não escolhe, a linha aparece **desligada** e avisa "você ainda não escolheu", porque nesse estado o Club não mescla sozinho. Um clique em **Ligada** grava a sua escolha e liga de fato; escolher aqui passa a valer como decisão sua.
- **Sem revisor** (revisão do quadro desligada e nenhum revisor apontado na tarefa), nada conclui sozinho: a tarefa espera você, mesmo com a linha ligada.
- Os **presets** (Manual, Supervisionado, Automático) e os portões de **plano** e **commit** ainda não têm tela própria; o commit automático é o botão do mesmo painel.

### Card registrado automaticamente

Quando um funcionário altera código do projeto numa conversa que não é de nenhuma tarefa, o Club cria sozinho um card para registrar o trabalho:

- Nasce em **Fazendo**, ligado à conversa, e vai para **Revisão** quando o turno termina. O cartão leva o selo discreto **Registrado automaticamente**.
- O detalhe mostra **Arquivos alterados nesta conversa (n)**, na ordem em que foram editados, sem o que fica em `.myco/` nem o que está fora do projeto. A lista para em 300 arquivos.
- A revisão segue a regra acima (revisor do quadro, ou você).
- **Só alteração de código é detectada**: o Club vê as edições feitas pelas ferramentas de edição do funcionário. O que mudou só pelo terminal (`sed`, `node -e`, scripts) não gera card nem entra na lista.

### Follow-up de revisão

Quando o revisor aprova e ainda vê uma melhoria (uma limpeza, um risco menor, uma ideia que merece outra tarefa), ele registra um **follow-up** na tarefa. É só um registro: **nada vira card sozinho**.

- **Quando o revisor usa**: só para melhoria **posterior**, que não invalida a aprovação. Falha que invalida a aprovação (bug, regressão, critério não cumprido) continua sendo **reprovar**, não follow-up.
- **Quem decide**: o gestor que pediu a tarefa, pela conversa dele, ou você, pela tela. O follow-up vai para você quando foi você quem pediu a tarefa, quando o gestor saiu do projeto ou quando o aviso a ele não chegou em 30 minutos. O autor não decide o próprio follow-up. Pela tela você decide também o que está com o gestor (o servidor aceita os dois); vale quem decidir primeiro, e o outro recebe o aviso de que já foi decidido.
- **Na conversa**: quando foi você quem pediu a tarefa e ela tem conversa, o follow-up aparece como **balão na conversa de trabalho da tarefa**, depois da última mensagem. Só você o vê: não é mensagem da conversa e o funcionário nunca o lê. O balão traz o que importa para decidir:
  - o selo **Vale fazer** ou **Opcional** (o "vale fazer" vem antes);
  - o título em linguagem simples e **Se não fizer:** (o que acontece sem o ajuste);
  - o **tamanho** (pequeno, médio ou grande) e **quem faria**;
  - **Detalhes técnicos**, fechado: o achado e o plano do revisor.
- **Na caixa**: o item **follow-up** mostra a recomendação e **abre essa conversa** ao clicar. Follow-up de tarefa que um gestor pediu, ou de tarefa sem conversa, abre o card.
- **No quadro**: o cartão não mostra o texto do follow-up, só um selo: **N follow-ups, M vale fazer** (sem nenhum "vale fazer", **N follow-ups abertos**; amarelo quando algum espera você). Enquanto houver follow-up aberto, o selo **Aprovada** do cartão não aparece, porque a tarefa não está toda resolvida; quando todos forem decididos, ele volta. O detalhe da tarefa traz o resumo no topo e o botão **Abrir conversa**, que leva ao balão (sem conversa, o detalhe mostra o follow-up e as saídas ali mesmo).
- **Follow-up antigo**, sem os campos acima (título, recomendação, "se não fizer", tamanho), aparece com o texto, como antes. Um e outro seguem a mesma regra para as saídas: no detalhe, enquanto estiver aberto e não esperar na conversa, você vê **Criar card** e **Descartar** (ou **Revisar** e **Concluir**), mesmo que esteja com o gestor (a nota diz quem pediu a tarefa).
- **No detalhe da tarefa**, cada follow-up traz quem achou (ou **revisão**, se a ficha dele saiu do projeto; a caixa chama do mesmo jeito), quando, com quem está (ou quem decidiu e quando) e o selo **Aberto**, **Virou card** ou **Descartado**. Depois de decidido, o follow-up que tem os campos acima continua mostrando o selo da recomendação, o título e o **Se não fizer:**, e não só o texto. Cada decisão também entra no **Histórico** da tarefa.

Em cada follow-up aberto (no balão, na caixa ou no detalhe) há duas saídas:

- **Criar card**: são dois toques. O primeiro abre o formulário, com **Responsável**, **Título** e **Descrição** já preenchidos e editáveis (o responsável é o que o revisor sugeriu; a descrição é o achado inteiro); o segundo, em **Criar card** dentro dele, confirma. O card nasce em **Aguardar**: você manda começar depois, no quadro. O follow-up passa a mostrar um link para ele.
- **Descartar**: não vira card. Escolha o motivo: **Não vale o custo**, **Já resolvido**, **Fora do escopo** ou **Outro motivo** (texto livre, uma linha). O motivo aparece no follow-up.

Quando a tarefa de origem já está **Finalizado** (a aprovação costuma fechá-la), o balão e o item da caixa mostram o selo **Finalizado**, e as saídas passam a ser:

- **Revisar**: cria o card de ajuste para o responsável da tarefa (o mesmo formulário do **Criar card**).
- **Concluir**: encerra o follow-up sem card, na hora; ele some da caixa. Fica no histórico como "concluído sem ajuste".

**Criar card**, **Revisar** e **Descartar** pedem confirmação; **Concluir** age na hora. **Decidido não se reabre**: quem tentar decidir de novo (você pela tela e o gestor pela conversa, por exemplo) recebe o aviso de que já foi decidido. Depois de decidir, a tela diz o que foi feito (por exemplo, "Card t-… criado em Aguardar"), porque o balão e o item da caixa somem.

As saídas só ligam depois que a tarefa de origem é lida (ela diz se está **Finalizado** e traz o achado inteiro): até lá a tela mostra **Lendo a tarefa de origem**. Se a leitura falha, as saídas continuam desligadas e a tela tenta de novo a cada 20 segundos.

### Card sem código

Card é para trabalho de código. Se o funcionário **termina o turno sem editar nenhum arquivo** (e sem ter pedido subtarefa), o card **não vai para revisão**: fica em **Fazendo**, com o selo **Sem código**, e deixa de ocupar o funcionário (a fila dele anda).

- **Quem decide**: quem pediu o card. O gestor, pela conversa dele; ou você, quando foi você quem pediu (também quando o gestor saiu do projeto ou o aviso a ele não chegou em 30 minutos). Com você, o selo fica amarelo.
- **No detalhe**: o bloco **Terminou sem editar código** mostra o que o funcionário disse ao terminar (a análise ou a resposta costuma estar aí) e, quando é com você, **Cancelar** (abre o diálogo de cancelar, com o motivo) e **Devolver ao responsável**.
- **Na caixa** (rótulo **parada**): a frase diz que o card terminou sem editar código, **ver o que ele disse** abre o resumo, e os botões são **Cancelar** (pede o motivo) e **Devolver ao responsável**.
- **Devolver ao responsável** manda uma mensagem na conversa de trabalho dele: o card sai de "sem código" e ele volta a trabalhar. Se a conversa não existe mais, o aviso diz para cancelar o card. Se a mensagem ficou guardada (o funcionário está ocupado em outra tarefa e a recebe quando terminar), a tela avisa em texto comum, sem ser erro: não mande de novo.
- No diálogo de **Cancelar**, o card sem código diz que o turno já terminou (não há o que interromper), em vez do aviso de tarefa em andamento.
- Mover o card de coluna também desfaz a marca.
- Para perguntar ou pedir uma análise, converse com o funcionário em vez de criar um card.

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
| **Cartão que aguarda** | Selo **Aguardando N subtarefas** (pontilhado, sem laranja) e, colada embaixo do cartão, uma bandeja com um link por subtarefa aberta e o status dela num selo, ligados ao cartão por uma linha em árvore. Cartão e bandeja são um bloco só: selecionar o cartão contorna os dois. |
| **Subtarefa** | Na bandeja colada embaixo do cartão, o link **Subtarefa de “Cartão”** com o status do cartão de origem. Uma subtarefa que também delegou mostra o cartão de origem e, depois, as próprias subtarefas. |
| **Detalhe** | No topo, um bloco com todas as subtarefas (as fechadas também), "2 de 3 abertas" e, se o cartão aguarda, a regra acima. Na subtarefa, o bloco **Subtarefa do card** com o link de origem. |

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

### Motor secundário: ida e volta

Se o principal bate o limite e a ficha tem motor secundário, a tarefa segue nele (selo **no secundário** no cartão). Isso **não é definitivo**: quando o limite libera, a tarefa volta ao motor principal, em conversa nova, **na próxima retomada** do trabalho dela. O limite liberar não move nada por si: a volta vem com a vez dela na fila, o reinício do servidor, uma conversa que parou ou a reprovação feita pelo revisor automático (esses quatro sem ação sua), ou com uma ação sua que retoma o trabalho (o ajuste que você manda na conversa para reprovar, a resposta a uma dúvida).

- O selo **no secundário** some e, enquanto a tarefa está aberta, o cartão mostra **voltou ao principal: {motor}**.
- O detalhe escreve a volta (**Voltou ao {motor} em {data e hora}…**), e o **Histórico** guarda a nota "motor principal liberado: voltou ao {motor} em conversa nova, com o resumo da anterior".
- Se a conversa nova não abrir, a tarefa segue no secundário (o selo continua) e o histórico diz o motivo.

Regras da troca e da volta: `06-consumo-e-motores.md`.

### O que aparece em "Inbox"

Cada item abre o cartão da tarefa e traz a ação. Sem **×**: o item some sozinho quando o problema acaba.

| Rótulo | O que quer dizer | Ação |
| --- | --- | --- |
| **dúvida** | A dúvida de uma tarefa está **aguardando você**. Mostra a tarefa e a primeira pergunta. | **Responder**: abre o cartão, onde se responde. |
| **parada** | A revisão não começou ou ficou sem veredito, ou o ajuste não chegou ao funcionário. | **Revisar** (abre o cartão: aprove com **Aprovar entrega**, ou mande o ajuste na conversa para reprovar), **Delegar revisão** (no item de revisão parada: abre ali mesmo o seletor **Quem revisa**, com os mesmos funcionários do cartão, e **Delegar revisão** pede a revisão sem abrir o cartão; o item some quando o pedido sai, e a caixa diz a quem foi) ou **Reenviar ajuste** (age na hora, sem abrir o cartão: zera as falhas e tenta de novo; o item some se o ajuste chegou). |
| **bloqueada** | Uma tarefa espera outra que não anda. | Se a outra se recupera sozinha, nada a fazer. Se só você resolve, o link abre o cartão da tarefa que segura: **Responder** (dúvida com você), **Revisar**, **Ver ajuste** (o reenvio é no item **parada** dela) ou **Decidir** (a que segura está em **Aguardar**, no limite de revisões automáticas ou sem responsável). Se ela foi cancelada: **Liberar**, **Cancelar junto** ou **Continuar esperando** (some por 7 dias). |
| **não começou** | Cartão em **A fazer** parado há mais de 2 dias, fora da fila e sem bloqueio. | **Começar** ou **Cancelar**. |
| **parada** (sem código) | O card terminou o turno sem editar código e a decisão é sua (veja **Card sem código**). Mostra a tarefa; **ver o que ele disse** abre o resumo do funcionário. | **Cancelar** (pede o motivo) ou **Devolver ao responsável** (age na hora). |
| **follow-up** | O revisor aprovou e deixou uma melhoria para depois, e a decisão é sua (veja **Follow-up de revisão**). Mostra o selo **Vale fazer** ou **Opcional** (e **Finalizado**, se a tarefa já fechou) e o título; um clique no item abre a conversa de trabalho da tarefa, onde está o balão. Follow-up antigo mostra a primeira linha do texto, e **ver o texto inteiro** abre o resto (até 600 caracteres). | **Abrir card**, **Criar card** e **Descartar** (decide na hora, sem abrir o cartão) ou, com a tarefa Finalizada, **Revisar** e **Concluir**. |

Clicar no item abre o quadro de tarefas do projeto já no cartão; o **follow-up** abre a conversa de trabalho da tarefa (sem conversa, o cartão). Com **avisar no sistema** ligado, cada item novo também vira uma notificação.

## Testes, mesclar e deploy

- **Rodar testes**: aparece se o projeto tem comando de teste (`npm test`, `composer test` ou `phpunit`). O cartão mostra **Testes** com "passaram" ou "falharam". Se falhou, **Saída dos testes** mostra o fim do log.
- **Mesclar em {base}** (só com código em worktree): pede confirmação, roda os testes e mescla. Teste vermelho desfaz a mescla. Se não há teste para rodar, o Club pergunta se mescla mesmo assim. Depois de mesclada, a tarefa vai para **Finalizado** e mostra "mesclada em ... (commit)".
- **Pedir deploy** (em tarefa **Finalizado** ou mesclada): escolha **Quem faz o deploy**. Só aparecem funcionários com servidor na ficha. O checklist pede backup, estado antes e depois, e runbook. Ele pede confirmação antes de qualquer passo que não tem volta.
- **Pedir ao Codex** (segunda opinião): aparece só com **Usar o Codex (GPT)** ligado. Ver 06.

### Uma suíte pesada por vez

A suíte completa de testes e o `tsc` do projeto inteiro gastam memória e processador. Por isso rodam **uma por vez no computador**: quem chega com outra em andamento espera a vez.

- **Vale para**: o **Rodar testes**, os testes da revisão e da mescla (do Club) e o terminal dos funcionários, no Claude e no Codex. Se dois funcionários pedem a suíte juntos, o segundo espera o primeiro acabar.
- **Passa direto**: teste de um arquivo ou com filtro, e qualquer outro comando.
- **A espera não conta nos 10 minutos** dos testes do Club nem no tempo mostrado no cartão.
- **Limite da espera**: 30 minutos nos testes do Club e 13 no terminal do funcionário. Passou disso, o comando roda mesmo assim, sem trava. Trava de um processo que morreu ou que passou do prazo vale como esquecida e é ignorada.
- **Em segundo plano não**: no terminal do funcionário, a suíte completa tem de rodar em primeiro plano; em segundo plano o comando é negado.
- **Onde aparece a espera**: no quadro, uma bolinha laranja no topo de **Fazendo** diz, ao passar o mouse ou tocar, "testes de … esperando a vez (a suíte de … roda agora)", desde que horas e quantos cartões esperam atrás (veja **Estado da fila de cada funcionário**, abaixo). No terminal do funcionário aparece "Esperei N s a vez: outra validação pesada rodava…", e o Club registra `[fila] … esperando a vez` no log do servidor.

### Estado da fila de cada funcionário

No topo das colunas **Fazendo** e **Revisão**, o quadro mostra uma bolinha por funcionário ocupado, para você ver por que a fila dele não anda sem investigar. Passe o mouse, use o teclado (Tab) ou toque na bolinha para ler a frase; toque fora, `Esc` ou rolar a fecha. Com o filtro por funcionário, só a dele. Atualiza sozinho a cada poucos segundos.

- **Bolinha normal** (andamento): em **Fazendo**, quem trabalha num cartão ou numa conversa e quem tem uma entrega recém-começada; em **Revisão**, quem está revisando um cartão (o pedido de revisão ainda sem resposta). A frase diz o que a pessoa faz e quantos cartões esperam atrás.
- **Bolinha laranja com halo** (a fila está parada, visível sem passar o mouse), em **Fazendo**: **esperando a máquina folgar** (com o motivo, ex.: pouca memória), **parada pelo limite de consumo**, **testes esperando a vez** (outra suíte pesada roda; diz quem) e **entrega em processamento há mais de 3 minutos** (resumo e commit; a fila só anda quando terminar). Cada uma traz "desde HH:MM" e o motivo.
- **Sem bolinha**: funcionário livre e projeto pausado (a faixa azul de cima já avisa).
### Commit automático

No topo do quadro, dentro de **Revisão automática do quadro**, o botão **Commit automático** (desligado por padrão, por projeto, só pela tela). Ligado, quando uma tarefa vai para **Finalizado** o Club faz **um commit local** com os arquivos que ela alterou. **Nunca faz push.** A mensagem é sempre `<título da tarefa> (<id>)`, sem IA, e os hooks do repositório rodam como num commit seu.

- **O que entra**: os arquivos que a tarefa alterou (a lista **Arquivos alterados** do cartão) e que ainda têm mudança no git. Arquivo novo, apagado e renomeado entram; o nome vale como está (espaço, `[ ]` e `*` incluídos).
- **O que fica de fora** (e o cartão diz por quê):
  - arquivo que **outra tarefa ainda não encerrada** também alterou (o diff da revisão dela continua inteiro; quando ela acabar, o arquivo entra no commit dela);
  - arquivo que **você gravou no editor do Club depois** da última edição da tarefa (**editado por você**);
  - arquivo de segredo (`.env`, chaves), de dependência ou build, e arquivo em conflito ou que você deixou *staged* com mudança nova por cima.
- **O seu índice não muda**: o commit sai de um índice à parte. O que você deixou *staged* não entra e continua *staged*; o `git status` não fica ao contrário.
- **Resultado no cartão**: o **SHA** (`commit 1a2b3c4`) quando tudo entrou, ou **commit parcial** quando sobrou arquivo (o detalhe lista cada um com o motivo). **Falhou** (hook que recusou, identidade do git, `index.lock`) ou **parcial** vira um item em "Inbox" (ele leva o motivo; o **×** o dispensa, e o cartão segue mostrando o resultado). A tarefa fica pronta do mesmo jeito: falha de commit nunca trava nada.
- **Quando não commita** (e diz o motivo): sem lista de arquivos (edição só por terminal não é vista), lista no limite de 300 arquivos (pode estar cortada), repositório no meio de merge ou rebase, HEAD destacado, projeto que não é repositório git. Tarefa de **worktree** tem o fluxo de mesclar e fica de fora. Ligar depois não commita tarefas que já estavam prontas, e a mesma entrega nunca gera dois commits.
- **Limite conhecido**: o Club só sabe o que foi gravado pelo **editor do Club** (aba de arquivos). Edição feita em **outro editor** (VS Code, vim…) ou pelo terminal não é detectada: o arquivo entra no commit da tarefa como se fosse dela. Se você edita o mesmo arquivo fora do Club, desligue o commit automático ou revise com `git show`.

### Um card escrevendo por vez (opção "um escritor por vez")

Opção do projeto, **desligada por padrão**. Liga e desliga só pela tela: no quadro de tarefas, abra o painel recolhível **Revisão automática do quadro**; lá, a linha **Um card escrevendo por vez** tem um botão **Ligada** / **Desligada** e, embaixo, o texto da regra. Ligada, só **um card por vez** edita código no checkout principal (a pasta do próprio projeto).

- **Por quê**: o commit automático por tarefa só leva os arquivos do próprio card. Com dois cards editando a mesma pasta ao mesmo tempo, os arquivos se misturam e o commit de um fica parcial (veja "O que fica de fora" acima). Com um card por vez, cada commit sai limpo.
- **Quem espera**: funcionário **sem** **Trabalhar numa worktree própria** edita direto no projeto. Se outro funcionário já tem um card editando, o card dele fica na fila e só começa quando o do outro fechar. O card que acabou de ficar pronto segura a vaga até a tentativa de commit terminar.
- **Quem não espera**: funcionário **com** **Trabalhar numa worktree própria** trabalha em paralelo numa cópia só dele. Também passam direto o card só de plano (ainda não edita) e o card criado automaticamente.
- **Mesma pessoa**: a fila de cada funcionário já anda um card por vez; a regra vale entre funcionários diferentes.
- **No quadro**: o card que espera mostra o selo **Aguardando recursos: a vaga de escrita deste projeto está com “{título}” ({id}, fazendo)**. O texto diz quem ocupa a vaga e em que fase está (fazendo, em revisão, em Aguardar ou pronto com o commit automático ainda rodando). Ele começa sozinho quando a vaga libera ou a opção é desligada.
- **Na ficha** (aba **Ficha**, ao lado de **Trabalhar numa worktree própria**): um aviso diz o efeito. Sem worktree e opção ligada: "Sem worktree, edita direto no projeto e espera…". Sem worktree e opção desligada: "…junto com os outros". Com worktree: "Com worktree própria, trabalha em paralelo numa cópia só dele, sem esperar ninguém."
- **Quando ligar a worktree**: quando dois ou mais funcionários costumam editar ao mesmo tempo e esperar um pelo outro custa caro. Ela pesa disco, não memória, e o projeto precisa ser repositório git. Mas tarefa de worktree tem o fluxo de **Mesclar** e não entra no commit automático.

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
