/**
 * ============================================================
 * noxe-insta-automation — ponto de entrada do Worker
 * ============================================================
 *
 * Software SEM FINS LUCRATIVOS.
 *
 * Este projeto nao rouba e nao coleta informacoes de ninguem. Tudo o que ele
 * guarda fica no SEU banco de dados D1, dentro da SUA conta da Cloudflare:
 * o IGSID de quem comentou e gravado apenas como SHA-256, o texto do
 * comentario e o username nao sao armazenados, e o token do Instagram fica
 * cifrado com AES-GCM. Nada e enviado ao autor deste codigo nem a terceiros —
 * nao existe servidor nosso no meio. Os detalhes estao na politica de
 * privacidade servida em /privacy-policy e no SECURITY.md.
 *
 * Desenvolvido por Vitor S. Gonsalez — Noxelora.
 *
 * Se o projeto deu certo para voce, deixe uma estrela no GitHub. E totalmente
 * de graca e ajuda outras pessoas a encontrarem o projeto:
 *   https://github.com/VitorSaviolli/Noxe_InstaAutomation
 *
 * Quer apoiar? PIX: saviolligonsalez@gmail.com
 * Doacoes ajudam a manter projetos como este 100% gratuitos.
 *
 * Licenca MIT — veja o arquivo LICENSE.
 * ============================================================
 */
import { type AutomationConfig, automationConfig, resolveConfigForMedia } from './config'
import { CommentsRepository, type DeferredComment } from './repositories/comments-repository'
import { TokensRepository } from './repositories/tokens-repository'
import { handleHealth } from './routes/health'
import { handleDataDeletion, handlePrivacyPolicy } from './routes/legal'
import {
  CALLBACK_PATH,
  handleAuthorizeStart,
  handleOAuthCallback,
  handleSubscribe,
} from './routes/oauth'
import { handleWebhookVerification, readWebhookRequest } from './routes/webhook'
import { evaluateComment, isReelFromEvent, processComment } from './services/automation'
import { MetaApiClient } from './services/meta-api'
import {
  loadAccessToken,
  refreshLongLivedToken,
  shouldRefresh,
  storeAccessToken,
} from './services/token-manager'
import type { Env } from './types/env'
import type { CommentEvent } from './types/meta'
import { sha256Hex } from './utils/hash'
import { renderTemplate } from './utils/templates'

const WEBHOOK_PATH = '/webhooks/instagram'

/**
 * Teto de comentarios ENTREGUES por invocacao do webhook. (§16.1)
 *
 * Cada comentario entregue custa 5 consultas ao D1 (`findByCommentId`,
 * `isUserInCooldown`, `claimComment`, `markPrivateSent`, `markCompleted`) mais
 * 2 chamadas a Meta (Direct e resposta publica), e o lote inteiro custa outras
 * 2 consultas (token da conta e credencial). Consulta ao D1 e chamada de rede
 * contam no MESMO teto de 50 subrequests por invocacao, entao:
 *
 *   5 x (5 + 2) + 2 + 1 (reagendamento em lote) = 38  <= 50
 *
 * Sobram 12, e o pior caso gasta 5 deles: um `getMediaInfo` de fallback por
 * comentario, quando o webhook nao informa o tipo da midia. Com 6 seriam
 * `6 x 8 + 3 = 51` e o teto ja estouraria — 5 e o maior valor que cabe, e e o
 * numero que a spec cita de exemplo.
 */
const MAX_COMENTARIOS_POR_INVOCACAO = 5

/**
 * Quantos registros o cron tenta reprocessar por execucao.
 *
 * O mesmo teto de 50 subrequests vale aqui, e a retentativa custa 4 por
 * registro (Direct + `markPrivateSent` + resposta publica + `markCompleted`)
 * mais ate 7 fixos da renovacao do token. Com 10: 10 x 4 + 7 = 47 <= 50. Era
 * 20 — o que ja estourava o teto hoje, e estouraria sempre agora que o
 * excedente do webhook e drenado por aqui. (§16.1)
 */
const RETRY_BATCH_SIZE = 10

/**
 * O que o pipeline de entrega busca fora de si mesmo.
 *
 * Existe para o teste injetar dubles por parametro — o projeto nao usa mock de
 * modulo. Os valores padrao sao exatamente o que roda em producao.
 */
export interface BatchDeps {
  /** Fabrica do cliente da Meta, para o teste nao tocar a rede. */
  createApi: (apiVersion: string, token: string) => MetaApiClient
  /** Origem da configuracao. Hoje o modulo; adiante, o banco. */
  resolveConfig: (mediaId: string) => AutomationConfig
}

