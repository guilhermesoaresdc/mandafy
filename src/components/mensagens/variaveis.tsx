'use client'

import { useMemo, useState } from 'react'
import { CAMPOS, nomeDoCampo, valorDoCampo } from '@/lib/vocabulario'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'
import { cn } from '@/lib/utils'

/**
 * As variáveis como cartões com NOME, e não como código.
 *
 * O QUE HAVIA ANTES
 *
 * Uma lista de identificadores: `valor_cents`, `fecha_em`, `retorno_cents`,
 * `pix_copia_cola`. Quem escreve a mensagem é quem toca a banca, não quem
 * escreveu o schema — e para essa pessoa `retorno_cents` não é "quanto ele
 * ganha se acertar", é um enigma. O nome estava a um clique de distância, no
 * código-fonte.
 *
 * O JEITO DO MAKE, QUE É O JEITO CERTO
 *
 * Cada campo vira um cartão com três coisas: o nome em português, o que ele é,
 * e o VALOR DE EXEMPLO. O exemplo é a parte que mais ensina — "R$ 5,00" ao lado
 * de "Valor da aposta" responde de uma vez a pergunta que o nome sozinho deixa
 * no ar (é em centavos? já vem formatado? tem o R$?).
 *
 * Clicar insere `{{chave}}` no texto, na posição do cursor. O código continua
 * existindo, porque é ele que o compilador entende — o que muda é que ninguém
 * precisa mais decorá-lo para escrever uma mensagem.
 */

/** Insere no ponto do cursor, e não no fim. */
export function inserirNoCursor(
  campo: HTMLTextAreaElement | null,
  texto: string,
  atual: string,
): { proximo: string; cursor: number } {
  if (!campo) return { proximo: atual + texto, cursor: (atual + texto).length }

  const inicio = campo.selectionStart ?? atual.length
  const fim = campo.selectionEnd ?? inicio

  return {
    proximo: atual.slice(0, inicio) + texto + atual.slice(fim),
    cursor: inicio + texto.length,
  }
}

const ORDEM_DOS_GRUPOS = ['Pessoa', 'Aposta', 'Resultado', 'Tempo', 'Links'] as const

export function SeletorDeVariaveis({
  aoInserir,
  usadas = [],
  compacto = false,
}: {
  /** Recebe o texto pronto para inserir, já com as chaves. */
  aoInserir: (trecho: string) => void
  /** As que já estão no texto — ganham selo e não somem da lista. */
  usadas?: readonly string[]
  compacto?: boolean
}) {
  const [busca, setBusca] = useState('')

  const grupos = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase('pt-BR')

    const chaves = Object.keys(CONTATO_EXEMPLO).filter((chave) => {
      if (termo === '') return true
      // Procura pelo NOME e pelo código: quem já conhece `valor_cents` continua
      // achando por ele, e quem não conhece acha por "valor".
      return (
        nomeDoCampo(chave).toLocaleLowerCase('pt-BR').includes(termo) ||
        chave.includes(termo)
      )
    })

    return ORDEM_DOS_GRUPOS.map((grupo) => ({
      grupo,
      campos: chaves.filter((c) => (CAMPOS[c]?.grupo ?? 'Pessoa') === grupo),
    })).filter((g) => g.campos.length > 0)
  }, [busca])

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Procurar campo…"
        aria-label="Procurar variável"
        className="h-8 rounded-lg border border-line bg-surface-2 px-2 text-2xs text-ink outline-none placeholder:text-pending focus-visible:border-ink"
      />

      {grupos.length === 0 ? (
        <p className="py-2 text-2xs text-pending">Nenhum campo com esse nome.</p>
      ) : (
        grupos.map(({ grupo, campos }) => (
          <div key={grupo} className="flex flex-col gap-1">
            <p className="text-2xs font-medium tracking-wide text-pending uppercase">{grupo}</p>
            <div className={cn('grid gap-1', compacto ? 'grid-cols-1' : 'sm:grid-cols-2')}>
              {campos.map((chave) => {
                const campo = CAMPOS[chave]
                const jaUsada = usadas.includes(chave)

                return (
                  <button
                    key={chave}
                    type="button"
                    onClick={() => aoInserir(`{{${chave}}}`)}
                    title={campo?.ajuda}
                    className={cn(
                      'flex flex-col items-start gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors',
                      jaUsada
                        ? 'border-live/50 bg-live-soft/50'
                        : 'border-line hover:border-ink hover:bg-surface-2',
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-2xs text-ink">
                        {nomeDoCampo(chave)}
                      </span>
                      {jaUsada ? (
                        <span className="shrink-0 text-2xs text-live">no texto</span>
                      ) : null}
                    </span>
                    {/*
                      O exemplo, e não o código. É o que responde "vem formatado?"
                      sem ninguém precisar enviar um teste para descobrir.
                    */}
                    <span className="w-full truncate font-mono text-2xs text-pending">
                      {valorDoCampo(chave, CONTATO_EXEMPLO[chave])}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))
      )}

      <p className="text-2xs text-pending">
        Clique para inserir onde o cursor está. Se o campo vier vazio no envio, a mensagem não sai
        pela metade — ela falha e aparece no histórico.
      </p>
    </div>
  )
}
