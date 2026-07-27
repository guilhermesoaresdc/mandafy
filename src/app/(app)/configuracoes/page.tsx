import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { Button, Card, CardBody, CardHeader, CardTitle, Separator } from '@/components/ui'
import { USER_ROLE_LABELS } from '@/db/schema/enums'
import { sairAction } from '@/lib/auth/actions'
import { requireAdmin } from '@/lib/auth/current'

export const metadata: Metadata = { title: 'Configurações · Mandafy' }

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="text-2xs text-ink-2">{rotulo}</span>
      <span className="text-xs text-ink">{valor}</span>
    </div>
  )
}

export default async function ConfiguracoesPage() {
  const user = await requireAdmin()

  return (
    <SessionFrame title="Configurações">
      <div className="grid max-w-3xl gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Organização</CardTitle>
          </CardHeader>
          <CardBody className="divide-y divide-line py-0">
            <Linha rotulo="Nome" valor={user.orgName} />
            <Linha rotulo="Identificador" valor={user.orgSlug} />
            <Linha rotulo="Fuso horário" valor={user.timezone} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sua conta</CardTitle>
          </CardHeader>
          <CardBody className="py-0">
            <div className="divide-y divide-line">
              <Linha rotulo="Nome" valor={user.name} />
              <Linha rotulo="E-mail" valor={user.email} />
              <Linha rotulo="Perfil" valor={USER_ROLE_LABELS[user.role]} />
            </div>

            <Separator className="my-3" />

            <form action={sairAction} className="pb-4">
              <Button type="submit" variant="secondary" size="sm">
                Sair
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>

      {/* TODO Fase 2: conectar plataforma. Fase 8: chaves de API, webhooks de
          saída, exportação e anonimização de dados (LGPD). */}
    </SessionFrame>
  )
}
