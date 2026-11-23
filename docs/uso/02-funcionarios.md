# Funcionários

Fontes: `client/src/staff/HireForm.tsx`, `AgentForm.tsx`, `agentRoles.ts`, `PlaybookRoster.tsx`, `HrPanel.tsx`, `client/src/office/ProjectOffice.tsx`, `McpServers.tsx`, `SkillLibrary.tsx`, `client/src/detail/SkillManage.tsx`, `client/src/toolbar/RolesEditor.tsx`, `shared/roles.ts`, `server/staff/ficha.ts`.

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
| Tráfego (SEO e mídia paga) | Sonnet | High | Edita sozinho |
| Engenharia de IA | Sonnet | High | Edita sozinho |
| QA (testes) | Sonnet | Medium | Edita sozinho |
| Revisor(a) de código | Sonnet | High | Autônomo |
| Segurança (AppSec) | Opus | Xhigh | Autônomo |
| DevOps / SRE | Sonnet | High | Edita sozinho |
| Documentação | Sonnet | Medium | Edita sozinho |

O Orquestrador(a) pode contratar subfuncionários. Ao dividir o trabalho, ele segue a ordem que você pedir; sem ela, só passa na frente o bug que perde dados, abre falha de segurança ou trava um fluxo essencial (bug cosmético e melhoria viram pendência para você decidir), e só liga uma tarefa a outra quando ela realmente precisa da outra pronta. Ele e os cargos que editam código (Back-end, Dados (DBA), Front-end, Design system, Web designer, Tráfego (SEO e mídia paga), Engenharia de IA, QA, DevOps / SRE e Documentação) já vêm com o roteiro **Planeja grande, executa pequeno** (ver **Pensador × executor** abaixo). Produto (PO) e Arquiteto(a) decidem e planejam, sem roteiro. O Tráfego cuida de SEO (palavras-chave, auditoria técnica, conteúdo, Search Console) e de mídia paga (Google Ads, Meta Ads) com medição de conversão. A ficha manda não criar, ativar nem pausar campanha, não mudar orçamento, lance nem público e não publicar anúncio sem o seu ok com valor e período, mas isso é instrução escrita, não uma trava: nada no sistema impede o funcionário de agir se ele descumprir. Se ele usa um MCP de anúncios (Google Ads, Meta Ads), marque o acesso desse MCP como **Pede antes de escrever** (ou **Só leitura**): aí quem segura é o sistema (ver **MCPs** abaixo). O navegador nasce ligado e usa o seu Chrome com os seus logins, que chega ao Google Ads e ao Meta Ads sem passar pelo MCP e, nele, só a instrução da ficha segura. Se ele usa o navegador para anúncio, ponha também o **Acesso do navegador** em **Pede antes de escrever** (ou **Só leitura**, que bloqueia o navegador inteiro). Construir as páginas é do Web designer. Revisor(a) e Segurança entregam parecer, não corrigem. DevOps / SRE trabalha em servidores e já nasce com autonomia que permite escrever; a escrita só vale nas conexões com **Permitir comandos de escrita** marcado (ver **Servidores (SSH e FTP)** abaixo).

### Pensador × executor

Quem tem o roteiro **Planeja grande, executa pequeno** é o **pensador**: planeja, decide o que muda e em quais arquivos, e confere o resultado, no modelo dele. O trabalho braçal vai para **agents** mais baratos, os **executores**.

| Agent | Modelo e esforço | Papel |
| --- | --- | --- |
| **Executor** | Sonnet, Medium | Implementa o que o funcionário já decidiu: edita os arquivos combinados, escreve código e testes, roda a verificação e devolve o que mudou. |
| **Executor rápido** | Haiku, Low | Tarefa mecânica, sem julgamento: busca e troca em vários arquivos, rodar um comando e relatar o resultado. Se a tarefa pede decisão, devolve para o executor. |
| **Pesquisador** | Haiku, Low, só leitura | Acha no código onde algo está e responde com arquivo:linha. |
| **Revisor** | Sonnet, High, só leitura | Confere a mudança antes de ela ser aceita: bugs, regressões e desvios do pedido. |

