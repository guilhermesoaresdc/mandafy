import { withTenant } from '@/db'
import { listarHistorico } from '@/db/queries/historico'
import { CHANNELS, NOTIFICATION_STATUSES, type Channel, type NotificationStatus } from '@/db/schema/enums'
import { getCurrentUser, tenantOf } from '@/lib/auth/current'

/**
 * Exportar CSV do que estiver filtrado (§10.1).
 *
 * Sai como fluxo e não como string montada na memória: um recorte de 3 dias
 * numa operação grande são dezenas de milhares de linhas, e concatenar tudo
 * antes de responder derruba o processo por memória.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const LIMITE = 5_000

/**
 * Escapa um campo.
 *
 * O `\t` na frente de valores que começam com `=`, `+`, `-` ou `@` não é
 * capricho: Excel e Google Sheets interpretam esses como FÓRMULA, e um nome de
 * contato começando com `=` viraria execução de célula ao abrir a planilha.
 */
function campo(valor: unknown): string {
  if (valor === null || valor === undefined) return ''

  const texto = valor instanceof Date ? valor.toISOString() : String(valor)
  const perigoso = /^[=+\-@]/.test(texto)
  const escapado = (perigoso ? `\t${texto}` : texto).replace(/"/g, '""')

  return `"${escapado}"`
}

function lista<T extends string>(valor: string | null, validos: readonly T[]): T[] | undefined {
  if (!valor) return undefined
  const itens = valor.split(',').filter((v): v is T => (validos as readonly string[]).includes(v))
  return itens.length > 0 ? itens : undefined
}

export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) return new Response('não autenticado', { status: 401 })

  const url = new URL(request.url)
  const canais = lista<Channel>(url.searchParams.get('canais'), CHANNELS)
  const status = lista<NotificationStatus>(url.searchParams.get('status'), NOTIFICATION_STATUSES)
  const busca = url.searchParams.get('busca') ?? undefined
  const horas = Number(url.searchParams.get('horas') ?? 72)

  const linhas = await withTenant(tenantOf(user), (tx) =>
    listarHistorico(tx, {
      ...(canais ? { canais } : {}),
      ...(status ? { status } : {}),
      ...(busca ? { busca } : {}),
      horas: Number.isFinite(horas) ? Math.min(Math.max(horas, 1), 72) : 72,
      ownerId: user.isAdmin ? null : user.id,
      limite: LIMITE,
    }),
  )

  const cabecalho = [
    'quando',
    'canal',
    'status',
    'contato',
    'mensagem',
    'agendado_para',
    'enviado_em',
    'entregue_em',
    'erro',
    'latencia_ms',
  ]

  const codificador = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // BOM: sem ele o Excel em português abre o arquivo em Latin-1 e todo
      // acento vira caractere quebrado.
      controller.enqueue(codificador.encode('﻿'))
      controller.enqueue(codificador.encode(`${cabecalho.join(',')}\n`))

      for (const linha of linhas) {
        controller.enqueue(
          codificador.encode(
            [
              campo(linha.createdAt),
              campo(linha.channel),
              campo(linha.status),
              campo(linha.contactName),
              campo(linha.messageKey),
              campo(linha.scheduledFor),
              campo(linha.sentAt),
              campo(linha.deliveredAt),
              campo(linha.errorCode),
              campo(linha.latenciaMs),
            ].join(',') + '\n',
          ),
        )
      }

      controller.close()
    },
  })

  const carimbo = new Date().toISOString().slice(0, 10)

  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="mandafy-historico-${carimbo}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
