/**
 * Leitura e escrita cruas de `painel_midias` (§8, §9.4, §12.5).
 *
 * Como o irmao `painel-config-repository.ts`, aqui nao existe regra de
 * produto: este arquivo devolve LINHAS e monta STATEMENTS. Quem julga se a
 * linha presta e o validador unico; quem decide o que gravar e a tela; e quem
 * grava e o funil de `gravar.ts`, no MESMO `db.batch()` da linha global e da
 * linha de auditoria.
 *
 * **Nenhum metodo daqui executa escrita.** Todos devolvem `D1PreparedStatement`,
 * pela mesma razao que o repositorio de configuracao: "sem log, sem mudanca"
 * (§8.8) so e verdade se a escrita da midia, a bump de `versao` e a linha de
 * auditoria estiverem no mesmo lote atomico. Um `.run()` aqui seria a segunda
 * grafia do lote, exatamente o que o Ruling 91 proibe.
 *
 * **`media_id` e TEXT em todo o caminho, sem excecao** (Ruling 90). A migration
 * `0002` ja avisa que converter para numero perde precisao acima de 2^53 e
 * "casa o Reel errado, sem erro nenhum". Nada neste arquivo chama `Number()`
 * sobre um id, e nada o faz atravessar `JSON.parse` sem aspas.
 *
 * **A leitura do CAMINHO QUENTE nao mora aqui**: ela e `PainelConfigRepository.ler()`,
 * que traz global e midias ativas num `batch` unico. Este repositorio serve a
 * TELA, que precisa tambem das linhas inativas, um Reel desmarcado continua
 * existindo, com a sobreposicao dele guardada, e some da tela se a consulta
 * filtrar por `ativo = 1`.
 */
import { ID_DA_CONFIG, type PainelMidiaRecord } from './painel-config-repository'

/**
 * A trava otimista de §8.8, escrita como CLAUSULA de cada escrita de midia.
 *
 * **Esta e a peca que faz a extensao do funil ser uma extensao e nao um
 * segundo funil** (Ruling 91). A trava do painel e uma so, `painel_config.versao`,
 * que a migration `0002` define como "contador monotonico de TODA a
 * configuracao (global + midias)", e uma escrita de midia que nao a
 * carregasse commitaria sozinha no dia em que outra aba tivesse salvo antes.
 *
 * **Ela nao pode ser `changes() > 0`**, que e como a linha de auditoria se
 * prende a gravacao: `changes()` responde sobre o statement imediatamente
 * anterior, e uma FILA de escritas de midia quebraria a corrente na primeira
 * que alterasse zero linhas. E nao pode ser `versao = <resultante>` depois do
 * `UPDATE` global, porque um escritor concorrente que empurrasse a versao para
 * o mesmo numero satisfaria a condicao, o caso exato que GRAV-19 constroi.
 *
 * Ela e o MESMO predicado do `UPDATE` global, avaliado ANTES dele: por isso as
 * escritas de midia vao no comeco do lote, e nao no fim. Dentro do
 * `db.batch()`, que roda em transacao, `versao` ainda e a de antes da bump,
 * entao as duas travas ou casam as duas, ou falham as duas.
 */
const TRAVA_DE_VERSAO = `EXISTS (SELECT 1 FROM painel_config WHERE id = ${ID_DA_CONFIG} AND versao = ?)`

/**
 * Teto de linhas em `painel_midias` (§12.5).
 *
 * 200 e o bound de carga fria, de memoria e de CPU do caminho quente: a
 * consulta do webhook varre a tabela inteira, e ela nao tem indice secundario
 * de proposito.
 */
export const TETO_DE_MIDIAS = 200

/** A partir daqui a tela avisa que o teto esta perto (§12.5). */
export const AVISO_DE_TETO_DE_MIDIAS = 197

/**
 * Ids NOVOS por gravacao (§12.5).
 *
 * 20 e o bound de SUBREQUESTS: cada id novo e revalidado contra a conta com
 * `getMediaInfo`, e vinte chamadas mais o lote de escrita cabem no teto de 50.
 */
export const IDS_NOVOS_POR_GRAVACAO = 20

/**
 * As colunas de sobreposicao de `painel_midias`, na ordem do schema.
 *
 * `NULL` significa CHAVE AUSENTE no patch, "este Reel segue a regra geral"
 * (§9.3). Nao existe um quarto estado, e por isso a lista e fechada aqui: um
 * `UPDATE` escrito a mao numa tela esqueceria uma coluna, e a coluna esquecida
 * ficaria com o valor velho enquanto a tela dissesse que ela voltou ao geral.
 */
