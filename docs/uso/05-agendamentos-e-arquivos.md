# Agendamentos e arquivos

Esta página cobre três telas do projeto: **Agendamentos**, **Arquivos** e o painel de mudanças sem commit.

## Agendamentos

Abra pelo botão **Agendamentos**, no cabeçalho do quadro de tarefas. Abre uma tela cheia, com o título "Agendamentos · {projeto}" e o texto: "O que os funcionários fazem sozinhos: rotinas que repetem, despertadores e o "continue" do limite de uso. À direita, o calendário do que vai rodar."

- **Esquerda**: as rotinas de **todos** os funcionários do projeto ("Rotinas (n)", com **+ Nova rotina**) e, embaixo, os despertadores e "continue" ("Despertadores e “continue” (n)").
- **Direita**: o calendário do mês, de domingo a sábado. **‹** e **›** trocam de mês; **Hoje** volta ao mês atual.
- Em tela estreita (menos de 860 px) as duas colunas viram duas abas: **Lista** e **Calendário**.

A lista é relida a cada 5 segundos. **Ver tarefas** volta ao quadro. O horário é o deste computador.

### Rotinas

Uma rotina manda uma mensagem ao funcionário no horário marcado, sozinha: todo dia, toda semana, quinzenal, todo mês, a cada N dias, a cada N minutos ou horas, ou uma vez só.

Cada rotina mostra:

- o nome e o botão **Ligada** / **Desligada** (liga ou desliga sem apagar);
- o funcionário e onde roda (na última conversa, numa conversa nova ou como tarefa no quadro);
- o "quando roda" por extenso (ex.: "todo dia às 08:00");
- "Próxima: …" com a contagem; e, se estiver ligada com atraso, "Roda com atraso: até N h depois do horário";
- a última execução (e o motivo, se falhou);
- a mensagem;
- **Histórico (n)**: guarda as últimas 50 execuções.

Botões: **Editar**, **Rodar agora** e **Apagar**. **Rodar agora** manda a mensagem já, sem esperar o horário. **Apagar** para a rotina e some com o histórico dela. Os dois pedem confirmação na própria linha.

No histórico, cada linha tem o estado, o horário, o motivo (texto do servidor), "rodou N min depois do horário" quando atrasou, o selo **Rodar agora** (execução manual) e "N execuções" quando um descarte cobre várias.

### Estados

O símbolo e o texto dizem o estado; a cor só reforça. Valem para o histórico e para o calendário.

| Símbolo | Estado | Quer dizer |
| --- | --- | --- |
| ○ | prevista | ainda vai rodar |
| ✓ | rodou | a mensagem foi enviada |
| ✕ | falhou | foi pulada ou deu erro (o motivo está no histórico) |
| – | descartada | perdida: estava fechado e passou do limite de atraso, ou uma mais recente tomou o lugar |
| ? | incerta | o programa caiu depois de reservar o horário e antes de terminar: não se sabe se começou, e ele não tenta de novo sozinho |
| · | sem registro | já passou e o histórico (últimas 50) não lembra mais |

### Criar e editar rotina

**+ Nova rotina** e **Editar** abrem o mesmo formulário:

- **Funcionário**: não troca ao editar. Quem já tem 10 rotinas (o máximo) fica indisponível.
- **Nome** e **Mensagem**.
- **Onde**: na última conversa, numa conversa nova ou criar tarefa no quadro.
- **Repetir**: Uma vez, Todo dia, Toda semana (escolha os dias), Quinzenal (a cada 2 semanas), Todo mês (no dia do mês; mês sem esse dia roda no último), A cada N dias, semanas ou meses, **A cada N minutos**, **A cada N horas**, ou Cron (avançado).
- **Começa em** (ou **Data**, em "Uma vez"), **Hora** e **Termina em** (opcional; o dia do fim ainda roda). "A cada N minutos", "A cada N horas" e Cron não têm esses campos: rodam pelo relógio.
- **Rodar com atraso** e **Ligada**.

Antes de salvar, a prévia mostra "Roda … Próximas: …". Se não houver execução futura, avisa para conferir as datas.

**A cada N minutos** aceita 5, 6, 10, 12, 15, 20 ou 30 (os que dividem a hora certinho) e roda sempre nos mesmos minutos de cada hora: de 30 em 30 é :00 e :30, e não "30 minutos depois de salvar". **A cada N horas** aceita de 1 a 12 e roda no minuto 0, contando da meia-noite (de 2 em 2 horas: 00:00, 02:00, 04:00…; de 5 em 5: 00:00, 05:00, 10:00, 15:00, 20:00 e de novo 00:00). Por dentro as duas são um cron (`*/N * * * *` e `0 */N * * *`), então rotinas antigas com esse cron abrem direto nessas opções ao **Editar**.

