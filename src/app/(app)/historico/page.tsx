import type { Metadata } from 'next'
import { withTenant } from '@/db'
import { contarHistorico, listarHistorico, paramLista } from '@/db/queries/historico'
import { SessionFrame } from '@/components/shell/app-shell'
import {
  CHANNELS,
  NOTIFICATION_STATUSES,
  type Channel,
  type NotificationStatus,
} from '@/db/schema/enums'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { LogAoVivo, type LinhaLog } from './log'

export const metadata: Metadata = { title: 'Histórico · Mandafy' }
export const dynamic = 'force-dynamic'

/** Quantas linhas a tela carrega de uma vez. O resto é filtro, não rolagem. */
const LIMITE = 200

/**
 * O histórico (§10.1).
 *
 * A TELA PASSA A ACEITAR SER APONTADA
 *
 * Ela não tinha `searchParams`. Isso não era uma limitação de conforto: os
 * alertas do painel sabiam exatamente o que a pessoa precisava ver — "WhatsApp
 * falhando em 40%" — e não tinham como levá-la até lá, então escreviam por
 * extenso "Abra o histórico filtrado por este canal" e deixavam o filtro por
 * conta dela. Uma tela que não aceita ser apontada obriga toda outra tela que
 * saiba de um problema a descrever o caminho em vez de abri-lo.
 *
 * E A BUSCA DEIXA DE PROCURAR EM DOIS LUGARES DIFERENTES
 *
 * A mesma caixa procurava na base inteira quando alguém baixava a planilha (o
 * link do CSV manda `busca` ao servidor, que faz ILIKE em nome, telefone e
 * e-mail) e em 200 linhas quando olhava a tela — o filtro era em memória, sobre
 * a fatia já carregada. Duas respostas para a mesma pergunta, e a da tela era a
 * errada: "não achei" queria dizer "não estava nas 200 primeiras".
 */
export default async function HistoricoPage({
  searchParams,
}: {
  searchParams: Promise<{ canais?: string; status?: string; horas?: string; busca?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const horas = Number(params.horas)
  const filtro = {
    canais: paramLista<Channel>(params.canais, CHANNELS),
    status: paramLista<NotificationStatus>(params.status, NOTIFICATION_STATUSES),
    ...(Number.isFinite(horas) && horas > 0 ? { horas } : {}),
    ...(params.busca?.trim() ? { busca: params.busca.trim() } : {}),
    // Consultor só vê o que saiu para os leads dele (§9.4). O RLS protege o
    // banco; isto é o recorte da tela.
    ownerId: user.isAdmin ? null : user.id,
  }

  const { linhas, total } = await withTenant(tenantOf(user), async (tx) => ({
    linhas: await listarHistorico(tx, { ...filtro, limite: LIMITE }),
    /*
     * A contagem é uma segunda consulta de propósito: `count(*)` com os mesmos
     * filtros e sem `LIMIT` é o único jeito de o rodapé dizer "200 de 5.000"
     * em vez de "200 de 200" — que é o que ele dizia, sempre, medindo o array
     * que já tinha na mão contra ele mesmo.
     */
    total: await contarHistorico(tx, filtro),
  }))

  // Datas viram string na fronteira servidor→cliente: um `Date` atravessa a
  // serialização como string de qualquer forma, e ser explícito evita o tipo
  // mentir sobre o que chega do outro lado.
  const iniciais: LinhaLog[] = linhas.map((l) => ({
    id: l.id,
    createdAt: l.createdAt.toISOString(),
    channel: l.channel,
    status: l.status,
    contactId: l.contactId,
    contactName: l.contactName,
    messageKey: l.messageKey,
    scheduledFor: l.scheduledFor?.toISOString() ?? null,
    errorCode: l.errorCode,
    latenciaMs: l.latenciaMs,
  }))

  return (
    <SessionFrame
      title="Histórico"
      description={
        user.isAdmin
          ? 'Os últimos 3 dias, ao vivo. Clique numa linha para ver exatamente o que saiu.'
          : 'Os últimos 3 dias dos seus leads.'
      }
    >
      <LogAoVivo
        inicial={iniciais}
        total={total}
        podeReenviar={can(user, 'mensagem.enviar_manual')}
        canaisIniciais={filtro.canais ?? null}
        statusIniciais={filtro.status ?? null}
        buscaInicial={filtro.busca ?? ''}
      />
    </SessionFrame>
  )
}
