import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { withTenant } from '@/db'
import { sources } from '@/db/schema'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { eventosPorTipo, resumoNoAr } from '@/db/queries/no-ar'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { serverEnv } from '@/env'
import { eventosRecebidos, ultimoPayload } from '../actions'
import { MAPEAMENTO_SUGERIDO } from '@/lib/ingest/mapping'
import { descreverEvento } from '@/lib/vocabulario'
import { PassoEndereco } from './passo-endereco'
import { UltimoEventoRecebido } from './ultimo-evento'
import { EventosRecebidos } from './recebidos'
import { CombinarCampos } from './combinar-campos'

export const metadata: Metadata = { title: 'Conectar plataforma · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * A tradução que o Mandafy TRAZ DE FÁBRICA — que não é a que ele usa.
 *
 * Quem traduz o evento na hora da ingestão é `sources.mapping`, o mapa SALVO
 * desta plataforma. Esta constante é só o ponto de partida oferecido na tela.
 *
 * Enquanto o passo 2 lia daqui, ele afirmava "O Mandafy entende
 * `payment-by-deposit` como `order.paid`" logo abaixo de "não foi aproveitado:
 * não está no mapa de eventos" — as duas frases na mesma tela, uma contradizendo
 * a outra, e a errada era a tranquilizadora. Quem lesse concluía que o
 * mapeamento estava certo e ia procurar o problema em qualquer outro lugar.
 */
const DE_FABRICA: Record<string, string | undefined> = MAPEAMENTO_SUGERIDO.event_map ?? {}

/** O `event_map` gravado nesta plataforma — o único que o motor consulta. */
function mapaSalvo(mapping: unknown): Record<string, string | undefined> {
  if (!mapping || typeof mapping !== 'object') return {}
  const bruto = (mapping as { event_map?: unknown }).event_map
  return bruto && typeof bruto === 'object' ? (bruto as Record<string, string>) : {}
}

/**
 * Conectar plataforma, em três passos (§4.2).
 *
 * A numeração aparece porque aqui a ordem realmente importa — não como enfeite
 * (§11.5, nível 2).
 */
export default async function PlataformaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireAdmin()

  const { plataforma, recebidos, noAr } = await withTenant(tenantOf(user), async (tx) => {
    const [linha] = await tx
      .select({
        id: sources.id,
        name: sources.name,
        active: sources.active,
        ingestToken: sources.ingestToken,
        mapping: sources.mapping,
      })
      .from(sources)
      .where(eq(sources.id, id))
      .limit(1)

    return {
      plataforma: linha,
      /*
       * As duas leituras precisam sair do MESMO withTenant do fluxo, senão o
       * cruzamento "quem escuta este evento" compara organizações diferentes —
       * e um aviso mentiroso é pior que aviso nenhum.
       */
      recebidos: linha ? await eventosPorTipo(tx, linha.id) : [],
      noAr: linha ? await resumoNoAr(tx) : null,
    }
  })

  if (!plataforma) notFound()

  const [ultimo, recebidosCrus] = await Promise.all([
    ultimoPayload(plataforma.id),
    eventosRecebidos(plataforma.id),
  ])

  const salvo = mapaSalvo(plataforma.mapping)
  const nomeDoUltimo = ultimo?.nome ?? ''

  let base = 'https://mandafy.vercel.app'
  try {
    base = serverEnv().APP_URL
  } catch {
    // Ambiente incompleto não pode derrubar a tela; a URL é ilustrativa.
  }
  const enderecoWebhook = `${base}/in/${plataforma.ingestToken}`

  return (
    <SessionFrame
      title={plataforma.name}
      description="Três passos: apontar o endereço, receber um evento, combinar os campos."
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/configuracoes/plataformas">Voltar</Link>
        </Button>
      }
    >
      <div className="flex max-w-3xl flex-col gap-4 pb-8">
        <PassoEndereco endereco={enderecoWebhook} />

        <Card>
          <CardHeader>
            <CardTitle>
              <span className="mr-2 font-mono text-2xs text-pending">2</span>
              Receber um evento
            </CardTitle>
            {ultimo ? <Badge tone="ok">recebido</Badge> : <Badge tone="pending">aguardando</Badge>}
          </CardHeader>
          <CardBody>
            {ultimo ? (
              /*
                O QUE chegou, e não só QUANDO.
                
                A tela dizia "Último evento em 05/08/2026, 13:53:08" e parava
                aí. Quem acabou de criar uma conta de teste na plataforma não
                tinha como saber se o que chegou foi o cadastro, o pagamento ou
                outra coisa qualquer — nem se chegou a virar disparo. Hora sem
                nome não confirma nada.
              */
              <UltimoEventoRecebido
                evento={ultimo}
                fuso={user.timezone}
                // O mapa SALVO, que é o que decide o destino do evento.
                traduzido={salvo[nomeDoUltimo] ?? null}
                // E o de fábrica, para dizer "dá para resolver num clique"
                // quando ele conhece um nome que o salvo não tem.
                deFabrica={DE_FABRICA[nomeDoUltimo] ?? null}
              />
            ) : (
              <p className="text-xs text-ink-2">
                Dispare um evento de teste na plataforma — criar uma conta já serve. Assim que ele
                chegar, o conteúdo dele aparece aqui e os campos vão para o passo 3.
              </p>
            )}
          </CardBody>
        </Card>

        {/*
          O HISTÓRICO DO QUE CHEGOU, e não só o último.

          Um evento por vez responde "chegou alguma coisa?" e nada mais. Quem
          liga a plataforma dispara vários seguidos para conferir, e cada novo
          apagava o anterior da vista: com o cadastro funcionando e o pagamento
          não, a tela mostrava só o pagamento — e a conclusão era "nada funciona".
        */}
        {recebidosCrus.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Histórico deste webhook</CardTitle>
              <span className="text-2xs text-pending">os {recebidosCrus.length} mais recentes</span>
            </CardHeader>
            <CardBody>
              <EventosRecebidos sourceId={plataforma.id} eventos={recebidosCrus} fuso={user.timezone} />
            </CardBody>
          </Card>
        ) : null}

        {/*
          O que a plataforma manda DE VERDADE.
          
          Antes disto a tela mostrava um único payload — o último — e a lista de
          plataformas, um total bruto sem quebra por tipo. Quem estava
          conectando tinha de adivinhar quais eventos a própria plataforma
          dispara, e não tinha como saber se algum deles chegava sem ninguém
          escutando do outro lado.
        */}
        {recebidos.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>O que esta plataforma manda</CardTitle>
              <span className="text-2xs text-pending">últimos 7 dias</span>
            </CardHeader>
            <CardBody className="flex flex-col gap-1.5">
              {recebidos.map((evento) => {
                const ouvintes = (noAr?.fluxos ?? []).filter(
                  (f) => f.active && f.triggerEvent === evento.type,
                )

                return (
                  <div key={evento.type} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {/*
                      O NOME, e o código em cinza ao lado. Esta lista responde
                      "o que esta plataforma manda" — e `withdrawal.pending` não
                      responde isso a quem toca a banca. O código continua
                      visível porque é ele que aparece no gatilho do fluxo.
                    */}
                    <span className="min-w-44 text-2xs text-ink">
                      {descreverEvento(evento.type).nome}
                      <span className="ml-1.5 font-mono text-pending">{evento.type}</span>
                    </span>
                    <span className="text-2xs text-pending">
                      {evento.total}× · último em{' '}
                      {evento.ultimo.toLocaleString('pt-BR', { timeZone: user.timezone })}
                    </span>
                    {ouvintes.length > 0 ? (
                      <Badge tone="ok">{ouvintes.map((f) => f.name).join(', ')}</Badge>
                    ) : (
                      <Badge tone="pending">nenhum fluxo escuta</Badge>
                    )}
                  </div>
                )
              })}
            </CardBody>
          </Card>
        ) : null}

        <CombinarCampos
          sourceId={plataforma.id}
          mapping={plataforma.mapping}
          payload={ultimo?.payload ?? null}
          // Todos os nomes que já chegaram, para o passo 3 poder acrescentar de
          // uma vez os que faltam em vez de um por disparo.
          nomesRecebidos={recebidosCrus.map((e) => e.nome).filter((n): n is string => Boolean(n))}
        />
      </div>
    </SessionFrame>
  )
}