- **Quando o funcionário faz sozinho**: mudança local, conhecida e de baixo risco (ele já leu o arquivo, sabe o que mudar e um erro apareceria no diff), porque explicar custaria mais. O critério é o risco, não o número de linhas: o que toca segurança, dados, pagamento ou vários arquivos vai para o executor, mesmo curto.
- **Quem confere**: o funcionário olha o diff de cada entrega antes de pedir a próxima. O resumo do executor é só pista.
- **Os agents do roteiro nascem sozinhos**: se o projeto (e a conta) não tem algum, o Club cria o pronto em `.claude/agents` quando a conversa abre. O que já existe não é trocado.
- **Fichas que já existem não mudam sozinhas.** Quem foi contratado antes de o cargo ter roteiro continua sem ele: abra a ficha, em **Roteiro** escolha **Planeja grande, executa pequeno** e salve (vale a partir da próxima sessão). O mesmo vale para um cargo que você editou em **Configurações** → **Cargos**: a sua versão não ganha o roteiro sozinha; escolha o **Roteiro** nela ou use **voltar ao original**.
- **Executor que já existia**: se o `executor` do projeto era o pronto antigo (Haiku, Low) e ninguém o editou, o Club o atualizou uma vez para o novo (Sonnet, Medium), e o arquivo anterior ficou em `~/.myco/agent-backups`. O que alguém editou fica como está: o cartão do agent mostra "O pronto atual de “executor” é Sonnet · Medium; este usa …", e na edição aparece o botão **Usar Sonnet · Medium**, que só preenche o formulário (vale ao salvar).
- **Codex**: os agents rodam como subagents e **herdam o modelo da conversa** do funcionário; o modelo escrito no agent não vale lá. Só o esforço vem do agent. Ver `06-consumo-e-motores.md`.
- **Gastar menos**: o executor e o executor rápido só poupam se o modelo deles for menor que o do funcionário. Se o funcionário já roda em Sonnet, o ganho está no executor rápido (Haiku) e no esforço.

## A ficha

Abra o funcionário e, no painel dele, clique em **⋯** (**Mais opções**). As abas são **Ficha** (quem é) e **Projeto** (o que usa e como trabalha no projeto).

Na aba **Ficha**:

- **Nome\*** e **Cargo\***: nome e cargo na ficha. **Retrato**: foto pequena, mostrada no quadro.
- **Missão\***: o que ele faz. A primeira frase é o que o gestor vê dele. **Definição de pronto** e **Regras (uma por linha)**.
- **Modelo** e **Esforço**: começam do cargo. Se o motor recusar o modelo da ficha (ele deixou de existir), a conversa segue no modelo padrão, o cartão no quadro ganha o selo **Modelo obsoleto** e o painel e a ficha mostram o aviso; trocar o modelo e salvar tira a marca.
- **Roteiro**: **Nenhum (trabalha do jeito dele)**, **Planeja grande, executa pequeno**, **Reconhece, depois constrói** ou **Portão de revisão**. Com um roteiro escolhido, a lista **Quem ajuda neste roteiro** mostra cada agent dele com o papel e o modelo (o que falta no projeto aparece como "criado ao abrir a conversa"). No Codex a lista mostra "modelo da conversa" e o esforço. No nível simples, a explicação do roteiro aparece embaixo do resumo do cargo.
- **Autonomia** (tabela abaixo).
- **Trabalhar numa worktree própria**: cópia git só dele, num branch próprio. O projeto precisa ser repositório git. Sem ela, o funcionário edita direto no projeto; com a opção "um escritor por vez" ligada no projeto, ele espera o card de outro funcionário que está editando fechar, e a ficha mostra um aviso disso embaixo da opção. Com ela, trabalha em paralelo sem esperar. Veja "Um card escrevendo por vez" em `04-tarefas.md`.
- **Pode contratar subfuncionários**: os contratados entram como temporários, com no máximo a autonomia dele.
- **Motor** e **Motor secundário** aparecem só com o Codex ligado. Ver `06-consumo-e-motores.md`.

Na aba **Projeto**:

