-- Estado do sistema: memória entre execuções sem processo (§7.1, §10.2).
--
-- POR QUE
--
-- O worker é um processo que fica de pé, e por isso o BullMQ podia guardar
-- "toda hora no minuto 17" e "todo dia às 00:05" na própria fila. Um tick
-- disparado por HTTP não tem memória nenhuma: cada invocação nasce sem saber se
-- a manutenção já rodou nesta hora ou se os contadores diários já foram
-- zerados hoje.
--
-- Sem esse registro, das duas uma: ou a manutenção roda a cada tick — e
-- `mandafy_maintain_partitions()` mais a varredura de leads a cada minuto é
-- desperdício puro — ou não roda nunca, e aí `sent_today` cresce para sempre,
-- toda instância bate o teto no segundo dia e a operação para em silêncio.
--
-- Uma linha por tarefa. Sem org_id: são tarefas do sistema, não de tenant.

CREATE TABLE IF NOT EXISTS system_state (
  key        text PRIMARY KEY,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  detail     jsonb
);

COMMENT ON TABLE system_state IS
  'Quando cada tarefa periódica rodou pela última vez. Permite ao tick sem estado saber o que já foi feito.';

-- Sem RLS: a tabela não tem dado de tenant, e o tick roda sem contexto de
-- organização. Deixá-la fora da política é decisão explícita, não esquecimento.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON system_state TO mandafy_app;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Índice das retentativas
-- ─────────────────────────────────────────────────────────────────────────────
-- Sem worker, ninguém reprocessa o que falhou: o BullMQ é quem fazia as
-- retentativas, e uma notificação em `failed` ficava parada para sempre. O tick
-- passa a devolvê-las para a fila com espera crescente, e para isso precisa
-- encontrá-las — `status = 'failed'` numa tabela particionada por dia, sem
-- índice, é varredura de todas as partições a cada minuto.
--
-- Parcial porque `failed` é a minoria absoluta das linhas.
CREATE INDEX IF NOT EXISTS notifications_retry_idx
  ON notifications (attempted_at)
  WHERE status = 'failed';
