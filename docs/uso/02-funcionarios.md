# Funcionários

Fontes: `client/src/staff/HireForm.tsx`, `AgentForm.tsx`, `HrPanel.tsx`, `client/src/office/ProjectOffice.tsx`, `McpServers.tsx`, `SkillLibrary.tsx`, `client/src/detail/SkillManage.tsx`, `client/src/toolbar/RolesEditor.tsx`, `shared/roles.ts`, `server/staff/ficha.ts`.

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
| Web designer (sites e LP) | Opus | High | Edita sozinho |
| Engenharia de IA | Sonnet | High | Edita sozinho |
| QA (testes) | Sonnet | Medium | Edita sozinho |
| Revisor(a) de código | Sonnet | High | Autônomo |
| Segurança (AppSec) | Opus | Xhigh | Autônomo |
| DevOps / SRE | Sonnet | High | Edita sozinho |
| Documentação | Sonnet | Medium | Edita sozinho |

O Orquestrador(a) pode contratar subfuncionários e já vem com o roteiro **Planeja grande, executa pequeno**. Revisor(a) e Segurança entregam parecer, não corrigem. DevOps / SRE trabalha em servidores e já nasce com autonomia que permite escrever; a escrita só vale nas conexões com **Permitir comandos de escrita** marcado (ver **Servidores (SSH e FTP)** abaixo).

## A ficha

Abra o funcionário e, no painel dele, clique em **⋯** (**Mais opções**). As abas são **Ficha** (quem é) e **Projeto** (o que usa e como trabalha no projeto).

Na aba **Ficha**:

- **Nome\*** e **Cargo\***: nome e cargo na ficha. **Retrato**: foto pequena, mostrada no quadro.
- **Missão\***: o que ele faz. A primeira frase é o que o gestor vê dele. **Definição de pronto** e **Regras (uma por linha)**.
- **Modelo** e **Esforço**: começam do cargo. Se o motor recusar o modelo da ficha (ele deixou de existir), a conversa segue no modelo padrão, o cartão no quadro ganha o selo **Modelo obsoleto** e o painel e a ficha mostram o aviso; trocar o modelo e salvar tira a marca.
- **Roteiro**: **Nenhum (trabalha do jeito dele)**, **Planeja grande, executa pequeno**, **Reconhece, depois constrói** ou **Portão de revisão**.
- **Autonomia** (tabela abaixo).
- **Trabalhar numa worktree própria**: cópia git só dele, num branch próprio. O projeto precisa ser repositório git.
- **Pode contratar subfuncionários**: os contratados entram como temporários, com no máximo a autonomia dele.
- **Motor** e **Motor secundário** aparecem só com o Codex ligado. Ver `06-consumo-e-motores.md`.

Na aba **Projeto**:

- **Reporta a**: quem pode chamá-lo. Nenhum marcado = só você.
- **Conhecimento (um caminho por linha)**: arquivos que ele lê antes de começar. **Agents e skills indicados** aparecem se o projeto tiver algum.
- **MCPs**: marque os que ele usa e, em cada um, escolha o acesso: **Livre**, **Pede antes de escrever**, **Só leitura** ou **Desligado** (ver **MCPs** abaixo).
- **Servidores (SSH e FTP)**: clique em **+ dar acesso a servidores (SSH e FTP)** e marque as conexões que ele pode usar. A chave fica no seu computador; a ficha guarda só o nome da conexão. Em cada conexão SSH há **Permitir comandos de escrita** (ver **Servidores (SSH e FTP)** abaixo).
- **Usar o navegador (Claude in Chrome)**: usa o seu Chrome, com os seus logins. Envios, compras e formulários pedem o seu ok. Precisa da extensão instalada. Com ele marcado, **Acesso do navegador** limita o que ele faz (ver **MCPs** abaixo).

Salve com **Salvar ficha** (ou **Contratar**, ao criar). **Cancelar** fecha; no painel, o botão é **Desfazer**. Mudanças na ficha e nos MCPs valem a partir da próxima sessão.

**Autonomia**

