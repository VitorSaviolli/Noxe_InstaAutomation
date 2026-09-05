/**
 * Chave publica COSE -> JWK, e a importacao no WebCrypto.
 *
 * Dois algoritmos e nada mais (§10.4): **ES256 (-7)** cobre Apple/iCloud,
 * Google/Android e a maioria das chaves de seguranca; **RS256 (-257)** cobre o
 * Windows Hello com TPM, que e o unico caminho RS256 que o dono vai encontrar.
 * Ed25519 (-8) fica de fora por decisao registrada. Qualquer outro `alg` e
 * RECUSADO — nao existe ramo "aceita e torce".
 *
 * A conversao acontece **no registro** e a chave e importada ali mesmo: se ela
 * nao importa, a credencial nunca entra no banco (§10.5, passo 7). O que fica
 * gravado e o JWK em `painel_credenciais.chave_publica_jwk`, e e dele que o
 * login parte — o login nunca decodifica CBOR (§10.5).
 */
import { bytesToBase64Url } from '../../security/base64url'
import { bytesDoMapa, decodificarCbor, inteiroDoMapa, tamanhoDoMapa } from './cbor'

/** ECDSA com P-256 e SHA-256. */
export const ALG_ES256 = -7
/** RSASSA-PKCS1-v1_5 com SHA-256. */
export const ALG_RS256 = -257

/** Os dois, e so os dois (§10.4). */
export const ALGORITMOS_ACEITOS = [ALG_ES256, ALG_RS256] as const

export type AlgoritmoSuportado = (typeof ALGORITMOS_ACEITOS)[number]

/** `kty` COSE: 2 = EC2, 3 = RSA (RFC 8152). */
const KTY_EC2 = 2
const KTY_RSA = 3

/** `crv` COSE: 1 = P-256. */
const CRV_P256 = 1

/** Rotulos COSE. Inteiros, nunca texto — e o que a RFC 8152 manda. */
const ROTULO_KTY = 1
const ROTULO_ALG = 3
const ROTULO_EC_CRV = -1
const ROTULO_EC_X = -2
const ROTULO_EC_Y = -3
const ROTULO_RSA_N = -1
const ROTULO_RSA_E = -2

/** Uma coordenada de P-256 tem exatamente 32 bytes. */
const COORDENADA_EC = 32

/** Piso do modulo RSA: 2048 bits (§10.5, passo 7). */
const MODULO_RSA_MINIMO = 256

/** Um mapa COSE EC2 tem 5 entradas; um RSA tem 4. */
const ENTRADAS_EC2 = 5
const ENTRADAS_RSA = 4

export type MotivoCose =
  | 'cbor_invalido'
  | 'nao_e_mapa'
  | 'kty_ausente'
  | 'alg_nao_suportado'
  | 'curva_nao_suportada'
  | 'coordenada_invalida'
  | 'modulo_invalido'
  | 'expoente_invalido'
  | 'entradas_inesperadas'

export type LeituraDeChaveCose =
  | { readonly ok: true; readonly alg: AlgoritmoSuportado; readonly jwk: JsonWebKey }
  | { readonly ok: false; readonly motivo: MotivoCose }

/**
 * COSE_Key -> JWK.
 *
 * Trava de WA-24: o `alg` e conferido contra a lista de dois, e um `alg` fora
 * dela recusa **antes** de qualquer tentativa de importar a chave. Trocar esta
 * conferencia por um `default` permissivo derruba o teste do `alg` desconhecido.
 */
