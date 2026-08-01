'use server'

import { revalidatePath } from 'next/cache'
import { runMigrations } from '@/db/migrate'
import { seed } from '@/db/seed'
import { requireAdmin } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { tickDeEnvio } from '@/lib/delivery/tick'

/**
 * Operações de sistema, disparadas do painel (§9.4).
 *
 * POR QUE PELA TELA E NÃO POR UMA ROTA COM SEGREDO
 *
 * Quem opera este sistema publica pelo GitHub e olha o navegador; migrar e
 * semear por linha de comando é, para essa pessoa, o mesmo que não poder fazer.
 *
 * Mas a alternativa óbvia — um endpoint protegido por variável de ambiente —
 * seria pior: uma rota permanente, exposta à internet, capaz de destruir o
 * esquema, cuja única defesa é um segredo que vaza em log de proxy, em
 * histórico de terminal e em captura de tela. Uma Server Action aqui dentro já
 * está atrás da sessão e do papel de administrador, que é a autenticação real
 * do sistema. Um segredo a mais seria uma porta a mais.
 *
 * Todas são idempotentes: migrar duas vezes não reaplica, semear duas vezes não
 * duplica. Um clique duplo por impaciência é o modo de uso esperado.
 */

const log = createLogger('sistema')

export type EstadoAcao = {
  ok?: string
  erro?: string
  /** A senha do administrador, quando o seed acabou de criá-lo. */
  senha?: string
}

export async function migrarAction(): Promise<EstadoAcao> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  try {
    const r = await runMigrations()
    revalidatePath('/configuracoes/sistema')

    return {
      ok:
        r.aplicadas.length === 0
          ? `Nada a fazer: as ${r.jaAplicadas} migrations já estavam aplicadas.`
          : `${r.aplicadas.length} migration(s) aplicada(s): ${r.aplicadas.join(', ')}.`,
    }
  } catch (erro) {
    // A mensagem do Postgres vai para a tela porque é ela que diz o que fazer,
    // e erro de esquema não carrega dado pessoal (§14.1).
    const mensagem = erro instanceof Error ? erro.message : 'falha desconhecida'
    log.error('falha ao migrar pelo painel', { reason: mensagem.slice(0, 160) })
    return { erro: mensagem.slice(0, 400) }
  }
}

export async function semearAction(): Promise<EstadoAcao> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  try {
    const r = await seed()
    revalidatePath('/configuracoes/sistema')

    const feitos = [
      r.orgCriada && 'organização',
      r.adminCriado && 'administrador',
      r.perfis > 0 && `${r.perfis} perfil(is) de ritmo`,
      r.pipelineCriado && 'funil padrão',
      r.mensagens > 0 && `${r.mensagens} mensagem(ns)`,
      r.fluxos > 0 && `${r.fluxos} fluxo(s)-modelo`,
    ].filter((x): x is string => typeof x === 'string')

    return {
      ok:
        feitos.length === 0
          ? 'Nada a fazer: os dados-modelo já existiam.'
          : `Criado: ${feitos.join(', ')}. Os fluxos nascem pausados — revise o texto antes de ativar.`,
      /*
       * A senha só existe neste retorno, e só quando o administrador acabou de
       * ser criado. Não vai para log (§14.1) nem fica guardada em lugar nenhum:
       * o hash é o que o banco tem.
       */
      ...(r.senhaGerada ? { senha: r.senhaGerada } : {}),
    }
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : 'falha desconhecida'
    log.error('falha ao semear pelo painel', { reason: mensagem.slice(0, 160) })
    return { erro: mensagem.slice(0, 400) }
  }
}

/**
 * Roda o batimento uma vez, agora.
 *
 * Existe para responder à pergunta que só o operador consegue fazer: "o
 * agendador está mesmo chamando?". Se o botão envia e o automático não, o
 * problema é o agendamento, não o sistema — e essa distinção economiza horas.
 */
export async function baterAgoraAction(): Promise<EstadoAcao> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  try {
    const r = await tickDeEnvio(20_000)
    revalidatePath('/configuracoes/sistema')

    if (r.enviados === 0 && r.falhas === 0 && r.reagendadosParaRetry === 0) {
      return { ok: 'Nada vencido para enviar agora.' }
    }

    return {
      ok: `${r.enviados} enviada(s), ${r.falhas} falha(s), ${r.reagendadosParaRetry} devolvida(s) à fila${r.sobrou ? ' — e ainda sobrou trabalho' : ''}.`,
    }
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : 'falha desconhecida'
    log.error('falha ao bater pelo painel', { reason: mensagem.slice(0, 160) })
    return { erro: mensagem.slice(0, 400) }
  }
}
