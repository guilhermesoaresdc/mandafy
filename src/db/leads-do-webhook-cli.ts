/**
 * `npm run crm:leads-do-webhook` — traz para o funil o que o webhook já trouxe
 * para a base.
 *
 * A criação automática de lead por evento (§9.3) só alcança quem chega DEPOIS
 * dela existir. Todo cadastro que a plataforma mandou antes está no banco como
 * contato e nunca chegou ao time comercial — e essa é a maior parte da base.
 * Este comando é a recuperação desse histórico, uma vez só.
 *
 * SEM `--aplicar` ELE NÃO ESCREVE NADA.
 *
 * Mesma decisão de `db:modelos`: o comando pode abrir mil cartões e distribuí-
 * los entre os consultores, o que não se desfaz com um clique. E a simulação é
 * a parte útil na maioria das vezes — quantos entrariam é justamente o número
 * que ninguém tem antes de rodar.
 */
import { db, withTenant } from '@/db'
import { organizations } from '@/db/schema'
import { criarLeadsDosContatosDoWebhook, type ResultadoBackfill } from '@/lib/crm/criar-lead'

/** `--limite=500`. O padrão cobre a base de uma banca comum numa passagem. */
function lerLimite(): number {
  const arg = process.argv.find((a) => a.startsWith('--limite='))
  const n = arg ? Number(arg.slice('--limite='.length)) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000
}

async function principal(): Promise<void> {
  const aplicar = process.argv.includes('--aplicar')
  const limite = lerLimite()

  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations)

  if (orgs.length === 0) {
    console.log('Nenhuma organização no banco. Rode `npm run db:seed` primeiro.')
    return
  }

  let vistos = 0
  let criados = 0
  let pulados = 0
  let semFunil = 0

  for (const org of orgs) {
    /*
     * Uma transação por organização, com contexto de tenant — sem ele as
     * consultas comparam `org_id` com nulo, devolvem zero linhas e o comando
     * relataria "nada a fazer" numa base cheia. É a armadilha que já custou
     * caro neste código (ver `paraCadaOrg` em manutencao.ts).
     */
    const r: ResultadoBackfill = await withTenant(
      { orgId: org.id, userId: org.id, isAdmin: true },
      (tx) => criarLeadsDosContatosDoWebhook(tx, org.id, { aplicar, limite }),
    )

    vistos += r.vistos
    criados += r.criados
    pulados += r.pulados
    if (r.semFunil) semFunil += 1

    if (orgs.length > 1 && (r.vistos > 0 || r.semFunil)) {
      console.log(`· ${org.name}: ${r.criados} de ${r.vistos}${r.semFunil ? ' (sem funil padrão)' : ''}`)
    }
  }

  console.log('')

  if (vistos === 0) {
    console.log('Nenhum contato do webhook está sem lead. Nada a fazer.')
  } else if (aplicar) {
    console.log(`✓ ${criados} lead(s) criados a partir de ${vistos} contato(s) da plataforma.`)
  } else {
    console.log(
      `Simulação — nada foi gravado.\n` +
        `${vistos} contato(s) vieram da plataforma e não têm lead; ${criados} virariam cartão.\n` +
        'Rode de novo com -- --aplicar para valer.',
    )
  }

  if (pulados > 0) {
    console.log(
      `\n${pulados} ${pulados === 1 ? 'ficou de fora porque pediu' : 'ficaram de fora porque pediram'} ` +
        'para não receber. Um lead é uma\ntarefa para um consultor ligar — que é o que essas pessoas recusaram.',
    )
  }

  if (semFunil > 0) {
    console.log(
      `\n${semFunil} organização(ões) sem funil padrão: não há etapa onde pôr os cartões.\n` +
        'Rode `npm run db:seed` ou crie o pipeline padrão antes.',
    )
  }
}

principal()
  .then(() => process.exit(0))
  .catch((erro: unknown) => {
    console.error('\nFalha ao criar os leads:', erro instanceof Error ? erro.message : erro)
    process.exit(1)
  })