export function coseParaJwk(cose: Uint8Array): LeituraDeChaveCose {
  const leitura = decodificarCbor(cose)
  if (!leitura.ok) return { ok: false, motivo: 'cbor_invalido' }
  if (leitura.valor.tipo !== 'mapa') return { ok: false, motivo: 'nao_e_mapa' }

  const mapa = leitura.valor
  const kty = inteiroDoMapa(mapa, ROTULO_KTY)
  if (kty === null) return { ok: false, motivo: 'kty_ausente' }

  const alg = inteiroDoMapa(mapa, ROTULO_ALG)
  // Trava de WA-24.
  if (alg !== ALG_ES256 && alg !== ALG_RS256) return { ok: false, motivo: 'alg_nao_suportado' }

  // O par kty/alg tem que ser coerente: um mapa que diz RSA e alega ES256 e
  // anomalia, e anomalia se recusa.
  if (alg === ALG_ES256 && kty === KTY_EC2) return chaveEc2(mapa, alg)
  if (alg === ALG_RS256 && kty === KTY_RSA) return chaveRsa(mapa, alg)
  return { ok: false, motivo: 'alg_nao_suportado' }
}

function chaveEc2(
  mapa: Parameters<typeof inteiroDoMapa>[0],
  alg: typeof ALG_ES256,
): LeituraDeChaveCose {
  // Nenhum rotulo a mais: um mapa COSE com campo extra e conteudo que ninguem
  // examinou, e §10.5 manda recusar em vez de ignorar.
  if (tamanhoDoMapa(mapa) !== ENTRADAS_EC2) return { ok: false, motivo: 'entradas_inesperadas' }

  if (inteiroDoMapa(mapa, ROTULO_EC_CRV) !== CRV_P256) {
    return { ok: false, motivo: 'curva_nao_suportada' }
  }

  const x = bytesDoMapa(mapa, ROTULO_EC_X)
  const y = bytesDoMapa(mapa, ROTULO_EC_Y)
  if (x === null || y === null) return { ok: false, motivo: 'coordenada_invalida' }
  if (x.length !== COORDENADA_EC || y.length !== COORDENADA_EC) {
    return { ok: false, motivo: 'coordenada_invalida' }
  }

  return {
    ok: true,
    alg,
    jwk: { kty: 'EC', crv: 'P-256', x: bytesToBase64Url(x), y: bytesToBase64Url(y) },
  }
}

function chaveRsa(
  mapa: Parameters<typeof inteiroDoMapa>[0],
  alg: typeof ALG_RS256,
): LeituraDeChaveCose {
  if (tamanhoDoMapa(mapa) !== ENTRADAS_RSA) return { ok: false, motivo: 'entradas_inesperadas' }

  const n = bytesDoMapa(mapa, ROTULO_RSA_N)
  if (n === null || n.length < MODULO_RSA_MINIMO) return { ok: false, motivo: 'modulo_invalido' }

  const e = bytesDoMapa(mapa, ROTULO_RSA_E)
  if (e === null || e.length === 0) return { ok: false, motivo: 'expoente_invalido' }

  return {
    ok: true,
    alg,
    jwk: { kty: 'RSA', alg: 'RS256', n: bytesToBase64Url(n), e: bytesToBase64Url(e) },
  }
}

/** Os parametros de `importKey` de cada algoritmo. */
function parametrosDeImportacao(alg: AlgoritmoSuportado): SubtleCryptoImportKeyAlgorithm {
  return alg === ALG_ES256
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
}

/** Os parametros de `verify` de cada algoritmo. */
export function parametrosDeVerificacao(alg: AlgoritmoSuportado): SubtleCryptoSignAlgorithm {
  return alg === ALG_ES256 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
}

/**
 * Importa o JWK para verificacao. Devolve `null` em vez de lancar.
 *
 * O `importKey` lanca para chave malformada, e a chave chega do banco — que
 * gravou o que um autenticador mandou. Uma excecao aqui viraria `500` num login
 * que deveria responder "credencial invalida".
 */
export async function importarChaveDeVerificacao(
  jwk: JsonWebKey,
  alg: AlgoritmoSuportado,
): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey('jwk', jwk, parametrosDeImportacao(alg), false, ['verify'])
  } catch {
    return null
  }
}

/** `alg` desconhecido vindo do banco nao vira `TypeError` mais adiante. */
export function ehAlgoritmoSuportado(alg: number): alg is AlgoritmoSuportado {
  return alg === ALG_ES256 || alg === ALG_RS256
}
