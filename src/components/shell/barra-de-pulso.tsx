'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CHANNEL_COLOR_VAR, CHANNEL_LABELS, type Channel } from '@/db/schema/enums'

/**
 * A barra de pulso (§11.6) — o elemento assinatura.
 *
 * Uma faixa de ~80px representando os próximos 60 minutos. Cada envio agendado
 * é um traço vertical fino, colorido pelo canal, deslizando da direita para a
 * esquerda em direção à linha "agora".
 *
 * É a única animação contínua do sistema, e carrega informação real: você olha
 * e sabe se a operação está respirando, se há um pico chegando, se algum canal
 * está mudo.
 *
 * Canvas e não SVG: com algumas centenas de traços redesenhados a 60fps, o SVG
 * criaria e destruiria nós de DOM sem parar. O canvas desenha e esquece.
 *
 * `prefers-reduced-motion` desliga a animação e vira lista estática — não é
 * detalhe de acessibilidade opcional, está na spec.
 */

export type EnvioNaBarra = {
  id: string
  channel: Channel
  /** ISO. Convertido uma vez na montagem, não a cada quadro. */
  scheduledFor: string
}

const JANELA_MINUTOS = 60
const ALTURA = 80

export function BarraDePulso({ envios }: { envios: EnvioNaBarra[] }) {
  const router = useRouter()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [semAnimacao, setSemAnimacao] = useState(false)

  // Uma conversão só, na montagem: `new Date()` por traço por quadro seria
  // ~18 mil alocações por segundo com 300 envios na tela.
  const marcados = useMemo(
    () => envios.map((e) => ({ ...e, quando: new Date(e.scheduledFor).getTime() })),
    [envios],
  )

  /*
   * A BARRA PARAVA DE DIZER A VERDADE COM A ABA ABERTA.
   *
   * O painel é `force-dynamic`: recalcula a cada requisição, e nada no cliente
   * requisita de novo. Passada uma hora com a aba aberta — que é como esta tela
   * é usada, num monitor de balcão —, os envios da "próxima hora" já saíram
   * todos e a barra desenha "Nada agendado para a próxima hora." em cima de uma
   * fila cheia. Não é lentidão: é uma tela que afirma o contrário do que está
   * acontecendo, e é a pior das duas.
   *
   * `router.refresh()` e não uma rota SSE nova: a tela muda de minuto em
   * minuto, não de segundo em segundo. Um contrato de eventos e uma rota a
   * mais para ganhar 60 segundos de frescor é preço que não se paga.
   */
  useEffect(() => {
    const relogio = setInterval(() => router.refresh(), 60_000)
    return () => clearInterval(relogio)
  }, [router])

  useEffect(() => {
    const consulta = window.matchMedia('(prefers-reduced-motion: reduce)')
    setSemAnimacao(consulta.matches)

    const ouvir = (e: MediaQueryListEvent): void => setSemAnimacao(e.matches)
    consulta.addEventListener('change', ouvir)
    return () => consulta.removeEventListener('change', ouvir)
  }, [])

  useEffect(() => {
    if (semAnimacao) return

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Cores resolvidas uma vez: `getComputedStyle` por quadro é caro, e as
    // variáveis do tema não mudam durante a animação.
    const estilo = getComputedStyle(document.documentElement)
    const corPorCanal = new Map<Channel, string>(
      (Object.keys(CHANNEL_COLOR_VAR) as Channel[]).map((c) => [
        c,
        estilo.getPropertyValue(CHANNEL_COLOR_VAR[c]).trim() || '#8A94AD',
      ]),
    )
    const corLinha = estilo.getPropertyValue('--color-ink-2').trim() || '#8A94AD'

    let quadro = 0
    let parado = false

    function desenhar(): void {
      if (parado || !canvas || !ctx) return

      const dpr = window.devicePixelRatio || 1
      const largura = canvas.clientWidth

      if (canvas.width !== largura * dpr || canvas.height !== ALTURA * dpr) {
        canvas.width = largura * dpr
        canvas.height = ALTURA * dpr
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }

      ctx.clearRect(0, 0, largura, ALTURA)

      const agora = Date.now()
      const janelaMs = JANELA_MINUTOS * 60_000

      // A linha "agora", à esquerda. Os envios caminham em direção a ela.
      ctx.strokeStyle = corLinha
      ctx.globalAlpha = 0.35
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0.5, 0)
      ctx.lineTo(0.5, ALTURA)
      ctx.stroke()

      // Marcas a cada 15 minutos, para o olho ter escala.
      ctx.globalAlpha = 0.12
      for (let m = 15; m <= JANELA_MINUTOS; m += 15) {
        const x = (m / JANELA_MINUTOS) * largura
        ctx.beginPath()
        ctx.moveTo(x, ALTURA - 8)
        ctx.lineTo(x, ALTURA)
        ctx.stroke()
      }

      for (const envio of marcados) {
        const faltam = envio.quando - agora
        if (faltam < 0 || faltam > janelaMs) continue

        const x = (faltam / janelaMs) * largura

        /*
         * Quanto mais perto de sair, mais alto e mais opaco o traço. É o que
         * transforma a barra em informação em vez de enfeite: um pico chegando
         * aparece como um adensamento que cresce.
         */
        const proximidade = 1 - faltam / janelaMs
        const altura = 14 + proximidade * 44

        ctx.globalAlpha = 0.35 + proximidade * 0.55
        ctx.strokeStyle = corPorCanal.get(envio.channel) ?? corLinha
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(x, (ALTURA - altura) / 2)
        ctx.lineTo(x, (ALTURA + altura) / 2)
        ctx.stroke()
      }

      ctx.globalAlpha = 1
      quadro = requestAnimationFrame(desenhar)
    }

    quadro = requestAnimationFrame(desenhar)

    return () => {
      parado = true
      cancelAnimationFrame(quadro)
    }
  }, [marcados, semAnimacao])

  if (marcados.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center rounded-xl border border-line bg-surface-2">
        <p className="text-2xs text-pending">Nada agendado para a próxima hora.</p>
      </div>
    )
  }

  // Movimento reduzido: a mesma informação, sem animação (§11.6).
  if (semAnimacao) {
    return (
      <ul className="flex flex-col gap-1 rounded-xl border border-line bg-surface-2 p-3">
        {marcados.slice(0, 6).map((envio) => (
          <li key={envio.id} className="flex items-center gap-2 text-2xs">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ background: `var(${CHANNEL_COLOR_VAR[envio.channel]})` }}
            />
            <span className="font-mono text-ink-2 tabular-nums">
              {new Date(envio.quando).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'America/Sao_Paulo',
              })}
            </span>
            <span className="text-pending">{CHANNEL_LABELS[envio.channel]}</span>
          </li>
        ))}
        {marcados.length > 6 ? (
          <li className="text-2xs text-pending">e mais {marcados.length - 6}…</li>
        ) : null}
      </ul>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-surface-2">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${marcados.length} envios agendados para os próximos ${JANELA_MINUTOS} minutos`}
        className="block h-20 w-full"
      />
      <span className="pointer-events-none absolute bottom-1 left-2 font-mono text-2xs text-pending">
        agora
      </span>
      <span className="pointer-events-none absolute right-2 bottom-1 font-mono text-2xs text-pending">
        +{JANELA_MINUTOS} min
      </span>
    </div>
  )
}
