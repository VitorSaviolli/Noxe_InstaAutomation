/**
 * Verificacao WebAuthn: attestation (registro) e assertion (login e step-up).
 *
 * Modulo **puro**: nao conhece rota, nao conhece cookie, nao toca no D1 e nao
 * le o relogio. Tudo o que ele precisa chega por parametro — inclusive o
 * desafio, que vem do envelope assinado de `panel-session.ts` e **nunca** do
 * corpo da requisicao (§10.5 passo 4, §10.7 passo 6).
 *
 * As duas funcoes de topo sao `verificarRegistro` e `verificarAssertion`. A
 * segunda serve ao login **e** ao step-up: e o mesmo autenticador, a mesma
 * assinatura e a mesma exigencia de `UV = 1` (§7.8). O que muda entre os dois e
 * o proposito do envelope de onde o desafio saiu, e isso e escolhido por quem
 * chama — o que mantem a trava de `UV` num ponto unico do codigo.
 *
 * **Ao cliente vai sempre `credencial_invalida`** (§11.4). O `motivo` que estas
 * funcoes devolvem existe para o `console.warn` do servidor e para a tela poder
 * dizer "endereco antigo" — nunca para o corpo da resposta.
 */
import { bytesToBase64Url, decodeBase64Url } from '../../security/base64url'
import { timingSafeEqual } from '../../security/constant-time'
import { decodificarCbor, doMapa, tamanhoDoMapa, textoDoMapa } from './cbor'
import {
  ALG_ES256,
  type AlgoritmoSuportado,
  coseParaJwk,
  ehAlgoritmoSuportado,
  importarChaveDeVerificacao,
  parametrosDeVerificacao,
} from './cose'
import { derParaBruto } from './der'

const decodificador = new TextDecoder()
const codificador = new TextEncoder()

// ---------------------------------------------------------------------------
// `authData`: o formato binario cru
// ---------------------------------------------------------------------------

/** `rpIdHash` (32) + flags (1) + signCount (4). */
const TAMANHO_MINIMO_DO_AUTHDATA = 37
const TAMANHO_DO_RPIDHASH = 32
const POSICAO_DAS_FLAGS = 32
const POSICAO_DO_SIGNCOUNT = 33
const TAMANHO_DO_AAGUID = 16
/** `aaguid` (16) + `credentialIdLength` (2). */
const CABECALHO_DA_CREDENCIAL = 18

/** Teto do `credentialIdLength` (§10.5, passo 6). */
const CREDENTIAL_ID_MAXIMO = 1023

/** As flags de §10.5, passo 6. */
const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40
const FLAG_ED = 0x80

/** Quantos caracteres hexadecimais do `sha256(credential_id)` vao para o log. */
const PREFIXO_DE_CREDENCIAL = 8

/**
 * Chave publica descartavel, para quando o `credentialId` nao existe.
 *
 * E o ponto base G da curva P-256 (FIPS 186-4, D.1.2.3) — constante publica,
 * sem segredo nenhum. Serve para que uma credencial desconhecida percorra o
 * MESMO trabalho de uma assinatura invalida, em vez de responder antes e virar
 * um oraculo grosseiro de enumeracao (§11.4). E mitigacao parcial, e esta
 * escrita como parcial.
 *
 * Trava de WA-19.
 */
const CHAVE_DESCARTAVEL: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
  y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
}

// ---------------------------------------------------------------------------
// O contrato
// ---------------------------------------------------------------------------

/** O que o navegador manda no registro, ja em base64url. */
export interface RespostaDeRegistro {
  readonly id: string
  readonly type: string
  readonly clientDataJSON: string
  readonly attestationObject: string
}

/** O que o navegador manda no login e no step-up, ja em base64url. */
export interface RespostaDeAssertion {
  readonly id: string
  readonly type: string
  readonly clientDataJSON: string
  readonly authenticatorData: string
  readonly signature: string
  readonly userHandle: string | null
}