- **Reporta a**: quem pode chamá-lo. Nenhum marcado = só você.
- **Conhecimento (um caminho por linha)**: arquivos que ele lê antes de começar. **Agents e skills indicados** aparecem se o projeto tiver algum: marque os agents extras que ele deve usar. Os do roteiro valem sem marcar.
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

**Só planeja não combina com agent que edita nem com MCP Livre.** Em **Só planeja** o agent herda o modo e não grava (no Codex, ele roda na mesma sandbox, só de leitura): marcar o `executor`, o `executor-rapido` ou qualquer agent com Edit, Write, Bash ou PowerShell nas ferramentas (ou escolher um roteiro que os chama) só gasta consumo. Se o mesmo nome existe no projeto e na conta, vale o agent do projeto. E um MCP em **Livre**, o navegador incluso, não tem trava de escrita: em **Só planeja** quem segura é o próprio modelo; para garantir, use **Só leitura**. Quando a ficha tem **Só planeja** e uma dessas marcas, o campo **Autonomia** mostra o aviso **Impasse: “Só planeja” não grava**, com os nomes, ao contratar e ao editar, no Claude e no Codex. É só um aviso: dá para salvar. Para sair do impasse, tire da ficha o agent que você marcou, ou use o `pesquisador`, que só lê, ou escolha uma autonomia que edite; se o agent vem do **Roteiro**, desmarcá-lo não adianta, porque o roteiro continua chamando (mesmo o que o projeto nem tem): troque o roteiro ou escolha uma autonomia que edite. Ponha o MCP ou o **Acesso do navegador** em **Só leitura** ou escolha uma autonomia que edite. O MCP que o **Testar** achou sem nenhuma ferramenta de escrita não entra no aviso. O **navegador** vem ligado e **Livre** por padrão, então ele já entra no aviso; no Codex ele só conta com **Permitir que o GPT use meu Chrome** ligado nas Configurações. No Codex a ficha não tem a lista de agents nem a de MCPs: lá o aviso vale para o roteiro e para o navegador.

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

## Consulta entre projetos

Deixa um funcionário de um projeto fazer uma pergunta a um funcionário de outro (ex.: o Roberto, do Slingshot, pergunta ao Alphonse, do Learnote, como funciona o builder). **Vem desligado**: só você liga, limita e revoga, pela tela.

**Ligar:** no detalhe do projeto, aba **Projeto**, seção **Consulta entre projetos**.

1. Em **Ligar a outro projeto**, escolha o **projeto consultado**.
2. Em **Quem daqui pode consultar**, deixe **Todos** ou escolha **Só alguns** e marque os funcionários.
3. Clique em **Ligar**. O vínculo vale na hora.

**Limitar depois:** em **Editar** na linha do vínculo, troque a lista e clique em **Salvar lista**. Quem saiu da lista tem as consultas abertas canceladas.

**Revogar:** **Revogar** na linha do vínculo (e confirme). As consultas abertas entre os dois projetos são canceladas na hora e nenhuma resposta delas chega. A seção mostra também os vínculos que chegam a este projeto (quem pode consultá-lo), e dá para revogá-los daqui.

**O vínculo tem direção:** ligar o Slingshot ao Learnote não deixa o Learnote perguntar ao Slingshot.

**O que o funcionário consultado pode e não pode:**

- Pode: ler os arquivos do projeto dele e escrever uma resposta curta (até 4 KB).
- Não pode: editar, rodar comando, usar API ou MCP, ler a memória pessoal, criar tarefa, delegar nem consultar outro projeto. Qualquer pedido de permissão é negado.
- A resposta passa por um filtro que tira trechos com cara de segredo (chaves, tokens, `senha=…`). É um filtro, não uma garantia: não ligue o vínculo entre projetos cujos arquivos tenham segredos soltos.

**Custo:** a consulta gasta a **cota de uso do projeto consultado**, não a de quem perguntou. Projeto consultado pausado recusa a consulta.

**Limites:** prazo de 10 minutos por consulta, uma aberta por par de funcionários, no máximo 3 abertas por projeto consultado e poucas por hora.

