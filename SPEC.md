# Guia do projeto

> A equipe consulta este arquivo em caso de dúvida.
>
> Se tiver informação privada (senhas, dados de clientes, endereços internos),
> não escreva aqui: ponha o arquivo no `.gitignore`.

## Visão

Uma plataforma que organiza projetos e estipula funcionários com memórias persistentes para trabalhar com multi motores de IA. Simulando uma software factory, permite automatizar e centralizar o workflow de maneira visual e profissional.

## Problema que resolve

Unifica as memórias de AI Dev e integra com Codex e Claude signatures. Permite enxergar todo o fluxo de trabalho dos agentes de maneira visual e dedicado, melhorando a consistência, qualidade e economia de tokens.

## Escopo

<!--
O que o projeto faz. Uma função principal por linha.
-->

## Fora do escopo

<!--
O que o projeto não faz, mesmo que alguém peça.
Evita trabalho que contraria a visão.
-->

## Princípios e regras inegociáveis

<!--
Regras que não se quebram por conveniência.
Ex.: dados sensíveis só no servidor; dependência nova só com aprovação.
-->

## Glossário

<!--
Termos do projeto e o que significam, para todos falarem a mesma língua.
-->

## Decisões

<!--
Cada decisão com data e o porquê.
Ex.: 2026-11-06: SQLite, porque o cliente não tem servidor de banco.
-->

## Dúvidas em aberto

<!--
O que ainda não foi decidido. Quando resolver, passe para Decisões.
-->

## Lições da revisão

<!--
Regras que saíram de um 🔴 da revisão e valem para o projeto todo, uma por linha, com data.
No máximo 15: ao passar disso, junte ou tire as que ficaram velhas.
Ex.: 2026-11-06: toda rota que grava confere o cabeçalho x-myco.
-->

- 2026-11-20: `.myco/` está no `.gitignore`, então o revisor que lê pelo diff não vê os prints: na entrega liste o caminho absoluto de cada print com a hora de gravação e, na rodada de ajuste, regrave-os depois da última edição do CSS.
- 2026-11-20: no celular, ação de decisão do dono (rodapé fixo, Aprovar, Responder) nunca some com o foco em campo ou o teclado aberto; o corpo é que encolhe e rola.
- 2026-11-20: "com o teclado aberto" se prova no navegador nos dois modelos (layout que encolhe: viewport baixo; teclado que só cobre: `visualViewport` reduzido), não só com regra de CSS; no segundo o rodapé precisa seguir `visualViewport` (`client/src/tasks/useKeyboardInset.ts`).
- 2026-11-20 (ampliada 2026-11-21): toda entrega que edita código traz a saída de `npx tsc --noEmit` e a contagem dos testes do tema, mesmo quando o pedido veio pela conversa e não por card; print de tela só vale se for posterior ao último mtime de `client/src/styles.css` (arquivo compartilhado, outras tarefas regravam).
- 2026-11-20: teste que simula "parada resolvida" (`stuckState`, caixa, selos derivados) parte de um estado resolvido de verdade (revisão aberta, veredito, resposta dada), não de tirar só o campo que causou a parada: `stuckState` ganha regras novas e o fixture fica vermelho (conferir o teste do tema no `tasks.ts` sujo de hoje, não só o do dia).
- 2026-11-21: a revisão lê o diff da pasta principal do projeto; entrega feita só em outra branch/worktree/PR não aparece nele e reprova. A mudança também tem que estar na pasta principal (sem commit), além do PR, se houver.
- 2026-11-21: critério "o botão X faz Y" se prova acionando o handler (onClick/onSubmit) e conferindo a chamada que sai (rota e corpo), não só o HTML renderizado; sem jsdom, use o despachante de hooks mínimo de `tests/followUpDecideFlow.test.ts`.
- 2026-11-21: botões de ação fora do `ActionBar` (formulário, balão, caixa) seguem a mesma ordem: secundárias primeiro, a primária por último no DOM; no celular ela ocupa a largura inteira, embaixo (confira em cada estado: fechado e aberto).
- 2026-11-21: regra de token de CSS (fonte, cor, espaçamento) cobre também o shorthand (`font: 700 9px`); varra e teste todas as formas, não só a declaração isolada (`font-size:`).

