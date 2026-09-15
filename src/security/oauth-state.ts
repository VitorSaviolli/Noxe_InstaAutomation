/**
 * Protecao CSRF do fluxo OAuth.
 *
 * O Worker e stateless, entao em vez de guardar o `state` numa sessao ele e
 * ASSINADO com HMAC-SHA256 e carrega o proprio prazo de validade. O callback
 * so precisa recalcular a assinatura, sem round trip ao banco.
 *
 * Formato: base64url(nonce) "." expiraEm "." base64url(hmac)
 */

import { bytesToBase64Url } from './base64url'

const encoder = new TextEncoder()
const NONCE_BYTES = 16
const SEPARATOR = '.'

/** Janela de validade do state. Curta: o usuario autoriza em segundos. */
export const STATE_TTL_MS = 10 * 60 * 1000

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return bytesToBase64Url(new Uint8Array(mac))
}

/**
 * Cria um `state` assinado.
 *
 * `now` e injetado para tornar o modulo testavel sem mockar o relogio.
 */
export async function createState(secret: string, now: number): Promise<string> {
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)))
  const expiresAt = now + STATE_TTL_MS
  const payload = `${nonce}${SEPARATOR}${expiresAt}`
  const signature = await sign(payload, secret)

  return `${payload}${SEPARATOR}${signature}`
}

export type StateValidation =
  | { valid: true }
  | { valid: false; reason: 'malformado' | 'expirado' | 'assinatura_invalida' }

/**
 * Valida um `state` recebido no callback do OAuth.
 *
 * Verifica assinatura ANTES do prazo: um state forjado nao deve conseguir
 * distinguir "expirado" de "assinatura invalida" pela mensagem de erro.
 */
export async function validateState(
  state: string,
  secret: string,
  now: number,
): Promise<StateValidation> {
  const parts = state.split(SEPARATOR)
  if (parts.length !== 3) return { valid: false, reason: 'malformado' }

  const [nonce, expiresAtRaw, signature] = parts as [string, string, string]
  const payload = `${nonce}${SEPARATOR}${expiresAtRaw}`

  const expected = await sign(payload, secret)
  if (expected.length !== signature.length) {
    return { valid: false, reason: 'assinatura_invalida' }
  }

  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  if (diff !== 0) return { valid: false, reason: 'assinatura_invalida' }

  const expiresAt = Number.parseInt(expiresAtRaw, 10)
  if (!Number.isFinite(expiresAt)) return { valid: false, reason: 'malformado' }
  if (now > expiresAt) return { valid: false, reason: 'expirado' }

  return { valid: true }
}
