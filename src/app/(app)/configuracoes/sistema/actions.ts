'use server'

import { revalidatePath } from 'next/cache'
import { withTenant } from '@/db'
import { runMigrations } from '@/db/migrate'
import { reaplicarNaConexao, type Desfecho } from '@/db/reaplicar-modelos'
import { seedFlows } from '@/db/seed-flows'
import { semearFunilPadrao, semearRitmos } from '@/db/seed-org'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
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

/**
 * Cria o que faltar NA ORGANIZAÇÃO DE QUEM CLICOU.
 *
 * O BUG QUE ISTO CONSERTA
 *
 * Este botão chamava `seed()`, a rotina de instalação a partir do zero. Ela
 * procura a organização por um `slug` fixo — `mandafy` — e, quando não acha,
 * CRIA outra. Numa instalação cuja organização tenha outro slug, o clique
 * criava uma segunda organização, semeava tudo lá dentro e respondia
 * "Criado: organização, 9 fluxo(s)-modelo". A tela de fluxos continuava vazia.
 *
 * Mensagem de sucesso com resultado invisível é o pior desfecho que uma
 * operação pode ter: a pessoa não tem por onde desconfiar, e o próximo passo
 * dela é procurar o problema em qualquer outro lugar.
 *
 * Agora a semeadura roda dentro de `withTenant`, com o `orgId` da sessão. Se o
 * RLS recusar alguma escrita, ela falha alto em vez de gravar no lugar errado.
 * `seed()` continua existindo, para a primeira subida pelo comando, onde não há
 * sessão de onde tirar organização.
 */
export async function semearAction(): Promise<EstadoAcao> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  try {
    const r = await withTenant(tenantOf(user), async (tx) => {
      // Ritmos ANTES dos fluxos: `seedFlows` casa fluxo com ritmo por nome, e
      // sem eles os nove nascem sem ritmo em silêncio.
      const perfis = await semearRitmos(tx, user.orgId)
      const pipelineCriado = await semearFunilPadrao(tx, user.orgId)
      const modelos = await seedFlows(tx, user.orgId)
      return { perfis, pipelineCriado, ...modelos }
    })

    revalidatePath('/configuracoes/sistema')
    revalidatePath('/fluxos')
    revalidatePath('/mensagens')
    revalidatePath('/pipeline')

    const feitos = [
      r.perfis > 0 && `${r.perfis} perfil(is) de ritmo`,
      r.pipelineCriado && 'funil padrão',
      r.mensagens > 0 && `${r.mensagens} mensagem(ns)`,
      r.fluxos > 0 && `${r.fluxos} fluxo(s)-modelo`,
    ].filter((x): x is string => typeof x === 'string')

    return {
      ok:
        feitos.length === 0
          ? 'Nada a fazer: já estava tudo aqui.'
          : `Criado em ${user.orgName}: ${feitos.join(', ')}. Os fluxos nascem pausados — revise o texto antes de ativar.`,
    }
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : 'falha desconhecida'
    log.error('falha ao semear pelo painel', { reason: mensagem.slice(0, 160) })
    return { erro: mensagem.slice(0, 400) }
  }
}

/**
 * Leva o catálogo novo às mensagens que JÁ ESTÃO gravadas.
 *
 * POR QUE UM BOTÃO, SE JÁ EXISTE `npm run db:modelos -- --aplicar`
 *
 * Porque o comando não existe para quem opera este sistema. O seed só cria o
 * que falta — é o certo, senão um deploy apagaria texto ajustado à mão —, e a
 * consequência é que quem semeou uma vez fica preso na versão daquele dia para
 * sempre. Quando o catálogo foi reescrito para não exigir campo que o webhook
 * não manda, o código passou a estar certo e o banco continuou com a cadência
 * de PIX que falha com `variavel_ausente` em todo disparo.
 *
 * Uma correção que depende de um terminal é, para quem publica pelo navegador,
 * uma correção que não aconteceu.
 *
 * SIMULA PRIMEIRO, ESCREVE DEPOIS
 *
 * O primeiro clique só relata: reescrever o texto que sai para o cliente não
 * pode acontecer por engano, e o relatório é a parte que ninguém tem antes —
 * quais mensagens foram editadas à mão e por isso ficam de fora. O segundo
 * clique, no botão que aparece junto do relatório, grava.
 *
 * COM A CONEXÃO DA SESSÃO, NÃO COM UMA DE DONO
 *
 * A primeira versão chamava `reaplicarModelos()`, que abre conexão própria com
 * `DATABASE_URL_ADMIN` e RECUSA rodar com o papel da aplicação. Na hospedagem
 * de quem opera pelo navegador existe uma variável de banco só, apontando para
 * `mandafy_app` — então o botão respondia com a explicação de por que não ia
 * fazer nada, e a única saída era mexer em variável de ambiente e publicar de
 * novo. Consertar pelo painel era justamente o motivo de o botão existir.
 *
 * Aqui ele roda dentro de `withTenant`, na organização de quem clicou, como
 * "Criar o que faltar" já faz. O comando continua existindo para a instalação
 * inteira, onde há papel de dono e não há sessão de onde tirar organização.
 */
export async function reaplicarModelosAction(aplicar: boolean): Promise<EstadoAcao> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  try {
    const resultados = await withTenant(tenantOf(user), (tx) =>
      reaplicarNaConexao(tx, aplicar, user.orgId),
    )

    const conta = (d: Desfecho) => resultados.filter((r) => r.desfecho === d).length
    const mudadas = conta('reaplicado')
    const editadas = conta('editado')

    if (mudadas === 0) {
      return {
        ok:
          editadas > 0
            ? `Nada a atualizar. ${editadas} mensagem(ns) foram editadas à mão e ficam como estão — para levar o texto novo a elas, abra Mensagens e edite.`
            : 'Nada a atualizar: as mensagens já estão na versão atual do catálogo.',
      }
    }

    const sobre = resultados
      .filter((r) => r.desfecho === 'reaplicado')
      .map((r) => r.nome)
      .join(', ')

    if (!aplicar) {
      return {
        ok:
          `Simulação — nada foi gravado. ${mudadas} mensagem(ns) seriam atualizadas: ${sobre}.` +
          (editadas > 0 ? ` ${editadas} editada(s) à mão ficam como estão.` : '') +
          ' Clique em "Atualizar para valer" para gravar.',
      }
    }

    revalidatePath('/configuracoes/sistema')
    revalidatePath('/mensagens')

    return {
      ok:
        `${mudadas} mensagem(ns) atualizadas: ${sobre}.` +
        (editadas > 0 ? ` ${editadas} editada(s) à mão ficaram como estavam.` : ''),
    }
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : 'falha desconhecida'
    log.error('falha ao reaplicar modelos pelo painel', { reason: mensagem.slice(0, 160) })
    return { erro: mensagem.slice(0, 400) }
  }
}

/**
 * As duas metades do botão. Server Action não aceita argumento vindo do cliente
 * sem `bind`, e duas funções nomeadas dizem melhor o que cada clique faz.
 */
export async function simularModelosAction(): Promise<EstadoAcao> {
  return reaplicarModelosAction(false)
}

export async function aplicarModelosAction(): Promise<EstadoAcao> {
  return reaplicarModelosAction(true)
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
