import { and, eq, inArray, or, type SQL } from 'drizzle-orm'
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
 * A regra que este arquivo existe para cumprir está em `montarAtualizacao`:
 * importação NUNCA mexe em consentimento de contato que já existe.
 *
 * POR QUE EM LOTE, E NÃO LINHA A LINHA
 *
 * A primeira versão fazia de três a seis consultas POR LINHA. Com o banco na
 * mesma máquina isso é invisível; com o banco a 120 ms de distância — que é a
 * situação real, função numa região e Postgres em outra — cinco mil linhas
 * viram horas de ida e volta, e a função morre no limite de tempo muito antes.
 * Pior: morre no meio, com parte da base gravada.
 *
 * Aqui o número de consultas não cresce com o tamanho do arquivo: uma busca
 * para todos os contatos, uma inserção para todos os novos, uma busca e uma
 * inserção para os leads. O que sobra por linha é só o UPDATE de quem já
 * existia E tinha campo vazio para completar — e esse é justamente o caso raro.
 */

const log = createLogger('importar-leads')

export type ResultadoImportacao = {
  criados: number
  atualizados: number
  /** Já existiam e tinham pedido para sair — não foram reativados. */
  preservados: number
  leadsCriados: number
}

/** Quanto entra por INSERT. Um `VALUES` gigante estoura o limite de parâmetros. */
const LOTE = 500

type ContatoExistente = {
  id: string
  name: string | null
  phoneE164: string | null
  email: string | null
  cpf: string | null
  externalId: string | null
  tags: string[]
  optedOutAt: Date | null
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
  if (validas.length === 0) {
    return { criados: 0, atualizados: 0, preservados: 0, leadsCriados: 0 }
  }

  const agora = new Date()
  const existentes = await buscarExistentes(tx, orgId, validas)

  let atualizados = 0
  let preservados = 0

  /*
   * Duas linhas podem apontar para o MESMO contato por chaves diferentes — uma
   * casa pelo telefone, outra pelo e-mail. `conferir` não tem como saber disso,
   * porque só o banco sabe. Sem este controle, a segunda linha viraria contato
   * novo e esbarraria no índice único.
   */
  const jaResolvidos = new Set<string>()
  const paraInserir: LinhaValidada[] = []
  const contatoDaLinha = new Map<number, string>()

  for (const item of validas) {
    const existente = achar(existentes, item)

    if (!existente) {
      paraInserir.push(item)
      continue
    }

    if (jaResolvidos.has(existente.id)) continue
    jaResolvidos.add(existente.id)
    contatoDaLinha.set(item.linha, existente.id)

    if (existente.optedOutAt) preservados += 1
    else atualizados += 1

    const mudanca = montarAtualizacao(existente, item)
    // Só vai ao banco quem tem o que mudar. Reimportar a mesma planilha, que é
    // o caso mais comum, não gera UPDATE nenhum.
    if (mudanca) {
      await tx
        .update(contacts)
        .set({ ...mudanca, updatedAt: agora })
        .where(eq(contacts.id, existente.id))
    }
  }

  for (let i = 0; i < paraInserir.length; i += LOTE) {
    const fatia = paraInserir.slice(i, i + LOTE)
    const novos = await tx
      .insert(contacts)
      .values(
        fatia.map((item) => ({
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
          optinSource: 'import' as const,
          optinAt: agora,
        })),
      )
      .returning({ id: contacts.id })

    novos.forEach((novo, j) => {
      const item = fatia[j]
      if (item) contatoDaLinha.set(item.linha, novo.id)
    })
  }

  const leadsCriados = opcoes.criarLeads
    ? await abrirLeads(tx, orgId, validas, contatoDaLinha, opcoes, agora)
    : 0

  const resultado = { criados: paraInserir.length, atualizados, preservados, leadsCriados }
  log.info('importação concluída', resultado)
  return resultado
}

/**
 * Traz de uma vez todo contato que já existe e casa com alguma chave do
 * arquivo. Uma consulta, não uma por linha.
 */
async function buscarExistentes(
  tx: Tx,
  orgId: string,
  validas: LinhaValidada[],
): Promise<ContatoExistente[]> {
  const externos = [...new Set(validas.map((v) => v.externalId).filter((v): v is string => !!v))]
  const telefones = [...new Set(validas.map((v) => v.telefone).filter((v): v is string => !!v))]
  const emails = [...new Set(validas.map((v) => v.email).filter((v): v is string => !!v))]

  const chaves: SQL[] = []
  if (externos.length) chaves.push(inArray(contacts.externalId, externos))
  if (telefones.length) chaves.push(inArray(contacts.phoneE164, telefones))
  if (emails.length) chaves.push(inArray(contacts.email, emails))
  if (chaves.length === 0) return []

  return tx
    .select({
      id: contacts.id,
      name: contacts.name,
      phoneE164: contacts.phoneE164,
      email: contacts.email,
      cpf: contacts.cpf,
      externalId: contacts.externalId,
      tags: contacts.tags,
      optedOutAt: contacts.optedOutAt,
    })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), or(...chaves)))
}

