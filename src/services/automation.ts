import { type AutomationConfig, isDestinationUrlConfigured, isMediaAllowed } from '../config'
import type { CommentsRepository } from '../repositories/comments-repository'
import type { CommentEvent } from '../types/meta'
import { sha256Hex } from '../utils/hash'
import { matchKeyword, normalizeOptionsFrom } from '../utils/normalize'
import { renderTemplate } from '../utils/templates'
import { isRetryable, type MetaApiClient, PRIVATE_REPLY_WINDOW_MS } from './meta-api'

/**
 * Orquestracao de um comentario.
 *
 * A ordem e deliberada e nao pode ser invertida:
 *   claim no banco -> Direct -> resposta publica
 *
 * O claim vem primeiro porque a Meta permite UMA unica private reply por
 * comentario; sem o claim atomico, um webhook reentregue tentaria mandar a
 * segunda e falharia. O Direct vem antes da resposta publica porque a
 * resposta publica anuncia que o Direct foi enviado — publicar primeiro
 * significaria mentir para quem comentou quando o envio falha.
 */

/** Motivos para nao processar. Viram status `ignored` no banco. */
export type SkipReason =
  | 'automacao_desligada'
  | 'comentario_proprio'
  | 'resposta_a_comentario'
  | 'midia_nao_permitida'
  | 'nao_e_reel'
  | 'sem_correspondencia'
  | 'link_nao_configurado'
  | 'usuario_em_cooldown'
  | 'ja_processado'
  | 'fora_da_janela'

export type ProcessOutcome =
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'completed'; privateMessageId: string | null; publicReplyId: string | null }
  | { kind: 'private_sent_only'; privateMessageId: string | null }
  | { kind: 'retry'; errorCode: string; nextRetryAt: number }
  | { kind: 'failed'; errorCode: string }
  | { kind: 'uncertain'; errorCode: string }

export interface ProcessDeps {
  api: MetaApiClient
  repo: CommentsRepository
  /** ID da conta profissional: usado no path de /messages e no anti-loop. */
  igUserId: string
  /** Username da conta, para descartar comentarios da propria conta. */
  accountUsername: string
  config: AutomationConfig
  now: number
  /** Momento em que o comentario foi criado, se conhecido. */
  commentCreatedAt?: number
}

/** Espera exponencial: 1min, 4min, 16min. */
const RETRY_BASE_MS = 60_000
const MAX_ATTEMPTS = 3

export function computeNextRetry(attemptCount: number, now: number): number {
  return now + RETRY_BASE_MS * 4 ** attemptCount
}

/** Marca de um Reel no campo media_product_type. */
const REELS_PRODUCT_TYPE = 'REELS'

/**
 * Decide se o comentario deve ser processado, sem tocar em rede nem banco.
 *
 * Separado de proposito: e a parte com mais regra de negocio e a que mais
 * precisa de teste, entao fica pura.
 */
export function evaluateComment(
  event: CommentEvent,
  config: AutomationConfig,
  igUserId: string,
  accountUsername: string,
): { process: true; keyword: string } | { process: false; reason: SkipReason } {
  if (!config.enabled) return { process: false, reason: 'automacao_desligada' }

  // Anti-loop: a resposta publica da propria conta gera um novo evento.
  const proprio =
    event.fromId === igUserId ||
    (accountUsername.length > 0 && event.fromUsername === accountUsername)
  if (proprio) return { process: false, reason: 'comentario_proprio' }

  // Respostas dentro de uma thread nao devem acionar a automacao.
  if (event.parentId !== null) return { process: false, reason: 'resposta_a_comentario' }

  if (!isMediaAllowed(event.mediaId, config)) {
    return { process: false, reason: 'midia_nao_permitida' }
  }

  const keyword = matchKeyword(
    event.text,
    config.triggerKeywords,
    config.matchMode,
    normalizeOptionsFrom(config),
  )
  if (keyword === null) return { process: false, reason: 'sem_correspondencia' }

  if (!isDestinationUrlConfigured(config)) {
    return { process: false, reason: 'link_nao_configurado' }
  }

  return { process: true, keyword }
}

/**
 * Confirma o Reel com o que veio no proprio webhook, sem tocar a rede.
 *
 * `null` significa "o webhook nao informou" — quem chama decide se paga uma
 * consulta a Meta para saber ou se desiste. Separado de `isReel` porque o
 * reagendamento do excedente do lote (§16.1) so pode usar o caminho gratuito.
 */
export function isReelFromEvent(event: CommentEvent): boolean | null {
  if (event.mediaProductType === null) return null
  return event.mediaProductType.toUpperCase() === REELS_PRODUCT_TYPE
}

