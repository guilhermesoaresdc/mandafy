/**
 * O que uma organização JÁ EXISTENTE precisa para funcionar (§7.2, §9.2).
 *
 * POR QUE ISTO SAIU DE `seed.ts`
 *
 * `seed()` é a instalação a partir do zero: abre conexão própria como dono do
 * banco, procura a organização por um `slug` fixo e cria uma se não achar. Isso
 * está certo para a primeira subida e errado para um botão de tela — ali a
 * organização já existe, é a de quem clicou, e a conexão é a da sessão, com o
 * RLS aplicado.
 *
 * Enquanto as duas coisas eram a mesma função, o botão "Criar o que faltar" de
 * Configurações → Sistema semeava a organização ERRADA: procurava pelo slug
 * `mandafy`, não achava, criava uma SEGUNDA organização e respondia "Criado:
 * organização, 9 fluxos-modelo". A tela de fluxos continuava vazia. Mensagem de
 * sucesso com resultado invisível — o pior desfecho possível.
 *
 * As funções daqui recebem a conexão de quem chamou — o `Tx` do `withTenant`,
 * no caso do botão — e o `orgId` explícito. Elas nunca abrem conexão, nunca
 * criam organização e nunca adivinham para quem estão trabalhando.
 */

import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

/**
 * O tipo largo, e não o `Tx` do withTenant — de propósito.
 *
 * Um `Tx` é estruturalmente um `PostgresJsDatabase`, mas não o contrário. Com o
 * tipo estreito, estas funções serviriam ao botão da tela e recusariam a
 * conexão de dono que a primeira subida usa, e voltaríamos a ter duas cópias da
 * mesma semeadura — que foi exatamente como o botão passou a semear a
 * organização errada. É o mesmo tipo que `seed-flows.ts` já usa.
 */
type Db = PostgresJsDatabase<typeof schema>

/**
 * Perfis de randomização de envio (§7.2).
 *
 * Os NOMES importam mais do que parecem: `seed-flows.ts` liga cada fluxo ao seu
 * ritmo procurando por nome (`perfilPorNome.get(modelo.jitter)`), e um nome que
 * não bate vira `jitterProfileId` nulo — sem erro, sem aviso, e a coluna
 * "ritmo" some da tela. Por isso semear ritmos vem SEMPRE antes de semear
 * fluxos, e por isso estes quatro nomes não mudam.
 */
export const RITMOS = [
  { name: 'Instantâneo', mode: 'instantaneo' as const, min: 0, max: 0, isDefault: false },
  { name: 'Seguro', mode: 'humano' as const, min: 8, max: 25, isDefault: true },
  { name: 'Conservador', mode: 'humano' as const, min: 30, max: 90, isDefault: false },
  { name: 'Disparo em massa', mode: 'faixa' as const, min: 45, max: 180, isDefault: false },
]

/** Etapas padrão do funil (§9.2). */
export const ETAPAS = [
  { name: 'Novo', position: 0, color: '#8A94AD', probability: 10, isWon: false, isLost: false },
  { name: 'Contatado', position: 1, color: '#2D9CDB', probability: 30, isWon: false, isLost: false },
  { name: 'Negociando', position: 2, color: '#E8A13C', probability: 60, isWon: false, isLost: false },
  { name: 'Ganho', position: 3, color: '#17B26A', probability: 100, isWon: true, isLost: false },
  { name: 'Perdido', position: 4, color: '#E5484D', probability: 0, isWon: false, isLost: true },
]

/**
 * Cria os perfis de ritmo que faltarem. Devolve quantos nasceram agora.
 *
 * Idempotente por (org_id, name). O cuidado extra é com
 * `jitter_profiles_one_default_uq`, índice único parcial em (org_id) onde
 * `is_default`: se a organização já tem um padrão com OUTRO nome, inserir
 * "Seguro" como padrão levanta violação de unicidade e derruba a operação
 * inteira. O `onConflictDoNothing` mira em (org_id, name) e não cobre esse
 * índice — por isso a checagem explícita antes.
 */
export async function semearRitmos(tx: Db, orgId: string): Promise<number> {
  const [padraoExistente] = await tx
    .select({ id: schema.jitterProfiles.id })
    .from(schema.jitterProfiles)
    .where(
      and(eq(schema.jitterProfiles.orgId, orgId), eq(schema.jitterProfiles.isDefault, true)),
    )
    .limit(1)

  let criados = 0

  for (const ritmo of RITMOS) {
    const inseridos = await tx
      .insert(schema.jitterProfiles)
      .values({
        orgId,
        name: ritmo.name,
        mode: ritmo.mode,
        minSeconds: ritmo.min,
        maxSeconds: ritmo.max,
        // Já existe um padrão? Então este entra como não-padrão. A escolha de
        // quem é o padrão é de quem já configurou, não deste código.
        isDefault: ritmo.isDefault && !padraoExistente,
      })
      .onConflictDoNothing({
        target: [schema.jitterProfiles.orgId, schema.jitterProfiles.name],
      })
      .returning({ id: schema.jitterProfiles.id })

    criados += inseridos.length
  }

  return criados
}

/**
 * Cria o funil padrão com as cinco etapas, se a organização ainda não tiver um.
 *
 * Mesma armadilha do índice parcial, aqui em `pipelines_one_default_uq`: a
 * checagem é por "já existe funil padrão", e não por "já existe funil".
 */
export async function semearFunilPadrao(tx: Db, orgId: string): Promise<boolean> {
  const [existente] = await tx
    .select({ id: schema.pipelines.id })
    .from(schema.pipelines)
    .where(eq(schema.pipelines.orgId, orgId))
    .limit(1)

  if (existente) return false

  const [criado] = await tx
    .insert(schema.pipelines)
    .values({ orgId, name: 'Funil de vendas', isDefault: true })
    .returning({ id: schema.pipelines.id })

  // Zero linha aqui é RLS recusando em silêncio, não "já existia" — o SELECT
  // acima já respondeu por isso. Falhar alto é o certo.
  if (!criado) throw new Error('não foi possível criar o funil')

  await tx.insert(schema.pipelineStages).values(
    ETAPAS.map((etapa) => ({
      pipelineId: criado.id,
      name: etapa.name,
      position: etapa.position,
      color: etapa.color,
      probability: etapa.probability,
      isWon: etapa.isWon,
      isLost: etapa.isLost,
    })),
  )

  return true
}
