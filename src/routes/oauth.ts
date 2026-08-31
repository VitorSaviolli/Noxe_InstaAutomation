import { timingSafeEqual } from '../security/constant-time'
import { createState, validateState } from '../security/oauth-state'
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchAccountInfo,
  findMissingScopes,
  storeAccessToken,
  subscribeToWebhooks,
} from '../services/token-manager'
import type { Env } from '../types/env'

/** Path do callback. Precisa bater EXATAMENTE com o cadastrado no painel. */
export const CALLBACK_PATH = '/oauth/callback'

/** Resposta curta em texto, sem vazar detalhe interno. */
function texto(mensagem: string, status: number): Response {
  return new Response(mensagem, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Confere o token administrativo.
 *
 * Vem no header Authorization, nunca na URL: query strings vazam em log de
 * proxy, historico de navegador e Referer.
 */
export function isAdmin(request: Request, env: Env): boolean {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return false
  return timingSafeEqual(header.slice('Bearer '.length), env.SETUP_ADMIN_TOKEN)
}

/** Monta o redirect_uri absoluto a partir da URL da requisicao. */
function redirectUri(url: URL): string {
  return `${url.origin}${CALLBACK_PATH}`
}

/**
 * Inicia o fluxo: gera o state assinado e manda para a tela de consentimento.
 * Protegida pelo SETUP_ADMIN_TOKEN — so o dono conecta a conta.
 */
export async function handleAuthorizeStart(
  request: Request,
  env: Env,
  url: URL,
  now: number,
): Promise<Response> {
  if (!isAdmin(request, env)) return texto('Nao autorizado', 401)

  if (env.META_APP_ID.length === 0) {
    return texto('META_APP_ID nao configurado no wrangler.jsonc', 500)
  }

  const state = await createState(env.SETUP_ADMIN_TOKEN, now)
  const destino = buildAuthorizationUrl(env.META_APP_ID, redirectUri(url), state)

  return Response.json({
    authorizationUrl: destino,
    instrucoes: 'Abra esta URL no navegador logado na conta profissional.',
  })
}

/**
 * Callback do OAuth.
 *
 * Nao pode exigir o header de admin (quem chega aqui e o navegador, via
 * redirect da Meta). A protecao e o `state` assinado.
 */
export async function handleOAuthCallback(env: Env, url: URL, now: number): Promise<Response> {
  const erro = url.searchParams.get('error')
  if (erro !== null) {
    const motivo = url.searchParams.get('error_reason') ?? erro
    console.warn('Autorizacao negada pelo usuario:', motivo)
    return texto(`Autorizacao negada: ${motivo}`, 400)
  }

  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')

  if (state === null || code === null) {
    return texto('Parametros state ou code ausentes', 400)
  }

  const stateOk = await validateState(state, env.SETUP_ADMIN_TOKEN, now)
  if (!stateOk.valid) {
    console.warn('State do OAuth recusado:', stateOk.reason)
    return texto('State invalido ou expirado. Reinicie o fluxo.', 403)
  }

  try {
    const curto = await exchangeCodeForToken(
      env.META_APP_ID,
      env.META_APP_SECRET,
      redirectUri(url),
      code,
    )

    const faltando = findMissingScopes(curto.permissions)
    if (faltando.length > 0) {
      return texto(
        `Permissoes nao concedidas: ${faltando.join(', ')}. Refaca autorizando todas.`,
        400,
      )
    }

    const longo = await exchangeForLongLivedToken(env.META_APP_SECRET, curto.accessToken)
    const conta = await fetchAccountInfo(env.META_API_VERSION, longo.accessToken)

    await storeAccessToken(env, {
      igUserId: conta.userId,
      username: conta.username,
      accessToken: longo.accessToken,
      expiresInSeconds: longo.expiresInSeconds,
      now,
    })

    const inscrito = await subscribeToWebhooks(env.META_API_VERSION, longo.accessToken)

    console.log('Conta autorizada com sucesso. Webhook inscrito:', inscrito)

    return texto(
      [
        'Conta conectada com sucesso.',
        `Conta: ${conta.username ?? conta.userId}`,
        `Inscricao no webhook (nivel conta): ${inscrito ? 'ok' : 'FALHOU — refaca pelo /setup/subscribe'}`,
        '',
        'Lembre de configurar tambem o NIVEL APP no painel da Meta:',
        'Callback URL e Verify Token em Webhooks, campo "comments".',
      ].join('\n'),
      200,
    )
  } catch (cause) {
    // A mensagem pode conter detalhe do provedor; fica so no log.
    console.error('Falha no callback do OAuth:', cause instanceof Error ? cause.message : cause)
    return texto('Falha ao concluir a autorizacao. Verifique os logs.', 502)
  }
}

/** Refaz apenas a inscricao no webhook (nivel conta). */
export async function handleSubscribe(
  request: Request,
  env: Env,
  loadToken: () => Promise<{ token: string } | null>,
): Promise<Response> {
  if (!isAdmin(request, env)) return texto('Nao autorizado', 401)

  const guardado = await loadToken()
  if (!guardado) return texto('Nenhuma conta conectada ainda', 409)

  const ok = await subscribeToWebhooks(env.META_API_VERSION, guardado.token)
  return Response.json({ subscribed: ok }, { status: ok ? 200 : 502 })
}
