import type { Metadata } from 'next'
import Link from 'next/link'
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

      <div className="mt-4 flex max-w-3xl flex-col gap-2">
        {[
          {
            titulo: 'Plataformas',
            texto: 'De onde os eventos chegam. Conecte sua plataforma de sorteio e combine os campos.',
            href: '/configuracoes/plataformas',
          },
          {
            titulo: 'API',
            texto: 'Chaves para o seu sistema falar com o Mandafy, e webhooks para ele avisar o seu.',
            href: '/configuracoes/api',
          },
          {
            titulo: 'Privacidade',
            texto: 'Direitos do titular, retenção e o registro de quem acessou o quê.',
            href: '/configuracoes/privacidade',
          },
        ].map((item) => (
          <Card key={item.href}>
            <CardBody className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-ink">{item.titulo}</p>
                <p className="mt-0.5 text-2xs text-ink-2">{item.texto}</p>
              </div>
              <Button asChild variant="secondary" size="sm">
                <Link href={item.href}>Abrir</Link>
              </Button>
            </CardBody>
          </Card>
        ))}
      </div>
    </SessionFrame>
  )
}
