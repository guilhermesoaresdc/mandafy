# PULSO — Especificação Técnica Completa
### Motor de notificações multicanal + CRM para plataformas de sorteio

> Documento de entrega para implementação via Claude Code.
> Versão 1.0 — Julho/2026

---

## 0. Nome e posicionamento

**Nome recomendado: PULSO**

O sistema não é um "disparador". Ele é um batimento: eventos chegam, o motor decide o ritmo, os canais respondem. "Pulso" carrega cadência, timing e vida — exatamente o produto. É curto, é português nativo, funciona como "Pulse" se um dia sair do Brasil, e não soa spam (diferente de "Disparo", "Zap", "Blast").

**Tagline:** *Cada mensagem no tempo certo, no canal certo.*

**Alternativas avaliadas:**

| Nome | Por que funciona | Risco |
|---|---|---|
| **Pulso** ⭐ | Cadência + tempo real. Curto, memorável, sem cara de spam. | Palavra comum → domínio exato difícil (`usepulso.com`, `pulso.app`, `pulsohq.com`) |
| **Estopim** | Metáfora perfeita de gatilho/evento. Altíssima disponibilidade de domínio. Muito brasileiro. | Conotação de conflito ("estopim de briga") |
| **Tambor** | Duplo sentido genial: tambor de sorteio + batida/ritmo. Nicho-perfeito. | Trava o produto no nicho de sorteios se você quiser expandir |
| **Compasso** | Ritmo controlado, tom sofisticado. | Longo, menos "tech" |
| **Sinal** | Direto, técnico, bonito. | Genérico demais para busca/SEO |
| **Cadência** | Descreve literalmente o núcleo do produto. | Já muito usado em marketing/vendas |

**Evite:** "Notifica" (já existe `usenotifica.com.br`), qualquer variação de "Zap" (Z-API já ocupa o espaço e há risco de marca da Meta), "Disparo" (associação direta com spam).

**Antes de fechar:** verifique `registro.br` para `.com.br`, e faça busca de marca no INPI (classe 42 — serviços de software). Recomendo registrar `pulso.app` + `usepulso.com.br` como par.

**Decisão de arquitetura de marca:** mantenha o Pulso como marca independente da Hédiz. São verticais diferentes (imobiliário vs. sorteios) e compradores diferentes. Use a Hédiz como "empresa por trás" no rodapé — isso dá lastro sem confundir posicionamento.

---

## 1. O que o sistema é (em uma frase)

Uma camada que fica entre a plataforma de sorteio e o cliente final: recebe eventos via webhook, decide qual mensagem enviar, em quais canais, com qual atraso, e registra tudo — com um CRM leve por cima para o time comercial trabalhar os leads que sobram.

### 1.1 As três engrenagens

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  INGESTÃO       │────▶│  MOTOR           │────▶│  ENTREGA         │
│                 │     │                  │     │                  │
│ Webhook in      │     │ Fluxos/cadências │     │ WhatsApp (Evo)   │
│ Normalização    │     │ Fila + jitter    │     │ E-mail           │
│ Deduplicação    │     │ Cancelamento     │     │ SMS              │
│ ACK < 50ms      │     │ Regras/condições │     │ Telegram         │
└─────────────────┘     └──────────────────┘     └──────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  CRM             │
                        │ Leads + Pipeline │
                        │ Admin/Consultor  │
                        └──────────────────┘
```

---

## 2. Arquitetura e stack

### 2.1 Decisão principal: VPS único com Docker Compose

**Por quê:** a Evolution API é obrigatoriamente self-hosted (roda sobre o protocolo do WhatsApp Web). Se você já vai ter um VPS, colocar o app, o banco, o Redis e o worker no mesmo host elimina latência de rede entre as peças, elimina cold start, e o custo fica fixo e previsível (~R$ 80–150/mês para começar).

```yaml
# docker-compose.yml — visão geral dos serviços
services:
  caddy:        # reverse proxy + TLS automático
  app:          # Next.js (painel + API)
  worker:       # Node — consome as filas
  postgres:     # dados + partições de log
  redis:        # BullMQ + cache
  evolution:    # Evolution API v2
```

**Hardware inicial:** 4 vCPU / 8 GB RAM / 80 GB NVMe. A comunidade da Evolution API converge em 2 vCPU / 4 GB como piso para múltiplas instâncias de WhatsApp — os 8 GB dão folga para Postgres + Redis + app no mesmo host. Hetzner CPX31 ou Contabo VPS M.

**Plano B (se preferir gerenciado):** Next.js na Vercel + Postgres no Supabase + Redis no Upstash + worker no Railway + Evolution API no VPS. Funciona, custa mais, adiciona latência entre camadas e complica o debug. Só vale se você quiser zero manutenção de servidor.

### 2.2 Stack

| Camada | Escolha | Justificativa |
|---|---|---|
| Framework | **Next.js 15+ (App Router) + TypeScript** | Server Components cortam JS no cliente; API routes no mesmo projeto |
| Banco | **PostgreSQL 16** | Partições nativas por dia para o log de notificações |
| ORM | **Drizzle ORM** | Gera SQL previsível, sem overhead de runtime, migrations em SQL puro |
| Fila | **BullMQ + Redis** | Ver 2.3 |
| Worker | **Node 22 + processo separado** | Filas precisam de processo long-running |
| Auth | **Lucia / Auth.js com sessão em cookie** | Simples, sem dependência externa |
| UI | **Tailwind + Radix Primitives** (sem biblioteca de componentes pesada) | Controle total do design; bundle mínimo |
| Estado servidor | **TanStack Query** apenas onde há polling real | Resto é Server Component |
| Validação | **Zod** | Compartilhado entre API pública e formulários |
| Realtime | **SSE** (`/api/stream`) | Mais leve que WebSocket para atualizar status de envio ao vivo |

### 2.3 Por que BullMQ e não pg-boss

Ambos servem. O BullMQ ganha aqui por três recursos que são exatamente o núcleo deste produto:

1. **Delayed jobs com precisão de milissegundo** — o "5 minutos e não pagou" é literalmente um delayed job.
2. **Rate limiter nativo por fila** — o WhatsApp não-oficial exige 1 mensagem a cada 3–5 segundos por número. No BullMQ isso é `limiter: { max: 1, duration: 4000 }`, não código seu.
3. **Remoção de job por ID** — essencial para o cancelamento (cliente pagou no minuto 3, cancela o job do minuto 5).

O Redis já vai estar no stack de qualquer forma (a Evolution API o usa para cache de sessão). Se um dia quiser sair do Redis, o pg-boss é a migração natural — mas não comece por ele.

---

## 3. Modelo de dados

### 3.1 Núcleo

```sql
-- Multi-tenant desde o dia 1 (mesmo com 1 cliente)
organizations (
  id uuid pk, name text, slug text unique,
  timezone text default 'America/Sao_Paulo',
  created_at timestamptz
)

users (
  id uuid pk, org_id uuid fk,
  name text, email citext unique, password_hash text,
  role text check (role in ('admin','consultor')),
  active boolean default true,
  last_login_at timestamptz
)

-- Conectores: cada plataforma de sorteio plugada
sources (
  id uuid pk, org_id uuid fk,
  name text,                    -- "Rifa do João"
  platform text,                -- 'generico' | 'rifei' | 'custom'
  ingest_token text unique,     -- vai na URL do webhook
  hmac_secret text,             -- opcional, se a plataforma assinar
  mapping jsonb,                -- ver 4.2
  active boolean default true
)
```

### 3.2 Eventos

```sql
-- Cru: tudo que chega, sem processar. Auditoria + replay.
events_raw (
  id bigserial, source_id uuid, received_at timestamptz,
  headers jsonb, payload jsonb,
  dedupe_hash text, signature_ok boolean,
  processed_at timestamptz, error text
) PARTITION BY RANGE (received_at);  -- diária, retenção 7 dias

