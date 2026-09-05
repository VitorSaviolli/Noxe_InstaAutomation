/**
 * Vetores congelados de hardware real (§13.3).
 *
 * **Estado atual: NENHUM vetor foi capturado. O conjunto abaixo esta VAZIO de
 * propósito, e isso e um `BLOCKED` declarado do Step 5 da Task 7 — nao um
 * esquecimento.** A pagina de captura esta publicada e o dono a usara quando
 * puder.
 *
 * ## Por que nao da para gerar estes vetores com software
 *
 * O metodo T2 tem duas fontes e elas so valem por serem **independentes**: o
 * `AutenticadorFalso` gera variacao, e o hardware real prova que a variacao
 * corresponde ao mundo. Preencher este arquivo com saida do `AutenticadorFalso`
 * destruiria exatamente a independencia que T2 existe para garantir — e o teste
 * "os vetores de hardware sao aceitos" passaria a dizer apenas que o
 * autenticador de software concorda consigo mesmo. Por isso o arquivo nasce
 * vazio e os testes que dependem dele ficam **vermelhos por construcao**
 * (`test.todo`), em vez de virarem uma promessa esquecida.
 *
 * ## O que cada vetor contem, e por que nao contem segredo
 *
 * Chave publica, assinatura, desafio e metadados — exatamente o que o servidor
 * ja recebe pela rede em toda cerimonia. Nao ha chave privada, nao ha cookie,
 * nao ha identificador de conta. Podem ser commitados sem risco.
 *
 * ## Cada vetor traz o proprio `rpId`, `origin` e desafio
 *
 * Eles valiam **na hora da captura** e **nao casam com nenhuma instalacao** —
 * nem com a do dono, nem com a de quem clonar o template. O verificador e
 * testado contra os valores que vem DENTRO do vetor, nunca contra
 * `env.PANEL_RP_ID`. E o que mantem estes testes verdes na maquina de todo
 * mundo, e o que os mantem alinhados a regra de que nada especifico de uma
 * instalacao entra no repositorio.
 *
 * ## Dois avisos de realidade, registrados antes da captura
 *
 * 1. **O dono nao tem Android.** O vetor `registroEs256Android` vira de Windows
 *    Hello (em modo ES256) ou de iPhone. O campo `procedencia` guarda de onde
 *    ele veio de verdade; o NOME fica como esta para nao quebrar as referencias
 *    ja escritas nos testes. Um vetor ES256 de qualquer plataforma cumpre o
 *    papel dele aqui: provar que uma attestation ES256 de hardware e aceita.
 * 2. **O dono nao tem chave USB, e Windows Hello e iCloud sempre confirmam
 *    identidade.** E provavel que `loginSemUv` — o vetor NEGATIVO, com `UV = 0`
 *    — chegue como **BLOCKED permanente**: nao existe autenticador a mao capaz
 *    de produzi-lo. As duas hipoteses estao prontas: se ele chegar, o teste
 *    dedicado fica verde; se nao chegar, `UV = 0` continua provado em software
 *    pelo helper `semUv()` do `AutenticadorFalso`, e a ausencia do vetor fica
 *    registrada aqui em vez de virar cobertura fingida.
 *
 * Este arquivo mora em `tests/fixtures/`, que nao casa com o `include` do
 * vitest, entao ele nao vira uma suite vazia.
 */

/**
 * Os seis nomes do conjunto minimo de §13.3. Exatamente estes, nesta grafia.
 *
 * Um nome novo aqui obriga a decidir onde ele entra; um nome removido quebra o
 * `vetoresAusentes()` e o teste que o consome.
 */
export const NOMES_DE_VETOR = [
  /** Attestation ES256 de hardware. Ver aviso 1 acima sobre a procedencia. */
  'registroEs256Android',
  /** Attestation RS256. TPM do Windows Hello e o unico caminho RS256. */
  'registroRs256WindowsHello',
  /** Assertion ES256 com `signCount` sempre 0 e `BE = 1`, `BS = 1`. */
  'loginEs256Icloud',
  /** Assertion cujo `r` em DER tem 33 bytes (padding `0x00`). */
  'loginEs256DerRAlto',
  /** Assertion cujo `r` em DER tem 31 bytes. So o hardware entrega barato. */
  'loginEs256DerRCurto',
  /** Vetor NEGATIVO: `UV = 0`. Ver aviso 2 acima — provavel BLOCKED. */
  'loginSemUv',
] as const

