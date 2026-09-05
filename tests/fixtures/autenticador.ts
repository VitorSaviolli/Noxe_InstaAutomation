/**
 * `AutenticadorFalso` — um autenticador WebAuthn de software, escrito no
 * proprio repositorio (§13.3).
 *
 * Ele **produz os mesmos bytes que um autenticador real produziria**, usando o
 * `crypto.subtle` do workerd. E metade do metodo T2: o software gera variacao
 * (dezenas de cerimonias, cada uma com um byte diferente) e os vetores
 * congelados de `vetores-webauthn.ts` provam que a variacao corresponde ao
 * mundo real. Sozinho, este arquivo daria testes SIMETRICOS — o mesmo autor
 * cometeria o mesmo erro dos dois lados e tudo passaria verde.
 *
 * Tres decisoes que sustentam a independencia, e nenhuma e enfeite:
 *
 * 1. **O codificador CBOR daqui e escrito separado do decodificador de
 *    producao** (`src/services/webauthn/cbor.ts`). Nenhuma linha e
 *    compartilhada. Se as duas pontas dividissem codigo, um erro de forma
 *    passaria despercebido nas duas.
 * 2. **O base64url daqui e local**, e nao o de `src/security/base64url.ts`,
 *    pelo mesmo motivo. Uma suite confere que os dois concordam.
 * 3. **A conversao de assinatura vai de CRU para DER** — o inverso do que a
 *    producao faz (§13.3, item 6). O WebCrypto assina ECDSA em `r||s` cru; um
 *    autenticador real devolve ASN.1 DER. Sem este passo, `der.ts` nunca seria
 *    exercitado e a armadilha maior do projeto passaria despercebida.
 *
 * Este arquivo mora em `tests/fixtures/`, que nao casa com o `include` do
 * vitest, entao ele nao vira uma suite vazia.
 */
import type { RespostaDeAssertion, RespostaDeRegistro } from '../../src/services/webauthn/verificar'

// ---------------------------------------------------------------------------
// base64url local (ponto 2 acima)
// ---------------------------------------------------------------------------

