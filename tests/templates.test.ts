import { describe, expect, test } from 'vitest'
import { renderTemplate, sanitizeValue } from '../src/utils/templates'

/** Caractere de controle NUL, construido sem literal para nao poluir o fonte. */
const NUL = String.fromCharCode(0)
/** Caractere de controle BEL. */
const BEL = String.fromCharCode(7)

describe('renderTemplate', () => {
  test('substitui {username} e {link}', () => {
    const result = renderTemplate('Olá, {username}! Link: {link}', {
      username: 'maria',
      link: 'https://exemplo.com',
    })
    expect(result).toBe('Olá, maria! Link: https://exemplo.com')
  })

  test('substitui todas as ocorrencias do mesmo placeholder', () => {
    const result = renderTemplate('{username}, {username}!', {
      username: 'joao',
      link: 'https://x.com',
    })
    expect(result).toBe('joao, joao!')
  })

  test('mantem placeholder desconhecido intacto', () => {
    const result = renderTemplate('Oi {username}, veja {outro}', {
      username: 'ana',
      link: 'https://x.com',
    })
    expect(result).toBe('Oi ana, veja {outro}')
  })

  test('funciona sem nenhum placeholder', () => {
    expect(renderTemplate('mensagem fixa', { username: 'a', link: 'b' })).toBe('mensagem fixa')
  })

  test('sanitiza username com caractere de controle', () => {
    const result = renderTemplate('Oi {username}', {
      username: `ma${NUL}ria`,
      link: 'https://x.com',
    })
    expect(result).toBe('Oi maria')
  })

  test('template vazio devolve string vazia', () => {
    expect(renderTemplate('', { username: 'a', link: 'b' })).toBe('')
  })
})

describe('sanitizeValue', () => {
  test('remove caracteres de controle', () => {
    expect(sanitizeValue(`ab${NUL}cd`, 100)).toBe('abcd')
    expect(sanitizeValue(`ab${BEL}cd`, 100)).toBe('abcd')
  })

  test('limita o tamanho', () => {
    expect(sanitizeValue('abcdef', 3)).toBe('abc')
  })

  test('remove espacos das pontas', () => {
    expect(sanitizeValue('  ola  ', 100)).toBe('ola')
  })

  test('preserva texto normal', () => {
    expect(sanitizeValue('usuario_teste', 100)).toBe('usuario_teste')
  })
})
