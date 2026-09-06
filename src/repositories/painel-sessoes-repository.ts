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

/**
 * Quantas falhas de step-up apagam a sessao (§7.6, §10.10).
 *
 * Mora ao lado da coluna que ele conta. O numero e o unico teto que o painel
 * aplica a uma rota JA autenticada: quem esta martelando step-up dentro de uma
 * sessao valida ou e o dono errando, ou e um painel invadido tentando adivinhar
 * — e nos dois casos derrubar a sessao e a direcao segura.
 */
export const FALHAS_DE_STEPUP_ATE_APAGAR = 10

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
   * A rotacao do `sid` depois de um step-up bem-sucedido (§10.8, §10.10).
   *
   * §10.8 lista dois momentos de rotacao, e este e o segundo: a sessao muda de
   * "conseguiu ler" para "acabou de autorizar". Como ela acontece na MESMA
   * requisicao que grava e responde `303`, o cookie novo chega junto com o
   * redirect — nao existe a corrida de rede movel em que o cookie novo se perde.
   *
   * **`WHERE sid_hash = ?` com o hash ANTIGO**, e nao um `INSERT`: a sessao e a
   * mesma linha, com o mesmo `expira_em`, o mesmo `criada_em` e o mesmo
   * `falhas_stepup`. Uma linha nova daria uma sessao com prazo absoluto novo, e
   * SES-01 diz que ele **nunca** e estendido.
   *
   * **`falhas_stepup` NAO e zerado aqui**, e a ausencia e decisao: §10.10 manda
   * incrementar na falha e apagar a sessao na decima, e nao diz que o sucesso
   * perdoa as anteriores. Zerar transformaria "dez falhas apagam a sessao" em
   * "dez falhas SEGUIDAS apagam a sessao", que e um teto que quem esta
   * martelando consegue nunca alcancar.
   *
   * Statement, e nao gravacao: a rotacao entra no MESMO `db.batch()` da
   * configuracao e da auditoria — sem log, sem mudanca, e sem sessao rotacionada
   * por uma gravacao que nao aconteceu.
   *
   * **`AND changes() > 0` nao e enfeite, e este statement so esta certo na
   * TERCEIRA posicao daquele lote.** A trava otimista de §8.8 pode fazer o
   * `UPDATE` da configuracao alterar zero linhas sem que o `db.batch()` rejeite
   * nada; a linha de auditoria ja se defende disso pelo mesmo `changes()`, e sem
   * esta condicao a rotacao aconteceria assim mesmo. O `sid` no banco mudaria, a
   * rota responderia `versao_desatualizada` **sem** mandar o cookie novo, e o
   * dono seria deslogado por uma gravacao que nunca aconteceu — o pior desfecho
   * possivel para quem acabou de encostar o dedo no leitor.
   *
   * A cadeia: `UPDATE` da config altera N linhas; o `INSERT` da auditoria roda
   * `WHERE changes() > 0` e insere 1 quando N > 0, ou 0 quando N = 0; entao
   * `changes()` vale 1 ou 0 exatamente quando a gravacao aconteceu ou nao.
   */
  statementDeRotacao(sidHashAntigo: string, sidHashNovo: string): D1PreparedStatement {
    return this.db
      .prepare('UPDATE painel_sessoes SET sid_hash = ? WHERE sid_hash = ? AND changes() > 0')
      .bind(sidHashNovo, sidHashAntigo)
  }

  /**
   * Uma falha de step-up a mais naquela sessao (§10.10).
   *
   * O incremento e feito no SQL (`falhas_stepup + 1`) e nao em JavaScript: um
   * valor calculado no Worker e lido antes do lote perderia uma tentativa
   * simultanea, e o contador que existe para limitar martelada nao pode ser o
   * primeiro a perder contagem sob martelada.
   */
  statementDeFalhaDeStepup(sidHash: string): D1PreparedStatement {
    return this.db
      .prepare('UPDATE painel_sessoes SET falhas_stepup = falhas_stepup + 1 WHERE sid_hash = ?')
      .bind(sidHash)
  }

  /** Apaga UMA sessao. E o que a decima falha de step-up faz (§10.10). */
  statementDeApagar(sidHash: string): D1PreparedStatement {
    return this.db.prepare('DELETE FROM painel_sessoes WHERE sid_hash = ?').bind(sidHash)
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