const DEFAULT_BATCH_DEPS: BatchDeps = {
  createApi: (apiVersion, token) => new MetaApiClient(apiVersion, token),
  resolveConfig: (mediaId) => resolveConfigForMedia(mediaId),
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const now = Date.now()

    switch (url.pathname) {
      case '/health':
        return handleHealth(env)

      case '/privacy-policy':
        return handlePrivacyPolicy()

      case '/data-deletion':
        return handleDataDeletion()

      case WEBHOOK_PATH:
        return handleWebhook(request, env, ctx, url, now)

      case '/setup/authorize':
        return handleAuthorizeStart(request, env, url, now)

      case CALLBACK_PATH:
        return handleOAuthCallback(env, url, now)

      case '/setup/subscribe':
        return handleSubscribe(request, env, () => loadAccessToken(env))

      default:
        return new Response('Not Found', { status: 404 })
    }
  },

  /**
   * Cron unico: varre retry_pending e renova o token quando necessario.
   *
   * Um so trigger para as duas tarefas, conforme o limite de um Cron
   * Trigger definido para o projeto.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledTasks(env, Date.now()))
  },
} satisfies ExportedHandler<Env>

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  now: number,
): Promise<Response> {
  if (request.method === 'GET') return handleWebhookVerification(url, env)
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const parsed = await readWebhookRequest(request, env)
  if (!parsed.ok) {
    console.warn('Webhook rejeitado:', parsed.reason)
    return new Response(parsed.reason, { status: parsed.status })
  }

  // A Meta reenvia o evento se demorarmos a responder, entao confirmamos
  // imediatamente e processamos em segundo plano.
  if (parsed.events.length > 0) {
    ctx.waitUntil(processEvents(parsed.events, env, now))
  }

  return new Response('EVENT_RECEIVED', { status: 200 })
}

/** Processa os eventos do lote em sequencia, sem deixar erro escapar. */
export async function processEvents(
  events: readonly CommentEvent[],
  env: Env,
  now: number,
  deps: BatchDeps = DEFAULT_BATCH_DEPS,
): Promise<void> {
  const conta = await new TokensRepository(env.DB).get()
  if (!conta) {
    console.warn('Evento recebido mas nenhuma conta esta conectada. Rode /setup/authorize.')
    return
  }

  const credencial = await loadAccessToken(env)
  if (!credencial) return

  const api = deps.createApi(env.META_API_VERSION, credencial.token)
  const repo = new CommentsRepository(env.DB)
  const accountUsername = conta.username ?? ''

  for (const event of events.slice(0, MAX_COMENTARIOS_POR_INVOCACAO)) {
    try {
      const resultado = await processComment(event, {
        api,
        repo,
        igUserId: credencial.igUserId,
        accountUsername,
        config: deps.resolveConfig(event.mediaId),
        now,
      })
      console.log(`Comentario ${event.commentId}: ${resultado.kind}`)
    } catch (cause) {
      console.error(
        `Erro inesperado no comentario ${event.commentId}:`,
        cause instanceof Error ? cause.message : cause,
      )
    }
  }

  await reagendarExcedente(events.slice(MAX_COMENTARIOS_POR_INVOCACAO), {
    repo,
    igUserId: credencial.igUserId,
    accountUsername,
    now,
    resolveConfig: deps.resolveConfig,
  })
}

/**
 * Passa o que sobrou da fatia para a fila que o cron ja varre. (§16.1)
 *
 * Reagendar so pode acontecer para o comentario que HOJE seria entregue, senao
 * o cron mandaria Direct para quem nunca digitou a palavra-gatilho. Os portoes
 * gratuitos ficam aqui: o veredito de `evaluateComment` e a confirmacao de Reel
 * que veio no proprio webhook. Os dois que custam consulta — dedup e cooldown —
 * viajam dentro do proprio INSERT, em `deferForRetry`.
 *
 * A unica confirmacao que NAO e refeita e a do tipo da midia quando o webhook
 * nao o informou: perguntar a Meta custaria uma chamada por comentario, que e
 * exatamente o gasto que a fatia existe para evitar. Na pratica o webhook de
 * comentarios da Meta sempre traz `media_product_type`.
 */
