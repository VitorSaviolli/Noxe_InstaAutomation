/**
 * Codificacao base64url (RFC 4648 secao 5), sem padding.
 *
 * O codificador daqui NASCEU em `oauth-state.ts`, onde era privado, e foi
 * movido para ca sem alterar um byte do que ele produz: o `state` do OAuth vai
 * assinado na URL de consentimento da Meta, e mudar o alfabeto ou restaurar o
 * padding invalidaria todo state em voo. Quem prova isso e a suite
 * `tests/regressao-oauth.test.ts` (REG-14), que congela um vetor de ouro cuja
 * assinatura, em base64 PADRAO, tem `+`, `/` e `=` ao mesmo tempo.
 *
 * O decodificador e novo e existe para o painel: os envelopes assinados
 * precisam ler de volta o que escreveram.
 */

/**
 * Bytes -> base64url sem padding.
 *
 * `btoa` produz base64 padrao; as tres substituicoes finais sao o que separa
 * base64 de base64url. Sem elas o valor precisaria de escape em URL e em
 * cookie.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** So o alfabeto base64url. Nada de `+`, de `/` nem de `=`. */
const ALFABETO_BASE64URL = /^[A-Za-z0-9_-]*$/

/**
 * base64url -> bytes. Devolve `null` em vez de lancar.
 *
 * NUNCA lanca, e isso e requisito e nao detalhe: a entrada vem de cookie e de
 * corpo de requisicao, isto e, de qualquer pessoa na internet. Uma excecao
 * aqui viraria 500 numa rota que deveria responder "credencial invalida".
 *
 * E CANONICO: um conteudo tem exatamente um texto que o representa, e o texto
 * de volta e sempre o que o `bytesToBase64Url` daqui emitiria. Sao tres
 * recusas, e a terceira e a que nao e obvia:
 *
 * 1. fora do alfabeto base64url (`+`, `/`, `=` e o resto);
 * 2. comprimento `% 4 === 1`, que nao existe em base64;
 * 3. **bits residuais diferentes de zero.** O `atob` implementa o
 *    *forgiving-base64* do WHATWG e IGNORA os bits sobrando do ultimo grupo:
 *    `atob('AQ')` e `atob('AR')` devolvem o MESMO byte. Sem a reconferencia
 *    abaixo, dois textos representariam o mesmo conteudo — e uma etapa
 *    seguinte que compare textos (codigo de recuperacao, `credential_id`)
 *    herdaria um jeito de escrever o mesmo segredo de duas formas.
 *
 * O preco e uma recodificacao por leitura, sobre entradas de dezenas de bytes.
 */
export function decodeBase64Url(texto: string): Uint8Array | null {
  if (!ALFABETO_BASE64URL.test(texto)) return null

  // Um grupo base64 tem 4 caracteres; sobrar exatamente 1 e impossivel.
  const sobra = texto.length % 4
  if (sobra === 1) return null

  const padrao =
    texto.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(sobra === 0 ? 0 : 4 - sobra)

  let bytes: Uint8Array
  try {
    const binario = atob(padrao)
    bytes = new Uint8Array(binario.length)
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i)
  } catch {
    return null
  }

  // Trava de SES-10. A recodificacao e o que TORNA a canonicidade verdadeira,
  // em vez de prometida: se o texto nao for o unico que representa estes
  // bytes, some. Tirar esta linha "por desempenho" derruba o teste da grafia
  // unica, e nao o do circulo fechado — o round trip continuaria passando.
  return bytesToBase64Url(bytes) === texto ? bytes : null
}
