import { count, desc } from 'drizzle-orm'
import type { Tx } from '@/db'
import { eventsRaw, sources } from '@/db/schema'

/**
 * Consultas das plataformas conectadas (§4.2).
 *
 * Moram aqui, e não dentro do componente de página, para que possam ser
 * EXECUTADAS num teste. Uma query pode passar no `tsc` e no build e ainda ser
 * recusada pelo Postgres — foi exatamente o que aconteceu com a contagem
 * abaixo. Só rodar contra um banco de verdade pega essa classe de erro.
 */

export type PlataformaResumo = {
  id: string
  name: string
  active: boolean
  ingestToken: string
  createdAt: Date
  /** Quantos eventos crus chegaram — é como a pessoa vê se a conexão está viva. */
  recebidos: number
}

/**
 * Contagem de eventos por plataforma.
 *
 * Duas queries em vez de uma subconsulta correlacionada de propósito: dentro da
 * projeção de um `select`, o Drizzle renderiza colunas SEM qualificar a tabela,
 * então `sources.id` virava um `"id"` solto que o Postgres resolvia como
 * `events_raw.id` — e a comparação uuid = bigint estourava em tempo de
 * execução. Agrupar e juntar em JS é imune a isso.
 */
export async function contarEventosPorPlataforma(tx: Tx): Promise<Map<string, number>> {
  const linhas = await tx
    .select({ sourceId: eventsRaw.sourceId, total: count() })
    .from(eventsRaw)
    .groupBy(eventsRaw.sourceId)

  const porOrigem = new Map<string, number>()
  for (const linha of linhas) {
    if (linha.sourceId) porOrigem.set(linha.sourceId, linha.total)
  }
  return porOrigem
}

/** Plataformas da organização, mais recentes primeiro, com o total recebido. */
export async function listarPlataformas(tx: Tx): Promise<PlataformaResumo[]> {
  const linhas = await tx
    .select({
      id: sources.id,
      name: sources.name,
      active: sources.active,
      ingestToken: sources.ingestToken,
      createdAt: sources.createdAt,
    })
    .from(sources)
    .orderBy(desc(sources.createdAt))

  // Sem plataforma nenhuma não há o que contar — poupa uma varredura nas
  // partições de events_raw na tela vazia, que é a mais visitada no começo.
  if (linhas.length === 0) return []

  const recebidos = await contarEventosPorPlataforma(tx)
  return linhas.map((linha) => ({ ...linha, recebidos: recebidos.get(linha.id) ?? 0 }))
}
