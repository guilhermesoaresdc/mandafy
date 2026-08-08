import type { Metadata } from 'next'
import Link from 'next/link'
import { withTenant } from '@/db'
import { listarFluxos } from '@/db/queries/flows'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, BotaoAcao, Button, Card, CardBody, EmptyState } from '@/components/ui'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { alternarFluxoAction, criarFluxosModeloAction } from './actions'
import { descreverEvento } from '@/lib/vocabulario'

export const metadata: Metadata = { title: 'Fluxos · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function FluxosPage() {
  const user = await requireAdmin()

  const lista = await withTenant(tenantOf(user), listarFluxos)

  return (
    /*
     * A descrição diz de onde vêm os eventos.
     *
     * Quem procura "como gero o webhook" vem para cá primeiro — o fluxo é o que
     * reage ao evento, então parece o lugar. Não é: o endereço nasce na
     * plataforma conectada, uma tela adiante. Uma frase aqui economiza a
     * procura.
     */
    <SessionFrame
      title="Fluxos"
      description="O que dispara, quando sai, e o que faz parar. Os eventos chegam da sua plataforma — o endereço de webhook fica em Configurações → Plataformas."
    >
      {lista.length === 0 ? (
        /*
         * Vazio convida à ação (§11.7) — e a ação fica AQUI.
         *
         * Este texto mandava rodar `npm run db:seed`. Quem opera o Mandafy
         * trabalha pelo navegador: a instrução era uma porta sem maçaneta. Pior,
         * era desnecessária — o mesmo trabalho já existia num botão escondido em
         * Configurações → Sistema, onde ninguém procura quando o que falta é um
         * fluxo.
         */
        <EmptyState
          title="Nenhum fluxo ainda"
          description="Comece pela recuperação de PIX: ela avisa quem gerou o pagamento e não pagou, e para sozinha no instante em que o pagamento entra. Todos chegam pausados — você lê o texto antes de ligar."
          action={
            <BotaoAcao
              acao={criarFluxosModeloAction}
              rotulo="Trazer os nove fluxos prontos"
              rotuloOcupado="Trazendo…"
            />
          }
        />
      ) : (
        <div className="flex max-w-3xl flex-col gap-2">
          {lista.map((fluxo) => (
            <Card key={fluxo.id}>
              <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-48 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-xs font-medium text-ink">{fluxo.name}</p>
                    {fluxo.active ? (
                      <Badge tone="ok">ativo</Badge>
                    ) : (
                      <Badge tone="pending">pausado</Badge>
                    )}
                    {fluxo.cancelOn.length > 0 ? (
                      <Badge tone="pending">para sozinho</Badge>
                    ) : null}
                    {fluxo.temMensagemPausada ? (
                      <Badge tone="fail">mensagem pausada</Badge>
                    ) : null}
                  </div>

                  {/*
                    O NOME DO EVENTO, e o código na dica.

                    `order.created · 4 passos` obrigava a decorar um dicionário
                    para ler a própria banca. O dicionário existe desde sempre
                    em `vocabulario.ts` e era usado em outras telas — esta
                    imprimia o identificador cru, em font-mono, como se fosse
                    para um programador. O código sobrevive no `title`, onde
                    serve a quem for integrar sem atrapalhar quem for operar.
                  */}
                  <p className="mt-0.5 text-2xs text-pending" title={fluxo.triggerEvent}>
                    {descreverEvento(fluxo.triggerEvent).nome} · {fluxo.passos} mensagem
                    {fluxo.passos === 1 ? '' : 's'}
                    {fluxo.ritmo ? ` · ${fluxo.ritmo}` : ''}
                  </p>
                </div>

                <form action={alternarFluxoAction}>
                  <input type="hidden" name="id" value={fluxo.id} />
                  <input type="hidden" name="ativar" value={fluxo.active ? '0' : '1'} />
                  <Button type="submit" variant="ghost" size="sm">
                    {fluxo.active ? 'Pausar' : 'Ativar'}
                  </Button>
                </form>

                <Button asChild variant="secondary" size="sm">
                  <Link href={`/fluxos/${fluxo.id}`}>Abrir</Link>
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </SessionFrame>
  )
}