export function paraBase64Url(bytes: Uint8Array): string {
  let texto = ''
  for (const byte of bytes) texto += String.fromCharCode(byte)
  return btoa(texto).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function deBase64Url(texto: string): Uint8Array {
  const padrao = texto.replaceAll('-', '+').replaceAll('_', '/')
  const completo = padrao + '='.repeat((4 - (padrao.length % 4)) % 4)
  const binario = atob(completo)
  const bytes = new Uint8Array(binario.length)
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------------------
// Codificador CBOR do teste (ponto 1 acima)
// ---------------------------------------------------------------------------

/** Cabecalho CBOR: tipo maior + argumento, na forma mais curta possivel. */
function cabecalho(maior: number, argumento: number): number[] {
  const topo = maior << 5
  if (argumento < 24) return [topo | argumento]
  if (argumento < 0x100) return [topo | 24, argumento]
  if (argumento < 0x10000) return [topo | 25, argumento >> 8, argumento & 0xff]
  return [
    topo | 26,
    (argumento >>> 24) & 0xff,
    (argumento >>> 16) & 0xff,
    (argumento >>> 8) & 0xff,
    argumento & 0xff,
  ]
}

export type ItemCbor =
  | { readonly cbor: 'inteiro'; readonly valor: number }
  | { readonly cbor: 'bytes'; readonly valor: Uint8Array }
  | { readonly cbor: 'texto'; readonly valor: string }
  | { readonly cbor: 'lista'; readonly itens: readonly ItemCbor[] }
  | { readonly cbor: 'mapa'; readonly pares: readonly (readonly [ItemCbor, ItemCbor])[] }

export const cbInteiro = (valor: number): ItemCbor => ({ cbor: 'inteiro', valor })
export const cbBytes = (valor: Uint8Array): ItemCbor => ({ cbor: 'bytes', valor })
export const cbTexto = (valor: string): ItemCbor => ({ cbor: 'texto', valor })
export const cbLista = (itens: readonly ItemCbor[]): ItemCbor => ({ cbor: 'lista', itens })
export const cbMapa = (pares: readonly (readonly [ItemCbor, ItemCbor])[]): ItemCbor => ({
  cbor: 'mapa',
  pares,
})

/** Serializa um `ItemCbor`. Escrito do zero, sem olhar o decodificador. */
export function codificarCbor(item: ItemCbor): Uint8Array {
  const saida: number[] = []
  escrever(item, saida)
  return Uint8Array.from(saida)
}

function escrever(item: ItemCbor, saida: number[]): void {
  if (item.cbor === 'inteiro') {
    if (item.valor >= 0) saida.push(...cabecalho(0, item.valor))
    else saida.push(...cabecalho(1, -1 - item.valor))
    return
  }
  if (item.cbor === 'bytes') {
    saida.push(...cabecalho(2, item.valor.length), ...item.valor)
    return
  }
  if (item.cbor === 'texto') {
    const bytes = new TextEncoder().encode(item.valor)
    saida.push(...cabecalho(3, bytes.length), ...bytes)
    return
  }
  if (item.cbor === 'lista') {
    saida.push(...cabecalho(4, item.itens.length))
    for (const dentro of item.itens) escrever(dentro, saida)
    return
  }
  saida.push(...cabecalho(5, item.pares.length))
  for (const [chave, valor] of item.pares) {
    escrever(chave, saida)
    escrever(valor, saida)
  }
}

// ---------------------------------------------------------------------------
// Cru -> DER (ponto 3 acima)
// ---------------------------------------------------------------------------

/** Um INTEGER DER: sem zeros a esquerda, com `0x00` quando o bit alto acende. */
function inteiroDer(coordenada: Uint8Array): number[] {
  let inicio = 0
  while (inicio < coordenada.length - 1 && coordenada[inicio] === 0) inicio++
  const corpo = [...coordenada.subarray(inicio)]
  if ((corpo[0] as number) >= 0x80) corpo.unshift(0x00)
  return [0x02, corpo.length, ...corpo]
}

/**
 * `r||s` cru -> `SEQUENCE { INTEGER r, INTEGER s }`.
 *
 * **E este passo que faz o teste exercitar `der.ts`.** Sem ele, o teste mandaria
 * ao verificador os mesmos 64 bytes que o WebCrypto espera, e o caminho que um
 * autenticador de verdade obriga a percorrer nunca seria tocado.
 */
export function cruParaDer(bruto: Uint8Array): Uint8Array {
  const r = inteiroDer(bruto.subarray(0, 32))
  const s = inteiroDer(bruto.subarray(32, 64))
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s])
}

// ---------------------------------------------------------------------------
// A cerimonia, e os helpers puros de mutacao
// ---------------------------------------------------------------------------

/**
 * Tudo o que muda de uma cerimonia para a outra.
 *
 * Os helpers abaixo alteram **exatamente uma coisa** cada um, e o autenticador
 * RE-ASSINA sobre o resultado. Isso e de proposito e e o que torna o teste
 * negativo honesto: se o teste mudasse o `origin` DEPOIS da assinatura, a
 * recusa poderia vir da assinatura quebrada e nao da conferencia de origem, e
 * o teste passaria com a trava de origem apagada.
 */
export interface Cerimonia {
  readonly rpId: string
  readonly origem: string
  readonly desafio: string
  readonly tipo: string
  readonly up: boolean
  readonly uv: boolean
  readonly be: boolean
  readonly bs: boolean
  readonly signCount: number
  /** Flag `ED`: o autenticador anexou extensoes ao `authData`. */
  readonly ed: boolean
  readonly crossOrigin: boolean | undefined
  /** Campos extras dentro do `clientDataJSON`, como um navegador real poe. */
  readonly extras: Readonly<Record<string, unknown>>
}

