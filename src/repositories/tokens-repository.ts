/**
 * Acesso ao access token da conta, guardado cifrado no D1.
 *
 * Tabela de linha unica (id = 1): o projeto atende UMA conta profissional.
 * Se um dia atender clientes, esta e a tabela que vira multi-linha.
 */

export interface AccountTokenRecord {
  id: number
  ig_user_id: string
  username: string | null
  encrypted_token: string
  expires_at: number
  last_refreshed_at: number | null
  created_at: number
  updated_at: number
}

const SINGLETON_ID = 1

export class TokensRepository {
  constructor(private readonly db: D1Database) {}

  async get(): Promise<AccountTokenRecord | null> {
    return this.db
      .prepare('SELECT * FROM account_tokens WHERE id = ?')
      .bind(SINGLETON_ID)
      .first<AccountTokenRecord>()
  }

  /** Grava (ou substitui) o token da conta. */
  async save(params: {
    igUserId: string
    username: string | null
    encryptedToken: string
    expiresAt: number
    now: number
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO account_tokens
           (id, ig_user_id, username, encrypted_token, expires_at,
            last_refreshed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           ig_user_id = excluded.ig_user_id,
           username = excluded.username,
           encrypted_token = excluded.encrypted_token,
           expires_at = excluded.expires_at,
           last_refreshed_at = excluded.last_refreshed_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        SINGLETON_ID,
        params.igUserId,
        params.username,
        params.encryptedToken,
        params.expiresAt,
        params.now,
        params.now,
        params.now,
      )
      .run()
  }

  /** Apaga o token. Usado pela rota de exclusao de dados. */
  async clear(): Promise<void> {
    await this.db.prepare('DELETE FROM account_tokens WHERE id = ?').bind(SINGLETON_ID).run()
  }
}
