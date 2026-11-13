# Dicas e casos

Fontes: as páginas 01 a 07 desta pasta e `shared/roles.ts` (nomes dos cargos). Os casos usam só o que essas páginas descrevem.

## Casos práticos

### 1. Projeto do zero, com orquestrador e equipe pequena

**Situação:** você tem uma ideia e ainda não tem pasta.

**Quem contratar:** **Orquestrador(a)**, depois **Back-end** e **QA (testes)**.

1. **+ projeto** → **Criar pasta nova** → **Nome da pasta** e **Onde criar** → marque **Iniciar um repositório git (o painel de código e a revisão usam o diff)** → **Criar projeto**.
2. Clique no **+** do projeto → **Orquestrador(a)** → **Nome\*** → **Contratar**. Ele já vem com **Pode contratar subfuncionários** marcado.
3. Clique no **+** do Orquestrador para contratar **Back-end** e **QA (testes)**: eles passam a reportar a ele.
4. Abra o Orquestrador e descreva o pedido no chat, com o resultado esperado.

**Conferir no fim:**

- o quadro mostra a sala com os três funcionários, ligados ao Orquestrador;
- se o pedido for grande, ele mostrou o plano antes e esperou o seu ok;
- o selo do projeto mostra o que ficou **sem commit**;
- ele disse como ver funcionando (endereço, arquivo ou passo a passo).

### 2. Funcionalidade nova: plano, execução, revisão e mesclagem

**Situação:** uma funcionalidade que mexe no servidor e na tela.

**Quem contratar:** **Back-end** (executa), **Front-end** (tela, se precisar) e **Revisor(a) de código** (revisa).

1. Na ficha do **Back-end** (aba **Ficha**), marque **Trabalhar numa worktree própria** → **Salvar ficha**. Sem worktree não aparece **Mesclar**.
2. Para aprovar o plano antes, use **Autonomia** **Só planeja** na ficha dele. Com ela, a tarefa para em **Fazendo** com o selo **Plano para aprovar**.
3. Abra **Tarefas** no painel do projeto → **Nova tarefa** → **Título**, **O que precisa ser feito** (com o critério de pronto), **Quem cuida**: **Back-end** → marque **Revisão automática** e **Quem revisa**: **Revisor(a) de código** → **Criar e começar**.
4. No cartão do plano, leia e escolha **Aprovar e executar**, **Pedir mudanças** ou **Recusar plano**.
5. Quando a tarefa for para **Revisão**, abra **O que mudou** e confira o **Resumo da entrega** e o diff. Clique em **Rodar testes**.
6. Clique em **Mesclar em {base}** e confirme.

**Conferir no fim:**

- o diff mexe só no que foi pedido;
- os testes passaram (teste vermelho desfaz a mesclagem);
- a tarefa está em **Pronto**, com "mesclada em ... (commit)".

### 3. Corrigir um bug, com revisão antes de aceitar

**Situação:** algo quebrou e você consegue descrever como reproduzir.

**Quem contratar:** **Back-end** ou **Front-end** (corrige) e **Revisor(a) de código** (revisa).

1. **Tarefas** → **Nova tarefa** → **Título** ("Bug: ...").
2. Em **O que precisa ser feito**, escreva os passos para reproduzir, o resultado esperado e o que acontece hoje. Peça um teste que reproduza o bug antes da correção.
3. **Quem cuida**: o responsável → marque **Revisão automática** e **Quem revisa** → **Criar e começar**.
4. Em **Revisão**, clique em **Rodar testes** e veja se passaram. Leia o diff.
5. Se faltar algo, escreva na conversa da tarefa: ela volta para **Fazendo**.
6. Aceite com **Mesclar em {base}**. **Aprovar entrega** só move para **Pronto**; não roda testes nem mescla.

**Conferir no fim:**

- o teste de reprodução falhava antes e passa agora;
- o diff não tem mudanças fora do bug;
- você sabe se o código foi mesclado ou só aprovado.

### 4. Revisão de segurança antes de publicar

**Situação:** vai publicar uma versão com login, tokens, segredos ou rotas novas.

**Quem contratar:** **Segurança (AppSec)** (parecer, sem correção). Quem corrige é o **Back-end** ou o **Front-end** responsável.

