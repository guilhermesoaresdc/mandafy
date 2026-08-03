import type { Metadata } from 'next'
import { withTenant } from '@/db'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody } from '@/components/ui'
import { listarEquipe } from '@/db/queries/equipe'
import { USER_ROLES, USER_ROLE_LABELS } from '@/db/schema/enums'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { alternarAcessoAction, trocarPapelAction } from './actions'
import { ConvidarPessoa, ReenviarConvite, TrocarSenha } from './formularios'

export const metadata: Metadata = { title: 'Equipe · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * Quem entra no painel (§9.4).
 *
 * Não existe cadastro público: a lista de quem pode entrar é exatamente a lista
 * desta tela. Quem é cadastrado recebe um link e cria a própria senha — o
 * administrador nunca digita nem enxerga senha de ninguém.
 */

function quando(data: Date | null): string {
  if (!data) return 'nunca entrou'

  const dias = Math.floor((Date.now() - data.getTime()) / 86_400_000)
  if (dias === 0) return 'hoje'
  if (dias === 1) return 'ontem'
  if (dias < 30) return `há ${dias} dias`
  return data.toLocaleDateString('pt-BR')
}

export default async function EquipePage() {
  const user = await requireAdmin()
  assertCan(user, 'usuarios.gerenciar')

  const equipe = await withTenant(tenantOf(user), (tx) => listarEquipe(tx))
  const adminsAtivos = equipe.filter((m) => m.papel === 'admin' && m.ativo).length

  return (
    <SessionFrame
      title="Equipe"
      description="Quem tem acesso ao painel. Ninguém entra sem estar nesta lista."
    >
      <div className="flex max-w-3xl flex-col gap-4">
        <ConvidarPessoa />

        <div className="flex flex-col gap-2">
          {equipe.map((membro) => {
            const souEu = membro.id === user.id
            // O último administrador ativo não pode ser desligado nem
            // rebaixado, ou não sobra quem religue o acesso de ninguém.
            const ultimoAdmin = membro.papel === 'admin' && membro.ativo && adminsAtivos <= 1

            return (
              <Card key={membro.id}>
                <CardBody className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-medium text-ink">{membro.nome}</p>
                      {souEu ? <Badge tone="ok">você</Badge> : null}
                      {!membro.ativo ? <Badge tone="fail">sem acesso</Badge> : null}
                      {membro.ativo && !membro.aceitou ? (
                        <Badge tone="pending">
                          {membro.conviteAberto ? 'convite enviado' : 'convite vencido'}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-2xs text-pending">
                      {membro.email}
                    </p>
                  </div>

                  <div className="text-2xs text-ink-2">
                    <span className="text-pending">último acesso </span>
                    {quando(membro.ultimoAcesso)}
                  </div>

                  {/*
                    O perfil é um formulário próprio: trocar papel é a decisão
                    mais consequente desta tela — muda o que a pessoa enxerga —
                    e não deve compartilhar botão com nada.
                  */}
                  <form action={trocarPapelAction} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={membro.id} />
                    {USER_ROLES.map((papel) => (
                      <Button
                        key={papel}
                        type="submit"
                        name="papel"
                        value={papel}
                        size="sm"
                        variant={membro.papel === papel ? 'secondary' : 'ghost'}
                        disabled={membro.papel === papel || (ultimoAdmin && papel !== 'admin')}
                      >
                        {USER_ROLE_LABELS[papel]}
                      </Button>
                    ))}
                  </form>

                  {membro.ativo && !membro.aceitou ? <ReenviarConvite id={membro.id} /> : null}

                  <form action={alternarAcessoAction}>
                    <input type="hidden" name="id" value={membro.id} />
                    <input type="hidden" name="ativar" value={membro.ativo ? '0' : '1'} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      disabled={membro.ativo && (souEu || ultimoAdmin)}
                      title={
                        souEu
                          ? 'Você não pode tirar o próprio acesso.'
                          : ultimoAdmin
                            ? 'É o último administrador ativo.'
                            : undefined
                      }
                    >
                      {membro.ativo ? 'Tirar acesso' : 'Devolver acesso'}
                    </Button>
                  </form>
                </CardBody>
              </Card>
            )
          })}
        </div>

        <Card>
          <CardBody className="flex flex-col gap-3">
            <div>
              <p className="text-xs font-medium text-ink">Sua senha</p>
              <p className="mt-0.5 text-2xs text-ink-2">
                Trocar encerra todas as sessões desta conta, inclusive a atual.
              </p>
            </div>
            <TrocarSenha />
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
