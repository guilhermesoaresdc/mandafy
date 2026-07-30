import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/current'
import { EntrarForm } from './form'

export const metadata: Metadata = { title: 'Entrar · Mandafy' }

export default async function EntrarPage() {
  /*
   * Quem já está autenticado vai direto ao painel — mas a decisão é tomada
   * aqui, onde a sessão pode ser validada de verdade, e não no middleware,
   * que só enxerga a presença do cookie. Um cookie morto simplesmente cai
   * neste `null` e a tela de entrada aparece, como deve.
   */
  if (await getCurrentUser()) redirect('/painel')

  return <EntrarPageContent />
}

function EntrarPageContent() {
  return (
    <div className="w-full max-w-[360px]">
      <div className="mb-8 text-center">
        <p className="font-display text-xl font-bold tracking-tight text-ink">Mandafy</p>
        <p className="mt-1 text-xs text-ink-2">Cada mensagem no tempo certo, no canal certo.</p>
      </div>

      <div className="rounded-xl border border-line bg-surface p-6">
        <EntrarForm />
      </div>

      <p className="mt-6 text-center text-2xs text-pending">
        Acesso restrito à equipe da operação.
      </p>
    </div>
  )
}
