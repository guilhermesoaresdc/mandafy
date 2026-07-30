-- Busca de chave de API antes de existir contexto de tenant (§12.1).
--
-- O bug que isto conserta é fatal e só aparece com o RLS ligado: autenticar uma
-- chave de API significa DESCOBRIR a organização, então não há como definir
-- `app.org_id` antes da consulta. Com a política de tenant valendo, o
-- `SELECT ... WHERE key_hash = $1` não encontrava linha nenhuma — e toda a API
-- pública recusava toda chave válida com "credencial inválida".
--
-- A saída poderia ser o mesmo escape que `sessions` e `users` usam
-- (`mandafy_current_org() IS NULL OR ...`), mas ali o escape é largo: qualquer
-- consulta sem contexto lê a tabela inteira. Para credenciais isso é mais do
-- que o necessário.
--
-- Esta função é mais estreita: recebe o HASH e devolve no máximo uma linha, sem
-- o hash de volta. Quem não tem a chave em claro não consegue o hash, e sem o
-- hash não há o que buscar — a função não permite enumeração.

CREATE OR REPLACE FUNCTION mandafy_lookup_api_key(p_hash text)
RETURNS TABLE (id uuid, org_id uuid, scopes text[], revoked_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- `search_path` fixo: com SECURITY DEFINER, um search_path controlável pelo
-- chamador permitiria trocar `api_keys` por uma tabela plantada.
SET search_path = public, pg_temp
AS $fn$
  SELECT k.id, k.org_id, k.scopes, k.revoked_at
  FROM api_keys k
  WHERE k.key_hash = p_hash
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION mandafy_lookup_api_key(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT EXECUTE ON FUNCTION mandafy_lookup_api_key(text) TO mandafy_app;
  END IF;
END
$$;
