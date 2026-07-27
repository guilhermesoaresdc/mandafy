-- Row Level Security: o isolamento multi-tenant no banco, não só na UI (§9.4).
--
-- MODELO DE PAPÉIS
--   mandafy      → dono das tabelas. Roda migrations e seed. Ignora RLS.
--   mandafy_app  → papel da aplicação e do worker. RLS SEMPRE aplicado.
--
-- Por isso NÃO usamos FORCE ROW LEVEL SECURITY: o dono precisa conseguir
-- migrar e semear, e a aplicação nunca se conecta como dono. É o
-- DATABASE_URL (papel da aplicação) que carrega a restrição; DATABASE_URL_ADMIN
-- (dono) é usado só por `db:migrate` e `db:seed`.
--
-- O contexto vem de SET LOCAL dentro da transação — ver withTenant() em src/db.

CREATE OR REPLACE FUNCTION mandafy_current_org() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION mandafy_current_user() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION mandafy_is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.is_admin', true), '')::boolean, false) $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Papel da aplicação. Criado pelo init do Docker; aqui só concedemos.
-- Se não existir (por exemplo num Postgres gerenciado), a migration não quebra.
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO mandafy_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mandafy_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mandafy_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mandafy_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public
             GRANT USAGE, SELECT ON SEQUENCES TO mandafy_app';
  ELSE
    RAISE NOTICE 'Papel mandafy_app não existe; RLS criado mas sem concessões.';
  END IF;
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabelas com org_id: política simples de tenant.
-- ─────────────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'sources', 'contacts', 'suppressions', 'messages', 'jitter_profiles',
    'flows', 'events', 'notifications', 'notifications_archive',
    'notification_daily_stats', 'pipelines', 'channel_configs', 'wa_instances',
    'api_keys', 'outbound_webhooks', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL
         USING (org_id = mandafy_current_org())
         WITH CHECK (org_id = mandafy_current_org())',
      t || '_tenant', t
    );
  END LOOP;
END
$do$;

-- ─────────────────────────────────────────────────────────────────────────────
-- organizations: a própria organização do contexto.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_tenant ON organizations;
CREATE POLICY organizations_tenant ON organizations FOR ALL
  USING (id = mandafy_current_org())
  WITH CHECK (id = mandafy_current_org());

-- ─────────────────────────────────────────────────────────────────────────────
-- users e sessions: precisam ser legíveis ANTES de existir contexto de tenant,
-- senão o login é impossível. A permissão extra vale só quando app.org_id não
-- está definido — isto é, no caminho de autenticação, que são poucas queries
-- explícitas e todas por identificador não adivinhável (e-mail + senha, ou
-- sha256 do token de sessão).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant ON users;
CREATE POLICY users_tenant ON users FOR ALL
  USING (mandafy_current_org() IS NULL OR org_id = mandafy_current_org())
  WITH CHECK (mandafy_current_org() IS NULL OR org_id = mandafy_current_org());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessions_tenant ON sessions;
CREATE POLICY sessions_tenant ON sessions FOR ALL
  USING (
    mandafy_current_org() IS NULL
    OR EXISTS (SELECT 1 FROM users u
               WHERE u.id = sessions.user_id AND u.org_id = mandafy_current_org())
  )
  WITH CHECK (
    mandafy_current_org() IS NULL
    OR EXISTS (SELECT 1 FROM users u
               WHERE u.id = sessions.user_id AND u.org_id = mandafy_current_org())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- leads: a regra que a spec exige explicitamente em §9.4 —
-- "consultor só enxerga os próprios leads, garantido no banco".
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_tenant ON leads;
CREATE POLICY leads_tenant ON leads FOR ALL
  USING (
    org_id = mandafy_current_org()
    AND (mandafy_is_admin() OR owner_id = mandafy_current_user())
  )
  WITH CHECK (
    org_id = mandafy_current_org()
    AND (mandafy_is_admin() OR owner_id = mandafy_current_user())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabelas filhas sem org_id: herdam a visibilidade do pai.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_activities_tenant ON lead_activities;
CREATE POLICY lead_activities_tenant ON lead_activities FOR ALL
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id))
  WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id));

ALTER TABLE message_variants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_variants_tenant ON message_variants;
CREATE POLICY message_variants_tenant ON message_variants FOR ALL
  USING (EXISTS (SELECT 1 FROM messages m WHERE m.id = message_variants.message_id))
  WITH CHECK (EXISTS (SELECT 1 FROM messages m WHERE m.id = message_variants.message_id));

ALTER TABLE flow_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_steps_tenant ON flow_steps;
CREATE POLICY flow_steps_tenant ON flow_steps FOR ALL
  USING (EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_steps.flow_id))
  WITH CHECK (EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_steps.flow_id));

ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_stages_tenant ON pipeline_stages;
CREATE POLICY pipeline_stages_tenant ON pipeline_stages FOR ALL
  USING (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id))
  WITH CHECK (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id));

-- events_raw guarda o payload cru antes de sabermos a organização; o vínculo é
-- pela origem. Sem origem conhecida, ninguém vê.
ALTER TABLE events_raw ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS events_raw_tenant ON events_raw;
CREATE POLICY events_raw_tenant ON events_raw FOR ALL
  USING (EXISTS (SELECT 1 FROM sources s WHERE s.id = events_raw.source_id))
  WITH CHECK (EXISTS (SELECT 1 FROM sources s WHERE s.id = events_raw.source_id));
