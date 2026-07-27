import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { Button, EmptyState } from '@/components/ui'
import { requireAdmin } from '@/lib/auth/current'

export const metadata: Metadata = { title: 'Fluxos · Mandafy' }

export default async function FluxosPage() {
  await requireAdmin()

  return (
    <SessionFrame
      title="Fluxos"
      description="O que dispara, quando sai, e o que faz parar."
      actions={<Button disabled>Novo fluxo</Button>}
    >
      {/* Copy de vazio convida à ação (§11.7). */}
      <EmptyState
        title="Nenhum fluxo ainda"
        description="Comece pelo modelo de recuperação de PIX — leva 2 minutos. Ele avisa quem gerou o pagamento e não pagou, e para sozinho no instante em que o pagamento entra."
        action={<Button disabled>Usar o modelo de recuperação de PIX</Button>}
      />
    </SessionFrame>
  )
}
