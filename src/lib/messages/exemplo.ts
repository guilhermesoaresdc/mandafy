import type { DadosVariaveis } from './variables'

/**
 * Contato e pedido de exemplo para a prévia (§6.6).
 *
 * A spec pede prévia "com dados reais de um contato de teste". Enquanto o CRM
 * não existe (Fase 7), o exemplo é fixo — mas escolhido para ser honesto:
 * nome composto em caixa alta (é como cadastro de sorteio chega de verdade),
 * valor em centavos como manda §4.1, e acentuação no nome da campanha, que é
 * justamente o que estoura o limite do SMS.
 */

export const CONTATO_EXEMPLO: DadosVariaveis = {
  nome: 'MARIA APARECIDA DA SILVA',
  primeiro_nome: 'Maria',
  telefone: '+5511988887777',
  email: 'maria@exemplo.com.br',

  external_id: 'PED-48213',
  valor_cents: 4990,
  quantidade: 12,
  campanha: 'Moto 0km — Edição de Julho',
  premio: 'Honda CG 160 Start',
  link_pagamento: 'https://sorteio.exemplo.com.br/pedido/48213/pagar',
  pix_copia_cola: '00020126580014BR.GOV.BCB.PIX0136exemplo-de-chave-pix-aqui5204000053039865802BR',

  // Mesmo instante nos dois formatos que os filtros aceitam.
  criado_em: '2026-07-30T14:32:00-03:00',
  expira_em: '2026-07-30T14:37:00-03:00',
}

/** Nomes disponíveis, para o editor listar ao lado do corpo. */
export const VARIAVEIS_DISPONIVEIS = Object.keys(CONTATO_EXEMPLO).sort()
