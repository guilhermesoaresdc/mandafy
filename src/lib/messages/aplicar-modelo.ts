import { CANAIS_PADRAO, type ModeloMensagem } from './modelos'
import { CHANNELS, type Channel } from '@/db/schema/enums'

/**
 * Traduz um modelo nas linhas que vão para o banco (§5.2, §6.1).
 *
 * POR QUE UMA FUNÇÃO, E NÃO DUAS CÓPIAS
 *
 * Dois lugares criam mensagem a partir de modelo: o seed, na primeira subida, e
 * a tela de nova mensagem. Enquanto cada um montava as próprias linhas, os dois
 * divergiam em cinco pontos — e três mudavam o que a pessoa vê:
 *
 *   canais    o seed desliga o SMS (§8.4); a tela ligava TODOS. Uma mensagem
 *             criada pela tela sairia pelo canal mais caro do sistema sem
 *             ninguém ter pedido.
 *   assunto   o seed grava `subject` no e-mail; a tela nunca gravava, e a
 *             prévia caía no nome da mensagem como assunto.
 *   synced    o seed marca a variante escrita à mão como dessincronizada; a
 *             tela deixava tudo sincronizado, e a primeira edição do corpo
 *             apagaria o texto feito de propósito para aquele canal.
 *
 * Com uma função só, a mensagem criada pela tela nasce idêntica à semeada. É a
 * diferença entre "temos modelos" e "temos modelos que funcionam igual".
 */

export type LinhaMensagem = {
  key: string
  name: string
  category: ModeloMensagem['category']
  description?: string
  body: string
  ignoreQuietHours: boolean
}

export type LinhaVariante = {
  channel: Channel
  enabled: boolean
  synced?: boolean
  body?: string
  subject?: string
  preheader?: string
  textBody?: string
  buttons?: { text: string; url?: string }[]
  stripAccents?: boolean
  parseMode?: 'HTML'
}

export type LinhasDoModelo = {
  mensagem: LinhaMensagem
  variantes: LinhaVariante[]
}

/**
 * `chave` permite ao chamador desviar da chave do modelo.
 *
 * O seed nunca desvia: ele pula quando a chave já existe. A tela precisa, porque
 * criar "Lembrete de PIX" duas vezes é uso legítimo — a segunda vira
 * `pix_lembrete_1_2`. A chave é contrato da API pública (§3.4), então quem
 * chama decide; o modelo só oferece a dele.
 */
export function linhasDoModelo(modelo: ModeloMensagem, chave = modelo.key): LinhasDoModelo {
  return {
    mensagem: {
      key: chave,
      name: modelo.name,
      category: modelo.category,
      ...(modelo.description ? { description: modelo.description } : {}),
      body: modelo.body,
      ignoreQuietHours: modelo.ignoreQuietHours ?? false,
    },

    variantes: CHANNELS.map((canal) => {
      const escrita = modelo.variantes?.[canal]

      /*
       * `buttons` sai do resto de propósito.
       *
       * No catálogo ele é `readonly` — o dado é `as const` — e na linha do
       * banco não é. Separando aqui, a única origem de `buttons` abaixo é a
       * cópia; deixá-lo no espalhamento faria o tipo virar "um ou outro", e o
       * "outro" é o imutável que a tabela recusa.
       */
      const { buttons, ...resto } = escrita ?? {}

      return {
        channel: canal,
        enabled: modelo.canais?.[canal] ?? CANAIS_PADRAO[canal],

        /*
         * Variante escrita à mão nasce DESSINCRONIZADA. Editar o corpo
         * principal depois não pode apagar um texto que existe justamente
         * porque aquele canal precisa de outro conteúdo — o SMS que cabe num
         * segmento, o e-mail com assunto, o Telegram com botão.
         */
        ...(escrita ? { synced: false, ...resto } : {}),

        // A fronteira entre dado de catálogo e linha de tabela é esta cópia.
        ...(buttons ? { buttons: [...buttons] } : {}),

        // O assunto do topo vale para o e-mail quando a variante não traz o
        // seu. Sem ele, a prévia mostra o nome da mensagem como assunto.
        ...(canal === 'email' && !escrita?.subject && modelo.subject
          ? { subject: modelo.subject }
          : {}),

        ...(canal === 'telegram' ? { parseMode: 'HTML' as const } : {}),
      }
    }),
  }
}

/** O modelo com esta chave, ou nada. */
export function acharModelo(
  modelos: readonly ModeloMensagem[],
  chave: string | null | undefined,
): ModeloMensagem | null {
  if (!chave) return null
  return modelos.find((m) => m.key === chave) ?? null
}