| Opção | O que faz |
| --- | --- |
| Só planeja | Lê e propõe; não altera arquivos nem roda comandos. |
| Pede tudo | Pede aprovação antes de cada edição ou comando. No Codex, não pede: a sandbox fica só leitura. |
| Edita sozinho | Edita arquivos sem perguntar; no Claude, pede antes de rodar comandos. No Codex, roda comandos sem perguntar, dentro da sandbox. |
| Autônomo | O Claude Code decide o que é seguro rodar; o que julga arriscado (deploy em produção, apagar em massa) é recusado e ele pede a você. No Codex, não há classificador: roda na sandbox sem perguntar. |
| Sem travas | Não pede nada. Os bloqueios de segredos (.ssh, .env) e os hooks continuam. Só para quem você confia, em projeto com git. |

### Servidores (SSH e FTP)

Com conexões marcadas na ficha, o funcionário trabalha no servidor (por exemplo, uma VPS) sem ver a chave: quem roda o `ssh` é o Club. O cadastro das conexões fica em **Servidores**, no detalhe do projeto.

- **SSH vale nos dois motores (Claude e Codex)**, pelas ferramentas do MCP `myco-ssh`. No terminal do funcionário, `ssh`, `scp`, `sftp`, `rsync` e afins ficam bloqueados, com ou sem servidor na ficha.
- **Leitura, sempre**: status do servidor, processos, containers e logs do Docker, serviços e journal do systemd, listar pastas e ler arquivos. Pastas e arquivos só dentro de `/var/log` e da **Pasta do projeto no servidor** da conexão. `.env`, chaves e credenciais não são lidos. A saída troca segredos por `[segredo removido]` e é cortada em 64 KB.
- **Escrita, só com as duas condições juntas**: **Permitir comandos de escrita** marcado na conexão (aba **Projeto**) e uma autonomia que altera algo (**Edita sozinho**, **Autônomo** ou **Sem travas**). Com **Só planeja** ou **Pede tudo**, o servidor fica só leitura, mesmo com a caixa marcada. Escrever é rodar um comando livre (`ssh_executar`) ou enviar um arquivo do projeto para a pasta do servidor (`ssh_enviar`).
- **Aprovação**: no Claude, a escrita segue a autonomia (em **Edita sozinho** cada comando pede o seu ok; em **Sem travas** não pede). O Codex não pergunta a cada comando: nele, as travas são a caixa de escrita e a autonomia.
- **Envio de arquivo**: só arquivo do projeto, até 10 MB, para dentro da **Pasta do projeto no servidor** (sem ela, não envia). Não cria pastas e só troca um arquivo que já existe se o funcionário pedir. Não envia `.env`, chaves nem `.git`, e não escreve em `.ssh`, `.git` nem `authorized_keys`.
- **Limites**: 60 segundos por comando, um comando por vez em cada conexão, e pausa de 30 segundos depois de 3 falhas seguidas de conexão. Todo comando fica no registro `~/.myco/logs/ssh-comandos.jsonl`. O `ssh` precisa estar instalado no seu computador (no Windows, o recurso opcional **Cliente OpenSSH**).
- **No projeto do próprio Claudio’s Club** o acesso a servidor fica desligado nos dois motores.
- **FTP só no Claude**, pelas ferramentas `ftp_*`, presas à pasta da conexão (a senha fica no cofre do sistema). Com conexão FTP marcada, não dá para escolher o Codex.

O que não funciona:

- **Comando interativo**: o comando roda sem terminal. Editor (`vim`), `top`, `less` e perguntas de confirmação travam ou falham; use a versão sem tela (`top -b -n 1`, `-y`).
- **`sudo` com senha**: não há terminal nem como digitar a senha. Só `sudo` sem senha, liberado no servidor para o usuário e para os comandos certos.
- **Chave com senha (passphrase)**: o Club não pergunta a senha. Carregue a chave no `ssh-agent` (`ssh-add`) antes; sem isso a conexão falha. O botão **Testar** da conexão mostra "a chave tem senha: carregue-a no ssh-agent".

