/**
 * Contrato de ambiente do Worker.
 *
 * Valores de "vars" do wrangler.jsonc chegam como string. Segredos chegam
 * pelo Cloudflare Secrets (producao) ou pelo .dev.vars local.
 *
 * Configuracao de COMPORTAMENTO nao mora aqui — mora em src/config.ts.
 */
export interface Env {
  /** Banco: dedup de comentarios, cooldown e token cifrado. */
  DB: D1Database

  // --- Identificadores publicos (wrangler.jsonc "vars") ---
  /** ID publico do app no Meta for Developers. */
  META_APP_ID: string
  /** Versao da Graph API usada nas chamadas, ex: "v23.0". */
  META_API_VERSION: string
  /** ID da conta profissional. Preenchido apos o primeiro OAuth. */
  META_IG_USER_ID: string

  // --- Segredos (wrangler secret put) ---
  /** Valida X-Hub-Signature-256 e assina a troca de code no OAuth. */
  META_APP_SECRET: string
  /** Confere o handshake GET do webhook. */
  META_WEBHOOK_VERIFY_TOKEN: string
  /** Chave AES-GCM (base64, 32 bytes) que cifra o access token no D1. */
  TOKEN_ENCRYPTION_KEY: string
  /** Protege as rotas administrativas. Enviado como Authorization: Bearer. */
  SETUP_ADMIN_TOKEN: string
}
