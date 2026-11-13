# Funcionários

Fontes: `client/src/staff/HireForm.tsx`, `AgentForm.tsx`, `HrPanel.tsx`, `client/src/office/ProjectOffice.tsx`, `McpServers.tsx`, `SkillLibrary.tsx`, `client/src/toolbar/RolesEditor.tsx`, `shared/roles.ts`, `server/staff/ficha.ts`.

## Contratar

### Pelo quadro

- Clique no **+** de um projeto: o novo funcionário reporta a você. Clique no **+** de um funcionário: o novo reporta a ele.
- Arraste o **+** e solte no vazio: abre as mesmas opções do clique.
- Arraste o **+** de um funcionário sobre um colega do mesmo projeto: liga os dois (o gestor passa a chamar o colega).
- Solte sobre um funcionário de outro projeto: copia a ficha dele para este projeto (pede confirmação).
- No celular, o toque faz o mesmo.

### Do zero ou da empresa

- No formulário, escolha **Do zero** (ficha nova) ou **Da empresa** (copia a ficha de outro projeto).
- Em **Da empresa**, busque por nome, cargo ou projeto e clique em **Copiar para este projeto**. A cópia entra como funcionário novo; a ficha original não muda.
- Marque **Levar a memória também** se quiser levar a memória. Ela pode ter detalhes do outro projeto.

### No nível simples

- Escolha o cargo nos botões. Já vem marcado o cargo padrão, se houver; senão, o Orquestrador(a).
- Preencha **Nome\*** e, se quiser, **Retrato**. Clique em **Contratar**.
- Ele nasce sem MCPs. Para os outros campos, clique em **Mostrar todos os campos**.
- A conversa abre vazia. A primeira tarefa você manda pelo chat (ver `03-chat.md`).

## Cargos prontos

Um cargo é um modelo de ficha: preenche o formulário, e cada campo continua editável naquele funcionário. Para mudar o modelo de um cargo, vá em **Configurações** → **Cargos** (**Cargos para contratar**): **editar**, **padrão** (o que já vem marcado ao contratar), **tirar** ou **voltar ao original**, e **Novo cargo**. Salve com **Salvar cargo**. A mudança vale para os próximos contratados.

| Cargo | Modelo | Esforço | Autonomia |
| --- | --- | --- | --- |
| Orquestrador(a) | Opus | High | Edita sozinho |
| Produto (PO) | Sonnet | High | Edita sozinho |
| Arquiteto(a) | Opus | High | Só planeja |
| Back-end | Sonnet | Medium | Edita sozinho |
| Dados (DBA) | Sonnet | High | Edita sozinho |
| Front-end | Sonnet | Medium | Edita sozinho |
| Design system | Sonnet | Medium | Edita sozinho |
| Engenharia de IA | Sonnet | High | Edita sozinho |
| QA (testes) | Sonnet | Medium | Edita sozinho |
| Revisor(a) de código | Sonnet | High | Autônomo |
| Segurança (AppSec) | Sonnet | High | Autônomo |
| DevOps / SRE | Sonnet | High | Pede tudo |
| Documentação | Sonnet | Medium | Edita sozinho |

O Orquestrador(a) pode contratar subfuncionários e já vem com o roteiro **Planeja grande, executa pequeno**. Revisor(a) e Segurança entregam parecer, não corrigem. DevOps / SRE trabalha em servidores (ver **Servidores (SSH e FTP)** abaixo).

## A ficha

Abra o funcionário e, no painel dele, clique em **⋯** (**Mais opções**). As abas são **Ficha** (quem é) e **Projeto** (o que usa e como trabalha no projeto).

Na aba **Ficha**:

