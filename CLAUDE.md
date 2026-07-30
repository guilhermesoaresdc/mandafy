# Mandafy — convenções do projeto

Motor de notificações multicanal (WhatsApp, e-mail, SMS, Telegram) + CRM leve para
plataformas de sorteio. A especificação completa e normativa está em
[`docs/especificacao.md`](docs/especificacao.md) — leia antes de mexer em qualquer
subsistema. As referências `§N` neste arquivo e nos comentários do código apontam
para seções daquele documento.

> Nota de nomenclatura: a especificação foi escrita com o nome de produto "Pulso".
> O nome adotado é **Mandafy**. Onde a spec diz `pulso_live_…`, `X-Pulso-Signature`
> ou `pls.to`, use `mandafy_live_…`, `X-Mandafy-Signature` e o domínio configurado
> em `SHORTLINK_DOMAIN`. O resto da spec vale literalmente.

## Stack (fixa — não adicione dependências sem perguntar)

Next.js 15 App Router · TypeScript · Drizzle ORM · PostgreSQL 16 · BullMQ + Redis ·
Tailwind v4 · Radix Primitives · Zod · TanStack Query/Virtual · Vitest.

## Layout do repositório

```
src/
  app/           rotas (App Router). (app)/ = área autenticada, login/ = pública
  components/
    ui/          primitivas do design system (Pad, Button, Field, …)
    shell/       casca do app: navegação em sessões, cabeçalho, paleta ⌘K
  db/
    schema/      tabelas Drizzle, um arquivo por domínio
    queries/     consultas reaproveitadas pelas telas — testáveis contra o banco
    migrate.ts   aplica drizzle/*.sql
    seed.ts      organização, admin, mensagens e fluxos-modelo
  lib/
    auth/        sessão em cookie, hash de senha, guardas de rota
    channels/    um adaptador por canal atrás de uma interface comum (§8)
  worker/        processo long-running que consome as filas BullMQ
drizzle/         migrations em SQL puro (inclui partições e pg_cron)
docker/          Dockerfile, Caddyfile, init de banco
```

## Regras não negociáveis

1. **React Server Components por padrão.** `"use client"` só nos componentes
   listados em §13.2: pads de canal, kanban, barra de pulso, editor de mensagem,
   filtros do histórico. O orçamento de performance de §13 é requisito.
2. **Multi-tenant desde o dia 1.** Toda query carrega `org_id`. Consultor só
   enxerga os próprios leads — garantido no banco (RLS), não só na UI (§9.4).
3. **Canais isolados.** `src/lib/channels/{whatsapp,email,sms,telegram}.ts` atrás
   de uma interface comum. Trocar de provedor = trocar variável de ambiente (§8).
4. **Cancelamento por chave** (§5.1) é a lógica mais crítica do sistema. Tem teste
   próprio; não altere sem rodar `npm test`.
5. **Query nova = teste que a executa.** `tsc`, `eslint` e `next build` passam
   com SQL que o Postgres recusa. Consultas de tela moram em `src/db/queries/` e
   são exercitadas em `tests/consultas.test.ts`; a renderização, em
   `npm run fumaca`.
6. **Nenhum dado pessoal em log de aplicação** (§14.1). Telefone, e-mail, CPF e
   nome nunca vão para stdout.
7. **Credenciais de provedor criptografadas em repouso** (AES-256-GCM,
   `ENCRYPTION_KEY` no ambiente, nunca no banco).
8. **Português na interface, inglês no código.** Rótulos, mensagens de erro e
   nomes de rota em pt-BR (`/mensagens`, `/fluxos`); identificadores, tipos e
   nomes de arquivo em inglês. Comentários em português quando explicam decisão.
9. **Copy da interface segue §11.7**: nomeie pelo que a pessoa controla, não pela
   implementação ("Conectar plataforma", não "Webhook config").

## Comandos

| Comando | O que faz |
|---|---|
| `docker compose up` | Sobe tudo (app, worker, postgres, redis, evolution, caddy) |
| `npm run dev` | Next.js em modo desenvolvimento |
| `npm run worker:dev` | Worker das filas com recarga automática |
| `npm run db:generate` | Gera migration a partir do schema Drizzle |
| `npm run db:migrate` | Aplica as migrations pendentes |
| `npm run db:seed` | Popula org, admin, mensagens e fluxos-modelo |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run fumaca` | Sobe o app compilado e abre cada tela autenticada |

## Fases de implementação (§15)

Uma fase por vez, cada uma funcionando de ponta a ponta.

- [x] **1 — Fundação**: compose, schema, migrations, auth, RBAC, design system, navegação
- [x] **2 — Ingestão**: webhook de entrada, dedupe, mapeamento visual, normalização
- [x] **3 — Mensagens**: CRUD, variantes por canal, compilação, spintax, pré-visualização
- [x] **4 — Entrega**: BullMQ, adaptadores dos 4 canais, jitter, janela de silêncio, guardas
- [x] **5 — Fluxos**: cadências, agendamento em cascata, cancelamento por chave
- [ ] **6 — Histórico e painel**: SSE ao vivo, partições, dashboard, barra de pulso
- [ ] **7 — CRM**: leads virtualizados, kanban, distribuição, RLS por consultor
- [ ] **8 — API e polimento**: API pública, chaves, webhooks de saída, LGPD
