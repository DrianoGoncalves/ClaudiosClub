# Extensão do Chrome

Mostra no Chrome o que espera você e cria tarefas com responsável, mesmo com a aba do Club fechada.

## O que faz

- **Avisos**: de minuto em minuto, a extensão lê a caixa "precisa de mim" e mostra uma notificação do Chrome para cada item novo, com os mesmos tipos de aviso que a aba do Club mostra (plano para aprovar, permissão, segredo no chat, espera de resposta, erro, rotina que não rodou, consumo perto do limite, tarefa esquecida ou bloqueada). Um mesmo aviso não aparece duas vezes. Nos avisos de segredo, a extensão não recebe o selo (real ou falso positivo) nem a dica do valor: eles só aparecem na tela do Claudio’s Club. O número no ícone é quantos itens estão na caixa.
- **Clicar no aviso** abre o Club numa aba nova, na tela de quem espera. Avisos de tarefa (esquecida em A fazer, esperando outra) abrem o quadro de tarefas do projeto; aviso de consumo abre as Configurações.
- **Tarefa rápida**: clique no ícone da extensão, escolha o **Projeto** e o **Responsável** (as fichas do projeto), dê um **Título** e, se quiser, uma **Descrição**. A tarefa entra no quadro em **Aguardar**; marque **Iniciar já** para ela começar (vale a trava de consumo: pode ficar na fila de **A fazer**).
- **Da página atual**: você pode anexar a URL e o título da aba aberta e o texto selecionado nela. Nada é anexado sem você marcar. O que vem da página entra na descrição citado e avisado como **conteúdo externo**: é dado, não instrução, e o funcionário não deve executar o que ele pedir. A URL sai do Chrome sem usuário, senha, fragmento (`#…`) nem o valor de parâmetros que parecem segredo (`token`, `key`, `code`, `session`…).

## Instalar

1. Em **Configurações → Geral → Extensão do Chrome**, clique em **Baixar extensão**.
2. Descompacte o `.zip` numa pasta que você não vai apagar (o Chrome lê a extensão dali).
3. No Chrome, abra `chrome://extensions` (digite na barra de endereço), ligue **Modo do desenvolvedor** e clique em **Carregar sem compactação**. Escolha a pasta descompactada.
4. Fixe o ícone do Claudio’s Club na barra do Chrome (o quebra-cabeça) para ver o número dos avisos.

Não há instalador, `.crx` nem Chrome Web Store. Para atualizar, baixe de novo, troque os arquivos da pasta e clique em recarregar na página `chrome://extensions`. O ID da extensão não muda entre versões.

## Parear

A extensão só fala com o Club depois de pareada.

1. Em **Configurações → Geral → Extensão do Chrome**, escreva um nome para este Chrome (opcional) e clique em **Gerar código de pareamento**.
2. Clique no ícone da extensão e digite o código (`XXXX-XXXX`). O código serve uma vez e vale 5 minutos.
3. As Configurações avisam quando a extensão pareia, e ela entra na lista **Pareadas**.

Cada Chrome pareado recebe um token que fica só na extensão. O Club guarda só um resumo dele, nunca o token nem o código. Cabem até 5 pareamentos ao mesmo tempo.

## Revogar

Em **Pareadas**, **Revogar** ao lado do pareamento e confirme. A extensão perde o acesso na hora: o ícone mostra `!` e o popup pede para parear de novo. **Desparear**, no rodapé do popup, só esquece o token naquele Chrome; para invalidar de vez, revogue nas Configurações (por exemplo, se o Chrome foi perdido ou emprestado).

## Limites

- O **Club (o servidor) e o Chrome precisam estar abertos**. Os avisos chegam em até 1 minuto, porque a extensão lê a caixa a cada minuto.
- **Club fora do ar**: o ícone mostra `off` e o popup mostra **Club offline**. Não existe fila: a tarefa não é guardada para depois, e o que você digitou continua no formulário até fechar o popup.
- O Club precisa estar no endereço padrão, porta **4848**. Com outra porta (`MYCO_PORT`) a extensão não funciona, e o botão de baixar recusa o pacote.
- As notificações precisam estar permitidas para o Chrome no sistema (no Windows, o modo Não incomodar as esconde; o número no ícone continua).
- O texto de cada aviso vem do Club em português; os textos da própria extensão seguem o idioma do Chrome (português, inglês ou espanhol).
- O aviso "fulano terminou" da aba do Club (turno que acabou) não chega pela extensão: só a caixa "precisa de mim".
- A extensão só lê as abas quando você clica no ícone, e só a aba atual.

## Segurança

- Permissões mínimas: notificações, alarmes, armazenamento local e a aba atual (só ao clicar no ícone), e acesso só ao endereço local do Club. A extensão não injeta nada em páginas.
- Fala só com 4 rotas do Club (parear, ler a caixa, listar projetos e criar tarefa). Não lê conversa, arquivo nem configuração.
- Token revogado, código vencido ou pareamento cheio são recusados pelo Club com o motivo.

## Problemas comuns

| Sintoma | O que fazer |
| --- | --- |
| **Baixar extensão** diz que a extensão não está nesta versão | Atualize o Club (Configurações → Geral → Sistema → Atualizações). |
| O Chrome recusa **Carregar sem compactação** | Descompacte o `.zip` antes e escolha a pasta que tem o `manifest.json`, não o `.zip`. |
| Código inválido ou expirado | Gere outro: vale 5 minutos e só uma vez. |
| "Limite de 5 extensões pareadas" | Revogue uma em **Pareadas** e gere outro código. |
| Ícone com `off` | O Club está fora do ar: abra o Club. O ícone volta sozinho em até 1 minuto. |
| Ícone com `!` | O pareamento foi revogado: gere um código novo e pareie de novo. |
| Não aparece notificação, mas o número sobe | Permita as notificações do Chrome nas configurações do sistema. |
