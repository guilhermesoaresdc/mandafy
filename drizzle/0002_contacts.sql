-- Contatos, consentimento por canal e bloqueios (§3.3).
-- O consentimento é requisito de arquitetura, não seção jurídica decorativa (§14).

CREATE TABLE IF NOT EXISTS contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- id na plataforma de origem
  external_id       text,
  name              text,
  -- sempre normalizado para E.164: +5588999999999
  phone_e164        text,
  email             citext,
  telegram_chat_id  bigint,
  cpf               text,
  tags              text[] NOT NULL DEFAULT '{}',

  -- Consentimento por canal (LGPD — §14.1)
  optin_whatsapp    boolean NOT NULL DEFAULT true,
  optin_email       boolean NOT NULL DEFAULT true,
  optin_sms         boolean NOT NULL DEFAULT true,
  optin_telegram    boolean NOT NULL DEFAULT true,
  optin_source      text CHECK (optin_source IN ('checkout', 'import', 'api')),
  optin_at          timestamptz,
  -- IP no momento do consentimento, quando a plataforma informa (§14.1)
  optin_ip          inet,
  opted_out_at      timestamptz,
  optout_reason     text,

  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_event_at     timestamptz,
  total_orders      integer NOT NULL DEFAULT 0,
  total_paid_cents  bigint NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Um contato por telefone e por e-mail dentro da organização. Parciais porque
-- um contato pode ter só um dos dois.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_phone_uq
  ON contacts (org_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_email_uq
  ON contacts (org_id, email) WHERE email IS NOT NULL;
-- Permite o upsert vindo da plataforma sem depender de telefone/e-mail.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_external_uq
  ON contacts (org_id, external_id) WHERE external_id IS NOT NULL;

-- Busca instantânea em 50 mil leads, alvo <100ms (§9.1, §13.2).
CREATE INDEX IF NOT EXISTS contacts_name_trgm_idx
  ON contacts USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contacts_org_last_event_idx
  ON contacts (org_id, last_event_at DESC);
CREATE INDEX IF NOT EXISTS contacts_tags_idx
  ON contacts USING gin (tags);

-- Bloqueio granular por canal: bounce de e-mail, número inexistente no
-- WhatsApp, resposta "SAIR" (§3.3, §5.3 regra 2).
CREATE TABLE IF NOT EXISTS suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'email', 'sms', 'telegram')),
  reason      text NOT NULL CHECK (reason IN ('hard_bounce', 'invalid', 'optout', 'complaint')),
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A regra de guarda 2 consulta por contato+canal. Único torna a checagem
-- barata e a criação idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_contact_channel_uq
  ON suppressions (contact_id, channel);
CREATE INDEX IF NOT EXISTS suppressions_org_idx ON suppressions (org_id);
