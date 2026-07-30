-- Descadastro em um clique, sem sessão (§14.1).
--
-- Mesmo problema de 0014, com consequência pior. O link do rodapé do e-mail
-- chega sem cookie e sem contexto de tenant: quem clica pode nunca ter entrado
-- no painel, e o `List-Unsubscribe-Post` do Gmail nem cookie manda. Com a
-- política de tenant valendo, o `SELECT org_id FROM contacts WHERE id = $1` não
-- encontrava nada — e a página respondia "Pronto, você não recebe mais nossas
-- mensagens" sem ter descadastrado ninguém.
--
-- Mentir para quem pediu para sair é pior do que falhar: a pessoa acredita que
-- resolveu, continua recebendo, e a próxima mensagem vira reclamação — quando
-- não vira processo.
--
-- A função devolve SÓ a organização, a partir do id do contato. Esse id é um
-- UUID v4: 122 bits de aleatoriedade, não se adivinha. E o pior que alguém faz
-- com um id acertado é descadastrar a pessoa — exatamente o que ela pode pedir
-- a qualquer momento.

CREATE OR REPLACE FUNCTION mandafy_org_do_contato(p_contact_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT c.org_id FROM contacts c WHERE c.id = p_contact_id;
$fn$;

REVOKE ALL ON FUNCTION mandafy_org_do_contato(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT EXECUTE ON FUNCTION mandafy_org_do_contato(uuid) TO mandafy_app;
  END IF;
END
$$;
