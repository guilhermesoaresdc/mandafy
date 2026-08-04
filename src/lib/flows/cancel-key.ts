import { valorPorNome, type DadosVariaveis } from '@/lib/messages/variables'

/**
 * Chave de cancelamento (§5.1).
 *
 * É o fio que amarra os quatro envios agendados ao mesmo pedido. Quando
 * `order.paid` chega no minuto 3, é por esta chave que os três envios restantes
 * são cancelados de uma vez.
 *
 * A regra que faz tudo funcionar: o gatilho e o evento de cancelamento têm de
 * produzir a MESMA string. `order:{{external_id}}` resolvido no `order.created`
 * e no `order.paid` precisa dar `order:12345` nos dois. Se der `order:12345` e
 * `order:12345 ` — com um espaço — o cancelamento não acha nada e o cliente que
 * acabou de pagar recebe "finalize seu pagamento". Esse é o bug número 1 de
 * sistemas de recuperação, e é por isso que a normalização é agressiva aqui.
 */

export type ResultadoChave =
  | { ok: true; chave: string }
  | { ok: false; faltando: string[] }

const VARIAVEL = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g

/**
 * Resolve o modelo com os dados do evento.
 *
 * Falha explicitamente quando falta valor, em vez de gerar `order:undefined` —
 * uma chave assim casaria com QUALQUER outro pedido que também não tivesse o
 * campo, e cancelaria envios de gente que não pagou nada.
 */
export function montarChave(modelo: string | null, dados: DadosVariaveis): ResultadoChave {
  if (!modelo || modelo.trim() === '') return { ok: false, faltando: ['modelo'] }

  const faltando: string[] = []

  const chave = modelo.replace(VARIAVEL, (_todo, nome: string) => {
    const valor = valorPorNome(dados, nome)
    const texto = valor === undefined || valor === null ? '' : String(valor).trim()

    if (texto === '') {
      faltando.push(nome)
      return ''
    }

    /*
     * Cada VALOR é aparado antes de entrar na chave, não só a chave montada.
     * Um `external_id` de " 12345" produziria `order: 12345` — o espaço fica no
     * meio, onde um trim final não alcança — e a chave do `order.paid` viria
     * sem ele. Os dois lados deixariam de casar e o lembrete de PIX sairia
     * para quem já pagou.
     */
    return texto
  })

  if (faltando.length > 0) return { ok: false, faltando }

  return { ok: true, chave: normalizarChave(chave) }
}

/**
 * Normaliza para que os dois lados sempre casem.
 *
 * Espaço nas pontas, caixa e espaço interno repetido são as três formas de a
 * mesma chave lógica virar duas strings diferentes — e o valor vem de payload
 * de plataforma de terceiro, onde `"12345"` e `" 12345"` convivem.
 */
export function normalizarChave(chave: string): string {
  return chave.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** As chaves batem? Existe para o teste dizer o que está comparando. */
export function chavesIguais(a: string, b: string): boolean {
  return normalizarChave(a) === normalizarChave(b)
}

/** Modelos sugeridos ao criar um fluxo. */
export const MODELOS_CHAVE = [
  { modelo: 'order:{{external_id}}', rotulo: 'Por aposta', dica: 'O mais comum. Cancela quando aquela aposta é paga.' },
  { modelo: 'contact:{{contact_id}}', rotulo: 'Por contato', dica: 'Cancela tudo o que estava agendado para a pessoa.' },
  /*
   * A extração, não "a campanha": numa banca o agrupamento natural é o
   * sorteio, e quando ele fecha nada mais que o cite deve sair. O prefixo
   * `campaign:` continua porque é dado gravado em `notifications.cancel_key`
   * — trocá-lo deixaria de cancelar o que já está agendado.
   */
  { modelo: 'campaign:{{sorteio}}', rotulo: 'Por sorteio', dica: 'Cancela tudo daquela extração de uma vez.' },
] as const

/** As variáveis que um modelo exige. O editor lista para conferência. */
export function variaveisDaChave(modelo: string): string[] {
  const nomes = new Set<string>()
  for (const encontrado of modelo.matchAll(VARIAVEL)) {
    if (encontrado[1]) nomes.add(encontrado[1])
  }
  return [...nomes]
}