1. Contrate **Segurança (AppSec)** pelo **+** do projeto (ou pelo **+** do Orquestrador, se ele for o gestor).
2. **Tarefas** → **Nova tarefa** → **Título** ("Auditar autenticação e rotas novas") → em **O que precisa ser feito**, delimite o escopo: o diff ou a área, não o projeto inteiro.
3. **Quem cuida**: **Segurança (AppSec)** → **Criar e começar**.
4. Leia o parecer: riscos por gravidade, arquivo:linha, correção sugerida e a área que corrige.
5. Para cada risco que vale corrigir, crie **Nova tarefa** para o responsável, com o trecho do parecer.
6. Depois da correção, use **Delegar revisão** com **Segurança (AppSec)** e confira só os riscos críticos e altos.

**Conferir no fim:**

- nenhum segredo foi colado no chat; se foi, troque-o e clique em **já troquei** no aviso **segredo** (em **precisa de mim**);
- os riscos críticos e altos estão corrigidos e reconferidos;
- as dependências com vulnerabilidade estão separadas entre produção e desenvolvimento.

### 5. Servidor e deploy com DevOps / SRE

**Situação:** um site ficou lento ou precisa de uma versão nova no ar.

**Quem contratar:** **DevOps / SRE** (autonomia **Pede tudo**: pede permissão a cada passo).

1. Contrate **DevOps / SRE**. Na ficha, aba **Projeto**, clique em **+ dar acesso a servidores (SSH e FTP)** e marque a conexão. A chave fica no seu computador; a ficha guarda só o nome.
2. **Tarefas** → **Nova tarefa** → **O que precisa ser feito**: "só diagnosticar, sem mudar nada" → **Quem cuida**: **DevOps / SRE** → **Criar e começar**.
3. Em **precisa de mim**, aprove cada cartão de **permissão** com **Aprovar**. Evite **Sempre neste projeto** para comandos no servidor.
4. Para publicar, abra a tarefa em **Pronto** (ou mesclada) → **Pedir deploy** → **Quem faz o deploy**: **DevOps / SRE**.
5. Siga o checklist: backup, estado antes e depois, runbook. Confirme os passos que não têm volta.

**Conferir no fim:**

- o backup foi feito antes do deploy;
- o runbook diz o que mudou e como desfazer;
- as imagens e os volumes das versões antigas foram removidos (regra do cargo).

### 6. Acompanhar algo que demora (despertador)

**Situação:** um CI ou um deploy leva vários minutos e você não quer ficar olhando.

**Quem contratar:** nenhum. Use o funcionário que já cuida do assunto (**DevOps / SRE** ou **Back-end**).

1. No chat dele, peça para voltar a olhar depois, por exemplo: "volte a olhar o CI em 20 minutos e me diga se passou".
2. O aviso mostra "Volta a olhar em HH:MMh" com a contagem e **Cancelar**.
3. Para ver todos os agendamentos, use **Agendamentos**, no cabeçalho do quadro de tarefas.
4. Quando ele voltar, a conversa mostra "Voltou a olhar às HH:MMh" e a resposta.

**Conferir no fim:**

- a hora e o texto aparecem em **Agendamentos**;
- só há um despertador por conversa: agendar de novo troca o anterior;
- depois de 20 despertadores seguidos sem você falar, ele pede o seu ok.

### 7. Segunda opinião do Codex numa decisão difícil

**Situação:** a tarefa já tem mudanças grandes (troca de biblioteca, mudança no banco) e você quer um segundo parecer.

**Quem contratar:** nenhum. O Codex revisa o diff de uma tarefa; ele não revisa uma ideia sem código.

1. **Configurações** → **Geral** → **Usar o Codex (GPT)**. Se não aparecer, use **Nível de uso** **Avançado**. O Club instala o Codex se faltar.
2. Na linha **Codex**, se estiver sem login, clique em **Entrar no Codex** e espere (até 3 minutos).
3. Na tarefa com mudanças, na seção **Código, revisão e deploy**, clique em **Pedir ao Codex**.
4. Espere ("O Codex está revisando… leva alguns minutos") e leia **O que o Codex achou**.
5. Compare com o parecer do **Revisor(a) de código** e decida você.

**Conferir no fim:**

