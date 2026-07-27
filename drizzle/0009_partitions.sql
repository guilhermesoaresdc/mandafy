-- Manutenção das tabelas particionadas (§10.2).
--
-- A limpeza é DROP TABLE da partição: instantânea, não trava nada, não gera
-- VACUUM. É muito superior a DELETE FROM … WHERE created_at < …, que degrada
-- o banco inteiro.
--
-- Estas funções são chamáveis por pg_cron OU pelo worker (fila `maintenance`).
-- Não dependemos de imagem customizada do Postgres.

-- ─────────────────────────────────────────────────────────────────────────────
-- Cria as partições diárias que faltam. Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mandafy_ensure_partitions(days_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  spec       record;
  d          date;
  part_name  text;
  created    integer := 0;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES ('events_raw'), ('events'), ('notifications')) AS t(tbl)
  LOOP
    -- Começa em ontem para cobrir eventos que chegam com atraso de fuso.
    FOR d IN
      SELECT generate_series(current_date - 1, current_date + days_ahead, interval '1 day')::date
    LOOP
      part_name := spec.tbl || '_' || to_char(d, 'YYYY_MM_DD');

      IF to_regclass('public.' || quote_ident(part_name)) IS NULL THEN
        BEGIN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            part_name, spec.tbl, d::text, (d + 1)::text
          );
          created := created + 1;
        EXCEPTION WHEN OTHERS THEN
          -- Uma partição que falha (por exemplo porque a DEFAULT já recebeu
          -- linhas daquele dia) não pode impedir a criação das outras.
          RAISE WARNING 'mandafy_ensure_partitions: falhou em % (%)', part_name, SQLERRM;
        END;
      END IF;
    END LOOP;
  END LOOP;

  RETURN created;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Consolida os agregados diários antes de qualquer descarte (§10.2, camada fria).
-- Sem isto, o painel perderia o histórico ao dropar as partições quentes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mandafy_aggregate_notifications(days_back integer DEFAULT 4)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  touched bigint;
BEGIN
  INSERT INTO notification_daily_stats (org_id, day, channel, status, flow_id, total)
  SELECT
    n.org_id,
    (n.created_at AT TIME ZONE 'UTC')::date,
    n.channel,
    n.status,
    COALESCE(n.flow_id, '00000000-0000-0000-0000-000000000000'::uuid),
    count(*)
  FROM notifications n
  WHERE n.created_at >= current_date - days_back
  GROUP BY 1, 2, 3, 4, 5
  ON CONFLICT (org_id, day, channel, status, flow_id)
  DO UPDATE SET total = EXCLUDED.total;

  GET DIAGNOSTICS touched = ROW_COUNT;
  RETURN touched;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Move a camada quente para a morna antes do descarte (§10.2).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mandafy_archive_notifications(hot_days integer DEFAULT 3)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  moved bigint;
BEGIN
  INSERT INTO notifications_archive (
    id, org_id, created_at, contact_id, message_id, variant_id, flow_id, step_id,
    event_id, channel, status, scheduled_for, attempted_at, sent_at, delivered_at,
    read_at, provider, provider_message_id, provider_instance, rendered_subject,
    rendered_body, attempts, error_code, error_message, cancel_key, dedupe_key,
    queue_job_id
  )
  SELECT
    id, org_id, created_at, contact_id, message_id, variant_id, flow_id, step_id,
    event_id, channel, status, scheduled_for, attempted_at, sent_at, delivered_at,
    read_at, provider, provider_message_id, provider_instance, rendered_subject,
    rendered_body, attempts, error_code, error_message, cancel_key, dedupe_key,
    queue_job_id
  FROM notifications
  WHERE created_at < current_date - hot_days
  ON CONFLICT (id, created_at) DO NOTHING;

  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Descarta partições fora da retenção.
--
-- Segurança: só entram no laço tabelas que são de fato partições dos nossos
-- pais (via pg_inherits) E cujo nome casa com o padrão de data. A partição
-- DEFAULT nunca casa com o padrão, então nunca é descartada.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mandafy_drop_old_partitions(
  events_raw_days     integer DEFAULT 7,
  events_days         integer DEFAULT 30,
  notifications_days  integer DEFAULT 3
)
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  spec       record;
  part       record;
  part_date  date;
  dropped    integer := 0;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('events_raw',    events_raw_days),
      ('events',        events_days),
      ('notifications', notifications_days)
    ) AS t(tbl, keep_days)
  LOOP
    FOR part IN
      SELECT c.relname AS name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE p.relname = spec.tbl
        AND n.nspname = 'public'
    LOOP
      CONTINUE WHEN part.name !~ ('^' || spec.tbl || '_\d{4}_\d{2}_\d{2}$');

      part_date := to_date(right(part.name, 10), 'YYYY_MM_DD');

      IF part_date < current_date - spec.keep_days THEN
        EXECUTE format('DROP TABLE IF EXISTS %I', part.name);
        dropped := dropped + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN dropped;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- O que pg_cron ou o worker chamam. A ordem importa: agregar e arquivar
-- ANTES de descartar, senão o histórico se perde.
-- ─────────────────────────────────────────────────────────────────────────────
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

  RETURN format(
    'partições criadas=%s agregados=%s arquivadas=%s descartadas=%s',
    created, aggregated, archived, dropped
  );
END;
$fn$;

-- Partições DEFAULT: rede de segurança para que nada se perca se a manutenção
-- falhar. Nunca são descartadas pela função acima.
CREATE TABLE IF NOT EXISTS events_raw_default    PARTITION OF events_raw    DEFAULT;
CREATE TABLE IF NOT EXISTS events_default        PARTITION OF events        DEFAULT;
CREATE TABLE IF NOT EXISTS notifications_default PARTITION OF notifications DEFAULT;

-- Partições iniciais, para o sistema já subir gravando.
SELECT mandafy_ensure_partitions(3);