const PADRAO: Omit<Cerimonia, 'rpId' | 'origem' | 'desafio' | 'tipo'> = {
  up: true,
  uv: true,
  be: false,
  bs: false,
  signCount: 0,
  ed: false,
  crossOrigin: undefined,
  extras: {},
}

export function cerimonia(base: {
  rpId: string
  origem: string
  desafio: string
  tipo: string
}): Cerimonia {
  return { ...PADRAO, ...base }
}

export const comOrigin = (c: Cerimonia, origem: string): Cerimonia => ({ ...c, origem })
export const comTipo = (c: Cerimonia, tipo: string): Cerimonia => ({ ...c, tipo })
export const comRpId = (c: Cerimonia, rpId: string): Cerimonia => ({ ...c, rpId })
export const semUv = (c: Cerimonia): Cerimonia => ({ ...c, uv: false })
export const semUp = (c: Cerimonia): Cerimonia => ({ ...c, up: false })
/** Liga a flag `ED` e anexa um bloco de extensao ao fim do `authData`. */
export const comExtensao = (c: Cerimonia): Cerimonia => ({ ...c, ed: true })
export const comBackup = (c: Cerimonia): Cerimonia => ({ ...c, be: true, bs: true })
export const comSignCount = (c: Cerimonia, signCount: number): Cerimonia => ({ ...c, signCount })
export const comDesafio = (c: Cerimonia, desafio: string): Cerimonia => ({ ...c, desafio })

/**
 * Vira UM bit de UM byte dentro de um campo base64url.
 *
 * Usado no teste do byte alterado: e a unica mutacao que acontece DEPOIS da
 * assinatura, porque a afirmacao ali e justamente sobre a assinatura.
 */
export function trocarByte(campo: string, indice: number): string {
  const bytes = deBase64Url(campo)
  const copia = new Uint8Array(bytes)
  copia[indice] = ((copia[indice] ?? 0) ^ 0x01) & 0xff
  return paraBase64Url(copia)
}

// ---------------------------------------------------------------------------
// O autenticador
// ---------------------------------------------------------------------------

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40
const FLAG_ED = 0x80

export type AlgoritmoDoFalso = 'ES256' | 'RS256'

/** Rotulos COSE, escritos aqui de novo — nada vem de `src/`. */
const COSE_KTY = 1
const COSE_ALG = 3
const COSE_CRV = -1
const COSE_X = -2
const COSE_Y = -3
const COSE_N = -1
const COSE_E = -2

export interface OpcoesDoFalso {
  /** `alg` gravado no mapa COSE. Diferente do real so nos testes negativos. */
  readonly algDeclarado?: number
  /** `fmt` do `attestationObject`. Diferente de `none` so nos testes negativos. */
  readonly fmt?: string
  /**
   * Substitui a chave COSE inteira por estes bytes.
   *
   * Existe para o teste da chave que o `importKey` recusa: um ponto EC com o
   * tamanho certo mas FORA da curva P-256 passa por `cose.ts` e so morre na
   * importacao. Nenhum autenticador honesto produz isso; um hostil, sim.
   */
  readonly coseSubstituto?: Uint8Array
  /** Substitui o `id` do corpo, mantendo o `credentialId` dentro do authData. */
  readonly idDoCorpo?: string
  /**
   * `attStmt` com conteudo, em vez do mapa vazio que `attestation: "none"` exige.
   *
   * §10.5 manda RECUSAR, nao "aceitar e ignorar": um `attStmt` cheio num `fmt`
   * que nao tem statement e conteudo que ninguem examinou.
   */
  readonly attStmtComConteudo?: boolean
  /**
   * Tamanho do `credentialId`, em bytes. O padrao sao 32.
   *
   * Existe para o teste do teto de 1023 de §10.5: um `credentialId` acima
   * disso e o unico jeito de exercitar a conferencia do `credentialIdLength`
   * sem cair antes no "campo truncado".
   */
  readonly tamanhoDoCredentialId?: number
}

