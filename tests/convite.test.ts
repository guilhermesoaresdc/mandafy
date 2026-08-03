import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'

/**
 * Convite e recuperação de senha (§9.4, §14.1).
 *
 * Contra Postgres de verdade porque é lá que tudo o que importa acontece: uso
 * único, prazo, invalidação dos outros links, queda das sessões abertas e a
 * exigência de conta ativa. Todas essas regras vivem em `mandafy_definir_senha`
 * e num objeto em memória não existiriam.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`
const ORG = uid('d01')
const PESSOA = uid('d02')

describe.skipIf(!habilitado)('§9.4 — acesso por convite', () => {
  let admin: postgres.Sql
  let tokens: typeof import('@/lib/auth/tokens')
  let senha: typeof import('@/lib/auth/password')

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    tokens = await import('@/lib/auth/tokens')
    senha = await import('@/lib/auth/password')

    await admin`
      INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Convite', 'convite-teste')
      ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 0 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM users WHERE org_id = ${ORG}`
    await admin`
      INSERT INTO users (id, org_id, name, email, password_hash, role, active)
      VALUES (${PESSOA}, ${ORG}, 'Convidada', 'convidada@teste.local', '', 'consultor', true)`
  })

  const conta = async () => {
    const [l] = await admin<{ password_hash: string; active: boolean }[]>`
      SELECT password_hash, active FROM users WHERE id = ${PESSOA}`
    return l!
  }

  it('quem foi convidado existe, está ativo e NÃO entra', async () => {
    const c = await conta()

    // Os dois estados são independentes: ativo é "o admin permite", hash vazio
    // é "ainda não definiu senha". Confundi-los faria um link antigo devolver
    // acesso a quem foi desligado.
    expect(c.active).toBe(true)
    expect(c.password_hash).toBe('')

    // Hash vazio não casa com senha nenhuma — nem com string vazia.
    expect(await senha.verifyPassword('', '')).toBe(false)
    expect(await senha.verifyPassword('qualquer-coisa', '')).toBe(false)
  })

  it('o link define a senha e a pessoa passa a entrar', async () => {
    const token = await tokens.emitirToken(PESSOA, 'convite')

    const leitura = await tokens.lerToken(token)
    expect(leitura.ok).toBe(true)

    const hash = await senha.hashPassword('senha-bem-comprida')
    expect(await tokens.consumirToken(token, hash)).toBe(PESSOA)

    expect(await senha.verifyPassword('senha-bem-comprida', (await conta()).password_hash)).toBe(
      true,
    )
  })

  it('o mesmo link NÃO funciona duas vezes', async () => {
    const token = await tokens.emitirToken(PESSOA, 'convite')
    await tokens.consumirToken(token, await senha.hashPassword('primeira-senha-longa'))

    // Um link sobrevive ao encaminhamento do e-mail, ao histórico do navegador
    // e a um print. Uso único é o que limita o estrago.
    const segunda = await tokens.consumirToken(token, await senha.hashPassword('segunda-senha-x'))
    expect(segunda).toBeNull()

    const leitura = await tokens.lerToken(token)
    expect(leitura).toMatchObject({ ok: false, motivo: 'usado' })

    // E a senha continua sendo a primeira.
    expect(await senha.verifyPassword('primeira-senha-longa', (await conta()).password_hash)).toBe(
      true,
    )
  })

  it('dois cliques simultâneos trocam a senha UMA vez', async () => {
    const token = await tokens.emitirToken(PESSOA, 'convite')

    const [a, b] = await Promise.all([
      tokens.consumirToken(token, await senha.hashPassword('senha-da-esquerda')),
      tokens.consumirToken(token, await senha.hashPassword('senha-da-direita')),
    ])

    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('emitir um link novo mata o anterior', async () => {
    const velho = await tokens.emitirToken(PESSOA, 'convite')
    const novo = await tokens.emitirToken(PESSOA, 'recuperacao')

    // Pedir recuperação três vezes não pode deixar três chaves circulando.
    expect(await tokens.lerToken(velho)).toMatchObject({ ok: false, motivo: 'usado' })
    expect((await tokens.lerToken(novo)).ok).toBe(true)
  })

  it('link vencido não vale', async () => {
    const token = await tokens.emitirToken(PESSOA, 'recuperacao')
    await admin`UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
                WHERE user_id = ${PESSOA} AND used_at IS NULL`

    expect(await tokens.lerToken(token)).toMatchObject({ ok: false, motivo: 'expirado' })
    expect(await tokens.consumirToken(token, await senha.hashPassword('nao-deveria-valer'))).toBeNull()
  })

  it('conta desligada não define senha, nem com link válido', async () => {
    const token = await tokens.emitirToken(PESSOA, 'convite')
    await admin`UPDATE users SET active = false WHERE id = ${PESSOA}`

    // O cenário exato que motivou separar `active` de "convite pendente": um
    // convite antigo não pode devolver o acesso que o administrador retirou.
    expect(await tokens.lerToken(token)).toMatchObject({ ok: false, motivo: 'inativo' })
    expect(await tokens.consumirToken(token, await senha.hashPassword('nao-deveria-valer'))).toBeNull()
    expect((await conta()).password_hash).toBe('')
  })

  it('definir senha derruba as sessões abertas', async () => {
    await admin`UPDATE users SET password_hash = 'x' WHERE id = ${PESSOA}`
    await admin`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES ('sessao-de-teste-convite', ${PESSOA}, now() + interval '1 day')`

    const token = await tokens.emitirToken(PESSOA, 'recuperacao')
    await tokens.consumirToken(token, await senha.hashPassword('senha-nova-longa'))

    /*
     * Quem redefine a senha costuma estar reagindo a acesso indevido. Deixar a
     * sessão do invasor viva tornaria a troca decorativa — ele continuaria
     * dentro por até trinta dias.
     */
    const [restantes] = await admin<{ total: number }[]>`
      SELECT count(*)::int AS total FROM sessions WHERE user_id = ${PESSOA}`
    expect(restantes?.total).toBe(0)
  })

  it('token malformado é recusado sem tocar o banco', async () => {
    for (const lixo of ['', 'curto', '../../etc/passwd', 'a'.repeat(200), 'com espaço']) {
      expect(await tokens.lerToken(lixo)).toMatchObject({ ok: false, motivo: 'invalido' })
    }
  })

  it('a busca por e-mail ignora a caixa', async () => {
    // A coluna é citext: quem digita CONVIDADA@ no "esqueci minha senha"
    // precisa encontrar a mesma conta.
    expect(await tokens.contaPorEmail('CONVIDADA@TESTE.LOCAL')).toMatchObject({ userId: PESSOA })
    expect(await tokens.contaPorEmail('ninguem@teste.local')).toBeNull()
  })
})
