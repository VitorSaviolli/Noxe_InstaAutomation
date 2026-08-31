import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { CommentsRepository } from '../src/repositories/comments-repository'
import { TokensRepository } from '../src/repositories/tokens-repository'

const AGORA = 1_700_000_000_000
const HORA = 60 * 60 * 1000

async function limparBanco(): Promise<void> {
  await env.DB.prepare('DELETE FROM processed_comments').run()
  await env.DB.prepare('DELETE FROM account_tokens').run()
}

describe('CommentsRepository', () => {
  let repo: CommentsRepository

  beforeEach(async () => {
    await limparBanco()
    repo = new CommentsRepository(env.DB)
  })

  test('claimComment devolve true na primeira vez', async () => {
    expect(await repo.claimComment('c1', 'm1', 'hash1', AGORA)).toBe(true)
  })

  test('claimComment devolve false para comment_id repetido', async () => {
    await repo.claimComment('c1', 'm1', 'hash1', AGORA)
    expect(await repo.claimComment('c1', 'm1', 'hash1', AGORA)).toBe(false)
  })

  test('claim concorrente do mesmo comentario: exatamente um ganha', async () => {
    const tentativas = await Promise.all([
      repo.claimComment('c-corrida', 'm1', 'hash1', AGORA),
      repo.claimComment('c-corrida', 'm1', 'hash1', AGORA),
      repo.claimComment('c-corrida', 'm1', 'hash1', AGORA),
    ])
    expect(tentativas.filter(Boolean)).toHaveLength(1)
  })

  test('o registro nasce com status processing', async () => {
    await repo.claimComment('c1', 'm1', 'hash1', AGORA)
    const registro = await repo.findByCommentId('c1')
    expect(registro?.status).toBe('processing')
    expect(registro?.attempt_count).toBe(0)
  })

  test('findByCommentId devolve null para id inexistente', async () => {
    expect(await repo.findByCommentId('nao-existe')).toBeNull()
  })

  test('markPrivateSent grava o id da mensagem e muda o status', async () => {
    await repo.claimComment('c1', 'm1', 'hash1', AGORA)
    await repo.markPrivateSent('c1', 'msg-123', AGORA)

    const registro = await repo.findByCommentId('c1')
    expect(registro?.status).toBe('private_sent')
    expect(registro?.private_message_id).toBe('msg-123')
  })

  test('markCompleted grava a resposta publica e limpa o erro', async () => {
    await repo.claimComment('c1', 'm1', 'hash1', AGORA)
    await repo.markPrivateSent('c1', 'msg-123', AGORA)
    await repo.markCompleted('c1', 'reply-456', AGORA)

    const registro = await repo.findByCommentId('c1')
    expect(registro?.status).toBe('completed')
    expect(registro?.public_reply_id).toBe('reply-456')
    expect(registro?.last_error_code).toBeNull()
    expect(registro?.next_retry_at).toBeNull()
  })

  test('scheduleRetry incrementa a contagem de tentativas', async () => {
    await repo.claimComment('c1', 'm1', 'hash1', AGORA)
    await repo.scheduleRetry('c1', AGORA + 60_000, 'HTTP_429', AGORA)
    await repo.scheduleRetry('c1', AGORA + 120_000, 'HTTP_429', AGORA)

    const registro = await repo.findByCommentId('c1')
    expect(registro?.attempt_count).toBe(2)
    expect(registro?.status).toBe('retry_pending')
    expect(registro?.last_error_code).toBe('HTTP_429')
  })

  test('findRetryPending traz apenas os vencidos', async () => {
    await repo.claimComment('vencido', 'm1', 'h1', AGORA)
    await repo.scheduleRetry('vencido', AGORA - 1000, 'HTTP_500', AGORA)

    await repo.claimComment('futuro', 'm1', 'h2', AGORA)
    await repo.scheduleRetry('futuro', AGORA + 600_000, 'HTTP_500', AGORA)

    const pendentes = await repo.findRetryPending(AGORA, 10)
    expect(pendentes.map((r) => r.comment_id)).toEqual(['vencido'])
  })

  test('findRetryPending respeita o limite', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.claimComment(`c${i}`, 'm1', 'h1', AGORA)
      await repo.scheduleRetry(`c${i}`, AGORA - 1000, 'HTTP_500', AGORA)
    }
    expect(await repo.findRetryPending(AGORA, 3)).toHaveLength(3)
  })

  test('cooldown: usuario que acabou de acionar esta bloqueado', async () => {
    await repo.claimComment('c1', 'm1', 'hash-maria', AGORA)
    await repo.markCompleted('c1', 'r1', AGORA)

    expect(await repo.isUserInCooldown('hash-maria', AGORA - 24 * HORA)).toBe(true)
  })

  test('cooldown: acionamento antigo nao bloqueia mais', async () => {
    const ONTEM = AGORA - 25 * HORA
    await repo.claimComment('c1', 'm1', 'hash-maria', ONTEM)
    await repo.markCompleted('c1', 'r1', ONTEM)

    expect(await repo.isUserInCooldown('hash-maria', AGORA - 24 * HORA)).toBe(false)
  })

  test('cooldown: outro usuario nao e afetado', async () => {
    await repo.claimComment('c1', 'm1', 'hash-maria', AGORA)
    await repo.markCompleted('c1', 'r1', AGORA)

    expect(await repo.isUserInCooldown('hash-joao', AGORA - 24 * HORA)).toBe(false)
  })

  test('cooldown: comentario ignorado nao bloqueia acionamento seguinte', async () => {
    await repo.claimComment('c1', 'm1', 'hash-maria', AGORA)
    await repo.markStatus('c1', 'ignored', AGORA)

    expect(await repo.isUserInCooldown('hash-maria', AGORA - 24 * HORA)).toBe(false)
  })
})

describe('TokensRepository', () => {
  let repo: TokensRepository

  beforeEach(async () => {
    await limparBanco()
    repo = new TokensRepository(env.DB)
  })

  test('get devolve null quando nao ha token', async () => {
    expect(await repo.get()).toBeNull()
  })

  test('save e depois get devolve o registro', async () => {
    await repo.save({
      igUserId: '178414',
      username: 'conta_teste',
      encryptedToken: 'cifrado-abc',
      expiresAt: AGORA + 60 * 24 * HORA,
      now: AGORA,
    })

    const registro = await repo.get()
    expect(registro?.ig_user_id).toBe('178414')
    expect(registro?.encrypted_token).toBe('cifrado-abc')
  })

  test('save duas vezes substitui em vez de duplicar', async () => {
    await repo.save({
      igUserId: '1',
      username: 'a',
      encryptedToken: 'primeiro',
      expiresAt: AGORA,
      now: AGORA,
    })
    await repo.save({
      igUserId: '1',
      username: 'a',
      encryptedToken: 'segundo',
      expiresAt: AGORA,
      now: AGORA,
    })

    expect((await repo.get())?.encrypted_token).toBe('segundo')

    const contagem = await env.DB.prepare('SELECT COUNT(*) AS total FROM account_tokens').first<{
      total: number
    }>()
    expect(contagem?.total).toBe(1)
  })

  test('clear remove o token', async () => {
    await repo.save({
      igUserId: '1',
      username: 'a',
      encryptedToken: 'x',
      expiresAt: AGORA,
      now: AGORA,
    })
    await repo.clear()
    expect(await repo.get()).toBeNull()
  })
})
