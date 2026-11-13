# Configurações e atualização

## Abrir as configurações

- Engrenagem no topo, ou Ctrl+, (vírgula).
- O painel tem o campo **Buscar configurações** e os grupos **Geral**, **Quadro**, **Conversa**, **Cargos**, **MCPs**, **Consumo** e **Créditos**.
- **Nível de uso**: **Simples** esconde o que é avançado. Para ver tudo, use **Mostrar tudo** ou escolha **Avançado**.

## Itens mais usados

| Item | Grupo | O que faz |
| --- | --- | --- |
| **Idioma** | Geral | Português (Brasil), English ou Español. Vale neste navegador e recarrega a página. |
| **Usar o Codex (GPT)** | Geral (avançado) | Liga o Codex. Ao ligar, o Club instala o Codex CLI se ele faltar. Gasta a cota do seu ChatGPT. |
| **Modelo do GPT** | Geral (avançado) | Modelo do Codex usado nas perguntas ao GPT. **Padrão do Codex** deixa o Codex escolher. Só aparece com o Codex ligado. |
| **Atualizações** | Geral | Mostra a versão e tem **Procurar agora**. Ver "Atualizar o Club" abaixo. |
| **Bloquear o Claudio’s Club no navegador dos funcionários** | Geral (avançado) | Ligado por padrão: o navegador do funcionário (que é o seu, já pareado) não abre a tela do Club, para ele não aprovar nem mesclar no seu lugar. Desligue só para testar o próprio Club. Para só ver a tela, use `http://localhost:5173` (sem pareamento). Vale para conversas novas. |
| **Servidor** | Geral | **Reiniciar** e **Parar o Clube dos Claudios**. Ao parar, as conversas abertas fecham e as rotinas param até o servidor voltar. |

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
| Dúvida sobre o que falta para rodar | Rode `npm run doctor`. Ele só lê e mostra o que falta. |
