# Configurações e atualização

## Abrir as configurações

- Engrenagem no topo, ou Ctrl+, (vírgula).
- O painel tem o campo **Buscar configurações**. O que aparece depende do **Nível de uso**.
- No **Simples**, as configurações vêm em cartões por tema, cada um com ícone. Cada item tem título em linguagem comum, uma frase do que muda para você e o controle ao lado (os interruptores mostram **Ligado** ou **Desligado**). Os temas são **Nível de uso**, **Aparência**, **Quadro**, **Conversas**, **Gasto e limites**, **Internet e Chrome**, **Segurança e atualização** e **Ajuda e sobre**. Para ver o resto, use **Passar para o nível Avançado** (no fim da lista) ou escolha **Avançado** em **Nível de uso**.
- No **Avançado**, a lista é técnica, com os grupos **Geral**, **Quadro**, **Conversa**, **Consumo**, **Fila de tarefas**, **Cargos**, **MCPs** e **Créditos**. Dentro de **Geral** há as seções **Ajuda**, **Internet e GPT**, **Extensão do Chrome** e **Sistema**. Só aparecem no Avançado: **Servidor**, **Monitor de CPU e memória**, **Mostrar o escopo do usuário** e os **MCPs**.
- Os nomes dos grupos e dos itens nas tabelas abaixo são os do **Avançado**. Os mesmos itens existem no Simples, com o título em linguagem comum (por exemplo, **Idioma** fica em **Aparência**, e **Atualizações** em **Segurança e atualização**).

## Itens mais usados

| Item | Grupo | O que faz |
| --- | --- | --- |
| **Idioma** | Geral | Português (Brasil), English ou Español. Vale neste navegador e recarrega a página. |
| **Títulos de conversa por IA** | Conversa | Ligado por padrão: o Club pede ao Haiku (o modelo mais leve do Claude) um título curto para cada conversa com assunto livre, e isso gasta um pouco da cota da assinatura. Desmarque para não gastar: a lista passa a mostrar o começo do assunto. Os títulos que você escreveu em **Renomear conversa** continuam valendo. No Simples: **Dar título às conversas com IA**. |
| **Retomar sozinho quando a conversa cair por falha passageira** | Conversa (avançado) | Ligado por padrão: se a conversa de um funcionário parar por falha passageira (API sobrecarregada, erro 5xx, limite de taxa, queda de conexão) ou o processo cair no meio do turno, ela segue sozinha, com espera de 30 s, 2 min e 8 min e até 3 tentativas por turno. Não retoma erro de login, cobrança nem limite de uso, e não repete uma ação que mexia fora do projeto: nesses casos avisa em **Inbox**. Desligado, a conversa fica parada até você mandar mensagem. Detalhes na página 03. Só no Avançado; no Simples a retomada fica ligada. |
| **Usar o Codex (GPT)** | Geral, seção Internet e GPT (avançado) | Liga o Codex. Ao ligar, o Club instala o Codex CLI se ele faltar. Gasta a cota do seu ChatGPT. |
| **Modelo do GPT** | Geral, seção Internet e GPT (avançado) | Modelo do Codex usado nas perguntas ao GPT. **Padrão do Codex** deixa o Codex escolher. Só aparece com o Codex ligado. |
| **Avisos e tarefa rápida no Chrome** | Geral, seção Extensão do Chrome | Baixa a extensão do Chrome, mostra como instalar, gera o código de pareamento e lista os pareamentos, com **Revogar**. Ver a página 09. |
| **Atualizações** | Geral, seção Sistema | Mostra a versão e tem **Procurar agora**. Ver "Atualizar o Club" abaixo. |
| **Bloquear o Claudio’s Club no navegador dos funcionários** | Geral (avançado) | Ligado por padrão: o navegador do funcionário (que é o seu, já pareado) não abre a tela do Club, para ele não aprovar nem mesclar no seu lugar. Desligue só para testar o próprio Club. Para só ver a tela, use `http://localhost:5173` (sem pareamento). Vale para conversas novas. |
| **Servidor** | Geral, seção Sistema (avançado) | **Reiniciar** e **Parar o Clube dos Claudios**. Ao parar, as conversas abertas fecham e as rotinas param até o servidor voltar. |
| **Parar ao fechar a aba** | Geral, seção Sistema (avançado) | Desligado por padrão: fechar a aba ou o navegador deixa o servidor rodando em segundo plano. Ligado, o Clube dos Claudios para sozinho cerca de 30 segundos depois que a **última** aba dele fechar. Recarregar (F5), navegar dentro do app ou fechar só uma de várias abas não para. Para do mesmo jeito que o botão **Parar**: as conversas em andamento são interrompidas (ficam salvas) e as rotinas só voltam quando você iniciar o servidor de novo. Se o servidor subir sem nenhuma aba aberta (início automático, `npm run daily:start`), ele não para por isso: só conta depois que uma aba o abriu. |

