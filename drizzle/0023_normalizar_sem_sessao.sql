-- Normalizar o evento que chegou, sem sessão de usuário.
--
-- O SINTOMA
--
-- A plataforma manda o webhook, a rota responde 200, `events_raw` recebe a
-- linha — e nada mais acontece. A tela de conexão diz "recebido", o fluxo nunca
-- dispara, e não há erro em lugar nenhum para procurar.
--
-- A CAUSA, QUE É A MESMA DE SEMPRE NESTE PROJETO
--
-- Quem transforma `events_raw` em `events` roda FORA de qualquer sessão: é o
-- worker, ou a varredura de pendentes do batimento. Nenhum dos dois tem
-- `app.org_id`, e:
--
--   • `sources` tem política `org_id = mandafy_current_org()` — comparação com
--     nulo, nenhuma linha;
--   • `events_raw` herda dela: "a fonte precisa estar visível".
--
-- Então o SELECT do evento cru devolve ZERO LINHAS. O código conclui
-- `evento_cru_nao_encontrado` e desiste, ou nem chega lá: a varredura de
-- pendentes também lê `events_raw` e volta vazia, então acha que não há nada
-- para fazer. E o UPDATE que marcaria `processed_at` atualiza zero linhas em
-- silêncio, deixando o evento pendente para sempre.
--
-- É a terceira vez que este caminho é consertado no mesmo lugar: 0015 para o
-- descadastro, 0016 para a busca da fonte e a gravação do cru. Aqui é o passo
-- seguinte da mesma cadeia — quem GRAVOU já passa pela porta certa, quem LÊ
-- ainda não passava.
--
-- POR QUE FUNÇÃO E NÃO POLÍTICA PERMISSIVA
--
-- `events_raw` guarda payload de plataforma, que carrega telefone, e-mail e
-- CPF. Abrir a tabela para o papel da aplicação resolveria isto e abriria tudo
-- o mais. As funções abaixo devolvem só o necessário e são fechadas para o
-- público; quem as chama já está dentro do processo do servidor.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Os eventos que ainda não foram processados
-- ─────────────────────────────────────────────────────────────────────────────
-- Devolve o id e a organização juntos: quem chama precisa do org_id para abrir
-- o `withTenant` do resto do trabalho, e descobri-lo depois exigiria outra
-- consulta que esbarraria na mesma parede.
--
-- `error IS NULL` fica de fora do que é devolvido: evento recusado pelo
-- mapeamento já foi decidido, e retomá-lo faria a varredura girar em falso
-- sobre as mesmas linhas para sempre.
CREATE OR REPLACE FUNCTION mandafy_eventos_crus_pendentes(p_limite integer)
RETURNS TABLE (id bigint, org_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT e.id, s.org_id
  FROM events_raw e
  JOIN sources s ON s.id = e.source_id
  WHERE e.processed_at IS NULL
    AND e.error IS NULL
  ORDER BY e.received_at
  LIMIT greatest(1, least(p_limite, 500));
$fn$;

REVOKE ALL ON FUNCTION mandafy_eventos_crus_pendentes(integer) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Um evento cru com a sua fonte
-- ─────────────────────────────────────────────────────────────────────────────
-- As duas leituras numa chamada só porque as duas esbarravam na mesma parede, e
-- porque separá-las abriria a janela em que a fonte é removida entre uma e
-- outra.
CREATE OR REPLACE FUNCTION mandafy_evento_cru(p_id bigint)
RETURNS TABLE (
  id           bigint,
  source_id    uuid,
  org_id       uuid,
  mapping      jsonb,
  payload      jsonb,
  received_at  timestamptz,
  processed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT e.id, e.source_id, s.org_id, s.mapping, e.payload, e.received_at, e.processed_at
  FROM events_raw e
  JOIN sources s ON s.id = e.source_id
  WHERE e.id = p_id
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION mandafy_evento_cru(bigint) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Marcar como processado
-- ─────────────────────────────────────────────────────────────────────────────
-- O UPDATE mais importante do caminho, e o que falhava mais calado: sem ele o
-- evento continua pendente, a varredura o pega de novo na passagem seguinte, e
-- o fluxo dispara outra vez. Mensagem repetida para o mesmo cliente, sem nada
-- na tela sugerindo o porquê.
CREATE OR REPLACE FUNCTION mandafy_marcar_evento_cru(p_id bigint, p_erro text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  UPDATE events_raw
  SET processed_at = now(), error = p_erro
  WHERE id = p_id
  RETURNING true;
$fn$;

REVOKE ALL ON FUNCTION mandafy_marcar_evento_cru(bigint, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT EXECUTE ON FUNCTION mandafy_eventos_crus_pendentes(integer) TO mandafy_app;
    GRANT EXECUTE ON FUNCTION mandafy_evento_cru(bigint) TO mandafy_app;
    GRANT EXECUTE ON FUNCTION mandafy_marcar_evento_cru(bigint, text) TO mandafy_app;
  END IF;
END
$$;
