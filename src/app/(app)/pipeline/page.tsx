import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { requireUser } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { formatBRL } from '@/lib/utils'

export const metadata: Metadata = { title: 'Pipeline · Mandafy' }

/**
 * Etapas padrão de §9.2. Espelham o que o seed grava em `pipeline_stages`.
 * TODO Fase 7: ler do banco e montar o kanban com arrastar e soltar.
 */
const ETAPAS = [
  { nome: 'Novo', cor: 'var(--color-pending)' },
  { nome: 'Contatado', cor: 'var(--color-ch-telegram)' },
  { nome: 'Negociando', cor: 'var(--color-warn)' },
  { nome: 'Ganho', cor: 'var(--color-ok)' },
  { nome: 'Perdido', cor: 'var(--color-fail)' },
]

export default async function PipelinePage() {
  const user = await requireUser()
  const veCompleto = can(user, 'pipeline.ver_completo')

  return (
    <SessionFrame
      title="Pipeline"
      description={veCompleto ? 'O funil inteiro.' : 'Seu funil.'}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {ETAPAS.map((etapa) => (
          <div
            key={etapa.nome}
            className="flex min-h-64 flex-col rounded-xl border border-line bg-surface"
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ background: etapa.cor }}
              />
              <span className="text-2xs font-medium text-ink">{etapa.nome}</span>
              <span className="ml-auto font-mono text-2xs text-pending">0</span>
            </div>

            <div className="flex flex-1 items-center justify-center px-3 py-6">
              <p className="text-center text-2xs text-pending">Nenhum lead</p>
            </div>

            <div className="border-t border-line px-3 py-2 font-mono text-2xs text-pending">
              {formatBRL(0)}
            </div>
          </div>
        ))}
      </div>
    </SessionFrame>
  )
}
