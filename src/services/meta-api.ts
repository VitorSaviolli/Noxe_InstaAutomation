import type {
  ApiError,
  ApiResult,
  MediaInfoResponse,
  MediaListResponse,
  PrivateReplyResponse,
  PublicReplyResponse,
} from '../types/meta'

/**
 * Cliente da Instagram API (fluxo "Instagram API with Instagram Login").
 *
 * Os hosts sao DIFERENTES por etapa e trocar um pelo outro e a falha mais
 * comum desta integracao:
 *   - www.instagram.com  -> tela de consentimento (navegador do usuario)
 *   - api.instagram.com  -> UNICO endpoint: troca do code por token curto
 *   - graph.instagram.com -> todo o resto (token longo, refresh, API)
 *
 * graph.facebook.com pertence ao fluxo com Facebook Login e NAO deve
 * aparecer aqui. `assertGraphHost` transforma esse engano em erro de teste.
 */

export const HOST_AUTHORIZE = 'https://www.instagram.com'
export const HOST_TOKEN_EXCHANGE = 'https://api.instagram.com'
export const HOST_GRAPH = 'https://graph.instagram.com'

/** Scopes pedidos no OAuth. Somente o necessario para o fluxo. */
export const REQUIRED_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
] as const

/** Teto conservador: a Meta nao documenta limite do texto de reply. */
export const MAX_REPLY_LENGTH = 2000

/**
 * Itens por pagina de `me/media` (§12.5).
 *
 * Uma pagina = UMA chamada = 1 subrequest. O filtro de Reels e feito no
 * Worker, porque a Meta nao oferece filtro server-side por REELS: pedir menos
 * itens so faria mais paginas para achar o mesmo tanto de Reel.
 */
export const ITENS_POR_PAGINA_DE_MIDIAS = 25

/**
 * Os campos que a listagem pede, numa string so.
 *
 * `thumbnail_url` entra porque a tela precisa da miniatura, e sai da memoria
 * quando a resposta e montada: ele NUNCA vai para o D1 (§12.5). `caption` e
 * `media_product_type` entram para a tela nao precisar de uma chamada extra
 * por item — a proibicao de §12.5 que mais custa se for esquecida.
 */
const CAMPOS_DA_LISTAGEM =
  'id,media_type,media_product_type,caption,permalink,thumbnail_url,timestamp'

/** Private reply so e aceita ate 7 dias apos a criacao do comentario. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Timeout de cada chamada. Workers derruba invocacoes longas demais. */
const REQUEST_TIMEOUT_MS = 10_000

/** Falha ruidosa se alguem colar uma URL de graph.facebook.com. */
function assertGraphHost(url: string): void {
  if (!url.startsWith(`${HOST_GRAPH}/`)) {
    throw new Error(`URL fora do host esperado (${HOST_GRAPH}): ${url}`)
  }
}

/** Classifica a falha num codigo curto usado em log e no banco. */
function classify(status: number, code: number | null, subcode: number | null): string {
  if (status === 0) return 'NETWORK'
  if (code === 190) return 'TOKEN_INVALIDO'
  if (status === 401) return 'NAO_AUTORIZADO'
  if (status === 403) return 'PROIBIDO'
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
    return 'RATE_LIMIT'
  }
  if (status === 404 || (code === 100 && subcode === 33)) return 'OBJETO_INEXISTENTE'
  if (status >= 500) return `HTTP_${status}`
  if (status === 400) return 'REQUISICAO_INVALIDA'
  return `HTTP_${status}`
}

/**
 * Erros que valem nova tentativa.
 *
 * Tudo que NAO esta aqui e definitivo: retentar so gastaria cota e, no caso
 * do private reply (limite de 1 por comentario), poderia duplicar.
 */
export function isRetryable(shortCode: string): boolean {
  return (
    shortCode === 'NETWORK' ||
    shortCode === 'RATE_LIMIT' ||
    shortCode === 'HTTP_500' ||
    shortCode === 'HTTP_502' ||
    shortCode === 'HTTP_503' ||
    shortCode === 'HTTP_504'
  )
}

