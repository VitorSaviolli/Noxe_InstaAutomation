import { env } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import { handleWebhookVerification, parseCommentEvents } from '../src/routes/webhook'

const VERIFY_TOKEN = 'verify-token-de-teste'

function urlDe(query: Record<string, string>): URL {
  const url = new URL('https://exemplo.workers.dev/webhooks/instagram')
  for (const [chave, valor] of Object.entries(query)) {
    url.searchParams.set(chave, valor)
  }
  return url
}

/** Monta um change de comentario com os campos que o parser exige. */
function change(value: Record<string, unknown>) {
  return { field: 'comments', value }
}

function payload(changes: unknown[]): string {
  return JSON.stringify({ object: 'instagram', entry: [{ id: 'conta', changes }] })
}

describe('handshake de verificacao do webhook', () => {
  test('devolve o challenge cru com 200 quando o token confere', async () => {
    const resposta = handleWebhookVerification(
      urlDe({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      }),
      env,
    )

    expect(resposta.status).toBe(200)
    expect(await resposta.text()).toBe('1158201444')
    expect(resposta.headers.get('content-type')).toContain('text/plain')
  })

  test('recusa com 403 quando o verify token esta errado', () => {
    const resposta = handleWebhookVerification(
      urlDe({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'token-errado',
        'hub.challenge': '123',
      }),
      env,
    )
    expect(resposta.status).toBe(403)
  })

  test('recusa com 403 quando o mode nao e subscribe', () => {
    const resposta = handleWebhookVerification(
      urlDe({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '123',
      }),
      env,
    )
    expect(resposta.status).toBe(403)
  })

  test('recusa com 403 quando falta o verify token', () => {
    const resposta = handleWebhookVerification(
      urlDe({ 'hub.mode': 'subscribe', 'hub.challenge': '123' }),
      env,
    )
    expect(resposta.status).toBe(403)
  })

  test('devolve 400 quando falta o challenge', () => {
    const resposta = handleWebhookVerification(
      urlDe({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }),
      env,
    )
    expect(resposta.status).toBe(400)
  })
})

describe('parseCommentEvents (parsing defensivo)', () => {
  const completo = {
    id: 'comment-123',
    text: 'eu quero',
    from: { id: 'igsid-abc', username: 'visitante' },
    media: { id: 'media-456', media_product_type: 'REELS' },
  }

  test('extrai um evento completo', () => {
    const eventos = parseCommentEvents(payload([change(completo)]))

    expect(eventos).toHaveLength(1)
    expect(eventos[0]).toEqual({
      commentId: 'comment-123',
      mediaId: 'media-456',
      fromId: 'igsid-abc',
      fromUsername: 'visitante',
      text: 'eu quero',
      parentId: null,
      mediaProductType: 'REELS',
    })
  })

  test('captura parent_id quando presente', () => {
    const eventos = parseCommentEvents(payload([change({ ...completo, parent_id: 'comment-pai' })]))
    expect(eventos[0]?.parentId).toBe('comment-pai')
  })

  test('devolve lista vazia para JSON invalido', () => {
    expect(parseCommentEvents('nao e json')).toEqual([])
  })

  test('devolve lista vazia quando falta entry', () => {
    expect(parseCommentEvents(JSON.stringify({ object: 'instagram' }))).toEqual([])
  })

  test('entry que nao e array nao quebra', () => {
    expect(parseCommentEvents(JSON.stringify({ entry: 'nao e array' }))).toEqual([])
  })

  test('ignora change de outro field', () => {
    const outro = JSON.stringify({
      entry: [{ changes: [{ field: 'messages', value: { id: 'x' } }] }],
    })
    expect(parseCommentEvents(outro)).toEqual([])
  })

  test('descarta evento sem comment id', () => {
    const { id: _id, ...semId } = completo
    expect(parseCommentEvents(payload([change(semId)]))).toEqual([])
  })

  test('descarta evento sem texto', () => {
    const { text: _text, ...semTexto } = completo
    expect(parseCommentEvents(payload([change(semTexto)]))).toEqual([])
  })

  test('descarta evento sem media id', () => {
    const { media: _media, ...semMedia } = completo
    expect(parseCommentEvents(payload([change(semMedia)]))).toEqual([])
  })

  test('descarta evento sem from id', () => {
    const semFrom = { ...completo, from: { username: 'visitante' } }
    expect(parseCommentEvents(payload([change(semFrom)]))).toEqual([])
  })

  test('username ausente vira string vazia em vez de quebrar', () => {
    const semUsername = { ...completo, from: { id: 'igsid-abc' } }
    expect(parseCommentEvents(payload([change(semUsername)]))[0]?.fromUsername).toBe('')
  })

  test('media_product_type ausente vira null', () => {
    const semTipo = { ...completo, media: { id: 'media-456' } }
    expect(parseCommentEvents(payload([change(semTipo)]))[0]?.mediaProductType).toBeNull()
  })

  test('processa varios eventos no mesmo lote', () => {
    const segundo = { ...completo, id: 'comment-2', from: { id: 'igsid-2', username: 'outro' } }
    expect(parseCommentEvents(payload([change(completo), change(segundo)]))).toHaveLength(2)
  })

  test('um evento invalido no lote nao descarta os validos', () => {
    const eventos = parseCommentEvents(payload([change({ id: 'incompleto' }), change(completo)]))
    expect(eventos).toHaveLength(1)
    expect(eventos[0]?.commentId).toBe('comment-123')
  })

  test('texto vazio e descartado', () => {
    expect(parseCommentEvents(payload([change({ ...completo, text: '' })]))).toEqual([])
  })
})
