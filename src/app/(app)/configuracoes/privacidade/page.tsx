import type { Metadata } from 'next'
import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import { withTenant } from '@/db'
import { auditLog, contacts, users } from '@/db/schema'
import { SessionFrame } from '@/components/shell/app-shell'
import { Button, Card, CardBody, CardHeader, CardTitle, Separator } from '@/components/ui'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { RETENCAO } from '@/lib/lgpd'
import { BuscarTitular } from './buscar-titular'

export const metadata: Metadata = { title: 'Privacidade · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * Direitos do titular e retenção (§14.1).
 *
 * A tela existe porque a spec é clara: "não é seção jurídica decorativa — é
 * requisito de arquitetura". Quem opera precisa conseguir atender um pedido de
 * exportação ou de exclusão sem abrir o banco.
 */
export default async function PrivacidadePage() {
  const user = await requireAdmin()

  const { registros, totalContatos, descadastrados } = await withTenant(
    tenantOf(user),
    async (tx) => {
      const registros = await tx
        .select({
          id: auditLog.id,
          action: auditLog.action,
          entityId: auditLog.entityId,
          createdAt: auditLog.createdAt,
          userName: users.name,
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.userId))
        .orderBy(desc(auditLog.createdAt))
        .limit(20)

      const todos = await tx.select({ optedOutAt: contacts.optedOutAt }).from(contacts)

      return {
        registros: registros.filter((r) => r.action.startsWith('lgpd.')),
        totalContatos: todos.length,
        descadastrados: todos.filter((c) => c.optedOutAt).length,
      }
    },
  )

  return (
    <SessionFrame
      title="Privacidade"
      description="Direitos do titular, retenção e o registro de quem acessou o quê."
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/configuracoes">Voltar</Link>
        </Button>
      }
    >
      <div className="flex max-w-3xl flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Atender um pedido do titular</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-2xs text-ink-2">
              Busque a pessoa pelo telefone, e-mail ou nome. Você pode exportar tudo que temos sobre
              ela, ou anonimizar.
            </p>
            <BuscarTitular />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Como funciona a anonimização</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <p className="text-2xs text-ink-2">
              Removemos nome, telefone, e-mail e CPF, e limpamos o texto das mensagens que foram
              enviadas — é lá que o nome aparece por extenso. Os números agregados continuam, sem
              ligação com a pessoa.
            </p>
            <p className="text-2xs text-pending">
              Anonimizar em vez de apagar é decisão de arquitetura: apagar a linha levaria junto o
              histórico de envios, e o sistema perderia a capacidade de provar o que fez — que é
              justamente o que uma fiscalização pede.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Retenção</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-1 text-2xs text-ink-2">
            <p>Log quente: {RETENCAO.logQuenteDias} dias, consulta instantânea.</p>
            <p>Arquivo: {RETENCAO.arquivoDias} dias.</p>
            <p>Agregados anônimos: {RETENCAO.agregadosMeses} meses.</p>
            <p>Payload cru das plataformas: {RETENCAO.eventosCrusDias} dias.</p>
            <Separator className="my-2" />
            <p className="text-pending">
              A limpeza é feita descartando a partição do dia, não apagando linha a linha — é
              instantâneo e não degrada o banco.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Consentimento</CardTitle>
            <span className="font-mono text-2xs text-pending">
              {descadastrados} de {totalContatos} descadastrados
            </span>
          </CardHeader>
          <CardBody className="flex flex-col gap-2 text-2xs text-ink-2">
            <p>
              Mensagens de recuperação e relacionamento só saem para quem tem consentimento
              registrado. Transacionais se apoiam em execução de contrato.
            </p>
            <p className="text-pending">
              Quatro caminhos de saída, todos com processamento imediato: palavra-chave no WhatsApp
              e no SMS, link no rodapé do e-mail, <code className="font-mono">/parar</code> no
              Telegram, e o endpoint da API.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pedidos atendidos</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-1">
            {registros.length === 0 ? (
              <p className="text-2xs text-pending">Nenhum pedido registrado ainda.</p>
            ) : (
              registros.map((registro) => (
                <div key={registro.id} className="flex items-center gap-2 text-2xs">
                  <span className="font-mono text-pending tabular-nums">
                    {registro.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                  </span>
                  <span className="text-ink-2">
                    {registro.action === 'lgpd.exportar'
                      ? 'exportação'
                      : registro.action === 'lgpd.anonimizar'
                        ? 'anonimização'
                        : 'descadastro'}
                  </span>
                  <span className="truncate font-mono text-pending">{registro.entityId}</span>
                  {registro.userName ? (
                    <span className="text-pending">por {registro.userName}</span>
                  ) : null}
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
