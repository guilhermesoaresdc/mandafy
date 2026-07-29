-- Corrige o caminho de autenticação sob RLS.
--
-- SINTOMA: laço infinito de redirecionamento depois do login. O cookie era
-- criado, /painel não conseguia validar a sessão, redirecionava para /entrar,
-- e o middleware — que só olha a presença do cookie — devolvia para /painel.
--
-- CAUSA: `validateSessionToken` junta sessions → users → organizations. As duas
-- primeiras têm a saída `mandafy_current_org() IS NULL`, que é o que permite
-- lê-las ANTES de existir contexto de tenant. `organizations` ficou sem ela em
-- 0010: sem contexto, `id = mandafy_current_org()` compara com NULL e resulta
-- em nulo — nunca verdadeiro. A linha some, o inner join não devolve nada, e
-- toda sessão válida é tratada como inválida.
--
-- Por que a saída é aceitável aqui: sem contexto de tenant, `organizations`
-- expõe apenas nome, slug e fuso horário. É estritamente menos sensível do que
-- `users`, que já tinha a mesma permissão desde 0010 — e é a única forma de o
-- login funcionar sem conceder BYPASSRLS ao papel da aplicação.
--
-- O isolamento real continua intacto: assim que `withTenant()` define
-- app.org_id, a condição volta a valer e nenhuma organização vê a outra.

DROP POLICY IF EXISTS organizations_tenant ON organizations;
CREATE POLICY organizations_tenant ON organizations FOR ALL
  USING (mandafy_current_org() IS NULL OR id = mandafy_current_org())
  WITH CHECK (mandafy_current_org() IS NULL OR id = mandafy_current_org());