export class AutenticadorFalso {
  private constructor(
    readonly algoritmo: AlgoritmoDoFalso,
    readonly credentialId: string,
    private readonly credentialIdBytes: Uint8Array,
    private readonly par: CryptoKeyPair,
    readonly jwkPublico: JsonWebKey,
  ) {}

  /**
   * Cria um autenticador com par de chaves novo (§13.3, item 1).
   *
   * ES256 = `ECDSA/P-256`; RS256 = `RSASSA-PKCS1-v1_5` de 2048 bits com
   * expoente `[1,0,1]`, exatamente o que um TPM de Windows Hello devolve.
   */
  static async criar(algoritmo: AlgoritmoDoFalso = 'ES256'): Promise<AutenticadorFalso> {
    const parametros: SubtleCryptoGenerateKeyAlgorithm =
      algoritmo === 'ES256'
        ? { name: 'ECDSA', namedCurve: 'P-256' }
        : {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
          }

    const par = (await crypto.subtle.generateKey(parametros, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', par.publicKey)) as JsonWebKey
    const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32))

    return new AutenticadorFalso(
      algoritmo,
      paraBase64Url(credentialIdBytes),
      credentialIdBytes,
      par,
      jwk,
    )
  }

  /** O `alg` COSE deste autenticador. */
  get algCose(): number {
    return this.algoritmo === 'ES256' ? -7 : -257
  }

  /** A chave publica em JWK, como `painel_credenciais` guardaria. */
  get jwkParaOBanco(): JsonWebKey {
    if (this.algoritmo === 'ES256') {
      return { kty: 'EC', crv: 'P-256', x: this.jwkPublico.x, y: this.jwkPublico.y }
    }
    return { kty: 'RSA', alg: 'RS256', n: this.jwkPublico.n, e: this.jwkPublico.e }
  }

  /** Chave publica COSE (§13.3, item 2). */
  chavePublicaCose(opcoes: OpcoesDoFalso = {}): Uint8Array {
    if (opcoes.coseSubstituto !== undefined) return opcoes.coseSubstituto
    const alg = opcoes.algDeclarado ?? this.algCose

    if (this.algoritmo === 'ES256') {
      return codificarCbor(
        cbMapa([
          [cbInteiro(COSE_KTY), cbInteiro(2)],
          [cbInteiro(COSE_ALG), cbInteiro(alg)],
          [cbInteiro(COSE_CRV), cbInteiro(1)],
          [cbInteiro(COSE_X), cbBytes(deBase64Url(this.jwkPublico.x ?? ''))],
          [cbInteiro(COSE_Y), cbBytes(deBase64Url(this.jwkPublico.y ?? ''))],
        ]),
      )
    }

    return codificarCbor(
      cbMapa([
        [cbInteiro(COSE_KTY), cbInteiro(3)],
        [cbInteiro(COSE_ALG), cbInteiro(alg)],
        [cbInteiro(COSE_N), cbBytes(deBase64Url(this.jwkPublico.n ?? ''))],
        [cbInteiro(COSE_E), cbBytes(deBase64Url(this.jwkPublico.e ?? ''))],
      ]),
    )
  }

  /**
   * `clientDataJSON` serializado como TEXTO e convertido para bytes (§13.3,
   * item 4). E assim que o navegador faz, e e por isso que a assinatura cobre o
   * hash desses bytes e nao um JSON reserializado pelo servidor.
   */
  clientData(c: Cerimonia): Uint8Array {
    const objeto: Record<string, unknown> = {
      type: c.tipo,
      challenge: c.desafio,
      origin: c.origem,
      ...c.extras,
    }
    if (c.crossOrigin !== undefined) objeto.crossOrigin = c.crossOrigin
    return new TextEncoder().encode(JSON.stringify(objeto))
  }

