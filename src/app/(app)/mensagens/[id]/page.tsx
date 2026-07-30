import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withTenant } from '@/db'
import { buscarMensagem } from '@/db/queries/messages'
import { SessionFrame } from '@/components/shell/app-shell'
import { Button } from '@/components/ui'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { alternarMensagemAction } from '../actions'
import { EditorMensagem, type VarianteEditavel } from './editor'

export const metadata: Metadata = { title: 'Mensagem · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function MensagemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireAdmin()

  const completa = await withTenant(tenantOf(user), (tx) => buscarMensagem(tx, id))
  // RLS já filtra por organização: uma mensagem de outra org não volta da
  // consulta, e cai aqui como inexistente. É o comportamento certo — dizer
  // "sem permissão" confirmaria que ela existe.
  if (!completa) notFound()

  const { mensagem, variantes } = completa

  const editaveis: VarianteEditavel[] = variantes.map((v) => ({
    channel: v.channel,
    enabled: v.enabled,
    synced: v.synced,
    body: v.body,
    subject: v.subject,
    preheader: v.preheader,
    stripAccents: v.stripAccents,
    linkShorten: v.linkShorten,
  }))

  return (
    <SessionFrame
      title={mensagem.name}
      description="Escreva uma vez. Cada canal recebe sua versão — e você vê as quatro antes de enviar."
      actions={
        <form action={alternarMensagemAction}>
          <input type="hidden" name="id" value={mensagem.id} />
          <input type="hidden" name="ativar" value={mensagem.active ? '0' : '1'} />
          <Button type="submit" variant="ghost" size="sm">
            {mensagem.active ? 'Pausar' : 'Reativar'}
          </Button>
        </form>
      }
    >
      <EditorMensagem
        mensagem={{
          id: mensagem.id,
          key: mensagem.key,
          name: mensagem.name,
          category: mensagem.category,
          body: mensagem.body,
          ignoreQuietHours: mensagem.ignoreQuietHours,
          active: mensagem.active,
        }}
        variantes={editaveis}
      />
    </SessionFrame>
  )
}
