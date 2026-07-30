import type { Bloco, No } from './ast'
import { removerAcentos, removerEmoji } from './gsm'

/**
 * Os quatro renderizadores de §6.2.
 *
 * Cada um recebe a árvore já com as variáveis resolvidas em nós de texto, e
 * escapa por conta própria. Nenhum deles vê a fonte original — é isso que
 * impede o valor de uma variável de virar formatação.
 */

export type OpcoesSms = {
  /** Encurta o link e devolve a URL curta. Sem isso, a URL vai inteira. */
  encurtar?: (url: string) => string
  removerAcentuacao?: boolean
}

// ── Utilidades comuns ────────────────────────────────────────────────────────

/** Texto puro de uma sequência de nós. Usado para URLs e para a versão SMS. */
function textoDe(nos: No[]): string {
  return nos
    .map((no) => {
      switch (no.tipo) {
        case 'texto':
          return no.valor
        case 'mono':
          return no.valor
        case 'negrito':
        case 'italico':
        case 'riscado':
          return textoDe(no.filhos)
        case 'link':
          return textoDe(no.rotulo)
        case 'variavel':
          // Variável não resolvida não vaza para o cliente (§6.3). Quem compila
          // já derrubou a notificação antes de chegar aqui; na prévia isto
          // marca visualmente o buraco.
          return `{{${no.nome}}}`
      }
    })
    .join('')
}

