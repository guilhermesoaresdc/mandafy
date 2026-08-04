import { and, eq } from 'drizzle-orm'
import type { Tx } from '@/db'
import { contacts, leads, pipelines, pipelineStages } from '@/db/schema'
import { createLogger } from '@/lib/logger'
import type { LinhaValidada } from './conferir'

/**
 * Gravação da lista importada (§9.1, §14.1).
 *
 * A conferência mora em `conferir.ts`, sem banco, porque a tela a roda no
 * navegador: quem sobe a planilha vê o que vai entrar antes de qualquer
 * requisição. Aqui fica só o que precisa do Postgres.
 *
 * A regra que este arquivo existe para cumprir está no `if (existente)`:
 * importação NUNCA mexe em consentimento de contato que já existe.
 */

const log = createLogger('importar-leads')

export type ResultadoImportacao = {
  criados: number
  atualizados: number
  /** Já existiam e tinham pedido para sair — não foram reativados. */
  preservados: number
  leadsCriados: number
}

/**
 * Grava. Chamada DEPOIS de `conferir`, com o que ela aprovou.
 *
 * `criarLeads` é opcional porque as duas intenções são diferentes: importar
 * base para disparo quer contatos; importar carteira para o time comercial
 * quer leads. Criar lead sempre encheria o pipeline de mil cartões que ninguém
 * pediu.
 */
export async function importarContatos(
  tx: Tx,
  orgId: string,
  validas: LinhaValidada[],
  opcoes: { criarLeads?: boolean; ownerId?: string | null; origem?: string } = {},
): Promise<ResultadoImportacao> {
  const agora = new Date()
  let criados = 0
  let atualizados = 0
  let preservados = 0
  let leadsCriados = 0

  const etapaInicial = opcoes.criarLeads ? await primeiraEtapa(tx, orgId) : null

  for (const item of validas) {
    const existente = await acharContato(tx, orgId, item)

    if (existente) {
      /*
       * Contato que existe NÃO tem o consentimento mexido.
       *
       * Aparecer numa planilha não é a pessoa pedindo para voltar. Reativar
       * quem pediu para sair porque o telefone dela estava num arquivo é
       * exatamente o que §14.1 proíbe, e é o que um `INSERT ... ON CONFLICT DO
       * UPDATE` ingênuo faria sem ninguém notar.
       *
       * Só os campos de identificação são completados, e apenas onde estavam
       * vazios: a planilha acrescenta o que falta, nunca sobrescreve o que o
       * sistema já sabe.
       */
      await tx
        .update(contacts)
        .set({
          name: existente.name ?? item.nome,
          phoneE164: existente.phoneE164 ?? item.telefone,
          email: existente.email ?? item.email,
          cpf: existente.cpf ?? item.cpf,
          externalId: existente.externalId ?? item.externalId,
          // União feita aqui, e não em SQL: o Drizzle expande array de JS em
          // um parâmetro por item, e `($1, $2)::text[]` é um record, que o
          // Postgres recusa. Com o valor atual em mãos, JS resolve melhor.
          ...(item.tags.length > 0
            ? { tags: [...new Set([...existente.tags, ...item.tags])] }
            : {}),
          updatedAt: agora,
        })
        .where(eq(contacts.id, existente.id))

      if (existente.optedOutAt) preservados += 1
      else atualizados += 1

      if (etapaInicial) {
        leadsCriados += await criarLead(tx, orgId, existente.id, item, etapaInicial, opcoes, agora)
      }
      continue
    }

    const [novo] = await tx
      .insert(contacts)
      .values({
        orgId,
        name: item.nome,
        phoneE164: item.telefone,
        email: item.email,
        cpf: item.cpf,
        externalId: item.externalId,
        tags: item.tags,
        /*
         * `import` é a origem do consentimento (§14.1), e é uma declaração:
         * quem importa afirma ter base legal para falar com essas pessoas. O
         * campo existe para que essa afirmação fique registrada com data.
         */
        optinSource: 'import',
        optinAt: agora,
      })
      .returning({ id: contacts.id })

    if (!novo) continue
    criados += 1

    if (etapaInicial) {
      leadsCriados += await criarLead(tx, orgId, novo.id, item, etapaInicial, opcoes, agora)
    }
  }

  log.info('importação concluída', { criados, atualizados, preservados, leadsCriados })
  return { criados, atualizados, preservados, leadsCriados }
}

/**
 * Acha o contato que já existe, na ordem de confiança da chave.
 *
 * `external_id` primeiro porque é o identificador da plataforma e não muda;
 * telefone depois; e-mail por último, que é o que mais se compartilha em
 * família. Procurar por e-mail primeiro juntaria duas pessoas num contato só.
 */
async function acharContato(tx: Tx, orgId: string, item: LinhaValidada) {
  const colunas = {
    id: contacts.id,
    name: contacts.name,
    phoneE164: contacts.phoneE164,
    email: contacts.email,
    cpf: contacts.cpf,
    externalId: contacts.externalId,
    tags: contacts.tags,
    optedOutAt: contacts.optedOutAt,
  }

  if (item.externalId) {
    const [achado] = await tx
      .select(colunas)
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.externalId, item.externalId)))
      .limit(1)
    if (achado) return achado
  }

  if (item.telefone) {
    const [achado] = await tx
      .select(colunas)
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.phoneE164, item.telefone)))
      .limit(1)
    if (achado) return achado
  }

  if (item.email) {
    const [achado] = await tx
      .select(colunas)
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.email, item.email)))
      .limit(1)
    if (achado) return achado
  }

  return null
}

/** A primeira etapa do pipeline padrão — onde todo lead novo entra. */
async function primeiraEtapa(
  tx: Tx,
  orgId: string,
): Promise<{ pipelineId: string; stageId: string } | null> {
  const [pipeline] = await tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.orgId, orgId), eq(pipelines.isDefault, true)))
    .limit(1)

  if (!pipeline) return null

  const [etapa] = await tx
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipeline.id))
    .orderBy(pipelineStages.position)
    .limit(1)

  return etapa ? { pipelineId: pipeline.id, stageId: etapa.id } : null
}

/**
 * Cria o lead, se o contato ainda não tiver um aberto.
 *
 * Importar a mesma planilha duas vezes é acidente comum — e sem esta guarda a
 * segunda vez duplica o pipeline inteiro.
 */
async function criarLead(
  tx: Tx,
  orgId: string,
  contactId: string,
  item: LinhaValidada,
  etapa: { pipelineId: string; stageId: string },
  opcoes: { ownerId?: string | null; origem?: string },
  agora: Date,
): Promise<number> {
  const [aberto] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.orgId, orgId),
        eq(leads.contactId, contactId),
        eq(leads.status, 'aberto'),
      ),
    )
    .limit(1)

  if (aberto) return 0

  await tx.insert(leads).values({
    orgId,
    contactId,
    pipelineId: etapa.pipelineId,
    stageId: etapa.stageId,
    ownerId: opcoes.ownerId ?? null,
    title: item.titulo ?? item.nome ?? 'Lead importado',
    valueCents: item.valorCents,
    source: opcoes.origem ?? 'importacao',
    stageChangedAt: agora,
  })

  return 1
}
