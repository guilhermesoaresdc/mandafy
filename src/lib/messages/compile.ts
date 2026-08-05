import type { Channel } from '@/db/schema/enums'
import type { Bloco, No } from './ast'
import { variaveisUsadas } from './ast'
import { contarSms, cortarParaSegmentos, type ContagemSms } from './gsm'
import { parseMensagem } from './parse'
import { renderEmail, renderSms, renderTelegram, renderWhatsapp, type OpcoesSms } from './render'
import { resolverSpintax, sementeDeTexto } from './spintax'
import { resolverVariavel, type DadosVariaveis } from './variables'

/**
 * Compilação de uma mensagem para um canal (§6).
 *
 * A ordem importa e é sempre esta:
 *
 *   fonte → spintax → análise → variáveis → renderização do canal
 *
 * O spintax vem primeiro porque é conteúdo do autor, e pode conter formatação
 * dentro das alternativas. As variáveis vêm DEPOIS da análise, direto nos nós
 * da árvore: se um contato se chamar `**Ana**`, o cliente lê `**Ana**` em vez
 * de ver negrito. Substituir texto antes de analisar deixaria a formatação nas
 * mãos de quem preenche o cadastro.
 */

export type MotivoFalha = 'variavel_ausente' | 'corpo_vazio' | 'erro_de_sintaxe'

export type Compilacao =
  | { ok: true; canal: Channel; corpo: string; html?: string; texto?: string; sms?: ContagemSms }
  | { ok: false; motivo: MotivoFalha; detalhe: string; variaveis?: string[] }

export type OpcoesCompilacao = {
  canal: Channel
  dados: DadosVariaveis
  /** Fixa o sorteio do spintax. Sem semente, cada compilação varia (§6.5). */
  semente?: number
  preheader?: string | null
  linkDescadastro?: string
  sms?: OpcoesSms
  /**
   * Prévia do editor: variável sem valor vira `{{nome}}` visível em vez de
   * derrubar a compilação. Em envio real isto é sempre `false` — §6.3 é
   * explícita: nunca mandar `Oi {{nome}}!` literal para o cliente.
   */
  previa?: boolean
}

/** Troca cada nó de variável pelo valor resolvido. Devolve o que faltou. */
function aplicarVariaveis(
  blocos: Bloco[],
  dados: DadosVariaveis,
  previa: boolean,
): { blocos: Bloco[]; faltando: string[] } {
  const faltando: string[] = []

  const nos = (lista: No[]): No[] =>
    lista.map((no): No => {
      switch (no.tipo) {
        case 'variavel': {
          const valor = resolverVariavel(no, dados)
          if (valor === null) {
            if (!faltando.includes(no.nome)) faltando.push(no.nome)
            // Na prévia o buraco continua visível; em envio real a compilação
            // falha logo abaixo e este nó nunca chega a um renderizador.
            return previa ? no : { tipo: 'texto', valor: '' }
          }
          return { tipo: 'texto', valor }
        }
        case 'negrito':
        case 'italico':
        case 'riscado':
          return { ...no, filhos: nos(no.filhos) }
        case 'link':
          return { ...no, rotulo: nos(no.rotulo), url: nos(no.url) }
        default:
          return no
      }
    })

  return {
    blocos: blocos.map((bloco) =>
      bloco.tipo === 'regua' ? bloco : { tipo: 'paragrafo', filhos: nos(bloco.filhos) },
    ),
    faltando,
  }
}

export function compilar(fonte: string, opcoes: OpcoesCompilacao): Compilacao {
  const previa = opcoes.previa ?? false

  const semente = opcoes.semente ?? sementeDeTexto(`${fonte}#${Math.random()}`)
  const { texto: sorteado } = resolverSpintax(fonte, semente)

  const documento = parseMensagem(sorteado)

  // Erro de sintaxe não impede o envio: um filtro digitado errado vira aviso no
  // editor, e o resto da mensagem continua compilando. O que NÃO pode passar é
  // variável sem valor — essa é regra da spec.
  if (documento.blocos.length === 0) {
    return { ok: false, motivo: 'corpo_vazio', detalhe: 'A mensagem está vazia.' }
  }

  const { blocos, faltando } = aplicarVariaveis(documento.blocos, opcoes.dados, previa)

  if (faltando.length > 0 && !previa) {
    return {
      ok: false,
      motivo: 'variavel_ausente',
      detalhe: `Sem valor para: ${faltando.join(', ')}.`,
      variaveis: faltando,
    }
  }

  switch (opcoes.canal) {
    case 'whatsapp':
      return { ok: true, canal: 'whatsapp', corpo: renderWhatsapp(blocos) }

    case 'telegram':
      return { ok: true, canal: 'telegram', corpo: renderTelegram(blocos) }

    case 'email': {
      const { html, texto } = renderEmail(blocos, {
        preheader: opcoes.preheader ?? null,
        ...(opcoes.linkDescadastro ? { linkDescadastro: opcoes.linkDescadastro } : {}),
      })
      return { ok: true, canal: 'email', corpo: texto, html, texto }
    }

    case 'sms': {
      const bruto = renderSms(blocos, opcoes.sms ?? {})

      /*
       * O TETO DE CUSTO, aplicado depois das variáveis e antes da contagem.
       *
       * Aqui é o único ponto por onde todo SMS passa — a prévia do editor, o
       * envio de teste e a fila de produção chamam esta mesma função. Pôr o
       * corte no adaptador do provedor deixaria a prévia mentindo sobre o que
       * vai sair; pô-lo só na tela não protegeria o envio, que é onde a
       * variável ganha valor e o texto cresce.
       *
       * A prévia NÃO corta: quem está escrevendo precisa ver o excesso para
       * poder encurtar, e um texto que se corta sozinho na tela esconde
       * exatamente o problema que o contador ao lado está denunciando.
       */
      const corpo = previa ? bruto : cortarParaSegmentos(bruto, opcoes.sms?.segmentosMax).texto

      return { ok: true, canal: 'sms', corpo, sms: contarSms(corpo) }
    }
  }
}

/** Compila os quatro canais de uma vez — é o que alimenta a prévia de §6.6. */
export function compilarTodos(
  fonte: string,
  opcoes: Omit<OpcoesCompilacao, 'canal'>,
): Record<Channel, Compilacao> {
  // Mesma semente nos quatro: a prévia lado a lado tem de mostrar A MESMA
  // mensagem em quatro formatos, não quatro sorteios diferentes.
  const semente = opcoes.semente ?? sementeDeTexto(fonte)

  return {
    whatsapp: compilar(fonte, { ...opcoes, canal: 'whatsapp', semente }),
    telegram: compilar(fonte, { ...opcoes, canal: 'telegram', semente }),
    email: compilar(fonte, { ...opcoes, canal: 'email', semente }),
    sms: compilar(fonte, { ...opcoes, canal: 'sms', semente }),
  }
}

/**
 * Variáveis que o corpo exige. O editor lista para quem escreve conferir.
 *
 * Analisa a fonte CRUA, sem sortear o spintax: uma variável que só aparece em
 * uma das alternativas continua sendo obrigatória, e sortear esconderia isso —
 * a mensagem passaria na prévia e falharia com `variavel_ausente` no envio em
 * que aquele ramo saísse. O analisador atravessa `{a|b}` como texto literal e
 * ainda assim enxerga os `{{…}}` de dentro.
 */
export function variaveisDoCorpo(fonte: string): string[] {
  return variaveisUsadas(parseMensagem(fonte).blocos)
}
