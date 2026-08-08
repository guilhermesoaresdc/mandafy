import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Autenticação do batimento (§7.1).
 *
 * Existe porque as recusas são um instrumento de diagnóstico, não só um
 * portão. Quando o batimento para, o sistema inteiro para de entregar — e
 * quem opera vê apenas a resposta desta rota no painel do agendador. Se os
 * quatro modos de falha respondessem a mesma coisa, cada parada viraria uma
 * caça ao tesouro entre o painel do agendador e o da hospedagem.
 *
 * Cada caso abaixo se conserta num lugar DIFERENTE. É isso que o teste
 * protege: não que a rota recuse, mas que ela diga onde mexer.
 */

const SEGREDO = 'segredo-de-teste-longo-o-suficiente'

async function chamar(headers: Record<string, string>) {
  const { GET } = await import('@/app/api/cron/route')
  const requisicao = new Request('https://exemplo.test/api/cron', { headers })
  // A rota só usa `headers` do NextRequest neste caminho.
  const resposta = await GET(requisicao as never)
  return { status: resposta.status, corpo: (await resposta.json()) as Record<string, unknown> }
}

/**
 * O ambiente mínimo vem de `tests/ambiente.ts` (setupFiles), e NÃO daqui.
 *
 * Este arquivo já teve um `AMBIENTE_MINIMO` próprio, com
 * `DATABASE_URL: 'postgres://ninguem:ninguem@…/nada'` — um endereço inválido de
 * propósito, porque nenhum caso deste arquivo abre banco. Era verdade, e ainda
 * assim quebrou o CI inteiro no dia em que as suítes de banco passaram a rodar.
 *
 * `vi.stubEnv` mexe no ambiente do PROCESSO, e o `@/db` guarda o pool num
 * singleton de módulo criado na primeira importação. Com o endereço envenenado
 * no ar, o pool nascia apontando para um papel que não existe — e o `postgres`
 * só se conecta na primeira consulta, então a falha não aparecia aqui: aparecia
 * dois arquivos adiante, num `beforeEach` que estourava o tempo tentando falar
 * com um banco inexistente.
 *
 * A lição, e o motivo de o comentário ser longo: um valor falso só é inofensivo
 * enquanto ninguém o usa, e "ninguém usa" é uma afirmação sobre o resto da
 * suíte, não sobre este arquivo.
 */
describe('§7.1 — autenticação do batimento', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.CRON_SECRET = SEGREDO
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
    vi.unstubAllEnvs()
  })

  it('sem cabeçalho: manda configurar o cabeçalho no agendador', async () => {
    const { status, corpo } = await chamar({})

    expect(status).toBe(401)
    expect(corpo.error).toBe('sem_credencial')
    expect(String(corpo.hint)).toMatch(/Authorization/)
  })

  /*
   * O engano mais comum ao configurar um agendador externo: o painel pede
   * nome e valor em campos separados, e cola-se só o segredo no valor. Antes
   * isto respondia igual a um segredo desatualizado, então quem estava com o
   * formato errado ia revirar as variáveis da hospedagem, que estavam certas.
   */
  it('sem o prefixo Bearer: diz que falta o prefixo, não que o segredo está errado', async () => {
    const { status, corpo } = await chamar({ authorization: SEGREDO })

    expect(status).toBe(401)
    expect(corpo.error).toBe('formato_invalido')
    expect(String(corpo.hint)).toMatch(/Bearer/)
  })

  it('valor diferente: informa quantos caracteres chegaram', async () => {
    const { status, corpo } = await chamar({ authorization: 'Bearer valor-que-nao-e-o-certo' })

    expect(status).toBe(401)
    expect(corpo.error).toBe('nao_autorizado')
    // O tamanho do que FOI ENVIADO — quem chamou já sabe, então não vaza nada,
    // e é o que denuncia um valor cortado ao colar.
    expect(corpo.recebidos).toBe('valor-que-nao-e-o-certo'.length)
  })

  it('nunca revela o tamanho do segredo do servidor', async () => {
    const { corpo } = await chamar({ authorization: 'Bearer errado' })
    const texto = JSON.stringify(corpo)

    expect(texto).not.toContain(SEGREDO)
    expect(texto).not.toContain(String(SEGREDO.length))
  })

  /*
   * 503 e não 401 quando o servidor é que está sem segredo: um agendador que
   * recebe 401 conclui que a PRÓPRIA credencial está errada, e manda o
   * operador procurar no lugar errado.
   */
  it('servidor sem CRON_SECRET responde 503, não 401', async () => {
    delete process.env.CRON_SECRET
    const { status, corpo } = await chamar({ authorization: 'Bearer qualquer-coisa' })

    expect(status).toBe(503)
    expect(corpo.error).toBe('cron_secret_ausente')
  })

  it('segredo curto do lado do servidor também é 503, com o motivo certo', async () => {
    process.env.CRON_SECRET = 'curto'
    const { status, corpo } = await chamar({ authorization: 'Bearer curto' })

    expect(status).toBe(503)
    expect(corpo.error).toBe('cron_secret_curto')
  })

  it('aceita Bearer em qualquer caixa e com espaço nas pontas', async () => {
    // Painel web arrasta espaço ao colar; um segredo não muda de significado
    // por causa disso.
    const { status } = await chamar({ authorization: `  bEaReR   ${SEGREDO}  ` })
    expect(status).not.toBe(401)
  })
})
