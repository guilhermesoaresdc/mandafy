import type { Tx } from '@/db'
import type { Channel } from '@/db/schema/enums'
import { CHANNEL_LABELS } from '@/db/schema/enums'
import { carregarInstancias, resolverCanal } from './config'
import { escolherParaAgendamento } from './warmup'

/**
 * O canal está ligado e conectado? (§8)
 *
 * O PROBLEMA QUE ISTO RESOLVE
 *
 * Canal sem conexão não é um envio que falhou: é um envio que nunca teve como
 * acontecer. E mesmo assim ele virava linha em `notifications` — uma por
 * contato, por canal, por disparo. Um lote de duzentos leads com o SMS sem
 * chave gravava duzentas linhas `skipped: sem_destino` no histórico; o de mil,
 * mil. O histórico é a tela onde se procura UMA mensagem específica entre
 * milhares, e ela ficava soterrada por um problema que é o mesmo, único, e não
 * é sobre nenhum daqueles contatos.
 *
 * Pior: essas linhas roubavam a explicação. O motivo real — "o SMS não tem
 * chave configurada" — ficava distribuído em mil linhas que diziam cada uma
 * "não saiu", e quem disparou via o lote inteiro cinza sem saber o que fazer.
 *
 * A DIFERENÇA ENTRE PULAR E BARRAR
 *
 * Pular é sobre a PESSOA: ela pediu para sair, já recebeu o teto de hoje, não
 * tem e-mail cadastrado. São decisões por contato, cada uma é um fato daquele
 * envio, e cada uma merece a sua linha no histórico — é o que responde "por que
 * fulano não recebeu?".
 *
 * Barrar é sobre a CONFIGURAÇÃO: não há credencial, não há número conectado, o
 * canal está desligado nas configurações. Vale para todo mundo igualmente, não
 * depende de quem é o contato, e o lugar de aparecer é na tela de quem
 * disparou — uma vez, com o passo para consertar.
 *
 * Este módulo responde à segunda pergunta. Consulta por ORGANIZAÇÃO e por
 * CANAL, uma vez por disparo — não uma vez por contato.
 */

export type ProntidaoCanal = {
  canal: Channel
  pronto: boolean
  /** Por que não dá — frase para a tela de quem disparou, não para o cliente. */
  motivo: string | null
}

/**
 * Testa os canais pedidos.
 *
 * Não decifra nem usa credencial para nada além de saber se ela existe: quem
 * envia de verdade resolve de novo, com a instância escolhida pelo rodízio.
 */
export async function prontidaoDosCanais(
  tx: Tx,
  orgId: string,
  canais: readonly Channel[],
): Promise<Map<Channel, ProntidaoCanal>> {
  const saida = new Map<Channel, ProntidaoCanal>()
  if (canais.length === 0) return saida

  /*
   * O WhatsApp é o único que depende de um chip conectado, e não só de
   * credencial. `escolherParaAgendamento` aplica as mesmas regras do envio —
   * existe, ligado, não banido —, para que a resposta daqui não seja mais
   * otimista que a do momento do disparo.
   */
  let instancia = null
  if (canais.includes('whatsapp')) {
    const todas = await carregarInstancias(tx, orgId)
    // Volta pela lista completa porque `escolherParaAgendamento` devolve o tipo
    // sem segredo, e `resolverCanal` precisa da apikey para dizer se a Evolution
    // está configurada — sem ela, o canal seria dado como pronto e falharia no
    // envio, que é exatamente o que este módulo existe para evitar.
    const escolhida = escolherParaAgendamento(todas)
    instancia = escolhida ? (todas.find((i) => i.id === escolhida.id) ?? null) : null
  }

  for (const canal of canais) {
    const resolucao = await resolverCanal(
      tx,
      orgId,
      canal,
      canal === 'whatsapp' ? instancia : undefined,
    )

    saida.set(canal, {
      canal,
      pronto: resolucao.alvo !== null,
      motivo: resolucao.falta,
    })
  }

  return saida
}

export type CanalBarrado = { canal: Channel; motivo: string }

/**
 * A frase que vai para a tela de quem disparou.
 *
 * Uma frase por canal, com o nome do canal na frente — "WhatsApp: nenhum número
 * conectado". Sem o nome, um lote pedindo três canais devolveria três motivos
 * soltos e ninguém saberia qual é de qual.
 */
export function explicarBarrados(barrados: readonly CanalBarrado[]): string {
  if (barrados.length === 0) return ''

  const linhas = barrados.map((b) => `${CHANNEL_LABELS[b.canal]}: ${b.motivo}`)

  return linhas.length === 1
    ? `${linhas[0]}. Ajuste em Canais e tente de novo.`
    : `${linhas.join('; ')}. Ajuste em Canais e tente de novo.`
}