Cuidados:

- **Crie um usuário só para a IA na VPS**, sem root e com as permissões mínimas (só as pastas e os serviços que a tarefa precisa). O comando livre roda como esse usuário e o Club não limita o que ele pode: quem pode tudo no servidor, o funcionário também pode. Uma conexão que entra como `root` aparece com o aviso **entra como root: prefira um usuário só para a IA, sem root**.
- **Uma chave por projeto.** A chave é um arquivo seu, não do projeto: a mesma chave cadastrada em mais de um projeto dá o mesmo acesso nos dois (mesma conta, mesmas permissões), e trocar ou revogar essa chave afeta os dois.
- Para só diagnosticar, deixe **Permitir comandos de escrita** desmarcado.

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
- Ao arquivar funcionário ou projeto, as conversas paradas fecham seus processos; as que estão trabalhando continuam abertas e a tela avisa.
- **Excluir** apaga ficha, memória, foto e histórico de vez. Se houver tarefas abertas, o sistema avisa e elas ficam sem responsável.

## MCPs

- Em **Configurações** → **MCPs** (**Servidores MCP**), há quatro escopos: **Da conta (Club)** (recomendado: segredos no cofre do sistema, e só quem tem o MCP na ficha carrega), **Da conta (Claude Code)** (todas as sessões do Claude Code veem), **Do projeto** (vai para o git: não ponha chave ali) e **Locais do projeto** (só neste computador).
- Tipos: **HTTP**, **SSE** e **Comando local**. Valores de variáveis e cabeçalhos nunca voltam para a tela; aparece "definido".
- Botões: **+ MCP**, **Testar**, **Editar**, **Excluir**.
- Na ficha, cada MCP marcado tem um seletor de acesso, na linha do nome:
  - **Livre**: segue a autonomia da ficha (como sempre).
  - **Pede antes de escrever**: as ferramentas de leitura passam; as que escrevem pedem a sua aprovação, em qualquer autonomia. No Codex, que não pergunta, as que escrevem ficam bloqueadas.
  - **Só leitura**: as de leitura passam; as que escrevem ficam bloqueadas.
  - **Desligado**: o MCP não entra na conversa.
- Quem só lê é o que o próprio MCP declara no **Testar**. Sem teste, ou se o MCP mudou depois dele, nenhuma ferramenta conta como leitura: em **Só leitura** o MCP inteiro fica bloqueado e em **Pede antes de escrever** toda ferramenta pede antes. Com um desses dois escolhidos, a ficha mostra quantas ferramentas contam como escrita, ou avisa que o MCP não foi testado.
- No modo sem travas, e sempre no GPT, *Pede antes de escrever* vira *Só leitura*, porque não há quem confirme.
- O **navegador** tem um seletor só, **Acesso do navegador**, que aparece com **Usar o navegador** marcado. Vale para o Claude in Chrome e para o Chrome do GPT, que são o mesmo navegador (vale o mais restritivo dos dois). Ele não tem teste: **Só leitura** bloqueia o navegador inteiro e **Pede antes de escrever** pede a cada ação.
- No GPT a lista de MCPs não aparece na ficha; só o **Acesso do navegador** vale nos dois motores.
- Cada MCP ligado que roda no seu computador ocupa memória, mas o peso de cada um não foi medido (a ficha diz "peso não medido"). O que foi medido, e o que gasta o limite de uso, está em **O que pesa e quando vale ligar**, abaixo.

## O que pesa e quando vale ligar

A ficha avisa o que pesa mais com um **selo** e uma dica. São dois pesos diferentes:

- **Usa memória**: um programa a mais no seu computador. Só tem número onde foi medido (no Windows, por conversa aberta).
- **Gasta limite**: gasta o limite de uso da assinatura mais rápido. É só comparação: não há número, porque depende do pedido.

Os selos aparecem onde você decide: **Modelo** e **Esforço** (aba **Ficha**), **MCPs** e **Usar o navegador** (aba **Projeto**) e, no nível Simples, na própria tela de contratar. Toque no selo para abrir o porquê e quando vale ligar. Só ganham selo as opções com base no código; sem base, a ficha não marca.

