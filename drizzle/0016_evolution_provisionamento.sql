-- Provisionar instância de WhatsApp de dentro do painel (§7.3, §8.2).
--
-- Duas mudanças, cada uma consertando um problema concreto.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Quem criou a instância
-- ─────────────────────────────────────────────────────────────────────────────
-- O Mandafy passa a criar instâncias na Evolution, mas o servidor pode ser
-- COMPARTILHADO com outro sistema — é o caso de quem já roda uma Evolution para
-- outra operação. Duas origens possíveis para uma linha aqui:
--
--   managed = true   o Mandafy criou a instância. Remover aqui pode (e deve)
--                    apagá-la lá também.
--   managed = false  alguém colou as credenciais de uma instância que já
--                    existia. Remover aqui apaga só a linha — mexer na
--                    instância derrubaria o WhatsApp do outro sistema.
--
-- Sem essa distinção, o botão "remover" seria uma roleta: às vezes limpa o
-- próprio chip, às vezes desconecta a operação do vizinho.
ALTER TABLE wa_instances
  ADD COLUMN IF NOT EXISTS managed boolean NOT NULL DEFAULT false;

-- Instâncias que já existiam foram cadastradas à mão, coladas de fora.
UPDATE wa_instances SET managed = false WHERE managed IS DISTINCT FROM false;

COMMENT ON COLUMN wa_instances.managed IS
  'true = criada pelo Mandafy na Evolution; false = credenciais coladas de uma instância externa. Só as managed podem ser apagadas do servidor.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Token do webhook de retorno
-- ─────────────────────────────────────────────────────────────────────────────
-- A Evolution NÃO assina as chamadas que faz ao nosso webhook — conferido no
-- código dela (webhook.controller.ts): o corpo leva `apikey`, mas nada de HMAC.
-- Autenticar por um campo do corpo seria confiar em quem está falando.
--
-- Então o segredo vai na URL, como já acontece na ingestão das plataformas
-- (§4.3): cada instância recebe seu próprio token, e o endereço registrado na
-- Evolution é /api/evolution/{token}. Assim o retorno identifica a instância
-- sem depender do conteúdo, e vazar o endereço de um chip não expõe os outros.
ALTER TABLE wa_instances
  ADD COLUMN IF NOT EXISTS webhook_token text;

CREATE UNIQUE INDEX IF NOT EXISTS wa_instances_webhook_token_uq
  ON wa_instances (webhook_token) WHERE webhook_token IS NOT NULL;

COMMENT ON COLUMN wa_instances.webhook_token IS
  'Segredo na URL do webhook de retorno. A Evolution não assina as chamadas.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Índice para casar o retorno do provedor