-- Normalizado: é sobre isso que os fluxos disparam
events (
  id bigserial pk, org_id uuid, source_id uuid,
  type text,                    -- evento canônico, ver 4.1
  external_id text,             -- id do pedido/usuário na origem
  contact_id uuid fk,
  occurred_at timestamptz,
  data jsonb,                   -- valores normalizados p/ variáveis
  raw_id bigint
) PARTITION BY RANGE (occurred_at);  -- diária, retenção 30 dias

CREATE INDEX ON events (org_id, type, occurred_at DESC);
CREATE UNIQUE INDEX ON events (source_id, type, external_id, occurred_at);
```

### 3.3 Contatos e consentimento

```sql
contacts (
  id uuid pk, org_id uuid,
  external_id text,             -- id na plataforma de origem
  name text,
  phone_e164 text,              -- +5588999999999 — sempre normalizado
  email citext,
  telegram_chat_id bigint,
  cpf text,
  tags text[],

  -- consentimento por canal (LGPD)
  optin_whatsapp boolean default true,
  optin_email boolean default true,
  optin_sms boolean default true,
  optin_telegram boolean default true,
  optin_source text,            -- 'checkout' | 'import' | 'api'
  optin_at timestamptz,
  opted_out_at timestamptz,
  optout_reason text,

  first_seen_at timestamptz, last_event_at timestamptz,
  total_orders int default 0, total_paid_cents bigint default 0
);

