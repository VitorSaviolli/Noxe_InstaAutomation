import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { type AutomationConfig, automationConfig } from '../src/config'
import { CommentsRepository } from '../src/repositories/comments-repository'
import { computeNextRetry, evaluateComment, processComment } from '../src/services/automation'
import type { MetaApiClient } from '../src/services/meta-api'
import type { ApiError, CommentEvent } from '../src/types/meta'

const AGORA = 1_700_000_000_000
const IG_USER_ID = '17841400000000000'
const USERNAME_CONTA = 'conta_de_teste'

/** Config de teste: o link precisa estar preenchido para a automacao rodar. */
function configTeste(patch: Partial<AutomationConfig> = {}): AutomationConfig {
  return { ...automationConfig, destinationUrl: 'https://exemplo.com/link', ...patch }
}

function evento(patch: Partial<CommentEvent> = {}): CommentEvent {
  return {
    commentId: 'comment-1',
    mediaId: 'media-1',
    fromId: 'igsid-visitante',
    fromUsername: 'visitante',
    text: 'eu quero',
    parentId: null,
    mediaProductType: 'REELS',
    ...patch,
  }
}

function erro(shortCode: string, status = 500): ApiError {
  return { status, code: null, subcode: null, message: 'erro simulado', shortCode }
}

interface RespostasFalsas {
  privateReply?: { ok: boolean; messageId?: string; erro?: ApiError }
  publicReply?: { ok: boolean; replyId?: string; erro?: ApiError }
  mediaProductType?: string
  mediaInfoFalha?: boolean
}

/**
 * Duble da API da Meta. Registra as chamadas na ORDEM em que ocorrem, que e
 * o que permite provar que o Direct sai antes da resposta publica.
 */
class ApiFalsa {
  readonly chamadas: string[] = []
  readonly textosEnviados: string[] = []

  constructor(private readonly respostas: RespostasFalsas = {}) {}

  async sendPrivateReply(_ig: string, _comment: string, text: string) {
    this.chamadas.push('private')
    this.textosEnviados.push(text)
    const r = this.respostas.privateReply ?? { ok: true, messageId: 'msg-1' }
    if (!r.ok) return { ok: false as const, error: r.erro ?? erro('HTTP_500') }
    return { ok: true as const, data: { message_id: r.messageId ?? 'msg-1' } }
  }

  async replyToComment(_comment: string, _message: string) {
    this.chamadas.push('public')
    const r = this.respostas.publicReply ?? { ok: true, replyId: 'reply-1' }
    if (!r.ok) return { ok: false as const, error: r.erro ?? erro('HTTP_500') }
    return { ok: true as const, data: { id: r.replyId ?? 'reply-1' } }
  }

  async getMediaInfo(_mediaId: string) {
    this.chamadas.push('mediaInfo')
    if (this.respostas.mediaInfoFalha) {
      return { ok: false as const, error: erro('NETWORK', 0) }
    }
    return {
      ok: true as const,
      data: { id: 'media-1', media_product_type: this.respostas.mediaProductType ?? 'REELS' },
    }
  }
}

function comoApi(falsa: ApiFalsa): MetaApiClient {
  return falsa as unknown as MetaApiClient
}

async function limpar(): Promise<void> {
  await env.DB.prepare('DELETE FROM processed_comments').run()
}