/**
 * Qual contato é este, na ordem de confiança da chave.
 *
 * `external_id` primeiro porque é o identificador da plataforma e não muda;
 * telefone depois; e-mail por último, que é o que mais se compartilha em
 * família. Procurar por e-mail primeiro juntaria duas pessoas num contato só.
 */
function achar(existentes: ContatoExistente[], item: LinhaValidada): ContatoExistente | null {
  if (item.externalId) {
    const achado = existentes.find((c) => c.externalId === item.externalId)
    if (achado) return achado
  }
  if (item.telefone) {
    const achado = existentes.find((c) => c.phoneE164 === item.telefone)
    if (achado) return achado
  }
  if (item.email) {
    const achado = existentes.find((c) => c.email === item.email)
    if (achado) return achado
  }
  return null
}

/**
 * O que a planilha pode mudar num contato que já existe — e só isso.
 *
 * CONTATO QUE EXISTE NÃO TEM O CONSENTIMENTO MEXIDO.
 *
 * Aparecer numa planilha não é a pessoa pedindo para voltar. Reativar quem
 * pediu para sair porque o telefone dela estava num arquivo é exatamente o que
 * §14.1 proíbe, e é o que um `INSERT ... ON CONFLICT DO UPDATE` ingênuo faria
 * sem ninguém notar. Nenhuma coluna de opt-in aparece abaixo, de propósito.
 *
 * Os campos de identificação são completados apenas onde estavam vazios: a
 * planilha acrescenta o que falta, nunca sobrescreve o que o sistema já sabe.
 *
 * Devolve `null` quando não há nada a mudar — e aí nem UPDATE acontece.
 */
function montarAtualizacao(
  existente: ContatoExistente,
  item: LinhaValidada,
): Partial<typeof contacts.$inferInsert> | null {
  const mudanca: Partial<typeof contacts.$inferInsert> = {}

  if (!existente.name && item.nome) mudanca.name = item.nome
  if (!existente.phoneE164 && item.telefone) mudanca.phoneE164 = item.telefone
  if (!existente.email && item.email) mudanca.email = item.email
  if (!existente.cpf && item.cpf) mudanca.cpf = item.cpf
  if (!existente.externalId && item.externalId) mudanca.externalId = item.externalId

  const novas = item.tags.filter((t) => !existente.tags.includes(t))
  if (novas.length > 0) mudanca.tags = [...existente.tags, ...novas]

  return Object.keys(mudanca).length > 0 ? mudanca : null
}

/**
 * Abre um lead para cada contato que ainda não tem um aberto.
 *
 * Importar a mesma planilha duas vezes é acidente comum — e sem a consulta dos
 * já abertos a segunda vez duplicaria o pipeline inteiro.
 */
async function abrirLeads(
  tx: Tx,
  orgId: string,
  validas: LinhaValidada[],
  contatoDaLinha: Map<number, string>,
  opcoes: { ownerId?: string | null; origem?: string },
  agora: Date,
): Promise<number> {
  const etapa = await primeiraEtapa(tx, orgId)
  if (!etapa) {
    // Sem funil configurado não há onde pôr o cartão. Os contatos entraram, que
    // é o que serve para disparo; dizer isso alto é melhor que fingir sucesso.
    log.warn('sem funil padrão: contatos importados sem lead')
    return 0
  }

  const ids = [...new Set([...contatoDaLinha.values()])]
  if (ids.length === 0) return 0

  const abertos = new Set<string>()
  for (let i = 0; i < ids.length; i += LOTE) {
    const linhas = await tx
      .select({ contactId: leads.contactId })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, orgId),
          eq(leads.status, 'aberto'),
          inArray(leads.contactId, ids.slice(i, i + LOTE)),
        ),
      )
    for (const l of linhas) abertos.add(l.contactId)
  }

  const novos = []
  const jaEnfileirados = new Set<string>()

  for (const item of validas) {
    const contactId = contatoDaLinha.get(item.linha)
    if (!contactId || abertos.has(contactId) || jaEnfileirados.has(contactId)) continue
    jaEnfileirados.add(contactId)

    novos.push({
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
  }

  for (let i = 0; i < novos.length; i += LOTE) {
    await tx.insert(leads).values(novos.slice(i, i + LOTE))
  }

  return novos.length
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
