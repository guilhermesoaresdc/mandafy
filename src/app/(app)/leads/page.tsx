import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { Button, EmptyState } from '@/components/ui'
import { requireUser } from '@/lib/auth/current'
import { can } from '@/lib/rbac'

export const metadata: Metadata = { title: 'Leads · Mandafy' }

export default async function LeadsPage() {
  const user = await requireUser()
  const veTodos = can(user, 'leads.ver_todos')

  return (
    <SessionFrame
      title="Leads"
      description={veTodos ? 'Todos os leads da operação.' : 'Os leads sob sua responsabilidade.'}
      actions={<Button disabled>Importar CSV</Button>}
    >
      {/* TODO Fase 7: tabela virtualizada com @tanstack/react-virtual —
          50 mil leads sem travar, busca abaixo de 100ms pelo índice trigram
          já criado em contacts.name (§9.1, §13.2). */}
      <EmptyState
        title="Nenhum lead ainda"
        description="Os leads aparecem sozinhos conforme os eventos chegam: quem gerou pagamento e não pagou em 24h vira lead automaticamente."
        action={<Button disabled>Criar lead manualmente</Button>}
      />
    </SessionFrame>
  )
}
