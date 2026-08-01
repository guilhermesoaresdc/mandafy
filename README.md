# Mandafy

**Cada mensagem no tempo certo, no canal certo.**

Uma camada entre a plataforma de sorteio e o cliente final: recebe eventos via
webhook, decide qual mensagem enviar, em quais canais, com qual atraso, e
registra tudo — com um CRM leve por cima para o time comercial trabalhar os
leads que sobram.

A especificação completa e normativa está em [`docs/especificacao.md`](docs/especificacao.md).
As referências `§N` no código apontam para seções daquele documento.

## As três engrenagens

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  INGESTÃO       │────▶│  MOTOR           │────▶│  ENTREGA         │
│                 │     │                  │     │                  │
│ Webhook in      │     │ Fluxos/cadências │     │ WhatsApp (Evo)   │
│ Normalização    │     │ Fila + jitter    │     │ E-mail           │
│ Deduplicação    │     │ Cancelamento     │     │ SMS              │
│ ACK < 50ms      │     │ Regras/condições │     │ Telegram         │
└─────────────────┘     └──────────────────┘     └──────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  CRM             │
                        │ Leads + Pipeline │
                        │ Admin/Consultor  │
                        └──────────────────┘
```

## Subir localmente

Precisa de Docker e Docker Compose. Cinco comandos:

```bash
cp .env.example .env
make segredos          # gera SESSION_SECRET e ENCRYPTION_KEY — cole no .env
make up                # sobe app, worker, postgres, redis e evolution
make migrate           # cria o schema
make seed              # cria a organização, o admin e o pipeline padrão
```

O `make seed` imprime a senha do administrador **uma única vez**. Guarde.

Painel em <http://localhost:3000>. Sem Docker, rodando o Next direto:

```bash
npm install
npm run db:migrate && npm run db:seed
npm run dev           # painel
npm run worker:dev    # worker das filas, em outro terminal
```

## Comandos

| Comando | O que faz |
|---|---|
| `make up` / `make down` | Sobe / derruba tudo |
| `make logs` | Acompanha app e worker |
| `make migrate` | Aplica as migrations pendentes |
| `make seed` | Popula os dados iniciais |
| `make psql` | Abre um psql no banco |
| `make check` | typecheck + lint + testes (o mesmo que a CI) |
| `make reset` | **Apaga os volumes.** Pede confirmação digitada |
| `make producao` | Sobe com Caddy e TLS, sem portas expostas |

## Variáveis de ambiente

Todas em [`.env.example`](.env.example), com comentários. As que exigem
atenção:

| Variável | Por quê |
|---|---|
| `SESSION_SECRET` | 32 bytes em hex. Assina os cookies de sessão |
| `ENCRYPTION_KEY` | 32 bytes em hex. AES-256-GCM das credenciais de provedor no banco. **Perder esta chave torna as credenciais salvas ilegíveis** |
| `DATABASE_URL` | Papel `mandafy_app`. RLS **sempre** aplicado — é o que o app e o worker usam |
| `DATABASE_URL_ADMIN` | Dono das tabelas. Ignora RLS. Só `db:migrate` e `db:seed` |
| `EVOLUTION_GLOBAL_APIKEY` | Chave da Evolution API. Sem ela o serviço não sobe |

Os dois endereços de banco não são redundância: é o que faz o isolamento entre
organizações e o "consultor só vê os próprios leads" valerem no banco, e não
apenas na interface. Ver [`drizzle/0010_rls.sql`](drizzle/0010_rls.sql).

Rodando sobre Supabase em vez do Postgres do compose? Leia
[`docs/supabase.md`](docs/supabase.md) antes — há quatro diferenças que, se
ignoradas, só aparecem em produção. Do Supabase usamos apenas o Postgres:
nada de `@supabase/supabase-js`, PostgREST ou Supabase Auth.

## Arquitetura

VPS único com Docker Compose. A Evolution API é obrigatoriamente self-hosted
(roda sobre o protocolo do WhatsApp Web), então o servidor existe de qualquer
forma; colocar app, banco, Redis e worker no mesmo host elimina latência entre
as peças e deixa o custo fixo.

```
caddy     reverse proxy + TLS automático
app       Next.js 15 (painel + API)
worker    Node — consome as filas BullMQ
postgres  PostgreSQL 16 — dados + partições diárias do log
redis     BullMQ + cache
evolution Evolution API v2 (WhatsApp)
```

Stack: Next.js 15 App Router · TypeScript · Drizzle ORM · PostgreSQL 16 ·
BullMQ + Redis · Tailwind v4 · Radix Primitives · Zod · Vitest.

As migrations são **SQL escrito à mão** em `drizzle/`. O gerador do drizzle-kit
não expressa tabelas particionadas, políticas RLS, `citext` nem índices
trigram — e o sistema depende dos quatro. O schema Drizzle em `src/db/schema/`
existe para tipar as queries e espelha aquele SQL.

## Deploy na Vercel

`vercel.json` traz um `ignoreCommand` que **só deixa construir a produção**.
Deploys de preview em cada push consomem crédito rápido e, neste projeto, não
mostram nada de útil: sem `DATABASE_URL` e `REDIS_URL` no ambiente de preview,
a aplicação só chega até a tela de entrada.

A semântica do `ignoreCommand` é invertida e vale registrar, porque confunde:
**código 1 constrói, código 0 pula**. Por isso a linha testa se
`VERCEL_ENV` é `production` e sai com 1 nesse caso.

Produção, para a Vercel, é a *branch de produção do projeto* — a `main`. Código
em qualquer outro branch só vira site depois do merge.

Para reativar previews temporariamente, apague o `ignoreCommand` ou troque a
condição. Rodando local (`npm run dev`) nada disso se aplica.

## Fases

- [x] **1 — Fundação**: compose, schema, migrations, autenticação, RBAC, design system, navegação
- [ ] **2 — Ingestão**: webhook de entrada, dedupe, mapeamento visual, normalização
- [ ] **3 — Mensagens**: CRUD, variantes por canal, compilação, spintax, pré-visualização
- [ ] **4 — Entrega**: filas por canal, adaptadores, jitter, janela de silêncio, guardas
- [ ] **5 — Fluxos**: cadências, agendamento em cascata, cancelamento por chave
- [ ] **6 — Histórico e painel**: SSE ao vivo, partições, dashboard, barra de pulso
- [ ] **7 — CRM**: leads virtualizados, kanban, distribuição, RLS por consultor
- [ ] **8 — API e polimento**: API pública, chaves, webhooks de saída, LGPD

## Sobre o WhatsApp: leia antes de operar

A Evolution API **não é** a API oficial da Meta. Ela funciona bem e é a escolha
certa para este custo e esta velocidade, mas **o número pode ser banido — e um
número banido raramente volta.**

### Conectando um número

Em **Canais**, preencha o endereço da Evolution e a chave global no cartão do
WhatsApp; depois **Conectar por QR Code**, dê um nome ao chip e leia o código
na própria tela. O Mandafy cria a instância, registra o retorno e detecta
sozinho quando o aparelho conecta. Não é preciso abrir o Manager da Evolution.

Se a Evolution já roda para outra operação, use **Colar credenciais**: o
Mandafy passa a enviar pela instância que já existe e **nunca a apaga do
servidor** — remover aqui tira só a linha daqui. A distinção fica gravada em
`wa_instances.managed`, e é ela que decide o que o botão "Remover" faz.

O retorno da Evolution chega em `/api/evolution/{token}` e é o que move o
histórico de *enviado* para *entregue* e *lido*, e o que faz "SAIR" respondido
no WhatsApp descadastrar na hora. A Evolution não assina o que envia — por isso
o segredo vai na URL, um por instância.

O Mandafy reduz o risco com aquecimento automático, rate limit por instância,
spintax, janela de silêncio, respeito a opt-out e rodízio entre números. Isso
reduz muito o risco, mas não o zera. Na prática:

- Sempre mais de um número conectado, com rodízio.
- O número principal do negócio **nunca** deve ser usado para automação em massa.
- O adaptador de canal é trocável: um cliente grande pode migrar para a
  WhatsApp Cloud API sem reescrever nada.

Seja direto com seus clientes sobre isso. É honesto, e protege você.

## LGPD

Requisito de arquitetura, não seção jurídica decorativa. O que já está no
código: consentimento por canal em `contacts`, supressões por canal e motivo,
credenciais de provedor cifradas em repouso, auditoria de acesso, e a regra de
que **nenhum dado pessoal vai para log de aplicação** — telefone, e-mail, CPF e
nome nunca chegam ao stdout (ver `src/lib/logger.ts`).

Retenção: 3 dias de log quente, 30 dias de arquivo, 12 meses de agregados
anônimos; `events_raw` some em 7 dias. A limpeza descarta partições inteiras,
sem travar o banco.