Cron tem 5 campos: minuto, hora, dia do mês, mês e dia da semana. Ex.: `*/30 * * * *` = a cada 30 minutos; `0 8 * * 1-5` = dias úteis às 08:00. Um cron de passo que não repete de N em N (por exemplo `*/45 * * * *`, que roda no minuto 0 e no 45 de cada hora, ou `0 */13 * * *`) abre no Cron (avançado), com o texto que estava, e um aviso curto; confira as "Próximas" antes de salvar.

**Esc** com o formulário aberto: se você não mudou nada, fecha o formulário; se mudou, pergunta "Descartar o que você mudou neste formulário?" na própria tela (**Sim, descartar** ou **Continuar editando**; Esc de novo também volta a editar). **Cancelar** descarta direto.

Se o servidor recusar sem dizer o motivo (ao salvar, ligar, apagar, rodar agora ou cancelar um despertador), a tela mostra "Não deu certo: o servidor não explicou o motivo" em vez de ficar calada. Se este navegador ainda não estiver pareado, a mensagem diz isso.

Ao salvar, o calendário vai ao mês da próxima execução. Execuções anteriores à criação, à edição da recorrência ou a ligá-la não aparecem, porque a rotina ainda não existia ali.

### Rodar com atraso

Desligado por padrão. Ligado, pede **Limite de atraso (horas, de 1 a 168)**.

- Se o Clube dos Claudios estiver fechado (ou parado) na hora marcada, ao abrir ele roda **uma vez** a execução perdida mais recente, desde que tenha passado há no máximo N h.
- Passou do limite: descarta. As outras execuções perdidas também são descartadas (ficam no histórico como "descartada").
- Desligado: só roda no minuto marcado. Fechado nessa hora, a execução se perde.

### Calendário

- Cada dia mostra as execuções das rotinas e os despertadores e "continue" pendentes.
- Clique num dia: embaixo aparece o que roda nele (hora, rotina, funcionário, estado, mensagem e **Editar**).
- Se o mês tiver mais execuções do que cabem: "Há mais execuções do que cabem na tela: o calendário ficou incompleto neste mês."

### Despertadores e "continue"

Ficam embaixo das rotinas, em "Despertadores e “continue” (n)". Some quando não há nenhum.

| Tipo | O que é |
| --- | --- |
| **Despertador** | Pedido pelo próprio funcionário. Na hora marcada ele recebe a mensagem e volta ao trabalho. |
| **Continuar após o limite** | Automático. O limite de uso da assinatura acabou no meio de uma conversa. O "continue" é enviado quando o limite voltar. |

Cada item mostra quem (o nome do funcionário; **Freela** para conversa sem ficha), a hora ("às HH:MMh", com a data se for outro dia), a contagem regressiva ("em 4min 05s", "agora") e o texto do despertador, ou "(sem mensagem)" se estiver vazio.

Botões de cada item:

- **Abrir conversa**: abre a conversa.
- **Cancelar**: pede confirmação ("Cancelar este agendamento? Nada será feito na hora marcada."). Use **Sim, cancelar** ou **Manter**.

### Avisos possíveis

