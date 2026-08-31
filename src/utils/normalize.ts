import type { AutomationConfig, MatchMode } from '../config'

/**
 * Marcas de combinacao Unicode (os acentos, depois que NFD os separa da letra).
 * `\p{M}` cobre acentos de qualquer alfabeto, nao so os latinos.
 */
const COMBINING_MARKS = /\p{M}/gu

/**
 * Pontuacao e simbolos. `\p{P}` pega ! ? . , ; : e tambem os invertidos
 * (interrogacao e exclamacao do espanhol); `\p{S}` pega simbolos e emoji,
 * entao "eu quero 🔥" normaliza para "eu quero" e casa em modo exact.
 */
const PUNCTUATION_AND_SYMBOLS = /[\p{P}\p{S}]/gu

/** Qualquer sequencia de espacos, tabs ou quebras de linha. */
const WHITESPACE = /\s+/g

export interface NormalizeOptions {
  caseSensitive: boolean
  normalizeAccents: boolean
  ignorePunctuation: boolean
}

/**
 * Normaliza texto para comparacao.
 *
 * Sempre colapsa espacos, tabs e quebras de linha em um unico espaco e
 * remove espacos das pontas. Minusculas, acentos e pontuacao sao opcionais.
 */
export function normalizeText(input: string, options: NormalizeOptions): string {
  let text = input

  if (!options.caseSensitive) {
    text = text.toLowerCase()
  }

  if (options.normalizeAccents) {
    text = text.normalize('NFD').replace(COMBINING_MARKS, '')
  }

  if (options.ignorePunctuation) {
    text = text.replace(PUNCTUATION_AND_SYMBOLS, ' ')
  }

  return text.replace(WHITESPACE, ' ').trim()
}

/** Extrai as opcoes de normalizacao de uma AutomationConfig. */
export function normalizeOptionsFrom(config: AutomationConfig): NormalizeOptions {
  return {
    caseSensitive: config.caseSensitive,
    normalizeAccents: config.normalizeAccents,
    ignorePunctuation: config.ignorePunctuation,
  }
}

/**
 * Decide se um comentario aciona a automacao.
 *
 * `exact`    — o texto normalizado precisa ser igual a uma das keywords.
 * `contains` — basta que uma keyword apareca como SUBSTRING do texto.
 *
 * Retorna a keyword que casou (util para log e teste) ou null.
 */
export function matchKeyword(
  commentText: string,
  keywords: readonly string[],
  mode: MatchMode,
  options: NormalizeOptions,
): string | null {
  const haystack = normalizeText(commentText, options)
  if (haystack.length === 0) return null

  for (const keyword of keywords) {
    const needle = normalizeText(keyword, options)
    if (needle.length === 0) continue

    const hit = mode === 'exact' ? haystack === needle : haystack.includes(needle)
    if (hit) return keyword
  }

  return null
}