describe('evaluateComment (decisao pura)', () => {
  test('aceita comentario com a palavra exata', () => {
    const r = evaluateComment(evento(), configTeste(), IG_USER_ID, USERNAME_CONTA)
    expect(r).toEqual({ process: true, keyword: 'eu quero' })
  })

  test('ignora quando a automacao esta desligada', () => {
    const r = evaluateComment(evento(), configTeste({ enabled: false }), IG_USER_ID, USERNAME_CONTA)
    expect(r).toEqual({ process: false, reason: 'automacao_desligada' })
  })

  test('ignora comentario da propria conta pelo fromId', () => {
    const r = evaluateComment(
      evento({ fromId: IG_USER_ID }),
      configTeste(),
      IG_USER_ID,
      USERNAME_CONTA,
    )
    expect(r).toEqual({ process: false, reason: 'comentario_proprio' })
  })

  test('ignora comentario da propria conta pelo username', () => {
    const r = evaluateComment(
      evento({ fromUsername: USERNAME_CONTA }),
      configTeste(),
      IG_USER_ID,
      USERNAME_CONTA,
    )
    expect(r).toEqual({ process: false, reason: 'comentario_proprio' })
  })

  test('ignora resposta dentro de uma thread', () => {
    const r = evaluateComment(
      evento({ parentId: 'comment-pai' }),
      configTeste(),
      IG_USER_ID,
      USERNAME_CONTA,
    )
    expect(r).toEqual({ process: false, reason: 'resposta_a_comentario' })
  })

  test('ignora midia fora da lista permitida', () => {
    const r = evaluateComment(
      evento(),
      configTeste({ allowedMediaIds: ['outra-midia'] }),
      IG_USER_ID,
      USERNAME_CONTA,
    )
    expect(r).toEqual({ process: false, reason: 'midia_nao_permitida' })
  })

  test('ignora texto que nao casa com o gatilho', () => {
    const r = evaluateComment(
      evento({ text: 'que legal!' }),
      configTeste(),
      IG_USER_ID,
      USERNAME_CONTA,
    )
    expect(r).toEqual({ process: false, reason: 'sem_correspondencia' })
  })

  test('ignora quando o link ainda esta com o placeholder', () => {
    const r = evaluateComment(
      evento(),
      configTeste({ destinationUrl: '[COLOQUE_O_LINK_AQUI]' }),
      IG_USER_ID,
      USERNAME_CONTA,
    )
    expect(r).toEqual({ process: false, reason: 'link_nao_configurado' })
  })
})

