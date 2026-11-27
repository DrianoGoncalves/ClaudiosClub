# Começando

Fontes: `README.md` (seção "Começando" e "Não abre ou a tela fica em branco"), `client/src/board/Board.tsx`, `client/src/office/WorkspacesSettings.tsx`.

## Requisitos

- Node 22 ou mais novo, e Git.
- Windows 10/11 ou Linux.

## Instalar e abrir

1. No terminal, clone o projeto: `git clone https://github.com/DrianoGoncalves/ClaudiosClub.git`
2. Entre na pasta: `cd ClaudiosClub`
3. Rode: `npm run setup`

O `npm run setup` roda uma vez só. Ele instala as dependências, o Claude Code e o login se faltarem, oferece as barras de consumo e abre o navegador já pareado no endereço local do Claudio's Club.

Depois disso, use tudo pelo navegador.

**Para ligar de novo** (computador reiniciado, por exemplo):

- Use o botão **Iniciar** na página de início, que aparece no mesmo endereço quando o Claudio's Club está parado. O botão chama o link `myco://`. Na primeira vez, o navegador pergunta se pode abrir: marque "sempre permitir".
- Ou rode `npm run daily:start` no terminal. Se o botão **Iniciar** não fizer nada, rode esse comando uma vez: ele registra o link e sobe o Claudio's Club.

**Por que parou.** Se o Claudio's Club foi encerrado sem você pedir (por exemplo, o sistema o fechou por falta de memória), ele não consegue avisar na hora: quem descobre é a subida seguinte. Ao clicar em **Iniciar** na página de início, quando o Club volta, a página **não entra direto nele**: ela fica com o quadro **Por que parou**, com a hora e o motivo (ou "provavelmente falta de memória", quando o sistema não deixou registro), e o botão **Abrir o Claudio's Club**. O motivo também fica no log. Feche programas pesados antes de seguir. A conversa que estava no meio de um turno foi interrompida: abra-a e peça para continuar. O quadro aparece uma vez por saída (depois de **Abrir** ele não volta neste navegador) e por até 30 minutos. Parar o Claudio's Club de propósito (**Parar**, ou `npm run daily:stop`) apaga o aviso: quem parou foi você. Reiniciar pelo botão não gera o quadro; computador desligado ou reiniciado só aparece no log.

**Pouca memória no Linux.** Com o systemd do usuário, o Claudio's Club se divide em grupos separados do sistema: o vigia (que sobe o servidor de novo), o servidor e cada conversa. Quando a memória acaba, o sistema passa a encerrar só a conversa mais pesada, e o vigia e o servidor continuam no ar. Como o Club deixou de ser um bloco só, o sistema também pode escolher outro programa seu (por exemplo, o navegador) em vez dele. Isso é esperado e não bloqueia nada. A conversa encerrada fica no disco: abra-a e peça para continuar. Ao parar o Claudio's Club (botão **Parar**, **Reiniciar** ou `npm run daily:stop`), as conversas que sobrarem sem servidor são encerradas. No Windows e no macOS nada muda. **Só vale para um vigia novo:** o botão **Reiniciar** não recarrega o vigia. Depois de atualizar o Claudio's Club, use **Parar** e **Iniciar** uma vez (ou reinicie o computador); a divisão em grupos passa a valer a partir daí.

**Opcional, no Windows: disco mais rápido.** A página de início tem a seção **Opcional: disco mais rápido**, recolhida. O antivírus do Windows (Defender) verifica cada arquivo que o Claudio's Club, o git e os testes abrem, e num HD isso pesa no disco. A seção mostra dois comandos, cada um com o botão **Copiar** e o comando que desfaz:

- **Recomendado (risco baixo):** tira da verificação os transcripts das conversas e o histórico do git do Claudio's Club.
- **Opcional (mais ganho, mais risco):** tira o `node_modules`. Ele é código de terceiros baixado do npm, então um pacote malicioso deixaria de ser verificado.

