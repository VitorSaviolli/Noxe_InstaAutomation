import { describe, expect, test } from 'vitest'
import type { NormalizeOptions } from '../src/utils/normalize'
import { matchKeyword, normalizeText } from '../src/utils/normalize'

const DEFAULT_OPTIONS: NormalizeOptions = {
  caseSensitive: false,
  normalizeAccents: true,
  ignorePunctuation: true,
}

describe('normalizeText', () => {
  test('colapsa espacos extras em um unico espaco', () => {
    expect(normalizeText('eu    quero', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('remove espacos das pontas', () => {
    expect(normalizeText('   eu quero   ', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('trata quebra de linha como espaco', () => {
    expect(normalizeText('eu\nquero', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('trata tab como espaco', () => {
    expect(normalizeText('eu\tquero', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('converte para minusculas quando caseSensitive e false', () => {
    expect(normalizeText('EU QUERO', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('preserva maiusculas quando caseSensitive e true', () => {
    const options = { ...DEFAULT_OPTIONS, caseSensitive: true }
    expect(normalizeText('EU QUERO', options)).toBe('EU QUERO')
  })

  test('remove acentos quando normalizeAccents e true', () => {
    expect(normalizeText('cardápio', DEFAULT_OPTIONS)).toBe('cardapio')
  })

  test('preserva acentos quando normalizeAccents e false', () => {
    const options = { ...DEFAULT_OPTIONS, normalizeAccents: false }
    expect(normalizeText('cardápio', options)).toBe('cardápio')
  })

  test('remove pontuacao quando ignorePunctuation e true', () => {
    expect(normalizeText('eu quero!!!', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('preserva pontuacao quando ignorePunctuation e false', () => {
    const options = { ...DEFAULT_OPTIONS, ignorePunctuation: false }
    expect(normalizeText('eu quero!', options)).toBe('eu quero!')
  })
})

describe('matchKeyword em modo exact', () => {
  const keywords = ['eu quero']

  test('casa a palavra exata', () => {
    expect(matchKeyword('eu quero', keywords, 'exact', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('casa ignorando maiusculas', () => {
    expect(matchKeyword('EU QUERO', keywords, 'exact', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('casa ignorando espacos extras', () => {
    expect(matchKeyword('  eu   quero  ', keywords, 'exact', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('casa ignorando pontuacao final', () => {
    expect(matchKeyword('Eu quero!', keywords, 'exact', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('NAO casa quando ha texto a mais', () => {
    expect(matchKeyword('eu quero o link', keywords, 'exact', DEFAULT_OPTIONS)).toBeNull()
  })

  test('NAO casa texto sem relacao', () => {
    expect(matchKeyword('que legal', keywords, 'exact', DEFAULT_OPTIONS)).toBeNull()
  })

  test('NAO casa string vazia', () => {
    expect(matchKeyword('', keywords, 'exact', DEFAULT_OPTIONS)).toBeNull()
  })

  test('NAO casa apenas espacos', () => {
    expect(matchKeyword('   ', keywords, 'exact', DEFAULT_OPTIONS)).toBeNull()
  })
})

describe('matchKeyword em modo contains', () => {
  const keywords = ['eu quero']

  test('casa quando a keyword aparece no meio da frase', () => {
    expect(matchKeyword('oi, eu quero o link', keywords, 'contains', DEFAULT_OPTIONS)).toBe(
      'eu quero',
    )
  })

  test('casa ignorando maiusculas e acentos', () => {
    expect(matchKeyword('EU QUERÔ isso', keywords, 'contains', DEFAULT_OPTIONS)).toBe('eu quero')
  })

  test('NAO casa quando a keyword nao aparece', () => {
    expect(matchKeyword('nao tenho interesse', keywords, 'contains', DEFAULT_OPTIONS)).toBeNull()
  })
})

describe('matchKeyword com multiplas keywords', () => {
  const keywords = ['eu quero', 'quero o link', 'tenho interesse']

  test('casa a segunda keyword da lista', () => {
    expect(matchKeyword('quero o link', keywords, 'exact', DEFAULT_OPTIONS)).toBe('quero o link')
  })

  test('casa a terceira keyword da lista', () => {
    expect(matchKeyword('Tenho Interesse', keywords, 'exact', DEFAULT_OPTIONS)).toBe(
      'tenho interesse',
    )
  })

  test('devolve null quando nenhuma casa', () => {
    expect(matchKeyword('parabens', keywords, 'exact', DEFAULT_OPTIONS)).toBeNull()
  })

  test('ignora keyword vazia na lista', () => {
    expect(matchKeyword('qualquer coisa', ['', 'eu quero'], 'exact', DEFAULT_OPTIONS)).toBeNull()
  })
})
