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
 * no patch, nunca `undefined` (§9.3). A conversao mora no parser do
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
  /** As linhas ATIVAS, que sao as unicas que o webhook resolve (§9.4). */
  midias: PainelMidiaRecord[]
  /**
   * As linhas INTEIRAS, ativas e inativas, ou `null` quando quem leu nao
   * pediu por elas.
   *
   * `null` nao e "nao ha linhas": e "esta leitura nao perguntou". O caminho
   * quente nao pergunta, e a diferenca entre os dois importa porque a tela de
   * Reels mostra exatamente o que o filtro `ativo = 1` descarta.
   */
  todas: PainelMidiaRecord[] | null
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
 * As colunas de COMPORTAMENTO de `painel_config`, no formato do banco.
 *
 * Sao as colunas que o dono decide: de `enabled` a `user_cooldown_hours`.
 * Ficam de fora `versao`, `parado_por_codigo_em`, `criado_em` e
 * `atualizado_em`, que sao carimbo e nao ajuste, a mesma fronteira que §9.9
 * usa para dizer o que entra em `antes`/`depois`.
 *
 * A conversao de `AutomationConfig` para estas colunas e produto e mora em
 * quem chama: aqui elas chegam prontas, ja no formato do banco.
 */
export interface LinhaGravavel {
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
}

/**
 * Os valores que materializam a linha quando ela ainda nao existe (§8.3).
 *
 * Sao as colunas `NOT NULL` de `painel_config` que a parada nao decide: ela
 * decide `enabled`, `parado_por_codigo_em` e `versao`, e o resto vem da
 * fabrica.
 *
 * E um `Omit` de `LinhaGravavel`, e nao uma segunda lista com as mesmas treze
 * linhas: uma coluna nova de comportamento tem de aparecer nos DOIS escritores
 * da mesma linha, a parada e a gravacao do painel, e duas listas divergiriam
 * na primeira vez que alguem lembrasse de uma so.
 */
export type LinhaDeFabrica = Omit<LinhaGravavel, 'enabled'>

/**
 * A linha unica de `painel_config` (§8.3). Exportada porque a auditoria precisa
 * dela para prender a propria escrita a esta linha, e uma segunda grafia do `1`
 * seria a que nao mudaria no dia em que a primeira mudasse.
 */
export const ID_DA_CONFIG = 1

