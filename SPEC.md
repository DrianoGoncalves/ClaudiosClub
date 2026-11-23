# Guia do projeto

> A equipe consulta este arquivo em caso de dúvida.
>
> Se tiver informação privada (senhas, dados de clientes, endereços internos),
> não escreva aqui: ponha o arquivo no `.gitignore`.

## Visão

<!--
O que é o projeto, em duas ou três frases, e para quem é.
-->

## Problema que resolve

<!--
Qual dor existe hoje e o que muda para quem usa
quando o projeto estiver pronto.
-->

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

### 1. O quadro (`.myco/tasks.json`) é lido uma vez por versão do arquivo

- Toda leitura passa por `readTasks` (guardado por versão do arquivo: mtime, ctime, tamanho e inode). Não ler o `tasks.json` por outro caminho em rota ou rotina.
- Toda gravação passa por `mutate` (que descarta o guardado). Nunca gravar o `tasks.json` fora dele.
- Tarefa lida nunca é alterada no lugar: sempre objeto novo (`{ ...t, campo }`). O guardado é o mesmo para todos os leitores; nos testes ele vem congelado e a alteração no lugar quebra o teste.
- Arquivo mexido há menos de 3 s não é guardado (o mtime do Windows anda em degraus de ~15,6 ms: duas gravações seguidas de mesmo tamanho dariam a mesma versão).

*Por quê:* o arquivo passa de 5 MB; reler e refazer o parse a cada listagem, rodada da fila e mudança era o maior gasto de CPU do servidor.

### 2. Caminho quente sem varrer transcripts

- Achar a pasta de um projeto e a lista de projetos do quadro no caminho das tarefas usa `adapter.projectPath` / `adapter.boardProjectIds` (só a descoberta e um `access`).
- `adapter.listProjects()` (que faz `stat` de todo transcript do `~/.claude/projects`, mais de mil arquivos) não entra em caminho chamado por tarefa, por cartão ou por polling.

*Por quê:* o `stat` em rajada ocupava o pool de I/O do Node, e a leitura e a gravação do quadro ficavam esperando atrás dele.

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

### 6. Gravação atômica tolerante ao Windows

- O rename do `writeAtomic` tenta por pelo menos ~3 s (backoff com jitter) antes de desistir: no HDD, o antivírus segura o destino por mais que meio segundo. A desistência vai para o log; ela nunca é silenciosa.

### 7. Estáticos e subida

- `/assets/` (nome com hash do build) é imutável por 1 ano; o resto (`index.html`, `sw.js`, ícones) é `no-cache` com ETag/Last-Modified e responde 304. O imutável é decidido pelo caminho já resolvido, nunca pelo texto pedido.
- Sem compressão: o servidor só escuta no loopback (127.0.0.1); comprimir só atrasaria a primeira carga.
- O vigia e o `daily` sobem o servidor com `UV_THREADPOOL_SIZE=16` (respeitando valor já definido).

### 8. Medir antes de mudar

- Pedido acima de 2 s vai para o log como `[lento] MÉTODO caminho status em N ms`, sem a query (pode levar código ou token) e sem o SSE.
- Mudança que afeta essas regras traz no pedido de revisão o número de antes e de depois: tempo da rota, processos git por leitura, atraso do event loop.
