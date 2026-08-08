import type { Metadata } from 'next'
import Link from 'next/link'
import { withTenant } from '@/db'
import { listarMensagens } from '@/db/queries/messages'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, EmptyState } from '@/components/ui'
import { PadCanalMensagem } from './[id]/pad-canal'
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
                  {/*
                    A chave sai da lista e vai para a dica. Ela é contrato com
                    quem integra pela API — e quem abre esta tela está
                    procurando "o lembrete de PIX", não `pix_lembrete_1`.
                  */}
                  <p className="mt-0.5 text-2xs text-pending" title={mensagem.key}>
                    {MESSAGE_CATEGORY_LABELS[mensagem.category]}
                  </p>

                  {/*
                    O TEXTO, e não só o nome.

                    A lista mostrava nome, categoria e canais — tudo SOBRE a
                    mensagem, nada DELA. Saber o que uma mensagem diz custava
                    uma tela por mensagem, e "Lembrete de PIX — 5 minutos" não
                    conta se o texto ainda fala de rifa ou se está em branco.
                  */}
                  {mensagem.amostra ? (
                    <p className="mt-1 truncate text-2xs text-ink-2">{mensagem.amostra}</p>
                  ) : (
                    <p className="mt-1 text-2xs text-fail">Sem texto — não vai sair nada.</p>
                  )}
                </div>

                {/*
                  Os pads LIGAM E DESLIGAM daqui também.
                  Eram só leitura, com o comentário "liga e desliga acontece
                  dentro da mensagem" — verdadeiro e invisível. Na tela eles são
                  idênticos aos do editor: mesma cor, mesmo brilho, mesmo
                  formato de interruptor. Quem clicava concluía que o sistema
                  estava quebrado, e não que aquele controle específico era
                  enfeite. Um pad que parece um interruptor precisa ser um.
                */}
                <div className="hidden items-center gap-1 sm:flex">
                  {CHANNELS.map((canal) => (
                    <PadCanalMensagem
                      key={canal}
                      messageId={mensagem.id}
                      canal={canal}
                      ligado={mensagem.canaisAtivos.includes(canal)}
                      rotulo=""
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