/** A linha de `painel_credenciais` que o login carrega. */
export interface CredencialGuardada {
  readonly credentialId: string
  readonly rpId: string
  readonly usuarioHandle: string
  readonly jwk: JsonWebKey
  readonly algoritmo: number
  readonly signCount: number
}

/** O que o registro produz, pronto para virar linha de `painel_credenciais`. */
export interface CredencialRegistrada {
  readonly credentialId: string
  readonly jwk: JsonWebKey
  readonly algoritmo: AlgoritmoSuportado
  readonly signCount: number
  readonly backupElegivel: boolean
  readonly backupAtivo: boolean
}

/** O que o login produz, pronto para virar `UPDATE painel_credenciais`. */
export interface AssertionVerificada {
  readonly credentialId: string
  readonly signCount: number
  readonly backupElegivel: boolean
  readonly backupAtivo: boolean
  /** `signCount` que nao avancou. Avisa, **nunca** recusa (§10.7, passo 11). */
  readonly signCountRegrediu: boolean
}

/**
 * Por que a verificacao recusou.
 *
 * Vai para o `console.warn`, nunca para o corpo. `credencial_desconhecida` NAO
 * existe nesta lista de proposito: uma credencial que o banco nao conhece
 * responde `assinatura_invalida`, exatamente como uma assinatura errada
 * (§11.4). Um codigo proprio para ela seria o oraculo de enumeracao que a
 * tabela de erros existe para fechar.
 */
export type MotivoWebauthn =
  | 'tipo_de_credencial'
  | 'campo_ausente'
  | 'base64url_invalido'
  | 'client_data_invalido'
  | 'tipo_de_cerimonia'
  | 'desafio_diferente'
  | 'origem_desconhecida'
  | 'cross_origin'
  | 'attestation_invalida'
  | 'formato_de_attestation'
  | 'authdata_invalido'
  | 'rp_id_hash_diferente'
  | 'presenca_ausente'
  | 'verificacao_de_usuario_ausente'
  | 'sem_credencial_anexada'
  | 'chave_publica_invalida'
  | 'chave_nao_importa'
  | 'credencial_de_endereco_antigo'
  | 'dono_diferente'
  | 'assinatura_malformada'
  | 'assinatura_invalida'

export type ResultadoDeRegistro =
  | { readonly ok: true; readonly credencial: CredencialRegistrada }
  | { readonly ok: false; readonly motivo: MotivoWebauthn }

export type ResultadoDeAssertion =
  | { readonly ok: true; readonly assertion: AssertionVerificada }
  | { readonly ok: false; readonly motivo: MotivoWebauthn }

export interface EntradaDeRegistro {
  readonly resposta: RespostaDeRegistro
  readonly rpId: string
  /** Sempre `origemDoPainel(env)`. Comparada por string INTEIRA. */
  readonly origem: string
  /** O desafio do envelope de proposito `registrar`. Nunca vem do corpo. */
  readonly desafioEsperado: string
}

export interface EntradaDeAssertion {
  readonly resposta: RespostaDeAssertion
  readonly rpId: string
  readonly origem: string
  /** O desafio do envelope de proposito `entrar` ou `stepup`. Nunca vem do corpo. */
  readonly desafioEsperado: string
  /** A linha do banco, ou `null` quando o `credentialId` nao existe. */
  readonly credencial: CredencialGuardada | null
  /** `painel_estado.usuario_handle`. */
  readonly usuarioHandleEsperado: string
}

// ---------------------------------------------------------------------------
// Registro (attestation)
// ---------------------------------------------------------------------------

/**
 * Verifica a attestation de `POST /painel/api/registrar/verificar` (§10.5).
 *
 * A ordem e a de §10.5 e ela importa: o que custa zero vem antes do que custa
 * CPU, e nada de CBOR acontece antes de `type`, `origin` e desafio fecharem.
 */
