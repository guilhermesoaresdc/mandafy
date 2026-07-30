/**
 * Distribuição de leads entre consultores (§9.3).
 *
 * "Round-robin entre consultores ativos, ou manual."
 *
 * Round-robin puro tem um defeito conhecido: quem entra na equipe hoje recebe
 * o próximo lead como se tivesse a mesma carga de quem está há um mês. O que
 * este módulo faz é round-robin PONDERADO PELA CARGA — quem tem menos leads
 * abertos recebe primeiro, e o desempate é estável para não depender de sorte.
 *
 * Puro de propósito: recebe a carga já lida e devolve quem fica com o lead.
 */

export type Consultor = { id: string; name: string }

export type ModoDistribuicao = 'rodizio' | 'manual'

/**
 * Quem recebe o próximo lead.
 *
 * Empate resolvido pelo id, não por sorteio: com a equipe vazia, o rodízio
 * ficaria imprevisível e ninguém entenderia por que os três primeiros leads
 * caíram na mesma pessoa.
 */
export function proximoResponsavel(
  consultores: readonly Consultor[],
  carga: ReadonlyMap<string, number>,
): Consultor | null {
  if (consultores.length === 0) return null

  return [...consultores].sort((a, b) => {
    const diferenca = (carga.get(a.id) ?? 0) - (carga.get(b.id) ?? 0)
    return diferenca !== 0 ? diferenca : a.id.localeCompare(b.id)
  })[0]!
}

/**
 * Distribui vários leads de uma vez, mantendo o equilíbrio ao longo da fila.
 *
 * A carga é atualizada A CADA atribuição. Sem isso, distribuir 10 leads com a
 * carga lida uma vez só mandaria os 10 para a mesma pessoa — que é o modo
 * clássico de o "round-robin" não rodar nada.
 */
export function distribuir(
  quantidade: number,
  consultores: readonly Consultor[],
  cargaInicial: ReadonlyMap<string, number>,
): Consultor[] {
  if (consultores.length === 0) return []

  const carga = new Map(cargaInicial)
  const destinos: Consultor[] = []

  for (let i = 0; i < quantidade; i += 1) {
    const escolhido = proximoResponsavel(consultores, carga)
    if (!escolhido) break

    destinos.push(escolhido)
    carga.set(escolhido.id, (carga.get(escolhido.id) ?? 0) + 1)
  }

  return destinos
}

// ── Regras de criação automática (§9.3) ──────────────────────────────────────

export type RegraCriacao = {
  chave: string
  rotulo: string
  evento: string
  /** Nome da etapa em que o lead nasce. */
  etapa: string
  /** Valor mínimo em centavos para a regra valer. */
  valorMinimoCents?: number
  /** Espera antes de criar, em segundos. */
  atrasoSegundos?: number
  explicacao: string
}

/** As três regras sugeridas por §9.3. */
export const REGRAS_PADRAO: RegraCriacao[] = [
  {
    chave: 'pix_nao_pago_24h',
    rotulo: 'PIX sem pagamento em 24h',
    evento: 'order.created',
    etapa: 'Novo',
    atrasoSegundos: 24 * 3600,
    explicacao: 'Gerou o PIX e não pagou em um dia. Vale um toque humano.',
  },
  {
    chave: 'compra_alta',
    rotulo: 'Compra acima de R$ 200',
    evento: 'order.paid',
    etapa: 'Contatado',
    valorMinimoCents: 20_000,
    explicacao: 'Cliente valioso. Merece atenção antes da próxima campanha.',
  },
  {
    chave: 'reativacao',
    rotulo: 'Sumiu há 30 dias, mas já comprou',
    evento: 'contact.inactive_30d',
    etapa: 'Novo',
    explicacao: 'Tem histórico de compra e parou. É o lead mais barato de recuperar.',
  },
]

export type ContextoRegra = {
  evento: string
  valorCents: number | null
  /** Já comprou alguma vez? A regra de reativação depende disso. */
  jaComprou: boolean
}

/** As regras que este evento aciona. */
export function regrasAplicaveis(
  ctx: ContextoRegra,
  regras: readonly RegraCriacao[] = REGRAS_PADRAO,
): RegraCriacao[] {
  return regras.filter((regra) => {
    if (regra.evento !== ctx.evento) return false

    if (regra.valorMinimoCents !== undefined) {
      if (ctx.valorCents === null || ctx.valorCents < regra.valorMinimoCents) return false
    }

    // "com histórico de compra" — a regra de reativação só vale para quem já
    // comprou. Criar lead para quem nunca comprou encheria o funil de ruído.
    if (regra.chave === 'reativacao' && !ctx.jaComprou) return false

    return true
  })
}
