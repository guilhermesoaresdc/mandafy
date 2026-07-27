-- Núcleo: organizações, usuários, sessões e conectores (§3.1).
-- Multi-tenant desde o dia 1, mesmo com um único cliente.

CREATE TABLE IF NOT EXISTS organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  timezone    text NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name           text NOT NULL,
  -- citext: login não distingue caixa, e o índice único garante isso no banco.
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'consultor')),
  active         boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

-- O id é o sha256 do token em hex. O token cru existe só no cookie do navegador:
-- vazamento do banco não permite personificar sessão (§14.1).
CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  user_agent  text
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- Conectores: cada plataforma de sorteio plugada (§3.1, §4.2).
CREATE TABLE IF NOT EXISTS sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  platform      text NOT NULL DEFAULT 'generico'
                CHECK (platform IN ('generico', 'rifei', 'custom')),
  -- Vai na URL do webhook: POST /in/{ingest_token}
  ingest_token  text NOT NULL UNIQUE,
  -- Opcional: se a plataforma assinar o corpo, validamos HMAC (§4.3).
  hmac_secret   text,
  -- Mapeamento declarativo de payload → evento canônico (§4.2).
  mapping       jsonb NOT NULL DEFAULT '{}'::jsonb,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sources_org_idx ON sources (org_id);
