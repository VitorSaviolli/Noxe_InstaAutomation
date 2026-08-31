/**
 * Comparacao de strings em tempo constante.
 *
 * Usada para verify token e admin token. Uma comparacao com `===` sai no
 * primeiro byte diferente, o que permite descobrir o segredo byte a byte
 * medindo o tempo de resposta.
 */

const encoder = new TextEncoder()

/**
 * True se as duas strings forem iguais, sem vazar ONDE diferem pelo tempo.
 *
 * O tamanho ainda vaza (comprimentos diferentes retornam cedo). Isso e
 * aceitavel: o tamanho dos nossos tokens e publico e fixo.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = encoder.encode(a)
  const bytesB = encoder.encode(b)

  if (bytesA.length !== bytesB.length) return false

  let diff = 0
  for (let i = 0; i < bytesA.length; i++) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0)
  }

  return diff === 0
}