CREATE UNIQUE INDEX ON contacts (org_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX ON contacts (org_id, email) WHERE email IS NOT NULL;

-- Bloqueio granular: bounce de e-mail, número inexistente no WA, "SAIR"
suppressions (
  id uuid pk, org_id uuid, contact_id uuid,
  channel text, reason text,    -- 'hard_bounce'|'invalid'|'optout'|'complaint'
  created_at timestamptz
);
```

### 3.4 Mensagens (templates) — o coração do "mesma mensagem, canais diferentes"

```sql
-- A mensagem lógica. Uma por situação.
messages (
  id uuid pk, org_id uuid,
  key text,                     -- 'boas_vindas', 'pix_abandonado_5min'
  name text,                    -- "PIX abandonado — 5 minutos"
  category text,                -- 'transacional'|'recuperacao'|'relacionamento'
  description text,
  active boolean default true
);
CREATE UNIQUE INDEX ON messages (org_id, key);

-- Uma variante por canal. Padrão: todas habilitadas.
message_variants (
  id uuid pk, message_id uuid fk on delete cascade,
  channel text check (channel in ('whatsapp','email','sms','telegram')),
  enabled boolean default true,          -- ← o "pad" que liga/desliga na UI

  subject text,                          -- e-mail
  preheader text,                        -- e-mail
  body text,                             -- fonte única em formato Pulso (ver 6.2)
  html text,                             -- e-mail: HTML compilado
  parse_mode text,                       -- telegram: 'HTML'|'MarkdownV2'
  buttons jsonb,                         -- telegram: inline keyboard
  media_url text,
  link_shorten boolean default true,     -- sms: encurtar link

  updated_at timestamptz
);
CREATE UNIQUE INDEX ON message_variants (message_id, channel);
```

### 3.5 Fluxos de cadência

```sql
flows (
  id uuid pk, org_id uuid,
  name text,
  trigger_event text,           -- 'order.created'
  entry_conditions jsonb,       -- {"valor_cents": {">=": 1000}}
  cancel_on text[],             -- ['order.paid','order.cancelled']  ← crítico
  cancel_key_template text,     -- 'order:{{external_id}}'
  quiet_hours_enabled boolean default true,
  quiet_start time default '21:00', quiet_end time default '08:00',
  max_per_contact_per_day int default 4,
  active boolean default true,
  priority int default 100
);

flow_steps (
  id uuid pk, flow_id uuid fk on delete cascade,
  position int,
  delay_seconds int,            -- relativo ao passo anterior
  jitter_profile_id uuid,       -- randomizador, ver 7.2
  message_id uuid fk,
  channels_override text[],     -- null = usa o enabled do template
  conditions jsonb,             -- {"não_pagou": true}
  stop_if jsonb
);
```

### 3.6 Fila e log de notificações

```sql
notifications (
  id uuid, org_id uuid, created_at timestamptz,

  contact_id uuid, message_id uuid, variant_id uuid,
  flow_id uuid, step_id uuid, event_id bigint,
  channel text,

  status text,   -- ver máquina de estados 8.1
  scheduled_for timestamptz,
  attempted_at timestamptz, sent_at timestamptz,
  delivered_at timestamptz, read_at timestamptz,

  provider text,                -- 'evolution' | 'resend' | 'smsdev' | 'telegram'
  provider_message_id text,
  provider_instance text,       -- qual número/instância enviou

  rendered_subject text,
  rendered_body text,           -- exatamente o que foi enviado (auditoria)

  attempts smallint default 0,
  error_code text, error_message text,

  cancel_key text,              -- 'order:12345' ← permite cancelamento em lote
  dedupe_key text,              -- evita duplicata do mesmo passo
  queue_job_id text
) PARTITION BY RANGE (created_at);

-- Partição diária. Retenção: 3 dias quentes + 30 dias em arquivo comprimido.
-- Limpeza é DROP PARTITION → O(1), sem VACUUM, sem travar tabela.

CREATE INDEX ON notifications (org_id, created_at DESC);
CREATE INDEX ON notifications (cancel_key) WHERE status IN ('queued','scheduled');
CREATE INDEX ON notifications (channel, status, created_at DESC);
CREATE UNIQUE INDEX ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;
```

### 3.7 CRM

```sql
pipelines (id uuid pk, org_id uuid, name text, is_default boolean);

pipeline_stages (
  id uuid pk, pipeline_id uuid, name text, position int,
  color text, probability int, is_won boolean, is_lost boolean
);

leads (
  id uuid pk, org_id uuid,
  contact_id uuid fk,
  owner_id uuid fk,             -- consultor responsável ← base do RBAC
  pipeline_id uuid, stage_id uuid,
  title text, value_cents bigint,
  source text,                  -- 'evento:order.created' | 'manual' | 'api'
  status text,                  -- 'aberto'|'ganho'|'perdido'
  lost_reason text,
  next_action_at timestamptz,
  stage_changed_at timestamptz,
  created_at timestamptz, updated_at timestamptz
);
CREATE INDEX ON leads (org_id, owner_id, stage_id);
CREATE INDEX ON leads (org_id, next_action_at) WHERE status = 'aberto';

lead_activities (
  id uuid pk, lead_id uuid, user_id uuid,
  type text,                    -- 'nota'|'ligacao'|'mudanca_etapa'|'mensagem'
  content text, metadata jsonb, created_at timestamptz
);
```

### 3.8 Infra e integrações

```sql
channel_configs (
  id uuid pk, org_id uuid, channel text, provider text,
  credentials_encrypted bytea,  -- AES-256-GCM, chave em env
  rate_limit_per_minute int, daily_cap int,
  active boolean, is_default boolean
);

wa_instances (
  id uuid pk, org_id uuid, name text,
  evolution_url text, instance_name text, apikey_encrypted bytea,
  status text,                  -- 'conectado'|'desconectado'|'banido'
  warmup_stage int default 0,   -- 0=novo … 5=maduro
  daily_cap int,                -- calculado pelo warmup_stage
  sent_today int, last_sent_at timestamptz,
  proxy_url text,
  weight int default 1          -- para rodízio entre números
);

api_keys (
  id uuid pk, org_id uuid, name text,
  key_hash text,                -- sha256; prefixo visível: pulso_live_a1b2…
  scopes text[], last_used_at timestamptz, revoked_at timestamptz
);

outbound_webhooks (
  id uuid pk, org_id uuid, url text,
  events text[], secret text, active boolean,
  last_status int, failure_count int
);

audit_log (
  id bigserial, org_id uuid, user_id uuid,
  action text, entity text, entity_id text,
  before jsonb, after jsonb, ip inet, created_at timestamptz
);
```

---

## 4. Ingestão de eventos

### 4.1 Eventos canônicos

Todo webhook de entrada é traduzido para um destes. É o que torna o sistema plugável em qualquer plataforma de sorteio sem escrever código novo.

| Evento canônico | Equivalente típico na plataforma |
|---|---|
| `user.created` | Novo Usuário |
| `order.created` | Qrcode Criado / PIX gerado |
| `order.paid` | Qrcode Pago |
| `order.expired` | PIX expirado *(derivado se a plataforma não enviar)* |
| `order.cancelled` | Pedido cancelado |
| `ticket.awarded` | Bilhete Premiado |
| `withdrawal.pending` | Saque Pendente |
| `withdrawal.completed` | Saque Finalizado |
| `campaign.created` | Nova campanha publicada |
| `campaign.ending_soon` | *(gerado internamente por agendamento)* |

**Eventos internos (gerados pelo Pulso, não pela plataforma):**
`contact.inactive_7d`, `contact.inactive_30d`, `contact.first_purchase`, `contact.repeat_purchase`, `campaign.ending_24h`.

### 4.2 Mapeamento por conector

Cada `source` guarda um mapeamento declarativo. Nada de código por plataforma.

```json
{
  "event_path": "$.event",
  "event_map": {
    "novo_usuario": "user.created",
    "qrcode_criado": "order.created",
    "qrcode_pago": "order.paid",
    "bilhete_premiado": "ticket.awarded",
    "saque_pendente": "withdrawal.pending",
    "saque_finalizado": "withdrawal.completed"
  },
  "contact": {
    "external_id": "$.data.user.id",
    "name":        "$.data.user.name",
    "phone":       "$.data.user.phone",
    "email":       "$.data.user.email"
  },
  "fields": {
    "external_id":   "$.data.order.id",
    "valor_cents":   { "path": "$.data.order.amount", "transform": "reais_para_centavos" },
    "quantidade":    "$.data.order.tickets",
    "campanha":      "$.data.campaign.title",
    "pix_copia_cola":"$.data.order.pix_code",
    "link_pagamento":"$.data.order.checkout_url",
    "premio":        "$.data.campaign.prize"
  }
}
```

**Na UI:** tela "Conectar plataforma" com três passos —
1. Copiar a URL de webhook (`https://app.pulso.com.br/in/{ingest_token}`);
2. Colar um payload de exemplo (ou clicar em "Aguardando evento…" e o sistema captura o primeiro que chegar);
3. Arrastar os campos detectados para os slots canônicos. Visual, sem JSONPath à mão.

Isso resolve o cenário do print que você mandou: aquela plataforma tem os eventos "Novo Usuário / Qrcode Pago / Bilhete Premiado / Qrcode Criado / Saque Finalizado / Saque Pendente" — cada um vira uma linha do `event_map` e pronto.

### 4.3 Pipeline de ingestão (alvo: ACK em menos de 50 ms)

```
POST /in/{ingest_token}
  1. Valida token           → 401 se inválido
  2. Valida HMAC (opcional) → registra signature_ok
  3. Calcula dedupe_hash    → sha256(source_id + body)
  4. INSERT em events_raw
  5. Enfileira job 'normalize'
  6. return 200 { "ok": true, "id": "..." }      ← nada de processar aqui
```

Todo o resto (normalizar, criar/atualizar contato, disparar fluxos) roda no worker. Se a plataforma tiver timeout curto, isso salva a integração.

**Deduplicação:** se `dedupe_hash` já existe nas últimas 24h, responde 200 e ignora. Plataformas fazem retry com frequência.

### 4.4 Eventos derivados

`order.expired` normalmente não vem da plataforma. O Pulso gera: ao receber `order.created`, agenda uma verificação para T+X minutos; se não houve `order.paid` com o mesmo `external_id`, emite `order.expired` internamente. Isso vira um evento de primeira classe, disparável por fluxos.

---

## 5. Motor de cadência

### 5.1 O caso do PIX abandonado (o seu exemplo, resolvido)

**Fluxo: "Recuperação de PIX"**

```
Gatilho: order.created
Cancelar quando: order.paid, order.cancelled
Chave de cancelamento: order:{{external_id}}

Passo 1 → +5 min   | msg: pix_lembrete_1     | WA ✓  Email ✓  SMS ✗  TG ✓
Passo 2 → +25 min  | msg: pix_lembrete_2     | WA ✓  Email ✓  SMS ✗  TG ✓
Passo 3 → +2 h     | msg: pix_ultima_chance  | WA ✓  Email ✓  SMS ✓  TG ✓
Passo 4 → +20 h    | msg: pix_expirou_oferta | WA ✓  Email ✓  SMS ✗  TG ✓
```

**O mecanismo de cancelamento (a parte que quase todo sistema erra):**

Quando `order.created` chega, os 4 passos são enfileirados de uma vez, todos carregando `cancel_key = "order:12345"`.

Quando `order.paid` chega no minuto 3:
```sql
UPDATE notifications SET status='cancelled', error_code='pago_antes_do_envio'
WHERE cancel_key='order:12345' AND status IN ('queued','scheduled');
```
E o worker remove os jobs correspondentes do BullMQ por `queue_job_id`.

Resultado: zero chance de mandar "finalize seu pagamento" para quem já pagou. Esse é o bug número 1 de sistemas de recuperação e a razão de operações perderem credibilidade.

### 5.2 Fluxos que já vêm prontos (seed)

| Fluxo | Gatilho | Passos |
|---|---|---|
| **Boas-vindas** | `user.created` | +0 (imediato) → +2 dias (se não comprou) |
| **Recuperação de PIX** | `order.created` | +5min → +25min → +2h → +20h |
| **Pagamento confirmado** | `order.paid` | +0 imediato (recibo + números) |
| **Você foi premiado** | `ticket.awarded` | +0 imediato + notificação para o admin |
| **Saque em processamento** | `withdrawal.pending` | +0 imediato |
| **Saque concluído** | `withdrawal.completed` | +0 imediato |
| **Reativação 7 dias** | `contact.inactive_7d` | +0 |
| **Campanha encerrando** | `campaign.ending_24h` | +0 para toda a base da campanha |
| **Pós-compra / upsell** | `order.paid` | +3 dias |

### 5.3 Regras de guarda (aplicadas antes de todo envio)

Ordem de verificação, e o motivo fica registrado no log:

1. Contato tem opt-out global? → `skipped: optout`
2. Canal específico tem opt-out ou está em `suppressions`? → `skipped: suppressed`
3. Está em horário de silêncio (21h–08h)? → **reagenda** para a abertura da janela + jitter
4. Contato já recebeu o limite diário (padrão 4)? → `skipped: frequency_cap`
5. Já existe notificação com o mesmo `dedupe_key`? → `skipped: duplicate`
6. O canal tem dado válido? (sem telefone → pula WhatsApp/SMS; sem `telegram_chat_id` → pula Telegram) → `skipped: sem_destino`
7. A variante do canal está desabilitada? → `skipped: canal_desligado`
8. A instância de WhatsApp bateu o teto diário? → tenta próxima instância, senão reagenda

---

## 6. Mensagens: uma fonte, quatro saídas

### 6.1 O modelo mental

Você escreve **uma** mensagem. O sistema mantém **quatro** variantes que nascem dela e podem ser ajustadas individualmente. Editar o corpo principal propaga para as variantes que você não tocou (elas ficam "sincronizadas"); no momento em que você edita uma variante, ela vira "customizada" e para de receber propagação — com um botão "ressincronizar" sempre disponível.

Na UI isso aparece como um selo discreto: `sincronizado` / `customizado`.

### 6.2 Formato-fonte e compilação por canal

O corpo é escrito em um Markdown reduzido e compilado para cada destino:

| Fonte | WhatsApp | Telegram (HTML) | E-mail | SMS |
|---|---|---|---|---|
| `**negrito**` | `*negrito*` | `<b>negrito</b>` | `<strong>` | texto puro |
| `*itálico*` | `_itálico_` | `<i>itálico</i>` | `<em>` | texto puro |
| `~riscado~` | `~riscado~` | `<s>` | `<del>` | removido |
| `` `mono` `` | ``` ```mono``` ``` | `<code>` | `<code>` | texto puro |
| `[texto](url)` | `texto: url` | `<a href>` | `<a href>` | link encurtado |
| Emoji | mantém | mantém | mantém | **remove** (ver 6.4) |
| `---` | linha em branco | linha em branco | `<hr>` | ignorado |

### 6.3 Variáveis e fallback

```
Oi {{nome|"tudo bem"}}! Seu PIX de {{valor|moeda}} para a campanha
*{{campanha}}* ainda está aberto.

São {{quantidade}} números esperando por você. 🎟️

Finaliza aqui: {{link_pagamento}}
```

Filtros disponíveis: `|moeda`, `|data`, `|hora`, `|maiusculo`, `|primeiro_nome`, `|telefone`, `|"fallback"`.

Se uma variável obrigatória vier vazia, a notificação vai para `failed: variavel_ausente` — nunca envia `Oi {{nome}}!` literal para o cliente.

### 6.4 Adaptação inteligente por canal

**WhatsApp**
- Quebra automática em 2–3 parágrafos curtos (bloco único de 10 linhas parece robô)
- Emoji preservado
- Link no fim da mensagem, nunca no meio
- `delay` + `presence: "composing"` para simular digitação humana

**Telegram**
- `parse_mode: HTML` (mais seguro que MarkdownV2, que exige escapar `_ * [ ] ( ) ~ > # + - = | { } . !`)
- Suporta botões inline — configure em `buttons`: `[{ "text": "Pagar agora", "url": "{{link_pagamento}}" }]`
- `disable_web_page_preview: true` por padrão para não poluir

**E-mail**
- HTML montado com React Email/MJML → tabelas, inline CSS, largura 600px
- Sempre gerar versão texto puro em paralelo (multipart) — melhora entregabilidade
- Assunto + preheader editáveis separadamente
- Link de descadastro obrigatório no rodapé
- Modo de composição: **visual** (blocos: cabeçalho, texto, botão, imagem, rodapé) ou **HTML puro** para quem quer controle total

**SMS — o canal que exige mais cuidado**

Este é o detalhe técnico que economiza dinheiro de verdade: SMS usa o alfabeto GSM-7, que cabe **160 caracteres** por segmento. Um único emoji ou caractere fora do GSM-7 força a mensagem para UCS-2, e o limite despenca para **70 caracteres** por segmento. Ou seja: um 🎟️ no meio da mensagem pode dobrar ou triplicar sua fatura.

Regras aplicadas automaticamente na variante SMS:
- Remove emoji (com aviso visual no editor)
- Oferece remover acentuação (opcional — "olá" vs "ola")
- Encurta links via encurtador próprio (`pls.to/abc123`, permite rastrear clique)
- **Contador de segmentos ao vivo** no editor: `142/160 · 1 segmento · ~R$ 0,06`
- Alerta em vermelho ao cruzar para 2 segmentos

### 6.5 Spintax — variação anti-spam

Essa é uma exigência técnica, não um capricho. Os provedores e a própria detecção do WhatsApp tratam mensagens idênticas enviadas em massa como sinal de spam. A recomendação recorrente na comunidade Evolution API é variar o conteúdo.

Sintaxe no corpo:
```
{Oi|Olá|E aí} {{primeiro_nome}}, {vi que|notei que|percebi que}
seu PIX ainda não foi pago.
```

Cada envio sorteia uma combinação. O editor mostra 3 exemplos gerados ao vivo. O texto final renderizado fica em `rendered_body` no log — você sempre sabe exatamente o que o cliente recebeu.

### 6.6 Pré-visualização lado a lado

Tela dedicada mostrando as quatro saídas simultaneamente, com dados reais de um contato de teste:

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  WhatsApp    │  Telegram    │   E-mail     │     SMS      │
│  (bolha)     │  (bolha)     │  (inbox)     │  (tela)      │
│              │              │              │ 142/160 · 1  │
│  [Enviar     │  [Enviar     │  [Enviar     │  [Enviar     │
│   teste]     │   teste]     │   teste]     │   teste]     │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

---

## 7. Fila, jitter e proteção de reputação

### 7.1 Filas separadas por canal

Cada canal tem características de risco e throughput completamente diferentes. Uma fila única seria um erro.

| Fila | Rate limit padrão | Concorrência | Retry |
|---|---|---|---|
| `wa:{instance_id}` | 1 msg / 4 s | 1 | 3× backoff exponencial |
| `email` | 100 / min | 10 | 5× |
| `sms` | 60 / min | 5 | 2× (SMS custa; não insista) |
| `telegram` | 20 / s (teto é 30) | 5 | 3× (respeitar `retry_after` do 429) |

**Sobre o Telegram:** a documentação oficial de bots é explícita — bots não conseguem transmitir mais que cerca de 30 mensagens por segundo, e ultrapassar isso retorna erro 429, que bloqueia o bot inteiro (não só aquele envio) pelo tempo indicado em `retry_after`. Trabalhamos com 20/s para ter margem. Existe a opção paga de broadcast até 1000/s via Telegram Stars, mas exige saldo e base grande — irrelevante para o seu caso.

### 7.2 Perfis de randomização (o randomizador que você pediu)

Um `jitter_profile` é reutilizável e aplicável em três níveis: global (padrão do sistema) → fluxo → passo. O mais específico vence.

```
Modo INSTANTÂNEO   → sem atraso adicional (transacionais críticos: pagamento aprovado)
Modo FIXO          → sempre X segundos
Modo FAIXA         → aleatório entre mín e máx
Modo HUMANO        → aleatório com distribuição enviesada para o meio da faixa
                     (evita o padrão estatístico uniforme, que é detectável)
```

**Perfis já configurados (seed):**

| Perfil | Faixa | Onde usar |
|---|---|---|
| Instantâneo | 0 s | Pagamento confirmado, bilhete premiado, saque |
| Seguro | 8–25 s | Padrão para WhatsApp |
| Conservador | 30–90 s | Números novos ou em aquecimento |
| Disparo em massa | 45–180 s | Campanha para toda a base |

**Na UI:** um controle de faixa dupla (dois marcadores em uma trilha) com preview em texto — *"os próximos 10 envios sairiam em: 12s, 19s, 8s, 24s, 15s…"*. Muda em tempo real ao arrastar. Dá a sensação exata de estar mexendo em um mixer.

### 7.3 Aquecimento e rodízio de números

A Evolution API opera sobre o WhatsApp Web, não é API oficial, e o WhatsApp detecta comportamento automatizado e bane números. As práticas que a comunidade consolidou e que o Pulso automatiza:

**Escada de aquecimento** (`warmup_stage` define o `daily_cap`):

| Estágio | Dias | Teto diário | Intervalo mínimo |
|---|---|---|---|
| 0 — Novo | 1–3 | 20 | 60 s |
| 1 — Inicial | 4–7 | 50 | 40 s |
| 2 — Crescendo | 8–14 | 120 | 25 s |
| 3 — Estável | 15–30 | 300 | 15 s |
| 4 — Maduro | 31+ | 600 | 8 s |
| 5 — Consolidado | 60+ | 1000 | 5 s |

A progressão é automática, mas só avança se a taxa de falha ficar abaixo de 3%. Qualquer sinal de degradação (desconexões repetidas, mensagens não entregues em série) **rebaixa** o estágio e emite alerta no painel.

**Rodízio:** múltiplas instâncias ativas recebem os envios por peso, com estado guardado em Redis. Se uma instância cai ou bate o teto, a fila migra para a próxima automaticamente.

**Painel de saúde do número:** para cada instância — status de conexão, enviadas hoje / teto, taxa de falha 24h, tempo desde a última reconexão, estágio de aquecimento. Semáforo verde/âmbar/vermelho.

### 7.4 Janela de silêncio

Padrão 21h–08h no fuso do contato (assumindo `America/Sao_Paulo`). Mensagens que cairiam nessa janela são **reagendadas**, não descartadas, para a abertura da janela + jitter — o que espalha naturalmente a fila da manhã em vez de criar um pico às 08:00:00.

Transacionais críticos (`order.paid`, `ticket.awarded`, `withdrawal.completed`) ignoram a janela de silêncio por padrão — mas isso é configurável por mensagem.

---

## 8. Canais: implementação

### 8.1 Máquina de estados (idêntica para todos os canais)

```
queued ──▶ scheduled ──▶ sending ──▶ sent ──▶ delivered ──▶ read
   │           │            │          │
   │           │            └──▶ failed ──▶ (retry) ──▶ sending
   │           │                    │
   │           │                    └──▶ dead (esgotou tentativas)
   │           └──▶ cancelled  (evento de cancelamento chegou)
   └──▶ skipped  (regra de guarda bloqueou — motivo no error_code)
```

`delivered` e `read` só existem onde o canal reporta: WhatsApp (via webhook `MESSAGES_UPDATE` da Evolution), e-mail (webhook do provedor), SMS (DLR). Telegram não tem confirmação de leitura para bots.

### 8.2 WhatsApp — Evolution API

**Atenção crítica de versão:** o formato do payload mudou entre v1 e v2 e isso quebra integrações silenciosamente.

```jsonc
// v1 (formato antigo, aninhado)
POST /message/sendText/{instance}
{
  "number": "5588999999999",
  "textMessage": { "text": "Olá" },
  "options": { "delay": 1200, "presence": "composing", "linkPreview": false }
}

// v2 (formato atual, plano) ← use este
POST /message/sendText/{instance}
Header: apikey: <sua-chave>
{
  "number": "5588999999999",
  "text": "Olá",
  "delay": 1200,
  "linkPreview": false
}
```

Fixe a versão da imagem Docker (`evoapicloud/evolution-api:v2.x.x`), nunca use `latest`, e mantenha o adaptador do canal isolado em um único arquivo (`lib/channels/whatsapp.ts`) para que uma mudança de contrato seja um patch de 20 linhas.

**Webhooks de retorno a configurar na instância:**
- `MESSAGES_UPDATE` → atualiza `delivered_at` / `read_at`
- `CONNECTION_UPDATE` → atualiza `wa_instances.status`, dispara alerta se desconectar
- `MESSAGES_UPSERT` → captura respostas (alimenta o CRM e detecta "SAIR")
- `SEND_MESSAGE` → confirma o `provider_message_id`

**Detecção de opt-out:** se a resposta do contato bate com `/^(sair|parar|cancelar|descadastrar|stop|remover)/i`, cria supressão no canal WhatsApp, responde uma confirmação curta e registra em `audit_log`. Prazo de processamento: imediato.

**Validação de número:** antes do primeiro envio para um contato novo, chamar `/chat/whatsappNumbers/{instance}` para confirmar que o número existe no WhatsApp. Evita queima de reputação com números inválidos.

### 8.3 E-mail

**Recomendação: começar no Resend, migrar para Amazon SES ao passar de ~200 mil/mês.**

Racional: o Resend tem a melhor experiência de desenvolvimento do mercado, integração nativa com React Email e Next.js, e o plano gratuito cobre 3.000 e-mails/mês (100/dia); o Pro começa em US$ 20/mês para 50 mil. O SES é imbatível em custo (US$ 0,10 por 1.000 e-mails) mas exige configuração de bounce handling, listas de supressão e monitoramento de entregabilidade por conta própria. Nas comparações de 2026, a diferença só compensa a partir de volumes altos — em 50 mil/mês a economia não paga as horas de configuração.

Um ponto de atenção honesto: relatos recorrentes apontam que o tratamento de bounce do Resend em envios de volume ainda é mais fraco que o de concorrentes como Postmark, e houve reajuste significativo nos tiers superiores no passado. Como o Pulso implementa sua própria camada de supressão, isso fica mitigado.

**Implementação:** interface `EmailProvider` com métodos `send()` e `parseWebhook()`. Adapters para Resend, SES e Brevo. Trocar de provedor = mudar uma variável de ambiente.

**Obrigatório para entregabilidade:**
- SPF, DKIM e DMARC configurados no domínio (bloqueie o envio no painel enquanto não estiverem verdes)
- Subdomínio dedicado: `envio.seudominio.com.br` — protege a reputação do domínio principal
- `List-Unsubscribe` e `List-Unsubscribe-Post` nos headers (one-click, exigido por Gmail e Outlook)
- Versão texto puro em todo envio
- Webhook de bounce/complaint → supressão automática e imediata

### 8.4 SMS

Comece com um provedor nacional que cobre em real e sem mensalidade. O SMSDev e a Comtele operam bem nessa faixa; a Zenvia é mais completa mas trabalha com assinatura + preço por mensagem, o que costuma sair mais caro em volumes de PME. Custo de referência no mercado brasileiro em 2026: faixa de R$ 0,05 a R$ 0,08 por SMS simples.

Evite Twilio para operação 100% Brasil: cobrança em dólar traz IOF e variação cambial, e o suporte não é local.

**Implementação:** mesma abordagem de adapter. Interface `SmsProvider` com `send()` e `parseDlr()`.

**Use SMS com parcimônia.** É o canal mais caro e o de pior experiência. No Pulso, ele vem **desligado por padrão** em mensagens de relacionamento e só ligado nos passos finais de recuperação, onde o valor recuperado justifica o custo.

### 8.5 Telegram

O mais simples dos quatro. Bot criado via @BotFather, token no `channel_configs`.

O desafio não é técnico, é de aquisição: você precisa do `telegram_chat_id`, e ele só existe depois que o usuário iniciar conversa com o bot. Estratégias:
- Link com payload: `https://t.me/SeuBot?start={{contact_external_id}}` — o `/start` já chega vinculado ao contato
- Colocar esse link na página de obrigado da plataforma de sorteio e na primeira mensagem de WhatsApp/e-mail
- Oferecer incentivo: "receba o resultado do sorteio em primeira mão no Telegram"

Uma vez capturado, é o canal mais barato (gratuito), mais rápido e sem risco de banimento. Vale investir na captura.

---

## 9. CRM

Mínimo viável de verdade, sem virar um Pipedrive pela metade.

### 9.1 Página "Leads" (a base)

Tabela virtualizada (renderiza só as linhas visíveis — 50 mil leads sem travar). Colunas: nome, telefone, e-mail, origem, etapa, responsável, valor, último evento, próxima ação.

- Busca instantânea (índice trigram no Postgres, resposta abaixo de 100 ms)
- Filtros salvos ("Meus abertos", "Sem contato há 7 dias", "Pagaram acima de R$ 100")
- Seleção múltipla → atribuir responsável, mudar etapa, aplicar tag, disparar mensagem
- Import/export CSV
- Painel lateral ao clicar em um lead: dados, linha do tempo unificada (eventos da plataforma + notificações enviadas + atividades do consultor), campo de nota, botão de envio manual

### 9.2 Página "Pipeline" (o funil)

Kanban por etapa, arrastar e soltar. Cada coluna mostra contagem e soma de valores. Cartão compacto: nome, valor, tempo na etapa, avatar do responsável, ícones dos últimos canais tocados.

Etapas padrão: `Novo` → `Contatado` → `Negociando` → `Ganho` / `Perdido`.

O drag-and-drop atualiza otimisticamente (a UI move na hora, o servidor confirma depois). Se falhar, o cartão volta com um toast explicando.

### 9.3 Criação automática de lead

Regras configuráveis. Padrão sugerido:
- `order.created` sem pagamento em 24h → cria lead na etapa "Novo"
- `order.paid` acima de R$ 200 → cria lead na etapa "Contatado" (cliente valioso, merece toque humano)
- `contact.inactive_30d` com histórico de compra → cria lead de reativação

**Distribuição:** round-robin entre consultores ativos, ou manual. Configurável por regra.

### 9.4 Controle de acesso

| Recurso | Admin | Consultor |
|---|---|---|
| Ver todos os leads | ✓ | ✗ (só os próprios) |
| Editar lead próprio | ✓ | ✓ |
| Reatribuir responsável | ✓ | ✗ |
| Ver pipeline completo | ✓ | ✗ (filtrado) |
| Criar/editar mensagens | ✓ | ✗ |
| Criar/editar fluxos | ✓ | ✗ |
| Ligar/desligar canais | ✓ | ✗ |
| Ver histórico de notificações | Todos | Só dos próprios leads |
| Enviar mensagem manual | ✓ | ✓ (só para leads próprios) |
| Configurar integrações/API | ✓ | ✗ |
| Gerenciar usuários | ✓ | ✗ |
| Ver custos e faturamento | ✓ | ✗ |

**Implementação:** middleware de autorização no servidor + políticas RLS no Postgres. Nunca confie apenas na UI. Toda query de lead passa por `WHERE org_id = $1 AND (is_admin OR owner_id = $2)` no nível do banco.

---

## 10. Histórico e observabilidade

### 10.1 Tela "Histórico" (3 dias quentes)

Layout de terminal de log — denso, monoespaçado, rápido. Sem cards inflados.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [Todos ▾] [WA][Email][SMS][TG]  [Status ▾]  [Buscar…]     ⟳ ao vivo    │
├─────────────────────────────────────────────────────────────────────────┤
│ 14:32:07  ●WA   Maria Silva      pix_lembrete_1     ✓ entregue   1.2s   │
│ 14:32:03  ●EM   Maria Silva      pix_lembrete_1     ✓ enviado    0.4s   │
│ 14:31:58  ●TG   João Costa       boas_vindas        ✗ falhou     bot    │
│ 14:31:44  ○SMS  Ana Souza        pix_ultima_chance  ⧗ agendado   14:45  │
│ 14:31:12  ●WA   Pedro Lima       pagamento_ok       ✓ lido       0.8s   │
│ 14:30:55  ●WA   Carla Dias       pix_lembrete_1     ⊘ cancelado  pagou  │
└─────────────────────────────────────────────────────────────────────────┘
```

- Atualização ao vivo via SSE (sem polling)
- Clicar na linha abre o detalhe: corpo exato enviado, tentativas, resposta crua do provedor, latência, qual instância enviou
- Filtro combinado por canal + status + período + busca por contato
- Exportar CSV do que estiver filtrado
- Botão "Reenviar" em falhas (com confirmação)

### 10.2 Retenção em camadas

| Camada | Prazo | Onde | Consulta |
|---|---|---|---|
| Quente | 3 dias | `notifications`, partições diárias | Instantânea |
| Morna | 30 dias | `notifications_archive`, comprimida | 1–3 s |
| Fria | 12 meses | Agregados diários por canal/status/fluxo | Instantânea |

Limpeza via `pg_cron`: `DROP TABLE notifications_2026_07_24` é instantâneo e não trava nada — muito superior a `DELETE FROM … WHERE created_at < …`, que gera VACUUM pesado e degrada o banco.

### 10.3 Dashboard

Cinco números no topo, nada de gráfico decorativo:

```
Enviadas hoje    Taxa entrega    Na fila    Falhas 24h    Recuperado (R$)
    1.247            94,2%          38          12          R$ 8.430
```

Abaixo: a **barra de pulso** (ver seção 11) e a lista dos próximos envios agendados.

### 10.4 Alertas

Notificação no painel + e-mail para o admin quando:
- Instância de WhatsApp desconecta ou é banida
- Taxa de falha de um canal passa de 10% em 15 minutos
- Fila com mais de 500 jobs pendentes
- Domínio de e-mail com DKIM/SPF quebrado
- Saldo de SMS abaixo do limite configurado
- Webhook de entrada rejeitado por assinatura inválida (possível tentativa de abuso)

---

## 11. Design

### 11.1 Conceito: mesa de som

O produto é uma **mesa de mixagem para mensagens**. Você tem canais, tem faders de tempo, tem pads que acendem quando armados. Essa metáfora não é decorativa — ela é literalmente o que o software faz, e resolve exatamente o controle que você descreveu: aceso e saturado quando ligado, apagado e cinza quando desligado.

O contraponto: tudo ao redor dos pads é sóbrio, quase editorial. A cor mora nos controles ativos e em mais nenhum lugar. É o que faz o painel parecer um instrumento e não um dashboard genérico.

### 11.2 Tokens

```css
/* Estrutura — papel frio, tinta profunda. Nem cream, nem dark padrão. */
--paper:      #F5F6FA;   /* fundo da aplicação */
--surface:    #FFFFFF;   /* cartões, painéis */
--surface-2:  #EDEFF5;   /* estados sutis, cabeçalhos de tabela */
--ink:        #0B1020;   /* texto principal, estrutura */
--ink-2:      #5A6480;   /* texto secundário */
--line:       #DFE3EE;   /* divisórias, sempre 1px */

/* Ação */
--live:       #4B2EE8;   /* índigo elétrico — ação primária, foco */
--live-soft:  #EAE6FF;

/* Canais — só aparecem em elementos ativos */
--ch-whatsapp: #17B26A;
--ch-telegram: #2D9CDB;
--ch-email:    #E8863C;
--ch-sms:      #8B5CF6;

/* Estados */
--ok:      #17B26A;
--warn:    #E8A13C;
--fail:    #E5484D;
--pending: #8A94AD;
```

### 11.3 Tipografia

| Papel | Família | Uso |
|---|---|---|
| Display | **Bricolage Grotesque** (variável) | Títulos de sessão, números grandes do dashboard. Tem largura variável — use expandido nos títulos, é o que dá personalidade |
| Interface | **Geist Sans** | Rótulos, botões, corpo. Neutra e legível em 13–14px |
| Dados | **Geist Mono** | Horários, IDs, contadores, o log inteiro. Tabular numbers ligado |

Escala: 11 / 13 / 15 / 18 / 24 / 34 / 48. Nada entre.

### 11.4 O pad de canal (o controle que você pediu)

Não é toggle. É um pad iluminado.

```
LIGADO                          DESLIGADO
┌──────────────┐                ┌ ─ ─ ─ ─ ─ ─ ┐
│  ◉ WhatsApp  │  ← cor viva      ○ WhatsApp     ← cinza, borda tracejada
│              │     do canal   │              │   opacidade reduzida
└──────────────┘                └ ─ ─ ─ ─ ─ ─ ┘
```

```css
.pad {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px; border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--surface);
  cursor: pointer;
  transition: filter 180ms cubic-bezier(.2,.8,.2,1),
              transform 120ms,
              box-shadow 180ms,
              border-color 180ms;
}

