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
  /**
   * Host exato do painel administrativo, sem esquema e sem barra.
   *
   * E o `rpId` do WebAuthn E a base da origem esperada — nao existe
   * `PANEL_ORIGIN`, para que origem e `rpId` nao possam divergir. Nasce VAZIO
   * no repositorio, porque cada instalacao tem o proprio endereco; vazio
   * significa painel em 503, que e o padrao seguro e nao um defeito.
   */
  PANEL_RP_ID: string
  /**
   * Dominios para os quais o painel pode apontar o link do Direct.
   *
   * Separados por virgula, em minusculas e em punycode. Um item que comeca
   * com ponto (`.exemplo.com.br`) tambem libera os subdominios.
   *
   * E a trava que o painel NAO pode alterar: o bloco `vars` do wrangler.jsonc
   * e sobrescrito a cada publicacao, entao mudar esta lista exige o
   * repositorio mais a credencial de deploy — as duas coisas que um painel
   * invadido nao tem. Nasce VAZIA no repositorio, porque cada instalacao tem o
   * proprio dominio; vazia significa que o painel nao altera link nem texto do
   * Direct, e a entrega segue com o link que ja esta valendo.
   */
  ALLOWED_LINK_DOMAINS: string

  // --- Segredos (wrangler secret put) ---
  /** Valida X-Hub-Signature-256 e assina a troca de code no OAuth. */
  META_APP_SECRET: string
  /** Confere o handshake GET do webhook. */
  META_WEBHOOK_VERIFY_TOKEN: string
  /** Chave AES-GCM (base64, 32 bytes) que cifra o access token no D1. */
  TOKEN_ENCRYPTION_KEY: string
  /** Protege as rotas administrativas. Enviado como Authorization: Bearer. */
  SETUP_ADMIN_TOKEN: string
  /**
   * Raiz das quatro subchaves do painel: sessao, desafio, csrf e codigos.
   *
   * NUNCA reutilizar aqui o SETUP_ADMIN_TOKEN nem o TOKEN_ENCRYPTION_KEY.
   * Rotacionar o admin token nao pode derrubar as sessoes, e vazar um convite
   * — que e assinado com o admin token — nao pode entregar a chave das
   * sessoes. Ausente, o painel inteiro responde 503.
   */
  PANEL_SESSION_KEY: string
}
