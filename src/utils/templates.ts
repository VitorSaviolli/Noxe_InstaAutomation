/**
 * Substituicao de placeholders nas mensagens.
 *
 * Os valores vem de dados do Instagram (username) e da config (link), entao
 * passam por sanitizacao antes de entrar no texto. Nao e escape de HTML — a
 * mensagem e texto puro no Direct — e sim defesa contra caracteres de
 * controle e valores absurdamente longos que quebrariam o payload da API.
 */

/**
 * Caracteres de controle (Cc) e de formatacao invisivel (Cf).
 * Cf inclui zero-width joiner e marcas de direcao, usadas para disfarcar
 * texto — nao tem lugar num username nem numa URL.
 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu

/** Limite defensivo para um username do Instagram (o real e 30). */
const MAX_USERNAME_LENGTH = 64

/** Limite defensivo para uma URL. */
const MAX_LINK_LENGTH = 2048

/** Remove caracteres de controle e limita o tamanho. */
export function sanitizeValue(value: string, maxLength: number): string {
  return value.replace(CONTROL_CHARS, '').trim().slice(0, maxLength)
}

export interface TemplateValues {
  username: string
  link: string
}

/**
 * Troca {username} e {link} no template.
 *
 * Placeholders desconhecidos ficam intactos — e melhor entregar a mensagem
 * com um `{foo}` visivel do que engolir silenciosamente um erro de config.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const username = sanitizeValue(values.username, MAX_USERNAME_LENGTH)
  const link = sanitizeValue(values.link, MAX_LINK_LENGTH)

  return template.replaceAll('{username}', username).replaceAll('{link}', link)
}
