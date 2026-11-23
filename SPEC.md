# Claudio's Club: guia do projeto

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
