import type { Metadata } from 'next'
import { withTenant } from '@/db'
import { montarPipeline } from '@/db/queries/leads'
import { SessionFrame } from '@/components/shell/app-shell'
import { BotaoAcao, EmptyState } from '@/components/ui'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { criarFunilPadraoAction } from './actions'
import { Kanban, type Coluna } from './kanban'

export const metadata: Metadata = { title: 'Pipeline · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const user = await requireUser()

  // Consultor vê o pipeline FILTRADO (§9.4) — o RLS de `leads` já faz o
  // recorte por dono, então a mesma consulta serve aos dois perfis.
  const colunas = await withTenant(tenantOf(user), (tx) => montarPipeline(tx))

  const paraKanban: Coluna[] = colunas.map((c) => ({
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
  }))

  const vazio = paraKanban.every((c) => c.total === 0)

  return (
    <SessionFrame
      title="Pipeline"
      description={
        /*
          A instrução era "Arraste para mover de etapa" — e no celular arrastar
          não move nada. O `draggable` do HTML não nasce de um toque: nem o
          Safari do iPhone nem o Chrome do Android disparam `dragstart` por
          gesto, e não há remendo de CSS que conserte isso.
          O caminho que funciona nos dois lugares é o seletor de etapa dentro
          de cada cartão, que já existia — mas nada na tela dizia isso, e quem
          abria no telefone ficava tentando o gesto que a própria tela mandou
          fazer. §11.7: nomear pelo que a pessoa controla.
        */
        user.isAdmin
          ? 'Cada cartão tem um seletor de etapa — e no computador dá para arrastar. O cartão move na hora; o servidor confirma depois.'
          : 'Os seus leads, por etapa.'
      }
    >
      {paraKanban.length === 0 ? (
        /*
         * O botão só aparece para quem administra.
         *
         * Esta é a única tela do grupo autenticado que entra por `requireUser`,
         * não `requireAdmin`: um consultor que clicasse tomaria a exceção de
         * permissão crua na tela. A diferença entre "não posso" e "não entendi"
         * é mostrar o caminho para quem pode resolver.
         */
        <EmptyState
          title="Nenhum funil configurado"
          description={
            user.isAdmin
              ? 'O funil padrão é Novo → Contatado → Negociando → Ganho / Perdido. Dá para renomear as etapas depois.'
              : 'Peça a quem administra o Mandafy para criar o funil de vendas.'
          }
          {...(user.isAdmin
            ? {
                action: (
                  <BotaoAcao
                    acao={criarFunilPadraoAction}
                    rotulo="Criar o funil padrão"
                    rotuloOcupado="Criando…"
                  />
                ),
              }
            : {})}
        />
      ) : vazio ? (
        <div className="flex flex-col gap-4">
          <EmptyState
            title="Nenhum lead no funil ainda"
            description="Os leads nascem sozinhos: PIX gerado e não pago em 24h, compra acima de R$ 200, ou contato que sumiu há 30 dias mas já comprou."
          />
          <Kanban colunas={paraKanban} />
        </div>
      ) : (
        <Kanban colunas={paraKanban} />
      )}
    </SessionFrame>
  )
}
