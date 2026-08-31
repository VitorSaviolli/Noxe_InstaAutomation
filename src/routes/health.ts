import type { Env } from '../types/env'

/**
 * Health check publico.
 *
 * Nao expoe segredo nem estado sensivel: apenas se as pecas obrigatorias
 * estao presentes. Serve para monitoramento externo e para conferir um
 * deploy sem abrir o dashboard.
 */
export async function handleHealth(env: Env): Promise<Response> {
  const temToken = await hasStoredToken(env)

  return Response.json({
    status: 'ok',
    webhook: '/webhooks/instagram',
    configurado: {
      appId: env.META_APP_ID.length > 0,
      apiVersion: env.META_API_VERSION,
      contaAutorizada: temToken,
    },
  })
}

/** True se ja existe um token de conta gravado. Nunca devolve o token. */
async function hasStoredToken(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT 1 AS hit FROM account_tokens WHERE id = 1').first<{
      hit: number
    }>()
    return row !== null
  } catch {
    return false
  }
}