export async function verificarRegistro(entrada: EntradaDeRegistro): Promise<ResultadoDeRegistro> {
  const { resposta, rpId, origem, desafioEsperado } = entrada

  // 3. `type === "public-key"`.
  if (resposta.type !== 'public-key') return { ok: false, motivo: 'tipo_de_credencial' }
  if (typeof resposta.id !== 'string' || resposta.id.length === 0) {
    return { ok: false, motivo: 'campo_ausente' }
  }

  const clientData = decodeBase64Url(resposta.clientDataJSON)
  if (clientData === null) return { ok: false, motivo: 'base64url_invalido' }

  // 4. `webauthn.create` LITERAL. Trava de WA-06 pelo avesso: confundir os dois
  // tipos deixaria uma resposta de login servir de registro.
  const leituraDoCliente = conferirClientData(
    clientData,
    'webauthn.create',
    desafioEsperado,
    origem,
  )
  if (leituraDoCliente !== null) return { ok: false, motivo: leituraDoCliente }

  const attestation = decodeBase64Url(resposta.attestationObject)
  if (attestation === null) return { ok: false, motivo: 'base64url_invalido' }

  // 5. `fmt === "none"` e `attStmt` vazio. Trava de WA-23.
  const authData = authDataDaAttestation(attestation)
  if (authData === null) return { ok: false, motivo: 'formato_de_attestation' }

  // 6. `authData` cru, com `AT` obrigatorio.
  const dados = lerAuthData(authData)
  if (dados === null) return { ok: false, motivo: 'authdata_invalido' }

  const motivoDasFlags = await conferirRpIdEFlags(dados, rpId)
  if (motivoDasFlags !== null) return { ok: false, motivo: motivoDasFlags }

  if (!dados.at || dados.credentialId === null || dados.chaveCose === null) {
    return { ok: false, motivo: 'sem_credencial_anexada' }
  }

  // 7. COSE -> JWK, `importKey` e o confronto do `id`.
  return await credencialDaAttestation(dados, dados.credentialId, dados.chaveCose, resposta.id)
}

/**
 * A chave anexada vira linha de `painel_credenciais` (§10.5, passo 7).
 *
 * `importKey` roda AGORA: uma chave que nao importa nunca vira linha, e
 * descobrir isso no primeiro login seria descobrir tarde demais.
 *
 * O `id` do corpo tem que ser o `credentialId` que o proprio `authData` carrega:
 * sem esse confronto, o banco guardaria uma chave sob um identificador
 * escolhido por quem enviou o corpo.
 */
async function credencialDaAttestation(
  dados: DadosDoAutenticador,
  credentialIdBytes: Uint8Array,
  chaveCose: Uint8Array,
  idDoCorpo: string,
): Promise<ResultadoDeRegistro> {
  const chave = coseParaJwk(chaveCose)
  if (!chave.ok) return { ok: false, motivo: 'chave_publica_invalida' }
  if ((await importarChaveDeVerificacao(chave.jwk, chave.alg)) === null) {
    return { ok: false, motivo: 'chave_nao_importa' }
  }

  const credentialId = bytesToBase64Url(credentialIdBytes)
  if (!timingSafeEqual(credentialId, idDoCorpo)) {
    return { ok: false, motivo: 'campo_ausente' }
  }

  return {
    ok: true,
    credencial: {
      credentialId,
      jwk: chave.jwk,
      algoritmo: chave.alg,
      signCount: dados.signCount,
      backupElegivel: dados.be,
      backupAtivo: dados.bs,
    },
  }
}

// ---------------------------------------------------------------------------
// Login e step-up (assertion)
// ---------------------------------------------------------------------------