- **Nome\*** e **Cargo\***: nome e cargo na ficha. **Retrato**: foto pequena, mostrada no quadro.
- **Missão\***: o que ele faz. A primeira frase é o que o gestor vê dele. **Definição de pronto** e **Regras (uma por linha)**.
- **Modelo** e **Esforço**: começam do cargo.
- **Roteiro**: **Nenhum (trabalha do jeito dele)**, **Planeja grande, executa pequeno**, **Reconhece, depois constrói** ou **Portão de revisão**.
- **Autonomia** (tabela abaixo).
- **Trabalhar numa worktree própria**: cópia git só dele, num branch próprio. O projeto precisa ser repositório git.
- **Pode contratar subfuncionários**: os contratados entram como temporários, com no máximo a autonomia dele.
- **Motor** e **Motor secundário** aparecem só com o Codex ligado. Ver `06-consumo-e-motores.md`.

Na aba **Projeto**:

- **Reporta a**: quem pode chamá-lo. Nenhum marcado = só você.
- **Conhecimento (um caminho por linha)**: arquivos que ele lê antes de começar. **Agents e skills indicados** aparecem se o projeto tiver algum.
- **MCPs**: marque os que ele usa e, em cada um, escolha o acesso: **Livre**, **Pede antes de escrever**, **Só leitura** ou **Desligado** (ver **MCPs** abaixo).
- **Servidores (SSH e FTP)**: clique em **+ dar acesso a servidores (SSH e FTP)** e marque as conexões que ele pode usar. A chave fica no seu computador; a ficha guarda só o nome da conexão.
- **Usar o navegador (Claude in Chrome)**: usa o seu Chrome, com os seus logins. Envios, compras e formulários pedem o seu ok. Precisa da extensão instalada. Com ele marcado, **Acesso do navegador** limita o que ele faz (ver **MCPs** abaixo).

Salve com **Salvar ficha** (ou **Contratar**, ao criar). **Cancelar** fecha; no painel, o botão é **Desfazer**. Mudanças na ficha e nos MCPs valem a partir da próxima sessão.

**Autonomia**

| Opção | O que faz |
| --- | --- |
| Só planeja | Lê e propõe; não altera arquivos nem roda comandos. |
| Pede tudo | Pede aprovação antes de cada edição ou comando. |
| Edita sozinho | Edita arquivos sem perguntar; pede antes de rodar comandos. |
| Autônomo | O Claude Code decide o que é seguro rodar; o que julga arriscado (deploy em produção, apagar em massa) é recusado e ele pede a você. |
| Sem travas | Não pede nada. Os bloqueios de segredos (.ssh, .env) e os hooks continuam. Só para quem você confia, em projeto com git. |

## Memória

- Cada funcionário tem uma memória própria, que atravessa as conversas: decisões e o porquê, convenções, pendências e onde parou. Ele lê no início de cada conversa e atualiza ao fechar um assunto. Ela é curta (cerca de 60 linhas).
- **Memória pessoal**: na ficha de quem já existe, a seção **Memória pessoal** tem o botão **Editar a memória pessoal**. Ela vale em todos os projetos da pessoa, só para o que serve de um projeto para o outro. Tem limite de linhas e de bytes; se passar, resuma antes de **Salvar memória**.
- O funcionário lê a memória pessoal, mas não a altera. Se ela estiver errada, edite-a na ficha ou peça ao funcionário que aponte o erro.

## Gestor e equipe

- **Reporta a** define quem chama quem. Só quem tem **Pode contratar subfuncionários** contrata.
- Um subordinado nunca tem mais autonomia que o gestor.
- Um gestor repassa o que é da área de cada subordinado como tarefa (aparece no quadro de tarefas). O que não tem dono ele faz ou passa aos agents.
- Temporários saem do quadro quando terminam. Nada é apagado.

## Organograma (quadro)

- Cada projeto é uma sala; os funcionários ficam dentro dela. As linhas entre eles mostram **empresta** e **delegando**.
- Para desfazer um vínculo, clique em **Desfazer vínculo** na linha entre os dois. A ficha anterior fica no histórico.
- **Reorganizar o quadro** (botão do canto do quadro) desfaz os arrastos e refaz a grade de salas mantendo a ordem de agora (de cima para baixo, da esquerda para a direita) dentro de cada workspace.
- Quem tem mais de um gestor fica uma linha abaixo do mais fundo deles e recebe a mesma linha de cada um.
- Legenda: **projeto**, **funcionário / agent**, **skill**.

