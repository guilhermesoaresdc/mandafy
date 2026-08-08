'use client'

import Link from 'next/link'
import { Badge, Button, Modal } from '@/components/ui'
import { formatBRL } from '@/lib/utils'
import type { LinhaLead } from './tabela'

/**
 * A ficha do lead — o que abre ao clicar na lista.
 *
 * POR QUE UMA JANELA ANTES DA PÁGINA
 *
 * Trabalhar a lista é passar por dezenas de leads perguntando a mesma coisa:
 * quem é, quanto vale, de quem é, quando apareceu. Navegar para a página cheia
 * para descobrir isso custa um carregamento inteiro — a ficha completa faz seis
 * consultas, entre elas trinta eventos e trinta envios — e, pior, custa o
 * LUGAR: voltar traz a lista no topo, com a rolagem perdida e a seleção
 * desfeita. Com cinquenta leads para revisar, é o que faz alguém desistir de
 * revisar.
 *
 * A janela responde com o que a lista JÁ TEM em mãos: nada de rede, nada de
 * espera. Quando a pergunta for maior que isso — o que foi enviado, o que a
 * plataforma mandou, mover de etapa —, o botão abre a página completa, que é
 * onde essas respostas moram.
 */
export function FichaDoLead({
  lead,
  aoFechar,
  aoSelecionar,
}: {
  lead: LinhaLead | null
  aoFechar: () => void
  /** Junta este lead à seleção, para disparar sem sair da lista. */
  aoSelecionar?: (id: string) => void
}) {
  if (!lead) return null

  const contato = [lead.contactPhone, lead.contactEmail].filter(Boolean)

  return (
    <Modal
      aberto
      aoFechar={aoFechar}
      titulo={lead.title}
      descricao={
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge
            tone={lead.status === 'ganho' ? 'ok' : lead.status === 'perdido' ? 'fail' : 'pending'}
          >
            {lead.stageName}
          </Badge>
          <span className={lead.ownerName ? 'text-ink-2' : 'text-fail'}>
            {lead.ownerName ?? 'sem responsável'}
          </span>
        </span>
      }
      acoes={
        <>
          <Button asChild size="sm">
            <Link href={`/leads/${lead.id}`}>Abrir página completa</Link>
          </Button>
          {aoSelecionar ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                aoSelecionar(lead.id)
                aoFechar()
              }}
            >
              Selecionar para envio
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={aoFechar}>
            Fechar
          </Button>
        </>
      }
    >
      <dl className="divide-y divide-line">
        <Linha rotulo="Nome do cliente" valor={lead.contactName ?? '—'} />
        {contato.map((valor) => (
          <Linha key={valor} rotulo="Contato" valor={valor!} mono />
        ))}
        <Linha
          rotulo="Valor"
          valor={lead.valueCents > 0 ? formatBRL(lead.valueCents) : 'sem valor registrado'}
          mono={lead.valueCents > 0}
        />
        <Linha rotulo="Entrou por" valor={lead.source} />
        <Linha rotulo="Último evento" valor={porExtenso(lead.lastEventAt)} />
        <Linha rotulo="Próxima ação" valor={porExtenso(lead.nextActionAt)} />
      </dl>

      <p className="mt-3 text-2xs text-pending">
        O histórico do cliente — o que a plataforma mandou e o que já foi enviado a ele — está na
        página completa.
      </p>
    </Modal>
  )
}

function Linha({ rotulo, valor, mono = false }: { rotulo: string; valor: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-2xs text-pending">{rotulo}</dt>
      <dd className={`truncate text-2xs text-ink ${mono ? 'font-mono' : ''}`}>{valor}</dd>
    </div>
  )
}

/** Data por extenso, e não "3d": na janela cabe, e a data exata é a que serve. */
function porExtenso(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  })
}