Quem roda é você, no PowerShell aberto como administrador (só no Windows; no Linux não há esse passo). A página nunca roda nada. As pastas que já estão fora da verificação aparecem marcadas.

**Dependências usadas.** A página de início também tem a seção **Dependências usadas**, recolhida. Ela lista os pacotes do npm que o Claudio's Club usa, em dois grupos: **Do app** e **Para montar e testar**. Cada pacote mostra a versão instalada, a licença, uma descrição curta e o link para a página dele no npm. A lista vem do `package.json` e atualiza a cada subida ou com `npm run doctor`. Pacote que falta instalar aparece em vermelho, com a versão pedida.

## Parear o navegador

As ações (mandar mensagem, botões) só funcionam em navegador pareado. Num navegador novo:

1. Clique em **Parear este navegador** (no aviso que aparece, ou em **Configurações** → **Geral** → **Pareamento deste navegador**).
2. A tela mostra um comando com um código. Rode `npm run pair CÓDIGO` num terminal seu, na pasta do Claudio's Club, e confirme.
3. A aba se pareia sozinha. O código vale 10 min. O pareamento dura 1 ano.

Os funcionários não conseguem aprovar o pareamento: quem aprova é o terminal do usuário.

## Escolher o nível de uso

**Configurações** → **Nível de uso** (no Avançado: **Configurações** → **Geral** → **Nível de uso**):

- **Simples**: contratar só com nome e cargo (o resto vem do cargo); o essencial na tela, com as configurações em cartões por tema e em linguagem comum.
- **Avançado**: todos os campos da ficha, do painel e das configurações.

Dá para trocar a qualquer hora; nada se perde.

## Começar com uma equipe pronta (opcional)

Um modelo de equipe cria de uma vez as fichas de uma equipe, com a hierarquia (todos respondem ao orquestrador). Há dois:

| Modelo | Quem entra |
|---|---|
| **Site / landing page** | Marina (Orquestrador(a)), Caio (Web designer), Bia (Desenvolvedor(a) front-end), Rafael (Especialista em tráfego) |
| **Manutenção de SaaS** | Helena (Orquestrador(a)), Tiago (Desenvolvedor(a) back-end), Laura (Desenvolvedor(a) front-end), Otávio (Analista de QA), Renata (Analista de segurança), Davi (DevOps / SRE) |

Onde escolher:

- **No Novo projeto**: o campo **Equipe pronta (opcional)** vem em **Sem equipe**. Escolha um modelo para o projeto já abrir com a equipe.
- **Num projeto sem nenhum funcionário**: na aba **Equipe** do projeto aparece **Comece com uma equipe pronta**. Escolha o modelo e clique em **Criar equipe**.

Antes de aplicar, a tela lista quem entra (nome e cargo). Só as fichas são criadas: **nenhuma tarefa nem conversa começa sozinha**, e você pode editar ou apagar cada ficha depois. Projeto que já tem funcionário não mostra a opção, e o Club recusa (409) aplicar um modelo nele. Criar a equipe não gasta cota; só conversar com alguém gasta.

## Primeiro projeto

1. No canto de baixo do quadro, clique em **+ projeto** (ele cria ou abre um projeto já na aba em que você está).
2. Escolha:
   - **Criar pasta nova**: preencha **Nome da pasta** e **Onde criar**; ou
   - **Pasta que já existe**: clique em **Procurar…** e escolha a pasta na janela que abre, ou digite o caminho em **Caminho da pasta**.
3. Marque **Iniciar um repositório git (o painel de código e a revisão usam o diff)** se quiser.
4. Se quiser, escolha uma **Equipe pronta** (ver acima); o padrão é **Sem equipe**.
5. Clique em **Criar projeto** (pasta nova) ou **Abrir projeto** (pasta existente).

A pasta entra no quadro na hora. O Claude Code passa a conhecê-la na primeira conversa.

