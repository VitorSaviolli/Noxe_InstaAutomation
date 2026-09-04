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
}
