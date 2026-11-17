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
| segredo | Recebeu um segredo no chat, com um selo que diz se parece de verdade ou falso positivo (ver abaixo). Botões: **já troquei** e **não é segredo**. |
| esperando | Espera sua resposta. |
| erro | Parou com erro. |
| rotina | Uma rotina não rodou. |
| sem dono | Ficou sem dono num reinício. |
| dúvida, parada, bloqueada, não começou | Itens de tarefa: dúvida que espera você, revisão ou ajuste que não anda, tarefa que espera outra parada, cartão esquecido. Cada um traz a ação e abre o cartão da tarefa (ver 04, "A fila se recupera sozinha"). |

- Pergunta, espera e rotina têm um **×** para tirar o item da caixa. Ao tirar uma pergunta, ela sai sem resposta ("Tira da caixa sem responder agora"). Ao tirar uma espera, ela só sai da caixa até a sessão mudar de status.
- O aviso de **segredo** também aparece como balão na própria conversa, com a mesma frase da caixa, o selo, a dica e o botão **Ignorar** (igual a **já troquei**: tira o aviso do balão e da caixa; se o segredo aparecer de novo, ele volta; em **possível credencial exposta** o botão se chama **Já troquei**, para não sugerir deixar pra lá). Quando o aviso sabe em que arquivo o segredo está, o balão mostra o caminho e o botão **Abrir arquivo**, que abre o arquivo no editor do Claudio’s Club (o mesmo link **abrir arquivo** aparece no item da caixa); arquivo que o editor não abre, como `.env` ou chave, mostra só o caminho, com a nota para abrir no seu editor. O balão só existe na tela: não vai para o modelo. **Não é segredo** continua só na caixa, e o aviso de chave no `.mcp.json` do projeto, que não nasce numa conversa, também.
- O aviso de **segredo** diz, no balão e na caixa, se o valor parece de verdade. O **selo** é um palpite que o Claudio’s Club faz na hora em que o segredo aparece, pelo formato e pelo contexto (ele não confere a credencial no provedor, então pode errar). O estado vem escrito, não só na cor:

  | Selo | O que quer dizer |
  | --- | --- |
  | **possível credencial exposta** | Parece de verdade: token com formato de provedor, chave privada, senha longa e variada, ou senha de um host de fora. Troque. |
  | **contexto local, autenticidade desconhecida** | O host é local ou de desenvolvimento (como `localhost` ou `127.0.0.1`): não dá para saber se a senha é de verdade. |
  | **provável exemplo/teste** | Arquivo de modelo (`.env.example`), teste, valor de enchimento (`xxxx`), token com cara de exemplo ou senha padrão conhecida (`root`, `changeme`). |
  | **não foi possível determinar** | Contexto insuficiente. Trate como de verdade até conferir. |

  Token com formato válido de provedor nunca aparece como exemplo. Se depois aparecer, na mesma conversa, uma ocorrência mais grave do mesmo tipo, o aviso passa a mostrar o estado mais grave. Aviso antigo, sem palpite, aparece como antes, sem selo.
- Ao lado do selo, a **dica** mostra só um pedaço do valor para você reconhecer qual é: token de provedor mostra o prefixo público e os 4 últimos caracteres (`sk-ant-…a9F2, 108 car.`); senha de 12 caracteres ou mais, só os 2 últimos e o tamanho; senha menor, só o tamanho; senha padrão conhecida, só "senha padrão conhecida"; chave privada, nada. O Claudio’s Club nunca guarda o valor inteiro, e a dica só aparece na tela do Claudio’s Club: não vai para a extensão do Chrome, para a notificação nem para o modelo.
- **por quê?** abre o motivo do palpite (por exemplo, "O host é local ou de desenvolvimento"). O motivo já estava calculado: abrir não faz consulta nenhuma.
- **Não é segredo** vale só para aquela ocorrência: aquele valor, naquela conversa. Se o mesmo tipo de segredo aparecer com outro valor, o aviso volta. Antes valia para o tipo todo na conversa; as dispensas feitas antes continuam como eram. Em **possível credencial exposta**, use só se tiver certeza de que o valor não é uma credencial de verdade; se for, troque e clique em **já troquei**.
- O aviso de **erro** (a conversa parou com erro, ou o turno parou no teto de ferramentas ou de minutos) também aparece como balão vermelho na própria conversa, com a mesma frase da caixa. Não tem botão: erro não se dispensa, e o balão some da conversa e da caixa quando você manda mensagem nova. Quando a conversa já mostra o aviso no próprio fluxo (o teto), ele não se repete em balão. O balão só existe na tela: não vai para o modelo.
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
- Título da conversa (no seletor, em **precisa de mim** e na busca **Ctrl+K**): vale o que você escreveu com o lápis **Renomear conversa**; se não escreveu, o título gerado por IA a partir do assunto; enquanto ele não vem, o começo do assunto (a tarefa ou a sua 1ª mensagem). A conversa que o Club abre para o revisor conferir uma tarefa se chama **Revisão - título da tarefa**: o mesmo nome da coluna **Revisão** do quadro de tarefas, no idioma da tela (*Review - …* em inglês, *Revisión - …* em espanhol), sem IA, mesmo com os títulos por IA desligados; o título que você escreveu no lápis vale mais que ele, e se você mudar de assunto nela, o título passa a seguir o assunto novo. Título longo é cortado com reticências. O título gerado só existe em conversa do Club com assunto livre: a de tarefa, a de assunto vago, a aberta fora do Club e a que a geração falhou ficam com o começo do assunto. Para voltar ao automático, abra **Renomear conversa**, deixe o campo vazio e salve: volta ao título gerado, ou ao assunto se não houver. Para não ter título gerado por IA, desmarque **Títulos de conversa por IA** nas Configurações (grupo **Conversa**; no Simples, **Dar título às conversas com IA**, em **Conversas**): o Club para de chamar o modelo (que gasta um pouco da cota da assinatura) e a lista mostra o começo do assunto; os títulos que você escreveu seguem valendo. Vem ligada.

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
