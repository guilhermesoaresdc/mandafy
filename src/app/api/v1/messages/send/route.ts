import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { contacts, messages } from '@/db/schema'
import { CHANNELS } from '@/db/schema/enums'
import { comChave, erro, lerCorpo, ok } from '@/lib/api/responder'
import { enfileirarEnvio } from '@/lib/delivery/enqueue'
import { toE164 } from '@/lib/phone'

/**
 * POST /v1/messages/send (§12.2).
 *
 * Dispara uma mensagem específica para um contato, com variáveis. É o endpoint
 * que a plataforma do cliente chama quando quer controlar o disparo em vez de
 * depender de um fluxo.
 *
 * Passa pelo MESMO caminho de um envio de fluxo: guardas, compilação, jitter,
 * janela de silêncio, fila. Um atalho aqui significaria a API furando as regras
 * que protegem os números — que é o problema que este sistema existe para
 * evitar.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const schema = z.object({
  message_key: z.string().trim().min(1).max(60),
  contact: z.object({
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().max(200).optional(),
    telegram_chat_id: z.number().int().optional(),
    external_id: z.string().trim().max(200).optional(),
    name: z.string().trim().max(200).optional(),
  }),
  channels: z.array(z.enum(CHANNELS)).optional(),
  variables: z.record(z.string(), z.unknown()).default({}),
  schedule_in_seconds: z.number().int().min(0).max(30 * 86400).optional(),
  cancel_key: z.string().trim().max(200).optional(),
  idempotency_key: z.string().trim().max(200).optional(),
})

export async function POST(request: Request): Promise<Response> {
  return comChave(request, 'messages:send', async (tx, ctx) => {
    const bruto = await lerCorpo(request)
    if (!bruto) return erro('corpo_invalido', 'O corpo precisa ser um objeto JSON.')

    const parsed = schema.safeParse(bruto)
    if (!parsed.success) {
      return erro('corpo_invalido', 'Corpo inválido.', parsed.error.issues.slice(0, 5))
    }

    const dados = parsed.data

    const [mensagem] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.key, dados.message_key), eq(messages.orgId, ctx.chave.orgId)))
      .limit(1)

    if (!mensagem) {
      return erro('nao_encontrado', `Nenhuma mensagem com a chave ${dados.message_key}.`)
    }

    const contato = await acharOuCriarContato(tx, ctx.chave.orgId, dados.contact)
    if ('erro' in contato) return erro('corpo_invalido', contato.erro)

    const agora = new Date()
    const quando = dados.schedule_in_seconds
      ? new Date(agora.getTime() + dados.schedule_in_seconds * 1000)
      : agora

    /*
     * O `Idempotency-Key` do header (§12.1) vira o `dedupe_key` do envio. É o
     * que faz um retry do cliente não gerar segunda mensagem para a mesma
     * pessoa — que é o motivo de o header existir.
     */
    const dedupe = ctx.idempotencyKey ?? dados.idempotency_key ?? null

    const resultados = await enfileirarEnvio(
      tx,
      {
        orgId: ctx.chave.orgId,
        contactId: contato.id,
        messageId: mensagem.id,
        ...(dados.channels ? { canais: dados.channels } : {}),
        dados: dados.variables,
        cancelKey: dados.cancel_key ?? null,
        dedupeKey: dedupe,
      },
      quando,
    )

    if (resultados.length === 0) return erro('nao_encontrado', 'Mensagem ou contato não encontrado.')

    const enfileirados = resultados.filter(
      (r) => r.situacao === 'enfileirado' || r.situacao === 'reagendado',
    )

    return ok(
      {
        contact_id: contato.id,
        queued: enfileirados.length,
        results: resultados.map((r) => ({
          channel: r.canal,
          status: r.situacao,
          ...('notificationId' in r ? { notification_id: r.notificationId } : {}),
          ...('quando' in r ? { scheduled_for: r.quando.toISOString() } : {}),
          ...('motivo' in r ? { reason: r.motivo } : {}),
        })),
      },
      enfileirados.length > 0 ? 202 : 200,
    )
  })
}

type DadosContato = z.infer<typeof schema>['contact']

async function acharOuCriarContato(
  tx: Parameters<Parameters<typeof comChave>[2]>[0],
  orgId: string,
  dados: DadosContato,
): Promise<{ id: string } | { erro: string }> {
  const e164 = dados.phone ? toE164(dados.phone) : null
  if (dados.phone && !e164) return { erro: 'Telefone inválido. Use DDD + número.' }

  if (!e164 && !dados.email && dados.telegram_chat_id === undefined && !dados.external_id) {
    return { erro: 'Informe ao menos telefone, e-mail, telegram_chat_id ou external_id.' }
  }

  // Ordem de busca: external_id, telefone, e-mail. O external_id vem primeiro
  // por ser o identificador da plataforma, que não muda.
  for (const [coluna, valor] of [
    [contacts.externalId, dados.external_id],
    [contacts.phoneE164, e164],
    [contacts.email, dados.email],
  ] as const) {
    if (!valor) continue

    const [achado] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(coluna, valor)))
      .limit(1)

    if (achado) return achado
  }

  const [criado] = await tx
    .insert(contacts)
    .values({
      orgId,
      externalId: dados.external_id ?? null,
      name: dados.name ?? null,
      phoneE164: e164,
      email: dados.email ?? null,
      telegramChatId: dados.telegram_chat_id ?? null,
      // Quem chama a API afirma ter a base legal; registramos a origem para a
      // auditoria poder cobrar isso depois (§14.1).
      optinSource: 'api',
      optinAt: new Date(),
    })
    .returning({ id: contacts.id })

  return criado ?? { erro: 'Não foi possível criar o contato.' }
}
