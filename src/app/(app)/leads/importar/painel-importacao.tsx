'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { lerCsv, mapearColunas, type CampoDestino, type LeituraCsv } from '@/lib/leads/csv'
import { conferir, type Conferencia, type MapaColunas } from '@/lib/leads/conferir'
import { formatBRL, formatNumber } from '@/lib/utils'
import { importarAction, type EstadoImportacao } from './actions'

/**
 * Importar lista (§9.1, §13.2).
 *
 * O ARQUIVO NÃO SOBE PARA SER CONFERIDO.
 *
 * A leitura e a conferência rodam aqui, no navegador: `csv.ts` e `conferir.ts`
 * são puros justamente para isso. O ganho não é de servidor — é de confiança.
 * Quem sobe uma planilha de dez mil pessoas quer ver o que vai acontecer antes
 * de acontecer, e um ciclo de subir-esperar-ler-corrigir-subir-de-novo acaba
 * com alguém importando no escuro para não repetir a espera.
 *
 * Só depois de a pessoa dizer "importa" as linhas aprovadas vão ao servidor —
 * onde são validadas de novo, porque validação de navegador não é garantia.
 *
 * ADIVINHAR A COLUNA É SUGESTÃO, NUNCA DECISÃO
 *
 * O mapeamento automático acerta quase sempre e ainda assim aparece na tela,
 * editável. Gravar telefone na coluna de CPF em silêncio é o erro que só se
 * descobre no primeiro disparo.
 */

const CAMPOS: { campo: CampoDestino; rotulo: string; nota?: string }[] = [
  { campo: 'nome', rotulo: 'Nome' },
  { campo: 'telefone', rotulo: 'Telefone', nota: 'WhatsApp e SMS' },
  { campo: 'email', rotulo: 'E-mail' },
  { campo: 'cpf', rotulo: 'CPF' },
  { campo: 'external_id', rotulo: 'Código na plataforma', nota: 'evita duplicar' },
  { campo: 'tags', rotulo: 'Etiquetas' },
  { campo: 'valor_cents', rotulo: 'Valor' },
  { campo: 'titulo', rotulo: 'Título do lead' },
]

const LIMITE_LINHAS = 5000

