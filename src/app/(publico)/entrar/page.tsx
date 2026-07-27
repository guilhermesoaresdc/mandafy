import type { Metadata } from 'next'
import { EntrarForm } from './form'

export const metadata: Metadata = { title: 'Entrar · Mandafy' }

export default function EntrarPage() {
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