/* Ligado: cor do canal, leve halo */
.pad[data-on="true"] {
  border-color: var(--ch);
  background: color-mix(in oklab, var(--ch) 8%, white);
  box-shadow: 0 0 0 1px var(--ch), 0 2px 12px color-mix(in oklab, var(--ch) 25%, transparent);
}
.pad[data-on="true"] .dot { background: var(--ch); }

/* Desligado: dessaturado de verdade, não apenas mais claro */
.pad[data-on="false"] {
  filter: grayscale(1);
  opacity: .5;
  border-style: dashed;
  box-shadow: none;
}

/* Micro-interação de pressão — é o que dá sensação física */
.pad:active { transform: scale(.97); }

@media (prefers-reduced-motion: reduce) {
  .pad { transition: none; }
}
```

O `filter: grayscale(1)` é o detalhe que importa: ele efetivamente converte para preto e branco, incluindo o ícone e a cor de fundo, com uma transição contínua. É visualmente muito mais convincente que trocar classes de cor.

**Acessibilidade obrigatória:** o estado não pode depender só de cor. Por isso o ponto vazio/cheio (`○` / `◉`) e a borda tracejada. `role="switch"`, `aria-checked`, ativável por Espaço e Enter, foco visível.

### 11.5 Navegação em sessões (estilo Typeform, adaptado a app)

O padrão Typeform puro (uma pergunta por tela, rolagem sequestrada) não funciona para um painel operacional. A adaptação certa:

**Nível 1 — Sessões:** cada área principal é uma tela cheia sem rolagem vertical (Painel, Mensagens, Fluxos, Histórico, Leads, Pipeline, Canais, Configurações). Trocar de sessão faz uma transição horizontal com a View Transitions API.

**Nível 2 — Dentro da sessão:** quando há sequência real (criar mensagem, montar fluxo, conectar plataforma), aí sim vira passo a passo com trilho lateral numerado, `Enter` para avançar, `Esc` para voltar. Numeração só aparece onde a ordem realmente importa — não como enfeite.

**Nível 3 — Paleta de comandos:** `⌘K` / `Ctrl+K` abre busca universal — pular para qualquer lead, mensagem, fluxo ou executar ação ("desligar SMS em todas as mensagens", "pausar fluxo de recuperação"). Para operador experiente, isso substitui a navegação inteira.

Rolagem existe apenas em listas longas (leads, histórico) e é virtualizada.

### 11.6 O elemento assinatura: a barra de pulso

No topo do painel, uma faixa horizontal de ~80px representando os próximos 60 minutos. Cada envio agendado é um traço vertical fino, colorido pelo canal, deslizando da direita para a esquerda em direção à linha "agora". Enviados somem com um flash. Cancelados desvanecem em cinza.

É a única animação contínua do sistema e ela carrega informação real: você olha e sabe se a operação está respirando, se há um pico chegando, se algum canal está mudo. É o que faz o produto ser lembrado.

Implementação: canvas 2D ou SVG, dados via SSE, `requestAnimationFrame`, desligada por `prefers-reduced-motion` (vira lista estática).

### 11.7 Copy da interface

Regra: nomeie pelo que a pessoa controla, não pela implementação.

| Não escreva | Escreva |
|---|---|
| Webhook config | Conectar plataforma |
| Payload mapping | Combinar campos |
| Job queue | Fila de envio |
| Template variant | Versão do canal |
| Jitter profile | Ritmo de envio |
| Cancel key | Cancelar quando |
| Enviar | Enviar agora |
| Submit | Salvar mensagem |

Erros explicam o que houve e o que fazer, sem pedir desculpa: *"O número não tem WhatsApp. Verifique o cadastro ou desligue este canal para este contato."*
Vazios convidam à ação: *"Nenhum fluxo ainda. Comece pelo modelo de recuperação de PIX — leva 2 minutos."*

---

## 12. API pública e webhooks

### 12.1 Autenticação

```
Authorization: Bearer pulso_live_a1b2c3d4e5f6...
Idempotency-Key: <uuid opcional, evita duplicata em retry>
```

Chaves com prefixo visível (`pulso_live_` / `pulso_test_`), armazenadas como hash SHA-256, escopos por recurso, revogáveis, com registro de último uso.

### 12.2 Endpoints

```
# Ingestão
POST   /in/{ingest_token}              # webhook das plataformas (sem auth, token na URL)
POST   /v1/events                      # ingestão autenticada, formato canônico

