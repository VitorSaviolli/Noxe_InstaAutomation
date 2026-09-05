/**
 * `painel_sessoes`: as sessoes vivas do painel.
 *
 * A tabela nasce nesta etapa porque a etapa do registro precisa dela por dois
 * motivos, e nenhum deles e emitir sessao: o modo `sessao` do registro de
 * passkey le a linha para saber QUEM esta pedindo, e o codigo de recuperacao
 * apaga TODAS as linhas no mesmo lote em que e consumido (§10.11). Quem
 * EMITE sessao e o login, e isso e a etapa seguinte — `POST
 * /painel/api/registrar/verificar` nao emite sessao nenhuma (§15.3, decisao 5).
 *
 * O cookie carrega um identificador aleatorio; aqui fica so o SHA-256 dele
 * (§8.6). Um dump do D1 nao entrega cookie utilizavel, do mesmo jeito que a
 * tabela de comentarios guarda hash do IGSID e nao o IGSID.
 */

/** Uma sessao viva, como o banco a guarda. */
export interface LinhaDeSessao {
  sidHash: string
  credentialId: string
  rpId: string
  criadaEm: number
  expiraEm: number
  ociosaAte: number
  vistaEm: number
  falhasStepup: number
}

export class PainelSessoesRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * A sessao daquele `sha256(sid)`, ou `null`.
   *
   * A LINHA e a autoridade, e nao o cookie: o HMAC do cookie e o filtro
   * gratuito que recusa lixo sem tocar no D1 (§10.8), mas quem responde "esta
   * sessao ainda existe?" e esta consulta. E por isso que apagar a linha
   * invalida a sessao emitida, que e a garantia de §10.13.
   *
   * O prazo NAO e conferido aqui: quem compara relogio sao as rotas, que
   * recebem `now` por parametro. Um repositorio que lesse `Date.now()` seria o
   * primeiro lugar do painel a fazer isso.
   */
  async buscarPorHash(sidHash: string): Promise<LinhaDeSessao | null> {
    const linha = await this.db
      .prepare(
        `SELECT sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate,
                vista_em, falhas_stepup
           FROM painel_sessoes
          WHERE sid_hash = ?`,
      )
      .bind(sidHash)
      .first<{
        sid_hash: string
        credential_id: string
        rp_id: string
        criada_em: number
        expira_em: number
        ociosa_ate: number
        vista_em: number
        falhas_stepup: number
      }>()

    if (linha === null) return null

    return {
      sidHash: linha.sid_hash,
      credentialId: linha.credential_id,
      rpId: linha.rp_id,
      criadaEm: linha.criada_em,
      expiraEm: linha.expira_em,
      ociosaAte: linha.ociosa_ate,
      vistaEm: linha.vista_em,
      falhasStepup: linha.falhas_stepup,
    }
  }

  /**
   * O UNICO `INSERT INTO painel_sessoes` do projeto.
   *
   * Devolve um statement, e nao grava: a sessao nasce no MESMO `db.batch()` da
   * atualizacao da credencial e da linha de auditoria do login (§9.10 — 3
   * escritas, um lote). "Grava a sessao e depois tenta logar" nao pode ser
   * escrito por engano se a API nao oferecer (§8.8).
   *
   * Sem `ON CONFLICT`: o `sid` sao 32 bytes sorteados a cada emissao, entao um
   * `sid_hash` repetido nao e colisao — e defeito no sorteio, e o lote inteiro
   * tem de falhar em vez de sobrescrever a sessao de outra pessoa.
   */
  statementDeCriacao(linha: LinhaDeSessao): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO painel_sessoes
           (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate,
            vista_em, falhas_stepup)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        linha.sidHash,
        linha.credentialId,
        linha.rpId,
        linha.criadaEm,
        linha.expiraEm,
        linha.ociosaAte,
        linha.vistaEm,
        linha.falhasStepup,
      )
  }

  /**
   * Apaga TODAS as sessoes. Statement, para entrar no lote de quem decidiu.
   *
   * Usado pelo consumo de um codigo de recuperacao (§10.11): se um codigo foi
   * usado por quem nao devia, qualquer sessao aberta pode ser dele. O mesmo
   * statement serve a "sair de todos os aparelhos" (§10.13), que chega na
   * etapa dos aparelhos.
   */
  statementDeApagarTodas(): D1PreparedStatement {
    return this.db.prepare('DELETE FROM painel_sessoes')
  }
}
