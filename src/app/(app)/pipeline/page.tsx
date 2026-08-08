import { redirect } from 'next/navigation'

/**
 * O funil mudou de endereço (§9.1).
 *
 * `/leads` e `/pipeline` mostravam os mesmos leads, cada uma fazendo o que a
 * outra não fazia: a lista busca, exporta e dispara em lote; o funil mostra a
 * etapa e deixa mover. Quem quisesse "mover os 200 que acabaram de receber"
 * precisava das duas, alternando pelo menu.
 *
 * A rota antiga fica, e não como cortesia: ela está em favoritos, em links
 * colados em conversa, e na barra de endereço de quem digita por memória.
 * Apagá-la trocaria "duas telas para a mesma coisa" por "a tela sumiu".
 */
export default function PipelinePage() {
  redirect('/leads?vista=funil')
}
