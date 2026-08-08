-- O cartão "Hoje" contava em dois calendários ao mesmo tempo (§10.2).
--
-- O QUE APARECIA NA TELA
--
-- Às 22h de um sábado de sorteio, sob um cabeçalho que diz textualmente "do
-- 00h de Brasília até agora":
--
--   Comprado           R$ 12.400      ← o dia inteiro, em Brasília
--   Mensagens enviadas 7              ← uma hora, em UTC
--
-- `movimentoDoDia` agrupa em `AT TIME ZONE 'America/Sao_Paulo'` e casa com
-- `diaLocal`. `metricasDoPainel` usava `diaUtc`. Os dois são renderizados lado
-- a lado, no mesmo cartão, como se falassem do mesmo período — e entre 21h e
-- 00h de Brasília (00h e 03h em UTC) o segundo recomeça do zero enquanto o
-- primeiro continua somando. Três horas por dia, todo dia, o painel se
-- contradizia; e é justamente a faixa de horário em que uma banca de sorteio
-- está mais movimentada.
--
-- POR QUE A MIGRATION É OBRIGATÓRIA
--
-- `notification_daily_stats.day` é preenchida por esta função com
-- `(n.created_at AT TIME ZONE 'UTC')::date`. Mexer só no TypeScript — trocar
-- `diaUtc` por `diaLocal` na consulta — faria a tela pedir o balde
-- `2026-08-09` enquanto o agregado guardou aquelas linhas em `2026-08-08`.
-- O painel passaria a mostrar ZERO nas mesmas três horas, o que é pior que
-- mostrar um número discordante: um número errado se percebe, um zero parece
-- uma noite parada.
--
-- O FUSO É FIXO NA FUNÇÃO, E ISSO É UMA DÍVIDA CONHECIDA
--
-- `organizations.timezone` existe, e o certo seria agrupar por ele. Mas a
-- função agrega a tabela inteira de uma vez, sem juntar com `organizations`, e
-- fazer isso aqui trocaria uma varredura por um join a cada consolidação
-- horária. Enquanto todas as bancas operam no mesmo fuso, `America/Sao_Paulo`
-- literal entrega o resultado certo pelo preço certo. Quando a primeira banca
-- de outro fuso entrar, este é o lugar de consertar — e o comentário está aqui
-- para que se saiba onde.
--
-- REPROCESSAR OS DIAS JÁ AGREGADOS
--
-- Sem isso, as linhas gravadas com o balde antigo continuariam lá, e a tela
-- leria dias errados até que o tempo os tirasse da janela. A função já é
-- `ON CONFLICT … DO UPDATE`, então rodá-la de novo reescreve.
CREATE OR REPLACE FUNCTION mandafy_aggregate_notifications(days_back integer DEFAULT 4)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  touched bigint;
BEGIN
  INSERT INTO notification_daily_stats (org_id, day, channel, status, flow_id, total)
  SELECT
    n.org_id,
    -- O dia de quem opera, e não o do servidor. Mesma expressão de
    -- `movimentoDoDia`, para que as duas metades do cartão "Hoje" contem a
    -- mesma coisa.
    (n.created_at AT TIME ZONE 'America/Sao_Paulo')::date,
    n.channel,
    n.status,
    COALESCE(n.flow_id, '00000000-0000-0000-0000-000000000000'::uuid),
    count(*)
  FROM notifications n
  WHERE n.created_at >= current_date - days_back
  GROUP BY 1, 2, 3, 4, 5
  ON CONFLICT (org_id, day, channel, status, flow_id)
  DO UPDATE SET total = EXCLUDED.total;

  GET DIAGNOSTICS touched = ROW_COUNT;
  RETURN touched;
END;
$fn$;

/*
 * Os baldes antigos saem antes de os novos entrarem.
 *
 * `ON CONFLICT DO UPDATE` reescreve o que colidir, e as linhas do balde UTC
 * que NÃO colidem com nenhum balde local sobreviveriam — somando duas vezes o
 * mesmo envio, uma em cada dia. Apagar a janela que vai ser reconstruída é o
 * único jeito de a soma fechar.
 */
DELETE FROM notification_daily_stats
WHERE day >= (current_date - 7);

SELECT mandafy_aggregate_notifications(7);
