/**
 * O catálogo de modelos preparado para ser EXIBIDO (§6.6, §11.7).
 *
 * A galeria de "nova mensagem" mostra um cartão por modelo, e o que convence
 * quem está escolhendo não é o nome — é ver o texto pronto. Por isso a amostra
 * aqui não é o corpo cru: é o corpo compilado com o contato de exemplo, o mesmo
 * que a prévia do editor usa. "Oi Maria! Vi que seu PIX de R$ 49,90 ainda não
 * foi pago" diz o que o modelo faz; `{{nome|primeiro_nome|"tudo bem"}}` não.
 *
 * POR QUE ISTO NÃO VIVE NO COMPONENTE
 *
 * O corpo inteiro dos treze modelos são alguns milhares de caracteres, e a tela
 * de mensagens tem orçamento de peso (§13). Compilando no servidor, o navegador
 * recebe só as duas linhas que cabem no cartão; o texto completo fica no
 * servidor, onde já estava.
 */

import type { Channel, MessageCategory } from '@/db/schema/enums'
import { compilar } from './compile'
import { CONTATO_EXEMPLO } from './exemplo'
import { CANAIS_PADRAO, MENSAGENS, type ChaveModelo, type ModeloMensagem } from './modelos'
import { sementeDeTexto } from './spintax'

export type ResumoModelo = {
  key: ChaveModelo
  name: string
  category: MessageCategory
  /** Duas linhas do corpo já compilado, para o cartão. */
  amostra: string
  /** Os canais que o modelo liga — os mesmos pads da lista de mensagens. */
  canais: Channel[]
}

/** O que cabe em duas linhas de cartão sem cortar no meio de uma palavra. */
const LIMITE = 150

function encurtar(texto: string): string {
  if (texto.length <= LIMITE) return texto
  const corte = texto.slice(0, LIMITE)
  const espaco = corte.lastIndexOf(' ')
  return `${(espaco > LIMITE * 0.6 ? corte.slice(0, espaco) : corte).trimEnd()}…`
}

export function resumoDosModelos(): ResumoModelo[] {
  return MENSAGENS.map((modelo) => {
    /*
     * `largo` é o mesmo objeto visto pelo tipo comum. O catálogo é `as const`,
     * então cada entrada tem o tipo exato do que escreveram nela — e ler
     * `canais` numa que não declara `canais` é erro de compilação. `modelo`
     * continua servindo para `key`, que é onde os literais importam.
     */
    const largo: ModeloMensagem = modelo

    /*
     * Semente fixa a partir da chave: o spintax sorteia uma alternativa, e sem
     * semente o mesmo cartão mostraria um texto diferente a cada carregamento
     * da página. Uma galeria que muda sozinha parece defeito.
     */
    const compilada = compilar(modelo.body, {
      canal: 'whatsapp',
      dados: CONTATO_EXEMPLO,
      semente: sementeDeTexto(modelo.key),
      // Variável sem exemplo vira `{{nome}}` visível em vez de derrubar o
      // cartão — é uma vitrine, não um envio.
      previa: true,
    })

    const corpo = compilada.ok ? compilada.corpo : modelo.body

    return {
      key: modelo.key,
      name: modelo.name,
      category: modelo.category,
      amostra: encurtar(
        corpo
          // Os marcadores do WhatsApp (`*negrito*`) viram ruído em duas linhas
          // sem negrito de verdade. A amostra é vitrine, não renderização.
          .replace(/[*_~]/g, '')
          .replace(/\s*\n+\s*/g, ' ')
          .trim(),
      ),
      canais: (Object.keys(CANAIS_PADRAO) as Channel[]).filter(
        (canal) => largo.canais?.[canal] ?? CANAIS_PADRAO[canal],
      ),
    }
  })
}