## Desempenho: regras que não podem voltar atrás

O Claudio's Club roda numa máquina comum (Windows, 4 núcleos, HDD, pouca RAM livre) ao lado de vários agentes. Em 22/11/2026 o servidor chegou a
responder rotas triviais em 30 s e arquivos estáticos em 99 s. As causas medidas estão abaixo, com a regra que impede cada uma de voltar. Quem mexer
nessas áreas confere a regra antes de entregar; mudar uma delas pede medição (antes e depois) no pedido de revisão.

### 1. O quadro (`.myco/tasks.json` e o arquivo morto) é lido uma vez por versão do arquivo

- O quadro são dois arquivos: o ativo (`.myco/tasks.json`) e o arquivo morto (`.myco/tasks-arquivo.json`), com as tarefas fechadas (prontas ou canceladas) sem mudança há mais de 6 h (`MYCO_COLD_AFTER_HOURS` troca). O ativo é regravado inteiro, com fsync, a cada mudança; o morto quase nunca muda.
- Toda leitura passa por `readTasks` (os dois arquivos juntos, cada um guardado por versão do arquivo: mtime, ctime, tamanho e inode) ou por `readActiveTasks` (só o ativo). Não ler nenhum dos dois por outro caminho em rota ou rotina.
- `readActiveTasks` só em caminho que olha tarefa aberta e não procura tarefa por id vindo de fora, nem dependência, pai/filho, idempotência ou pronta com pendência (commit, vaga de escrita, aviso da caixa). Na dúvida, `readTasks`: a cancelada do morto ainda bloqueia quem espera por ela.
- Toda gravação passa por `mutate` (que descarta o guardado do arquivo gravado). Nunca gravar nenhum dos dois fora dele. A mudança de arquivo segue a ordem de `writeBoard`: o morto ganha a tarefa (e a cópia dele sai) antes de o ativo perdê-la; o ativo ganha a reaberta antes de o morto perdê-la. Em nenhum instante, nem numa queda de energia, a tarefa fica fora dos dois; repetida nos dois, vale a do ativo. Tarefa do morto que muda volta ao ativo: a única gravação que decide é a do ativo.
- Entrada no morto no máximo uma vez por hora por projeto; saída na hora. Quem lê durante uma mudança de arquivo recebe o quadro de antes dela, sem esperar as gravações.
- Tarefa lida nunca é alterada no lugar: sempre objeto novo (`{ ...t, campo }`). O guardado é o mesmo para todos os leitores; nos testes ele vem congelado e a alteração no lugar quebra o teste. As do morto vêm congeladas sempre: a gravação descobre o que mudou nele pela identidade dos objetos.
- Arquivo mexido há menos de 3 s não é guardado (o mtime do Windows anda em degraus de ~15,6 ms: duas gravações seguidas de mesmo tamanho dariam a mesma versão).

*Por quê:* o arquivo passa de 5 MB; reler e refazer o parse a cada listagem, rodada da fila e mudança era o maior gasto de CPU do servidor. Com o fsync (regra 6), regravar os 6,3 MB custava 204 ms (mediana no HDD); só o ativo (0,23 MB, em 24/11/2026), 67 ms.

### 2. Caminho quente sem varrer transcripts