# Envio direto
POST   /v1/messages/send               # dispara uma mensagem específica
POST   /v1/messages/send-raw           # texto livre em canais escolhidos
GET    /v1/messages/{id}               # status de um envio
GET    /v1/notifications               # log filtrável

# Contatos
GET    /v1/contacts | POST | PATCH /v1/contacts/{id}
POST   /v1/contacts/{id}/optout        # descadastro programático

# CRM
GET    /v1/leads | POST | PATCH /v1/leads/{id}
GET    /v1/pipelines

# Controle
POST   /v1/flows/{id}/pause | /resume
POST   /v1/channels/{channel}/pause    # pausa de emergência de um canal inteiro
GET    /v1/health                      # status de instâncias, filas, canais
```

**Exemplo de envio direto:**

```json
POST /v1/messages/send
{
  "message_key": "pix_lembrete_1",
  "contact": { "phone": "+5588999999999", "name": "Maria" },
  "channels": ["whatsapp", "email"],
  "variables": {
    "valor": 4990,
    "campanha": "Fiat Argo 2026",
    "link_pagamento": "https://..."
  },
  "schedule_in_seconds": 300,
  "cancel_key": "order:12345"
}
```

### 12.3 Webhooks de saída

Notifica seu sistema (ou o do cliente) sobre o que acontece dentro do Pulso.

Eventos: `message.sent`, `message.delivered`, `message.failed`, `message.read`, `contact.opted_out`, `lead.created`, `lead.stage_changed`, `instance.disconnected`.

Assinatura HMAC-SHA256 no header `X-Pulso-Signature` sobre `timestamp.body`, com tolerância de 5 minutos contra replay. Retry com backoff exponencial (1min, 5min, 30min, 2h, 12h); após 5 falhas seguidas o webhook é desativado e o admin é alertado.

---

## 13. Performance

### 13.1 Orçamento (não negociável)

| Métrica | Alvo |
|---|---|
| ACK do webhook de entrada | < 50 ms (p95) |
| Primeira renderização do painel | < 800 ms |
| Interação pronta (TTI) | < 1,2 s |
| Navegação entre sessões | < 150 ms |
| Busca em 50 mil leads | < 100 ms |
| JS enviado ao cliente (rota inicial) | < 120 KB gzip |
| Consulta do histórico (3 dias) | < 200 ms |

### 13.2 Como chegar lá

**Servidor**
- React Server Components como padrão. `"use client"` apenas em: pads de canal, kanban, barra de pulso, editor de mensagem, filtros do histórico. Todo o resto é HTML.
- Nada de biblioteca de componentes pesada. Radix Primitives (headless, tree-shakeable) + Tailwind.
- `Suspense` com streaming: cabeçalho e navegação aparecem antes dos dados.
- Sem ORM que gere N+1. Drizzle com joins explícitos.

**Banco**
- Todos os índices da seção 3.
- Partições diárias em `notifications`, `events` e `events_raw`.
- Contadores do dashboard vêm de uma tabela de agregados atualizada por trigger, nunca de `COUNT(*)` em tabela grande.
- `pgBouncer` em modo transaction se o número de conexões crescer.
- Busca de leads com índice GIN trigram.

**Cliente**
- Listas virtualizadas (`@tanstack/react-virtual`) em leads e histórico.
- SSE em vez de polling para status ao vivo. Uma conexão, não uma requisição por segundo.
- Atualização otimista em toda ação de baixo risco (arrastar cartão, ligar/desligar pad).
- Fontes com `font-display: swap` e subset latin + latin-ext.
- Ícones como componentes SVG inline, não uma biblioteca inteira.

**Worker**
- Concorrência configurável por fila.
- Conexão Redis compartilhada.
- Renderização de template com cache em memória (compilar uma vez, usar mil vezes).
- Circuit breaker por provedor: 5 falhas seguidas pausa a fila daquele canal por 60s e alerta.

---

## 14. LGPD e conformidade

Isso não é seção jurídica decorativa — é requisito de arquitetura, e a fiscalização da ANPD sobre disparos vem se intensificando. As multas previstas chegam a 2% do faturamento anual, limitadas a R$ 50 milhões por infração.

### 14.1 O que o sistema precisa garantir

**Base legal por tipo de mensagem.** Transacionais (pagamento confirmado, bilhete premiado, saque) se apoiam em execução de contrato — o cliente iniciou a relação. Promocionais (reativação, upsell, nova campanha) exigem consentimento explícito. O Pulso marca cada mensagem com sua `category`, e mensagens promocionais são bloqueadas para contatos sem `optin_at` registrado.

**Consentimento registrado.** `optin_source` + `optin_at` + IP quando disponível. Checkbox nunca pré-marcado. Se o consentimento veio da plataforma de sorteio, o mapeamento do conector deve trazer esse dado.

**Opt-out em quatro caminhos** (todos implementados):
1. Palavra-chave no WhatsApp/SMS: `SAIR`, `PARAR`, `CANCELAR`
2. Link de descadastro no rodapé de todo e-mail (one-click, sem login)
3. Comando `/parar` no bot do Telegram
4. Endpoint de API para a plataforma do cliente

Processamento **imediato**, não em 48h. É trivial tecnicamente e elimina o risco.

**Direitos do titular.** Endpoint e botão no painel para exportar todos os dados de um contato (JSON) e para apagar/anonimizar. Anonimização preserva os agregados estatísticos mas remove nome, telefone, e-mail e CPF.

**Retenção.** Definida e documentada: 3 dias de log quente, 30 de arquivo, 12 meses de agregados anônimos. `events_raw` some em 7 dias.

**Segurança.** Credenciais de provedores criptografadas em repouso (AES-256-GCM, chave em variável de ambiente, nunca no banco). Log de auditoria de todo acesso a dados pessoais. TLS obrigatório. Nenhum dado pessoal em log de aplicação.

### 14.2 Sobre o risco do WhatsApp não-oficial

Seja direto com seus clientes sobre isso, porque é honesto e porque protege você.

A Evolution API não é a API oficial da Meta. Ela funciona bem, é a escolha certa para o seu custo e sua velocidade, mas o número pode ser banido — e um número banido raramente volta. O Pulso mitiga com aquecimento automático, rate limit por instância, spintax, janela de silêncio, respeito a opt-out e rodízio entre números. Isso reduz muito o risco, mas não o zera.

Consequências práticas para o produto:
- Sempre mais de um número conectado, com rodízio
- O número principal do negócio nunca deve ser usado para automação em massa
- Deixe o caminho para a API oficial aberto: o adaptador de canal deve ser trocável, para que um cliente grande possa migrar para WhatsApp Cloud API sem reescrever nada
- No onboarding, um aviso claro e assinado sobre o risco

---

## 15. Plano de implementação (fases para o Claude Code)

Não construa tudo de uma vez. Cada fase entrega algo funcionando de ponta a ponta.

**Fase 1 — Fundação (2–3 dias)**
Docker Compose completo, schema do banco com migrations, autenticação, RBAC, layout base com o design system, navegação em sessões. Entregável: login funciona, painel vazio abre em menos de 1s.

**Fase 2 — Ingestão (2 dias)**
Endpoint de webhook, `events_raw`, deduplicação, tela de conectar plataforma com mapeamento visual, normalização para eventos canônicos, criação/atualização de contatos. Entregável: evento da plataforma de sorteio chega e vira contato + evento normalizado.

**Fase 3 — Mensagens (3 dias)**
CRUD de mensagens, variantes por canal, editor com compilação, variáveis, spintax, pads de canal, pré-visualização lado a lado, contador de segmentos SMS. Entregável: criar uma mensagem e ver as quatro versões.

**Fase 4 — Entrega (3–4 dias)**
BullMQ, filas por canal, adaptadores dos quatro canais, perfis de jitter, janela de silêncio, regras de guarda, envio de teste, aquecimento e rodízio de instâncias. Entregável: botão "enviar teste" entrega em WhatsApp, e-mail, SMS e Telegram.

**Fase 5 — Fluxos (3 dias)**
CRUD de fluxos, editor de passos, agendamento em cascata, **cancelamento por chave**, eventos derivados, os 9 fluxos-modelo. Entregável: o cenário do PIX de 5 minutos funciona, incluindo o cancelamento quando paga antes.

**Fase 6 — Histórico e painel (2 dias)**
Log com SSE ao vivo, filtros, detalhe, reenvio, particionamento e limpeza automática, dashboard com métricas, barra de pulso, alertas. Entregável: operação visível em tempo real.

**Fase 7 — CRM (3 dias)**
Leads com tabela virtualizada, pipeline kanban, criação automática, distribuição, atividades, RLS por consultor. Entregável: consultor loga e vê só o que é dele.

**Fase 8 — API e polimento (2 dias)**
API pública documentada, chaves, webhooks de saída com HMAC, exportações LGPD, auditoria de performance contra o orçamento da seção 13.

---

## 16. Variáveis de ambiente

```bash
# App
NODE_ENV=production
APP_URL=https://app.pulso.com.br
SESSION_SECRET=
ENCRYPTION_KEY=              # 32 bytes hex — criptografa credenciais no banco

