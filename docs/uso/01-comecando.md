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

**Configurações** → **Geral** → **Nível de uso**:

- **Simples**: contratar só com nome e cargo (o resto vem do cargo); o essencial na tela.
- **Avançado**: todos os campos da ficha, do painel e das configurações.

Dá para trocar a qualquer hora; nada se perde.

## Ver o projeto demo (opcional)

Para ver uma equipe pronta:

1. **Configurações** → **Geral** → **Projeto demo**.
2. Clique em **Criar projeto demo**. Ele cria uma vez e abre a sala.

Ver o quadro e as fichas não gasta nada; abrir um funcionário usa a sua cota.

## Primeiro projeto

1. No canto de baixo do quadro, clique em **+ projeto** (ele cria ou abre um projeto já na aba em que você está).
2. Escolha:
   - **Criar pasta nova**: preencha **Nome da pasta** e **Onde criar**; ou
   - **Pasta que já existe**: preencha **Caminho da pasta**.
3. Marque **Iniciar um repositório git (o painel de código e a revisão usam o diff)** se quiser.
4. Clique em **Criar projeto** (pasta nova) ou **Abrir projeto** (pasta existente).

A pasta entra no quadro na hora. O Claude Code passa a conhecê-la na primeira conversa.

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