-- ─────────────────────────────────────────────────────────────────────────────
-- Os webhooks de retorno da Evolution (MESSAGES_UPDATE) chegam identificando a
-- mensagem pelo id DELA, e o caminho é `provider_message_id = $1`. Sem índice,
-- cada confirmação de entrega vira varredura sequencial nas partições de
-- `notifications` — a tabela de maior escrita do sistema — e chega uma ou mais
-- por mensagem enviada. Numa operação com volume, o retorno de entrega
-- derrubaria o banco antes do envio.
--
-- Parcial: a esmagadora maioria das linhas tem `provider_message_id` nulo
-- (agendadas, puladas, canceladas) e não precisa entrar no índice.
CREATE INDEX IF NOT EXISTS notifications_provider_msg_idx
  ON notifications (provider_message_id, created_at DESC)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_archive_provider_msg_idx
  ON notifications_archive (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Achar a instância pelo token do webhook, sem contexto de tenant
-- ─────────────────────────────────────────────────────────────────────────────
-- A Evolution chama de fora, sem cookie e sem saber o que é uma organização.
-- Com a política de tenant valendo, `SELECT ... WHERE webhook_token = $1`
-- compara `org_id` com NULL e não devolve linha nenhuma — o retorno seria
-- descartado em silêncio, e o histórico pararia em "enviado" para sempre.
--
-- Mesma saída de 0014 e 0015: função SECURITY DEFINER estreita, que devolve só
-- o necessário para localizar a instância. O token é 24 bytes aleatórios.
CREATE OR REPLACE FUNCTION mandafy_instancia_por_token(p_token text)
RETURNS TABLE (id uuid, org_id uuid, instance_name text, managed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT w.id, w.org_id, w.instance_name, w.managed
  FROM wa_instances w
  WHERE w.webhook_token = p_token
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION mandafy_instancia_por_token(text) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. O MESMO defeito na ingestão das plataformas — e este derruba a fase 2
-- ─────────────────────────────────────────────────────────────────────────────
-- Encontrado ao montar o webhook acima, conferido contra o banco: a rota
-- `/in/{token}` (§4.3) busca `sources` por `ingest_token` sem contexto de
-- tenant, porque a plataforma que chama não tem sessão. Com RLS, a busca
-- devolve zero linhas e a rota responde 401 `token_invalido` para TODA chamada
-- legítima.
--
-- O efeito é o pior possível de diagnosticar: o painel funciona, a tela de
-- plataformas mostra o conector configurado, e nada nunca chega. Quem integra
-- vê 401 e conclui que copiou o token errado.
CREATE OR REPLACE FUNCTION mandafy_source_por_token(p_token text)
RETURNS TABLE (id uuid, org_id uuid, hmac_secret text, active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT s.id, s.org_id, s.hmac_secret, s.active
  FROM sources s
  WHERE s.ingest_token = p_token
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION mandafy_source_por_token(text) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. E gravar o payload cru, que esbarra na MESMA parede um nível abaixo
-- ─────────────────────────────────────────────────────────────────────────────
-- A política de `events_raw` é "a fonte precisa estar visível". Como `sources`
-- só é visível com contexto de tenant, achar o token não basta: o INSERT
-- seguinte era recusado do mesmo jeito. Consertar só a busca trocaria 401 por
-- 500 — de recusar tudo para engolir tudo.
--
-- Uma função só faz dedupe e gravação, e recebe o TOKEN em vez do id da fonte:
-- assim ela não pode ser usada para escrever na fonte de outra organização sem
-- conhecer o segredo dela.
--
-- De quebra, o dedupe passa a ser atômico. O caminho anterior era SELECT e
-- depois INSERT em chamadas separadas: dois retries simultâneos da plataforma
-- — que é exatamente quando o retry acontece — passavam os dois pelo SELECT e
-- gravavam o mesmo evento duas vezes. Duas mensagens para o mesmo cliente.
CREATE OR REPLACE FUNCTION mandafy_gravar_evento_cru(
  p_token        text,
  p_payload      jsonb,
  p_headers      jsonb,
  p_dedupe_hash  text,
  p_signature_ok boolean
)
RETURNS TABLE (id bigint, received_at timestamptz, duplicado boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_source_id uuid;
  v_id        bigint;
  v_em        timestamptz;
BEGIN
  SELECT s.id INTO v_source_id
  FROM sources s
  WHERE s.ingest_token = p_token AND s.active
  LIMIT 1;

  -- Token inválido ou conector desligado: nenhuma linha. Quem chama decide o
  -- que responder, e responde igual nos dois casos.
  IF v_source_id IS NULL THEN
    RETURN;
  END IF;

  SELECT r.id, r.received_at INTO v_id, v_em
  FROM events_raw r
  WHERE r.dedupe_hash = p_dedupe_hash
    AND r.received_at > now() - interval '24 hours'
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_em, true;
    RETURN;
  END IF;

  INSERT INTO events_raw (source_id, payload, headers, dedupe_hash, signature_ok)
  VALUES (v_source_id, p_payload, p_headers, p_dedupe_hash, p_signature_ok)
  RETURNING events_raw.id, events_raw.received_at INTO v_id, v_em;

  RETURN QUERY SELECT v_id, v_em, false;
END
$fn$;

REVOKE ALL ON FUNCTION mandafy_gravar_evento_cru(text, jsonb, jsonb, text, boolean) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT EXECUTE ON FUNCTION mandafy_instancia_por_token(text) TO mandafy_app;
    GRANT EXECUTE ON FUNCTION mandafy_source_por_token(text) TO mandafy_app;
    GRANT EXECUTE ON FUNCTION mandafy_gravar_evento_cru(text, jsonb, jsonb, text, boolean)
      TO mandafy_app;
  END IF;
END
$$;