export type NomeDeVetor = (typeof NOMES_DE_VETOR)[number]

/** Metadados que acompanham todo vetor, capturados junto com os bytes. */
interface BaseDoVetor {
  readonly nome: NomeDeVetor
  /** Aparelho, sistema e navegador de onde saiu. Escrito a mao na captura. */
  readonly procedencia: string
  /** Data da captura, em ISO. So documentacao. */
  readonly capturadoEm: string
  /** O `rpId` que valia na captura. NAO casa com nenhuma instalacao. */
  readonly rpId: string
  /** A origem que valia na captura. NAO casa com nenhuma instalacao. */
  readonly origem: string
  /** O desafio que valia na captura, em base64url. */
  readonly desafio: string
  /** `credential.id`, base64url, como o navegador mandou. */
  readonly id: string
  /** `response.clientDataJSON`, base64url. */
  readonly clientDataJSON: string
}

/** Um vetor de attestation (`navigator.credentials.create`). */
export interface VetorDeRegistro extends BaseDoVetor {
  readonly cerimonia: 'registro'
  /** `response.attestationObject`, base64url. */
  readonly attestationObject: string
  /** COSE `alg` esperado: -7 ou -257. Confere o que o verificador deduziu. */
  readonly algoritmoEsperado: number
}

/** Um vetor de assertion (`navigator.credentials.get`). */
export interface VetorDeAssertion extends BaseDoVetor {
  readonly cerimonia: 'assertion'
  /** `response.authenticatorData`, base64url. */
  readonly authenticatorData: string
  /** `response.signature`, base64url. ES256 vem em DER. */
  readonly assinatura: string
  /** `response.userHandle`, base64url, ou `null`. */
  readonly userHandle: string | null
  /** A chave publica da credencial, como `painel_credenciais` guardaria. */
  readonly chavePublicaJwk: JsonWebKey
  /** COSE `alg` da credencial: -7 ou -257. */
  readonly algoritmo: number
  /** `painel_estado.usuario_handle` que valia na captura. */
  readonly usuarioHandle: string
  /** O que o verificador tem que responder. `false` so em `loginSemUv`. */
  readonly deveSerAceito: boolean
}

export type Vetor = VetorDeRegistro | VetorDeAssertion

/**
 * O conjunto capturado. **VAZIO ate o dono rodar a pagina de captura.**
 *
 * Quando um vetor chegar, ele entra aqui com a chave igual ao nome, e os
 * `test.todo` correspondentes de `tests/painel-webauthn.test.ts` viram `test`.
 */
export const VETORES: Partial<Record<NomeDeVetor, Vetor>> = {}

/** Os nomes que ainda faltam. Vazio significa Step 5 concluido. */
export function vetoresAusentes(): NomeDeVetor[] {
  return NOMES_DE_VETOR.filter((nome) => VETORES[nome] === undefined)
}

/** Os nomes ja capturados. */
export function vetoresPresentes(): NomeDeVetor[] {
  return NOMES_DE_VETOR.filter((nome) => VETORES[nome] !== undefined)
}

/** O vetor de registro daquele nome, ou `null` se ele ainda nao existe. */
export function vetorDeRegistro(nome: NomeDeVetor): VetorDeRegistro | null {
  const achado = VETORES[nome]
  return achado !== undefined && achado.cerimonia === 'registro' ? achado : null
}

/** O vetor de assertion daquele nome, ou `null` se ele ainda nao existe. */
export function vetorDeAssertion(nome: NomeDeVetor): VetorDeAssertion | null {
  const achado = VETORES[nome]
  return achado !== undefined && achado.cerimonia === 'assertion' ? achado : null
}

/**
 * A frase que um teste bloqueado escreve quando o vetor falta.
 *
 * Existe para que a mensagem seja SEMPRE a mesma e SEMPRE nomeie o vetor: um
 * `skip` silencioso vira cobertura fantasma na primeira vez que alguem le a
 * saida da suite com pressa.
 */
export function faltaOVetor(nome: NomeDeVetor): string {
  return `vetor de hardware ausente: ${nome} (Step 5 da Task 7 esta BLOCKED)`
}