export const COLUNAS_DE_SOBREPOSICAO = [
  'enabled',
  'trigger_keywords',
  'match_mode',
  'case_sensitive',
  'normalize_accents',
  'ignore_punctuation',
  'process_only_reels',
  'public_reply_enabled',
  'public_reply_text',
  'private_reply_enabled',
  'private_reply_text',
  'destination_url',
  'user_cooldown_hours',
] as const

export type ColunaDeSobreposicao = (typeof COLUNAS_DE_SOBREPOSICAO)[number]

/** Uma sobreposicao inteira. `null` numa coluna = segue a regra geral. */
export type Sobreposicao = Readonly<Record<ColunaDeSobreposicao, string | number | null>>

/** A sobreposicao vazia: todas as colunas seguindo a regra geral. */
export function semSobreposicao(): Sobreposicao {
  const vazia: Record<string, string | number | null> = {}
  for (const coluna of COLUNAS_DE_SOBREPOSICAO) vazia[coluna] = null
  return vazia as Sobreposicao
}

/** A sobreposicao que aquela linha do banco carrega hoje. */
export function sobreposicaoDaLinha(linha: PainelMidiaRecord): Sobreposicao {
  const atual: Record<string, string | number | null> = {}
  for (const coluna of COLUNAS_DE_SOBREPOSICAO) {
    atual[coluna] = (linha as unknown as Record<string, string | number | null>)[coluna] ?? null
  }
  return atual as Sobreposicao
}

/** Alguma coluna de sobreposicao esta preenchida? E o selo "Regras proprias". */
export function temRegrasProprias(sobreposicao: Sobreposicao): boolean {
  return COLUNAS_DE_SOBREPOSICAO.some((coluna) => sobreposicao[coluna] !== null)
}

/** Os metadados de TELA de um Reel. Nunca `thumbnail_url` nem `media_url`. */
export interface MetadadosDeMidia {
  readonly legendaCurta: string | null
  readonly permalink: string | null
  readonly mediaProductType: string | null
  readonly postadoEm: number | null
}

