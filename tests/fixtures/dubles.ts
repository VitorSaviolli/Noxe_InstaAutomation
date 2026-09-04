/**
 * Dubles injetados por parametro. Nada de mock de modulo.
 *
 * Este arquivo mora em `tests/fixtures/`, que nao casa com o `include` do
 * vitest, entao ele nao vira uma suite vazia.
 */

/** Statements que gravam. Serve para separar leitura de escrita na contagem. */
const ESCRITA = /^\s*(insert|update|delete|replace)/i

/**
 * Envolve um D1Database real e conta o que passa por ele.
 *
 * E o unico jeito honesto de transformar "nao estoura o teto de 50
 * subrequests por invocacao" — que e uma afirmacao sobre a plataforma, e que
 * o Miniflare NAO impoe — numa afirmacao sobre o codigo.
 *
 * `prepares` conta cada statement preparado, inclusive os que depois entram
 * num `db.batch()`. Como um `db.batch()` inteiro vale UM subrequest, o numero
 * e conservador: ele nunca subestima o gasto real.
 */
export class D1Contador {
  prepares = 0
  escritas = 0
  batches = 0
  execs = 0
  dumps = 0

  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    this.prepares++
    if (ESCRITA.test(sql)) this.escritas++
    return this.real.prepare(sql)
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches++
    return this.real.batch<T>(statements)
  }

  exec(query: string): Promise<D1ExecResult> {
    this.execs++
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    this.dumps++
    return this.real.dump()
  }

  /** Zera os contadores sem trocar o banco por baixo. */
  zerar(): void {
    this.prepares = 0
    this.escritas = 0
    this.batches = 0
    this.execs = 0
    this.dumps = 0
  }
}

/** Entrega o contador onde o codigo de producao espera um D1Database. */
export function comoD1(contador: D1Contador): D1Database {
  return contador as unknown as D1Database
}