/**
 * A forma minima da resposta do autenticador. Qualquer outra vira `null`.
 *
 * Mora AQUI, e nao na rota que a usa, porque as duas cerimonias de assertion —
 * o login (`POST /painel/api/entrar/verificar`, corpo JSON) e o step-up (o
 * campo escondido do formulario, §10.10 passo 3) — leem exatamente a mesma
 * forma. A primeira grafia vivia dentro de `entrar.ts`, e a segunda teria de
 * ser uma copia: uma copia que aceitasse um campo a menos entregaria ao
 * `verificarAssertion` um objeto pela metade num caminho so, e seria o caminho
 * que ninguem revisou.
 *
 * O envelope e sempre `{ credencial: { ... } }`: o mesmo objeto que o
 * `painel.js` monta nas duas cerimonias.
 */
export function lerRespostaDeAssertion(corpo: unknown): RespostaDeAssertion | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const credencial = (corpo as { credencial?: unknown }).credencial
  if (typeof credencial !== 'object' || credencial === null) return null

  const lida = credencial as Record<string, unknown>
  if (
    typeof lida.id !== 'string' ||
    typeof lida.type !== 'string' ||
    typeof lida.clientDataJSON !== 'string' ||
    typeof lida.authenticatorData !== 'string' ||
    typeof lida.signature !== 'string'
  ) {
    return null
  }
  // `userHandle` e o unico opcional: o passo 5 de §10.7 confere os DOIS lados —
  // ausente tambem e uma resposta possivel, e `verificarAssertion` a trata.
  if (lida.userHandle !== null && typeof lida.userHandle !== 'string') return null

  return {
    id: lida.id,
    type: lida.type,
    clientDataJSON: lida.clientDataJSON,
    authenticatorData: lida.authenticatorData,
    signature: lida.signature,
    userHandle: lida.userHandle as string | null,
  }
}

/**
 * Verifica a assertion do login e do step-up (§10.7, passos 3 a 11).
 *
 * A ordem e a de §10.7. Nenhum CBOR roda aqui: a chave ja e JWK.
 */
export async function verificarAssertion(
  entrada: EntradaDeAssertion,
): Promise<ResultadoDeAssertion> {
  const { resposta, rpId, origem, desafioEsperado, credencial, usuarioHandleEsperado } = entrada

  const campos = camposDaAssertion(resposta)
  if (!campos.ok) return { ok: false, motivo: campos.motivo }
  const { clientData, authDataBytes, assinatura } = campos

  // 6. `webauthn.get` LITERAL, desafio por `timingSafeEqual`, origem exata.
  // Trava de WA-06: uma resposta de `webauthn.create` nao entra por aqui.
  const motivoDoCliente = conferirClientData(clientData, 'webauthn.get', desafioEsperado, origem)
  if (motivoDoCliente !== null) return { ok: false, motivo: motivoDoCliente }

  // 7. `rpIdHash`, `UP = 1` e `UV = 1`.
  const dados = lerAuthData(authDataBytes)
  if (dados === null) return { ok: false, motivo: 'authdata_invalido' }

  const motivoDasFlags = await conferirRpIdEFlags(dados, rpId)
  if (motivoDasFlags !== null) return { ok: false, motivo: motivoDasFlags }

  // 4 e 5. A credencial e o dono. O motivo e CALCULADO aqui e nao decide nada
  // ainda: recusar neste ponto pularia o `verify` e criaria um TERCEIRO tempo
  // de resposta, em que "existe mas nao serve" se distingue de "nao existe" so
  // pelo relogio (§11.4). Ele so e devolvido depois do trabalho completo.
  const motivoDaLinha = conferirCredencial(
    credencial,
    resposta.userHandle,
    rpId,
    usuarioHandleEsperado,
  )

  // 8. O que e assinado: `authenticatorData || SHA-256(clientDataJSON)`, os
  // bytes CRUS concatenados — nunca o JSON (§10.7, passo 8). Errar isto e o bug
  // que faz tudo devolver `false`.
  const assinado = await concatenarComHashDoCliente(authDataBytes, clientData)

  const { jwk, algoritmo } = chaveParaConferir(credencial, motivoDaLinha)
  const fechou = await conferirAssinatura(jwk, algoritmo, assinatura, assinado)

  // O motivo da linha vem ANTES do da assinatura: o `verify` ja foi pago, e a
  // tela de §10.14 precisa poder dizer "endereco antigo" a quem trocou de
  // endereco, em vez de deixa-lo preso num `assinatura_invalida`.
  if (motivoDaLinha !== null) return { ok: false, motivo: motivoDaLinha }
  if (!fechou.ok) return { ok: false, motivo: fechou.motivo }
  if (credencial === null) return { ok: false, motivo: 'assinatura_invalida' }

  return await assertionAprovada(dados, credencial)
}