| Recurso | Selo | O que pesa | Quando vale ligar |
|---|---|---|---|
| Cada conversa aberta do Claude | Usa memória | 200–290 MB por conversa aberta. O Club fecha sozinho a que fica 15 minutos parada. | Não é uma opção, é o custo de manter conversas abertas: feche as que não usa. |
| **Usar o navegador** (Claude) | Usa memória | Um aviso leve, cerca de 54 MB, fica aberto em toda conversa com a caixa marcada. Ao abrir uma página, o navegador sem os seus logins soma 80–120 MB e fecha sozinho depois de 10 minutos sem uso. O seu Chrome real (Claude in Chrome) não foi medido. | Para quem testa telas, confere sites ou lê páginas. Para quem só mexe em código, desmarque. |
| **Perguntar ao GPT** (**Usar o Codex (GPT)** nas Configurações) | Usa memória e Gasta limite | 20–45 MB em cada conversa do Claude. Cada pergunta abre outra chamada no Codex e gasta a cota do seu ChatGPT (não a do Claude). | Para quem decide coisas que pesam e ganha com uma segunda opinião. Desligar tira também o GPT como motor. |
| **Modelo** Opus ou Fable | Gasta limite | Custam mais por token que Sonnet e Haiku na tabela de preços do Club, e tendem a gastar o limite mais rápido. | Para planejar, decidir e revisar. Em trabalho mecânico, Sonnet ou Haiku gastam menos. |
| **Esforço** alto, xhigh ou max | Gasta limite | O modelo pensa mais antes de responder: demora mais e gasta o limite mais rápido. | Em tarefa difícil ou arriscada. No dia a dia, esforço baixo ou médio gasta menos. |

Sem selo (leve, ou sem medida: o que não foi medido fica sem número):

| Recurso | O que se sabe |
|---|---|
| **MCPs** marcados | Cada MCP que roda no seu computador sobe junto com a conversa, usado ou não. Peso não medido: desmarque os que o funcionário não usa. |
| **Servidores** SSH | Leve, cerca de 2 MB por conversa (só sobe com servidor SSH marcado). FTP: peso não medido. |
| Motor **Codex (GPT)** | Cada mensagem abre um processo que termina junto com a resposta; não fica programa parado. Peso não medido, e o navegador do GPT também não. |
| **Motor secundário** | Não sobe nada extra: só quando o principal bate o limite a tarefa segue em conversa nova no outro motor. |
| Skills, agents, regras, conhecimento, estilo de comunicação, memória pessoal e roteiro | São texto que entra no prompt da conversa. Sem medida de quanto pesa. |
| **Trabalhar numa worktree própria** | Uma cópia git no disco; pesa disco, não memória. |
| Autonomia e **Pode contratar subfuncionários** | Não sobem nada. |

## Skills e agents

