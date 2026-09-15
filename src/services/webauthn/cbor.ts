/**
 * Decodificador CBOR minimo (RFC 8949), so o que o WebAuthn exige.
 *
 * Escrito a mao porque o projeto nao ganha dependencia nova. O subconjunto e o
 * de §10.5: inteiros, byte strings, text strings, arrays e mapas. Nada de
 * float, nada de tag, nada de `true`/`false`/`null`, o que nao esta aqui e
 * RECUSADO, nunca "aceito e ignorado".
 *
 * **Este decodificador so roda no REGISTRO** (§10.5). O login nao toca CBOR: a
 * chave publica ja foi convertida para JWK e guardada em
 * `painel_credenciais.chave_publica_jwk`. E o que mantem o caminho quente longe
 * dos 10 ms de CPU do parser.
 *
 * Requisitos de seguranca, todos de §10.5 e todos com teste:
 *
 * 1. **Comprimento indefinido recusado.** E o `0x1f` de RFC 8949 §3.2.2: um
 *    fluxo que so termina num marcador permite que o mesmo conteudo tenha duas
 *    grafias, e grafia dupla e por onde entra confusao de forma canonica.
 * 2. **Profundidade maxima 4.** Sem teto, um mapa dentro de mapa dentro de mapa
 *    e recursao controlada por quem envia o corpo.
 * 3. **Byte string maxima 2 KB.** O `attestationObject` inteiro cabe em ~1-2 KB
 *    com `attestation: "none"`.
 * 4. **Consumo EXATO.** Sobrar byte depois do valor de topo e recusa: e o que
 *    impede anexar conteudo depois de um `attestationObject` valido.
 * 5. **Nunca lanca.** Devolve uniao discriminada, no formato que `webhook.ts` ja
 *    usa. A entrada vem do corpo de uma requisicao, isto e, de qualquer pessoa
 *    na internet, uma excecao aqui viraria `500` numa rota que deveria
 *    responder "credencial invalida".
 * 6. **Argumento na forma mais curta.** RFC 8949 §4.2.1: o valor 5 se escreve
 *    `05`, nunca `18 05`. E o item 1 outra vez, grafia dupla e por onde entra
 *    confusao de forma canonica, so que aplicado ao argumento.
 *
 * O codificador CBOR do teste (`tests/fixtures/autenticador.ts`) e escrito
 * SEPARADO deste arquivo, de proposito: as duas pontas do metodo T2 (§13.3) so
 * sao independentes se nao compartilharem uma linha de codigo.
 */

/** Profundidade maxima de aninhamento (§10.5). */
export const PROFUNDIDADE_MAXIMA = 4

/** Byte string e text string maximas, em bytes (§10.5). */
export const BYTES_MAXIMOS = 2048

/** Os cinco tipos maiores que este subconjunto conhece (RFC 8949 §3.1). */
const MAIOR_INTEIRO_POSITIVO = 0
const MAIOR_INTEIRO_NEGATIVO = 1
const MAIOR_BYTES = 2
const MAIOR_TEXTO = 3
const MAIOR_LISTA = 4
const MAIOR_MAPA = 5

/** `0x1f` no campo de informacao adicional: comprimento indefinido. */
const INFO_INDEFINIDO = 31

/** Informacao adicional que anuncia o argumento em 1, 2 e 4 bytes seguintes. */
const INFO_1_BYTE = 24
const INFO_2_BYTES = 25
const INFO_4_BYTES = 26

const decodificadorUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export type ValorCbor =
  | { readonly tipo: 'inteiro'; readonly numero: number }
  | { readonly tipo: 'bytes'; readonly bytes: Uint8Array }
  | { readonly tipo: 'texto'; readonly texto: string }
  | { readonly tipo: 'lista'; readonly itens: readonly ValorCbor[] }
  | { readonly tipo: 'mapa'; readonly entradas: readonly EntradaDeMapa[] }

export interface EntradaDeMapa {
  readonly chave: ValorCbor
  readonly valor: ValorCbor
}

/**
 * Por que a recusa aconteceu.
 *
 * Serve ao `console.warn` do servidor, NUNCA ao corpo da resposta: ao cliente
 * vai sempre `credencial_invalida` (§11.4).
 */
export type MotivoCbor =
  | 'truncado'
  | 'sobra'
  | 'comprimento_indefinido'
  | 'tipo_nao_suportado'
  | 'profundidade'
  | 'bytes_grandes_demais'
  | 'inteiro_grande_demais'
  | 'texto_invalido'
  | 'chave_repetida'
  | 'forma_nao_canonica'

export type LeituraCbor =
  | { readonly ok: true; readonly valor: ValorCbor }
  | { readonly ok: false; readonly motivo: MotivoCbor }