export function PainelImportacao() {
  const [arquivo, setArquivo] = useState<{ nome: string; leitura: LeituraCsv } | null>(null)
  const [mapa, setMapa] = useState<MapaColunas>({})
  const [criarLeads, setCriarLeads] = useState(true)
  const [estado, setEstado] = useState<EstadoImportacao>({})
  const [enviando, iniciar] = useTransition()
  const entrada = useRef<HTMLInputElement>(null)

  async function escolher(file: File | undefined) {
    if (!file) return
    const texto = await file.text()
    const leitura = lerCsv(texto)

    setArquivo({ nome: file.name, leitura })
    setMapa(mapearColunas(leitura.colunas))
    setEstado({})
  }

  /*
   * Reconferir a cada troca de coluna é o que torna o mapeamento honesto: mudar
   * o campo do telefone e ver na hora quantas linhas passaram a ser recusadas
   * diz mais que qualquer explicação.
   */
  const conferencia: Conferencia | null = useMemo(
    () => (arquivo ? conferir(arquivo.leitura.linhas, mapa) : null),
    [arquivo, mapa],
  )

  const excedeu = (conferencia?.validas.length ?? 0) > LIMITE_LINHAS

  function importar() {
    if (!conferencia || conferencia.validas.length === 0) return
    iniciar(async () => {
      setEstado(await importarAction({ linhas: conferencia.validas, criarLeads }))
    })
  }

  function recomecar() {
    setArquivo(null)
    setMapa({})
    setEstado({})
    if (entrada.current) entrada.current.value = ''
  }

  // ── Depois de gravar ──────────────────────────────────────────────────────
  if (estado.resultado) {
    const r = estado.resultado
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <p className="text-sm font-medium text-ok">Importação concluída.</p>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Numero rotulo="Contatos novos" valor={r.criados} />
            <Numero rotulo="Já existiam" valor={r.atualizados} />
            <Numero rotulo="Leads criados" valor={r.leadsCriados} />
            <Numero rotulo="Preservados" valor={r.preservados} destaque={r.preservados > 0} />
          </dl>

          {r.preservados > 0 ? (
            /*
             * Isto não é aviso de erro — é a prestação de contas da decisão
             * mais importante do importador. Quem vê "3 preservados" precisa
             * entender por que essas três pessoas não voltaram, senão vai
             * procurar o bug.
             */
            <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-ink-2">
              {r.preservados === 1
                ? 'Uma pessoa da planilha já tinha pedido para não receber mais. Ela continua fora: '
                : `${formatNumber(r.preservados)} pessoas da planilha já tinham pedido para não receber mais. Elas continuam fora: `}
              estar numa lista não desfaz um pedido de saída, e reativar por importação é o que a LGPD proíbe. Os dados de cadastro foram atualizados; o consentimento, não.
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button asChild size="sm">
              <Link href="/leads">Ver os leads</Link>
            </Button>
            <Button size="sm" variant="secondary" onClick={recomecar}>
              Importar outra lista
            </Button>
          </div>
        </CardBody>
      </Card>
    )
  }

  // ── Antes de escolher o arquivo ───────────────────────────────────────────
  if (!arquivo) {
    return (
      <Card>
        <CardBody className="flex flex-col items-start gap-3">
          <div>
            <p className="text-xs font-medium text-ink">Escolha a planilha</p>
            <p className="mt-1 text-2xs leading-relaxed text-ink-2">
              CSV com uma pessoa por linha e a primeira linha com os nomes das colunas. Serve o
              arquivo que o Excel salva em português (separado por ponto e vírgula) e serve também
              o CSV que você exporta aqui mesmo, depois de ajustar na planilha.
            </p>
          </div>

          <input
            ref={entrada}
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => void escolher(e.target.files?.[0])}
            className="text-2xs text-ink-2 file:mr-3 file:h-8 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-2xs file:font-medium file:text-ink hover:file:bg-surface-2"
          />
        </CardBody>
      </Card>
    )
  }

  const validas = conferencia?.validas ?? []

  return (
    <div className="flex flex-col gap-4">
      {/* Arquivo lido */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-ink">{arquivo.nome}</p>
            <p className="text-2xs text-ink-2">
              {formatNumber(arquivo.leitura.linhas.length)} linha
              {arquivo.leitura.linhas.length === 1 ? '' : 's'} ·{' '}
              {arquivo.leitura.colunas.length} colunas · separador{' '}
              {arquivo.leitura.separador === '\t' ? 'tabulação' : `"${arquivo.leitura.separador}"`}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={recomecar}>
            Trocar arquivo
          </Button>
        </CardBody>
      </Card>

      {/* Mapeamento */}
      <Card>
        <CardHeader>
          <CardTitle>De onde vem cada informação</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 sm:grid-cols-2">
          {CAMPOS.map(({ campo, rotulo, nota }) => (
            <label key={campo} className="flex flex-col gap-1.5">
              <span className="text-2xs font-medium text-ink-2">
                {rotulo}
                {nota ? <span className="ml-1 font-normal text-pending">· {nota}</span> : null}
              </span>
              <select
                value={mapa[campo] ?? ''}
                onChange={(e) =>
                  setMapa((atual) => {
                    const proximo = { ...atual }
                    if (e.target.value === '') delete proximo[campo]
                    else proximo[campo] = e.target.value
                    return proximo
                  })
                }
                className="h-9 rounded-lg border border-line bg-surface px-2 text-xs text-ink"
              >
                <option value="">— não importar —</option>
                {arquivo.leitura.colunas.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </CardBody>
      </Card>

      {/* Conferência */}
      <Card>
        <CardHeader>
          <CardTitle>O que vai entrar</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <dl className="grid grid-cols-3 gap-3">
            <Numero rotulo="Prontas" valor={validas.length} />
            <Numero
              rotulo="Recusadas"
              valor={conferencia?.rejeitadas.length ?? 0}
              destaque={(conferencia?.rejeitadas.length ?? 0) > 0}
            />
            <Numero rotulo="Repetidas no arquivo" valor={conferencia?.repetidas ?? 0} />
          </dl>

          {validas.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[36rem] text-2xs">
                <thead className="bg-surface-2 text-ink-2">
                  <tr>
                    <Th>Nome</Th>
                    <Th>Telefone</Th>
                    <Th>E-mail</Th>
                    <Th>Etiquetas</Th>
                    <Th>Valor</Th>
                  </tr>
                </thead>
                <tbody>
                  {validas.slice(0, 8).map((l) => (
                    <tr key={l.linha} className="border-t border-line">
                      <Td>{l.nome ?? '—'}</Td>
                      <Td mono>{l.telefone ?? '—'}</Td>
                      <Td>{l.email ?? '—'}</Td>
                      <Td>{l.tags.join(', ') || '—'}</Td>
                      <Td mono>{l.valorCents > 0 ? formatBRL(l.valorCents) : '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {validas.length > 8 ? (
                <p className="border-t border-line px-3 py-2 text-2xs text-ink-2">
                  e mais {formatNumber(validas.length - 8)}.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-2xs text-fail">
              Nenhuma linha aproveitável. Confira acima de qual coluna vem o telefone — sem
              telefone nem e-mail não há como enviar nada, e a linha é recusada.
            </p>
          )}

          {conferencia && conferencia.rejeitadas.length > 0 ? (
            <details className="rounded-xl border border-line px-3 py-2">
              <summary className="cursor-pointer text-2xs text-ink-2">
                Ver as {formatNumber(conferencia.rejeitadas.length)} recusadas
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {conferencia.rejeitadas.slice(0, 50).map((r) => (
                  <li key={r.linha} className="text-2xs text-ink-2">
                    <span className="font-mono text-pending">linha {r.linha}</span> — {r.motivo}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </CardBody>
      </Card>

      {/* Gravar */}
      <Card>
        <CardBody className="flex flex-col gap-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={criarLeads}
              onChange={(e) => setCriarLeads(e.target.checked)}
              className="mt-0.5 size-3.5 accent-[var(--color-live)]"
            />
            <span className="text-2xs leading-relaxed text-ink-2">
              <span className="font-medium text-ink">Abrir um lead para cada pessoa</span> na
              primeira etapa do funil. Desmarque se você quer só a base para disparo — quem já tem
              lead aberto não ganha outro de qualquer forma.
            </span>
          </label>

          {/*
           * A frase abaixo é a única promessa que o importador faz sobre
           * consentimento, e ela precisa estar visível ANTES do botão. Depois
           * de gravar, é explicação; antes, é o que evita a pessoa importar
           * esperando que a lista "reative" a base antiga.
           */}
          <p className="text-2xs leading-relaxed text-pending">
            Quem já pediu para não receber continua fora, mesmo aparecendo na planilha. Contatos
            que já existem têm só os campos vazios completados.
          </p>

          {excedeu ? (
            <p className="text-2xs text-fail">
              São {formatNumber(validas.length)} linhas e o limite por vez é{' '}
              {formatNumber(LIMITE_LINHAS)}. Divida a planilha em partes.
            </p>
          ) : null}

          {estado.erro ? <p className="text-2xs text-fail">{estado.erro}</p> : null}

          <div>
            <Button onClick={importar} disabled={enviando || validas.length === 0 || excedeu}>
              {enviando
                ? 'Importando…'
                : `Importar ${formatNumber(validas.length)} contato${validas.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function Numero({
  rotulo,
  valor,
  destaque,
}: {
  rotulo: string
  valor: number
  destaque?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-2xs text-ink-2">{rotulo}</dt>
      <dd className={`text-lg font-medium ${destaque ? 'text-fail' : 'text-ink'}`}>
        {formatNumber(valor)}
      </dd>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium">{children}</th>
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={`max-w-40 truncate px-3 py-2 text-ink ${mono ? 'font-mono' : ''}`}>
      {children}
    </td>
  )
}