## RH

- Botão **RH e ranking** na barra do topo (título **Funcionários**), aba **RH**: uma linha por pessoa, com um chip por projeto em que ela tem ficha. As abas **Gastos** e **Economia** do mesmo painel são o ranking (veja o capítulo 6).
- Clique na linha ou num chip para editar. Filtre pela busca ou por **Projeto**.
- Se houver ficha de mesmo nome em outro projeto, aparece **Unificar** ("É a mesma pessoa?"). Ele pede confirmação com **Juntar**.
- Em **⋯** (ações da pessoa): **Ligar a outra ficha**, **Arquivar** ou **Desarquivar** por projeto, **Separar deste projeto** (se estiver em mais de um) e **Excluir**.
- **Excluir** apaga ficha, memória, foto e histórico de vez. Se houver tarefas abertas, o sistema avisa e elas ficam sem responsável.

## MCPs

- Em **Configurações** → **MCPs** (**Servidores MCP**), há quatro escopos: **Da conta (Club)** (recomendado: segredos no cofre do sistema, e só quem tem o MCP na ficha carrega), **Da conta (Claude Code)** (todas as sessões do Claude Code veem), **Do projeto** (vai para o git: não ponha chave ali) e **Locais do projeto** (só neste computador).
- Tipos: **HTTP**, **SSE** e **Comando local**. Valores de variáveis e cabeçalhos nunca voltam para a tela; aparece "definido".
- Botões: **+ MCP**, **Testar**, **Editar**, **Excluir**.
- Na ficha, cada MCP marcado tem um seletor de acesso, na linha do nome:
  - **Livre**: segue a autonomia da ficha (como sempre).
  - **Pede antes de escrever**: as ferramentas de leitura passam; as que escrevem pedem a sua aprovação, em qualquer autonomia.
  - **Só leitura**: as de leitura passam; as que escrevem ficam bloqueadas.
  - **Desligado**: o MCP não entra na conversa.
- Quem só lê é o que o próprio MCP declara no **Testar**. Sem teste, ou se o MCP mudou depois dele, nenhuma ferramenta conta como leitura: em **Só leitura** o MCP inteiro fica bloqueado e em **Pede antes de escrever** toda ferramenta pede antes. Com um desses dois escolhidos, a ficha mostra quantas ferramentas contam como escrita, ou avisa que o MCP não foi testado.
- No modo sem travas, e sempre no GPT, *Pede antes de escrever* vira *Só leitura*, porque não há quem confirme.
- O **navegador** tem um seletor só, **Acesso do navegador**, que aparece com **Usar o navegador** marcado. Vale para o Claude in Chrome e para o Chrome do GPT, que são o mesmo navegador (vale o mais restritivo dos dois). Ele não tem teste: **Só leitura** bloqueia o navegador inteiro e **Pede antes de escrever** pede a cada ação.
- No GPT a lista de MCPs não aparece na ficha; só o **Acesso do navegador** vale nos dois motores.

## Skills e agents

- Skill da biblioteca: ative **Mostrar o escopo do usuário** em **Configurações** → **Quadro**. No projeto **~ você**, veja **Biblioteca de skills (restritas)**. **+ skill na biblioteca** cria uma (**Nome**, **Descrição (quando usar)**, **Instruções**). **Tirar da biblioteca** manda para a lixeira da biblioteca (dá para recuperar).
- Só quem tem a skill marcada na ficha carrega. Ela aparece como `myco:<nome>`.
- **Agents** (subagents do Claude Code): crie com **Novo agent** no painel do projeto. Há três prontos: **Executor (Haiku)**, **Pesquisador (Haiku, só leitura)** e **Revisor (Sonnet)**.
- Skills e agents não existem no Codex.

Conversas e permissões: `03-chat.md`. Consumo e motores: `06-consumo-e-motores.md`. Se a dúvida não estiver aqui, diga que não sabe.