- você sabe que o diff foi enviado à OpenAI e que gastou a cota do seu ChatGPT;
- arquivos de segredo não foram enviados;
- a decisão final é sua, não do Codex.

### 8. Gastar menos

**Situação:** o consumo de 5 h ou de 7 dias sobe rápido, ou um projeto consome demais.

**Quem contratar:** nenhum. Ajuste as fichas que já existem. O **Orquestrador(a)** e o **Arquiteto(a)** (Opus, High) são os mais caros: use-os para dividir e planejar, não para tarefa simples.

1. **RH e ranking** (topo do quadro) → aba **Gastos** → escolha o **Período** → lupa **Analisar o custo de {nome}**.
2. Veja os achados por prioridade. Revise as caixas marcadas e clique em **Aplicar sugestões (n)** → **Confirmar e aplicar**.
3. Na ficha, aba **Ficha**, ajuste **Modelo** e **Esforço** (valem a partir da próxima sessão). Tarefa simples não precisa de Opus.
4. **Configurações** → **Consumo** → **Orçamento por projeto** e **Trava de consumo: 5 horas** / **7 dias**. Passando da porcentagem, o Club pergunta antes de conversar.
5. **Configurações** → **Conversa** → **Conversa nova quando o assunto fecha** → **Seguir sozinho numa nova (recomendado)**.
6. Dentro de uma conversa grande, clique em **Compactar** para liberar contexto. Para começar do zero, use **+** (Nova conversa) no painel do funcionário; a ficha e a memória continuam.

**Conferir no fim:**

- o anel de contexto da conversa baixou;
- as barras 5h e 7d estão em verde (abaixo de 70%);
- a ficha mostra o modelo e o esforço novos.

## Dicas

- Peça uma coisa por tarefa, com o critério de pronto em **O que precisa ser feito**.
- Pedido grande: peça o plano antes e só então dê o ok.
- Pedido vago: o funcionário faz até três perguntas; responda com opções concretas.
- Ficha enxuta: poucas regras, só as que valem sempre (limite de 50).
- Memória curta (cerca de 60 linhas): guarde decisões, convenções e pendências, não logs.
- Segredos não vão para o chat, para a ficha nem para a memória. Para MCP com chave, use o escopo **Da conta (Club)**; **Do projeto** vai para o git.
- Autonomia mínima: comece com **Só planeja** ou **Edita sozinho**. **Sem travas** só para quem você confia, em projeto com git.
- Projeto sem git não tem worktree, diff nem **Mesclar**: crie o repositório na hora de criar o projeto.
- Confira **O que mudou** e rode **Rodar testes** antes de **Mesclar em {base}**.
- Antes de **Atualizar** o Club, deixe a árvore limpa (commit ou `git stash`).
- Mensagem durante o trabalho: **Pôr na fila** espera; **Enviar agora** interrompe.
- Antes de tentar outro caminho, use **Duplicar**: a conversa original fica.
- **Voltar até aqui** desfaz arquivos, não comandos (instalar, banco, git).
- **Revisor(a)** e **Segurança (AppSec)** dão parecer; a correção vira tarefa nova para quem é da área.
- Para mapear um projeto já existente, crie o agent **Pesquisador (Haiku, só leitura)** com **Novo agent** no painel do projeto e peça o mapa a ele.

## Erros comuns

| Problema | O que fazer |
| --- | --- |
| **Mesclar em {base}** não aparece | A tarefa não está numa worktree. Marque **Trabalhar numa worktree própria** na ficha de quem executa (o projeto precisa ser git). |
| **Aprovar entrega** marcou **Pronto**, mas o código não entrou na branch | Esse botão não roda testes nem mescla. Use **Mesclar em {base}**. |
| A revisão automática parou antes da última rodada | O limite são 2 revisões automáticas, mesmo com o cartão mostrando `n/3`. Use **Delegar revisão** para o resto. |
| **Atualizar** está desligado | Há arquivos do Club mudados à mão. Guarde-os com `git stash` e tente de novo. |
| Ações dizem que o navegador não está pareado | Clique em **Parear este navegador** e rode o `npm run pair CÓDIGO` que aparece, sempre no mesmo endereço (`claudio.localhost`). |
| A conversa de um funcionário com motor Codex não abre | **Usar o Codex (GPT)** está desligado. Ligue-o em **Geral**. |
