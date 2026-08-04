import type { Metadata } from 'next'
import Link from 'next/link'
import { withTenant } from '@/db'
import { listarMensagens } from '@/db/queries/messages'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, ChannelPad, EmptyState } from '@/components/ui'
import { CHANNELS, MESSAGE_CATEGORY_LABELS } from '@/db/schema/enums'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { resumoDosModelos } from '@/lib/messages/galeria'
import { NovaMensagem } from './nova-mensagem'

export const metadata: Metadata = { title: 'Mensagens · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function MensagensPage() {
  // Consultor não gerencia mensagens (§9.4). O item some do menu E a rota
  // redireciona — esconder no menu nunca é a proteção.
  const user = await requireAdmin()

  const lista = await withTenant(tenantOf(user), listarMensagens)

  /*
   * A galeria é montada aqui, no servidor, e desce como texto já compilado. O
   * corpo inteiro do catálogo não precisa atravessar a rede para caber em
   * duas linhas de cartão (§13.1).
   */
  const modelos = resumoDosModelos()

  return (
    <SessionFrame
      title="Mensagens"
      description="Uma mensagem, quatro saídas. Você escreve uma vez; cada canal recebe sua versão."
      actions={<NovaMensagem modelos={modelos} />}
    >
      {lista.length === 0 ? (
        <EmptyState
          title="Nenhuma mensagem ainda"
          description="Clique em “Nova mensagem”: há modelos prontos para escolher, do lembrete de PIX ao aviso de prêmio. Dá para editar tudo depois."
        />
      ) : (
        <div className="flex max-w-3xl flex-col gap-2">
          {lista.map((mensagem) => (
            <Card key={mensagem.id}>
              <CardBody className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-xs font-medium text-ink">{mensagem.name}</p>
                    {mensagem.active ? null : <Badge tone="pending">pausada</Badge>}
                    {mensagem.customizadas > 0 ? (
                      <Badge tone="pending">
                        {mensagem.customizadas} customizada{mensagem.customizadas > 1 ? 's' : ''}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 font-mono text-2xs text-pending">
                    {mensagem.key} · {MESSAGE_CATEGORY_LABELS[mensagem.category]}
                  </p>
                </div>

                {/* Só leitura: liga e desliga acontece dentro da mensagem. */}
                <div className="hidden items-center gap-1 sm:flex">
                  {CHANNELS.map((canal) => (
                    <ChannelPad
                      key={canal}
                      channel={canal}
                      on={mensagem.canaisAtivos.includes(canal)}
                      label=""
                      className="px-2 py-1"
                    />
                  ))}
                </div>

                <Button asChild variant="secondary" size="sm">
                  <Link href={`/mensagens/${mensagem.id}`}>Abrir</Link>
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </SessionFrame>
  )
}
