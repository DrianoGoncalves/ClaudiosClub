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
| O botão **Iniciar** não faz nada, ou o Windows oferece a Microsoft Store | `npm run daily:start` uma vez |
| Ações dizem que o navegador não está pareado | Clique em **Parear este navegador** e rode o `npm run pair CÓDIGO` que aparece. Use sempre o mesmo endereço (`claudio.localhost`) |

Se o problema não estiver aqui, diga isso ao usuário e aponte `npm run doctor`.