/**
 * Confirma que a midia e um Reel.
 *
 * O webhook as vezes traz `media_product_type`; quando nao traz, consultamos
 * a API. Em caso de duvida (falha da consulta) NAO processamos — e melhor
 * perder um acionamento do que responder na publicacao errada.
 */
async function isReel(event: CommentEvent, api: MetaApiClient): Promise<boolean> {
  const doWebhook = isReelFromEvent(event)
  if (doWebhook !== null) return doWebhook

  const info = await api.getMediaInfo(event.mediaId)
  if (!info.ok) {
    console.warn('Nao foi possivel confirmar o tipo da midia:', info.error.shortCode)
    return false
  }

  return (info.data.media_product_type ?? '').toUpperCase() === REELS_PRODUCT_TYPE
}

/**
 * Processa um comentario de ponta a ponta.
 *
 * Nunca lanca: toda falha vira um ProcessOutcome, porque isto roda dentro de
 * ctx.waitUntil e uma excecao nao tratada perderia o evento em silencio.
 */
export async function processComment(
  event: CommentEvent,
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  const { api, repo, config, now } = deps

  const veredito = evaluateComment(event, config, deps.igUserId, deps.accountUsername)
  if (!veredito.process) return { kind: 'skipped', reason: veredito.reason }

  if (config.processOnlyReels && !(await isReel(event, api))) {
    return { kind: 'skipped', reason: 'nao_e_reel' }
  }

  // A private reply so e aceita ate 7 dias apos a criacao do comentario.
  if (
    deps.commentCreatedAt !== undefined &&
    now - deps.commentCreatedAt > PRIVATE_REPLY_WINDOW_MS
  ) {
    return { kind: 'skipped', reason: 'fora_da_janela' }
  }

  const commenterHash = await sha256Hex(event.fromId)

  // Dedup explicito ANTES do cooldown: um webhook reentregue precisa
  // reportar "ja processado", nao ser confundido com o cooldown do usuario.
  if (await repo.findByCommentId(event.commentId)) {
    return { kind: 'skipped', reason: 'ja_processado' }
  }

  const cooldownDesde = now - config.userCooldownHours * 60 * 60 * 1000
  if (await repo.isUserInCooldown(commenterHash, cooldownDesde)) {
    return { kind: 'skipped', reason: 'usuario_em_cooldown' }
  }

  // Claim atomico: se outro processo ja pegou, paramos aqui.
  const ganhou = await repo.claimComment(event.commentId, event.mediaId, commenterHash, now)
  if (!ganhou) return { kind: 'skipped', reason: 'ja_processado' }

  return deliver(event, deps)
}

/** Envia o Direct e, so entao, a resposta publica. */
async function deliver(event: CommentEvent, deps: ProcessDeps): Promise<ProcessOutcome> {
  const { api, repo, config, now } = deps

  let privateMessageId: string | null = null

  if (config.privateReplyEnabled) {
    const texto = renderTemplate(config.privateReplyText, {
      username: event.fromUsername,
      link: config.destinationUrl,
    })

    const envio = await api.sendPrivateReply(deps.igUserId, event.commentId, texto)

    if (!envio.ok) {
      const { shortCode } = envio.error
      console.warn('Falha no Direct:', shortCode)

      const registro = await repo.findByCommentId(event.commentId)
      const tentativas = registro?.attempt_count ?? 0

      if (isRetryable(shortCode) && tentativas < MAX_ATTEMPTS) {
        const nextRetryAt = computeNextRetry(tentativas, now)
        await repo.scheduleRetry(event.commentId, nextRetryAt, shortCode, now)
        return { kind: 'retry', errorCode: shortCode, nextRetryAt }
      }

      // Definitivo. NAO publicamos resposta publica: ela anunciaria um
      // Direct que nao foi enviado.
      await repo.markStatus(event.commentId, 'failed', now, shortCode)
      return { kind: 'failed', errorCode: shortCode }
    }

    privateMessageId = envio.data.message_id ?? null
    await repo.markPrivateSent(event.commentId, privateMessageId, now)
  }

  if (!config.publicReplyEnabled) {
    return { kind: 'private_sent_only', privateMessageId }
  }

  const resposta = await api.replyToComment(event.commentId, config.publicReplyText)

  if (!resposta.ok) {
    // O Direct JA foi enviado. Retentar a resposta publica e seguro (ela nao
    // tem limite de 1), mas o estado precisa refletir que a parte
    // irreversivel ja aconteceu.
    const { shortCode } = resposta.error
    console.warn('Falha na resposta publica (Direct ja enviado):', shortCode)
    await repo.markStatus(event.commentId, 'uncertain', now, shortCode)
    return { kind: 'uncertain', errorCode: shortCode }
  }

  await repo.markCompleted(event.commentId, resposta.data.id, now)
  return { kind: 'completed', privateMessageId, publicReplyId: resposta.data.id }
}
