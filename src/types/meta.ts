/**
 * Tipos do payload de webhook da Meta e das respostas da Graph API.
 *
 * Sao modelados como "tudo pode faltar" de proposito: o payload vem de fora
 * e a validacao em runtime (parseCommentEvents) e quem garante a forma.
 */

/** Um evento de comentario ja validado e pronto para processar. */
export interface CommentEvent {
  commentId: string
  mediaId: string
  /** IGSID do autor: identificador com escopo do app. */
  fromId: string
  fromUsername: string
  text: string
  /** Preenchido quando o comentario e resposta a outro comentario. */
  parentId: string | null
  /** Vem do payload quando disponivel; senao null e consultamos a API. */
  mediaProductType: string | null
}

/** Resultado de uma chamada a Graph API. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }

export interface ApiError {
  /** Status HTTP, ou 0 para falha de rede. */
  status: number
  /** Codigo numerico da Meta, quando presente no corpo. */
  code: number | null
  subcode: number | null
  message: string
  /** Chave curta usada em log e na coluna last_error_code. */
  shortCode: string
}

export interface PublicReplyResponse {
  id: string
}

export interface PrivateReplyResponse {
  /** A Meta devolve recipient_id e message_id no envio de mensagem. */
  recipient_id?: string
  message_id?: string
}

export interface MediaInfoResponse {
  id: string
  media_type?: string
  media_product_type?: string
}

/**
 * Um item da listagem `me/media` (§12.5).
 *
 * Modelado como "tudo pode faltar" pelo mesmo motivo dos outros: o corpo vem
 * de fora. `id` continua STRING em todo o caminho — `JSON.parse` de um id de
 * 18 digitos SEM aspas devolveria um `number` corrompido em silencio, e o
 * painel passaria a responder no Reel errado sem nenhum erro (Ruling 90).
 *
 * `thumbnail_url` aparece aqui e **nunca** vai para o D1: e endereco assinado
 * que vence em pouco tempo, e a migration `0002` explica por que a coluna nao
 * existe.
 */
export interface MediaListItem {
  id?: string
  media_type?: string
  media_product_type?: string
  caption?: string
  permalink?: string
  thumbnail_url?: string
  /** ISO 8601, como a Meta o devolve. Vira epoch ms no painel. */
  timestamp?: string
}

/**
 * Uma pagina de `me/media`.
 *
 * **`paging.next` e o unico fim de lista** (§12.5): receber menos itens que o
 * `limit` NAO significa fim, e parar por contagem deixaria Reels de fora sem
 * ninguem perceber.
 */
export interface MediaListResponse {
  data?: MediaListItem[]
  paging?: {
    next?: string
    cursors?: { after?: string }
  }
}
