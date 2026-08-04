-- RLS nas tabelas que ficaram de fora, antes que ligá-lo quebre o envio.
--
-- SINTOMA, do log de produção:
--
--   new row violates row-level security policy for table "system_state"
--
-- A tabela foi criada SEM RLS de propósito (0017): ela não guarda dado de
-- tenant, e o batimento a escreve sem contexto de organização. Só que num
-- Postgres gerenciado o painel exibe "RLS desabilitada" como alerta de
-- segurança, com um botão que liga. Ligada e sem política, ela recusa toda
-- escrita — e o batimento parou.
--
-- A LIÇÃO, QUE VALE ALÉM DESTA TABELA
--
-- "Deixar sem RLS e documentar por quê" não sobrevive a um painel que oferece
-- ligar em um clique. Quem opera vê um alerta vermelho de segurança e resolve —
-- como deve. A defesa não é pedir para não clicar: é deixar a política pronta,
-- de modo que ligar não mude comportamento nenhum.
--
-- Por isso aqui o RLS é LIGADO com política permissiva, em vez de desligado.
-- O alerta some, o comportamento continua, e o botão do painel vira inócuo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabelas de sistema, sem dado de tenant
-- ─────────────────────────────────────────────────────────────────────────────
-- `system_state` guarda quando cada tarefa periódica rodou. `auth_tokens`
-- guarda o sha256 de links de senha e o id do dono. Nenhuma das duas tem
-- `org_id`, e nenhuma é alcançável por consulta que não conheça a chave.
--
-- Política permissiva é a resposta CERTA aqui, não uma concessão: uma política
-- de tenant numa tabela sem tenant só poderia comparar `org_id` com nulo, o que
-- recusaria tudo. O que protege estas tabelas é o formato — busca por resumo
-- criptográfico de 32 bytes — e não a política.
DO $$
DECLARE
  t text;
BEGIN
  /*
   * `_migrations` entra na lista pelo mesmo motivo, e é a mais perigosa das
   * três: ligar RLS nela sem política impediria o app de registrar migrations
   * aplicadas — e como ele migra sozinho na subida, cada deploy tentaria
   * reaplicar tudo desde o começo e falharia.
   */
  FOREACH t IN ARRAY ARRAY['system_state', 'auth_tokens', '_migrations'] LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_sistema', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (true) WITH CHECK (true)',
        t || '_sistema', t
      );
    END IF;
  END LOOP;
END
$$;

COMMENT ON TABLE system_state IS
  'Quando cada tarefa periódica rodou. Sem dado de tenant: a política é permissiva de propósito, para que ligar RLS pelo painel não quebre o batimento.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. As partições — o próximo clique que quebraria tudo
-- ─────────────────────────────────────────────────────────────────────────────
-- `events`, `events_raw` e `notifications` são particionadas por dia, e cada
-- partição é uma tabela própria. A política do PAI já governa o acesso feito
-- pelo pai, que é como a aplicação sempre consulta — então as filhas nascem sem
-- política e aparecem no mesmo alerta do painel.
--
-- Se alguém ligar RLS numa partição de `notifications`, ela passa a recusar
-- toda escrita e o envio para por completo, num dia específico, sem erro
-- visível em lugar nenhum. É a mesma armadilha de `system_state`, num lugar
-- muito pior.
--
-- A correção é a mesma: deixar a política pronta em cada partição, idêntica à
-- do pai. Ligar RLS depois não muda nada.
CREATE OR REPLACE FUNCTION mandafy_politicas_das_particoes()
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  parte    record;
  aplicadas integer := 0;
BEGIN
  FOR parte IN
    SELECT c.relname AS filha, p.relname AS pai
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND p.relname IN ('events', 'events_raw', 'notifications')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', parte.filha);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', parte.filha || '_tenant', parte.filha);

    IF parte.pai = 'events_raw' THEN
      -- `events_raw` não tem org_id: a visibilidade vem da fonte, como no pai.
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL
           USING (EXISTS (SELECT 1 FROM sources s WHERE s.id = %I.source_id))
           WITH CHECK (EXISTS (SELECT 1 FROM sources s WHERE s.id = %I.source_id))',
        parte.filha || '_tenant', parte.filha, parte.filha, parte.filha
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL
           USING (org_id = mandafy_current_org())
           WITH CHECK (org_id = mandafy_current_org())',
        parte.filha || '_tenant', parte.filha
      );
    END IF;

    aplicadas := aplicadas + 1;
  END LOOP;

  RETURN aplicadas;
END
$fn$;

SELECT mandafy_politicas_das_particoes();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. E as partições NOVAS, criadas todo dia
-- ─────────────────────────────────────────────────────────────────────────────
-- Sem isto, o conserto duraria até amanhã: a partição de cada dia nasceria de
-- novo sem política, e o alerta do painel voltaria junto com o risco.
CREATE OR REPLACE FUNCTION mandafy_maintain_partitions()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  created    integer;
  aggregated bigint;
  archived   bigint;
  dropped    integer;
  policiadas integer;
BEGIN
  created    := mandafy_ensure_partitions(3);
  aggregated := mandafy_aggregate_notifications(4);
  archived   := mandafy_archive_notifications(3);
  dropped    := mandafy_drop_old_partitions(7, 30, 3);

  -- Antes de conceder: partição sem política é partição que recusa escrita se
  -- alguém ligar RLS nela.
  policiadas := mandafy_politicas_das_particoes();

  PERFORM mandafy_grant_app_role();

  RETURN format(
    'partições criadas=%s agregados=%s arquivadas=%s descartadas=%s policiadas=%s',
    created, aggregated, archived, dropped, policiadas
  );
END
$fn$;

-- `mandafy_politicas_das_particoes` roda dentro de uma função SECURITY DEFINER,
-- então herda os privilégios do dono. Fechada para o resto.
REVOKE ALL ON FUNCTION mandafy_politicas_das_particoes() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT EXECUTE ON FUNCTION mandafy_maintain_partitions() TO mandafy_app;
  END IF;
END
$$;
