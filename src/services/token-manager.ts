import { TokensRepository } from '../repositories/tokens-repository'
import { decrypt, encrypt } from '../security/encryption'
import type { Env } from '../types/env'
import { HOST_AUTHORIZE, HOST_GRAPH, HOST_TOKEN_EXCHANGE, REQUIRED_SCOPES } from './meta-api'

/**
 * Ciclo de vida do access token da conta.
 *
 * Fluxo oficial (Instagram API with Instagram Login):
 *   1. www.instagram.com/oauth/authorize    -> usuario consente, volta ?code=
 *   2. api.instagram.com/oauth/access_token -> code vira token de 1 HORA
 *   3. graph.instagram.com/access_token     -> vira token de 60 DIAS
 *   4. graph.instagram.com/refresh_access_token -> renova por mais 60 dias
 *
 * ATENCAO aos passos 3 e 4: a documentacao os define SEM versao no path.
 * Inserir /v25.0/ neles quebra a chamada.
 *
 * Regra do refresh: o token precisa ter PELO MENOS 24h de vida e ainda nao
 * ter expirado. Passou de 60 dias sem renovar, o unico caminho e refazer o
 * OAuth do zero, por isso o cron renova bem antes do vencimento.
 */

/** A Meta anexa "#_" ao final do redirect; precisa sair antes de usar. */
const CODE_SUFFIX = '#_'

/** Renova quando faltar menos que isto para expirar. */
export const REFRESH_THRESHOLD_MS = 10 * 24 * 60 * 60 * 1000

/** O token precisa ter no minimo 24h de vida para poder ser renovado. */
export const MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000

export class TokenError extends Error {
  constructor(
    message: string,
    readonly shortCode: string,
  ) {
    super(message)
    this.name = 'TokenError'
  }
}

/** Monta a URL de consentimento. O `state` protege contra CSRF. */
export function buildAuthorizationUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: REQUIRED_SCOPES.join(','),
    state,
  })
  return `${HOST_AUTHORIZE}/oauth/authorize?${params.toString()}`
}

/** Remove o sufixo "#_" que a Meta anexa ao code no redirect. */
export function cleanAuthorizationCode(code: string): string {
  return code.endsWith(CODE_SUFFIX) ? code.slice(0, -CODE_SUFFIX.length) : code
}

export interface ShortLivedToken {
  accessToken: string
  permissions: string[]
}

/**
 * Passo 2: troca o code por token de curta duracao (1 hora).
 *
 * UNICO ponto do sistema que usa api.instagram.com.
 *
 * O `user_id` devolvido aqui e DESCARTADO de proposito: nao esta confirmado
 * que ele seja o mesmo ID aceito no path de /messages. O ID correto vem de
 * `fetchAccountInfo` (campo user_id de /me).
 */
export async function exchangeCodeForToken(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
): Promise<ShortLivedToken> {
  const body = new FormData()
  body.set('client_id', appId)
  body.set('client_secret', appSecret)
  body.set('grant_type', 'authorization_code')
  body.set('redirect_uri', redirectUri)
  body.set('code', cleanAuthorizationCode(code))

  const response = await fetch(`${HOST_TOKEN_EXCHANGE}/oauth/access_token`, {
    method: 'POST',
    body,
  })

  if (!response.ok) {
    throw new TokenError(`Troca do code falhou: HTTP ${response.status}`, 'TROCA_CODE_FALHOU')
  }

  const data = (await response.json()) as {
    access_token?: string
    permissions?: string[] | string
  }

  if (!data.access_token) {
    throw new TokenError('Resposta da troca do code sem access_token', 'RESPOSTA_INVALIDA')
  }

  return { accessToken: data.access_token, permissions: normalizePermissions(data.permissions) }
}

function normalizePermissions(raw: string[] | string | undefined): string[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') return raw.split(',').map((item) => item.trim())
  return []
}

/**
 * Confere se o usuario concedeu TODAS as permissoes pedidas.
 *
 * A tela de consentimento permite desmarcar permissoes individualmente e o
 * fluxo ainda retorna sucesso, sem esta checagem o erro so apareceria no
 * primeiro comentario real.
 */
export function findMissingScopes(granted: readonly string[]): string[] {
  return REQUIRED_SCOPES.filter((scope) => !granted.includes(scope))
}

export interface LongLivedToken {
  accessToken: string
  expiresInSeconds: number
}

function readTokenResponse(data: unknown, contexto: string): LongLivedToken {
  const parsed = data as { access_token?: string; expires_in?: number }
  if (!parsed.access_token || typeof parsed.expires_in !== 'number') {
    throw new TokenError(`Resposta de ${contexto} incompleta`, 'RESPOSTA_INVALIDA')
  }
  return { accessToken: parsed.access_token, expiresInSeconds: parsed.expires_in }
}

