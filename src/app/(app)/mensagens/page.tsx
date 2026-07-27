import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { Button, Card, CardBody, CardHeader, CardTitle, EmptyState } from '@/components/ui'
import { requireAdmin } from '@/lib/auth/current'
import { PadDemo } from './pad-demo'

export const metadata: Metadata = { title: 'Mensagens · Mandafy' }

export default async function MensagensPage() {
  // Consultor não gerencia mensagens (§9.4). O item some do menu E a rota
  // redireciona — esconder no menu nunca é a proteção.
  await requireAdmin()

  return (
    <SessionFrame
      title="Mensagens"
      description="Uma mensagem, quatro saídas. Você escreve uma vez; cada canal recebe sua versão."
      actions={<Button disabled>Nova mensagem</Button>}
    >
      <div className="flex flex-col gap-4">
        <EmptyState
          title="Nenhuma mensagem ainda"
          description="Comece pela mensagem de boas-vindas — é a mais simples e já dá para ver as quatro versões lado a lado."
          action={<Button disabled>Criar a primeira mensagem</Button>}
        />

        <Card>
          <CardHeader>
            <CardTitle>Versões do canal</CardTitle>
            <span className="text-2xs text-pending">
              Ligado acende na cor do canal; desligado apaga de verdade
            </span>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-xs text-ink-2">
              Cada mensagem carrega quatro versões. Ligue e desligue os canais aqui — é assim
              que você controla por onde a mensagem sai.
            </p>
            <PadDemo />
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