describe('processComment (fluxo completo)', () => {
  let repo: CommentsRepository

  beforeEach(async () => {
    await limpar()
    repo = new CommentsRepository(env.DB)
  })

  function deps(api: ApiFalsa, config = configTeste(), extra: Record<string, unknown> = {}) {
    return {
      api: comoApi(api),
      repo,
      igUserId: IG_USER_ID,
      accountUsername: USERNAME_CONTA,
      config,
      now: AGORA,
      ...extra,
    }
  }

  test('caminho feliz: Direct e depois resposta publica', async () => {
    const api = new ApiFalsa()
    const r = await processComment(evento(), deps(api))

    expect(r).toEqual({ kind: 'completed', privateMessageId: 'msg-1', publicReplyId: 'reply-1' })
    expect(api.chamadas).toEqual(['private', 'public'])
  })

  test('a ORDEM importa: o Direct sai antes da resposta publica', async () => {
    const api = new ApiFalsa()
    await processComment(evento(), deps(api))
    expect(api.chamadas.indexOf('private')).toBeLessThan(api.chamadas.indexOf('public'))
  })

  test('grava o estado completed no banco', async () => {
    await processComment(evento(), deps(new ApiFalsa()))
    const registro = await repo.findByCommentId('comment-1')
    expect(registro?.status).toBe('completed')
    expect(registro?.private_message_id).toBe('msg-1')
    expect(registro?.public_reply_id).toBe('reply-1')
  })

  test('falha no Direct NAO publica resposta publica', async () => {
    const api = new ApiFalsa({
      privateReply: { ok: false, erro: erro('REQUISICAO_INVALIDA', 400) },
    })
    const r = await processComment(evento(), deps(api))

    expect(r).toEqual({ kind: 'failed', errorCode: 'REQUISICAO_INVALIDA' })
    expect(api.chamadas).not.toContain('public')
  })

  test('erro 429 no Direct agenda nova tentativa', async () => {
    const api = new ApiFalsa({ privateReply: { ok: false, erro: erro('RATE_LIMIT', 429) } })
    const r = await processComment(evento(), deps(api))

    expect(r.kind).toBe('retry')
    const registro = await repo.findByCommentId('comment-1')
    expect(registro?.status).toBe('retry_pending')
    expect(registro?.last_error_code).toBe('RATE_LIMIT')
  })

  test('erro 5xx no Direct agenda nova tentativa', async () => {
    const api = new ApiFalsa({ privateReply: { ok: false, erro: erro('HTTP_503', 503) } })
    const r = await processComment(evento(), deps(api))
    expect(r.kind).toBe('retry')
  })

  test('token expirado NAO e retentado', async () => {
    const api = new ApiFalsa({ privateReply: { ok: false, erro: erro('TOKEN_INVALIDO', 401) } })
    const r = await processComment(evento(), deps(api))

    expect(r).toEqual({ kind: 'failed', errorCode: 'TOKEN_INVALIDO' })
    expect((await repo.findByCommentId('comment-1'))?.status).toBe('failed')
  })

  test('falha na resposta publica apos Direct enviado vira uncertain', async () => {
    const api = new ApiFalsa({ publicReply: { ok: false, erro: erro('HTTP_500') } })
    const r = await processComment(evento(), deps(api))

    expect(r).toEqual({ kind: 'uncertain', errorCode: 'HTTP_500' })
    const registro = await repo.findByCommentId('comment-1')
    expect(registro?.status).toBe('uncertain')
    // O Direct saiu: o id precisa estar gravado para nao reenviar as cegas.
    expect(registro?.private_message_id).toBe('msg-1')
  })

  test('comentario duplicado nao envia nada na segunda vez', async () => {
    await processComment(evento(), deps(new ApiFalsa()))

    const segunda = new ApiFalsa()
    const r = await processComment(evento(), deps(segunda))

    expect(r).toEqual({ kind: 'skipped', reason: 'ja_processado' })
    expect(segunda.chamadas).not.toContain('private')
  })

  test('publicacao que nao e Reel e ignorada', async () => {
    const api = new ApiFalsa()
    const r = await processComment(evento({ mediaProductType: 'FEED' }), deps(api))

    expect(r).toEqual({ kind: 'skipped', reason: 'nao_e_reel' })
    expect(api.chamadas).toHaveLength(0)
  })

  test('consulta a API quando o webhook nao informa o tipo da midia', async () => {
    const api = new ApiFalsa({ mediaProductType: 'REELS' })
    const r = await processComment(evento({ mediaProductType: null }), deps(api))

    expect(api.chamadas[0]).toBe('mediaInfo')
    expect(r.kind).toBe('completed')
  })

  test('na duvida sobre o tipo da midia, nao processa', async () => {
    const api = new ApiFalsa({ mediaInfoFalha: true })
    const r = await processComment(evento({ mediaProductType: null }), deps(api))

    expect(r).toEqual({ kind: 'skipped', reason: 'nao_e_reel' })
    expect(api.chamadas).not.toContain('private')
  })

  test('processa foto quando processOnlyReels esta desligado', async () => {
    const api = new ApiFalsa()
    const r = await processComment(
      evento({ mediaProductType: 'FEED' }),
      deps(api, configTeste({ processOnlyReels: false })),
    )
    expect(r.kind).toBe('completed')
  })

  test('cooldown bloqueia o segundo acionamento do mesmo usuario', async () => {
    await processComment(evento(), deps(new ApiFalsa()))

    const api = new ApiFalsa()
    const r = await processComment(evento({ commentId: 'comment-2' }), deps(api))

    expect(r).toEqual({ kind: 'skipped', reason: 'usuario_em_cooldown' })
    expect(api.chamadas).toHaveLength(0)
  })

  test('cooldown nao afeta usuario diferente', async () => {
    await processComment(evento(), deps(new ApiFalsa()))

    const r = await processComment(
      evento({ commentId: 'comment-2', fromId: 'igsid-outro' }),
      deps(new ApiFalsa()),
    )
    expect(r.kind).toBe('completed')
  })

  test('comentario fora da janela de 7 dias e ignorado', async () => {
    const api = new ApiFalsa()
    const oitoDias = AGORA - 8 * 24 * 60 * 60 * 1000
    const r = await processComment(
      evento(),
      deps(api, configTeste(), { commentCreatedAt: oitoDias }),
    )

    expect(r).toEqual({ kind: 'skipped', reason: 'fora_da_janela' })
    expect(api.chamadas).not.toContain('private')
  })

  test('substitui {username} e {link} na mensagem privada', async () => {
    const api = new ApiFalsa()
    await processComment(evento({ fromUsername: 'maria' }), deps(api))

    expect(api.textosEnviados[0]).toBe(
      'Olá, maria! Aqui está o link que você pediu: https://exemplo.com/link',
    )
  })

  test('sem resposta publica quando publicReplyEnabled e false', async () => {
    const api = new ApiFalsa()
    const r = await processComment(evento(), deps(api, configTeste({ publicReplyEnabled: false })))

    expect(r.kind).toBe('private_sent_only')
    expect(api.chamadas).toEqual(['private'])
  })
})

describe('espera exponencial', () => {
  test('cresce a cada tentativa', () => {
    expect(computeNextRetry(0, AGORA)).toBe(AGORA + 60_000)
    expect(computeNextRetry(1, AGORA)).toBe(AGORA + 240_000)
    expect(computeNextRetry(2, AGORA)).toBe(AGORA + 960_000)
  })
})
