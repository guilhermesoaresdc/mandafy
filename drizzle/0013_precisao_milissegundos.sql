-- Precisão de milissegundo nas colunas de partição.
--
-- O bug que isto conserta é sério e silencioso. O Postgres guarda `timestamptz`
-- com precisão de MICROSSEGUNDO; o `Date` do JavaScript só tem MILISSEGUNDO.
-- Uma linha inserida com `DEFAULT now()` fica com `21:00:54.641730+00`, e o
-- driver entrega ao JS `21:00:54.641`. Toda consulta seguinte feita com esse
-- valor — e a chave primária destas tabelas é composta pela coluna de partição,
-- então TODA consulta por linha usa esse valor — casa com zero linhas.
--
-- Na prática significava: nenhum envio conseguia gravar o próprio resultado,
-- `queue_job_id` nunca era persistido, e o cancelamento por chave não removia
-- os jobs do BullMQ.
--
-- Não dá para resolver mudando o tipo para `timestamptz(3)`: o Postgres recusa
-- alterar o tipo de uma coluna que faz parte da chave de partição. A correção é
-- truncar na origem, no DEFAULT — assim vale para todo caminho de inserção,
-- inclusive SQL cru, seed e qualquer código futuro que esqueça do assunto.

ALTER TABLE events_raw    ALTER COLUMN received_at SET DEFAULT date_trunc('milliseconds', now());
ALTER TABLE events        ALTER COLUMN occurred_at SET DEFAULT date_trunc('milliseconds', now());
ALTER TABLE notifications ALTER COLUMN created_at  SET DEFAULT date_trunc('milliseconds', now());

-- Linhas que já existem com microssegundos continuariam inalcançáveis.
-- Truncar não muda o dia, então nenhuma linha troca de partição.
UPDATE events_raw    SET received_at = date_trunc('milliseconds', received_at)
  WHERE received_at <> date_trunc('milliseconds', received_at);
UPDATE events        SET occurred_at = date_trunc('milliseconds', occurred_at)
  WHERE occurred_at <> date_trunc('milliseconds', occurred_at);
UPDATE notifications SET created_at  = date_trunc('milliseconds', created_at)
  WHERE created_at  <> date_trunc('milliseconds', created_at);

-- As partições criadas daqui em diante herdam o DEFAULT da tabela-mãe
-- automaticamente, então `mandafy_maintain_partitions()` não precisa mudar.
