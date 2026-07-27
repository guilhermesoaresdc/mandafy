#!/bin/bash
# Executado UMA VEZ, na criação do volume do Postgres.
# Não cria tabelas: isso é responsabilidade das migrations (drizzle/*.sql).
set -euo pipefail

APP_PASSWORD="${POSTGRES_APP_PASSWORD:-mandafy_app}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Papel da aplicação. É com ele que o app e o worker se conectam, e é por
  -- NÃO ser dono das tabelas que o RLS se aplica a eles (drizzle/0010_rls.sql).
  -- Sem BYPASSRLS, sem SUPERUSER, sem CREATEDB: o mínimo para operar.
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandafy_app') THEN
      CREATE ROLE mandafy_app LOGIN PASSWORD '${APP_PASSWORD}';
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO mandafy_app;
  GRANT USAGE ON SCHEMA public TO mandafy_app;
EOSQL

# Banco próprio da Evolution API. Ela gerencia o schema dela sozinha; misturar
# com o nosso tornaria backup e migrations um problema.
if ! psql --username "$POSTGRES_USER" --dbname postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname = 'evolution'" | grep -q 1; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "CREATE DATABASE evolution"
fi

echo "init: papel mandafy_app e banco evolution prontos."
