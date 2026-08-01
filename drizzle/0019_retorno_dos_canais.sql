-- Retorno dos canais de e-mail, SMS e Telegram (§8.1, §8.3, §8.4, §8.5, §14.1).
--
-- O WhatsApp já tinha o caminho de volta (0016). Os outros três não tinham
-- nenhum: `delivered_at` nunca era preenchido fora do WhatsApp, bounce de
-- e-mail não virava supressão, e `/parar` no Telegram não descadastrava
-- ninguém. O primeiro é relatório errado; os outros dois são obrigação legal.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Token do webhook por canal
-- ─────────────────────────────────────────────────────────────────────────────
-- Mesma decisão de 0016, pelos mesmos motivos, agora por canal em vez de por
-- instância. Cada organização recebe um token por canal e registra
-- /api/retorno/{canal}/{token} no painel do provedor.
--
-- Por que na URL e não só por assinatura: dos três, apenas a Resend assina de
-- verdade (Svix). O SMSDev entrega a DLR num GET sem segredo nenhum, e o
-- Telegram oferece um header de segredo que é, ele próprio, um token fixo. Um
-- caminho único que sempre autentica é melhor que três caminhos com garantias
-- diferentes — e onde existe assinatura, ela é conferida POR CIMA do token.
--
-- Um token por canal, e não um por organização: vazar o endereço que está
-- colado no painel do SMSDev não pode entregar o webhook de e-mail junto.
ALTER TABLE channel_configs
  ADD COLUMN IF NOT EXISTS webhook_token text;

CREATE UNIQUE INDEX IF NOT EXISTS channel_configs_webhook_token_uq
  ON channel_configs (webhook_token) WHERE webhook_token IS NOT NULL;

COMMENT ON COLUMN channel_configs.webhook_token IS
  'Segredo na URL do webhook de retorno do provedor. Um por canal, por organização.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Achar o canal pelo token, sem contexto de tenant
-- ─────────────────────────────────────────────────────────────────────────────
-- O provedor chama de fora, sem cookie. Com a política de tenant valendo,
-- `SELECT ... WHERE webhook_token = $1` compara org_id com NULL e devolve zero
-- linhas — o retorno seria descartado em silêncio. É exatamente o defeito que
-- 0016 consertou na ingestão, e que se repetiria aqui.
--
-- Devolve as credenciais cifradas junto porque a Resend assina com um segredo
-- que mora nelas: buscar em duas etapas exigiria uma segunda função com o
-- mesmo poder, sem ganho nenhum.
CREATE OR REPLACE FUNCTION mandafy_canal_por_token(p_token text)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  channel text,
  provider text,
  credentials_encrypted bytea,
  active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT c.id, c.org_id, c.channel, c.provider, c.credentials_encrypted, c.active
  FROM channel_configs c
  WHERE c.webhook_token = p_token
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION mandafy_canal_por_token(text) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Achar o contato pelo chat do Telegram
-- ─────────────────────────────────────────────────────────────────────────────
-- Toda mensagem recebida no bot chega identificada pelo chat_id, e o caminho é
-- `telegram_chat_id = $1` para saber de quem se trata. Sem índice, cada `/parar`
-- e cada resposta varre a tabela inteira de contatos — que é a maior do CRM.
--
-- Parcial: a maioria dos contatos nunca falou com o bot e tem a coluna nula.
CREATE INDEX IF NOT EXISTS contacts_telegram_chat_idx
  ON contacts (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT EXECUTE ON FUNCTION mandafy_canal_por_token(text) TO mandafy_app;
  END IF;
END
$$;
