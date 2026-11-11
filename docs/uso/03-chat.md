# Conversar com o funcionário

Fontes: `client/src/chat/ChatView.tsx`, `client/src/inbox/InboxMenu.tsx`, `server/staff/ficha.ts`. Os botões de conversa (**Nova conversa**, **Duplicar**, seletor **Conversa**) estão em `client/src/detail/Detail.tsx`.

## Mandar mensagem

1. Clique no funcionário no quadro. O painel dele abre com a conversa.
2. Escreva na caixa e aperte **Enter**. **Shift+Enter** quebra a linha. Digite `/` no começo para os comandos da sessão, ou `@` para os arquivos do projeto.
3. O botão de envio faz o mesmo que o Enter.
4. Numa conversa nova, a tela diz: "Comece a conversa: [nome] lê a ficha e a memória antes de responder."

## Enquanto ele trabalha

Você pode mandar mensagem no meio do trabalho. O que acontece depende de **Configurações** → **Conversa** → **Mensagem durante o trabalho** (vale para todos os funcionários):

| Opção | Botão | O que acontece |
| --- | --- | --- |
| entra no meio | **Enviar** | Entra entre uma ferramenta e outra, sem parar. |
| vai para a fila | **Pôr na fila** | Espera ele terminar e vira a próxima mensagem. |
| interrompe | **Enviar agora** | Interrompe o que ele está fazendo e responde já. |

- **Parar** interrompe o turno atual.
- Uma linha discreta acima da caixa mostra o que ele está fazendo agora.
- O chip "N em segundo plano" lista os agents e comandos que estão rodando. Clique para ver e **parar** cada um.

## Anexos

- **Anexar arquivo**, ou cole com Ctrl+V. Aceita imagem, texto e PDF.
- Até 4 imagens por mensagem e até 5 arquivos. PDF até 2,9 MB; texto até 200 KB.
- Imagens são reduzidas no navegador antes de ir.
- Arquivo de outro tipo não entra: "Não dá para anexar [nomes]: só imagem, texto ou PDF."

## Ajustes desta conversa

- A barra logo abaixo da caixa tem **modelo**, **esforço** e **autonomia** só desta conversa. Vale na hora; a ficha não muda.
- **Chat detalhado** (**Configurações** → **Conversa**): mostra as leituras, buscas e comandos que ele fez. Sem ele, a conversa mostra só as mensagens, os pedidos de permissão e os avisos.
- Ícone de **MCPs** (só no nível avançado, com a conversa rodando): liga e desliga MCPs só nesta conversa.
- **Compactar**: resume o início da conversa para liberar contexto. O anel ao lado mostra o quanto do contexto está em uso (o número aparece ao passar o mouse).
- Ícone **O que mudou**: os arquivos que ele mudou, o diff, os testes e, na worktree dele, **mesclar**.

## Precisa de mim

O botão **precisa de mim** fica no topo do quadro, com um contador. Clique para abrir a lista; clique num item para abrir a conversa dele.

| Rótulo | Quando aparece |
| --- | --- |
| plano | Tem um plano para você aprovar. |
| permissão | Pede permissão para uma ação. |
| segredo | Recebeu um segredo no chat. Botões: **já troquei** e **não é segredo**. |
| esperando | Espera sua resposta. |
| erro | Parou com erro. |
| rotina | Uma rotina não rodou. |
| sem dono | Ficou sem dono num reinício. |

- Pergunta, espera e rotina têm um **×** para tirar o item da caixa. Ao tirar uma pergunta, ela sai sem resposta ("Tira da caixa sem responder agora"). Ao tirar uma espera, ela só sai da caixa até a sessão mudar de status.
- Se nada espera você, a lista diz: "Nada espera você agora."
- A caixa tem a opção **avisar no sistema (inclusive quando alguém termina)**.

### Permissão (cartão "Pede permissão: [ferramenta]")

- **Aprovar**: vale só para este pedido.
- **Sempre nesta conversa**: não pergunta mais isso nesta conversa.
- **Sempre neste projeto**: libera de vez no projeto.
- **Negar**.
- Perguntas com opções não têm os botões "Sempre".

### Plano (cartão "Plano pronto")

- **Aprovar e executar**: executa com a autonomia da ficha. Se a ficha for **Só planeja**, executa como **Edita sozinho**.
- **Pedir mudanças**: ele continua só planejando. Escreva o que mudar.
- **Recusar plano**: não executa e tira a tarefa da fila (vai para Aguardar).

### Pergunta (cartão "Pergunta para você")

- Escolha a resposta (ou **Outra resposta…**) e clique em **Responder**. Se disser "pode marcar mais de uma", marque quantas quiser.
- **Pular**: segue sem responder. Ele fica sabendo que você não respondeu.

## Arquivo citado vira link

- Quando a resposta cita um arquivo do projeto, com o caminho relativo entre crases (por exemplo `src/app.ts:42`), o caminho vira link. Clique para abrir no **editor de arquivos**.
- Se não virar link, o caminho aparece só como texto.

## Despertador

- Para acompanhar algo que demora (deploy, CI, um site), o funcionário pode pedir para voltar a olhar depois, entre 10 s e 24 h.
- Só um despertador por conversa. Agendar de novo troca o anterior.
- O aviso mostra "Volta a olhar em HH:MMh (Ns)", com a contagem regressiva e **Cancelar**. Quando ele volta: "Voltou a olhar às HH:MMh." Cancelado: "Despertador cancelado."
- Depois de 20 despertadores seguidos sem você falar, ele recusa o próximo e pede o seu ok.

## Conversa nova e ponto de corte

- **Configurações** → **Conversa** → **Conversa nova quando o assunto fecha**. As opções são **Seguir sozinho numa nova (recomendado)**, **Só avisar** e **Não mexer**.
- Pela descrição da tela: quando ele termina um assunto e registra o essencial na memória, e a conversa está grande (ou parada há tempo para o cache expirar, em geral 1 h), a sua próxima mensagem segue numa conversa nova. Ela lê só a ficha e a memória, fica mais barata, e a anterior continua na lista. A conversa de uma tarefa nunca troca.
- A tela não detalha o que **Só avisar** e **Não mexer** fazem. Se perguntarem, diga que não sabe.
- Conversa nova à mão: no painel do funcionário, o botão **+** (título "Nova conversa") começa do zero. A ficha e a memória continuam.
- **Duplicar**: uma cópia da conversa, com todo o histórico, para tentar outro caminho sem perder a original.
- O seletor **Conversa** lista as conversas agrupadas por dia.

## Voltar até aqui

- Em cada mensagem sua, **↶ voltar até aqui** devolve os arquivos ao que eram antes dela. Mostra a lista e pede confirmação.
- Comandos que ele rodou (instalar, banco, git) não são desfeitos.
- Só funciona para mensagens enviadas pelo Claudio's Club a partir desta versão.

## Outros avisos e botões

- Mensagem com a etiqueta **automática**: aviso da própria plataforma, não foi você que escreveu.
- **Copiar**, nas respostas dele: copia a resposta inteira em markdown.
- Conversa que está aberta fora do Claudio's Club (app do Claude ou terminal): aparecem **Trazer para o Clube dos Claudios** (cria uma cópia independente aqui, com o histórico; a original segue lá) e **Assumir aqui** (a outra aba perde a conexão; pede confirmação).

## Fora desta página

Limite de consumo e motores: `06-consumo-e-motores.md`. Tarefas: `04-tarefas.md`. Se a dúvida não estiver aqui, diga que não sabe.