# Banco / fila
DATABASE_URL=postgresql://...
REDIS_URL=redis://...

# Evolution API
EVOLUTION_URL=http://evolution:8080
EVOLUTION_GLOBAL_APIKEY=

# E-mail
EMAIL_PROVIDER=resend        # resend | ses | brevo
RESEND_API_KEY=
EMAIL_FROM="Pulso <envio@seudominio.com.br>"

# SMS
SMS_PROVIDER=smsdev          # smsdev | comtele | zenvia
SMS_API_KEY=
SMS_SENDER=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=

# Operação
DEFAULT_TIMEZONE=America/Sao_Paulo
QUIET_HOURS_START=21:00
QUIET_HOURS_END=08:00
LOG_RETENTION_DAYS=3
ARCHIVE_RETENTION_DAYS=30
```

---

## 17. Prompt inicial para o Claude Code

> Copie o bloco abaixo junto com este documento.

```
Você vai construir o PULSO, um sistema de notificações multicanal com CRM leve
para plataformas de sorteio brasileiras. A especificação completa está no arquivo
PULSO-especificacao.md — leia inteiro antes de escrever qualquer código.

Regras de trabalho:

1. Implemente FASE POR FASE, na ordem da seção 15. Não avance para a próxima fase
   sem que a anterior esteja funcionando de ponta a ponta. Ao concluir cada fase,
   pare e me mostre o que foi entregue.

