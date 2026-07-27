-- Perfis de ritmo, fluxos de cadência e seus passos (§3.5, §7.2).

-- A spec referencia flow_steps.jitter_profile_id (§3.5) e descreve os perfis
-- em §7.2, mas não modela a tabela. Aqui ela é criada.
-- Aplicável em três níveis: global → fluxo → passo. O mais específico vence.
CREATE TABLE IF NOT EXISTS jitter_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  mode         text NOT NULL
               CHECK (mode IN ('instantaneo', 'fixo', 'faixa', 'humano')),
  min_seconds  integer NOT NULL DEFAULT 0 CHECK (min_seconds >= 0),
  max_seconds  integer NOT NULL DEFAULT 0 CHECK (max_seconds >= 0),
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jitter_range_ok CHECK (max_seconds >= min_seconds)
);

CREATE UNIQUE INDEX IF NOT EXISTS jitter_profiles_org_name_uq
  ON jitter_profiles (org_id, name);
-- No máximo um perfil padrão por organização.
CREATE UNIQUE INDEX IF NOT EXISTS jitter_profiles_one_default_uq
  ON jitter_profiles (org_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS flows (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  trigger_event          text NOT NULL,
  entry_conditions       jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Cancelamento por chave — a lógica mais crítica do sistema (§5.1).
  -- cancel_on lista os eventos que cancelam; cancel_key_template gera a chave
  -- que amarra os envios agendados ao pedido: 'order:{{external_id}}'.
  cancel_on              text[] NOT NULL DEFAULT '{}',
  cancel_key_template    text,

  quiet_hours_enabled    boolean NOT NULL DEFAULT true,
  quiet_start            time NOT NULL DEFAULT '21:00',
  quiet_end              time NOT NULL DEFAULT '08:00',
  max_per_contact_per_day integer NOT NULL DEFAULT 4 CHECK (max_per_contact_per_day > 0),

  jitter_profile_id      uuid REFERENCES jitter_profiles(id) ON DELETE SET NULL,
  active                 boolean NOT NULL DEFAULT true,
  priority               integer NOT NULL DEFAULT 100,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flows_org_trigger_idx
  ON flows (org_id, trigger_event) WHERE active;
-- Lookup do cancelamento: dado um evento que chegou, quais fluxos cancela.
CREATE INDEX IF NOT EXISTS flows_cancel_on_idx
  ON flows USING gin (cancel_on);

CREATE TABLE IF NOT EXISTS flow_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id            uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  position           integer NOT NULL,
  -- Relativo ao passo anterior, não ao início do fluxo.
  delay_seconds      integer NOT NULL DEFAULT 0 CHECK (delay_seconds >= 0),
  jitter_profile_id  uuid REFERENCES jitter_profiles(id) ON DELETE SET NULL,
  message_id         uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  -- null = usa o `enabled` de cada variante do template
  channels_override  text[],
  conditions         jsonb NOT NULL DEFAULT '{}'::jsonb,
  stop_if            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS flow_steps_flow_position_uq
  ON flow_steps (flow_id, position);
