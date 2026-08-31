import { timingSafeEqual } from '../security/constant-time'
import { isValidSignature } from '../security/webhook-signature'
import type { Env } from '../types/env'
import type { CommentEvent } from '../types/meta'

/** Corpo maior que isso e descartado antes de qualquer parsing. */
const MAX_BODY_BYTES = 512 * 1024

/**
 * Handshake de verificacao do webhook.
 *
 * A Meta chama este GET quando voce clica em "Verificar e salvar" no painel.
 * A resposta precisa ser 200 com o hub.challenge CRU no corpo — texto puro,
 * sem JSON e sem aspas. Qualquer outra coisa e a Meta recusa a configuracao.
 */
export function handleWebhookVerification(url: URL, env: Env): Response {
  const params = url.searchParams
  const mode = params.get('hub.mode')
  const token = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')

  if (mode !== 'subscribe' || token === null) {
    return new Response('Forbidden', { status: 403 })
  }

  if (!timingSafeEqual(token, env.META_WEBHOOK_VERIFY_TOKEN)) {
    console.warn('Handshake recusado: verify token nao confere')
    return new Response('Forbidden', { status: 403 })
  }

  if (challenge === null) {
    return new Response('Missing hub.challenge', { status: 400 })
  }

  console.log('Handshake do webhook concluido')
  return new Response(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  })
}

export type WebhookParse =
  | { ok: true; events: CommentEvent[] }
  | { ok: false; status: number; reason: string }

/**
 * Le e valida a requisicao POST do webhook.
 *
 * Ordem importa: tamanho -> assinatura -> parsing. Nunca fazemos JSON.parse
 * antes de validar a assinatura, e a assinatura e conferida sobre o texto
 * CRU (re-serializar mudaria os bytes e invalidaria o HMAC).
 */
export async function readWebhookRequest(request: Request, env: Env): Promise<WebhookParse> {
  const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, reason: 'payload_muito_grande' }
  }

  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, reason: 'payload_muito_grande' }
  }

  const signature = request.headers.get('x-hub-signature-256')
  if (!(await isValidSignature(rawBody, signature, env.META_APP_SECRET))) {
    return { ok: false, status: 401, reason: 'assinatura_invalida' }
  }

  return { ok: true, events: parseCommentEvents(rawBody) }
}

/** Le uma propriedade string de um objeto desconhecido. */
function readString(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readObject(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return null
  return (source as Record<string, unknown>)[key] ?? null
}

/**
 * Extrai eventos de comentario de forma defensiva.
 *
 * Qualquer entrada malformada e simplesmente ignorada — um payload
 * inesperado nunca deve derrubar o Worker nem impedir que os OUTROS
 * eventos do mesmo lote sejam processados.
 */
export function parseCommentEvents(rawBody: string): CommentEvent[] {
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    console.warn('Payload do webhook nao e JSON valido')
    return []
  }

  const entries = readObject(payload, 'entry')
  if (!Array.isArray(entries)) return []

  const events: CommentEvent[] = []

  for (const entry of entries) {
    const changes = readObject(entry, 'changes')
    if (!Array.isArray(changes)) continue

    for (const change of changes) {
      if (readString(change, 'field') !== 'comments') continue

      const value = readObject(change, 'value')
      const commentId = readString(value, 'id')
      const text = readString(value, 'text')
      const from = readObject(value, 'from')
      const media = readObject(value, 'media')
      const fromId = readString(from, 'id')
      const mediaId = readString(media, 'id')

      // Sem qualquer um destes o evento e inutilizavel.
      if (!commentId || !text || !fromId || !mediaId) continue

      events.push({
        commentId,
        mediaId,
        fromId,
        fromUsername: readString(from, 'username') ?? '',
        text,
        parentId: readString(value, 'parent_id'),
        mediaProductType: readString(media, 'media_product_type'),
      })
    }
  }

  return events
}