2. Stack fixa: Next.js 15 App Router + TypeScript + Drizzle + PostgreSQL 16 +
   BullMQ/Redis + Tailwind + Radix Primitives. Não adicione dependências fora
   dessa lista sem me perguntar antes.

3. O orçamento de performance da seção 13 é requisito, não sugestão. React Server
   Components por padrão; "use client" só nos componentes listados.

4. Isole cada canal em lib/channels/{whatsapp,email,sms,telegram}.ts atrás de uma
   interface comum. Trocar de provedor deve ser mudar uma variável de ambiente.

5. Os pads de canal (seção 11.4) são o controle mais importante da interface.
   Use exatamente o padrão de filter: grayscale(1) descrito, com role="switch"
   e acessibilidade por teclado.

6. O cancelamento por chave (seção 5.1) é a lógica mais crítica do sistema.
   Escreva testes para ele antes de considerar a Fase 5 concluída.

7. Comece pelo docker-compose.yml e pelas migrations. Quero rodar
   `docker compose up` e ter tudo de pé localmente.

Comece pela Fase 1.
```

---

## 18. Estimativa de custo mensal (operação inicial)

| Item | Custo |
|---|---|
| VPS 4 vCPU / 8 GB (Hetzner CPX31 ou similar) | ~R$ 90 |
| Domínio `.com.br` | ~R$ 4 |
| E-mail (Resend Pro — 50 mil/mês) | ~R$ 110 |
| SMS (uso variável, R$ 0,05–0,08/msg) | conforme uso |
| Telegram | R$ 0 |
| WhatsApp (Evolution, self-hosted) | R$ 0 + custo dos chips |
| Backup externo (object storage) | ~R$ 15 |
| **Base fixa** | **~R$ 220/mês** |

O SMS é o único custo que escala de forma perigosa. É por isso que ele vem desligado por padrão em tudo que não seja recuperação de venda de alto valor.

---

## 19. O que ficou de fora de propósito

Para não inflar o escopo da primeira versão. Cada item é uma boa segunda etapa:

- Editor visual de fluxo em canvas (nó/aresta). A lista de passos resolve 95% dos casos e é muito mais rápida de construir e de usar. Faça o canvas quando um cliente pedir ramificação condicional complexa.
- Testes A/B de mensagem
- Segmentação avançada de base (construtor de audiência)
- Multi-idioma
- App móvel (o painel responsivo cobre)
- Atendimento humano / caixa de entrada unificada
- Relatório de atribuição de receita por fluxo (a métrica "recuperado" do dashboard é a versão simples disso)