async function reagendarExcedente(
  events: readonly CommentEvent[],
  deps: {
    repo: CommentsRepository
    igUserId: string
    accountUsername: string
    now: number
    resolveConfig: (mediaId: string) => AutomationConfig
  },
): Promise<void> {
  if (events.length === 0) return

  const pendentes: DeferredComment[] = []
  /** Autores ja reagendados neste lote, para o cooldown valer dentro dele. */
  const jaReagendados = new Set<string>()

  for (const event of events) {
    const config = deps.resolveConfig(event.mediaId)

    const veredito = evaluateComment(event, config, deps.igUserId, deps.accountUsername)
    if (!veredito.process) continue

    if (config.processOnlyReels && isReelFromEvent(event) === false) continue

    // O `WHERE NOT EXISTS` do INSERT enxerga o que ja esta gravado, mas nao o
    // que entra no MESMO lote: dois comentarios do mesmo autor no excedente
    // renderiam dois Directs. Hoje o segundo cai em `usuario_em_cooldown` e nao
    // vira linha nenhuma, e e isso que precisa continuar acontecendo.
    const commenterHash = await sha256Hex(event.fromId)
    if (jaReagendados.has(commenterHash)) continue
    jaReagendados.add(commenterHash)

    pendentes.push({
      commentId: event.commentId,
      mediaId: event.mediaId,
      commenterHash,
      cooldownSince: deps.now - config.userCooldownHours * 60 * 60 * 1000,
    })
  }

  const reagendados = await deps.repo.deferForRetry(pendentes, deps.now)
  if (reagendados > 0) {
    console.log(`Lote fatiado: ${reagendados} comentario(s) reagendado(s) para o cron`)
  }
}

/** Tarefas do cron: renovacao do token e reprocessamento de pendentes. */
export async function runScheduledTasks(
  env: Env,
  now: number,
  deps: BatchDeps = DEFAULT_BATCH_DEPS,
): Promise<void> {
  await maybeRefreshToken(env, now)
  await retryPending(env, now, deps)
}

async function maybeRefreshToken(env: Env, now: number): Promise<void> {
  const record = await new TokensRepository(env.DB).get()
  if (!record) return

  if (!shouldRefresh(record.expires_at, record.last_refreshed_at, record.created_at, now)) {
    return
  }

  try {
    const credencial = await loadAccessToken(env)
    if (!credencial) return

    const renovado = await refreshLongLivedToken(credencial.token)
    await storeAccessToken(env, {
      igUserId: record.ig_user_id,
      username: record.username,
      accessToken: renovado.accessToken,
      expiresInSeconds: renovado.expiresInSeconds,
      now,
    })
    console.log('Token renovado com sucesso')
  } catch (cause) {
    console.error('Falha ao renovar o token:', cause instanceof Error ? cause.message : cause)
  }
}

async function retryPending(env: Env, now: number, deps: BatchDeps): Promise<void> {
  const repo = new CommentsRepository(env.DB)
  const pendentes = await repo.findRetryPending(now, RETRY_BATCH_SIZE)
  if (pendentes.length === 0) return

  console.log(`Reprocessando ${pendentes.length} comentario(s) pendente(s)`)

  const conta = await new TokensRepository(env.DB).get()
  const credencial = await loadAccessToken(env)
  if (!conta || !credencial) return

  const api = deps.createApi(env.META_API_VERSION, credencial.token)

  for (const registro of pendentes) {
    // O texto do comentario nao e guardado (coleta minima), entao a nova
    // tentativa reenvia apenas o Direct, que e a etapa que falhou.
    const config = deps.resolveConfig(registro.media_id)
    // O `.replace()` cru daqui trocava so a PRIMEIRA ocorrencia e nao passava
    // pela sanitizacao. `renderTemplate` usa `replaceAll` e limpa caracteres
    // de controle — e e o unico ponto de renderizacao do projeto. (§16.3)
    const texto = renderTemplate(config.privateReplyText, {
      username: '',
      link: config.destinationUrl,
    })
    const envio = await api.sendPrivateReply(credencial.igUserId, registro.comment_id, texto)

    if (envio.ok) {
      await repo.markPrivateSent(registro.comment_id, envio.data.message_id ?? null, now)
      const resposta = await api.replyToComment(registro.comment_id, config.publicReplyText)
      if (resposta.ok) {
        await repo.markCompleted(registro.comment_id, resposta.data.id, now)
      } else {
        await repo.markStatus(registro.comment_id, 'uncertain', now, resposta.error.shortCode)
      }
    } else {
      await repo.markStatus(registro.comment_id, 'failed', now, envio.error.shortCode)
    }
  }
}

export { automationConfig }
