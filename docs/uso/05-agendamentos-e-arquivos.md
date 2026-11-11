# Agendamentos e arquivos

Esta página cobre três telas do projeto: **Agendamentos**, **Arquivos** e o painel de mudanças sem commit.

## Agendamentos

Abra pelo botão **Agendamentos**, no cabeçalho do quadro de tarefas. O título é "Agendamentos · {projeto}".

A tela diz: "O que os funcionários deixaram marcado para fazer sozinhos. Cancele o que não deve acontecer."

| Tipo | O que é |
| --- | --- |
| **Despertador** | Pedido pelo próprio funcionário. Na hora marcada ele recebe a mensagem e volta ao trabalho. |
| **Continuar após o limite** | Automático. O limite de uso da assinatura acabou no meio de uma conversa. O "continue" é enviado quando o limite voltar. |

Cada item mostra:

- quem (o nome do funcionário; **Freela** para conversa sem ficha);
- a hora ("às HH:MMh", com a data se for outro dia) e a contagem regressiva ("em 4min 05s", "agora");
- o texto do despertador, ou "(sem mensagem)" se estiver vazio.

Botões de cada item:

- **Abrir conversa**: abre a conversa.
- **Cancelar**: pede confirmação ("Cancelar este agendamento? Nada será feito na hora marcada."). Use **Sim, cancelar** ou **Manter**.

Avisos possíveis:

- "Agendamento cancelado."
- "Esse agendamento já não existe (já aconteceu ou foi cancelado)."
- "Não deu para cancelar: {erro}".
- "Nenhum agendamento pendente." (lista vazia)

A lista é relida a cada 5 segundos. **Ver tarefas** volta ao quadro.

Quando uma tarefa troca de motor (ver 06), o despertador e o "continue" da conversa antiga são cancelados. A hora do despertador vai para o resumo da conversa nova.

## Arquivos

Abra pelo botão **Arquivos** no painel do projeto ("Ver e editar os arquivos do projeto"). O título é "Arquivos de {projeto}".

- À esquerda, a árvore. Clique numa pasta para abrir; clique num arquivo para editar.
- À direita, o editor.
- **Salvar** (ou Ctrl+S) grava o arquivo. Nada é salvo sozinho.
- O estado aparece ao lado: **Salvando…**, **Salvo**, **Não salvo** ou **Erro ao salvar** (clique em **Tentar de novo**).

### Criar

- **Arquivo** ou **Pasta** abre um campo para o nome. Enter cria, Esc cancela.
- Cria dentro da pasta selecionada, ou "na raiz do projeto".
- O nome não pode começar com `/` ou `\` e não pode ter `..`.

### Apagar

- Selecione o item e clique na lixeira ("Apagar {caminho}"). Há confirmação.
- É permanente: não vai para a lixeira. Numa pasta, apaga tudo o que está dentro.
- Não apaga: segredos (`.env` e parecidos), `.git`, `node_modules` e `.myco`, nem pasta que contenha algum deles.

### Limites e casos especiais

- Arquivo de segredo aparece com cadeado e não abre: "Arquivo de segredo: aparece na lista, mas não abre aqui."
- Para editar, o limite é 1 MB. Acima disso: "Arquivo grande demais para editar aqui (mais de 1 MB)."
- Arquivo binário não edita como texto. Imagem só aparece para ver, até 10 MB.
- Conflito: se o arquivo mudou no disco (por exemplo, um funcionário editou), nada é sobrescrito. Escolha **Recarregar do disco** ou **Manter o meu e salvar por cima**.
- Saindo com mudança não salva, a tela pergunta: "Há mudanças não salvas. Sair e perder essas mudanças?".
- Fechar: **×** ou Esc.
- No celular, uma coisa por vez. Para voltar à árvore, use **‹ Arquivos**.

## Mudanças sem commit

No quadro, o selo do projeto mostra **{n} sem commit** (ou **limpo**). Clique no selo para abrir "Sem commit em {projeto}".

- Cada grupo é uma conversa que editou esses arquivos.
- **Pedir commit** e depois **Confirmar** manda à conversa dela um pedido fixo: commitar só os arquivos dela, nomeando-os no `git add`. O pedido proíbe `git add -A` e também push ou PR sem pedido seu.
- Depois do envio aparecem **Pedido enviado** e **Abrir conversa**.
- Se outra conversa também mexeu no arquivo, o item mostra "também mexido por ...". Nesse caso o pedido manda separar só os trechos dela.
- Conversa sem ficha: só a lista, sem botão ("conversa sem ficha: só a lista").
- **Sem dono**: arquivos editados à mão ou em conversas antigas. Não tem botão, porque não dá para saber de quem são.
- **Atualizar** relê a lista.

## Problemas comuns

| Sintoma | O que fazer |
| --- | --- |
| Arquivo não abre | É segredo, passou de 1 MB ou é binário. Ver os limites acima. |
| "Erro ao salvar" | Clique em **Tentar de novo**. |
| Aparece o aviso de conflito | Escolha **Recarregar do disco** para ver a versão do disco, ou **Manter o meu e salvar por cima**. |
| "Não deu para cancelar" | Tente de novo. Se a linha sumir da lista, o agendamento já aconteceu ou foi cancelado. |