- Skill da biblioteca: ative **Mostrar o escopo do usuário** em **Configurações** → **Quadro**. No projeto **~ você**, veja **Biblioteca de skills (restritas)**. **+ skill na biblioteca** cria uma (**Nome**, **Descrição (quando usar)**, **Instruções**). **Tirar da biblioteca** manda para a lixeira da biblioteca (dá para recuperar).
- Só quem tem a skill marcada na ficha carrega. Ela aparece como `myco:<nome>`.
- Skill da conta ou do projeto (a pasta `skills` do Claude Code): clique no cartão da skill no quadro (as da conta ficam no projeto **~ você**, com **Mostrar o escopo do usuário** ligado). O painel tem a seção **Editar ou excluir**:
  - **Editar** abre o `SKILL.md` inteiro, com o cabeçalho no topo. **Salvar** grava só esse arquivo; o nome da pasta não muda e a versão anterior fica em backup no servidor (`~/.myco/backups/skills`).
  - **Excluir** pede confirmação (**Mover para a lixeira** ou **Manter**). A pasta inteira vai para a lixeira do servidor (`~/.myco/backups/skills/.lixeira`) e pode ser recuperada de lá: o aviso do canto mostra o caminho exato e fica até você fechar no ×.
  - Se algum hook dos `settings.json` (da conta ou do projeto) chama a skill, nada é apagado e abre o alerta **Hooks vinculados a esta skill**, com cada hook (evento e arquivo). Ele avisa que, ao continuar, esses hooks deixam de rodar (podem ser proteções, como um bloqueio antes de um comando) e que o Claudio’s Club guarda uma cópia de cada `settings.json` em `~/.myco/backups/settings` antes de mexer. A pergunta é **Deseja continuar?**:
    - **Cancelar** (também Esc ou clicar fora): não apaga nada, nem a skill nem os hooks.
    - **Sim**: tira esses hooks dos `settings.json` e só depois manda a skill para a lixeira. O aviso do canto lista a pasta da lixeira, os hooks que saíram e os backups dos settings (para voltar um hook, copie o backup sobre o `settings.json` do mesmo nome).
    - Se os hooks mudaram entre o alerta e o **Sim** (alguém editou o settings), a mensagem do servidor aparece no alerta, a lista é refeita e você decide de novo; nada foi apagado.
  - Settings que não dá para ler, que não é um JSON válido ou com um hook da skill em formato que não dá para tirar sozinho: o servidor recusa, a mensagem diz o arquivo e o evento (corrija ou tire o hook à mão) e nada é apagado. O mesmo vale para o `SKILL.md` com chave de API escrita no texto, ao salvar.
  - Sem **Editar** nem **Excluir**: skill que é link (symlink ou junction; o painel mostra o destino, mexa na origem) e skill sincronizada da conta (só leitura). O painel diz o motivo.
