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

/**
 * Status que contam como "esta pessoa ja acionou a automacao".
 *
 * `ignored` e `failed` ficam de fora de proposito: nao devem bloquear uma
 * tentativa legitima seguinte.
 */
const STATUS_QUE_ACIONARAM: readonly CommentStatus[] = [
  'private_sent',
  'completed',
  'processing',
  'uncertain',
]

/**
 * Os mesmos, mais `retry_pending`.
 *
 * Um comentario esperando o cron e um Direct PROMETIDO: se ele nao contasse, o
 * autor reagendado numa invocacao nao seria barrado na proxima e receberia dois
 * Directs. O caminho inline (`isUserInCooldown`) NAO usa esta lista, incluir
 * `retry_pending` la mudaria o comportamento que esta etapa existe para
 * congelar. O portao do reagendamento e, de proposito, o mais estrito dos dois.
 */
const STATUS_QUE_PROMETEM_DIRECT: readonly CommentStatus[] = [
  ...STATUS_QUE_ACIONARAM,
  'retry_pending',
]

/**
 * Monta a lista de um `IN (...)`.
 *
 * So recebe valores de `CommentStatus`, que e uma uniao fechada escrita neste
 * arquivo: nao ha entrada externa alcancando esta string.
 */
function comoListaSql(status: readonly CommentStatus[]): string {
  return status.map((valor) => `'${valor}'`).join(', ')
}

/** Comentario que ficou fora da fatia da invocacao e vai esperar o cron. (§16.1) */
export interface DeferredComment {
  commentId: string
  mediaId: string
  commenterHash: string
  /** Inicio da janela de cooldown do autor. Varia por midia. */
  cooldownSince: number
}

/**
 * INSERT do reagendamento, com os dois portoes embutidos. (§16.1)
 *
 * `ON CONFLICT DO NOTHING` cobre o dedup por `comment_id`; o `WHERE NOT EXISTS`
 * cobre o cooldown do autor. Os dois de graca, dentro da mesma escrita, o
 * caminho normal paga uma consulta por cada.
 */
const SQL_REAGENDAR = `INSERT INTO processed_comments
     (comment_id, media_id, commenter_scoped_id_hash, status,
      attempt_count, next_retry_at, created_at, updated_at)
   SELECT ?, ?, ?, 'retry_pending', 0, ?, ?, ?
    WHERE NOT EXISTS (
          SELECT 1 FROM processed_comments
           WHERE commenter_scoped_id_hash = ?
             AND created_at >= ?
             AND status IN (${comoListaSql(STATUS_QUE_PROMETEM_DIRECT)}))
   ON CONFLICT (comment_id) DO NOTHING`

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

  /**
   * Enfileira o excedente do lote para a varredura do cron. (§16.1)
   *
   * Um unico `db.batch()`, transacao implicita e UM subrequest, grava o
   * excedente inteiro. Cada INSERT carrega dentro de si os dois portoes que o
   * caminho normal pagaria com uma consulta cada: o `ON CONFLICT DO NOTHING`
   * cobre o dedup e o `WHERE NOT EXISTS` cobre o cooldown do autor, contando
   * tambem quem ja esta reagendado. Sem isso o excedente furaria as duas regras
   * justamente no lote grande.
   *
   * Devolve quantas linhas foram realmente criadas.
   */
  async deferForRetry(items: readonly DeferredComment[], now: number): Promise<number> {
    if (items.length === 0) return 0

    const resultados = await this.db.batch(
      items.map((item) =>
        this.db
          .prepare(SQL_REAGENDAR)
          .bind(
            item.commentId,
            item.mediaId,
            item.commenterHash,
            now,
            now,
            now,
            item.commenterHash,
            item.cooldownSince,
          ),
      ),
    )

    return resultados.reduce((total, resultado) => total + (resultado.meta.changes ?? 0), 0)
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
   * Conta apenas acionamentos que chegaram a enviar algo, `ignored` e
   * `failed` nao devem bloquear uma tentativa legitima seguinte.
   */
  async isUserInCooldown(commenterHash: string, since: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS hit FROM processed_comments
          WHERE commenter_scoped_id_hash = ?
            AND created_at >= ?
            AND status IN (${comoListaSql(STATUS_QUE_ACIONARAM)})
          LIMIT 1`,
      )
      .bind(commenterHash, since)
      .first<{ hit: number }>()

    return row !== null
  }
}
