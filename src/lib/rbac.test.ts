import { describe, expect, it } from 'vitest'
import { assertCan, can, ForbiddenError, leadOwnerFilter, PERMISSIONS } from './rbac'

const admin = { id: 'u-admin', role: 'admin' as const }
const consultor = { id: 'u-consultor', role: 'consultor' as const }

/**
 * A matriz de §9.4, transcrita para teste. Se a spec mudar, este arquivo é o
 * primeiro a quebrar — que é exatamente o que queremos.
 */
const MATRIZ_SPEC = [
  { permissao: 'leads.ver_todos', admin: true, consultor: false },
  { permissao: 'leads.editar_proprio', admin: true, consultor: true },
  { permissao: 'leads.reatribuir', admin: true, consultor: false },
  { permissao: 'pipeline.ver_completo', admin: true, consultor: false },
  { permissao: 'mensagens.gerenciar', admin: true, consultor: false },
  { permissao: 'fluxos.gerenciar', admin: true, consultor: false },
  { permissao: 'canais.gerenciar', admin: true, consultor: false },
  { permissao: 'notificacoes.ver_todas', admin: true, consultor: false },
  { permissao: 'mensagem.enviar_manual', admin: true, consultor: true },
  { permissao: 'integracoes.gerenciar', admin: true, consultor: false },
  { permissao: 'usuarios.gerenciar', admin: true, consultor: false },
  { permissao: 'faturamento.ver', admin: true, consultor: false },
  // Direitos do titular (§14.1): exportar e anonimizar dado pessoal é do
  // administrador. Consultor conversa com o lead; não manipula o registro.
  { permissao: 'contatos.exportar', admin: true, consultor: false },
  { permissao: 'contatos.anonimizar', admin: true, consultor: false },
] as const

describe('can — matriz de controle de acesso (§9.4)', () => {
  it.each(MATRIZ_SPEC)(
    '$permissao → admin=$admin consultor=$consultor',
    ({ permissao, admin: esperadoAdmin, consultor: esperadoConsultor }) => {
      expect(can(admin, permissao)).toBe(esperadoAdmin)
      expect(can(consultor, permissao)).toBe(esperadoConsultor)
    },
  )

  it('cobre toda permissão declarada — nenhuma escapa do teste', () => {
    const testadas = new Set(MATRIZ_SPEC.map((linha) => linha.permissao))
    expect([...PERMISSIONS].filter((p) => !testadas.has(p))).toEqual([])
  })

  it('admin tem todas as permissões', () => {
    for (const permissao of PERMISSIONS) {
      expect(can(admin, permissao)).toBe(true)
    }
  })
})

describe('assertCan', () => {
  it('deixa passar quem pode', () => {
    expect(() => assertCan(admin, 'fluxos.gerenciar')).not.toThrow()
  })

  it('lança ForbiddenError para quem não pode, carregando a permissão negada', () => {
    try {
      assertCan(consultor, 'fluxos.gerenciar')
      expect.unreachable('deveria ter lançado')
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError)
      expect((error as ForbiddenError).permission).toBe('fluxos.gerenciar')
    }
  })
})

describe('leadOwnerFilter', () => {
  it('admin não é filtrado', () => {
    expect(leadOwnerFilter(admin)).toBeNull()
  })

  it('consultor é preso ao próprio id', () => {
    expect(leadOwnerFilter(consultor)).toBe('u-consultor')
  })
})