- Skill de um link do GitHub (a mesma tela nos três lugares):
  - Onde fica o botão **Instalar do GitHub**: ao lado de **Skills (n)** no painel da conta (**~ você**, com **Mostrar o escopo do usuário** ligado), ao lado de **Skills (n)** na aba **Ferramentas** do projeto, e junto de **+ skill na biblioteca** na **Biblioteca de skills**. Conta e projeto não têm outro botão de skill nova: é por aqui que uma skill chega a eles.
  - **Instalar:** cole o link no campo **URL do GitHub** e clique **Ver prévia** (Enter também vale). Só repositório **público**. Vale o link do repositório, de uma pasta (`/tree/<branch>/<pasta>`) ou do `SKILL.md` (`/blob/...`). Se o link tiver várias skills, aparece **Este link tem N skills. Escolha uma:** (nome, pasta e descrição de cada); clicar numa abre a prévia dela, e **Voltar** volta à lista.
  - A **prévia** não grava nada e mostra, nesta ordem: a origem (repositório, branch e commit), os **Alertas**, o `SKILL.md` como texto, a lista completa de arquivos (com a etiqueta **script** ou **binário**) e o **Nome da pasta** em que a skill vai ficar (começa com o nome da pasta do repositório; mude se quiser). Os alertas ficam no alto, do mais grave ao menos (**Perigo**, **Atenção**, **Aviso**, escritos além da cor): script ou programa na pasta (vários viram uma linha só, com a lista), arquivo binário, `hooks`, `allowed-tools`, `shell` ou `model` no cabeçalho e comando `` !`...` `` no texto, que roda ao chamar a skill. Sem alerta, a tela diz que isso só pega o que o Club sabe reconhecer: leia o `SKILL.md` mesmo assim.
  - **Instalar** é um botão separado de **Voltar** e **Cancelar**, sempre à vista no pé da janela. Com um alerta de **Perigo** (`hooks` ou comando que roda ao chamar a skill), ele só libera depois de marcar **Li os alertas de perigo e quero instalar mesmo assim**. Instala exatamente o commit mostrado na prévia; se o GitHub mudou no meio, a tela diz que o repositório mudou e oferece **Ver prévia de novo** (nada é gravado). Se já existe uma skill com esse nome, o Club recusa e não sobrescreve: troque o **Nome da pasta**.
  - **Instalar não ativa a skill.** A tela repete isso na prévia e no fim: só grava a pasta. Depois, marque a skill na ficha de quem deve usar (na biblioteca, como `myco:<nome>`).
  - Recusado, sem gravar nada (a tela mostra o motivo): caminho com `..` ou caractere proibido, nome reservado do Windows, dois arquivos que viram o mesmo no Windows (só caixa diferente), link simbólico, submódulo, mais de 300 arquivos, arquivo acima de 1 MB (`SKILL.md` acima de 128 KB), mais de 5 MB no total, redirecionamento para fora do GitHub, arquivo que não bate com o que o GitHub registrou e chave de API escrita em qualquer arquivo. Nenhum script é executado na instalação.
  - Destino: a biblioteca do Club, a conta (`~/.claude/skills`) ou o projeto (`.claude/skills`). Junto da skill fica o arquivo `.myco-origin.json`, com o link, a pasta, a branch acompanhada, o commit, a data e o hash de cada arquivo.
  - **Depois de instalada**, o cartão da skill (e a linha dela na biblioteca) leva o selo **GitHub**. No painel da skill (na biblioteca, dentro da janela da skill), a seção **Origem no GitHub** mostra o link do repositório, o commit (curto), a branch que ela acompanha e a data. O selo **há versão nova** aparece quando a checagem diária achou novidade; **modificada aqui** aparece quando você editou a skill depois de instalar.
  - **Atualizar não é automático.** Uma vez por dia o Club consulta o GitHub (uma consulta por repositório) só para marcar que há versão nova; nada é baixado nem trocado. A novidade só conta se a pasta da skill mudou (commit em outra parte do repositório não conta).
  - **Verificar atualização** (sob demanda, em qualquer skill instalada por link) baixa a versão nova e mostra: de onde vem, quantos arquivos entram, saem e mudam, as chaves do cabeçalho que mudam (antes → depois), os alertas da versão nova e o **diff de todos os arquivos** (linhas que entram e saem; arquivo binário só com o tamanho; mudança enorme sem linhas). Se estiver em dia, diz isso; se só outra parte do repositório mudou, diz que a pasta da skill não mudou.
  - **Aplicar atualização** pede confirmação (**Aplicar** ou **Cancelar**) e grava exatamente a versão mostrada; se a versão nova tem alerta de **Perigo**, também exige a caixa de ciência. A versão anterior vai para `~/.myco/backups/skills-github`. Se você editou a skill depois de instalar, aparece um aviso vermelho já no alto da seção e a confirmação vira **Sobrescrever e aplicar**: suas mudanças saem da pasta (fica uma cópia da versão atual em backup, mas **Voltar** não restaura mudanças locais). Se a skill for mexida entre a verificação e o clique, a confirmação de sobrescrever aparece na hora.
  - **Voltar à versão anterior** (também com confirmação) só funciona depois de uma atualização aplicada; antes disso o Club responde que não há versão anterior. A versão de que você saiu também fica guardada, então dá para voltar de novo.
  - Depois de aplicar ou voltar, o painel relê a skill: **Editar** abre o texto novo.
  - Sem login no GitHub o limite é de 60 consultas por hora; ao bater nele, a tela diz a hora em que libera.
- Skill apagada ou renomeada que uma ficha tinha marcada continua na lista **Agents e skills indicados**, marcada e com o selo **não existe mais**: desmarque e salve para tirá-la da ficha.
- **Agents** (subagents do Claude Code): crie com **Novo agent** no painel do projeto. Há três prontos: **Executor (Haiku)**, **Pesquisador (Haiku, só leitura)** e **Revisor (Sonnet)**.
- Skills e agents não existem no Codex: o GPT não recebe as skills da biblioteca marcadas na ficha (o Codex não tem como carregar uma skill só numa conversa).

Conversas e permissões: `03-chat.md`. Consumo e motores: `06-consumo-e-motores.md`. Se a dúvida não estiver aqui, diga que não sabe.
