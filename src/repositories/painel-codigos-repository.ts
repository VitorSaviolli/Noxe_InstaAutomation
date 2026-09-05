/**
 * Leitura e substituicao dos codigos de recuperacao e do codigo de parada.
 *
 * Como em `painel-config-repository.ts`, aqui nao existe regra de produto:
 * este arquivo devolve LINHAS e devolve STATEMENTS. Quem sorteia, normaliza e
 * compara e `src/services/panel-codes.ts`; quem decide o que fazer com o
 * resultado sao as rotas.
 *
 * A tabela guarda o HMAC, nunca o codigo (§8.5). Nada aqui aceita um codigo em
 * claro de proposito: se este arquivo pudesse receber o texto do codigo, um dia
 * alguem o passaria para um `console.log` de depuracao.
 *
 * **Nenhum metodo daqui grava por conta propria.** Os dois que escrevem
 * devolvem statements para o chamador juntar num unico `db.batch()` com a
 * linha de auditoria — e a regra de ouro de §8.8: sem log, sem mudanca.
 */

/** As duas familias de codigo. Nao existe uma terceira. */
export type TipoDeCodigo = 'recuperacao' | 'parada'

/** Um hash pronto para gravar. O codigo em claro nunca chega ate aqui. */
export interface CodigoParaGravar {
  hash: string
  tipo: TipoDeCodigo
  versaoHash: number
}

export class PainelCodigosRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Os hashes vivos de um tipo. UMA leitura, e a unica do caminho da parada.
   *
   * Traz a coluna `hash` e nada mais: e tudo o que a comparacao precisa, e
   * `criado_em`/`usado_em` na resposta so aumentariam a chance de alguem
   * imprimir a linha inteira em algum log.
   *
   * `usado_em` NAO entra no filtro de proposito: o codigo de parada nao e de
   * uso unico (§10.12), e o de recuperacao confere o uso unico na hora de
   * consumir, com `WHERE hash = ? AND usado_em IS NULL`, que e atomico.
   */
  async hashesVivos(tipo: TipoDeCodigo): Promise<string[]> {
    const resultado = await this.db
      .prepare('SELECT hash FROM painel_codigos WHERE tipo = ? AND invalidado_em IS NULL')
      .bind(tipo)
      .all<{ hash: string }>()

    if (resultado.success !== true) {
      throw new Error('D1_ERROR: a leitura dos codigos do painel nao reportou sucesso')
    }

    return (resultado.results ?? []).map((linha) => linha.hash)
  }

  /**
   * Apaga o conjunto antigo INTEIRO e grava o novo (§10.11).
   *
   * Gerar um conjunto novo invalida o anterior: uma lista impressa que a
   * pessoa achou que tinha substituido nao pode continuar valendo. O `DELETE`
   * vem primeiro no mesmo lote, entao nao existe instante com os dois
   * conjuntos vivos.
   */
  statementsDeSubstituicao(
    codigos: readonly CodigoParaGravar[],
    now: number,
  ): D1PreparedStatement[] {
    const insercoes = codigos.map((codigo) =>
      this.db
        .prepare(
          `INSERT INTO painel_codigos (hash, tipo, versao_hash, criado_em, usado_em, invalidado_em)
           VALUES (?, ?, ?, ?, NULL, NULL)`,
        )
        .bind(codigo.hash, codigo.tipo, codigo.versaoHash, now),
    )

    return [this.db.prepare('DELETE FROM painel_codigos'), ...insercoes]
  }

  /**
   * Consome UM codigo de recuperacao, e so ele (§10.11).
   *
   * `changes === 1` e a prova do uso unico, e ela e ATOMICA: o `WHERE` carrega
   * `usado_em IS NULL`, entao duas requisicoes com o mesmo codigo nao podem
   * ambas ver `1` — o D1 e SQLite com escritor unico, o mesmo padrao do
   * `claimComment` que o projeto ja usa.
   *
   * Statement, e nao gravacao, mas por um motivo DIFERENTE do resto do painel:
   * este aqui vai sozinho, ANTES do lote, porque §10.5 manda consumir a
   * autorizacao antes de inserir a credencial e aceita explicitamente o preco
   * — se a insercao falhar, o codigo foi queimado por nada. Se ele viajasse
   * dentro do lote, uma falha na credencial devolveria o codigo ao mundo, e ai
   * duas requisicoes com o mesmo codigo poderiam registrar duas passkeys.
   */
  statementDeConsumo(hash: string, now: number): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE painel_codigos SET usado_em = ?
          WHERE hash = ? AND tipo = 'recuperacao'
            AND usado_em IS NULL AND invalidado_em IS NULL`,
      )
      .bind(now, hash)
  }

  /**
   * Invalida em bloco todos os OUTROS codigos de recuperacao (§10.11).
   *
   * Justificativa da spec, em uma linha: se um codigo foi usado por quem nao
   * devia, os outros estao na mesma lista vazada. O codigo de PARADA nao entra
   * — ele nao abre cadastro nenhum, e derrubar o freio de emergencia junto
   * seria punir o dono no pior dia possivel.
   */
  statementDeInvalidacaoDosDemais(hash: string, now: number): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE painel_codigos SET invalidado_em = ?
          WHERE tipo = 'recuperacao' AND hash <> ?
            AND usado_em IS NULL AND invalidado_em IS NULL`,
      )
      .bind(now, hash)
  }
}
