import { describe, expect, it } from 'vitest'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { CAMPOS_CANONICOS, MAPEAMENTO_SUGERIDO, mappingSchema } from '@/lib/ingest/mapping'
import { MENSAGENS, type ModeloMensagem } from '@/lib/messages/modelos'
import { variaveisDoCorpo } from '@/lib/messages/compile'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'

/**
 * A ponte entre o que a plataforma manda e o que a mensagem escreve (§4.2, §6.3).
 *
 * O DEFEITO QUE ISTO IMPEDE
 *
 * São duas listas em arquivos diferentes: os campos que a tela de conexão
 * oferece para mapear, e as variáveis que as mensagens usam. Elas precisam
 * bater, e nada no compilador as compara.
 *
 * Divergiram uma vez, e o sintoma foi cruel: a tela de conexão continuou
 * oferecendo "quantidade de números", "campanha" e "prêmio" — vocabulário de
 * rifa — depois que as mensagens passaram a falar de aposta, sorteio, palpite e
 * hora de fechamento. Quem conectasse a plataforma preencheria tudo, veria
 * "conectada" em verde, e os envios morreriam com `variavel_ausente` — sem
 * variável nenhuma para preencher, porque a tela nunca perguntou por elas.
 */

/**
 * O que o contato fornece sozinho, sem passar pelo mapeamento de campos.
 *
 * `nome`, `telefone` e `email` moram na tabela `contacts` e são injetados nas
 * variáveis pelo enfileiramento; `primeiro_nome` é um filtro sobre `nome`.
 */
const DA_IDENTIDADE = ['nome', 'primeiro_nome', 'telefone', 'email']

/** Fornecidos pelo próprio sistema no momento do envio. */
const DO_SISTEMA = ['link_descadastro', 'contact_id']

const CANONICOS = new Set<string>(CANONICAL_EVENTS)

/**
 * Os eventos que a tela de conexão oferece como endereço pronto (passo 1).
 *
 * Copiados do componente de propósito: se alguém acrescentar um lá sem tradução
 * aqui, é este teste que avisa — e não a plataforma de quem conectou.
 */
const EVENTOS_NO_ENDERECO = [
  'novo_usuario',
  'qrcode_criado',
  'qrcode_pago',
  'bilhete_premiado',
  'saque_pendente',
  'saque_finalizado',
]

describe('§4.2 — o que a plataforma manda alimenta o que a mensagem escreve', () => {
  const oferecidos = new Set<string>(CAMPOS_CANONICOS.map((c) => c.chave))

  it('toda variável usada pelo catálogo tem de onde vir', () => {
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const usadas = new Set([
        ...variaveisDoCorpo(modelo.body),
        ...Object.values(modelo.variantes ?? {}).flatMap((v) =>
          v?.body ? variaveisDoCorpo(v.body) : [],
        ),
        ...(modelo.subject ? variaveisDoCorpo(modelo.subject) : []),
      ])

      for (const variavel of usadas) {
        if (DA_IDENTIDADE.includes(variavel) || DO_SISTEMA.includes(variavel)) continue

        expect(
          oferecidos.has(variavel),
          `${modelo.key} usa {{${variavel}}}, e a tela de conexão não oferece esse campo`,
        ).toBe(true)
      }
    }
  })

  it('todo campo oferecido existe no contato de exemplo', () => {
    // Senão a prévia do editor mostra o nome da variável cru para quem escreve
    // — e é a prévia que decide se o texto está bom.
    for (const campo of CAMPOS_CANONICOS) {
      expect(campo.chave in CONTATO_EXEMPLO, `${campo.chave} não tem exemplo`).toBe(true)
    }
  })

  it('o mapeamento sugerido é válido e só cita campos oferecidos', () => {
    const parsed = mappingSchema.safeParse(MAPEAMENTO_SUGERIDO)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    for (const chave of Object.keys(parsed.data.fields)) {
      expect(oferecidos.has(chave), `o sugerido mapeia ${chave}, que a tela não oferece`).toBe(true)
    }
  })

  it('o sugerido traduz para eventos que existem', () => {
    const parsed = mappingSchema.safeParse(MAPEAMENTO_SUGERIDO)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    // Um evento traduzido para nome inexistente é rejeitado na ingestão com
    // `evento_nao_mapeado` — e o sintoma é a plataforma "conectada" sem nada
    // acontecer nunca.
    for (const alvo of Object.values(parsed.data.event_map)) {
      expect(CANONICOS.has(alvo), `${alvo} não é evento canônico`).toBe(true)
    }
  })

  /*
   * Os endereços por evento do passo 1 e a tradução do passo 3 são duas listas
   * em arquivos diferentes. Um endereço com `?evento=` que o mapa não conhece
   * é recusado com `evento_nao_mapeado`: a plataforma marca entrega bem
   * sucedida, a tela diz "conectada", e nada acontece nunca.
   */
  it('todo evento oferecido no endereço tem tradução no mapeamento', () => {
    const traduzidos = new Set(Object.keys(mappingSchema.parse(MAPEAMENTO_SUGERIDO).event_map))

    for (const evento of EVENTOS_NO_ENDERECO) {
      expect(traduzidos.has(evento), `${evento} não tem tradução no mapeamento sugerido`).toBe(true)
    }
  })

  it('nenhum campo oferecido usa vocabulário de rifa', () => {
    // "números" no plural é o tell da rifa (os números que a pessoa compra).
    // "Número da aposta", no singular, é o identificador do pedido e fica.
    const proibidas = /\b(campanha|rifa|bilhete|n[úu]meros)\b/i
    for (const campo of CAMPOS_CANONICOS) {
      const texto = `${campo.rotulo} ${'dica' in campo ? campo.dica : ''}`
      expect(proibidas.test(texto), `vocabulário de rifa em "${campo.rotulo}"`).toBe(false)
    }
  })
})
