/**
 * Tamanho da leva de um disparo manual (§5).
 *
 * Mora fora da ação de servidor por uma regra do Next: arquivo `'use server'`
 * só pode exportar função assíncrona. E precisa ser o MESMO número dos dois
 * lados — a tela fatia a lista, o servidor recusa o que passar disso.
 *
 * Não é limite do banco: é do tempo de execução. `enfileirarEnvio` faz várias
 * consultas por contato, e com o banco a 120 ms de distância uma lista grande
 * numa chamada só morre no meio, metade enfileirada, sem ninguém saber qual
 * metade. Em levas, cada chamada é curta e o progresso é visível.
 */
export const TAMANHO_DA_LEVA = 25
