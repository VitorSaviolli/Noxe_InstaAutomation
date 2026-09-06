/**
 * `painel_auditoria`: o historico, no D1 do dono.
 *
 * A auditoria NASCEU na etapa da parada: os dois primeiros eventos auditaveis
 * do projeto sao `codigos_gerados` e `parada_acionada`, e a parada e justamente
 * o evento que mais precisa de registro. A etapa da ESCRITA acrescentou as
 * linhas de MUDANCA DE CONFIGURACAO — as unicas que preenchem `antes` e
 * `depois` — e a leitura do historico que a tela de Ajustes mostra no fim.
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
 * texto opaco. Quem as preenche e `routes/painel/gravar.ts`, que e onde a
 * lista de campos de comportamento tem sentido.
 */

/** De onde a linha veio. Espelha o `CHECK` de `origem` na migration 0002. */
export type OrigemDeAuditoria = 'painel' | 'parada' | 'assistente' | 'migracao'

/**
 * A lista FECHADA de acoes de §9.9, e ela e uma so.
 *
 * Um `string` solto aqui deixaria `config_alterda` entrar no banco sem nenhum
 * teste cair: o `CHECK` da migration confere so o comprimento, porque uma
 * enumeracao no SQL travaria uma migration futura. A trava tem de ser de tipo,
 * e e esta.
 */
export type AcaoDeAuditoria =
  | 'config_alterada'
  | 'midia_alterada'
  | 'mudanca_recusada'
  | 'login'
  | 'sessao_encerrada'
  | 'passkey_registrada'
  | 'passkey_removida'
  | 'stepup_recusado'
  | 'codigos_gerados'
  | 'recuperacao_usada'
  | 'parada_acionada'
  | 'acesso_zerado'

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
  acao: AcaoDeAuditoria
  alvo: string | null
  /** Nomes de campo, nunca valores. JSON, e `'[]'` quando nao ha nenhum. */
  campos: string
  antes: string | null
  depois: string | null
}

/**
 * Uma linha de `config_alterada`, do jeito que a tela de Ajustes a mostra.
 *
 * `depois` NAO vem: a tela mostra o que mudou e oferece voltar ao `antes`, e o
 * `depois` de cada linha e o `antes` da seguinte ou o estado de hoje. Trazer
 * uma coluna de ate 4000 caracteres que ninguem le sairia caro numa tela que
 * §12.10 orca em subrequests contados.
 */
export interface MudancaRegistrada {
  ocorridoEm: number
  versao: number
  /** JSON cru da coluna `campos`. Quem le TRATA como texto nao confiavel. */
  campos: string
  /** JSON cru do estado anterior. E o corpo do botao "Voltar a esta versao". */
  antes: string
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
   *
   * **`presoAMudanca` fecha a metade contraria**, e ela tambem existe: uma
   * gravacao que PERDE a trava otimista de §8.8 e um `UPDATE` de zero linhas
   * dentro de um lote que rodou inteiro — `db.batch()` nao rejeita por isso, e a
   * linha de auditoria commitaria sozinha, afirmando um `antes`/`depois` que
   * nunca aconteceu.
   *
   * A condicao e `changes() > 0`: em SQLite, `changes()` devolve quantas linhas
   * o ULTIMO `INSERT`/`UPDATE`/`DELETE` concluido naquela conexao alterou. Num
   * `db.batch()`, o statement imediatamente anterior a este e a gravacao da
   * configuracao — entao a pergunta que a condicao faz e exatamente "a mudanca
   * aconteceu?".
   *
   * **Isto so vale dentro de um lote, e logo depois da escrita que ele audita.**
   * Fora dessa posicao, `changes()` responde sobre outra escrita qualquer. E por
   * isso que a opcao existe em vez de ser o padrao, e e isso que GRAV-06 trava.
   *
   * A primeira grafia desta condicao comparava `versao` e `atualizado_em` da
   * linha de config, e ela ERRAVA: um escritor concorrente que empurrasse a
   * versao para o mesmo numero, com a linha ja carimbada no mesmo instante,
   * satisfazia a condicao sem que este lote tivesse mudado nada — o caso que
   * GRAV-19 constroi. `changes()` nao pergunta sobre o estado do banco, pergunta
   * sobre o efeito do statement anterior, que e a pergunta certa.
   */
  statementDeRegistro(
    evento: EventoDeAuditoria,
    opcoes: { presoAMudanca?: boolean } = {},
  ): D1PreparedStatement {
    const colunas =
      'INSERT INTO painel_auditoria\n' +
      '  (ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)\n'

    // `SELECT ... WHERE` e nao `VALUES ... WHERE`: `INSERT ... VALUES` nao
    // aceita `WHERE` em SQLite. A lista de colunas continua escrita UMA vez.
    const sql = opcoes.presoAMudanca
      ? `${colunas}SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`
      : `${colunas}VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

    return this.db
      .prepare(sql)
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
   * As ultimas mudancas de configuracao, para o historico de `/painel/ajustes`.
   *
   * So `config_alterada`, e so com `antes` preenchido: o bloco existe para
   * mostrar o valor anterior e oferecer o botao "Voltar a esta versao", e uma
   * linha sem `antes` nao responde nenhuma das duas perguntas. Recusa, login e
   * parada ficam de fora — elas nao sao "mudanca", e a tela de Ajustes nao e a
   * tela de seguranca.
   *
   * `ORDER BY id DESC` e nao `ocorrido_em DESC`: `id` E o rowid e ja e o indice
   * cronologico (§8.9), entao a consulta nao pede indice nenhum. Duas linhas do
   * mesmo milissegundo tambem saem na ordem certa, e `ocorrido_em` empataria.
   */
  async ultimasMudancas(limite: number): Promise<readonly MudancaRegistrada[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ocorrido_em, versao, campos, antes
           FROM painel_auditoria
          WHERE acao = 'config_alterada' AND antes IS NOT NULL
          ORDER BY id DESC
          LIMIT ?`,
      )
      .bind(limite)
      .all<{ ocorrido_em: number; versao: number; campos: string; antes: string }>()

    return (results ?? []).map((linha) => ({
      ocorridoEm: linha.ocorrido_em,
      versao: linha.versao,
      campos: linha.campos,
      antes: linha.antes,
    }))
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
