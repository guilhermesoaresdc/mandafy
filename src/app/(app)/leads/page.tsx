import type { Metadata } from 'next'
import { withTenant } from '@/db'
import { etapasDoPipeline,
  montarPipeline,
  consultoresAtivos,
  contarLeads,
  filtroSalvo,
  FILTROS_SALVOS,
  listarLeads,
  novosLeads,
  type FiltroLeads,
  type FiltroSalvo,
} from '@/db/queries/leads'
import { listarMensagensParaDisparo } from '@/db/queries/messages'
import { SessionFrame } from '@/components/shell/app-shell'
import { Card, CardBody, Stat } from '@/components/ui'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { formatNumber } from '@/lib/utils'
import Link from 'next/link'
import { TabelaLeads, type LinhaLead } from './tabela'
import { Kanban } from '../pipeline/kanban'

export const metadata: Metadata = { title: 'Leads · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * Quantos leads a tela carrega de uma vez.
 *
 * Era um `1000` solto repetido em dois lugares — e mudar um sem o outro faria
 * a lista e a contagem discordarem em silêncio, que é exatamente o defeito que
 * este commit conserta.
 */
const LIMITE = 1000

function ehFiltroSalvo(valor: string | undefined): valor is FiltroSalvo {
  return FILTROS_SALVOS.some((f) => f.chave === valor)
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; vista?: string }>
}) {
  const user = await requireUser()
  const { filtro: chave, vista } = await searchParams
  /*
   * DUAS TELAS PARA A MESMA LISTA VIRAM UMA COM DUAS VISTAS.
   *
   * `/leads` e `/pipeline` mostravam os mesmos leads, cada uma fazendo o que a
   * outra não fazia: a lista busca, exporta e dispara em lote; o funil mostra a
   * etapa e deixa mover. Quem quisesse "mover os 200 que acabaram de receber"
   * precisava das duas, alternando pelo menu. Um item de menu a menos, e a
   * mesma pergunta deixa de ter dois lugares para ser feita.
   */
  const noFunil = vista === 'funil'

  // Consultor não vê os filtros de outra pessoa; o RLS já limita o resultado,
  // isto só define o recorte pedido.
  const filtro: FiltroLeads = ehFiltroSalvo(chave) ? filtroSalvo(chave, user.id) : {}

  const { linhas, total, consultores, novos, mensagens, etapas, colunas } = await withTenant(
    tenantOf(user),
    async (tx) => ({
      linhas: await listarLeads(tx, { ...filtro, limite: LIMITE }),
      /*
       * A contagem passa a usar O MESMO FILTRO da lista.
       *
       * Ela contava a organização inteira enquanto a tabela mostrava um
       * recorte, e os dois números apareciam lado a lado como se falassem da
       * mesma coisa: "Leads 5.000" no alto, "1.000 de 1.000" no rodapé. Um dos
       * dois estava sempre errado, dependendo de qual pergunta a pessoa
       * achasse que estava fazendo.
       */
      total: await contarLeads(tx, filtro),
      consultores: user.isAdmin ? await consultoresAtivos(tx, user.orgId) : [],
      novos: await novosLeads(tx),
      // As etapas alimentam o seletor da ficha: mover de etapa é a ação mais
      // comum do funil e era a que exigia sair da lista.
      etapas: await etapasDoPipeline(tx),
      // O funil só é montado quando é ele que vai aparecer: são mais consultas
      // e nenhuma delas serve à lista.
      colunas: noFunil ? await montarPipeline(tx) : null,
      mensagens: await listarMensagensParaDisparo(tx),
    }),
  )

  const paraTabela: LinhaLead[] = linhas.map((l) => ({
    id: l.id,
    title: l.title,
    valueCents: l.valueCents,
    status: l.status,
    stageId: l.stageId,
    stageName: l.stageName,
    stageColor: l.stageColor,
    ownerId: l.ownerId,
    ownerName: l.ownerName,
    contactName: l.contactName,
    contactPhone: l.contactPhone,
    contactEmail: l.contactEmail,
    source: l.source,
    nextActionAt: l.nextActionAt?.toISOString() ?? null,
    lastEventAt: l.lastEventAt?.toISOString() ?? null,
  }))

  return (
    <SessionFrame
      title="Leads"
      description={
        user.isAdmin
          ? 'Todo mundo que passou por aqui. Os leads nascem sozinhos conforme os eventos chegam.'
          : 'Os seus leads.'
      }
      /*
       * Importar e exportar andam juntos no cabeçalho porque são o mesmo
       * trabalho visto dos dois lados: tirar a base para ajustar na planilha e
       * trazê-la de volta. Separá-los em telas distintas faria procurar.
       */
      actions={
        <>
          {/*
            As duas vistas da mesma lista, lado a lado. Um item de menu a
            menos, e a pergunta "quem são meus leads?" deixa de ter dois
            lugares para ser feita.
          */}
          <div className="flex overflow-hidden rounded-lg border border-line">
            {[
              { rotulo: 'Lista', href: '/leads', ativo: !noFunil },
              { rotulo: 'Funil', href: '/leads?vista=funil', ativo: noFunil },
            ].map((v) => (
              <Link
                key={v.rotulo}
                href={v.href}
                className={`px-3 py-2 text-2xs font-medium md:py-1.5 ${
                  v.ativo ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink'
                }`}
              >
                {v.rotulo}
              </Link>
            ))}
          </div>

          <Link
            href="/api/leads/csv"
            className="h-8 rounded-lg border border-line px-3 text-2xs leading-8 font-medium text-ink hover:bg-surface-2"
          >
            Exportar CSV
          </Link>
          <Link
            href="/leads/importar"
            className="h-8 rounded-lg bg-live px-3 text-2xs leading-8 font-medium text-white hover:bg-live/90"
          >
            Importar lista
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardBody className="grid grid-cols-3 gap-6">
            <Stat label="Leads" value={formatNumber(total)} />
            <Stat label="Novos (7 dias)" value={formatNumber(novos)} />
          </CardBody>
        </Card>

        {/*
          Filtros salvos (§9.1).

          `py-2 md:py-1`: no computador o alvo é o ponteiro e 27px de altura
          basta; no telefone é o polegar. Estes cinco atalhos são a navegação
          principal desta tela, e errar o toque devolve a pessoa para a lista
          inteira. A densidade do §11.1 vale para a mesa, não para o balcão.
        */}
        <div className="flex flex-wrap gap-1">
          <Link
            href="/leads"
            className={`rounded-lg border px-2.5 py-2 text-2xs md:py-1 ${
              chave ? 'border-line text-ink-2' : 'border-ink text-ink'
            }`}
          >
            Todos
          </Link>
          {FILTROS_SALVOS.map((f) => (
            <Link
              key={f.chave}
              href={`/leads?filtro=${f.chave}`}
              className={`rounded-lg border px-2.5 py-2 text-2xs md:py-1 ${
                chave === f.chave ? 'border-ink text-ink' : 'border-line text-ink-2'
              }`}
            >
              {f.rotulo}
            </Link>
          ))}
        </div>

        {noFunil && colunas ? (
          <Kanban
            colunas={colunas.map((c) => ({
              stageId: c.stageId,
              name: c.name,
              color: c.color,
              isWon: c.isWon,
              isLost: c.isLost,
              total: c.total,
              somaCents: c.somaCents,
              cartoes: c.cartoes.map((cartao) => ({
                id: cartao.id,
                title: cartao.title,
                valueCents: cartao.valueCents,
                ownerName: cartao.ownerName,
                contactName: cartao.contactName,
                diasNaEtapa: cartao.diasNaEtapa,
              })),
            }))}
          />
        ) : (
          <TabelaLeads
            linhas={paraTabela}
            total={total}
            etapas={etapas.map((e) => ({ id: e.id, name: e.name }))}
            consultores={consultores}
            podeReatribuir={can(user, 'leads.reatribuir')}
            mensagens={mensagens}
            podeEnviar={can(user, 'mensagem.enviar_manual')}
          />
        )}
      </div>
    </SessionFrame>
  )
}