**Como aparece:** a resposta chega à conversa de quem perguntou com o selo **Resposta de outro projeto · nome (projeto)**, e a conversa de consulta, no projeto consultado, abre com **Consulta de outro projeto · nome (projeto)**. É informação de outro funcionário, não ordem sua: o funcionário não segue instruções que estejam nela. Consulta sem resposta (prazo, erro ou revogação) vira um aviso curto, sem conteúdo.

**Consultas recentes:** a seção lista as últimas cinco que saem ou chegam ao projeto, com o estado (em andamento, respondida, falhou, sem resposta no prazo, cancelada, não entregue) e o prazo das que estão em andamento.

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

- Em **Configurações** → **MCPs** (**Servidores MCP**), há só dois escopos, os mesmos das skills: **Global** (`~/.claude.json`: vale em todos os projetos e também no Claude Code fora do Claudio’s Club; os cadastrados pela tela guardam os segredos no cofre do sistema) e **Projeto** (`.mcp.json` do projeto escolhido: vai para o git, não ponha chave ali; o que estava no escopo local do Claude Code aparece aqui, com a marca **fora do git**, só deste computador). Na ficha, cada MCP marcado é guardado com o escopo (Global ou Projeto); com o mesmo nome nos dois, só um pode ser marcado (o do Projeto vale na conversa). MCP que já estava salvo só pelo nome é convertido: Projeto se existe lá, senão Global.
- Tipos: **HTTP**, **SSE** e **Comando local**. Valores de variáveis e cabeçalhos nunca voltam para a tela; aparece "definido".
- Botões: **+ MCP**, **Testar**, **Editar**, **Excluir**.
- Na ficha, cada MCP marcado tem um seletor de acesso, na linha do nome:
  - **Livre**: segue a autonomia da ficha (como sempre). Não tem trava de escrita: em **Só planeja** quem segura é o próprio modelo, e a ficha avisa (ver **Autonomia**).
  - **Pede antes de escrever**: as ferramentas de leitura passam; as que escrevem pedem a sua aprovação, em qualquer autonomia. No Codex, que não pergunta, as que escrevem ficam bloqueadas.
  - **Só leitura**: as de leitura passam; as que escrevem ficam bloqueadas.
  - **Desligado**: o MCP não entra na conversa.
