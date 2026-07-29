# Rodar o Mandafy sobre Supabase

Do Supabase usamos **apenas o Postgres**. Nada de `@supabase/supabase-js`,
`@supabase/ssr` ou PostgREST: a autenticação, a RLS e o acesso a dados já
existem neste repositório e são testados. O quickstart que o painel do Supabase
sugere descreve uma arquitetura diferente da nossa.

O Supabase tem quatro diferenças em relação a um Postgres comum que, se
ignoradas, produzem falhas que só aparecem em produção. Todas estão resolvidas
abaixo.

---

## 1. Criar o papel da aplicação

Sem isto o isolamento multi-tenant **não vale nada**: a aplicação se conectaria
como dona das tabelas e ignoraria as próprias políticas de RLS. O consultor
passaria a ver a carteira inteira, e os testes locais continuariam verdes.

No painel do Supabase → **SQL Editor** → cole e execute, trocando a senha:

```sql
-- Papel da aplicação. Sem BYPASSRLS, sem SUPERUSER: só o necessário para operar.
create role mandafy_app login password 'TROQUE-POR-UMA-SENHA-FORTE';
alter  role mandafy_app nobypassrls;

grant connect on database postgres to mandafy_app;
grant usage   on schema   public   to mandafy_app;

-- O Supabase instala as extensões no schema `extensions`. Sem isto o tipo
-- citext não resolve para este papel e toda query em users/contacts falha.
alter role mandafy_app set search_path = public, extensions;
```

Rode isto **antes** do `npm run db:migrate`. A migration `0010_rls.sql` detecta
o papel e concede as permissões de tabela; se ele não existir, ela apenas
registra um aviso e o RLS fica sem efeito.

## 2. Usuário do pooler tem o ref do projeto embutido

Esta é a pegadinha que mais custa tempo. No Supavisor (o pooler), o nome de
usuário **não** é o nome do papel: é `papel.ref-do-projeto`.

```bash
# Errado — o pooler recusa
postgresql://mandafy_app:SENHA@aws-1-sa-east-1.pooler.supabase.com:6543/postgres

# Certo
postgresql://mandafy_app.zoxtcfvjafdgjybbclqs:SENHA@aws-1-sa-east-1.pooler.supabase.com:6543/postgres
```

A conexão direta (`db.<ref>.supabase.co:5432`) usa o nome do papel sem sufixo.

## 3. Porta 6543 desliga prepared statements

O modo transação do pooler entrega cada query a uma conexão possivelmente
diferente, então prepared statements não sobrevivem entre chamadas.
`src/db/index.ts` detecta isso pela porta, pelo host `pooler.supabase.com` ou
pelo parâmetro `pgbouncer`, e desliga o preparo sozinho. `DATABASE_PREPARE`
força o comportamento se a heurística não servir.

## 4. As duas URLs

```bash
# Aplicação e worker — RLS SEMPRE aplicado
DATABASE_URL=postgresql://mandafy_app.<ref>:SENHA_APP@aws-1-<regiao>.pooler.supabase.com:6543/postgres

# Migrations e seed — dono das tabelas, ignora RLS
DATABASE_URL_ADMIN=postgresql://postgres.<ref>:SENHA_POSTGRES@aws-1-<regiao>.pooler.supabase.com:6543/postgres
```

Que elas sejam papéis diferentes é o ponto inteiro. Apontar as duas para
`postgres` desmonta a garantia de §9.4.

---

## Ordem de execução

```bash
# 1. SQL Editor do Supabase: criar o papel (seção 1 acima)

# 2. Schema
DATABASE_URL_ADMIN='postgresql://postgres.<ref>:SENHA@...:6543/postgres' \
  npm run db:migrate

# 3. Organização, admin, ritmos de envio e pipeline
DATABASE_URL_ADMIN='postgresql://postgres.<ref>:SENHA@...:6543/postgres' \
  SEED_ADMIN_EMAIL='voce@empresa.com.br' \
  SEED_ADMIN_PASSWORD='uma-senha-de-10-ou-mais' \
  npm run db:seed
```

## Conferir que a RLS realmente está de pé

Vale a pena rodar os testes de isolamento contra o Supabase antes de confiar
nele. Eles criam e apagam os próprios dados:

```bash
TEST_DATABASE_URL_ADMIN='postgresql://postgres.<ref>:SENHA@...:6543/postgres' \
TEST_DATABASE_URL='postgresql://mandafy_app.<ref>:SENHA_APP@...:6543/postgres' \
  npx vitest run tests/rls.test.ts
```

O primeiro teste — *"o papel da aplicação NÃO ignora RLS"* — é o que pega o
erro de configuração mais perigoso: as duas URLs apontando para o mesmo papel.

---

## Manutenção das partições sem worker

Na Vercel o worker não roda, então nada chama `mandafy_maintain_partitions()`.
Sem isso, as partições diárias deixam de ser criadas e as escritas caem na
partição `DEFAULT` (nada se perde, mas o descarte por retenção para de
funcionar).

O Supabase tem `pg_cron`. No SQL Editor:

```sql
create extension if not exists pg_cron;

select cron.schedule(
  'mandafy-manutencao',
  '17 * * * *',          -- fora do minuto zero, para não competir com outros crons
  $$ select mandafy_maintain_partitions() $$
);
```

Rode **depois** do `db:migrate`, que é quem cria a função.

---

## O que o Supabase não resolve

- **O worker das filas** (§7.1) precisa de um processo long-running. Vercel não
  serve. Railway, Fly.io ou o próprio VPS.
- **A Evolution API** (§8.2) é obrigatoriamente self-hosted, sobre o protocolo
  do WhatsApp Web. Exige VPS, sem alternativa gerenciada.

Ou seja: mesmo indo de Vercel + Supabase, o VPS reaparece na Fase 4.