/** Cursor mutavel sobre os bytes. Local ao modulo: nada dele escapa. */
interface Cursor {
  readonly dados: Uint8Array
  posicao: number
}

type PassoCbor = LeituraCbor

type Cabecalho =
  | { readonly ok: true; readonly maior: number; readonly argumento: number }
  | { readonly ok: false; readonly motivo: MotivoCbor }

/**
 * Decodifica UM valor CBOR e exige que ele consuma todos os bytes.
 *
 * Trava de WA-23: a recusa de `sobra` e o que impede anexar bytes depois de um
 * `attestationObject` que, sozinho, seria valido.
 */
export function decodificarCbor(dados: Uint8Array): LeituraCbor {
  const cursor: Cursor = { dados, posicao: 0 }
  const passo = lerValor(cursor, 1)
  if (!passo.ok) return passo
  if (cursor.posicao !== dados.length) return { ok: false, motivo: 'sobra' }
  return passo
}

/**
 * O menor valor que cada largura de argumento tem direito de carregar.
 *
 * Abaixo disto o emissor escolheu uma forma mais longa do que precisava: `18`
 * carrega 1 byte e so vale de 24 para cima (de 0 a 23 o valor mora no proprio
 * primeiro byte); `19` carrega 2 e so vale de 256; `1a` carrega 4 e so vale de
 * 65536.
 */
function menorArgumentoDe(info: number): number {
  if (info === INFO_1_BYTE) return 24
  if (info === INFO_2_BYTES) return 256
  return 65536
}

/**
 * Le o cabecalho de um item: o tipo maior e o argumento.
 *
 * O `27` (argumento de 8 bytes) e recusado em vez de lido: um inteiro acima de
 * `Number.MAX_SAFE_INTEGER` perderia precisao ao virar `number`, e nada do
 * WebAuthn precisa dele. Os `28`, `29` e `30` sao reservados pela RFC.
 *
 * A forma tem que ser a MAIS CURTA possivel (RFC 8949 §4.2.1): o valor 5 se
 * escreve `05`, nunca `18 05`. E o mesmo principio do item 1 do cabecalho deste
 * arquivo, grafia dupla e por onde entra confusao de forma canonica, aplicado
 * ao argumento em vez do comprimento. Hoje nenhum ponto do painel trata os
 * bytes crus do CBOR como identidade a ser comparada ou hasheada, entao isto e
 * defesa em profundidade: fecha a porta antes de existir um caminho que passe
 * por ela.
 */
function lerCabecalho(cursor: Cursor): Cabecalho {
  if (cursor.posicao >= cursor.dados.length) return { ok: false, motivo: 'truncado' }

  const primeiro = cursor.dados[cursor.posicao] ?? 0
  cursor.posicao++

  const maior = primeiro >> 5
  const info = primeiro & 0x1f

  if (info < INFO_1_BYTE) return { ok: true, maior, argumento: info }
  // Trava de WA-23: comprimento indefinido nao entra, nunca.
  if (info === INFO_INDEFINIDO) return { ok: false, motivo: 'comprimento_indefinido' }
  if (info > INFO_4_BYTES) return { ok: false, motivo: 'inteiro_grande_demais' }

  const octetos = info === INFO_1_BYTE ? 1 : info === INFO_2_BYTES ? 2 : 4
  if (cursor.posicao + octetos > cursor.dados.length) return { ok: false, motivo: 'truncado' }

  let argumento = 0
  for (let i = 0; i < octetos; i++) {
    argumento = argumento * 256 + (cursor.dados[cursor.posicao + i] ?? 0)
  }
  cursor.posicao += octetos

  // Cabia numa forma mais curta? Entao esta nao e a canonica.
  if (argumento < menorArgumentoDe(info)) return { ok: false, motivo: 'forma_nao_canonica' }

  return { ok: true, maior, argumento }
}

function lerValor(cursor: Cursor, profundidade: number): PassoCbor {
  if (profundidade > PROFUNDIDADE_MAXIMA) return { ok: false, motivo: 'profundidade' }

  const cabecalho = lerCabecalho(cursor)
  if (!cabecalho.ok) return cabecalho

  const { maior, argumento } = cabecalho

  if (maior === MAIOR_INTEIRO_POSITIVO)
    return { ok: true, valor: { tipo: 'inteiro', numero: argumento } }
  if (maior === MAIOR_INTEIRO_NEGATIVO) {
    return { ok: true, valor: { tipo: 'inteiro', numero: -1 - argumento } }
  }
  if (maior === MAIOR_BYTES || maior === MAIOR_TEXTO) {
    return lerCadeia(cursor, maior, argumento)
  }
  if (maior === MAIOR_LISTA) return lerLista(cursor, argumento, profundidade)
  if (maior === MAIOR_MAPA) return lerMapa(cursor, argumento, profundidade)

  // Tag (6) e simples/float (7). O que nao esta no subconjunto e RECUSADO.
  return { ok: false, motivo: 'tipo_nao_suportado' }
}