- Quem só lê é o que o próprio MCP declara no **Testar**. Sem teste, ou se o MCP mudou depois dele, nenhuma ferramenta conta como leitura: em **Só leitura** o MCP inteiro fica bloqueado e em **Pede antes de escrever** toda ferramenta pede antes. Com um desses dois escolhidos, a ficha mostra quantas ferramentas contam como escrita, ou avisa que o MCP não foi testado.
- No modo sem travas, e sempre no GPT, *Pede antes de escrever* vira *Só leitura*, porque não há quem confirme.
- O **navegador** tem um seletor só, **Acesso do navegador**, que aparece com **Usar o navegador** marcado. Vale para o Claude in Chrome e para o Chrome do GPT, que são o mesmo navegador (vale o mais restritivo dos dois). Ele não tem teste: **Só leitura** bloqueia o navegador inteiro e **Pede antes de escrever** pede a cada ação.
- A lista de MCPs (Global e Projeto) e o acesso de cada um valem nos dois motores, Claude e GPT (Codex); o GPT recebe os marcados na ficha pelo arquivo de lançamento da conversa. O **Acesso do navegador** também vale nos dois.
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
  - **Instalar:** cole o link no campo **URL do GitHub** e clique **Ver prévia** (Enter também vale). Só repositório **público**. Vale o link do repositório, de uma pasta (`/tree/<branch>/<pasta>`) ou do `SKILL.md` (`/blob/...`). Se o link tiver várias skills, aparece **Este link tem N skills. Marque as que quer instalar:** (nome, pasta e descrição de cada, cada uma com uma caixa) e a caixa **Selecionar todas** (com todas marcadas, desmarca). O passo a passo de várias de uma vez está em **Instalar várias skills de uma vez**, mais abaixo. Com **uma só** marcada, **Ver prévia (1)** abre a prévia dela, como descrito a seguir, e **Voltar** volta à lista.
  - A **prévia** não grava nada e mostra, nesta ordem: a origem (repositório, branch e commit), os **Alertas**, o `SKILL.md` como texto, a lista completa de arquivos (com a etiqueta **script** ou **binário**) e o **Nome da pasta** em que a skill vai ficar (começa com o nome da pasta do repositório; mude se quiser). Os alertas ficam no alto, do mais grave ao menos (**Perigo**, **Atenção**, **Aviso**, escritos além da cor): script ou programa na pasta (vários viram uma linha só, com a lista), arquivo binário, `hooks`, `allowed-tools`, `shell` ou `model` no cabeçalho e comando `` !`...` `` no texto, que roda ao chamar a skill. Sem alerta, a tela diz que isso só pega o que o Club sabe reconhecer: leia o `SKILL.md` mesmo assim.
  - **Instalar** é um botão separado de **Voltar** e **Cancelar**, sempre à vista no pé da janela. Com um alerta de **Perigo** (`hooks` ou comando que roda ao chamar a skill), ele só libera depois de marcar **Li os alertas de perigo e quero instalar mesmo assim**. Instala exatamente o commit mostrado na prévia; se o GitHub mudou no meio, a tela diz que o repositório mudou e oferece **Ver prévia de novo** (nada é gravado). Se já existe uma skill com esse nome, o Club recusa e não sobrescreve: troque o **Nome da pasta**.
  - **Instalar não ativa a skill.** A tela repete isso na prévia e no fim: só grava a pasta. Depois, marque a skill na ficha de quem deve usar (na biblioteca, como `myco:<nome>`).
  - **Instalar várias skills de uma vez** (link de repositório ou pasta com mais de uma skill, como `https://github.com/greensock/gsap-skills`, que tem 8):
    - Marque as skills na lista (ou **Selecionar todas**) e clique **Ver prévia (N)**. Com **uma** marcada vale o fluxo de uma skill (inclusive trocar o **Nome da pasta**); com **duas ou mais** o Club busca a prévia de cada uma (**Buscando 3 de 8…**) e abre a tela **Prévia de N skills**.
    - No alto: o repositório e a branch, e os **Alertas** de todas somados por nível (**Perigo**, **Atenção**, **Aviso**, escritos além da cor). Abaixo, uma linha por skill, com a caixa de incluir, o nome, o nível mais grave dela e o total de arquivos; clicar no nome abre o acordeão com a origem (commit e pasta), os alertas, o `SKILL.md` como texto e a lista de arquivos, como na prévia de uma só.
    - **Skill com alerta de Perigo vem desmarcada** (e já abre, com um aviso na linha) e só entra se você marcar de novo; marcar vale como a ciência do **Li os alertas de perigo e quero instalar mesmo assim** da prévia de uma só. A caixa também fica travada, com o motivo, se o nome de pasta da skill não vale no escopo (na biblioteca, só minúsculas): instale só essa para poder trocar o nome.
    - **Instalar N** grava de uma vez as marcadas, cada uma no commit da própria prévia. Não sobrescreve skill que já existe.
    - O resultado vem **por skill**: **Instalada** (com o commit) ou **Falhou** (com o motivo, como **já existe a skill x** ou **o repositório mudou desde a prévia**). A falha de uma não desfaz nem impede as outras. **Voltar à lista** (só quando algo falhou) volta com as que falharam marcadas.
    - Até 50 skills por vez. A prévia busca uma skill depois da outra; se o GitHub bater o limite de consultas no meio, as que faltam aparecem com **sem prévia** e o aviso do limite (as já vistas continuam valendo).
  - Recusado, sem gravar nada (a tela mostra o motivo): caminho com `..` ou caractere proibido, nome reservado do Windows, dois arquivos que viram o mesmo no Windows (só caixa diferente), link simbólico, submódulo, mais de 300 arquivos, arquivo acima de 1 MB (`SKILL.md` acima de 128 KB), mais de 5 MB no total, redirecionamento para fora do GitHub, arquivo que não bate com o que o GitHub registrou e chave de API escrita em qualquer arquivo. Nenhum script é executado na instalação.
  - Destino: a biblioteca do Club, a conta (`~/.claude/skills`) ou o projeto (`.claude/skills`). Junto da skill fica o arquivo `.myco-origin.json`, com o link, a pasta, a branch acompanhada, o commit, a data e o hash de cada arquivo.
  - **Depois de instalada**, o cartão da skill (e a linha dela na biblioteca) leva o selo **GitHub**. No painel da skill (na biblioteca, dentro da janela da skill), a seção **Origem no GitHub** mostra o link do repositório, o commit (curto), a branch que ela acompanha e a data. O selo **há versão nova** aparece quando a checagem diária achou novidade; **modificada aqui** aparece quando você editou a skill depois de instalar.
  - **Atualizar não é automático.** Uma vez por dia o Club consulta o GitHub (uma consulta por repositório) só para marcar que há versão nova; nada é baixado nem trocado. A novidade só conta se a pasta da skill mudou (commit em outra parte do repositório não conta).
  - **Verificar atualização** (sob demanda, em qualquer skill instalada por link) baixa a versão nova e mostra: de onde vem, quantos arquivos entram, saem e mudam, as chaves do cabeçalho que mudam (antes → depois), os alertas da versão nova e o **diff de todos os arquivos** (linhas que entram e saem; arquivo binário só com o tamanho; mudança enorme sem linhas). Se estiver em dia, diz isso; se só outra parte do repositório mudou, diz que a pasta da skill não mudou.
  - **Aplicar atualização** pede confirmação (**Aplicar** ou **Cancelar**) e grava exatamente a versão mostrada; se a versão nova tem alerta de **Perigo**, também exige a caixa de ciência. A versão anterior vai para `~/.myco/backups/skills-github`. Se você editou a skill depois de instalar, aparece um aviso vermelho já no alto da seção e a confirmação vira **Sobrescrever e aplicar**: suas mudanças saem da pasta (fica uma cópia da versão atual em backup, mas **Voltar** não restaura mudanças locais). Se a skill for mexida entre a verificação e o clique, a confirmação de sobrescrever aparece na hora.
  - **Voltar à versão anterior** (também com confirmação) só funciona depois de uma atualização aplicada; antes disso o Club responde que não há versão anterior. A versão de que você saiu também fica guardada, então dá para voltar de novo.
  - Depois de aplicar ou voltar, o painel relê a skill: **Editar** abre o texto novo.
  - Sem login no GitHub o limite é de 60 consultas por hora; ao bater nele, a tela diz a hora em que libera.
