import { withTenant } from '@/db'
import { novidadesDesde, paramLista, type LinhaHistorico } from '@/db/queries/historico'
import { CHANNELS, NOTIFICATION_STATUSES, type Channel, type NotificationStatus } from '@/db/schema/enums'
import { getCurrentUser, tenantOf } from '@/lib/auth/current'
import { createLogger } from '@/lib/logger'

/**
 * Histórico ao vivo por SSE (§10.1).
 *
 * SSE e não polling porque §13.2 é explícita: uma conexão, não uma requisição
 * por segundo. Com 5 operadores olhando a tela, o polling de 1s daria 432 mil
 * consultas por dia contra a tabela de maior escrita do sistema.
 *
 * SSE e não WebSocket porque o tráfego é de mão única, atravessa proxy sem
 * configuração especial e reconecta sozinho no navegador.
 */

export const dynamic = 'force-dynamic'
/** Node, não Edge: a conexão com o Postgres não existe no runtime Edge. */
export const runtime = 'nodejs'

const log = createLogger('sse')

/** Intervalo entre varreduras. Não é polling do CLIENTE — é uma consulta só. */
const INTERVALO_MS = 2_000
/** Sem isto, proxy e balanceador derrubam a conexão por ociosidade. */
const KEEPALIVE_MS = 25_000
/** Teto de vida da conexão. O navegador reconecta sozinho. */
const MAX_MS = 10 * 60_000

export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) return new Response('não autenticado', { status: 401 })

  const url = new URL(request.url)
  const canais = paramLista<Channel>(url.searchParams.get('canais'), CHANNELS)
  const status = paramLista<NotificationStatus>(url.searchParams.get('status'), NOTIFICATION_STATUSES)
  const busca = url.searchParams.get('busca') ?? undefined

  const filtro = {
    ...(canais ? { canais } : {}),
    ...(status ? { status } : {}),
    ...(busca ? { busca } : {}),
    // Consultor só vê o que saiu para os leads dele (§9.4).
    ownerId: user.isAdmin ? null : user.id,
  }

  const ctx = tenantOf(user)
  const codificador = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let vivo = true
      // Começa no instante da conexão: o carregamento inicial da página já
      // trouxe o passado, e reenviá-lo duplicaria tudo na tela.
      let cursor = new Date()

      const enviar = (evento: string, dados: unknown): void => {
        if (!vivo) return
        try {
          controller.enqueue(
            codificador.encode(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`),
          )
        } catch {
          vivo = false
        }
      }

      const encerrar = (): void => {
        if (!vivo) return
        vivo = false
        clearInterval(varredura)
        clearInterval(keepalive)
        clearTimeout(limite)
        try {
          controller.close()
        } catch {
          // Já fechado pelo cliente.
        }
      }

      // `retry` diz ao navegador quanto esperar antes de reconectar sozinho.
      enviar('pronto', { desde: cursor.toISOString(), retry: 3000 })
      controller.enqueue(codificador.encode('retry: 3000\n\n'))

      const varredura = setInterval(() => {
        if (!vivo) return

        void withTenant(ctx, (tx) => novidadesDesde(tx, cursor, filtro))
          .then((linhas: LinhaHistorico[]) => {
            // Avança o cursor SEMPRE, não só quando há novidade: senão uma
            // linha atualizada duas vezes no mesmo segundo seria reenviada em
            // laço até o fim da conexão.
            cursor = new Date()
            if (linhas.length > 0) enviar('linhas', linhas)
          })
          .catch((erro: unknown) => {
            // Sem dado pessoal no log (§14.1).
            log.error('falha na varredura do stream', {
              reason: erro instanceof Error ? erro.message : 'desconhecido',
            })
          })
      }, INTERVALO_MS)

      const keepalive = setInterval(() => {
        if (!vivo) return
        try {
          // Comentário SSE: o cliente ignora, o proxy vê tráfego.
          controller.enqueue(codificador.encode(': ping\n\n'))
        } catch {
          encerrar()
        }
      }, KEEPALIVE_MS)

      const limite = setTimeout(encerrar, MAX_MS)

      request.signal.addEventListener('abort', encerrar)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Desliga o buffer do nginx, que seguraria os eventos até encher.
      'x-accel-buffering': 'no',
    },
  })
}
