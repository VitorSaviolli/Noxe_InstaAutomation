/**
 * `painel_auditoria`: o historico, no D1 do dono.
 *
 * A auditoria NASCE nesta etapa, e nao na etapa das telas: os dois primeiros
 * eventos auditaveis do projeto sao `codigos_gerados` e `parada_acionada`, e a
 * parada e justamente o evento que mais precisa de registro. A etapa das telas
 * acrescenta as linhas de MUDANCA DE CONFIGURACAO — as unicas que preenchem
 * `antes` e `depois`.
 *
 * Duas regras de §9.9 que este arquivo existe para tornar mecanicas:
 *
 * 1. **Sem log, sem mudanca.** `statementDeRegistro` devolve um statement para
 *    o chamador colocar no MESMO `db.batch()` da alteracao. Nao existe metodo
 *    que grave a auditoria sozinho: "grava e depois tenta logar" nao pode ser
 *    escrito por engano se a API nao oferecer.
 * 2. **Fracasso de requisicao NAO autenticada nao gera linha.** Gravar
 *    tentativa de estranho seria escrita provocada por estranho — a cota do D1
 *    e compartilhada com o webhook. Quem cuida disso e o chamador: a rota da
 *    parada so monta o lote quando o codigo confere.
 *
 * O que pode e o que nao pode entrar em `antes`/`depois` esta em §9.9 e vale
 * para quem monta o evento, nao para este arquivo: aqui as duas colunas sao
 * texto opaco, e nesta etapa os dois eventos as deixam `NULL`.
 */

/** De onde a linha veio. Espelha o `CHECK` de `origem` na migration 0002. */
export type OrigemDeAuditoria = 'painel' | 'parada' | 'assistente' | 'migracao'

/**
 * Um evento auditavel.
 *
 * `ator` nunca e o `credential_id` cru: passkey vira
 * `passkey:<8 hex do sha256 do credential_id>` (§9.9). Nesta etapa os dois
 * atores sao constantes: `'parada'` e `'assistente'`.
 */
export interface EventoDeAuditoria {
  ocorridoEm: number
  /**
   * Versao RESULTANTE da configuracao (§8.8, terceira funcao da versao).
   *
   * `0` para um evento que nao muda configuracao nenhuma — e o caso de
   * `codigos_gerados`, que nao pode pagar uma leitura de `painel_config` so
   * para carimbar um numero (a contabilidade de §9.10 da 0 consultas a essa
   * rota). A coluna nao tem `CHECK` de piso justamente para caber esse caso.
   */
  versao: number
  origem: OrigemDeAuditoria
  ator: string
  stepUp: boolean
  acao: string
  alvo: string | null
  /** Nomes de campo, nunca valores. JSON, e `'[]'` quando nao ha nenhum. */
  campos: string
  antes: string | null
  depois: string | null
}

/**
 * Retencao da auditoria (§8.9). E a UNICA poda de `painel_auditoria` do
 * projeto, e ela roda no cron — nunca no caminho de gravacao do painel.
 */
export const RETENCAO_DE_AUDITORIA = 500

export class PainelAuditoriaRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * O statement da linha de auditoria. Vai no lote de quem mudou o estado.
   *
   * Devolve um statement em vez de gravar: e o que impede, por construcao, a
   * mudanca que acontece sem log.
   */
  statementDeRegistro(evento: EventoDeAuditoria): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO painel_auditoria
           (ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        evento.ocorridoEm,
        evento.versao,
        evento.origem,
        evento.ator,
        evento.stepUp ? 1 : 0,
        evento.acao,
        evento.alvo,
        evento.campos,
        evento.antes,
        evento.depois,
      )
  }

  /**
   * Poda para as ultimas `RETENCAO_DE_AUDITORIA` linhas, SEM `COUNT(*)` (§8.9).
   *
   * `COUNT(*)` varreria a tabela inteira e cada linha varrida conta na cota de
   * leitura. O `OFFSET` sobre o `rowid` le no maximo 501 linhas e responde a
   * pergunta que interessa — "existe alguma linha alem das 500 mais recentes?"
   * — e o `DELETE` so acontece quando ha o que apagar.
   *
   * `id INTEGER PRIMARY KEY` E o rowid, entao ele ja e o indice cronologico:
   * nao existe indice novo para isto, e nao pode existir.
   *
   * Devolve quantas linhas foram apagadas. `0` significa que a tabela cabia no
   * teto e que NENHUMA escrita aconteceu.
   */
  async podar(): Promise<number> {
    const corte = await this.db
      .prepare('SELECT id FROM painel_auditoria ORDER BY id DESC LIMIT 1 OFFSET ?')
      .bind(RETENCAO_DE_AUDITORIA)
      .first<{ id: number }>()

    if (corte === null) return 0

    const apagadas = await this.db
      .prepare('DELETE FROM painel_auditoria WHERE id <= ?')
      .bind(corte.id)
      .run()

    return apagadas.meta.changes ?? 0
  }
}