- Na lista **Agents e skills indicados**, cada skill mostra o escopo ao lado: **Global** (a pasta `skills` da conta) ou **Projeto** (a pasta `.claude/skills` do projeto). O mesmo nome nos dois escopos aparece em duas linhas, e a ficha guarda qual delas você marcou.
- Skill apagada ou renomeada que uma ficha tinha marcada continua na lista, marcada e com o selo **não existe mais**: desmarque e salve para tirá-la da ficha. O selo só aparece quando a skill não existe no escopo marcado (marcou a **Global** e só existe a do **Projeto**, por exemplo). Skill sincronizada da conta que já estava na ficha aparece com a etiqueta **sincronizada**, sem selo.
- **Agents** (subagents do Claude Code): crie com **Novo agent** no painel do projeto. Há quatro prontos: **Executor (Sonnet)**, **Executor rápido (Haiku)**, **Pesquisador (Haiku, só leitura)** e **Revisor (Sonnet)**. Cada cartão de agent mostra o modelo, o esforço e uma etiqueta do papel (**implementa**, **mecânico**, **só lê**, **confere**). Ao editar um pronto, o papel dele aparece embaixo de **Modelo** e **Esforço**.
- Skills não existem no Codex: o GPT não recebe as skills marcadas na ficha (o Codex não tem como carregar uma skill só numa conversa). Os agents do roteiro existem lá como subagents (ver `06-consumo-e-motores.md`).

Conversas e permissões: `03-chat.md`. Consumo e motores: `06-consumo-e-motores.md`. Se a dúvida não estiver aqui, diga que não sabe.
