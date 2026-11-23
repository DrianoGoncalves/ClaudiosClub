# Deploy como código: o contrato do Claudio's Club

O Club não roda pipeline. Ele **dispara e acompanha** o workflow de deploy que mora no repositório do projeto. O workflow é escrito e mantido
pelo funcionário de infra (cargo DevOps / SRE). Assim o deploy se repete igual, dá para auditar e funciona com qualquer stack: o Club só conhece
a interface descrita abaixo, e o que a stack precisa (build, testes, destino) fica dentro do workflow.

Sem esse workflow, o "Pedir deploy" segue como antes: uma conversa com o funcionário de infra pelo MCP `myco-ssh` (plano B).

## O contrato (v1)

| Item | Regra |
|---|---|
| Arquivo | `.github/workflows/deploy.yml` |
| Gatilho | `workflow_dispatch`, com as entradas abaixo. Opcional: `push` de tag `v*` publica em **staging** sozinho. |
| Entrada `ref` | Obrigatória. O commit (SHA) ou a tag que vai ao ar. Validada no primeiro passo (só `[A-Za-z0-9._/-]`). |
| Entrada `ambiente` | `staging` (padrão) ou `producao`. Produção **só** por disparo com `ambiente=producao`; o Club pede o ok do dono antes. |
| Ambientes | Um *environment* do GitHub por ambiente (`staging`, `producao`), cada um com os próprios Secrets. |
| Segredos | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_PATH` e `SMOKE_URL`, nos Secrets do environment. Nunca no repositório, no chat ou na memória. |
| Smoke | Último passo: `curl` na `SMOKE_URL` (com algumas tentativas). Falhou = o job falha, e o Club mostra "fora do ar". |
| Rollback | Disparar o mesmo workflow com a **tag anterior** em `ref`. Nada de reescrever a história. |
| Concorrência | `concurrency: deploy-<ambiente>`, com `cancel-in-progress: false` (um deploy nunca é cortado no meio). |
| Resultado | O Club lê só a conclusão da execução (sucesso ou falha) e o link do log. Não precisa de saída especial. |

## Segurança (vale para todo workflow)

- Actions **pinadas por SHA**. Os modelos abaixo vêm com a tag (`@v4`) e um comentário: troque pelo SHA da release antes de usar, com
  `gh api repos/actions/checkout/git/ref/tags/v4 --jq .object.sha` (o mesmo vale para as outras actions).
- `permissions: contents: read` e nada mais.
- Entradas (`inputs.*`) e dados do evento **nunca** dentro de `run:`. Passe por `env:` e valide (proteção contra injeção de comando).
- SSH com `known_hosts` fixo (o Secret `DEPLOY_KNOWN_HOSTS`). Nada de `StrictHostKeyChecking=no`.
- Depois do deploy, remova as versões antigas no servidor (imagens, volumes e pastas de release).

## Modelo: Node (build e envio da pasta pronta)

```yaml
name: Deploy

on:
  workflow_dispatch:
    inputs:
      ref:
        description: Commit ou tag que vai ao ar
        required: true
      ambiente:
        description: Onde publicar
        type: choice
        options: [staging, producao]
        default: staging

permissions:
  contents: read

concurrency:
  group: deploy-${{ inputs.ambiente }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: ${{ inputs.ambiente }}
    env:
      REF: ${{ inputs.ref }}
    steps:
      - name: Validar a entrada
        run: '[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "ref inválida"; exit 1; }'
      - uses: actions/checkout@v4 # pinar por SHA
        with:
          ref: ${{ inputs.ref }}
      - uses: actions/setup-node@v4 # pinar por SHA
        with:
          node-version: 22
          cache: npm
      - run: npm ci --no-audit --no-fund
      - run: npm run build
      - name: Enviar ao servidor
        env:
          HOST: ${{ secrets.DEPLOY_HOST }}
          USER: ${{ secrets.DEPLOY_USER }}
          KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          KNOWN: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
          DEST: ${{ secrets.DEPLOY_PATH }}
        run: |
          set -euo pipefail
          install -m 700 -d ~/.ssh
          printf '%s\n' "$KEY" > ~/.ssh/id_deploy && chmod 600 ~/.ssh/id_deploy
          printf '%s\n' "$KNOWN" > ~/.ssh/known_hosts
          rsync -az --delete -e "ssh -i ~/.ssh/id_deploy" dist/ "$USER@$HOST:$DEST/"
          # Reinício ou limpeza ficam num script no servidor, se o projeto precisar; a falha dele derruba o deploy (não é escondida):
          ssh -i ~/.ssh/id_deploy "$USER@$HOST" "if [ -x '$DEST/post-deploy.sh' ]; then '$DEST/post-deploy.sh'; fi"
      - name: Smoke
        env:
          URL: ${{ secrets.SMOKE_URL }}
        run: curl -fsS --retry 5 --retry-delay 5 --retry-all-errors "$URL" > /dev/null
```

## Modelo: PHP (Composer e envio por rsync)

Igual ao de Node, trocando os passos de build:

```yaml
      - uses: shivammathur/setup-php@v2 # pinar por SHA
        with:
          php-version: '8.3'
      - run: composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader
```

No envio, mande a pasta do projeto em vez de `dist/`, excluindo o que não vai ao ar:
`rsync -az --delete --exclude .git --exclude .github --exclude tests --exclude .env ./ "$USER@$HOST:$DEST/"`.
O `.env` de produção fica só no servidor.

## Outras stacks e outros provedores

- **Stack nova** (Python, Go, .NET…): o contrato não muda. O funcionário de infra troca os passos de build e envio.
- **Hospedagem com CD próprio** (Vercel, Netlify, Cloudflare): ela já publica a cada push. O workflow vira só um invólucro da CLI dela, ou nem é preciso.
- **Fora do GitHub** (GitLab, Bitbucket) ou **projeto sem repositório remoto**: sem modelo por enquanto. O deploy segue pela conversa SSH até
  existir um projeto real assim; aí entra um adaptador novo no Club e um modelo equivalente.
- **App mobile ou desktop:** outro contrato (build e envio para teste interno), quando aparecer.
