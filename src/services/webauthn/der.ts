/**
 * ASN.1 DER -> `r||s` cru, para ECDSA P-256.
 *
 * **Esta e a armadilha numero um do projeto** (§10.7, passo 9). Um autenticador
 * WebAuthn devolve a assinatura ECDSA como `SEQUENCE { INTEGER r, INTEGER s }`;
 * o `crypto.subtle.verify` do WebCrypto exige `r||s` em 64 bytes crus. Sem esta
 * conversao o `verify` devolve `false` **em silencio** — nao lanca, nao avisa —
 * e o dono simplesmente nunca entra no proprio painel.
 *
 * O caminho inverso mora no `AutenticadorFalso` do teste, que converte cru ->
 * DER para produzir os mesmos bytes que um autenticador real produziria
 * (§13.3, item 6). Sem esse passo la, este arquivo aqui nunca seria exercitado.
 *
 * Maleabilidade (`s` e `n-s` sao ambas assinaturas validas) e irrelevante neste
 * desenho: replay ja esta barrado pelo desafio efemero e nenhum identificador
 * do painel deriva da assinatura (§10.7).
 *
 * Nunca lanca: devolve `null`. A entrada vem do corpo de uma requisicao.
 */

/** Uma coordenada de P-256 tem exatamente 32 bytes. */
export const TAMANHO_DA_COORDENADA = 32

/** `r||s` crus, o que o WebCrypto espera. */
export const TAMANHO_DA_ASSINATURA_CRUA = TAMANHO_DA_COORDENADA * 2

/**
 * Teto do DER de uma assinatura P-256.
 *
 * `0x30 len` (2) + dois INTEGER de no maximo `0x02 len` + 33 bytes (2 * 35) =
 * 72. Um DER maior que isso nao e assinatura P-256, e o teto e o que impede
 * que este parser gaste CPU com um corpo inflado (§11.3).
 */
export const TAMANHO_MAXIMO_DO_DER = 72

const SEQUENCE = 0x30
const INTEGER = 0x02
/** Acima disto o comprimento DER usa forma longa. */
const FORMA_CURTA = 0x80
/** Forma longa de UM octeto: o unico caso que uma assinatura P-256 alcanca. */
const FORMA_LONGA_DE_UM_OCTETO = 0x81

interface Leitura {
  readonly bytes: Uint8Array
  readonly proxima: number
}

/**
 * `SEQUENCE { INTEGER r, INTEGER s }` -> `r||s` com 32 bytes cada.
 *
 * Trava de WA-15 e WA-16: os passos 4 e 5 sao os que fazem um `r` de 33 bytes
 * (com o `0x00` de sinal) e um `r` de 31 bytes (sorteio que caiu abaixo de
 * 2^248) chegarem ao WebCrypto como 32 bytes alinhados a direita. Trocar
 * qualquer um dos dois por um `slice` de tamanho fixo derruba os dois testes.
 *
 * Trava de WA-17: o passo 1 e o passo 7 juntos sao o que recusa uma assinatura
 * crua de 64 bytes apresentada no lugar do DER.
 */
export function derParaBruto(der: Uint8Array): Uint8Array | null {
  // 1. Tem que ser um SEQUENCE.
  if (der.length < 2 || der[0] !== SEQUENCE) return null
  if (der.length > TAMANHO_MAXIMO_DO_DER) return null

  // 2. Comprimento: forma curta, ou `0x81 xx`. Nada alem disso cabe em 72 bytes.
  const marcador = der[1] ?? 0
  let posicao: number
  let comprimento: number

  if (marcador < FORMA_CURTA) {
    comprimento = marcador
    posicao = 2
  } else if (marcador === FORMA_LONGA_DE_UM_OCTETO) {
    if (der.length < 3) return null
    comprimento = der[2] ?? 0
    posicao = 3
  } else {
    return null
  }

  // O SEQUENCE tem que cobrir exatamente o resto do buffer.
  if (posicao + comprimento !== der.length) return null

  // 3-5. `r`, depois `s`.
  const r = lerInteiro(der, posicao)
  if (r === null) return null

  const s = lerInteiro(der, r.proxima)
  if (s === null) return null

  // 7. Consumo EXATO: nao pode sobrar byte depois de `s`.
  if (s.proxima !== der.length) return null

  const bruto = new Uint8Array(TAMANHO_DA_ASSINATURA_CRUA)
  bruto.set(r.bytes, 0)
  bruto.set(s.bytes, TAMANHO_DA_COORDENADA)
  return bruto
}

/**
 * Le um INTEGER DER e devolve a coordenada alinhada a direita em 32 bytes.
 *
 * O `0x00` que o DER poe na frente de um inteiro cujo bit mais alto esta ligado
 * some no passo 4; um inteiro curto ganha zeros a esquerda no passo 5. As duas
 * direcoes existem porque as duas acontecem no mundo real, e a segunda so
 * aparece em ~1 de cada 256 assinaturas — o que a torna exatamente o tipo de
 * caminho que um teste sintetico esquece.
 */
function lerInteiro(der: Uint8Array, inicio: number): Leitura | null {
  if (inicio + 2 > der.length) return null
  if (der[inicio] !== INTEGER) return null

  const tamanho = der[inicio + 1] ?? 0
  // Forma longa dentro de um INTEGER de coordenada nao existe: 33 < 0x80.
  if (tamanho === 0 || tamanho >= FORMA_CURTA) return null

  const fim = inicio + 2 + tamanho
  if (fim > der.length) return null

  // 4. Remove os zeros a esquerda.
  let corte = inicio + 2
  while (corte < fim - 1 && der[corte] === 0) corte++

  const significativos = fim - corte
  if (significativos > TAMANHO_DA_COORDENADA) return null

  // 5. Alinha a direita em 32 bytes.
  const bytes = new Uint8Array(TAMANHO_DA_COORDENADA)
  bytes.set(der.subarray(corte, fim), TAMANHO_DA_COORDENADA - significativos)

  return { bytes, proxima: fim }
}
