/**
 * Leitura crua das tabelas de configuracao do painel.
 *
 * Aqui nao existe regra de produto: este arquivo devolve LINHAS, do jeito que
 * o D1 as entregou. Quem julga se a linha presta e o validador unico
 * (`config-validation.ts`), e quem monta o snapshot e `config-store.ts`. A
 * separacao existe porque o banco e entrada NAO confiavel: uma linha pode ter
 * entrado por `wrangler d1 execute` ou por um bug de migration futura.
 *
 * As colunas sao lidas com `SELECT *` de proposito. Coluna que este codigo
 * nao conhece e descartada em silencio pelo parser (CFG-04), que e o que
 * permite uma migration futura acrescentar coluna sem derrubar um Worker
 * antigo que ainda esteja no ar.
 */

/** A linha unica de `painel_config`, exatamente como o D1 a devolve. */
export interface PainelConfigRecord {
  id: number
  enabled: number
  trigger_keywords: string
  match_mode: string
  case_sensitive: number
  normalize_accents: number
  ignore_punctuation: number
  process_only_reels: number
  media_scope: string
  public_reply_enabled: number
  public_reply_text: string
  private_reply_enabled: number
  private_reply_text: string
  destination_url: string
  user_cooldown_hours: number
  versao: number
  parado_por_codigo_em: number | null
  criado_em: number
  atualizado_em: number
}

/**
 * Uma linha de `painel_midias`.
 *
 * Toda coluna de sobreposicao e NULL-avel, e `NULL` significa CHAVE AUSENTE
 * no patch — nunca `undefined` (§9.3). A conversao mora no parser do
 * `config-store.ts`.
 */
export interface PainelMidiaRecord {
  media_id: string
  ativo: number
  legenda_curta: string | null
  permalink: string | null
  media_product_type: string | null
  postado_em: number | null
  visto_em: number | null
  indisponivel_desde: number | null
  enabled: number | null
  trigger_keywords: string | null
  match_mode: string | null
  case_sensitive: number | null
  normalize_accents: number | null
  ignore_punctuation: number | null
  process_only_reels: number | null
  public_reply_enabled: number | null
  public_reply_text: string | null
  private_reply_enabled: number | null
  private_reply_text: string | null
  destination_url: string | null
  user_cooldown_hours: number | null
  criado_em: number
  atualizado_em: number
}

/** O que uma leitura completa devolve: a linha global e as midias ativas. */
export interface LeituraDeConfig {
  config: PainelConfigRecord | null
  midias: PainelMidiaRecord[]
}

/**
 * O que a parada de emergencia precisa saber antes de decidir se grava.
 *
 * `null` na leitura significa LINHA AUSENTE, e nao "automacao desligada": sem
 * linha, quem manda e a fabrica de `src/config.ts`, que nasce ligada.
 */
export interface EstadoDaAutomacao {
  enabled: number
  versao: number
}

/**
 * Os valores que materializam a linha quando ela ainda nao existe (§8.3).
 *
 * Sao as colunas `NOT NULL` de `painel_config` que a parada nao decide: ela
 * decide `enabled`, `parado_por_codigo_em` e `versao`, e o resto vem da
 * fabrica. A conversao de `AutomationConfig` para estas colunas e produto e
 * mora em quem chama — aqui elas chegam prontas, ja no formato do banco.
 */
export interface LinhaDeFabrica {
  trigger_keywords: string
  match_mode: string
  case_sensitive: number
  normalize_accents: number
  ignore_punctuation: number
  process_only_reels: number
  media_scope: string
  public_reply_enabled: number
  public_reply_text: string
  private_reply_enabled: number
  private_reply_text: string
  destination_url: string
  user_cooldown_hours: number
}

const SINGLETON_ID = 1

