# Design system: botões

Dona: Belchior (design system). Aplicar nas telas é do front-end. Tokens e classes em `client/src/styles.css` (bloco "botões: hierarquia" no fim).

## Hierarquia

| Nível | Classe | Quando | Exemplo |
|---|---|---|---|
| Primária | `btn-primary` (preenchida) | Ação que destrava o fluxo ou depende do dono. No máximo 1 por painel/região. Sem pendência do dono, é a próxima ação natural. | `Aprovar entrega`, `Responder dúvida`, `Começar` |
| Secundária | `btn-secondary` (contorno) | Alternativas | `Delegar revisão`, `Abrir conversa`, `Editar` |
| Mais | "⋯" (`chat-more-btn`, `hr-more`) | Ações raras | mover, reabrir, tirar da fila |
| Destrutiva | `btn-secondary is-danger` + confirmação | Cancelar, apagar, revogar. Nunca primária; dentro de "⋯" quando não é o objetivo do painel. | `Apagar projeto` |

```html
<div class="actions"> <!-- ActionBar -->
  <button class="btn-secondary chat-more-btn">⋯</button>
  <button class="btn-secondary">Delegar revisão</button>
  <button class="btn-secondary is-danger">Cancelar tarefa</button>
  <button class="btn-primary">Aprovar entrega</button>
</div>
```

## Regras
- Ordem fixa [⋯] [secundárias] [primária]. Primária à direita no desktop; no celular, largura total e embaixo.
- Rótulo verbo + objeto. Nunca "OK" ou "Confirmar" soltos.
- Primária desabilitada mostra o motivo ao lado. Durante o envio: "enviando…" e sem clique duplo.
- Celular: alvo de toque 44 px (regra global ≤ 640 px; exceção: ícone 28 px `btn-icon`, `⋯`). Foco visível: contorno 2 px `--ink-blue`.
- Aplicar nos painéis com o componente `ActionBar` (barra de ações fixa, t-f541d9).

## Contraste (WCAG AA ≥ 4,5:1)
Texto da primária: `--on-ink-blue` sobre `--ink-blue` (claro 7,2:1; escuro 9,9:1). Destrutiva: `--danger` sobre `--card`/`--panel`/`--board`. Medido e travado em `tests/buttonContrast.test.ts`. Mexeu em token de botão → rode o teste.
