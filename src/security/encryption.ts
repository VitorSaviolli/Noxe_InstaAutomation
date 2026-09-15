/**
 * Criptografia AES-GCM do access token guardado no D1.
 *
 * Formato do texto cifrado: base64( IV[12 bytes] || ciphertext+tag ).
 * O IV e aleatorio por operacao, reutilizar IV em GCM quebra o esquema.
 */

const ALGORITHM = 'AES-GCM'
const IV_LENGTH = 12
const KEY_LENGTH_BYTES = 32

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionError'
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * Importa a chave a partir do segredo TOKEN_ENCRYPTION_KEY (base64, 32 bytes).
 *
 * Falha ruidosamente se a chave tiver tamanho errado: um deploy com chave
 * invalida deve quebrar no setup, nao no primeiro webhook.
 */
async function importKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array
  try {
    raw = base64ToBytes(base64Key)
  } catch {
    throw new EncryptionError('TOKEN_ENCRYPTION_KEY nao e base64 valido')
  }

  if (raw.length !== KEY_LENGTH_BYTES) {
    throw new EncryptionError(
      `TOKEN_ENCRYPTION_KEY precisa ter ${KEY_LENGTH_BYTES} bytes, recebeu ${raw.length}`,
    )
  }

  return crypto.subtle.importKey('raw', raw, ALGORITHM, false, ['encrypt', 'decrypt'])
}

/** Cifra texto puro. Devolve base64(IV || ciphertext). */
export async function encrypt(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoder.encode(plaintext),
  )

  const packed = new Uint8Array(iv.length + ciphertext.byteLength)
  packed.set(iv, 0)
  packed.set(new Uint8Array(ciphertext), iv.length)

  return bytesToBase64(packed)
}

/** Decifra o formato produzido por `encrypt`. */
export async function decrypt(payload: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key)

  let packed: Uint8Array
  try {
    packed = base64ToBytes(payload)
  } catch {
    throw new EncryptionError('Payload cifrado nao e base64 valido')
  }

  if (packed.length <= IV_LENGTH) {
    throw new EncryptionError('Payload cifrado truncado')
  }

  const iv = packed.slice(0, IV_LENGTH)
  const ciphertext = packed.slice(IV_LENGTH)

  try {
    const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext)
    return decoder.decode(plaintext)
  } catch {
    // Chave trocada ou dado corrompido. Nao vaza detalhe para o chamador.
    throw new EncryptionError('Falha ao decifrar: chave incorreta ou dado corrompido')
  }
}

/** Gera uma chave AES-GCM de 32 bytes em base64. Usado por scripts/. */
export function generateEncryptionKey(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(KEY_LENGTH_BYTES)))
}
