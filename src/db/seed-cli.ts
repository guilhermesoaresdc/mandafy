/**
 * `npm run db:seed` — o mesmo seed, pela linha de comando.
 *
 * Separado de `seed.ts` pelo mesmo motivo de `migrate-cli.ts`: módulo que o app
 * importa não tem ponto de entrada de processo, e um `node:url` ali derruba o
 * build do Next inteiro. A tela de sistema chama `seed()` diretamente.
 *
 * É aqui — e SÓ aqui — que a senha gerada vai para a tela. No terminal ela é
 * lida por quem rodou o comando e some com a janela; num servidor, o mesmo
 * `console.log` viraria linha permanente de log com credencial (§14.1).
 */
import { seed } from './seed'

seed()
  .then((r) => {
    console.log(r.orgCriada ? '✓ Organização criada.' : '· Organização já existe.')

    if (r.adminCriado) {
      console.log('✓ Administrador criado.')
      console.log(`    e-mail: ${r.adminEmail}`)
      if (r.senhaGerada) {
        console.log(`    senha:  ${r.senhaGerada}`)
        console.log('    ⚠ Guarde agora: esta senha não será exibida de novo.')
      }
    } else {
      console.log('· Administrador já existe.')
    }

    console.log(
      r.perfis > 0 ? `✓ ${r.perfis} perfil(is) de ritmo criado(s).` : '· Perfis de ritmo já existem.',
    )
    console.log(r.pipelineCriado ? '✓ Pipeline padrão criado com 5 etapas.' : '· Pipeline já existe.')

    console.log(
      r.mensagens > 0 || r.fluxos > 0
        ? `✓ ${r.mensagens} mensagem(ns) e ${r.fluxos} fluxo(s)-modelo criados.`
        : '· Mensagens e fluxos-modelo já existem.',
    )
    if (r.fluxos > 0) {
      console.log('    Os fluxos nascem PAUSADOS. Revise o texto e ative quando quiser.')
    }

    console.log('\nSeed concluído.')
  })
  .catch((error: unknown) => {
    console.error('\nFalha no seed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
