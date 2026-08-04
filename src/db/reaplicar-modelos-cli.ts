/**
 * `npm run db:modelos` — reaplica o catálogo por cima do que já está gravado.
 *
 * Separado de `reaplicar-modelos.ts` pelo mesmo motivo de `seed-cli.ts`: módulo
 * que o app importa não tem ponto de entrada de processo, e um `process.exit`
 * ali derruba o build do Next inteiro.
 *
 * SEM `--aplicar` ELE NÃO ESCREVE NADA.
 *
 * Um comando que reescreve o texto que sai para o cliente não pode ser
 * executável por engano. A simulação também é a parte útil na maioria das
 * vezes: ela diz quais mensagens foram editadas à mão, que é a informação que
 * ninguém tem antes de rodar.
 */
import { reaplicarModelos, type Desfecho, type Resultado } from './reaplicar-modelos'

/**
 * Singular e plural.
 *
 * "1 editadas à mão" numa saída em português é o tipo de descuido que faz
 * duvidar do resto do relatório — e este relatório é o que decide se alguém
 * roda o comando com `--aplicar`.
 */
const ROTULOS: Record<Desfecho, [singular: string, plural: string]> = {
  reaplicado: ['atualizada', 'atualizadas'],
  editado: ['editada à mão — não toquei', 'editadas à mão — não toquei'],
  em_dia: ['já estava em dia', 'já estavam em dia'],
  ausente: ['não existe no banco (rode db:seed)', 'não existem no banco (rode db:seed)'],
  orfa: [
    'aposentada do catálogo — continua no banco',
    'aposentadas do catálogo — continuam no banco',
  ],
}

function rotular(desfecho: Desfecho, n: number): string {
  const [um, varios] = ROTULOS[desfecho]
  return `${n} ${n === 1 ? um : varios}`
}

/** Da mais acionável para a menos. Quem lê no terminal lê de cima. */
const ORDEM: Desfecho[] = ['reaplicado', 'editado', 'orfa', 'ausente', 'em_dia']

function agrupar(resultados: Resultado[]): Map<Desfecho, Resultado[]> {
  const mapa = new Map<Desfecho, Resultado[]>()
  for (const r of resultados) {
    const lista = mapa.get(r.desfecho) ?? []
    lista.push(r)
    mapa.set(r.desfecho, lista)
  }
  return mapa
}

async function principal(): Promise<void> {
  const aplicar = process.argv.includes('--aplicar')

  const resultados = await reaplicarModelos(aplicar)
  const porDesfecho = agrupar(resultados)

  for (const desfecho of ORDEM) {
    const lista = porDesfecho.get(desfecho)
    if (!lista?.length) continue
    console.log(`\n${rotular(desfecho, lista.length)}:`)
    for (const r of lista) console.log(`  · ${r.key} — ${r.nome}`)
  }

  const mudadas = porDesfecho.get('reaplicado')?.length ?? 0
  const editadas = porDesfecho.get('editado')?.length ?? 0
  const orfas = porDesfecho.get('orfa')?.length ?? 0

  console.log('')

  if (mudadas === 0) {
    console.log('Nada a atualizar.')
  } else if (aplicar) {
    console.log(`✓ ${mudadas} mensagem(ns) atualizadas.`)
  } else {
    console.log(
      `Simulação — nada foi gravado. ${mudadas} mensagem(ns) seriam atualizadas.\n` +
        'Rode de novo com --aplicar para valer.',
    )
  }

  if (editadas > 0) {
    console.log(
      editadas === 1
        ? '\nA editada à mão ficou como estava, de propósito: o comando só reescreve\n' +
          'texto que ele mesmo escreveu. Para levar o modelo novo a ela, abra\n' +
          'Mensagens e edite, ou apague e recrie a partir do modelo.'
        : `\nAs ${editadas} editadas à mão ficaram como estavam, de propósito: o comando só\n` +
          'reescreve texto que ele mesmo escreveu. Para levar o modelo novo a elas,\n' +
          'abra Mensagens e edite, ou apague e recrie a partir do modelo.',
    )
  }

  if (orfas > 0) {
    console.log(
      `\n${orfas === 1 ? 'A aposentada saiu' : `As ${orfas} aposentadas saíram`} do catálogo mas ` +
        `${orfas === 1 ? 'continua' : 'continuam'} no banco. Confira em Mensagens\n` +
        'se algum fluxo ainda as usa; se não, dá para apagar sem perda.',
    )
  }
}

principal().catch((erro: unknown) => {
  console.error('\nFalha ao reaplicar os modelos:', erro instanceof Error ? erro.message : erro)
  process.exit(1)
})