async function parseError(response: Response): Promise<ApiError> {
  let code: number | null = null
  let subcode: number | null = null
  let message = `HTTP ${response.status}`

  try {
    const body = (await response.json()) as { error?: Record<string, unknown> }
    const error = body.error
    if (error) {
      code = typeof error.code === 'number' ? error.code : null
      subcode = typeof error.error_subcode === 'number' ? error.error_subcode : null
      if (typeof error.message === 'string') message = error.message
    }
  } catch {
    // Corpo nao-JSON: mantem a mensagem generica.
  }

  return {
    status: response.status,
    code,
    subcode,
    message,
    shortCode: classify(response.status, code, subcode),
  }
}

/** Executa a chamada e normaliza sucesso/erro num ApiResult. */
async function call<T>(url: string, init: RequestInit): Promise<ApiResult<T>> {
  assertGraphHost(url)

  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      return { ok: false, error: await parseError(response) }
    }

    return { ok: true, data: (await response.json()) as T }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'falha desconhecida'
    return {
      ok: false,
      error: { status: 0, code: null, subcode: null, message, shortCode: 'NETWORK' },
    }
  }
}

export class MetaApiClient {
  constructor(
    private readonly apiVersion: string,
    private readonly accessToken: string,
  ) {}

  private headers(): HeadersInit {
    return {
      authorization: `Bearer ${this.accessToken}`,
      'content-type': 'application/json',
    }
  }

  /**
   * Responde publicamente a um comentario.
   * POST /{ig-comment-id}/replies  body: {"message": "..."}
   */
  async replyToComment(
    commentId: string,
    message: string,
  ): Promise<ApiResult<PublicReplyResponse>> {
    const url = `${HOST_GRAPH}/${this.apiVersion}/${commentId}/replies`
    return call<PublicReplyResponse>(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ message: message.slice(0, MAX_REPLY_LENGTH) }),
    })
  }

  /**
   * Envia o Direct originado de um comentario (private reply).
   *
   * POST /{ig-user-id}/messages
   * body: {"recipient":{"comment_id":"..."},"message":{"text":"..."}}
   *
   * ATENCAO: a Meta permite UMA unica private reply por comentario. Uma
   * segunda chamada falha — e por isso que o claim no D1 acontece ANTES.
   */
  async sendPrivateReply(
    igUserId: string,
    commentId: string,
    text: string,
  ): Promise<ApiResult<PrivateReplyResponse>> {
    const url = `${HOST_GRAPH}/${this.apiVersion}/${igUserId}/messages`
    return call<PrivateReplyResponse>(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text: text.slice(0, MAX_REPLY_LENGTH) },
      }),
    })
  }

  /**
   * Uma pagina da listagem de midias da conta (§12.5).
   *
   * `after` e o cursor da pagina anterior. Ele **nunca** vai para o D1:
   * cursores sao temporarios, e guarda-los e bug futuro.
   */
  async listMedia(opcoes: { after?: string } = {}): Promise<ApiResult<MediaListResponse>> {
    const busca = new URLSearchParams({
      fields: CAMPOS_DA_LISTAGEM,
      limit: String(ITENS_POR_PAGINA_DE_MIDIAS),
    })
    if (opcoes.after !== undefined && opcoes.after !== '') busca.set('after', opcoes.after)

    const url = `${HOST_GRAPH}/${this.apiVersion}/me/media?${busca.toString()}`
    return call<MediaListResponse>(url, { method: 'GET', headers: this.headers() })
  }

  /**
   * Descobre o tipo da midia quando o webhook nao informa.
   * Um Reel tem media_product_type = "REELS".
   */
  async getMediaInfo(mediaId: string): Promise<ApiResult<MediaInfoResponse>> {
    const url = `${HOST_GRAPH}/${this.apiVersion}/${mediaId}?fields=id,media_type,media_product_type`
    return call<MediaInfoResponse>(url, { method: 'GET', headers: this.headers() })
  }
}
