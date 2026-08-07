import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { normalizeRawEvent, reprocessPending } from '@/lib/ingest/normalize'

/**
 * Da chegada do webhook ao evento canônico (§4).
 *
 * O CAMINHO QUE MORREU EM PRODUÇÃO SEM TESTE NENHUM
 *
 * Um `new-user` chegou às 18:53, ficou "na fila" e nunca virou nada. O
 * batimento respondia 200 de minuto em minuto com `normalizados: 0`, o painel
 * dizia "o evento nunca chegou" e não havia erro em lugar algum.
 *
 * A causa: dois caminhos de saída de `normalizeRawEvent` devolviam erro SEM
 * marcar a linha. Sem `processed_at` e sem `error`, ela é exatamente o que a
 * varredura de pendentes procura — então voltava no minuto seguinte, e no
 * seguinte, para sempre. Um laço silencioso, com todos os sinais verdes.
 *
 * A LIÇÃO QUE ESTE ARQUIVO PRENDE
 *
 * Toda saída de `normalizeRawEvent` marca a linha. "Não consegui ler" não é
 * "ainda não chegou a vez": é um defeito, e precisa aparecer como tal.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`
const ORG = uid('b01')
const FONTE = uid('b02')

/** O payload real da plataforma, achatado como ela manda. */
const NOVO_USUARIO = {
  id: '6a73b0bdaa711cd866a5686b',
  cpf: '04106503077',
  date: '2026-08-05T18:53:02.131-03:00',
  name: 'VINICIUS MATHEUS ROQUE',
  email: 'vinicius@exemplo.com.br',
  event: 'new-user',
  phone: '+5511972425144',
  message: 'Novo usuário VINICIUS MATHEUS ROQUE',
}

/** O mapeamento que a tela de conexão monta para esse payload achatado. */
const MAPA = {
  event_path: '$.event',
  event_map: { 'new-user': 'user.created' },
  contact: {
    external_id: '$.id',
    name: '$.name',
    phone: '$.phone',
    email: '$.email',
  },
  fields: { external_id: '$.id' },
}

