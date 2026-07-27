-- Fila e log de notificações (§3.6). Partição diária, retenção 3 dias quentes.
--
-- Sem chaves estrangeiras para contacts/messages/flows de propósito: esta é a
-- tabela de maior volume de escrita do sistema e cada FK custa uma verificação
-- por linha inserida. O vínculo é lógico; a integridade que importa (o tenant)
-- é garantida pela FK de org_id e pelo RLS.

CREATE TABLE IF NOT EXISTS notifications (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),

  contact_id           uuid,
  message_id           uuid,
  variant_id           uuid,
  flow_id              uuid,
  step_id              uuid,
  event_id             bigint,
  channel              text NOT NULL
                       CHECK (channel IN ('whatsapp', 'email', 'sms', 'telegram')),

  -- Máquina de estados de §8.1.
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'scheduled', 'sending', 'sent',
                                         'delivered', 'read', 'failed', 'dead',
                                         'cancelled', 'skipped')),
  scheduled_for        timestamptz,
  attempted_at         timestamptz,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,

  provider             text,
  provider_message_id  text,
  -- qual número/instância enviou (§7.3)
  provider_instance    text,

  -- Exatamente o que foi enviado, para auditoria (§6.5).
  rendered_subject     text,
  rendered_body        text,

  attempts             smallint NOT NULL DEFAULT 0,
  error_code           text,
  error_message        text,

  -- 'order:12345' — permite cancelar em lote quando o pagamento chega (§5.1).
  cancel_key           text,
  -- evita duplicata do mesmo passo para o mesmo contato
  dedupe_key           text,
  queue_job_id         text,

  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS notifications_org_created_idx
  ON notifications (org_id, created_at DESC);

-- O índice do cancelamento por chave. Parcial: só interessa o que ainda não saiu.
CREATE INDEX IF NOT EXISTS notifications_cancel_key_idx
  ON notifications (cancel_key)
  WHERE status IN ('queued', 'scheduled');

CREATE INDEX IF NOT EXISTS notifications_channel_status_idx
  ON notifications (channel, status, created_at DESC);

-- Próximos envios agendados: alimenta a barra de pulso (§11.6) e o painel.
CREATE INDEX IF NOT EXISTS notifications_scheduled_idx
  ON notifications (scheduled_for)
  WHERE status IN ('queued', 'scheduled');

CREATE INDEX IF NOT EXISTS notifications_contact_idx
  ON notifications (contact_id, created_at DESC);

-- §3.6 pede um índice único em dedupe_key. Numa tabela particionada o índice
-- único precisa conter a coluna de partição, então a unicidade é por dia.
-- Na prática isso é suficiente: o dedupe protege contra reenfileiramento do
-- mesmo passo, que acontece em minutos, nunca atravessando dias.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uq
  ON notifications (dedupe_key, created_at)
  WHERE dedupe_key IS NOT NULL;

-- Camada morna: 30 dias, sem partição, consulta em 1–3s (§10.2).
-- Mesmo formato da quente para que o arquivamento seja um INSERT … SELECT.
CREATE TABLE IF NOT EXISTS notifications_archive (
  id                   uuid NOT NULL,
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL,
  contact_id           uuid,
  message_id           uuid,
  variant_id           uuid,
  flow_id              uuid,
  step_id              uuid,
  event_id             bigint,
  channel              text NOT NULL,
  status               text NOT NULL,
  scheduled_for        timestamptz,
  attempted_at         timestamptz,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  provider             text,
  provider_message_id  text,
  provider_instance    text,
  rendered_subject     text,
  rendered_body        text,
  attempts             smallint NOT NULL DEFAULT 0,
  error_code           text,
  error_message        text,
  cancel_key           text,
  dedupe_key           text,
  queue_job_id         text,
  archived_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
);

CREATE INDEX IF NOT EXISTS notifications_archive_org_created_idx
  ON notifications_archive (org_id, created_at DESC);

-- Camada fria: 12 meses de agregados anônimos (§10.2). Também alimenta os
-- contadores do painel sem COUNT(*) em tabela grande (§13.2).
-- flow_id não pode ser NULL porque compõe a chave primária. O UUID zerado
-- representa "envio sem fluxo" (disparo manual ou via API), permitindo
-- ON CONFLICT direto no upsert do agregador.
CREATE TABLE IF NOT EXISTS notification_daily_stats (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day         date NOT NULL,
  channel     text NOT NULL,
  status      text NOT NULL,
  flow_id     uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  total       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, channel, status, flow_id)
);
