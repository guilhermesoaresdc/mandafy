-- Extensões exigidas pelo schema.
--
-- citext    → e-mail sem distinção de caixa (§3.1, §3.3)
-- pg_trgm   → busca instantânea em 50 mil leads, alvo <100ms (§9.1, §13.2)
-- pgcrypto  → gen_random_uuid()
-- btree_gin → índices compostos GIN (tags + org_id)

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gin;
