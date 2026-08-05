'use client'

import { useState } from 'react'
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'

/**
 * Passo 1 de §4.2: copiar o endereço de recebimento.
 *
 * O endereço contém o token — é a credencial da plataforma. Por isso o aviso
 * de tratá-lo como senha vem junto, e não escondido numa documentação.
 *
 * DOIS FORMATOS, PORQUE EXISTEM DOIS DESENHOS DE PAINEL
 *
 * Umas plataformas têm um campo de webhook só e mandam o tipo do evento dentro
 * do corpo. Outras — e é o caso do Techloto, o painel mais comum de banca —
 * cadastram UMA URL POR TIPO: escolhe "Qrcode Pago", cola um endereço,
 * adiciona; escolhe "Bilhete Premiado", cola outro. Nesse desenho o corpo não
 * precisa dizer o que aconteceu, e frequentemente não diz.
 *
 * Mandar essa pessoa colar o mesmo endereço seis vezes funcionaria pela metade:
 * os seis eventos chegariam indistinguíveis. Por isso a aba de baixo entrega um
 * endereço por evento, com `?evento=` no fim — a rota de entrada lê dali quando
 * o corpo cala.
 */

/**
 * Os nomes que o painel do Techloto usa, na ordem em que ele os lista.
 *
 * Cada um precisa existir no mapeamento sugerido, senão o endereço traz um
 * evento que o passo 3 não sabe traduzir e a ingestão o recusa com
 * `evento_nao_mapeado` — plataforma "conectada", nada acontecendo.
 * `tests/mapeamento.test.ts` compara as duas listas.
 */
const POR_EVENTO = [
  { plataforma: 'new-user', rotulo: 'Novo Usuário' },
  { plataforma: 'qrcode-created', rotulo: 'Qrcode Criado' },
  { plataforma: 'payment-by-deposit', rotulo: 'Depósito Confirmado' },
  { plataforma: 'payment-by-game', rotulo: 'Ticket Premiado' },
] as const

function Linha({ endereco, rotulo }: { endereco: string; rotulo?: string }) {
  const [copiado, setCopiado] = useState(false)

  async function copiar() {
    try {
      await navigator.clipboard.writeText(endereco)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      // Sem permissão de área de transferência: o texto continua selecionável.
    }
  }

  return (
    <div className="flex items-center gap-2">
      {rotulo ? (
        <span className="w-32 shrink-0 text-2xs font-medium text-ink">{rotulo}</span>
      ) : null}
      <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-2xs whitespace-nowrap text-ink">
        {endereco}
      </code>
      <Button variant="secondary" size="sm" onClick={copiar}>
        {copiado ? 'Copiado' : 'Copiar'}
      </Button>
    </div>
  )
}

export function PassoEndereco({ endereco }: { endereco: string }) {
  const [porEvento, setPorEvento] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="mr-2 font-mono text-2xs text-pending">1</span>
          Apontar a plataforma para cá
        </CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {/*
          A escolha vem antes do endereço, e não depois.

          Quem já copiou o endereço de cima e só então descobre que precisava de
          outro formato tem de desfazer o cadastro do outro lado. Perguntar
          primeiro custa um clique.
        */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-2xs font-medium text-ink-2">
            Como é o painel da sua plataforma?
          </legend>
          <div className="flex flex-wrap gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-2xs text-ink-2 has-[:checked]:border-ink has-[:checked]:text-ink">
              <input
                type="radio"
                name="formato"
                checked={!porEvento}
                onChange={() => setPorEvento(false)}
                className="size-3 accent-ink"
              />
              Um campo de webhook só
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-2xs text-ink-2 has-[:checked]:border-ink has-[:checked]:text-ink">
              <input
                type="radio"
                name="formato"
                checked={porEvento}
                onChange={() => setPorEvento(true)}
                className="size-3 accent-ink"
              />
              Um endereço por tipo de evento
            </label>
          </div>
        </fieldset>

        {porEvento ? (
          <>
            <p className="text-xs text-ink-2">
              Cadastre um por vez: escolha o tipo de evento no seu painel, cole o endereço
              correspondente e adicione. Método <strong>POST</strong> em todos.
            </p>

            <div className="flex flex-col gap-1.5">
              {POR_EVENTO.map((evento) => (
                <Linha
                  key={evento.plataforma}
                  rotulo={evento.rotulo}
                  endereco={`${endereco}?evento=${evento.plataforma}`}
                />
              ))}
            </div>

            <p className="text-2xs text-pending">
              Se o seu painel listar um evento que não está aqui, use o mesmo endereço trocando o
              que vem depois de <code className="font-mono">?evento=</code> pelo nome que ele usa —
              e depois traduza no passo 3.
            </p>
          </>
        ) : (
          <>
            <p className="text-xs text-ink-2">
              Cole este endereço no campo de webhook da sua plataforma de sorteio, com o método
              POST.
            </p>
            <Linha endereco={endereco} />
          </>
        )}

        <p className="text-2xs text-pending">
          Trate como senha: quem tiver este endereço consegue enviar eventos em seu nome.
        </p>

        {/*
          O nome do evento na URL só vale se o passo 3 souber traduzi-lo, e os
          nomes acima são exatamente os que o mapeamento sugerido já conhece.
          Dizer isso aqui evita a pergunta "e agora, o que faço com isso?".
        */}
        {porEvento ? (
          <p className="text-2xs text-pending">
            Estes seis nomes o Mandafy já traduz sozinho — o passo 3 vem preenchido.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}