function lerCadeia(cursor: Cursor, maior: number, tamanho: number): PassoCbor {
  if (tamanho > BYTES_MAXIMOS) return { ok: false, motivo: 'bytes_grandes_demais' }
  if (cursor.posicao + tamanho > cursor.dados.length) return { ok: false, motivo: 'truncado' }

  const fatia = cursor.dados.slice(cursor.posicao, cursor.posicao + tamanho)
  cursor.posicao += tamanho

  if (maior === MAIOR_BYTES) return { ok: true, valor: { tipo: 'bytes', bytes: fatia } }

  // `fatal: true` lanca em UTF-8 invalido; o `catch` e o que mantem a promessa
  // de que este modulo nunca lanca para fora.
  try {
    return { ok: true, valor: { tipo: 'texto', texto: decodificadorUtf8.decode(fatia) } }
  } catch {
    return { ok: false, motivo: 'texto_invalido' }
  }
}

function lerLista(cursor: Cursor, quantidade: number, profundidade: number): PassoCbor {
  const itens: ValorCbor[] = []
  for (let i = 0; i < quantidade; i++) {
    const item = lerValor(cursor, profundidade + 1)
    if (!item.ok) return item
    itens.push(item.valor)
  }
  return { ok: true, valor: { tipo: 'lista', itens } }
}

/**
 * Mapa, com recusa de chave repetida.
 *
 * Chave repetida nao e curiosidade academica: um mapa COSE com dois `3` (o
 * `alg`) deixaria a decisao de qual vale a cargo de quem le. Duas leituras
 * possiveis do mesmo conteudo e o mesmo defeito que a base64 nao canonica tem.
 */
function lerMapa(cursor: Cursor, quantidade: number, profundidade: number): PassoCbor {
  const entradas: EntradaDeMapa[] = []
  const vistas = new Set<string>()

  for (let i = 0; i < quantidade; i++) {
    const chave = lerValor(cursor, profundidade + 1)
    if (!chave.ok) return chave

    const impressao = impressaoDeChave(chave.valor)
    if (impressao === null) return { ok: false, motivo: 'tipo_nao_suportado' }
    if (vistas.has(impressao)) return { ok: false, motivo: 'chave_repetida' }
    vistas.add(impressao)

    const valor = lerValor(cursor, profundidade + 1)
    if (!valor.ok) return valor

    entradas.push({ chave: chave.valor, valor: valor.valor })
  }

  return { ok: true, valor: { tipo: 'mapa', entradas } }
}

/** Chave de mapa so pode ser inteiro (COSE) ou texto (attestationObject). */
function impressaoDeChave(chave: ValorCbor): string | null {
  if (chave.tipo === 'inteiro') return `i:${chave.numero}`
  if (chave.tipo === 'texto') return `t:${chave.texto}`
  return null
}

// ---------------------------------------------------------------------------
// Leitura tipada de mapa, a unica porta para quem consome
// ---------------------------------------------------------------------------

/** O valor de `chave` no mapa, ou `null` se nao for mapa ou a chave faltar. */
export function doMapa(valor: ValorCbor, chave: number | string): ValorCbor | null {
  if (valor.tipo !== 'mapa') return null
  const procurada = typeof chave === 'number' ? `i:${chave}` : `t:${chave}`
  for (const entrada of valor.entradas) {
    if (impressaoDeChave(entrada.chave) === procurada) return entrada.valor
  }
  return null
}

export function inteiroDoMapa(valor: ValorCbor, chave: number | string): number | null {
  const achado = doMapa(valor, chave)
  return achado !== null && achado.tipo === 'inteiro' ? achado.numero : null
}

export function bytesDoMapa(valor: ValorCbor, chave: number | string): Uint8Array | null {
  const achado = doMapa(valor, chave)
  return achado !== null && achado.tipo === 'bytes' ? achado.bytes : null
}

export function textoDoMapa(valor: ValorCbor, chave: number | string): string | null {
  const achado = doMapa(valor, chave)
  return achado !== null && achado.tipo === 'texto' ? achado.texto : null
}

/** Quantas entradas o mapa tem. `null` quando o valor nao e mapa. */
export function tamanhoDoMapa(valor: ValorCbor): number | null {
  return valor.tipo === 'mapa' ? valor.entradas.length : null
}