  /**
   * `authData` (§13.3, item 3).
   *
   * `SHA-256(rpId)` (32) `|| flags` (1) `|| signCount` big-endian (4) e, so no
   * registro, `aaguid` de 16 zeros `|| credIdLen` (2) `|| credentialId ||
   * cosePublicKey`.
   */
  async authData(
    c: Cerimonia,
    comCredencial: boolean,
    opcoes: OpcoesDoFalso = {},
  ): Promise<Uint8Array> {
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c.rpId)),
    )

    let flags = 0
    if (c.up) flags |= FLAG_UP
    if (c.uv) flags |= FLAG_UV
    if (c.be) flags |= FLAG_BE
    if (c.bs) flags |= FLAG_BS
    if (comCredencial) flags |= FLAG_AT
    if (c.ed) flags |= FLAG_ED

    const cabeca = [
      ...rpIdHash,
      flags,
      (c.signCount >>> 24) & 0xff,
      (c.signCount >>> 16) & 0xff,
      (c.signCount >>> 8) & 0xff,
      c.signCount & 0xff,
    ]

    // O bloco de extensao vai DEPOIS de tudo, exatamente como a WebAuthn manda.
    const extensao = c.ed ? [...codificarCbor(cbMapa([[cbTexto('x'), cbInteiro(1)]]))] : []

    if (!comCredencial) return Uint8Array.from([...cabeca, ...extensao])

    const cose = this.chavePublicaCose(opcoes)
    const idBytes =
      opcoes.tamanhoDoCredentialId === undefined
        ? this.credentialIdBytes
        : crypto.getRandomValues(new Uint8Array(opcoes.tamanhoDoCredentialId))

    return Uint8Array.from([
      ...cabeca,
      ...new Uint8Array(16), // aaguid de zeros: attestation "none"
      (idBytes.length >> 8) & 0xff,
      idBytes.length & 0xff,
      ...idBytes,
      ...cose,
      ...extensao,
    ])
  }

  /** Registro: `attestationObject` = CBOR de `{fmt, attStmt:{}, authData}`. */
  async registrar(c: Cerimonia, opcoes: OpcoesDoFalso = {}): Promise<RespostaDeRegistro> {
    const clientDataJSON = this.clientData(c)
    const authData = await this.authData(c, true, opcoes)

    const attStmt =
      opcoes.attStmtComConteudo === true
        ? cbMapa([[cbTexto('sig'), cbBytes(new Uint8Array([1, 2, 3]))]])
        : cbMapa([])

    const attestationObject = codificarCbor(
      cbMapa([
        [cbTexto('fmt'), cbTexto(opcoes.fmt ?? 'none')],
        [cbTexto('attStmt'), attStmt],
        [cbTexto('authData'), cbBytes(authData)],
      ]),
    )

    return {
      id: opcoes.idDoCorpo ?? this.credentialId,
      type: 'public-key',
      clientDataJSON: paraBase64Url(clientDataJSON),
      attestationObject: paraBase64Url(attestationObject),
    }
  }

  /**
   * Login e step-up. Assina `authData || SHA-256(clientDataJSON)` (§13.3, item
   * 5) e converte a assinatura ES256 de cru para DER (item 6).
   */
  async autenticar(
    c: Cerimonia,
    usuarioHandle: string | null = null,
  ): Promise<RespostaDeAssertion> {
    const clientDataJSON = this.clientData(c)
    const authData = await this.authData(c, false)
    const bruto = await this.assinar(await this.oQueSeAssina(authData, clientDataJSON))

    return this.montar(clientDataJSON, authData, this.emFormatoDeAutenticador(bruto), usuarioHandle)
  }

  /**
   * Assina em laco ate o `r` sair com o bit mais alto ligado (~50%).
   *
   * O DER desse `r` ganha um `0x00` na frente e passa a ter **33 bytes** — o
   * caminho de WA-15. O irmao dele, o `r` de 31 bytes, precisaria de ~1500
   * voltas (~1/256) e por isso vem dos vetores congelados, nunca do laco.
   */
  async autenticarComRAlto(
    c: Cerimonia,
    usuarioHandle: string | null = null,
  ): Promise<RespostaDeAssertion> {
    if (this.algoritmo !== 'ES256') throw new Error('r alto so faz sentido em ES256')

    const clientDataJSON = this.clientData(c)
    const authData = await this.authData(c, false)
    const assinado = await this.oQueSeAssina(authData, clientDataJSON)

    for (let volta = 0; volta < 200; volta++) {
      const bruto = await this.assinar(assinado)
      if ((bruto[0] as number) >= 0x80) {
        return this.montar(clientDataJSON, authData, cruParaDer(bruto), usuarioHandle)
      }
    }
    throw new Error('200 voltas sem um r alto — algo esta errado no sorteio')
  }

  /**
   * Assina sobre o `clientDataJSON` em vez de `authData || SHA-256(...)`.
   *
   * Existe so para o teste negativo do passo 8 de §10.7: e o bug classico, e um
   * verificador que o cometesse aceitaria esta resposta.
   */
  async autenticarAssinandoOJson(
    c: Cerimonia,
    usuarioHandle: string | null = null,
  ): Promise<RespostaDeAssertion> {
    const clientDataJSON = this.clientData(c)
    const authData = await this.authData(c, false)
    const bruto = await this.assinar(clientDataJSON)
    return this.montar(clientDataJSON, authData, this.emFormatoDeAutenticador(bruto), usuarioHandle)
  }

  /** Devolve a assinatura ES256 CRUA, sem passar por DER. Teste negativo. */
  async autenticarComAssinaturaCrua(
    c: Cerimonia,
    usuarioHandle: string | null = null,
  ): Promise<RespostaDeAssertion> {
    if (this.algoritmo !== 'ES256') throw new Error('assinatura crua so existe em ES256')

    const clientDataJSON = this.clientData(c)
    const authData = await this.authData(c, false)
    const bruto = await this.assinar(await this.oQueSeAssina(authData, clientDataJSON))
    return this.montar(clientDataJSON, authData, bruto, usuarioHandle)
  }

  private montar(
    clientDataJSON: Uint8Array,
    authData: Uint8Array,
    assinatura: Uint8Array,
    usuarioHandle: string | null,
  ): RespostaDeAssertion {
    return {
      id: this.credentialId,
      type: 'public-key',
      clientDataJSON: paraBase64Url(clientDataJSON),
      authenticatorData: paraBase64Url(authData),
      signature: paraBase64Url(assinatura),
      userHandle: usuarioHandle,
    }
  }

  /** `authData || SHA-256(clientDataJSON)`, os bytes crus concatenados. */
  private async oQueSeAssina(authData: Uint8Array, clientData: Uint8Array): Promise<Uint8Array> {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))
    const junto = new Uint8Array(authData.length + hash.length)
    junto.set(authData, 0)
    junto.set(hash, authData.length)
    return junto
  }

  private async assinar(dados: Uint8Array): Promise<Uint8Array> {
    const parametros: SubtleCryptoSignAlgorithm =
      this.algoritmo === 'ES256'
        ? { name: 'ECDSA', hash: 'SHA-256' }
        : { name: 'RSASSA-PKCS1-v1_5' }
    return new Uint8Array(await crypto.subtle.sign(parametros, this.par.privateKey, dados))
  }

  /** ES256 sai em DER; RS256 ja sai bruta, e assim vai para a rede. */
  private emFormatoDeAutenticador(bruto: Uint8Array): Uint8Array {
    return this.algoritmo === 'ES256' ? cruParaDer(bruto) : bruto
  }
}
