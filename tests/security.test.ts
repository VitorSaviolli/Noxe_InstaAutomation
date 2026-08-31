import { describe, expect, test } from 'vitest'
import { timingSafeEqual } from '../src/security/constant-time'
import {
  decrypt,
  EncryptionError,
  encrypt,
  generateEncryptionKey,
} from '../src/security/encryption'
import { createState, validateState } from '../src/security/oauth-state'
import { isValidSignature } from '../src/security/webhook-signature'

/** Chave valida: 32 bytes em base64. */
const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
const APP_SECRET = 'segredo-de-teste'

/** Calcula a assinatura que a Meta enviaria para um corpo. */
async function signBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

describe('assinatura do webhook', () => {
  const body = '{"object":"instagram","entry":[]}'

  test('aceita assinatura valida', async () => {
    const header = await signBody(body, APP_SECRET)
    expect(await isValidSignature(body, header, APP_SECRET)).toBe(true)
  })

  test('rejeita assinatura de outro segredo', async () => {
    const header = await signBody(body, 'segredo-errado')
    expect(await isValidSignature(body, header, APP_SECRET)).toBe(false)
  })

  test('rejeita quando o corpo foi alterado', async () => {
    const header = await signBody(body, APP_SECRET)
    expect(await isValidSignature(`${body} `, header, APP_SECRET)).toBe(false)
  })

  test('rejeita header ausente', async () => {
    expect(await isValidSignature(body, null, APP_SECRET)).toBe(false)
  })

  test('rejeita header sem o prefixo sha256=', async () => {
    expect(await isValidSignature(body, 'abc123', APP_SECRET)).toBe(false)
  })

  test('rejeita hex de tamanho errado', async () => {
    expect(await isValidSignature(body, 'sha256=abcd', APP_SECRET)).toBe(false)
  })

  test('rejeita hex com caractere invalido', async () => {
    const invalido = `sha256=${'z'.repeat(64)}`
    expect(await isValidSignature(body, invalido, APP_SECRET)).toBe(false)
  })

  test('rejeita quando o app secret esta vazio', async () => {
    const header = await signBody(body, APP_SECRET)
    expect(await isValidSignature(body, header, '')).toBe(false)
  })
})

describe('criptografia do token', () => {
  test('ida e volta preserva o texto', async () => {
    const original = 'IGQVJXaccess-token-exemplo'
    const cifrado = await encrypt(original, KEY)
    expect(await decrypt(cifrado, KEY)).toBe(original)
  })

  test('o texto cifrado nao contem o original', async () => {
    const original = 'token-secreto'
    const cifrado = await encrypt(original, KEY)
    expect(cifrado).not.toContain(original)
  })

  test('duas cifragens do mesmo texto sao diferentes (IV aleatorio)', async () => {
    const a = await encrypt('mesmo texto', KEY)
    const b = await encrypt('mesmo texto', KEY)
    expect(a).not.toBe(b)
  })

  test('falha ao decifrar com chave errada', async () => {
    const outraChave = generateEncryptionKey()
    const cifrado = await encrypt('token', KEY)
    await expect(decrypt(cifrado, outraChave)).rejects.toThrow(EncryptionError)
  })

  test('rejeita chave com tamanho errado', async () => {
    await expect(encrypt('x', 'YWJj')).rejects.toThrow(/32 bytes/)
  })

  test('rejeita payload truncado', async () => {
    await expect(decrypt('YWJj', KEY)).rejects.toThrow(EncryptionError)
  })

  test('generateEncryptionKey produz chave utilizavel', async () => {
    const chave = generateEncryptionKey()
    const cifrado = await encrypt('teste', chave)
    expect(await decrypt(cifrado, chave)).toBe('teste')
  })
})

describe('state do OAuth', () => {
  const SECRET = 'segredo-do-state'
  const AGORA = 1_700_000_000_000

  test('aceita state recem-criado', async () => {
    const state = await createState(SECRET, AGORA)
    expect(await validateState(state, SECRET, AGORA)).toEqual({ valid: true })
  })

  test('rejeita state expirado', async () => {
    const state = await createState(SECRET, AGORA)
    const resultado = await validateState(state, SECRET, AGORA + 11 * 60 * 1000)
    expect(resultado).toEqual({ valid: false, reason: 'expirado' })
  })

  test('rejeita state assinado com outro segredo', async () => {
    const state = await createState('outro-segredo', AGORA)
    const resultado = await validateState(state, SECRET, AGORA)
    expect(resultado).toEqual({ valid: false, reason: 'assinatura_invalida' })
  })

  test('rejeita state malformado', async () => {
    const resultado = await validateState('lixo', SECRET, AGORA)
    expect(resultado).toEqual({ valid: false, reason: 'malformado' })
  })

  test('rejeita state com payload adulterado', async () => {
    const state = await createState(SECRET, AGORA)
    const [nonce, _expira, assinatura] = state.split('.')
    const adulterado = `${nonce}.${AGORA + 999_999_999}.${assinatura}`
    const resultado = await validateState(adulterado, SECRET, AGORA)
    expect(resultado).toEqual({ valid: false, reason: 'assinatura_invalida' })
  })

  test('dois states seguidos sao diferentes', async () => {
    const a = await createState(SECRET, AGORA)
    const b = await createState(SECRET, AGORA)
    expect(a).not.toBe(b)
  })
})

describe('comparacao em tempo constante', () => {
  test('true para strings iguais', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  test('false para strings diferentes do mesmo tamanho', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
  })

  test('false para tamanhos diferentes', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })

  test('true para duas strings vazias', () => {
    expect(timingSafeEqual('', '')).toBe(true)
  })
})