/**
 * A chave que vai para o `verify`, e o algoritmo dela.
 *
 * Trava de WA-19, agora nos TRES casos que precisam custar o mesmo: credencial
 * desconhecida, credencial de endereco antigo e credencial de outro dono. Os
 * tres percorrem um `verify` inteiro com a chave descartavel, entao nenhum
 * deles se denuncia pelo relogio. Continua sendo mitigacao parcial — uma
 * credencial RS256 legitima custa mais que a chave descartavel, que e ES256 — e
 * continua escrita como parcial.
 */
function chaveParaConferir(
  credencial: CredencialGuardada | null,
  motivoDaLinha: MotivoWebauthn | null,
): { jwk: JsonWebKey; algoritmo: AlgoritmoSuportado } {
  if (credencial === null || motivoDaLinha !== null) {
    return { jwk: CHAVE_DESCARTAVEL, algoritmo: ALG_ES256 }
  }
  return {
    jwk: credencial.jwk,
    algoritmo: ehAlgoritmoSuportado(credencial.algoritmo) ? credencial.algoritmo : ALG_ES256,
  }
}

/**
 * A assertion aceita (§10.7, passo 11).
 *
 * `signCount`: avisa, NUNCA recusa. Passkeys sincronizadas por iCloud Keychain
 * e Google Password Manager devolvem 0 sempre, e recusar trancaria o dono
 * legitimo do lado de fora. Trava de WA-20 e de WA-21.
 */
async function assertionAprovada(
  dados: DadosDoAutenticador,
  credencial: CredencialGuardada,
): Promise<ResultadoDeAssertion> {
  const regrediu =
    dados.signCount > 0 && credencial.signCount > 0 && dados.signCount <= credencial.signCount
  if (regrediu) {
    console.warn(
      'painel:',
      'sign_count_regrediu',
      `passkey:${await prefixoDeCredencial(credencial.credentialId)}`,
    )
  }

  return {
    ok: true,
    assertion: {
      credentialId: credencial.credentialId,
      signCount: dados.signCount,
      backupElegivel: dados.be,
      backupAtivo: dados.bs,
      signCountRegrediu: regrediu,
    },
  }
}

// ---------------------------------------------------------------------------
// As pecas
// ---------------------------------------------------------------------------

/** O `authData` de dentro do `attestationObject`, so se `fmt === "none"`. */
function authDataDaAttestation(attestation: Uint8Array): Uint8Array | null {
  const leitura = decodificarCbor(attestation)
  if (!leitura.ok || leitura.valor.tipo !== 'mapa') return null

  // Trava de WA-23: `fmt` diferente de `none` e RECUSADO, nao "aceito e
  // ignorado". `attestation: "none"` e o que o painel pede nas options, entao
  // qualquer outro formato e anomalia.
  if (textoDoMapa(leitura.valor, 'fmt') !== 'none') return null

  const attStmt = doMapa(leitura.valor, 'attStmt')
  if (attStmt === null || tamanhoDoMapa(attStmt) !== 0) return null

  // Tres chaves e nada mais: `fmt`, `attStmt`, `authData`.
  if (tamanhoDoMapa(leitura.valor) !== 3) return null

  const authData = doMapa(leitura.valor, 'authData')
  return authData !== null && authData.tipo === 'bytes' ? authData.bytes : null
}

