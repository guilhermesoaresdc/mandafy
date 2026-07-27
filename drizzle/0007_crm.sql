-- CRM: pipelines, etapas, leads e atividades (§3.7, §9).

CREATE TABLE IF NOT EXISTS pipelines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pipelines_one_default_uq
  ON pipelines (org_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id  uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name         text NOT NULL,
  position     integer NOT NULL,
  color        text,
  probability  integer CHECK (probability BETWEEN 0 AND 100),
  is_won       boolean NOT NULL DEFAULT false,
  is_lost      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_position_uq
  ON pipeline_stages (pipeline_id, position);

CREATE TABLE IF NOT EXISTS leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- consultor responsável — é a base do RBAC de §9.4
  owner_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  pipeline_id        uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  stage_id           uuid NOT NULL REFERENCES pipeline_stages(id) ON DELETE RESTRICT,
  title              text NOT NULL,
  value_cents        bigint NOT NULL DEFAULT 0,
  -- 'evento:order.created' | 'manual' | 'api'
  source             text NOT NULL DEFAULT 'manual',
  status             text NOT NULL DEFAULT 'aberto'
                     CHECK (status IN ('aberto', 'ganho', 'perdido')),
  lost_reason        text,
  next_action_at     timestamptz,
  stage_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_org_owner_stage_idx
  ON leads (org_id, owner_id, stage_id);
CREATE INDEX IF NOT EXISTS leads_next_action_idx
  ON leads (org_id, next_action_at) WHERE status = 'aberto';
CREATE INDEX IF NOT EXISTS leads_contact_idx ON leads (contact_id);
-- Busca por título na tabela virtualizada de leads (§9.1).
CREATE INDEX IF NOT EXISTS leads_title_trgm_idx
  ON leads USING gin (title gin_trgm_ops);

CREATE TABLE IF NOT EXISTS lead_activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  type        text NOT NULL
              CHECK (type IN ('nota', 'ligacao', 'mudanca_etapa', 'mensagem')),
  content     text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A linha do tempo do lead é lida em ordem cronológica reversa (§9.1).
CREATE INDEX IF NOT EXISTS lead_activities_lead_idx
  ON lead_activities (lead_id, created_at DESC);
