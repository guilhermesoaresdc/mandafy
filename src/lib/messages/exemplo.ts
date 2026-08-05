import type { DadosVariaveis } from './variables'

/**
 * Contato e aposta de exemplo para a prévia (§6.6).
 *
 * A spec pede prévia "com dados reais de um contato de teste". Enquanto o CRM
 * não existe (Fase 7), o exemplo é fixo — mas escolhido para ser honesto: nome
 * composto em caixa alta (é como cadastro de banca chega de verdade) e valor em
 * centavos como manda §4.1.
 *
 * O VOCABULÁRIO É O DE UMA BANCA, não o de uma rifa.
 *
 * Aqui não há "campanha" nem "quantidade de números": há uma aposta, numa
 * modalidade, num palpite, para uma extração que fecha numa hora. Enquanto o
 * exemplo falava de rifa, quem escrevia mensagem via a prévia dizer "12 números
 * na campanha Moto 0km" e copiava esse vocabulário para o texto — o exemplo
 * ensina, mesmo quando ninguém pediu.
 */

export const CONTATO_EXEMPLO: DadosVariaveis = {
  /*
   * `primeiro_nome` NÃO entra aqui, e a ausência é o ponto.
   *
   * Ele é um FILTRO — `{{nome|primeiro_nome}}` —, não um campo. Enquanto
   * existia como chave deste objeto, a prévia resolvia `{{primeiro_nome}}` para
   * "Maria" e quatro variantes de SMS foram escritas assim. Em produção nada
   * grava esse campo: o que chega é `nome`, e as quatro caíam no padrão. O
   * cliente lia "Oi tudo bem!" com o nome dele salvo na base ao lado.
   *
   * O exemplo é a única coisa que quem escreve mensagem enxerga antes de
   * enviar. Um campo a mais aqui é uma variável que a prévia preenche e a
   * realidade não.
   */
  nome: 'MARIA APARECIDA DA SILVA',
  telefone: '+5511988887777',
  email: 'maria@exemplo.com.br',

  external_id: 'AP-48213',
  /** O que ele apostou. */
  valor_cents: 500,
  /** O que recebe se der. Cotação de grupo costuma ficar em 18×. */
  retorno_cents: 9000,
  saldo_cents: 2350,

  /*
   * Sem travessão, e de propósito. O rótulo do sorteio entra no SMS, e um `—`
   * está fora do GSM-7: um caractere força a mensagem inteira para UCS-2, o
   * limite cai de 160 para 70 e o custo triplica. Como exemplo, ele faria a
   * prévia mentir sobre o preço para quem está escrevendo.
   */
  sorteio: 'PTV 18h',
  modalidade: 'Grupo',
  palpite: 'Elefante (grupo 11)',

  /*
   * O resultado. `milhar` é TEXTO de propósito: o primeiro prêmio pode sair
   * `0742`, e como número o zero à esquerda some. Resultado errado numa
   * mensagem de prêmio é o pior erro que este sistema pode cometer.
   */
  milhar: '7842',
  grupo: '11',
  bicho: 'Elefante',

  link_pagamento: 'https://premiabicho.exemplo.com.br/aposta/48213/pagar',
  link_resultado: 'https://premiabicho.exemplo.com.br/resultados/ptv',
  pix_copia_cola: '00020126580014BR.GOV.BCB.PIX0136exemplo-de-chave-pix-aqui5204000053039865802BR',

  // Mesmo instante nos dois formatos que os filtros aceitam.
  criado_em: '2026-07-30T17:32:00-03:00',
  expira_em: '2026-07-30T17:37:00-03:00',
  /** Quando as apostas da extração fecham — a urgência real da operação. */
  fecha_em: '2026-07-30T17:50:00-03:00',
}

/** Nomes disponíveis, para o editor listar ao lado do corpo. */
export const VARIAVEIS_DISPONIVEIS = Object.keys(CONTATO_EXEMPLO).sort()