- Achar a pasta de um projeto e a lista de projetos do quadro no caminho das tarefas usa `adapter.projectPath` / `adapter.boardProjectIds` (só a descoberta e um `access`).
- `adapter.listProjects()` (que faz `stat` de todo transcript do `~/.claude/projects`, mais de mil arquivos) não entra em caminho chamado por tarefa, por cartão ou por polling.
- O `/api/board` lê o começo e o fim de cada transcript **uma vez por versão do arquivo** (`transcriptFacts` em `server/adapters/claude/sessions.ts`, com a mesma janela de 3 s da regra 1). O que muda sem mexer no transcript (ao vivo, `custom-title.json`, subagents) é lido a cada montagem e não entra no guardado.

*Por quê:* o `stat` em rajada ocupava o pool de I/O do Node, e a leitura e a gravação do quadro ficavam esperando atrás dele. Em 23/11/2026 o `/api/board` era a rota mais lenta (até 5,7 min com o HDD 100% ocupado): cada montagem relia 2 × 64 KB de ~600 transcripts.

### 3. Git e CLIs nas leituras da tela: uma vez por projeto, com teto e prazo

- Leitura de tela (caixa, contador de commits pendentes, aviso de commit parcial, estado do git das salas) consulta o git **uma vez por projeto por leitura**: o estado do repositório e o `status` de todos os caminhos juntos, divididos entre os cartões e entre os chamadores que perguntam ao mesmo tempo. (No aviso de commit parcial: t-56749a, em revisão. Na caixa, o `pendingChanges` do resolvedor: `planejado`.)
- Proibido: git por cartão, por aviso ou por item dentro de `Promise.all`. Com 49 avisos, isso eram ~540 `git.exe` por leitura, três leituras ao mesmo tempo, a cada 30 s.
- `planejado` Processo externo de fundo (git das leituras, `claude auth status`) tem teto de quantos rodam juntos, prazo de execução que mata o processo e prazo de espera: quem passou do prazo desiste sem rodar, em vez de acumular. (Hoje o teto existe só nas leituras do aviso de commit, na t-56749a, em revisão.)
- `planejado` Quem desiste por prazo (`settleWithin` e afins) não deixa processo rodando por trás. A leitura seguinte não abre outra por cima da que ainda roda: junta-se a ela.
- O que o dono pede (commit, mesclar, painel de código, `@` arquivos, começar tarefa) não espera trabalho de fundo.
- CLI pesado consultado pela tela guarda o resultado: o `claude auth status` vale 5 min; só o fluxo de login pede de novo na hora (`fresh`).

*Como conferir:* com o app aberto e o quadro parado, contar os `git.exe` vivos (devem ser poucos, nunca dezenas) e olhar o log `[lento]`.

### 4. Polling da tela não pode crescer com o tamanho do quadro

- Rota chamada em polling (a cada 3 a 20 s) responde do que já está em memória ou com custo fixo por projeto, nunca proporcional ao número de tarefas com processo externo.
- Leituras estáveis no cliente (`client/src/api.ts`): resposta com o mesmo texto devolve o mesmo objeto (tarefas, filas, consumo), e o React não redesenha. O `board` fica de fora de propósito: o redesenho dele atualiza o "há X min".
- GETs iguais em voo dividem uma ida ao servidor; toda escrita muda a geração, e a releitura depois de gravar nunca recebe a resposta de um GET que saiu antes.
- O quadro de tarefas limita os grupos longos (Pronto, arquivadas, canceladas: 40 por vez, com "Mostrar mais"). As colunas de trabalho em andamento ficam inteiras. O relógio de 30 s mantém o tempo relativo certo.

### 5. Rotinas periódicas sem reentrada

- A rodada da fila de tarefas (60 s) roda uma por vez. Rodada presa há mais de 10 min é liberada com aviso no log, para não desligar a rede de segurança.
- Rotina nova com `setInterval` que faz I/O ou sobe processo segue o mesmo padrão: uma de cada vez.

### 6. Gravação atômica tolerante ao Windows e à queda de energia