- "Agendamento cancelado."
- "Esse agendamento já não existe (já aconteceu ou foi cancelado)."
- "Não deu para cancelar: {erro}"
- "Não deu para ler os agendamentos: {erro}"
- "Aviso: {texto}": o arquivo de estado das rotinas estava corrompido e recomeçou. Nada rodou duas vezes, mas atrasos antigos não voltam.
- "Não deu para ler os agendamentos: só pelo Claudio’s Club": ver [Problemas comuns](#problemas-comuns).

Quando uma tarefa troca de motor (ver 06), o despertador e o "continue" da conversa antiga são cancelados. A hora do despertador vai para o resumo da conversa nova.

## Arquivos

Abra pelo botão **Arquivos** no painel do projeto ("Ver e editar os arquivos do projeto"). O título é "Arquivos de {projeto}".

Para o terminal, o painel do projeto tem o botão **Abrir terminal** (ícone de janela com `>_`, "Abrir um terminal na pasta do projeto"): abre um terminal do computador onde o Claudio’s Club roda, já dentro da pasta do projeto. Só funciona pela tela do Club e em computador com tela (Windows e Linux; no Mac, abra o terminal à mão). Sem tela, sem terminal instalado ou com a pasta apagada, aparece um aviso ao lado do botão.

- À esquerda, a árvore. Clique numa pasta para abrir; clique num arquivo para editar.
- À direita, o editor.
- **Salvar** (ou Ctrl+S) grava o arquivo. Nada é salvo sozinho.
- O estado aparece ao lado: **Salvando…**, **Salvo**, **Não salvo** ou **Erro ao salvar** (clique em **Tentar de novo**).
- Arquivo `.md` ou `.markdown` ganha o seletor **Código | Visualizar** abaixo do caminho. **Visualizar** mostra o texto atual (mesmo o que ainda não foi salvo) já formatado: títulos, listas, tabelas, código e links. Voltar para **Código** não perde nada. HTML escrito no arquivo aparece como texto, nunca é executado. Link `http`, `https` ou `mailto` abre em outra aba; link para outro arquivo do projeto (`outro.md`, `../x.md`) abre no próprio editor; imagem não carrega.
- Arquivo `.json` tem o mesmo seletor. **Visualizar** mostra uma árvore: clique numa chave para abrir ou fechar o objeto/lista; texto vem entre aspas (verde), número (roxo), `true`/`false` (azul-petróleo) e `null` (cinza, itálico). Tudo aparece como texto (HTML e URL dentro do arquivo não viram tag nem link). Se o JSON estiver inválido, a tela mostra o erro, com linha e coluna quando dá, e você volta a **Código** para corrigir. Arquivo pequeno abre inteiro; um grande abre só o primeiro nível e mostra os itens aos poucos (**Mostrar mais**), para não travar a aba. Número inteiro acima de 9 007 199 254 740 991 aparece arredondado (limite do navegador); o arquivo em si não muda.
- Os demais arquivos não têm o seletor.

### Criar

- **Arquivo** ou **Pasta** abre um campo para o nome. Enter cria, Esc cancela.
- Cria dentro da pasta selecionada, ou "na raiz do projeto".
- O nome não pode começar com `/` ou `\` e não pode ter `..`.

### Apagar

- Selecione o item e clique na lixeira ("Apagar {caminho}"). Há confirmação.
- É permanente: não vai para a lixeira. Numa pasta, apaga tudo o que está dentro.
- Não apaga: segredos (`.env` e parecidos), `.git`, `node_modules` e `.myco`, nem pasta que contenha algum deles.

### Limites e casos especiais

- Arquivo de segredo (`.env`, chaves) aparece com cadeado, e o Club nunca mostra o conteúdo: "Arquivo de segredo: o Club não mostra o conteúdo. Para abrir no editor de texto do seu computador, clique aqui."
- **clique aqui** abre o arquivo **fora do Club**, no editor de texto do computador onde o Claudio’s Club roda (Bloco de Notas no Windows, TextEdit no Mac, o editor gráfico de `VISUAL` ou `EDITOR` no Linux). O texto não passa pela tela do Club e não há como mostrá-lo nem ocultá-lo aqui; troque o valor e salve no seu editor. Só vale na tela do Claudio’s Club, num navegador pareado: funcionário (agente) pela API não abre segredo. O mesmo acontece com o botão **Corrigir** do aviso de segredo no chat (ver `03-chat.md`). `.git`, `node_modules` e as outras pastas escondidas continuam fechadas.
- Se o arquivo não abrir, a tela diz por quê, em linguagem simples: o Club não está neste computador (a página foi aberta de outra máquina: abra o arquivo no seu editor), roda sem tela, o computador não tem editor de texto com janela configurado (Linux: defina `VISUAL` ou `EDITOR` com um editor gráfico, como `gedit`, e reinicie o Club), o arquivo mudou enquanto abria, não existe mais ou o sistema não conseguiu abrir o editor.
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
| Arquivo não abre | Segredo nunca aparece no Club: **clique aqui** o abre no editor de texto do seu computador. Passou de 1 MB ou é binário: ver os limites acima. |
| "Erro ao salvar" | Clique em **Tentar de novo**. |
| Aparece o aviso de conflito | Escolha **Recarregar do disco** para ver a versão do disco, ou **Manter o meu e salvar por cima**. |
| "Não deu para cancelar" | Tente de novo. Se a linha sumir da lista, o agendamento já aconteceu ou foi cancelado. |
| "Não deu para ler os agendamentos: só pelo Claudio’s Club" | Este navegador não está pareado com o servidor. Clique em **Parear este navegador** (ver 01). |
