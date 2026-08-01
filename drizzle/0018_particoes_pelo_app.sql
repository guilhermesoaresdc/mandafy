-- A manutenção de partições precisa rodar pelo papel da aplicação (§10.2).
--
-- SINTOMA: `SELECT mandafy_maintain_partitions()` estoura com
-- "must be owner of table notifications_2026_07_26" quando quem chama é
-- `mandafy_app`. Criar partição exige CREATE no schema; apagar exige ser dono
-- da tabela. O papel da aplicação não tem nenhum dos dois — de propósito.
--
-- QUEM CHAMA: o job horário do worker, e agora também o batimento por HTTP.
-- Os dois conectam com DATABASE_URL, que é o papel da aplicação. Ou seja: a
-- manutenção vinha falhando INTEIRA a cada hora em qualquer instalação com a
-- separação de papéis montada. E como a chamada de partições é a primeira do
-- job, o erro derrubava tudo o que vinha depois — expurgo de sessões, retomada
-- de eventos crus, avanço da escada de aquecimento, varredura de leads.
--
-- Num Postgres onde a aplicação é dona das tabelas (Supabase sem o papel
-- separado) isso funcionava por acidente. O mesmo acidente que deixa o RLS
-- decorativo — e é justamente quem faz a coisa CERTA que era punido.
--
-- CORREÇÃO: as três funções passam a rodar com os privilégios de quem as
-- criou, como já acontece com as buscas por token (0014, 0015, 0016). O que
-- elas fazem é fechado e não recebe nome de tabela por parâmetro: só criam e
-- apagam partições das tabelas que o próprio corpo nomeia, dentro das janelas
-- de retenção de §14.1. Não há como usá-las para tocar outra coisa.
--
-- `search_path` fixo em cada uma: sem isso, um schema no caminho de busca do
-- chamador poderia oferecer uma função com nome igual ao de uma chamada
-- interna, e ela rodaria como dono.

ALTER FUNCTION mandafy_ensure_partitions(integer)
  SECURITY DEFINER SET search_path = public, pg_temp;

ALTER FUNCTION mandafy_drop_old_partitions(integer, integer, integer)
  SECURITY DEFINER SET search_path = public, pg_temp;

ALTER FUNCTION mandafy_maintain_partitions()
  SECURITY DEFINER SET search_path = public, pg_temp;

-- SECURITY DEFINER sem revogar o acesso público é uma escalada de privilégio
-- aberta: qualquer papel do banco poderia apagar partições.
REVOKE ALL ON FUNCTION mandafy_ensure_partitions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION mandafy_drop_old_partitions(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION mandafy_maintain_partitions() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    -- Só a de cima. As outras duas são detalhe interno e continuam
    -- inalcançáveis de fora, mesmo agora que rodam como dono.
    GRANT EXECUTE ON FUNCTION mandafy_maintain_partitions() TO mandafy_app;
  END IF;
END
$$;
