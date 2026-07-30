# API pública do Mandafy

Base: `https://seu-dominio/api/v1`

## Autenticação

```http
Authorization: Bearer mandafy_live_a1b2c3d4…
Idempotency-Key: 6f1e…            # opcional, evita duplicata em retry
```

Crie a chave em **Configurações → API**. Ela aparece **uma vez** — guardamos só
o resumo criptográfico, e nem nós conseguimos recuperá-la depois.

Marque só os escopos necessários. Uma chave que vaza faz exatamente o que você
deixou marcado.

| Ambiente | Prefixo |
|---|---|
| Produção | `mandafy_live_` |
| Teste | `mandafy_test_` |

### Erros

Todo erro sai no mesmo formato:

```json
{ "error": { "code": "sem_permissao", "message": "Esta chave não tem o escopo messages:send." } }
```

| HTTP | `code` | Quando |
|---|---|---|
| 401 | `sem_credencial` | Sem header `Authorization` |
| 401 | `credencial_invalida` | Chave desconhecida ou revogada |
| 403 | `sem_permissao` | A chave não tem o escopo |
| 404 | `nao_encontrado` | Recurso inexistente |
| 422 | `corpo_invalido` | JSON malformado ou campo faltando |
| 500 | `erro_interno` | Falha nossa |

Chave desconhecida e chave revogada devolvem a **mesma** resposta, de propósito:
distinguir contaria a um atacante que a chave existiu.

---

## Envio direto

### `POST /v1/messages/send`

Escopo: `messages:send`

```json
{
  "message_key": "pix_lembrete_1",
  "contact": { "phone": "+5588999999999", "name": "Maria" },
  "channels": ["whatsapp", "email"],
  "variables": {
    "valor_cents": 4990,
    "campanha": "Fiat Argo 2026",
    "link_pagamento": "https://…"
  },
  "schedule_in_seconds": 300,
  "cancel_key": "order:12345"
}
```

O contato é encontrado por `external_id`, telefone ou e-mail, nessa ordem; se não
existir, é criado.

O envio passa pelo **mesmo caminho** de um disparo por fluxo: regras de guarda,
compilação, ritmo de envio, janela de silêncio e fila. Não há atalho — a API
furando as regras que protegem os números seria o oposto do que este sistema faz.

Resposta `202`:

```json
{
  "contact_id": "…",
  "queued": 2,
  "results": [
    { "channel": "whatsapp", "status": "enfileirado", "notification_id": "…", "scheduled_for": "…" },
    { "channel": "email", "status": "enfileirado", "notification_id": "…", "scheduled_for": "…" }
  ]
}
```

`status` pode ser `enfileirado`, `reagendado` (caiu na janela de silêncio),
`pulado` (uma regra de guarda barrou — o motivo vem em `reason`) ou `falhou`.

O `cancel_key` é o que permite cancelar tudo de uma vez depois. Use o mesmo
valor que o evento de pagamento vai trazer — normalmente `order:{id do pedido}`.

### `GET /v1/messages/{id}`

Escopo: `messages:read`

Aceita `?created_at=…` (ISO). Sem ele, procura nos 3 dias da camada quente.

---

## Eventos

### `POST /v1/events`

Escopo: `events:write`

Ingestão no formato canônico, já mapeado. Para o payload cru da sua plataforma,
use `POST /in/{token}`, que passa pelo mapeamento visual.

```json
{
  "type": "order.paid",
  "external_id": "PED-12345",
  "contact": { "phone": "+5588999999999", "name": "Maria" },
  "data": { "valor_cents": 4990, "campanha": "Fiat Argo 2026" }
}
```

Um `order.paid` aqui **cancela** os lembretes agendados com a chave
correspondente — é o mesmo motor de §5.1.

---

## Contatos

| Método | Rota | Escopo |
|---|---|---|
| `GET` | `/v1/contacts?search=&limit=&offset=` | `contacts:read` |
| `POST` | `/v1/contacts/{id}/optout` | `contacts:write` |

O opt-out aceita `{ "channel": "sms" }` para sair de um canal só. Sem `channel`,
sai de todos. **Processamento imediato**, não em 48h.

O CPF nunca sai pela API. Ele interessa à plataforma que o coletou, e é o dado
cujo vazamento custa mais caro.

---

## CRM

| Método | Rota | Escopo |
|---|---|---|
| `GET` | `/v1/leads?search=&limit=&offset=` | `leads:read` |

---

## Operação

### `GET /v1/health`

Escopo: `messages:read`

Fila, saúde por canal e estado de cada número de WhatsApp — incluindo estágio de
aquecimento e uso do teto diário.

---

## Webhooks de saída

Configure em **Configurações → API**. Eventos disponíveis:

`message.sent` · `message.delivered` · `message.failed` · `message.read` ·
`contact.opted_out` · `lead.created` · `lead.stage_changed` ·
`instance.disconnected`

### Validando a assinatura

Cada entrega leva o header `X-Mandafy-Signature`:

```
X-Mandafy-Signature: t=1785441794,v1=5f3a…
```

O `v1` é HMAC-SHA256 sobre `timestamp + "." + corpo`, com o segredo do webhook.

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function valida(corpo, cabecalho, segredo) {
  const partes = Object.fromEntries(cabecalho.split(',').map((p) => p.split('=')))
  const idade = Math.abs(Math.floor(Date.now() / 1000) - Number(partes.t))

  // Rejeite o que for velho: o timestamp entra na assinatura justamente para
  // que uma entrega capturada não possa ser reenviada depois.
  if (idade > 300) return false

  const esperada = createHmac('sha256', segredo).update(`${partes.t}.${corpo}`).digest('hex')
  const a = Buffer.from(partes.v1, 'utf8')
  const b = Buffer.from(esperada, 'utf8')

  return a.length === b.length && timingSafeEqual(a, b)
}
```

Assine sobre o **corpo cru**, antes de qualquer parse — reserializar o JSON muda
os bytes e a assinatura deixa de bater.

### Retentativas

1 min → 5 min → 30 min → 2 h → 12 h. Após **5 falhas seguidas** o webhook é
desativado e aparece assim no painel. Uma entrega bem-sucedida zera o contador.

---

## Direitos do titular (LGPD)

Pelo painel, em **Configurações → Privacidade**: buscar a pessoa, exportar tudo
em JSON, anonimizar ou descadastrar.

Anonimizar remove nome, telefone, e-mail e CPF, e limpa o texto das mensagens já
enviadas — é lá que o nome aparece por extenso. Os agregados continuam, sem
ligação com a pessoa.

Anonimizar em vez de apagar é decisão de arquitetura: apagar a linha levaria
junto o histórico de envios, e o sistema perderia a capacidade de provar o que
fez — que é justamente o que uma fiscalização pede.

### Retenção

| Camada | Prazo |
|---|---|
| Log quente | 3 dias |
| Arquivo | 30 dias |
| Agregados anônimos | 12 meses |
| Payload cru das plataformas | 7 dias |
