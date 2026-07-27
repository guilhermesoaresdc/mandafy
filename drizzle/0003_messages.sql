-- Mensagens e variantes por canal (§3.4).
-- O coração do "uma fonte, quatro saídas" (§6).

CREATE TABLE IF NOT EXISTS messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- identificador estável usado pela API pública: 'pix_lembrete_1'
  key          text NOT NULL,
  name         text NOT NULL,
  -- A categoria define a base legal do envio (§14.1): promocional exige optin.
  category     text NOT NULL DEFAULT 'relacionamento'
               CHECK (category IN ('transacional', 'recuperacao', 'relacionamento')),
  description  text,
  -- Corpo canônico em Markdown reduzido (§6.2). É dele que nascem as variantes.
  body         text NOT NULL DEFAULT '',
  -- Transacional crítico pode furar a janela de silêncio (§7.4).
  ignore_quiet_hours boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_org_key_uq ON messages (org_id, key);
CREATE INDEX IF NOT EXISTS messages_org_idx ON messages (org_id);

-- Uma variante por canal. Padrão: todas habilitadas.
CREATE TABLE IF NOT EXISTS message_variants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('whatsapp', 'email', 'sms', 'telegram')),
  -- É o pad que liga/desliga na interface (§11.4).
  enabled       boolean NOT NULL DEFAULT true,

  -- O selo `sincronizado` / `customizado` de §6.1. A spec descreve o
  -- comportamento mas não modela a coluna: sem ela não há como saber se a
  -- variante ainda recebe propagação do corpo principal.
  synced        boolean NOT NULL DEFAULT true,

  subject       text,          -- e-mail
  preheader     text,          -- e-mail
  body          text,          -- fonte da variante, em formato Mandafy (§6.2)
  html          text,          -- e-mail: HTML compilado
  text_body     text,          -- e-mail: versão texto puro, exigida para entregabilidade (§8.3)
  parse_mode    text CHECK (parse_mode IN ('HTML', 'MarkdownV2')),  -- telegram
  buttons       jsonb,         -- telegram: inline keyboard
  media_url     text,
  link_shorten  boolean NOT NULL DEFAULT true,   -- sms: encurtar link (§6.4)
  strip_accents boolean NOT NULL DEFAULT false,  -- sms: "olá" → "ola" (§6.4)

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS message_variants_message_channel_uq
  ON message_variants (message_id, channel);