/**
 * Os tres campos binarios da assertion, decodificados (§10.7, passo 3).
 *
 * `decodeBase64Url` e CANONICO e nunca lanca: texto fora do alfabeto, com
 * padding ou com bits residuais some aqui, antes de qualquer trabalho de CPU.
 */
function camposDaAssertion(
  resposta: RespostaDeAssertion,
):
  | { ok: true; clientData: Uint8Array; authDataBytes: Uint8Array; assinatura: Uint8Array }
  | { ok: false; motivo: MotivoWebauthn } {
  if (resposta.type !== 'public-key') return { ok: false, motivo: 'tipo_de_credencial' }
  if (typeof resposta.id !== 'string' || resposta.id.length === 0) {
    return { ok: false, motivo: 'campo_ausente' }
  }

  const clientData = decodeBase64Url(resposta.clientDataJSON)
  const authDataBytes = decodeBase64Url(resposta.authenticatorData)
  const assinatura = decodeBase64Url(resposta.signature)
  if (clientData === null || authDataBytes === null || assinatura === null) {
    return { ok: false, motivo: 'base64url_invalido' }
  }

  return { ok: true, clientData, authDataBytes, assinatura }
}

/**
 * A linha do banco: endereco atual e dono certo (§10.7, passos 4 e 5).
 *
 * Trava de WA-18: uma credencial de `rp_id` antigo e IGNORADA e ganha um motivo
 * PROPRIO — nao porque o cliente vá vê-lo (ele vê sempre `credencial_invalida`),
 * mas porque a tela de §10.14 precisa poder dizer "endereco antigo" em vez de
 * deixar o dono que trocou de endereco preso num erro incompreensivel.
 *
 * Trava de WA-26: o `usuario_handle` e conferido nos DOIS lados — o da linha do
 * banco e o que o autenticador devolveu. Conferir so um deixaria metade do
 * caminho aberto.
 *
 * Nada e DECIDIDO aqui — nem o `null`, nem os dois motivos. Esta funcao so
 * calcula; quem recusa e `verificarAssertion`, depois do `verify`. Um retorno
 * mais cedo em qualquer um dos tres casos viraria um oraculo de tempo (§11.4).
 */
function conferirCredencial(
  credencial: CredencialGuardada | null,
  userHandle: string | null,
  rpId: string,
  usuarioHandleEsperado: string,
): MotivoWebauthn | null {
  if (credencial === null) return null
  if (credencial.rpId !== rpId) return 'credencial_de_endereco_antigo'
  if (!timingSafeEqual(credencial.usuarioHandle, usuarioHandleEsperado)) return 'dono_diferente'
  if (typeof userHandle === 'string' && !timingSafeEqual(userHandle, usuarioHandleEsperado)) {
    return 'dono_diferente'
  }
  return null
}

interface DadosDoAutenticador {
  readonly rpIdHash: Uint8Array
  readonly up: boolean
  readonly uv: boolean
  readonly be: boolean
  readonly bs: boolean
  readonly at: boolean
  readonly signCount: number
  readonly credentialId: Uint8Array | null
  readonly chaveCose: Uint8Array | null
}

/**
 * `authData` cru -> campos (§10.5, passo 6).
 *
 * Extensoes (`ED = 1`) sao recusadas: o painel nao pede nenhuma, e aceitar um
 * bloco CBOR extra depois da chave publica seria aceitar conteudo que ninguem
 * examinou.
 */
