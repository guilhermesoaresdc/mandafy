-- Concessões completas e repetíveis para o papel da aplicação.
--
-- 0010 já concedia, mas `GRANT ... ON ALL TABLES` só alcança as tabelas que
-- existem no instante em que roda. Qualquer tabela criada depois — inclusive
-- as partições diárias que a manutenção cria sozinha — nasce sem permissão, e
-- o sintoma é um login que funcionava e para de funcionar.
--
-- `ALTER DEFAULT PRIVILEGES` resolve o futuro, mas só para objetos criados
-- pelo MESMO papel que executou o comando. Como as partições podem ser criadas
-- por outro caminho (pg_cron, worker, SQL Editor), reconceder é a garantia
-- barata. Este arquivo é seguro de rodar quantas vezes for preciso.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    RAISE NOTICE 'Papel mandafy_app não existe; nada a conceder.';
    RETURN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO mandafy_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mandafy_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mandafy_app';
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO mandafy_app';

  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public
           GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mandafy_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public
           GRANT USAGE, SELECT ON SEQUENCES TO mandafy_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public
           GRANT EXECUTE ON FUNCTIONS TO mandafy_app';

  RAISE NOTICE 'Concessões aplicadas a mandafy_app.';

  /*
   * O Supabase instala extensões em `extensions`. Sem search_path o tipo
   * citext não resolve para este papel e toda query em users e contacts falha
   * com 42883.
   *
   * ALTER ROLE exige CREATEROLE ou superusuário — o dono das tabelas nem
   * sempre tem. Se não puder, avisa e segue: as concessões acima, que são o
   * essencial, já foram aplicadas. Abortar aqui deixaria o banco pior do que
   * antes de rodar a migration.
   */
  BEGIN
    EXECUTE 'ALTER ROLE mandafy_app SET search_path = public, extensions';
    RAISE NOTICE 'search_path de mandafy_app ajustado.';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE
      'Sem privilégio para ALTER ROLE. Se o banco for Supabase, rode como postgres: '
      'ALTER ROLE mandafy_app SET search_path = public, extensions;';
  END;
END
$do$;

-- Reconcede após criar partições, para que uma partição nova nunca fique
-- inacessível ao papel da aplicação. Chamada pela manutenção (§10.2).
CREATE OR REPLACE FUNCTION mandafy_grant_app_role() RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    RETURN;
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mandafy_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mandafy_app';
END
$fn$;

-- A manutenção passa a reconceder ao final. A ordem importa: agregar e
-- arquivar antes de descartar, e conceder depois de criar.
CREATE OR REPLACE FUNCTION mandafy_maintain_partitions()
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  created    integer;
  aggregated bigint;
  archived   bigint;
  dropped    integer;
BEGIN
  created    := mandafy_ensure_partitions(3);
  aggregated := mandafy_aggregate_notifications(4);
  archived   := mandafy_archive_notifications(3);
  dropped    := mandafy_drop_old_partitions(7, 30, 3);

  PERFORM mandafy_grant_app_role();

  RETURN format(
    'partições criadas=%s agregados=%s arquivadas=%s descartadas=%s',
    created, aggregated, archived, dropped
  );
END
$fn$;
