/**
 * Acesso ao registro de comentarios processados.
 *
 * A garantia central esta em `claimComment`: o INSERT com ON CONFLICT DO
 * NOTHING e atomico no SQLite, entao dois webhooks simultaneos para o mesmo
 * comment_id resultam em exatamente um claim. Toda a protecao contra
 * mensagem duplicada se apoia nisso.
 */

/** Estados do ciclo de vida de um comentario. */
export type CommentStatus =
  | 'received'
  | 'ignored'
  | 'processing'
  | 'private_sent'
  | 'completed'
  | 'retry_pending'
  | 'failed'
  /** Enviou o Direct mas nao conseguiu confirmar: NUNCA retentar as cegas. */
  | 'uncertain'

export interface CommentRecord {
  comment_id: string
  media_id: string
  commenter_scoped_id_hash: string
  status: CommentStatus
  private_message_id: string | null
  public_reply_id: string | null
  attempt_count: number
  last_error_code: string | null
  next_retry_at: number | null
  created_at: number
  updated_at: number
}

export class CommentsRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Tenta registrar o comentario como nosso.
   *
   * Retorna true se ESTE processo ganhou o direito de processar; false se o
   * comentario ja existia (webhook reenviado ou corrida entre invocacoes).
   */
  async claimComment(
    commentId: string,
    mediaId: string,
    commenterHash: string,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO processed_comments
           (comment_id, media_id, commenter_scoped_id_hash, status,
            attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, 'processing', 0, ?, ?)
         ON CONFLICT (comment_id) DO NOTHING`,
      )
      .bind(commentId, mediaId, commenterHash, now, now)
      .run()

    return (result.meta.changes ?? 0) > 0
  }

  async findByCommentId(commentId: string): Promise<CommentRecord | null> {
    return this.db
      .prepare('SELECT * FROM processed_comments WHERE comment_id = ?')
      .bind(commentId)
      .first<CommentRecord>()
  }

  async markStatus(
    commentId: string,
    status: CommentStatus,
    now: number,
    errorCode?: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processed_comments
            SET status = ?, last_error_code = ?, updated_at = ?, next_retry_at = NULL
          WHERE comment_id = ?`,
      )
      .bind(status, errorCode ?? null, now, commentId)
      .run()
  }

  /** Registra o envio do Direct. Chamado ANTES da resposta publica. */
  async markPrivateSent(
    commentId: string,
    privateMessageId: string | null,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processed_comments
            SET status = 'private_sent', private_message_id = ?, updated_at = ?
          WHERE comment_id = ?`,
      )
      .bind(privateMessageId, now, commentId)
      .run()
  }

  async markCompleted(commentId: string, publicReplyId: string | null, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processed_comments
            SET status = 'completed', public_reply_id = ?, updated_at = ?,
                next_retry_at = NULL, last_error_code = NULL
          WHERE comment_id = ?`,
      )
      .bind(publicReplyId, now, commentId)
      .run()
  }

  /** Agenda nova tentativa e incrementa o contador. */
  async scheduleRetry(
    commentId: string,
    nextRetryAt: number,
    errorCode: string,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE processed_comments
            SET status = 'retry_pending', next_retry_at = ?, last_error_code = ?,
                attempt_count = attempt_count + 1, updated_at = ?
          WHERE comment_id = ?`,
      )
      .bind(nextRetryAt, errorCode, now, commentId)
      .run()
  }

  /** Registros prontos para nova tentativa, para a varredura do cron. */
  async findRetryPending(now: number, limit: number): Promise<CommentRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM processed_comments
          WHERE status = 'retry_pending' AND next_retry_at IS NOT NULL
            AND next_retry_at <= ?
          ORDER BY next_retry_at ASC
          LIMIT ?`,
      )
      .bind(now, limit)
      .all<CommentRecord>()

    return result.results ?? []
  }

  /**
   * True se o usuario ja acionou a automacao dentro da janela de cooldown.
   *
   * Conta apenas acionamentos que chegaram a enviar algo — `ignored` e
   * `failed` nao devem bloquear uma tentativa legitima seguinte.
   */
  async isUserInCooldown(commenterHash: string, since: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS hit FROM processed_comments
          WHERE commenter_scoped_id_hash = ?
            AND created_at >= ?
            AND status IN ('private_sent', 'completed', 'processing', 'uncertain')
          LIMIT 1`,
      )
      .bind(commenterHash, since)
      .first<{ hit: number }>()

    return row !== null
  }
}
