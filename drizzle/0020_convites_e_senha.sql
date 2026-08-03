-- Convite de equipe e recuperação de senha (§9.4, §14.1).
--
-- Quem entra no painel é criado por um administrador, nunca por cadastro
-- público: não existe tela de "criar conta". O administrador cadastra o e-mail,
-- a pessoa recebe um link e define a própria senha.
--
-- Essa escolha vale mais do que parece. Sem tela de cadastro, não há superfície
-- para alguém tentar criar acesso, não há confirmação de e-mail a validar, e a
-- lista de quem pode entrar é exatamente a lista de quem foi cadastrado.
--
-- O MESMO MECANISMO SERVE PARA "ESQUECI MINHA SENHA"
--
-- Convite e recuperação são a mesma coisa vista de dois lados: um link de uso
-- único que autoriza definir uma senha. Dois mecanismos separados dobrariam a
-- superfície de ataque e a chance de um deles envelhecer sem manutenção.

CREATE TABLE IF NOT EXISTS auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- sha256 do token em hex. O token cru só existe dentro do link enviado por
  -- e-mail — mesma decisão de `sessions`: quem ler o banco não consegue
  -- personificar ninguém nem definir a senha de outra pessoa.
  token_hash  text NOT NULL UNIQUE,

  purpose     text NOT NULL CHECK (purpose IN ('convite', 'recuperacao')),

  expires_at  timestamptz NOT NULL,
  -- Uso único: um link reaproveitado é um link que sobrevive ao encaminhamento
  -- do e-mail, ao histórico do navegador e ao vazamento de um print.
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_tokens_expira_idx ON auth_tokens (expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE auth_tokens IS
  'Links de uso único para definir senha: convite de equipe e recuperação. O token cru vive só no e-mail.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Sem RLS nesta tabela, e o motivo é explícito
-- ─────────────────────────────────────────────────────────────────────────────
-- Quem abre o link não tem sessão nem organização — é justamente alguém que
-- ainda não consegue entrar. Uma política de tenant aqui devolveria zero linhas
-- e o link nunca funcionaria, repetindo o defeito que 0014, 0015 e 0016
-- consertaram em outros caminhos sem sessão.
--
-- O que protege a tabela não é a política, é o formato: a busca só acontece por
-- `token_hash`, que é o sha256 de 32 bytes aleatórios. Não há coluna que
-- permita listar, varrer ou adivinhar — e as linhas não contêm dado pessoal,
-- só um id de usuário e um resumo criptográfico.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth_tokens TO mandafy_app;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Achar o dono do token, sem contexto de tenant
-- ─────────────────────────────────────────────────────────────────────────────
-- `users` já é legível sem contexto (0010, para o login funcionar), mas depende
-- de `mandafy_current_org() IS NULL`. Encapsular aqui deixa o caminho explícito
-- e devolve de uma vez o que a tela precisa, em vez de espalhar a exceção.
CREATE OR REPLACE FUNCTION mandafy_usuario_por_token(p_hash text)
RETURNS TABLE (
  token_id   uuid,
  user_id    uuid,
  org_id     uuid,
  nome       text,
  email      text,
  purpose    text,
  expires_at timestamptz,
  used_at    timestamptz,
  active     boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT t.id, u.id, u.org_id, u.name, u.email::text, t.purpose,
         t.expires_at, t.used_at, u.active
  FROM auth_tokens t
  JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = p_hash
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION mandafy_usuario_por_token(text) FROM PUBLIC;

-- Encontrar por e-mail para o "esqueci minha senha". Devolve só o id: quem
-- chama não tem sessão, e nada além disso é necessário para gerar o link.
CREATE OR REPLACE FUNCTION mandafy_usuario_por_email(p_email text)
RETURNS TABLE (user_id uuid, org_id uuid, nome text, active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT u.id, u.org_id, u.name, u.active
  FROM users u
  WHERE u.email = p_email::citext
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION mandafy_usuario_por_email(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT EXECUTE ON FUNCTION mandafy_usuario_por_token(text) TO mandafy_app;
    GRANT EXECUTE ON FUNCTION mandafy_usuario_por_email(text) TO mandafy_app;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Definir a senha também sem contexto de tenant
-- ─────────────────────────────────────────────────────────────────────────────
-- A escrita fecha o ciclo: sem ela, a busca funcionaria e o UPDATE seria
-- recusado — trocar 401 por 500, que foi exatamente o que aconteceu na
-- ingestão (0016). Marca o token como usado e grava a senha na mesma
-- transação, para que um link não possa ser gasto duas vezes.
CREATE OR REPLACE FUNCTION mandafy_definir_senha(p_hash text, p_password_hash text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_user_id uuid;
BEGIN
  -- `FOR UPDATE` fecha a corrida de dois cliques simultâneos no mesmo link.
  SELECT t.user_id INTO v_user_id
  FROM auth_tokens t
  JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = p_hash
    AND t.used_at IS NULL
    AND t.expires_at > now()
    -- Conta desligada não define senha, nem por link antigo.
    AND u.active
  FOR UPDATE OF t;

  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE auth_tokens SET used_at = now() WHERE token_hash = p_hash;

  /*
   * `active` NÃO é tocado aqui, e a distinção importa.
   *
   * São dois estados diferentes que seria fácil confundir num só:
   *
   *   password_hash = ''   convite ainda não aceito
   *   active = false       o administrador tirou o acesso
   *
   * Quem foi convidado nasce ATIVO e mesmo assim não entra, porque o hash
   * vazio não casa com senha nenhuma. Se definir senha ligasse `active`, um
   * link de convite antigo reativaria alguém que o administrador desligou —
   * exatamente a pessoa que não deveria voltar. Desativar revoga os links
   * abertos (ver equipe/actions.ts), e a leitura do token exige conta ativa.
   */
  UPDATE users
  SET password_hash = p_password_hash,
      updated_at = now()
  WHERE id = v_user_id;

  -- Toda sessão aberta cai. Se a troca aconteceu porque alguém entrou na
  -- conta, deixar as sessões dele vivas tornaria a troca inútil.
  DELETE FROM sessions WHERE user_id = v_user_id;

  -- Os outros links pendentes da mesma pessoa também morrem: pedir recuperação
  -- três vezes não pode deixar três chaves válidas circulando por e-mail.
  UPDATE auth_tokens
  SET used_at = now()
  WHERE user_id = v_user_id AND used_at IS NULL;

  RETURN v_user_id;
END
$fn$;

REVOKE ALL ON FUNCTION mandafy_definir_senha(text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT EXECUTE ON FUNCTION mandafy_definir_senha(text, text) TO mandafy_app;
  END IF;
END
$$;
