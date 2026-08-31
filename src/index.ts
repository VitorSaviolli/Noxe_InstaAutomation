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
import { automationConfig, resolveConfigForMedia } from './config'
import { CommentsRepository } from './repositories/comments-repository'
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
import { processComment } from './services/automation'
import { MetaApiClient } from './services/meta-api'
import {
  loadAccessToken,
  refreshLongLivedToken,
  shouldRefresh,
  storeAccessToken,
} from './services/token-manager'
import type { Env } from './types/env'
import type { CommentEvent } from './types/meta'

const WEBHOOK_PATH = '/webhooks/instagram'

/** Quantos registros o cron tenta reprocessar por execucao. */
const RETRY_BATCH_SIZE = 20

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
): Promise<void> {
  const conta = await new TokensRepository(env.DB).get()
  if (!conta) {
    console.warn('Evento recebido mas nenhuma conta esta conectada. Rode /setup/authorize.')
    return
  }

  const credencial = await loadAccessToken(env)
  if (!credencial) return

  const api = new MetaApiClient(env.META_API_VERSION, credencial.token)
  const repo = new CommentsRepository(env.DB)

  for (const event of events) {
    try {
      const resultado = await processComment(event, {
        api,
        repo,
        igUserId: credencial.igUserId,
        accountUsername: conta.username ?? '',
        config: resolveConfigForMedia(event.mediaId),
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
}

/** Tarefas do cron: renovacao do token e reprocessamento de pendentes. */
export async function runScheduledTasks(env: Env, now: number): Promise<void> {
  await maybeRefreshToken(env, now)
  await retryPending(env, now)
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

async function retryPending(env: Env, now: number): Promise<void> {
  const repo = new CommentsRepository(env.DB)
  const pendentes = await repo.findRetryPending(now, RETRY_BATCH_SIZE)
  if (pendentes.length === 0) return

  console.log(`Reprocessando ${pendentes.length} comentario(s) pendente(s)`)

  const conta = await new TokensRepository(env.DB).get()
  const credencial = await loadAccessToken(env)
  if (!conta || !credencial) return

  const api = new MetaApiClient(env.META_API_VERSION, credencial.token)

  for (const registro of pendentes) {
    // O texto do comentario nao e guardado (coleta minima), entao a nova
    // tentativa reenvia apenas o Direct, que e a etapa que falhou.
    const config = resolveConfigForMedia(registro.media_id)
    const envio = await api.sendPrivateReply(
      credencial.igUserId,
      registro.comment_id,
      config.privateReplyText.replace('{link}', config.destinationUrl).replace('{username}', ''),
    )

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
