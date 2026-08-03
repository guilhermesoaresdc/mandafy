/**
 * Regras de senha que a INTERFACE precisa conhecer.
 *
 * Vive separado de `password.ts` porque aquele módulo importa `node:crypto`, e
 * um componente de cliente que precise só do tamanho mínimo arrastaria o
 * módulo inteiro para o navegador — o empacotador do Next recusa e o build
 * quebra com "Reading from node:crypto is not handled by plugins".
 *
 * Mesmo motivo de `src/lib/api/escopos.ts`. A regra geral: constante que a
 * tela mostra não mora no arquivo que faz criptografia.
 */

/**
 * Comprimento mínimo.
 *
 * Dez, e não oito: com scrypt no custo que usamos, o que protege contra
 * tentativa em massa é o tamanho, não a exigência de símbolo. Regras de
 * "precisa ter maiúscula e número" produzem senhas piores e mais anotadas em
 * papel — o comprimento é a única exigência que compensa o incômodo.
 */
export const MIN_PASSWORD_LENGTH = 10

/**
 * Por que um link de senha não vale mais, em português.
 *
 * Aqui e não em `senha-actions.ts` porque aquele arquivo é `'use server'`, e o
 * Next só aceita exportação de função assíncrona nesses módulos — um objeto ali
 * quebra a coleta de rotas com "A 'use server' file can only export async
 * functions".
 *
 * Cada mensagem diz o que fazer. "Já foi usado" pede aviso ao administrador de
 * propósito: se não foi a própria pessoa que usou o link, alguém entrou na
 * conta dela, e essa é a única mensagem desta tela que pede ação urgente.
 */
export const MENSAGEM_DO_MOTIVO: Record<string, string> = {
  invalido: 'Este link não é válido. Peça um novo para o administrador.',
  expirado: 'Este link venceu. Peça um novo — eles duram pouco de propósito.',
  usado: 'Este link já foi usado. Se não foi você, avise o administrador agora.',
  inativo: 'Esta conta está desativada. Fale com o administrador.',
}
