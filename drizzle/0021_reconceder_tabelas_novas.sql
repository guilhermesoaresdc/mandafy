-- Reconceder acesso às tabelas criadas depois de 0012.
--
-- SINTOMA, encontrado em produção: o batimento respondendo 500 com
-- `permission denied for table system_state` (SQLSTATE 42501). O SELECT
-- passava e o INSERT não — leitura concedida, escrita não.
--
-- CAUSA: 0012 concedeu sobre ALL TABLES e definiu privilégios padrão, mas
-- `ALTER DEFAULT PRIVILEGES` só alcança objetos criados PELO PAPEL que o
-- definiu. Toda tabela nascida depois — `system_state` (0017), `auth_tokens`
-- (0020) — depende do bloco condicional da própria migration, e basta ele
-- rodar num ambiente onde o papel ainda não existe, ou onde quem migra difere
-- de quem definiu o padrão, para a concessão passar em branco.
--
-- O LAÇO QUE ISSO CRIOU
--
-- Quem reconcede é `mandafy_grant_app_role()`, chamada ao final de
-- `mandafy_maintain_partitions()`. E a manutenção horária, que a executa,
-- rodava DEPOIS da zeragem diária — que era justamente a que falhava por falta
-- de permissão. A rotina que consertaria só rodava depois da que quebrava,
-- então nunca rodava. O sistema ficou preso.
--
-- O código foi arrumado para as tarefas não dependerem uma da outra (ver
-- src/app/api/cron/route.ts). Esta migration fecha o outro lado: reconcede
-- agora, em vez de esperar o primeiro ciclo de manutenção bem-sucedido.

SELECT mandafy_grant_app_role();

-- Explícito para as duas tabelas do episódio. `mandafy_grant_app_role()` já as
-- cobre, mas repetir aqui deixa o conserto legível para quem vier ler esta
-- migration procurando por elas pelo nome.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON system_state TO mandafy_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth_tokens  TO mandafy_app;
  END IF;
END
$$;