describe.skipIf(!habilitado)('§4 — normalizar o evento que chegou', () => {
  let admin: postgres.Sql

  async function limpar() {
    await admin`DELETE FROM events_raw WHERE source_id = ${FONTE}`
    await admin`DELETE FROM events WHERE org_id = ${ORG}`
    await admin`DELETE FROM notifications WHERE org_id = ${ORG}`
    await admin`DELETE FROM contacts WHERE org_id = ${ORG}`
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })

    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin`INSERT INTO organizations (id, name, slug)
                VALUES (${ORG}, 'Banca', 'normalizar-org')`
    await admin`INSERT INTO sources (id, org_id, name, ingest_token, mapping)
                VALUES (${FONTE}, ${ORG}, 'Techloto', ${'tok-normalizar-teste'}, ${JSON.stringify(MAPA)}::jsonb)`
  })

  afterAll(async () => {
    if (!habilitado) return
    await limpar()
    await admin`DELETE FROM sources WHERE id = ${FONTE}`
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 0 })
  })

  beforeEach(limpar)

  /** Grava o evento cru como a rota de webhook grava. */
  async function chegar(payload: unknown, sourceId: string | null = FONTE): Promise<number> {
    const [linha] = await admin<{ id: string }[]>`
      INSERT INTO events_raw (source_id, payload, dedupe_hash, signature_ok)
      VALUES (${sourceId}, ${JSON.stringify(payload)}::jsonb, ${Math.random().toString(36)}, true)
      RETURNING id`
    return Number(linha!.id)
  }

  async function estado(rawId: number) {
    const [linha] = await admin<{ processed_at: Date | null; error: string | null }[]>`
      SELECT processed_at, error FROM events_raw WHERE id = ${rawId}`
    return linha!
  }

  it('o cadastro vira evento canônico e contato', async () => {
    const rawId = await chegar(NOVO_USUARIO)
    const r = await normalizeRawEvent(rawId)

    expect(r.status).toBe('processado')
    if (r.status === 'processado') expect(r.type).toBe('user.created')

    const [evento] = await admin<{ type: string }[]>`
      SELECT type FROM events WHERE org_id = ${ORG}`
    expect(evento?.type).toBe('user.created')

    // O nome precisa chegar ao contato: sem ele toda mensagem sai com o padrão
    // "tudo bem" no lugar do nome que a plataforma mandou.
    const [contato] = await admin<{ name: string; phone_e164: string }[]>`
      SELECT name, phone_e164 FROM contacts WHERE org_id = ${ORG}`
    expect(contato?.name).toBe('VINICIUS MATHEUS ROQUE')
    expect(contato?.phone_e164).toBe('+5511972425144')
  })

  /*
   * O CONTATO NASCIA SEM CONSENTIMENTO, E A BASE INTEIRA FICAVA MUDA.
   *
   * O cadastro entrava, virava contato, e todo envio promocional parava na
   * guarda com `sem_optin` — para gente que aceitou receber no cadastro da
   * plataforma, antes de o webhook sair de lá. A importação por planilha já
   * registrava o aceite; a ingestão, não.
   */
  it('quem se cadastra na plataforma entra com o consentimento registrado', async () => {
    const rawId = await chegar(NOVO_USUARIO)
    await normalizeRawEvent(rawId)

    const [contato] = await admin<{ optin_at: Date | null; optin_source: string | null }[]>`
      SELECT optin_at, optin_source FROM contacts WHERE org_id = ${ORG}`

    expect(contato?.optin_at, 'sem data de aceite, nada promocional sai').not.toBeNull()
    // `checkout`: o aceite veio do cadastro na plataforma, não de planilha.
    expect(contato?.optin_source).toBe('checkout')
  })

  it('quem já estava na base sem aceite passa a ter, com a data do evento', async () => {
    await admin`INSERT INTO contacts (org_id, phone_e164, name)
                VALUES (${ORG}, ${NOVO_USUARIO.phone}, 'Antigo')`

    await normalizeRawEvent(await chegar(NOVO_USUARIO))

    const [contato] = await admin<{ optin_at: Date | null }[]>`
      SELECT optin_at FROM contacts WHERE org_id = ${ORG}`
    expect(contato?.optin_at).not.toBeNull()
  })

  /*
   * A linha que não se cruza: consentimento é registro, não reativação. Quem
   * pediu para sair continua fora, por mais eventos que a plataforma mande.
   */
  it('quem pediu para sair NÃO volta por causa de um evento novo', async () => {
    await admin`INSERT INTO contacts (org_id, phone_e164, name, opted_out_at)
                VALUES (${ORG}, ${NOVO_USUARIO.phone}, 'Saiu', now())`

    await normalizeRawEvent(await chegar(NOVO_USUARIO))

    const [contato] = await admin<{ optin_at: Date | null; opted_out_at: Date | null }[]>`
      SELECT optin_at, opted_out_at FROM contacts WHERE org_id = ${ORG}`
    expect(contato?.optin_at).toBeNull()
    expect(contato?.opted_out_at).not.toBeNull()
  })

  it('o evento processado é MARCADO, e a varredura não o pega de novo', async () => {
    const rawId = await chegar(NOVO_USUARIO)
    await normalizeRawEvent(rawId)

    expect((await estado(rawId)).processed_at).not.toBeNull()

    // Sem a marca, o mesmo cadastro dispararia o fluxo a cada batida — uma
    // boas-vindas por minuto para o mesmo cliente.
    const segunda = await reprocessPending(50)
    expect(segunda.vistos).toBe(0)
  })

  /*
   * O CASO QUE DERRUBOU A PRODUÇÃO.
   *
   * `mandafy_evento_cru` não devolve linha — a origem sumiu, a função não
   * existe, o id não bate. Antes isso saía daqui sem tocar em `events_raw`, e a
   * linha continuava sendo "pendente" para a varredura seguinte.
   */
  it('evento ilegível é MARCADO com erro, em vez de ficar pendente para sempre', async () => {
    const rawId = await chegar(NOVO_USUARIO)
    // Um id que não existe reproduz "a função não devolveu linha".
    const r = await normalizeRawEvent(rawId + 999_999)
    expect(r.status).toBe('erro')

    // E a linha de verdade continua intocada — marcar a errada seria pior.
    expect((await estado(rawId)).processed_at).toBeNull()
  })

  it('evento sem origem vinculada é marcado, não repetido', async () => {
    const rawId = await chegar(NOVO_USUARIO, null)
    const r = await normalizeRawEvent(rawId)

    expect(r.status).toBe('erro')

    /*
     * O motivo que sai é `evento_cru_nao_encontrado`, e não `sem_conector`.
     *
     * `mandafy_evento_cru` junta `events_raw` com `sources` por INNER JOIN, e
     * uma linha sem origem não sobrevive à junção — então ela some antes de
     * chegar à verificação de `source_id`. A guarda de `sem_conector` fica como
     * rede: quem chamar `normalizeRawEvent` por outro caminho ainda a alcança.
     *
     * O que importa é o mesmo nos dois: a linha PAROU de ser pendente.
     */
    const depois = await estado(rawId)
    expect(depois.processed_at, 'ficou pendente e voltaria para sempre').not.toBeNull()
    expect(depois.error).toBeTruthy()
  })

  it('evento que o mapa não entende vira "não aproveitado", com o motivo', async () => {
    const rawId = await chegar({ ...NOVO_USUARIO, event: 'evento-que-ninguem-mapeou' })
    const r = await normalizeRawEvent(rawId)

    expect(r.status).toBe('ignorado')

    // Marcado, senão a varredura giraria em falso sobre ele para sempre — e a
    // tela de conexão precisa mostrar o que está chegando e não sendo usado.
    const depois = await estado(rawId)
    expect(depois.processed_at).not.toBeNull()
    expect(depois.error).toBeTruthy()
  })

  /*
   * O sintoma como ele apareceu: a varredura RODA, encontra trabalho e não
   * conclui nada. Enquanto ela devolvia só um número, "0" queria dizer tanto
   * "não havia nada" quanto "havia, e tudo falhou" — e as duas eram a mesma
   * linha na resposta do batimento.
   */
  it('a varredura relata quantos viu, e por que não deram certo', async () => {
    await chegar({ ...NOVO_USUARIO, event: 'nao-mapeado-1' })
    await chegar({ ...NOVO_USUARIO, event: 'nao-mapeado-2' })

    const r = await reprocessPending(50)

    expect(r.vistos).toBe(2)
    expect(r.processados).toBe(0)
    expect(Object.values(r.motivos).reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('a varredura processa os pendentes de verdade', async () => {
    await chegar(NOVO_USUARIO)
    await chegar({ ...NOVO_USUARIO, id: 'outro-id-de-usuario', name: 'MARIA' })

    const r = await reprocessPending(50)

    expect(r.vistos).toBe(2)
    expect(r.processados).toBe(2)
    expect(r.motivos).toEqual({})
  })

  it('nada pendente devolve zero em tudo, sem inventar motivo', async () => {
    const r = await reprocessPending(50)
    expect(r).toEqual({ processados: 0, vistos: 0, motivos: {} })
  })

  /*
   * A regra que fecha o laço: NENHUMA saída de `normalizeRawEvent` pode deixar
   * a linha como a varredura a encontrou. Se um caminho novo esquecer de
   * marcar, o evento volta a girar em silêncio — e é assim que este projeto
   * perdeu um dia inteiro de disparos.
   */
  it('em nenhum desfecho a linha volta a ficar pendente', async () => {
    const casos = [
      NOVO_USUARIO,
      { ...NOVO_USUARIO, event: 'nao-mapeado' },
      { ...NOVO_USUARIO, event: undefined },
      { ...NOVO_USUARIO, phone: undefined, email: undefined },
      {},
    ]

    for (const payload of casos) {
      const rawId = await chegar(payload)
      await normalizeRawEvent(rawId)

      const depois = await estado(rawId)
      expect(
        depois.processed_at,
        `payload ${JSON.stringify(payload).slice(0, 60)} ficou pendente`,
      ).not.toBeNull()
    }

    // E a prova final: depois de tudo, não sobra nada para a varredura.
    expect((await reprocessPending(50)).vistos).toBe(0)
  })
})