function ehVazio(no: No): boolean {
  return no.tipo === 'texto' && no.valor.trim() === ''
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────

/**
 * WhatsApp usa marcadores próprios: `*negrito*`, `_itálico_`, `~riscado~` e
 * ``` para monoespaçado.
 *
 * §6.4 manda o link ficar no fim, nunca no meio. Um link solto no meio de uma
 * frase quebra a leitura e, em conversa comercial, derruba o clique. Então:
 * link que já é a última coisa da mensagem fica onde está; qualquer outro
 * deixa só o rótulo na frase e reaparece como linha final `rótulo: url`.
 */
export function renderWhatsapp(blocos: Bloco[]): string {
  const rodape: string[] = []

  const ultimoParagrafo = [...blocos].reverse().find((b) => b.tipo === 'paragrafo')
  const ultimoNo = ultimoParagrafo?.tipo === 'paragrafo' ? ultimoNaoVazio(ultimoParagrafo.filhos) : null

  const inline = (nos: No[]): string =>
    nos
      .map((no) => {
        switch (no.tipo) {
          case 'texto':
            return no.valor
          case 'negrito':
            return `*${inline(no.filhos)}*`
          case 'italico':
            return `_${inline(no.filhos)}_`
          case 'riscado':
            return `~${inline(no.filhos)}~`
          case 'mono':
            return `\`\`\`${no.valor}\`\`\``
          case 'link': {
            const rotulo = inline(no.rotulo)
            const url = textoDe(no.url)
            // Já está no fim: fica onde está, sem duplicar no rodapé.
            if (no === ultimoNo) return `${rotulo}: ${url}`
            rodape.push(`${textoDe(no.rotulo)}: ${url}`)
            return rotulo
          }
          case 'variavel':
            return `{{${no.nome}}}`
        }
      })
      .join('')

  const partes: string[] = []
  for (const bloco of blocos) {
    // A régua vira linha em branco (§6.2) — que é o que o parágrafo seguinte já
    // produz na junção; então basta não emitir nada.
    if (bloco.tipo === 'regua') continue
    partes.push(inline(bloco.filhos))
  }

  const corpo = partes.filter((p) => p.trim() !== '').join('\n\n')
  return rodape.length > 0 ? `${corpo}\n\n${rodape.join('\n')}` : corpo
}

function ultimoNaoVazio(nos: No[]): No | null {
  for (let i = nos.length - 1; i >= 0; i -= 1) {
    const no = nos[i]!
    if (!ehVazio(no)) return no
  }
  return null
}

// ── Telegram ─────────────────────────────────────────────────────────────────

const ESCAPE_HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

function escaparHtml(texto: string): string {
  return texto.replace(/[&<>]/g, (c) => ESCAPE_HTML[c] ?? c)
}

function escaparAtributo(texto: string): string {
  return escaparHtml(texto).replace(/"/g, '&quot;')
}

/**
 * Telegram em `parse_mode: HTML` (§6.4).
 *
 * HTML e não MarkdownV2 porque o MarkdownV2 exige escapar `_ * [ ] ( ) ~ > # +
 * - = | { } . !` — qualquer um desses num texto em português derruba o envio
 * com 400. Aqui só existem três caracteres a escapar.
 */
export function renderTelegram(blocos: Bloco[]): string {
  const inline = (nos: No[]): string =>
    nos
      .map((no) => {
        switch (no.tipo) {
          case 'texto':
            return escaparHtml(no.valor)
          case 'negrito':
            return `<b>${inline(no.filhos)}</b>`
          case 'italico':
            return `<i>${inline(no.filhos)}</i>`
          case 'riscado':
            return `<s>${inline(no.filhos)}</s>`
          case 'mono':
            return `<code>${escaparHtml(no.valor)}</code>`
          case 'link':
            return `<a href="${escaparAtributo(textoDe(no.url))}">${inline(no.rotulo)}</a>`
          case 'variavel':
            return escaparHtml(`{{${no.nome}}}`)
        }
      })
      .join('')

  return blocos
    .filter((b) => b.tipo === 'paragrafo')
    .map((b) => inline(b.filhos))
    .filter((p) => p.trim() !== '')
    .join('\n\n')
}

// ── E-mail ───────────────────────────────────────────────────────────────────

export type SaidaEmail = { html: string; texto: string }

/**
 * E-mail em HTML de tabela, 600px, CSS embutido (§6.4).
 *
 * Cliente de e-mail em 2026 ainda não entende flexbox nem folha de estilo
 * externa; tabela aninhada com `style=` continua sendo o que chega inteiro no
 * Outlook e no Gmail. A versão texto sai junto porque multipart melhora
 * entregabilidade — e porque parte da base lê em cliente sem HTML.
 */
export function renderEmail(
  blocos: Bloco[],
  opcoes: { preheader?: string | null; linkDescadastro?: string } = {},
): SaidaEmail {
  const inline = (nos: No[]): string =>
    nos
      .map((no) => {
        switch (no.tipo) {
          case 'texto':
            return escaparHtml(no.valor).replace(/\n/g, '<br />')
          case 'negrito':
            return `<strong>${inline(no.filhos)}</strong>`
          case 'italico':
            return `<em>${inline(no.filhos)}</em>`
          case 'riscado':
            return `<del>${inline(no.filhos)}</del>`
          case 'mono':
            return `<code style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;background:#f4f4f5;padding:1px 4px;border-radius:3px">${escaparHtml(no.valor)}</code>`
          case 'link':
            return `<a href="${escaparAtributo(textoDe(no.url))}" style="color:#2563eb;text-decoration:underline">${inline(no.rotulo)}</a>`
          case 'variavel':
            return escaparHtml(`{{${no.nome}}}`)
        }
      })
      .join('')

  const corpo = blocos
    .map((bloco) =>
      bloco.tipo === 'regua'
        ? '<hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0" />'
        : `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#18181b">${inline(bloco.filhos)}</p>`,
    )
    .join('\n        ')

  const descadastro = opcoes.linkDescadastro ?? '{{link_descadastro}}'

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
${opcoes.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escaparHtml(opcoes.preheader)}</div>\n` : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafafa">
  <tr>
    <td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px">
        <tr><td style="padding:32px">
        ${corpo}
        </td></tr>
        <tr><td style="padding:0 32px 24px">
          <p style="margin:0;font-size:11px;line-height:1.5;color:#a1a1aa">
            Não quer mais receber? <a href="${escaparAtributo(descadastro)}" style="color:#a1a1aa">Descadastre-se aqui</a>.
          </p>
        </td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  return { html, texto: renderTextoPuro(blocos, descadastro) }
}

/** Versão texto puro do e-mail: o outro ramo do multipart. */
function renderTextoPuro(blocos: Bloco[], linkDescadastro: string): string {
  const inline = (nos: No[]): string =>
    nos
      .map((no) => {
        switch (no.tipo) {
          case 'link': {
            const rotulo = textoDe(no.rotulo)
            const url = textoDe(no.url)
            return rotulo === url ? url : `${rotulo}: ${url}`
          }
          case 'negrito':
          case 'italico':
          case 'riscado':
            return inline(no.filhos)
          default:
            return textoDe([no])
        }
      })
      .join('')

  const corpo = blocos
    .map((bloco) => (bloco.tipo === 'regua' ? '---' : inline(bloco.filhos)))
    .filter((p) => p.trim() !== '')
    .join('\n\n')

  return `${corpo}\n\n---\nPara não receber mais: ${linkDescadastro}`
}

// ── SMS ──────────────────────────────────────────────────────────────────────

/**
 * SMS: texto puro, sem emoji, links encurtados (§6.4).
 *
 * O riscado some com o conteúdo, não só com os marcadores — a tabela de §6.2 o
 * marca como "removido", em contraste com o "texto puro" dos demais. Faz
 * sentido: texto que o autor riscou não vale os centavos que custaria.
 *
 * A régua é ignorada e os parágrafos são juntados com uma quebra só, em vez de
 * linha em branco: cada caractere a mais aproxima o segundo segmento.
 */
export function renderSms(blocos: Bloco[], opcoes: OpcoesSms = {}): string {
  const inline = (nos: No[]): string =>
    nos
      .map((no) => {
        switch (no.tipo) {
          case 'riscado':
            return ''
          case 'link': {
            const url = textoDe(no.url)
            return opcoes.encurtar ? opcoes.encurtar(url) : url
          }
          case 'negrito':
          case 'italico':
            return inline(no.filhos)
          default:
            return textoDe([no])
        }
      })
      .join('')

  let saida = blocos
    .filter((b) => b.tipo === 'paragrafo')
    .map((b) => inline(b.filhos))
    .filter((p) => p.trim() !== '')
    .join('\n')

  saida = removerEmoji(saida)
  if (opcoes.removerAcentuacao) saida = removerAcentos(saida)

  /*
   * Colapsa espaço repetido. Sobra sempre que algo foi retirado — o riscado
   * some e deixa dois espaços onde havia um — e num canal em que cada
   * caractere é cobrado, espaço duplo é dinheiro jogado fora. Explícito aqui, e
   * não como efeito colateral de `removerEmoji`.
   */
  return saida
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