/** Passo 3: converte o token curto em token de 60 dias. Path SEM versao. */
export async function exchangeForLongLivedToken(
  appSecret: string,
  shortLivedToken: string,
): Promise<LongLivedToken> {
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: appSecret,
    access_token: shortLivedToken,
  })

  const response = await fetch(`${HOST_GRAPH}/access_token?${params.toString()}`)
  if (!response.ok) {
    throw new TokenError(`Token longo falhou: HTTP ${response.status}`, 'TOKEN_LONGO_FALHOU')
  }

  return readTokenResponse(await response.json(), 'token longo')
}

/** Passo 4: renova o token por mais 60 dias. Path SEM versao. */
export async function refreshLongLivedToken(currentToken: string): Promise<LongLivedToken> {
  const params = new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: currentToken,
  })

  const response = await fetch(`${HOST_GRAPH}/refresh_access_token?${params.toString()}`)
  if (!response.ok) {
    throw new TokenError(`Renovacao falhou: HTTP ${response.status}`, 'REFRESH_FALHOU')
  }

  return readTokenResponse(await response.json(), 'renovacao')
}

/**
 * Busca o ID da conta profissional.
 *
 * O campo correto e `user_id`, NAO `id`: o `id` do node User e app-scoped e
 * nao serve para montar o path de /messages nem casa com o entry[].id que
 * chega no webhook.
 */
export async function fetchAccountInfo(
  apiVersion: string,
  accessToken: string,
): Promise<{ userId: string; username: string | null }> {
  const params = new URLSearchParams({ fields: 'user_id,username', access_token: accessToken })
  const response = await fetch(`${HOST_GRAPH}/${apiVersion}/me?${params.toString()}`)

  if (!response.ok) {
    throw new TokenError(`Consulta /me falhou: HTTP ${response.status}`, 'ME_FALHOU')
  }

  const data = (await response.json()) as { user_id?: string | number; username?: string }
  if (data.user_id === undefined) {
    throw new TokenError('Resposta de /me sem user_id', 'RESPOSTA_INVALIDA')
  }

  return { userId: String(data.user_id), username: data.username ?? null }
}

/**
 * Inscreve a conta nos campos de webhook.
 *
 * Isto e o NIVEL CONTA. O nivel APP (Callback URL e Verify Token) e feito
 * manualmente no painel da Meta e nao tem API, os dois sao necessarios.
 */
export async function subscribeToWebhooks(
  apiVersion: string,
  accessToken: string,
): Promise<boolean> {
  const params = new URLSearchParams({
    subscribed_fields: 'comments',
    access_token: accessToken,
  })

  const response = await fetch(
    `${HOST_GRAPH}/${apiVersion}/me/subscribed_apps?${params.toString()}`,
    { method: 'POST' },
  )

  if (!response.ok) return false

  const data = (await response.json()) as { success?: boolean }
  return data.success === true
}

/** Le e decifra o token guardado. Retorna null se nao houver conta ligada. */
export async function loadAccessToken(
  env: Env,
): Promise<{ token: string; igUserId: string; expiresAt: number } | null> {
  const record = await new TokensRepository(env.DB).get()
  if (!record) return null

  const token = await decrypt(record.encrypted_token, env.TOKEN_ENCRYPTION_KEY)
  return { token, igUserId: record.ig_user_id, expiresAt: record.expires_at }
}

/** Cifra e grava o token. */
export async function storeAccessToken(
  env: Env,
  params: {
    igUserId: string
    username: string | null
    accessToken: string
    expiresInSeconds: number
    now: number
  },
): Promise<void> {
  const encrypted = await encrypt(params.accessToken, env.TOKEN_ENCRYPTION_KEY)
  await new TokensRepository(env.DB).save({
    igUserId: params.igUserId,
    username: params.username,
    encryptedToken: encrypted,
    expiresAt: params.now + params.expiresInSeconds * 1000,
    now: params.now,
  })
}

/**
 * True quando vale a pena renovar.
 *
 * Duas condicoes vem da regra oficial: o token nao pode ter expirado e
 * precisa ter pelo menos 24h de idade. A terceira e nossa: so renova perto
 * do fim, para nao gastar chamada a toa.
 */
export function shouldRefresh(
  expiresAt: number,
  lastRefreshedAt: number | null,
  createdAt: number,
  now: number,
): boolean {
  if (now >= expiresAt) return false

  const emitidoEm = lastRefreshedAt ?? createdAt
  if (now - emitidoEm < MIN_TOKEN_AGE_MS) return false

  return expiresAt - now <= REFRESH_THRESHOLD_MS
}
