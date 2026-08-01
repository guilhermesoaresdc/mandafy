/**
 * Substituto de `server-only` sob o Vitest.
 *
 * O pacote real existe para QUEBRAR o build quando um módulo de servidor é
 * importado por um componente de cliente — a proteção que impede uma
 * credencial ou uma query ir parar no navegador. Ele faz isso lançando na
 * importação, o que sob o Vitest derruba qualquer suíte que alcance esses
 * módulos, mesmo indiretamente.
 *
 * Aqui não há navegador nem bundler: tudo roda em Node. Neutralizá-lo no teste
 * não afrouxa nada em produção, onde o `next build` continua aplicando a regra.
 */
export {}
