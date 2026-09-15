/**
 * As options das tres cerimonias: registro, login e step-up.
 *
 * Sao funcoes PURAS que montam o objeto que o `navigator.credentials` recebe.
 * O sorteio do desafio e a emissao do envelope ficam com a rota (§10.4 passo 6,
 * §10.7): este arquivo nao le o relogio, nao sorteia nada sozinho e nao conhece
 * cookie, o desafio entra por parametro, ja assinado por quem chamou.
 *
 * **`userVerification: "required"` nas tres.** E metade de §7.8: a outra metade
 * e a flag `UV` conferida no `authData`, que mora em `verificar.ts`. As options
 * sozinhas nao provam nada, sao instrucao para o autenticador, e um
 * autenticador hostil ignora instrucao. Estao aqui porque o autenticador
 * HONESTO precisa delas para pedir a biometria; a trava e a outra metade.
 */
import { bytesToBase64Url } from '../../security/base64url'
import { PRAZO_DE_ENVELOPE_MS } from '../../security/signed-envelope'
import { ALG_ES256, ALG_RS256 } from './cose'

/** 32 bytes sorteados, como manda §10.4 passo 6 e §10.7. */
const DESAFIO_BYTES = 32

/** O nome que aparece no dialogo do sistema operacional. */
export const NOME_DO_RP = 'Painel da automacao'

/** O que a tela do gerenciador de senhas mostra para o dono. */
export const NOME_DE_EXIBICAO = 'Dono da conta'

/**
 * `[-7, -257]` e nada mais (§10.4).
 *
 * ES256 cobre Apple/iCloud, Google/Android e as chaves de seguranca; RS256
 * cobre o Windows Hello com TPM. Ed25519 (-8) fica de fora por decisao: pouca
 * cobertura e incompatibilidades conhecidas.
 */
export const PARAMETROS_DE_CHAVE = [
  { type: 'public-key', alg: ALG_ES256 },
  { type: 'public-key', alg: ALG_RS256 },
] as const

export interface OpcoesDeRegistro {
  readonly rp: { readonly id: string; readonly name: string }
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string }
  readonly challenge: string
  readonly pubKeyCredParams: typeof PARAMETROS_DE_CHAVE
  readonly authenticatorSelection: {
    readonly residentKey: 'required'
    readonly userVerification: 'required'
  }
  readonly attestation: 'none'
  readonly excludeCredentials: readonly { readonly type: 'public-key'; readonly id: string }[]
  readonly timeout: number
}

export interface OpcoesDeAssertion {
  readonly challenge: string
  readonly rpId: string
  /**
   * Sempre vazia (§10.7).
   *
   * As credenciais sao descobriveis (`residentKey: "required"`), e devolver a
   * lista de `credential_id` a quem ainda nao provou nada seria enumeracao de
   * graca.
   */
  readonly allowCredentials: readonly never[]
  readonly userVerification: 'required'
  readonly timeout: number
}

/** 32 bytes aleatorios em base64url. E o unico sorteio deste modulo. */
export function sortearDesafio(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(DESAFIO_BYTES)))
}

/**
 * Options de `POST /painel/api/registrar/opcoes` (§10.4, passo 7).
 *
 * O `timeout` acompanha o prazo do envelope de `registrar`, 300 s, porque os
 * dois medem a mesma coisa: quanto tempo o dono tem para encarar o primeiro
 * dialogo do sistema operacional que ja viu. Derivar do envelope em vez de
 * escrever o numero de novo e o que impede os dois de divergirem.
 */
export function opcoesDeRegistro(entrada: {
  readonly rpId: string
  readonly usuarioHandle: string
  readonly nomeDeUsuario: string
  readonly desafio: string
  readonly excluir: readonly string[]
}): OpcoesDeRegistro {
  return {
    rp: { id: entrada.rpId, name: NOME_DO_RP },
    user: {
      id: entrada.usuarioHandle,
      name: entrada.nomeDeUsuario,
      displayName: NOME_DE_EXIBICAO,
    },
    challenge: entrada.desafio,
    pubKeyCredParams: PARAMETROS_DE_CHAVE,
    // Trava de §7.8, metade das options: sem `required` aqui, o autenticador
    // honesto nao pede biometria e a flag `UV` chega em 0.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    // `none` elimina a cadeia X.509 e ~90% do trabalho de verificacao (§10.4).
    attestation: 'none',
    excludeCredentials: entrada.excluir.map((id) => ({ type: 'public-key' as const, id })),
    timeout: PRAZO_DE_ENVELOPE_MS.registrar,
  }
}

/** Options de `POST /painel/api/entrar/opcoes` (§10.7). Custa zero consulta. */
export function opcoesDeLogin(entrada: {
  readonly rpId: string
  readonly desafio: string
}): OpcoesDeAssertion {
  return {
    challenge: entrada.desafio,
    rpId: entrada.rpId,
    allowCredentials: [],
    userVerification: 'required',
    timeout: PRAZO_DE_ENVELOPE_MS.entrar,
  }
}

/**
 * Options de `POST /painel/api/stepup/opcoes` (§10.10).
 *
 * Iguais as do login de proposito: a cerimonia e a mesma, e o que separa uma da
 * outra e o proposito do envelope, `stepup` em vez de `entrar`, mais o
 * `op_hash` que a rota de escrita recalcula. Duas formas diferentes de montar
 * as mesmas options seriam duas chances de esquecer o `userVerification`.
 */
export function opcoesDeStepUp(entrada: {
  readonly rpId: string
  readonly desafio: string
}): OpcoesDeAssertion {
  return {
    challenge: entrada.desafio,
    rpId: entrada.rpId,
    allowCredentials: [],
    userVerification: 'required',
    timeout: PRAZO_DE_ENVELOPE_MS.stepup,
  }
}
