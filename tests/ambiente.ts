/**
 * O ambiente mínimo das suítes (`setupFiles` do vitest.config.ts).
 *
 * POR QUE EXISTE
 *
 * `serverEnv()` valida o ambiente INTEIRO de uma vez, de propósito: metade das
 * variáveis presentes é um jeito de descobrir em produção, três horas depois do
 * deploy, que faltava uma. O efeito colateral é que qualquer teste que alcance
 * uma função que chame `serverEnv()` — `resolverCanal`, a rota do batimento —
 * morre num erro de configuração antes de exercitar o que veio testar.
 *
 * Isso já cobrou caro duas vezes. A suíte do batimento passou seis execuções
 * seguidas em vermelho na `main` por este motivo, e as suítes de banco não
 * rodavam sem um `.env` completo na máquina de quem chamasse — o que também
 * significa que elas nunca rodaram no CI, justamente as que protegem
 * cancelamento por chave, RLS e disjuntor.
 *
 * Nada aqui é usado por nenhum teste: não se abre banco por estes valores, não
 * se cifra nada com esta chave, não se emite sessão com este segredo. São os
 * campos que o esquema exige para `serverEnv()` deixar o código passar.
 *
 * `??=` e não atribuição: quem exporta um ambiente de verdade — o CI com o
 * Postgres de serviço, ou alguém com `.env` — continua mandando.
 */
process.env.APP_URL ??= 'https://exemplo.test'
process.env.SESSION_SECRET ??= 'x'.repeat(64)
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64)
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379'

/*
 * `DATABASE_URL` acompanha o endereço de teste quando ele existe: as suítes de
 * banco abrem a própria conexão, mas o código sob teste pode chamar `db` do
 * módulo, e apontá-lo para outro lugar trocaria um erro de configuração por um
 * erro de conexão — mais confuso, não menos.
 *
 * E na falta dele, a porta 1, onde nada escuta. Um endereço PLAUSÍVEL —
 * `127.0.0.1:5432` com um papel que não existe — foi o que quebrou o CI: o
 * pool do `@/db` nasceu apontando para lá, o `postgres` só se conecta na
 * primeira consulta, e a falha apareceu dois arquivos adiante num `beforeEach`
 * que estourou o tempo. Recusa de conexão é instantânea e diz o que é.
 */
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ?? 'postgres://sem-banco@127.0.0.1:1/sem-banco'
