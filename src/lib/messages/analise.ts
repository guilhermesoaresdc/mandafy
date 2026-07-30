import type { Channel } from '@/db/schema/enums'
import { contarSms, foraDoGsm7, temEmoji } from './gsm'
import { parseMensagem } from './parse'
import { contarCombinacoes } from './spintax'
import { resolverSpintax, sementeDeTexto } from './spintax'
import { renderSms, renderWhatsapp } from './render'

/**
 * Avisos do editor (§6.4, §6.5).
 *
 * São AVISOS, não transformações. A spec sugere "quebra automática em 2–3
 * parágrafos curtos" para o WhatsApp; quebrar o texto de alguém sozinho
 * mutilaria a mensagem — quem escreveu sabe onde a frase respira. O sistema
 * aponta, a pessoa decide. O que é transformação de verdade (remover emoji do
 * SMS) acontece na compilação, e o aviso aqui só torna visível o que mudou.
 */

export type Severidade = 'info' | 'atencao' | 'erro'

export type Aviso = { canal: Channel | null; severidade: Severidade; texto: string }

/** Acima disso um bloco de WhatsApp lido no celular vira parede de texto. */
const LINHAS_MAXIMAS_WHATSAPP = 10

export function analisar(fonte: string): Aviso[] {
  const avisos: Aviso[] = []

  if (fonte.trim() === '') return avisos

  const documento = parseMensagem(fonte)
  for (const erro of documento.erros) {
    avisos.push({ canal: null, severidade: 'erro', texto: erro.mensagem })
  }

  const { erros: errosSpintax } = resolverSpintax(fonte, sementeDeTexto(fonte))
  for (const erro of errosSpintax) {
    avisos.push({ canal: null, severidade: 'atencao', texto: erro.mensagem })
  }

  // ── WhatsApp: parede de texto (§6.4) ──
  const whatsapp = renderWhatsapp(documento.blocos)
  for (const bloco of whatsapp.split('\n\n')) {
    const linhas = bloco.split('\n').length
    if (linhas > LINHAS_MAXIMAS_WHATSAPP) {
      avisos.push({
        canal: 'whatsapp',
        severidade: 'atencao',
        texto: `Um bloco com ${linhas} linhas parece robô. Quebre em 2 ou 3 parágrafos curtos.`,
      })
      break
    }
  }

  // ── Spintax: variação insuficiente (§6.5) ──
  const combinacoes = contarCombinacoes(fonte)
  if (combinacoes === 1) {
    avisos.push({
      canal: 'whatsapp',
      severidade: 'info',
      texto:
        'Sem variação: todos vão receber texto idêntico. Use {Oi|Olá|E aí} para o envio em massa não parecer disparo.',
    })
  }

  // ── SMS: o canal caro (§6.4) ──
  const sms = renderSms(documento.blocos)
  const contagem = contarSms(sms)

  if (temEmoji(whatsapp)) {
    avisos.push({
      canal: 'sms',
      severidade: 'info',
      texto: 'Emoji é removido na versão SMS — fora do alfabeto GSM-7, ele dobraria o custo.',
    })
  }

  if (contagem.codificacao === 'UCS-2') {
    const culpados = foraDoGsm7(sms).slice(0, 6).join(' ')
    avisos.push({
      canal: 'sms',
      severidade: 'atencao',
      texto: `Acentuação joga o SMS para UCS-2: o limite cai de 160 para 70 caracteres. Culpados: ${culpados}. Ligue "remover acentuação" para cortar o custo.`,
    })
  }

  if (contagem.segmentos > 1) {
    avisos.push({
      canal: 'sms',
      severidade: 'erro',
      texto: `O SMS ocupa ${contagem.segmentos} segmentos — você paga ${contagem.segmentos}×. Encurte para caber em um.`,
    })
  }

  return avisos
}