export class PainelMidiasRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * TODAS as linhas, ativas e inativas, em ordem estavel de `media_id`.
   *
   * As inativas vem junto de proposito: desmarcar um Reel na tela nao apaga a
   * sobreposicao dele, e uma consulta que filtrasse por `ativo = 1` faria a
   * pessoa remarcar o Reel e descobrir que "as regras proprias" voltaram
   * sozinhas, ou que sumiram, conforme o dia.
   */
  async lerTodas(): Promise<PainelMidiaRecord[]> {
    const resultado = await this.db
      .prepare('SELECT * FROM painel_midias ORDER BY media_id')
      .all<PainelMidiaRecord>()

    if (resultado.success !== true) {
      throw new Error('D1_ERROR: a leitura de painel_midias nao reportou sucesso')
    }
    return resultado.results ?? []
  }

  /**
   * Uma linha, pelo `media_id`.
   *
   * `null` significa "nao existe linha", e a tela de `/painel/reel?midia=`
   * trata isso como RECUSA e nao como Reel novo (Ruling 93): um id que nao
   * casa com linha nenhuma nao ganha tela propria.
   */
  async lerUma(mediaId: string): Promise<PainelMidiaRecord | null> {
    return await this.db
      .prepare('SELECT * FROM painel_midias WHERE media_id = ?')
      .bind(mediaId)
      .first<PainelMidiaRecord>()
  }

  /**
   * Desmarca TODAS as linhas ativas.
   *
   * A seleção da tela e um CONJUNTO, e a unica forma honesta de gravar um
   * conjunto e "zera e marca o que veio": um `DELETE` das que sairam perderia
   * a sobreposicao junto, e um `UPDATE` so das que entraram deixaria ativa
   * qualquer Reel que a pessoa desmarcou.
   *
   * `atualizado_em` anda so nas linhas que estavam ativas, o `WHERE` evita
   * carimbar 200 linhas a cada gravacao.
   */
  statementDeDesmarcarTodas(now: number, versaoEsperada: number): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE painel_midias SET ativo = 0, atualizado_em = ?
          WHERE ativo = 1 AND ${TRAVA_DE_VERSAO}`,
      )
      .bind(now, versaoEsperada)
  }

  /**
   * Marca UM Reel, criando a linha se ela ainda nao existir.
   *
   * Os metadados de tela sao atualizados junto, porque a listagem que acabou
   * de vir da Meta e a informacao mais nova que o painel tem sobre aquele
   * Reel. `indisponivel_desde` volta a `NULL`: o Reel apareceu na listagem,
   * entao ele existe de novo.
   *
   * **`ON CONFLICT` e o que torna `media_id` unico na pratica** e nao so no
   * schema: dois ids iguais no mesmo formulario viram duas escritas na MESMA
   * linha, e nao duas linhas. A recusa por duplicata continua sendo do
   * validador da tela, que e quem sabe dizer isso em portugues.
   */
  statementDeMarcar(
    now: number,
    versaoEsperada: number,
    mediaId: string,
    metadados: MetadadosDeMidia,
  ): D1PreparedStatement {
    // `INSERT ... SELECT ... WHERE`, e nao `VALUES`: `INSERT ... VALUES` nao
    // aceita `WHERE` em SQLite, e sem `WHERE` a trava de versao nao teria onde
    // morar. E o mesmo motivo pelo qual a linha de auditoria presa a mudanca e
    // um `SELECT`.
    return this.db
      .prepare(
        `INSERT INTO painel_midias
           (media_id, ativo, legenda_curta, permalink, media_product_type, postado_em,
            visto_em, indisponivel_desde, criado_em, atualizado_em)
         SELECT ?, 1, ?, ?, ?, ?, ?, NULL, ?, ? WHERE ${TRAVA_DE_VERSAO}
         ON CONFLICT(media_id) DO UPDATE SET
           ativo              = 1,
           legenda_curta      = excluded.legenda_curta,
           permalink          = excluded.permalink,
           media_product_type = excluded.media_product_type,
           postado_em         = excluded.postado_em,
           visto_em           = excluded.visto_em,
           indisponivel_desde = NULL,
           atualizado_em      = excluded.atualizado_em`,
      )
      .bind(
        mediaId,
        metadados.legendaCurta,
        metadados.permalink,
        metadados.mediaProductType,
        metadados.postadoEm,
        now,
        now,
        now,
        versaoEsperada,
      )
  }

  /**
   * Devolve um Reel que JA TEM linha a lista de escolhidos.
   *
   * Nao toca em metadado nenhum, e a omissao e a decisao: `getMediaInfo`, a
   * unica chamada que a gravacao faz, nao devolve legenda nem permalink, e
   * sobrescreve-los com vazio apagaria exatamente o que a tela mostra no estado
   * "o Instagram nao respondeu".
   *
   * `indisponivel_desde` volta a `NULL`: a pessoa acabou de reafirmar que quer
   * este Reel na lista, e o carimbo de "sumiu" so faz sentido enquanto ele
   * estiver sumido.
   */
  statementDeReativar(now: number, versaoEsperada: number, mediaId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE painel_midias
            SET ativo = 1, indisponivel_desde = NULL, atualizado_em = ?
          WHERE media_id = ? AND ${TRAVA_DE_VERSAO}`,
      )
      .bind(now, mediaId, versaoEsperada)
  }

  /**
   * Marca um Reel que a listagem NAO trouxe, preservando os metadados salvos.
   *
   * E o caminho de §12.5 "mídia apagada continua marcada como indisponível":
   * o Reel sumiu do Instagram, a pessoa nao o desmarcou, e desmarca-lo por
   * conta propria seria mudar a configuracao dela sem pedir. A linha continua
   * ativa, e `indisponivel_desde` passa a dizer desde quando.
   */
  statementDeMarcarIndisponivel(
    now: number,
    versaoEsperada: number,
    mediaId: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE painel_midias
            SET ativo = 1,
                indisponivel_desde = COALESCE(indisponivel_desde, ?),
                atualizado_em = ?
          WHERE media_id = ? AND ${TRAVA_DE_VERSAO}`,
      )
      .bind(now, now, mediaId, versaoEsperada)
  }

  /**
   * Escreve a sobreposicao INTEIRA de um Reel, as treze colunas de uma vez.
   *
   * Escrever a lista fechada, e nao "so o que mudou", e o que faz "Voltar tudo
   * a seguir a regra geral" ser uma operacao e nao treze: o botao manda a
   * sobreposicao vazia, e as treze colunas voltam a `NULL` no mesmo statement.
   */
  statementDeSobreposicao(
    now: number,
    versaoEsperada: number,
    mediaId: string,
    sobreposicao: Sobreposicao,
  ): D1PreparedStatement {
    const atribuicoes = COLUNAS_DE_SOBREPOSICAO.map((coluna) => `${coluna} = ?`).join(', ')

    return this.db
      .prepare(
        `UPDATE painel_midias SET ${atribuicoes}, atualizado_em = ?
          WHERE media_id = ? AND ${TRAVA_DE_VERSAO}`,
      )
      .bind(
        ...COLUNAS_DE_SOBREPOSICAO.map((coluna) => sobreposicao[coluna]),
        now,
        mediaId,
        versaoEsperada,
      )
  }
}