function lerAuthData(authData: Uint8Array): DadosDoAutenticador | null {
  if (authData.length < TAMANHO_MINIMO_DO_AUTHDATA) return null

  const flags = authData[POSICAO_DAS_FLAGS] ?? 0
  if ((flags & FLAG_ED) !== 0) return null

  const visao = new DataView(authData.buffer, authData.byteOffset, authData.byteLength)
  const signCount = visao.getUint32(POSICAO_DO_SIGNCOUNT, false)

  // Trava de WA-22: `BE` e `BS` sao LIDAS, nunca exigidas. Elas dizem se a
  // passkey e sincronizavel e se ja esta em backup, e a tela de Aparelhos
  // mostra isso ao dono. Exigi-las recusaria metade dos autenticadores.
  const comum = {
    rpIdHash: authData.subarray(0, TAMANHO_DO_RPIDHASH),
    up: (flags & FLAG_UP) !== 0,
    uv: (flags & FLAG_UV) !== 0,
    be: (flags & FLAG_BE) !== 0,
    bs: (flags & FLAG_BS) !== 0,
    at: (flags & FLAG_AT) !== 0,
    signCount,
  }

  if (!comum.at) {
    // Sem `AT` o `authData` termina no `signCount`. Sobra = anomalia.
    if (authData.length !== TAMANHO_MINIMO_DO_AUTHDATA) return null
    return { ...comum, credentialId: null, chaveCose: null }
  }

  const inicioDaCredencial = TAMANHO_MINIMO_DO_AUTHDATA
  if (authData.length < inicioDaCredencial + CABECALHO_DA_CREDENCIAL) return null

  const posicaoDoTamanho = inicioDaCredencial + TAMANHO_DO_AAGUID
  const tamanhoDoId = visao.getUint16(posicaoDoTamanho, false)
  if (tamanhoDoId === 0 || tamanhoDoId > CREDENTIAL_ID_MAXIMO) return null

  const inicioDoId = posicaoDoTamanho + 2
  const fimDoId = inicioDoId + tamanhoDoId
  if (fimDoId > authData.length) return null

  return {
    ...comum,
    credentialId: authData.subarray(inicioDoId, fimDoId),
    chaveCose: authData.subarray(fimDoId),
  }
}

/**
 * `rpIdHash` byte a byte, `UP = 1` e `UV = 1`.
 *
 * Trava de WA-09: o `rpIdHash` e o passo mais pulado de todos, e e ele que
 * impede que uma credencial de outro RP sirva aqui.
 *
 * Trava de WA-10, de WA-11 e de WA-12: `UV = 1` e OBRIGATORIO no login e no
 * step-up (§7.8). Como as duas cerimonias passam por esta funcao, nao existe um
 * caminho onde alguem esqueca de conferir num deles — que e exatamente o erro
 * que §7.8 escreve em letras grandes.
 */
async function conferirRpIdEFlags(
  dados: DadosDoAutenticador,
  rpId: string,
): Promise<MotivoWebauthn | null> {
  const esperado = new Uint8Array(await crypto.subtle.digest('SHA-256', codificador.encode(rpId)))
  if (!mesmosBytes(dados.rpIdHash, esperado)) return 'rp_id_hash_diferente'

  if (!dados.up) return 'presenca_ausente'
  if (!dados.uv) return 'verificacao_de_usuario_ausente'
  return null
}

/**
 * `clientDataJSON` (§10.5 passo 4, §10.7 passo 6).
 *
 * Trava de WA-05: o desafio comparado e o `desafioEsperado`, que vem do
 * envelope assinado. Esta funcao nao tem como ler um desafio do corpo: o campo
 * do corpo e o `challenge` de dentro do `clientDataJSON`, e ele e o lado
 * COMPARADO, nunca o lado esperado.
 *
 * Trava de WA-06: `type` literal — `webauthn.create` no registro,
 * `webauthn.get` no login.
 *
 * Trava de WA-07 e de WA-08: `origin` por string INTEIRA. Trocar por `includes`
 * ou `startsWith` faria `https://exemplo.workers.dev.evil.com` passar, e faria
 * passar tambem a origem com barra final ou porta.
 */