export class PainelConfigRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Le a config global e as midias ativas num unico `db.batch()`.
   *
   * Um `batch` vale UM subrequest, e o caminho quente carrega isto uma vez
   * por lote (§9.5), nunca por comentario. As duas consultas viajam juntas
   * tambem para que a linha global e as midias venham do MESMO instante: ler
   * em duas idas abriria a janela de um snapshot meio velho e meio novo.
   *
   * As midias vem ordenadas por `media_id` para que a ordem de `overrides` e
   * de `allowedMediaIds` seja estavel entre invocacoes, o `.find()` de
   * `resolveConfigForMedia` ja e deterministico porque `media_id` e PRIMARY
   * KEY, e a ordenacao mantem o log e a tela previsiveis.
   *
   * **`comAsInativas` e a variante do PAINEL, e ela custa zero subrequest.**
   * As duas telas de Reels precisam das linhas que o filtro `ativo = 1`
   * descarta, o Reel apagado que §12.5 manda nao sumir da lista, o selo de
   * regras proprias num Reel desmarcado, a lista "salvo por voce" quando a Meta
   * nao responde, e ate a rodada 1 elas pagavam uma consulta PROPRIA por isso,
   * o quarto subrequest que §12.10 nao orcava. Aqui a mesma pergunta viaja no
   * lote que ja existe: um `batch` vale UM subrequest, entao a variante nao
   * custa nada e as duas telas voltam aos 3 da tabela.
   *
   * **Um segundo statement filtrado, em vez de um terceiro sem filtro, foi a
   * escolha.** Um terceiro traria as linhas ativas DUAS vezes no mesmo lote e
   * quebraria a premissa de dois statements de que os testes de orcamento
   * dependem. Filtrar em JavaScript e o mesmo predicado, escrito uma vez.
   *
   * **O caminho quente nao muda:** sem a opcao, o SQL e literalmente o de
   * sempre, e `todas` volta `null`.
   */
  async ler(opcoes: { comAsInativas?: boolean } = {}): Promise<LeituraDeConfig> {
    const comAsInativas = opcoes.comAsInativas === true
    const [global, midias] = await this.db.batch<PainelConfigRecord | PainelMidiaRecord>([
      this.db.prepare('SELECT * FROM painel_config WHERE id = ?').bind(ID_DA_CONFIG),
      this.db.prepare(
        comAsInativas
          ? 'SELECT * FROM painel_midias ORDER BY media_id'
          : 'SELECT * FROM painel_midias WHERE ativo = 1 ORDER BY media_id',
      ),
    ])

    // Um `batch` que reporte falha SEM rejeitar entregaria dois resultados
    // vazios, e vazio aqui significa "linha ausente", ou seja, a fabrica
    // LIGADA. Seria o unico ponto do modulo em que um erro ALARGA em vez de
    // parar. Lancar aqui devolve o caso para a falha segura do `config-store`,
    // que o transforma em `parado_por_erro`. (CFG-14, CFG-18)
    if (global?.success !== true || midias?.success !== true) {
      throw new Error('D1_ERROR: a leitura da configuracao do painel nao reportou sucesso')
    }

    const linhas = (midias.results ?? []) as PainelMidiaRecord[]
    return {
      config: ((global.results ?? [])[0] as PainelConfigRecord | undefined) ?? null,
      // O filtro sai do SQL e vem para ca **so** na variante do painel, e ele e
      // o MESMO predicado: `ativo = 1`. Quem resolve comportamento continua
      // vendo exatamente as linhas ativas, com ou sem a variante.
      midias: comAsInativas ? linhas.filter((linha) => linha.ativo === 1) : linhas,
      todas: comAsInativas ? linhas : null,
    }
  }

  /**
   * A leitura barata da parada de emergencia: UMA consulta, duas colunas.
   *
   * `ler()` custaria duas, a linha global e as midias, e a parada nao olha
   * midia nenhuma. `versao` vem junto porque a linha de auditoria guarda a
   * versao RESULTANTE (§8.8) e perguntar por ela depois seria uma segunda
   * consulta na rota que §9.10 fixa em duas leituras.
   */
  async lerEstadoDaAutomacao(): Promise<EstadoDaAutomacao | null> {
    const linha = await this.db
      .prepare('SELECT enabled, versao FROM painel_config WHERE id = ?')
      .bind(ID_DA_CONFIG)
      .first<EstadoDaAutomacao>()

    return linha ?? null
  }

  /**
   * A data da ultima parada por codigo, para a confirmacao de religar (§10.12).
   *
   * Consulta PROPRIA, e nao uma coluna a mais em `lerEstadoDaAutomacao`: aquela
   * e a leitura barata da rota de parada, que §9.10 orca em duas leituras e que
   * nao tem nenhum uso para esta data. Aqui a pergunta e outra, "desde quando
   * esta desligada?", e ela so e feita quando a automacao esta DESLIGADA, que
   * e o unico estado em que a tela oferece religar.
   *
   * `null` significa duas coisas que a tela trata igual: nunca houve parada por
   * codigo, ou nao ha linha nenhuma. Nos dois casos a tela nao inventa uma data.
   */
  async lerParadaPorCodigo(): Promise<number | null> {
    const linha = await this.db
      .prepare('SELECT parado_por_codigo_em FROM painel_config WHERE id = ?')
      .bind(ID_DA_CONFIG)
      .first<{ parado_por_codigo_em: number | null }>()

    return linha?.parado_por_codigo_em ?? null
  }

  /**
   * O `UPDATE` da parada de emergencia, ou o `INSERT` que materializa a linha.
   *
   * Um unico statement porque §8.3 exige que a parada funcione **mesmo quando
   * a linha ainda nao existe**: um fork que nunca abriu o painel tem a
   * configuracao so no arquivo, e a ultima rota que precisa funcionar nao pode
   * depender de a pessoa ter salvado alguma vez.
   *
   * No ramo `INSERT` a linha nasce da fabrica com `versao = 1`; no ramo
   * `UPDATE` a versao anda +1, e esse incremento e recurso, nao efeito
   * colateral: quem estava com o formulario aberto e obrigado a recarregar e
   * ver que a automacao foi parada (§8.8).
   *
   * O `WHERE painel_config.enabled = 1` do `DO UPDATE` e o que impede a
   * RAJADA de contar errado. A rota ja evita a segunda parada lendo o estado
   * antes (STOP-08), mas essa leitura e uma decisao fora do banco: cinco POSTs
   * simultaneos com o codigo certo leem `enabled = 1` os cinco e mandam cinco
   * `UPDATE`, e a versao pularia de 1 para 6, quebrando o carimbo de "versao
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
        ID_DA_CONFIG,
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

  /**
   * O `UPDATE` da gravacao pelo painel, com a trava otimista de §8.8, ou o
   * `INSERT` que materializa a linha na PRIMEIRA vez que o dono salva.
   *
   * **A trava e a clausula `WHERE painel_config.versao = ?`.** A tela envia a
   * versao que carregou; se a linha ja andou, outra aba, ou a parada de
   * emergencia, que tambem incrementa a versao, o `DO UPDATE` nao casa,
   * `meta.changes` volta `0` e quem chamou responde `409`. O efeito colateral e
   * recurso, e nao acidente: quem estava com o formulario aberto e obrigado a
   * recarregar e ver, em letras grandes, que a automacao foi parada (§8.8).
   *
   * **`versaoEsperada = 0` e o unico valor legitimo para o ramo `INSERT`**:
   * `carregarConfigEfetiva` devolve `versao: 0` exatamente quando a linha nao
   * existe (`origem: 'arquivo'`). Um `INSERT` com `VALUES` nao aceita `WHERE`,
   * entao essa metade NAO e travada pelo SQL, quem chama confere a versao lida
   * contra a enviada antes de montar o lote, e o teste GRAV-08 e onde isso fica
   * preso.
   *
   * **`parado_por_codigo_em` fica de fora do `SET`, de proposito.** Ele e o
   * carimbo da ultima parada de emergencia, e e dele que §10.12 tira a data que
   * a tela mostra ao religar. Uma gravacao comum nao pode apagar esse carimbo:
   * religar devolve a chave ao estado anterior, e nao reescreve a historia.
   *
   * Devolve statement, e nao grava: ele vai no MESMO lote da linha de
   * auditoria. Sem log, sem mudanca.
   */
  statementDeGravacao(
    now: number,
    valores: LinhaGravavel,
    versaoEsperada: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO painel_config
           (id, enabled, trigger_keywords, match_mode, case_sensitive, normalize_accents,
            ignore_punctuation, process_only_reels, media_scope, public_reply_enabled,
            public_reply_text, private_reply_enabled, private_reply_text, destination_url,
            user_cooldown_hours, versao, parado_por_codigo_em, criado_em, atualizado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled              = excluded.enabled,
           trigger_keywords     = excluded.trigger_keywords,
           match_mode           = excluded.match_mode,
           case_sensitive       = excluded.case_sensitive,
           normalize_accents    = excluded.normalize_accents,
           ignore_punctuation   = excluded.ignore_punctuation,
           process_only_reels   = excluded.process_only_reels,
           media_scope          = excluded.media_scope,
           public_reply_enabled = excluded.public_reply_enabled,
           public_reply_text    = excluded.public_reply_text,
           private_reply_enabled= excluded.private_reply_enabled,
           private_reply_text   = excluded.private_reply_text,
           destination_url      = excluded.destination_url,
           user_cooldown_hours  = excluded.user_cooldown_hours,
           versao               = painel_config.versao + 1,
           atualizado_em        = excluded.atualizado_em
         WHERE painel_config.versao = ?`,
      )
      .bind(
        ID_DA_CONFIG,
        valores.enabled,
        valores.trigger_keywords,
        valores.match_mode,
        valores.case_sensitive,
        valores.normalize_accents,
        valores.ignore_punctuation,
        valores.process_only_reels,
        valores.media_scope,
        valores.public_reply_enabled,
        valores.public_reply_text,
        valores.private_reply_enabled,
        valores.private_reply_text,
        valores.destination_url,
        valores.user_cooldown_hours,
        now,
        now,
        versaoEsperada,
      )
  }
}
