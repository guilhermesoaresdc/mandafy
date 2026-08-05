import type { Metadata } from 'next'
import Link from 'next/link'
import { SessionFrame } from '@/components/shell/app-shell'
import { Card, CardBody } from '@/components/ui'
import { requireUser } from '@/lib/auth/current'
import { PainelImportacao } from './painel-importacao'

export const metadata: Metadata = { title: 'Importar leads · Mandafy' }
export const dynamic = 'force-dynamic'

/*
 * A gravação é uma Server Action desta rota, e é a única do sistema que trabalha
 * proporcionalmente ao que o usuário enviou. Os 10 s padrão do plano gratuito
 * dariam conta de uma planilha pequena e matariam uma grande no meio.
 */
export const maxDuration = 60

/**
 * Importar lista (§9.1).
 *
 * A página é casca: quem trabalha é o painel, no navegador. O servidor entra
 * só na hora de gravar.
 */
export default async function ImportarLeadsPage() {
  await requireUser()

  return (
    <SessionFrame
      title="Importar leads"
      description="Suba a planilha, confira o que vai entrar e importe."
    >
      <div className="flex max-w-3xl flex-col gap-4">
        <PainelImportacao />

        {/*
         * O caminho de volta é parte do ambiente, não um extra: exportar,
         * ajustar na planilha e reimportar é como a base é corrigida em massa,
         * e o CSV daqui volta sem ninguém remapear coluna nenhuma.
         */}
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-ink">Levar a base para a planilha</p>
              <p className="text-2xs text-ink-2">
                Baixe, ajuste no Excel e suba de volta aqui — as colunas são reconhecidas sozinhas.
              </p>
            </div>
            <Link
              href="/api/leads/csv"
              className="h-8 shrink-0 rounded-lg border border-line px-3 text-2xs leading-8 font-medium text-ink hover:bg-surface-2"
            >
              Exportar CSV
            </Link>
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