Se você não acha **Usar o Codex (GPT)**, mude **Nível de uso** para **Avançado**.

## Codex

1. Ligue **Usar o Codex (GPT)** em Geral. O Club instala o Codex se faltar.
2. Na linha **Codex**, no topo do quadro (ou nas configurações):
   - **Instalar o Codex**, se o CLI não está instalado. Enquanto instala, aparece "Instalando Codex…".
   - **Entrar no Codex**, se está sem login. O login abre no navegador. A tela espera até 3 minutos ("aguardando login…").
3. Conectado, o ícone mostra "Codex conectado" com a versão.
4. Com o Codex ligado, o GPT é usado em três casos: funcionário que roda no motor Codex, pergunta ao GPT e segunda opinião nas tarefas. A segunda opinião envia o diff para a OpenAI.
5. Com o Codex desligado, as conversas de quem roda no Codex não abrem.

## Claude

- Na linha **Claude**, no topo: "CLI logado pela assinatura" é o estado normal.
- **Entrar no Claude** aparece quando o CLI está deslogado.
- **Entrar pela assinatura** aparece quando o CLI está logado pela API, e não pela assinatura.

## Atualizar o Club

Em linguagem simples:

- Quando sai uma versão nova, o topo do quadro mostra **Nova versão**. O Club confere ao subir e depois a cada 6 horas.
- **Atualizar** leva o código até a versão publicada no GitHub (uma tag `vX.Y.Z`). Ele só avança e não apaga nada seu. Se as dependências mudaram, instala. Depois reinicia.
- O Club segue as versões publicadas, não a branch principal. O que foi mesclado na principal só chega quando a versão sai.
- Com o vigia (o processo que sobe o servidor de novo), o botão é **Atualizar e reiniciar**. A página recarrega sozinha quando o servidor novo responde.
- Sem o vigia, o botão é **Atualizar**. Depois, reinicie à mão: "pare e rode `npm run daily:start` na pasta dele".
- **Procurar agora** busca no GitHub. Só busca de novo uma vez por minuto.

O botão **Atualizar** fica desligado nestes casos, com o motivo escrito na tela:

| Motivo na tela | O que fazer |
| --- | --- |
| "há arquivos do Clube dos Claudios mudados à mão: guarde ou desfaça (git stash) para atualizar por aqui" | Guarde (`git stash`) ou desfaça as mudanças nos arquivos do Club, e tente de novo. Arquivo novo que o git ainda não conhece não impede. |
| "este código tem commits que a {versão} não tem: atualize pelo terminal (git merge {versão})" | Faça a atualização pelo terminal, com o comando indicado. |
| "Esta cópia não veio de um git clone do GitHub: para atualizar, baixe de novo" | Baixe o Club de novo, pelo git clone do GitHub. |

## Problemas comuns

| Sintoma ou mensagem | O que fazer |
| --- | --- |
| "Não consegui buscar no GitHub: {erro}" | Sem rede, ou o GitHub está fora. Tente **Procurar agora** depois. |
| "o Clube dos Claudios não voltou em 3 min: veja o log com npm run daily:status" | Rode `npm run daily:status` para ver o log. |
| "o código foi atualizado (...), mas o npm install falhou" | Rode `npm run setup` no terminal. |
| "consumo: instale o myco-tap" | Rode `npm run mod:install`. |
| "consumo: abra uma sessão nova no app" | Abra uma sessão nova no app e mande uma mensagem. |
| "`claude` não encontrado no PATH" ou **CLI não encontrado** | O comando `claude` precisa estar acessível no terminal do computador. |
| **Codex CLI não instalado** | Clique em **Instalar o Codex**. |
| **Codex sem login** | Clique em **Entrar no Codex**. |
| "Codex: sem leitura" ou "Não deu para ler os limites do Codex" | Tente de novo. Se continuar, confira o login do Codex. |
| "atualize: {comando}" (Codex) | Rode o comando mostrado. Há uma versão nova do Codex CLI. |
| "O terminal dos funcionários no Codex não funciona nesta máquina" (Windows) | A política de senha do Windows trava a sandbox do Codex. Abra o PowerShell como administrador e rode `net accounts /minpwage:0` (o aviso tem o botão **Copiar**). Ver `06-consumo-e-motores.md`, "Codex no Windows". |
| Dúvida sobre o que falta para rodar | Rode `npm run doctor`. Ele só lê e mostra o que falta. |