export class PainelConfigRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Le a config global e as midias ativas num unico `db.batch()`.
   *
   * Um `batch` vale UM subrequest, e o caminho quente carrega isto uma vez
   * por lote (§9.5) — nunca por comentario. As duas consultas viajam juntas
   * tambem para que a linha global e as midias venham do MESMO instante: ler
   * em duas idas abriria a janela de um snapshot meio velho e meio novo.
   *
   * As midias vem ordenadas por `media_id` para que a ordem de `overrides` e
   * de `allowedMediaIds` seja estavel entre invocacoes — o `.find()` de
   * `resolveConfigForMedia` ja e deterministico porque `media_id` e PRIMARY
   * KEY, e a ordenacao mantem o log e a tela previsiveis.
   */
  async ler(): Promise<LeituraDeConfig> {
    const [global, midias] = await this.db.batch<PainelConfigRecord | PainelMidiaRecord>([
      this.db.prepare('SELECT * FROM painel_config WHERE id = ?').bind(SINGLETON_ID),
      this.db.prepare('SELECT * FROM painel_midias WHERE ativo = 1 ORDER BY media_id'),
    ])

    // Um `batch` que reporte falha SEM rejeitar entregaria dois resultados
    // vazios, e vazio aqui significa "linha ausente" — ou seja, a fabrica
    // LIGADA. Seria o unico ponto do modulo em que um erro ALARGA em vez de
    // parar. Lancar aqui devolve o caso para a falha segura do `config-store`,
    // que o transforma em `parado_por_erro`. (CFG-14, CFG-18)
    if (global?.success !== true || midias?.success !== true) {
      throw new Error('D1_ERROR: a leitura da configuracao do painel nao reportou sucesso')
    }

    return {
      config: ((global.results ?? [])[0] as PainelConfigRecord | undefined) ?? null,
      midias: (midias.results ?? []) as PainelMidiaRecord[],
    }
  }

  /**
   * A leitura barata da parada de emergencia: UMA consulta, duas colunas.
   *
   * `ler()` custaria duas — a linha global e as midias — e a parada nao olha
   * midia nenhuma. `versao` vem junto porque a linha de auditoria guarda a
   * versao RESULTANTE (§8.8) e perguntar por ela depois seria uma segunda
   * consulta na rota que §9.10 fixa em duas leituras.
   */
  async lerEstadoDaAutomacao(): Promise<EstadoDaAutomacao | null> {
    const linha = await this.db
      .prepare('SELECT enabled, versao FROM painel_config WHERE id = ?')
      .bind(SINGLETON_ID)
      .first<EstadoDaAutomacao>()

    return linha ?? null
  }

  /**
   * O `UPDATE` da parada de emergencia — ou o `INSERT` que materializa a linha.
   *
   * Um unico statement porque §8.3 exige que a parada funcione **mesmo quando
   * a linha ainda nao existe**: um fork que nunca abriu o painel tem a
   * configuracao so no arquivo, e a ultima rota que precisa funcionar nao pode
   * depender de a pessoa ter salvado alguma vez.
   *
   * No ramo `INSERT` a linha nasce da fabrica com `versao = 1`; no ramo
   * `UPDATE` a versao anda +1 — e esse incremento e recurso, nao efeito
   * colateral: quem estava com o formulario aberto e obrigado a recarregar e
   * ver que a automacao foi parada (§8.8).
   *
   * O `WHERE painel_config.enabled = 1` do `DO UPDATE` e o que impede a
   * RAJADA de contar errado. A rota ja evita a segunda parada lendo o estado
   * antes (STOP-08), mas essa leitura e uma decisao fora do banco: cinco POSTs
   * simultaneos com o codigo certo leem `enabled = 1` os cinco e mandam cinco
   * `UPDATE`, e a versao pularia de 1 para 6 — quebrando o carimbo de "versao
   * resultante" de §8.8, que e a chave do log de auditoria. Com a clausula, so
   * o primeiro muda a linha; os outros quatro sao no-op de zero linha alterada.
   * A direcao continua segura nos dois casos (o resultado e `enabled = 0`), e
   * ela nao toca o ramo `INSERT`: um fork que nunca abriu o painel continua
   * materializando a linha ja desligada.
   *
   * Devolve statement, e nao grava: ele vai no MESMO lote da linha de
   * auditoria. Sem log, sem mudanca.
   */
  statementDeParada(now: number, fabrica: LinhaDeFabrica): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO painel_config
           (id, enabled, trigger_keywords, match_mode, case_sensitive, normalize_accents,
            ignore_punctuation, process_only_reels, media_scope, public_reply_enabled,
            public_reply_text, private_reply_enabled, private_reply_text, destination_url,
            user_cooldown_hours, versao, parado_por_codigo_em, criado_em, atualizado_em)
         VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled              = 0,
           parado_por_codigo_em = excluded.parado_por_codigo_em,
           versao               = painel_config.versao + 1,
           atualizado_em        = excluded.atualizado_em
         WHERE painel_config.enabled = 1`,
      )
      .bind(
        SINGLETON_ID,
        fabrica.trigger_keywords,
        fabrica.match_mode,
        fabrica.case_sensitive,
        fabrica.normalize_accents,
        fabrica.ignore_punctuation,
        fabrica.process_only_reels,
        fabrica.media_scope,
        fabrica.public_reply_enabled,
        fabrica.public_reply_text,
        fabrica.private_reply_enabled,
        fabrica.private_reply_text,
        fabrica.destination_url,
        fabrica.user_cooldown_hours,
        now,
        now,
        now,
      )
  }
}
