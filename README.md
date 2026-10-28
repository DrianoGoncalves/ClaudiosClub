<div align="center">

# MyCo

### Sua empresa de agentes do Claude Code, num quadro branco.

Contrate funcionários, passe tarefas, veja quem está trabalhando e quem está esperando por você.<br>
**Todos os seus projetos numa tela só**, rodando na sua máquina, com a sua assinatura.

![Claude Code](https://img.shields.io/badge/Claude_Code-orquestrado-D97757?logo=claude&logoColor=white)
![Node](https://img.shields.io/badge/Node-22%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React_Flow-12-61DAFB?logo=react&logoColor=black)
![Local](https://img.shields.io/badge/100%25-local-2ea44f)

<img src="docs/img/quadro.png" alt="O quadro do MyCo: cada projeto é uma sala com o organograma dos funcionários do Claude Code" width="100%">

</div>

---

## Dez terminais abertos. Qual deles está esperando você?

Quem usa o Claude Code a sério termina o dia com uma sessão por projeto, cada uma num terminal, cada uma com o seu contexto, e nenhuma visão do todo. O MyCo transforma isso num escritório:

- **Cada projeto é uma sala**, com o organograma de quem trabalha nela.
- **Cada funcionário é uma sessão do Claude Code** com ficha, memória e autonomia que você define.
- **Um gestor planeja e distribui**, executores baratos fazem a parte braçal, e nada chega até você sem conferência.

## O que tem dentro

<table>
<tr>
<td width="33%" valign="top">

### 🏢 Escritório visual
Salas por projeto, organograma do gestor até a equipe, quem está ao vivo e o estado do git no cabeçalho: branch, arquivos sem commit, ↑↓ do remoto. Traço de caneta e letra de mão.

</td>
<td width="33%" valign="top">

### 👷 Funcionários com ficha
Cargo, missão, autonomia, modelo, agents, skills, MCPs, regras e definição de pronto. A ficha e a memória ficam em `.myco/` dentro do próprio projeto, com histórico de versões.

</td>
<td width="33%" valign="top">

### 🧭 Planeja grande, executa pequeno
O orquestrador quebra o trabalho e passa cada parte para quem é da área. Executores Haiku fazem, e um hook cobra a conferência de diff, tipos e testes a cada entrega.

</td>
</tr>
<tr>
<td valign="top">

### 💬 O app do Claude, aqui dentro
Modelo, esforço e autonomia na conversa, `/` comandos e skills, `@` arquivos, prints e PDFs, lista de tarefas, voltar no tempo, duplicar conversa, MCPs e agents em segundo plano.

</td>
<td valign="top">

### 📋 Kanban com fila
Uma tarefa por vez por funcionário: a próxima começa quando a atual vai para revisão. Cada um trabalha na sua worktree, e a entrega vira commit, com diff, testes e mesclar a um clique.

</td>
<td valign="top">

### 🔔 Precisa de mim
Permissões, perguntas e planos para aprovar numa caixa só, com contador no título da aba e notificação do sistema quando alguém termina.

</td>
</tr>
<tr>
<td valign="top">

### 📊 Consumo sob controle
Barras de 5 h e 7 dias da assinatura com o tempo até o reset, custo por funcionário, projeto e modelo, orçamento por projeto e uma linha de parada antes de estourar a cota.

</td>
<td valign="top">

### 🛡️ Guarda de segredos
Senha em comando, URL com senha e chaves conhecidas (Anthropic, OpenAI, GitHub, AWS, Stripe…) viram alerta no chat, nos comandos e nas saídas. O valor nunca é guardado.

</td>
<td valign="top">

### ⚡ Simples ou Avançado
No Simples: *Rápido / Equilibrado / Caprichado* e *Pede antes / Faz sozinho*. No Avançado, cada detalhe. E `Ctrl+K` leva a qualquer funcionário, tarefa ou conversa.

</td>
</tr>
</table>

## Como o trabalho anda

```mermaid
flowchart LR
    V([Você]) -->|pede| G["Gestor<br/>planeja e divide"]
    G -->|"tarefa da área"| F["Funcionário<br/>ex.: design system"]
    G -->|"parte pequena"| X["Executores<br/>Haiku"]
    F --> C{"Conferência<br/>diff · tipos · testes"}
    X --> C
    C -->|ok| R["Revisão<br/>no kanban"]
    R -->|"você aprova e mescla"| V
    R -.->|"próxima da fila"| G
```

Quem pediu fica sabendo quando a parte dele termina. Funcionários que um gestor contrata entram como **temporários**: saem do quadro quando o trabalho acaba (arquivados, nada é apagado), e só você decide efetivar.

## De perto

<img src="docs/img/barra.png" alt="Barra do topo: uso de 5 horas e 7 dias, precisa de mim, ranking e config" width="640">

**"Ainda posso pedir mais?"** A barra do topo mostra o uso da assinatura e quanto falta para o reset, quantas coisas esperam por você e o ranking de quem mais gastou.

<img src="docs/img/sala.png" alt="A sala de um projeto: o orquestrador com a equipe de design system e infraestrutura logo abaixo" width="100%">

**Uma sala, uma equipe.** O orquestrador no topo, quem é de cada área logo abaixo, as conversas soltas ao lado e os agents do projeto na coluna da direita.

<img src="docs/img/aguardando.png" alt="Sala com um funcionário destacado em vermelho, aguardando aprovação" width="100%">

**Quem trava, aparece.** O funcionário de testes pediu uma permissão: o cartão fica vermelho, a sala avisa "1 aguardando você" e o cabeçalho mostra um arquivo sem commit na branch de deploy.

## Por baixo do capô

- **O disco é a fonte da verdade.** O MyCo grava o que o Claude Code já entende (`.claude/agents`, `.claude/skills`, `CLAUDE.md`) e as fichas em `<projeto>/.myco/`. Fechou o MyCo, tudo continua funcionando.
- **Sem nuvem própria.** Cada funcionário é um processo `claude` na sua máquina, falando em `stream-json`. Conta, login e cota são os seus.
- **Só local.** O servidor escuta em `127.0.0.1`, recusa `Host` de fora (DNS rebinding) e só aceita escrita da própria página ou de ferramentas locais.
- **Infra com cinto de segurança.** O cargo de servidores acessa SSH só por apelido; `~/.ssh`, `.env` e chaves ficam bloqueados para o agente.

| Camada | Stack |
| --- | --- |
| Quadro | React 18, React Flow, Rough.js, fonte Caveat |
| Servidor | Node 22, TypeScript, SSE, zod |
| Claude Code | CLI em `stream-json`, hooks via `--settings`, mod `myco-tap` para a cota |
| Testes | Vitest |

## Começando

> [!NOTE]
> Precisa do **Node 22+**, do **Git** e do **[Claude Code](https://claude.com/claude-code)** instalado e com login feito. Feito e testado no **Windows 10/11**; os scripts do dia a dia são PowerShell.

```bash
git clone https://github.com/adrianogonca/MyCo.git
```

```bash
cd MyCo
```

```bash
npm install
```

```bash
npm run dev
```

Abra **http://myco.localhost:5173**, aponte as pastas dos seus projetos e contrate o primeiro funcionário.

| Para | Comando |
| --- | --- |
| Usar no dia a dia (build + servidor em http://myco.localhost:4848) | `npm run daily` |
| Subir junto com o Windows, em segundo plano | `npm run autostart` |
| Atalho no Menu Iniciar | `npm run launcher` |
| Barras de consumo 5 h / 7 d (instala o mod `myco-tap`) | `npm run mod:install` |
| Testes e tipos | `npm test` · `npm run typecheck` |

## O que vem por aí

- **Gatilhos e avaliações:** trabalho que começa sozinho e nota para cada entrega.
- **Codex:** o leitor de sessões já é um adaptador, pronto para receber outro motor.

O plano completo, fase a fase, está em [PLANO.md](PLANO.md).

## Créditos

A ideia de ler as sessões do Claude Code, o servidor Node com SSE e os instaladores com backup vieram do [habblaud](https://github.com/marmottajr/habblaud) (MIT), de [@marmottajr](https://github.com/marmottajr).