- O rename do `writeAtomic` tenta por pelo menos ~3 s (backoff com jitter) antes de desistir: no HDD, o antivírus segura o destino por mais que meio segundo. A desistência vai para o log; ela nunca é silenciosa.
- O `writeAtomic` força os dados no disco (`sync`) **antes** do rename. Sem isso, uma queda de energia logo depois deixa o arquivo com o tamanho certo e só zeros: em 23/11/2026 o `tasks.json` do MyCo (6,3 MB) voltou assim, e só foi recuperado varrendo o disco inteiro. Custo medido no HDD para esses 6,3 MB: de 22 para 205 ms por gravação (mediana). Encolher o arquivo (tirar as tarefas prontas antigas) é o que baixa esse custo; tirar o `sync`, não. Foi o que o arquivo morto fez (regra 1).
- Quem vai gravar o quadro lê de forma estrita (`readTasksForWrite`): arquivo preso que não solta vira `StateBusyError`, e quadro que não lê como lista vira `BoardCorruptError`. Nunca `[]`. Antes, as duas viravam lista vazia, e a gravação seguinte trocava o quadro inteiro por quase nada.
- O quadro tem cópias em `.myco/backups/tasks/` (no máximo uma a cada 10 min; ficam as 6 mais novas e a última de cada dia por 7 dias). Arquivo que não lê como lista é guardado ao lado (`tasks.json.corrompido-<data>`) e volta a cópia boa mais nova, ou a última versão lida pelo servidor. Sem nenhuma das duas, as gravações são recusadas até o arquivo ser consertado. Qualquer desses casos vira aviso na caixa "precisa de mim" (`server/boardGuard.ts`).
- O arquivo morto tem a mesma proteção, com cópias em `.myco/backups/tasks-arquivo/`: uma a cada entrada de tarefa nele (sem o limite de 10 min, e antes de a tarefa sair do ativo; sem a cópia, a entrada fica para depois). Morto que já existiu (tem cópia) e sumiu conta como estragado e volta da cópia. Estragado sem conserto trava o quadro inteiro, como o ativo: nada aparece e nada é gravado (sem ele, a fila liberaria quem espera por uma cancelada que está nele). Para zerar o quadro de propósito, com o servidor parado, apague também `.myco/backups/tasks-arquivo/`.

### 7. Estáticos e subida

- `/assets/` (nome com hash do build) é imutável por 1 ano; o resto (`index.html`, `sw.js`, ícones) é `no-cache` com ETag/Last-Modified e responde 304. O imutável é decidido pelo caminho já resolvido, nunca pelo texto pedido.
- Sem compressão: o servidor só escuta no loopback (127.0.0.1); comprimir só atrasaria a primeira carga.
- O vigia e o `daily` sobem o servidor com `UV_THREADPOOL_SIZE=16` (respeitando valor já definido).

### 8. Medir antes de mudar

- Pedido acima de 2 s vai para o log como `[lento] MÉTODO caminho status em N ms`, sem a query (pode levar código ou token) e sem o SSE.
- Mudança que afeta essas regras traz no pedido de revisão o número de antes e de depois: tempo da rota, processos git por leitura, atraso do event loop.

### 9. Testes em camadas

- Na entrega e na mescla, com vitest e a lista dos arquivos mudados, rodam só os testes ligados a eles: `vitest related … --passWithNoTests --maxWorkers=2` (`scopedTestCommand` em `server/taskCode.ts`). A suíte inteira roda no CI do PR e no botão "rodar testes" do cartão. `MYCO_FULL_TESTS=1` força a suíte inteira.
- Fora do CI, a suíte do Club roda com no máximo 2 processos de teste (`maxWorkers` no `vitest.config.ts`; `MYCO_TEST_WORKERS` troca o número).

*Por quê:* a suíte inteira (372 arquivos, ~6.800 testes) levava de 10 a 30 min por entrega nesta máquina, duas vezes por tarefa (entrega e mescla). Com 3 processos de ~350 MB ao lado dos funcionários, o Windows paginava no HDD. No CI ela roda em ~3 min.