Sobre o **Procurar…**:

- A janela abre no computador onde o Claudio's Club roda (o seu, se você o usa localmente). Se ela não aparecer, procure atrás do navegador. Enquanto ela está aberta, o botão mostra **Janela aberta…**.
- Escolher uma pasta preenche **Caminho da pasta**, e você ainda pode editar o texto. Fechar a janela sem escolher não muda o campo.
- Se o computador não consegue abrir a janela, o botão fica desligado e um aviso pede para digitar o caminho no campo. O mesmo vale se já houver uma janela de escolher pasta aberta: escolha nela ou feche-a.
- Com a tela aberta por um endereço que não é `localhost`, o botão não aparece (a janela abriria no computador do servidor, não no seu): digite o caminho.
- O botão está só em **Pasta que já existe**. Em **Criar pasta nova**, **Onde criar** continua sendo digitado.

Para trazer um projeto que você já usou com o Claude Code: **+ projeto** → **Importar do Claude Code**. Marque os que quer trazer e clique em **Importar (n)**. Nada muda nas pastas deles.

Depois do projeto, contrate o primeiro funcionário (ver `02-funcionarios.md`).

## Workspaces

Workspace é um grupo de projetos (por cliente, área, pessoal etc.). Cada workspace vira uma aba no quadro, com cor e fundo próprios.

- **Criar**: **Configurações** → **Quadro** → **Workspaces** → digite em **Nome do workspace** → **Adicionar**.
- Renomear: edite o nome no cartão do workspace. Ele salva quando você sai do campo ou aperta Enter.
- **Fundo**: **Fundo do quadro nesta aba**, no cartão do workspace (uma cor para cada tema).
- Para colocar um projeto num workspace: abra o projeto e, no campo **Workspace**, escolha o nome. Para tirar, escolha **Sem workspace**.
- **Remover**: o botão **Remover** no cartão. Os projetos dele ficam **Sem workspace**; nada é apagado.

As abas do topo são **Todos** (todos os projetos), **Sem workspace** e uma aba por workspace. Numa aba vazia, o quadro mostra: "Nenhum projeto nesta aba. Ponha um pelo detalhe do projeto ou crie um novo."

## Não abre ou a tela fica em branco

Rode `npm run doctor`: ele aponta o passo com problema e o comando de correção. Os casos mais comuns:

| Sintoma | O que fazer |
| --- | --- |
| Tela em branco, sem erro no console | `npm run build` |
| Build falha com `Failed to resolve entry for package` | `npm ci`, depois `npm run build` (o `npm install` não conserta) |
| O botão **Iniciar** não faz nada, ou o Windows oferece a Microsoft Store | `npm run daily:start` uma vez. No Linux, o link é um `.desktop` registrado com `xdg-mime`; se ainda não abrir, saia e entre de novo na sessão (ou rode `update-desktop-database ~/.local/share/applications`) |
| Aparece a faixa vermelha **O Claudio’s Club parou** (ele ficou mais de 1 minuto fora do ar, sem voltar sozinho, por exemplo porque o sistema o encerrou por falta de memória) | Clique em **Ir para a página de início** e, nela, em **Iniciar**. Se voltar sozinho antes de 1 minuto, a tela só mostra "reiniciando" e nada precisa ser feito |
| Ao clicar em **Iniciar**, a página mostrou o quadro **Por que parou** em vez de entrar no app | É o motivo da última saída sem aviso (falta de memória, por exemplo). Clique em **Abrir o Claudio's Club**. Se for uma conversa que ficou pela metade, abra-a e peça para continuar |
| Ações dizem que o navegador não está pareado | Clique em **Parear este navegador** e rode o `npm run pair CÓDIGO` que aparece. Use sempre o mesmo endereço (`claudio.localhost`) |

Se o problema não estiver aqui, diga isso ao usuário e aponte `npm run doctor`.