function conferirClientData(
  bytes: Uint8Array,
  tipoEsperado: 'webauthn.create' | 'webauthn.get',
  desafioEsperado: string,
  origem: string,
): MotivoWebauthn | null {
  let lido: unknown
  try {
    lido = JSON.parse(decodificador.decode(bytes))
  } catch {
    return 'client_data_invalido'
  }

  if (typeof lido !== 'object' || lido === null || Array.isArray(lido)) {
    return 'client_data_invalido'
  }

  const cliente = lido as Record<string, unknown>

  if (cliente.type !== tipoEsperado) return 'tipo_de_cerimonia'

  // WA-27, a limitacao conhecida: a comparacao abaixo NAO consome o desafio.
  // O mesmo desafio reapresentado dentro do prazo do envelope e aceito de
  // novo, e o que limita o replay e o prazo, nao um registro de uso unico.
  // Implementar uso unico aqui derruba o teste de WA-27 de proposito.
  if (typeof cliente.challenge !== 'string') return 'client_data_invalido'
  if (!timingSafeEqual(cliente.challenge, desafioEsperado)) return 'desafio_diferente'

  if (typeof cliente.origin !== 'string') return 'client_data_invalido'
  if (cliente.origin !== origem) return 'origem_desconhecida'

  if (cliente.crossOrigin === true) return 'cross_origin'

  return null
}

/**
 * `authenticatorData || SHA-256(clientDataJSON)`, bytes crus concatenados.
 *
 * Trava de WA-14: e ESTA concatenacao que faz a assinatura cobrir os dois
 * blocos. Assinar o `clientDataJSON` — o bug classico do passo 8 de §10.7 —
 * deixaria qualquer byte do `authData`, `UV` inclusive, livre para ser trocado
 * depois da assinatura.
 */
async function concatenarComHashDoCliente(
  authData: Uint8Array,
  clientData: Uint8Array,
): Promise<Uint8Array> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))
  const assinado = new Uint8Array(authData.length + hash.length)
  assinado.set(authData, 0)
  assinado.set(hash, authData.length)
  return assinado
}

/**
 * Importa a chave, converte a assinatura quando for ES256, e verifica.
 *
 * Trava de WA-01, WA-02 e WA-13: e aqui que uma cerimonia valida e aceita e que
 * a assinatura de outra chave e recusada, para os DOIS algoritmos. E o unico
 * ponto do modulo que decide isso.
 *
 * Trava de WA-15, WA-16 e WA-17: ES256 passa OBRIGATORIAMENTE por
 * `derParaBruto`. Mandar a assinatura do autenticador direto ao WebCrypto
 * devolveria `false` em silencio, e nenhuma mensagem de erro apareceria em
 * lugar nenhum — o dono so veria "nao foi possivel confirmar", para sempre.
 */
async function conferirAssinatura(
  jwk: JsonWebKey,
  algoritmo: AlgoritmoSuportado,
  assinatura: Uint8Array,
  assinado: Uint8Array,
): Promise<{ ok: true } | { ok: false; motivo: MotivoWebauthn }> {
  const chave = await importarChaveDeVerificacao(jwk, algoritmo)
  if (chave === null) return { ok: false, motivo: 'chave_nao_importa' }

  let bytes = assinatura
  if (algoritmo === ALG_ES256) {
    const bruto = derParaBruto(assinatura)
    if (bruto === null) return { ok: false, motivo: 'assinatura_malformada' }
    bytes = bruto
  }

  const fechou = await crypto.subtle.verify(
    parametrosDeVerificacao(algoritmo),
    chave,
    bytes,
    assinado,
  )
  return fechou ? { ok: true } : { ok: false, motivo: 'assinatura_invalida' }
}

function mesmosBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diferenca = 0
  for (let i = 0; i < a.length; i++) diferenca |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diferenca === 0
}

/**
 * Os 8 primeiros caracteres hexadecimais do `sha256(credential_id)`.
 *
 * Trava de §10.13: sao **tres** destinos — tela, `console` e `painel_auditoria`
 * — e **uma** regra. O `credential_id` inteiro nunca aparece em nenhum deles.
 */
export async function prefixoDeCredencial(credentialId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', codificador.encode(credentialId)),
  )
  let hex = ''
  for (const byte of digest.subarray(0, PREFIXO_DE_CREDENCIAL / 2)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}
