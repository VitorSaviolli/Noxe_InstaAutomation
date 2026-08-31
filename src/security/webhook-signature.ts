const SIGNATURE_PREFIX = 'sha256='
const SIGNATURE_HEX_LENGTH = 64
const HEX_PATTERN = /^[0-9a-f]+$/i

const encoder = new TextEncoder()

function hexToBytes(hex: string): Uint8Array | null {
  if (!HEX_PATTERN.test(hex)) return null

  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Valida o header X-Hub-Signature-256 enviado pela Meta.
 *
 * Usa crypto.subtle.verify em vez de comparar strings: a comparacao interna
 * e feita em tempo constante, fechando a janela para timing attack.
 *
 * IMPORTANTE: `rawBody` precisa ser o texto CRU da requisicao. Fazer
 * JSON.parse e re-serializar muda os bytes e invalida a assinatura.
 */
export async function isValidSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith(SIGNATURE_PREFIX)) return false
  if (appSecret.length === 0) return false

  const hex = header.slice(SIGNATURE_PREFIX.length)
  if (hex.length !== SIGNATURE_HEX_LENGTH) return false

  const signature = hexToBytes(hex)
  if (!signature) return false

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(rawBody))
}
