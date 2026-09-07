import { PainelAuditoriaRepository } from '../../repositories/painel-auditoria-repository'
import {
  type LinhaGravavel,
  PainelConfigRepository,
} from '../../repositories/painel-config-repository'
import {
  type LinhaDeSessao,
  PainelSessoesRepository,
} from '../../repositories/painel-sessoes-repository'
import { invalidarCacheDeConfig } from '../../services/config-store'
import { rotacionarSessao } from '../../services/panel-session'
import { COOKIE_DA_SESSAO, cookieDoPainel } from './campos'
import type { CampoDaConfig } from './dicionario'
import { CAMPOS_DE_COMPORTAMENTO, type EstadoDeComportamento } from './formulario'
import type { PedidoDeGravacao } from './gravar'
import { erro, redirecionar } from './resposta'
import type { EntradaDaRota } from './router'
import { cookieDeStepUpExpirado } from './stepup'

/**
 * O JSON de `antes`/`depois`, com as chaves em ordem fixa.
 *
 * **Nenhum metadado de exibicao entra aqui, e as linhas de midia ja chegaram**
 * (§9.9, §15.4). A frase antiga dizia "nem hoje nem quando as linhas de midia
 * chegarem", e elas chegaram neste mesmo commit: `POST /painel/reel` grava uma
 * sobreposicao e `POST /painel/reels` grava a selecao, e as duas passam por
 * aqui. A regra continua a mesma — `legenda_curta` e recorte da `caption` do
 * Reel, e `caption` esta na lista de proibidos dos DOIS destinos, entao a
 * proibicao vence a regra do "estado completo". A protecao e estrutural: a
 * funcao copia de `CAMPOS_DE_COMPORTAMENTO`, e nao do objeto que recebeu, entao
 * um campo a mais na origem nao vaza por descuido.
 */
function comoJson(estado: EstadoDeComportamento): string {
  const ordenado: Record<string, unknown> = {}
  for (const campo of CAMPOS_DE_COMPORTAMENTO) ordenado[campo] = estado[campo]
  return JSON.stringify(ordenado)
}

/** O que os passos 9 e 10 precisam do funil. */
export interface AplicacaoDeMudanca {
  readonly entrada: EntradaDaRota
  readonly sessao: LinhaDeSessao
  readonly pedido: PedidoDeGravacao
  readonly ator: string
  readonly antes: EstadoDeComportamento
  readonly depois: EstadoDeComportamento
  /** Os valores que vao para `painel_config`. Ausente: e o proprio `depois`. */
  readonly linhaGlobal?: EstadoDeComportamento
  readonly mudados: readonly CampoDaConfig[]
  readonly versaoEnviada: number
  readonly versaoResultante: number
  /** A gravacao passou pelo step-up? Decide a coluna, a rotacao e os cookies. */
  readonly comStepUp: boolean
}

/**
 * Passo 9 e passo 10: UM `db.batch()` e o `303`.
 *
 * O lote tem duas ou tres linhas — configuracao, auditoria e, so quando houve
 * step-up, a rotacao do `sid` (§10.8). Se qualquer parte falhar, todas falham:
 * sem log, sem mudanca, e nada de "grava e depois tenta logar".
 */
export async function aplicarMudanca(aplicacao: AplicacaoDeMudanca): Promise<Response> {
  const { entrada, sessao, pedido, antes, depois, mudados, comStepUp } = aplicacao
  const { env, now, contexto } = entrada

  /** A entidade que esta gravacao altera: um `media_id`, ou a linha global. */
  const alvo = pedido.midias?.alvo ?? null

  // §10.8: o `sid` rotaciona em exatamente dois momentos, e este e o segundo —
  // a sessao muda de "conseguiu ler" para "acabou de autorizar". O prazo
  // absoluto e o que JA estava valendo: SES-01 diz que ele nunca e estendido.
  // Como a rotacao acontece na mesma requisicao que grava e devolve o `303`, o
  // cookie novo chega junto com o redirect.
  const sessaoNova = comStepUp ? await rotacionarSessao(env, sessao.expiraEm) : null

  // **As escritas de midia vem PRIMEIRO, e a posicao e a trava** (Ruling 91).
  // Cada uma carrega `versao = <a ENVIADA>` na propria clausula `WHERE`, e
  // dentro da transacao do `db.batch()` a `versao` so anda quando o `UPDATE`
  // global logo abaixo roda. Avaliadas antes dele, elas veem a mesma versao que
  // o `WHERE` do global vai ver: as duas travas casam juntas ou falham juntas.
  //
  // **Postas DEPOIS, elas nunca commitariam** — e a razao escrita aqui ate esta
  // rodada dizia o contrario. Como o `bind` e `versaoEnviada` e a bump ja teria
  // acontecido, o `EXISTS` seria sempre falso: a linha global e a de auditoria
  // gravariam e a selecao de Reels do dono ficaria para tras em silencio, com a
  // tela dizendo "Pronto, salvo". A posicao e necessaria nos dois mundos; o que
  // muda e QUAL silencio ela evita, e a razao errada e o que sobrevive a
  // proxima refatoracao. O comentario gemeo de `TRAVA_DE_VERSAO`, em
  // `painel-midias-repository.ts`, ja dizia a versao certa.
  //
  // Elas tambem nao podem usar `changes() > 0`, que e como a linha de auditoria
  // se prende: `changes()` fala do statement anterior, e uma FILA de escritas
  // quebraria a corrente na primeira que alterasse zero linhas.
  const deMidias = aplicacao.pedido.midias?.statements ?? []
  const indiceDaConfig = deMidias.length

  const lote = [
    ...deMidias,
    new PainelConfigRepository(env.DB).statementDeGravacao(
      now,
      comoLinha(aplicacao.linhaGlobal ?? depois),
      aplicacao.versaoEnviada,
    ),
    new PainelAuditoriaRepository(env.DB).statementDeRegistro(
      {
        ocorridoEm: now,
        versao: aplicacao.versaoResultante,
        origem: 'painel',
        ator: aplicacao.ator,
        // §9.9: a coluna diz se AQUELA gravacao passou por step-up. Um `false`
        // fixo faria a auditoria nao distinguir a troca do link — que so
        // acontece com a digital — de uma troca de palavra-gatilho.
        stepUp: comStepUp,
        // **A acao segue o ALVO, e nao a rota** (§9.9). `midia_alterada` ja
        // existia em `AcaoDeAuditoria` e na lista de §9.9, e ate esta linha
        // nunca era emitido em lugar nenhum: toda gravacao saia como
        // `config_alterada`, inclusive a de UM Reel.
        //
        // Isso ligava duas telas que ninguem tinha ligado. `ultimasMudancas`
        // filtra `WHERE acao = 'config_alterada' AND antes IS NOT NULL` e nao
        // le o `alvo` — entao a linha de um Reel entrava no historico de
        // Ajustes indistinguivel da global, com o botao "Voltar a esta versao"
        // ao lado. E o `antes` de uma linha de Reel e a config EFETIVA daquele
        // Reel: apertar o botao gravava o link e o intervalo PRIVADOS de um
        // Reel por cima da configuracao de TODOS. Quando o campo divergente e
        // protegido, a tela de conferencia mostra o literal e o dono tem chance
        // de perceber; quando e o modo de comparacao, as palavras, o intervalo
        // para cima ou a chave, nao ha step-up nenhum e a troca e silenciosa.
        //
        // Com a acao presa ao alvo, a linha cai FORA do filtro e o botao some
        // sem uma linha de `ajustes.ts` mudar.
        //
        // A pergunta e sobre o ALVO, e nao sobre a presenca de `midias`:
        // `POST /painel/reels` tambem escreve em `painel_midias`, e ele muda a
        // linha GLOBAL — `mediaScope` — com um `alvo` nulo, porque marcar e
        // desmarcar nao tem um alvo, tem um conjunto novo. Aquela linha e
        // restauravel e continua sendo `config_alterada`.
        acao: alvo === null ? 'config_alterada' : 'midia_alterada',
        // §9.9 quer saber QUAL entidade mudou. Um `media_id` cabe nos 32
        // caracteres da coluna, e e por isso que ela existe desde a migration
        // `0002` — a Task 13 e a primeira a preenche-la.
        alvo,
        campos: JSON.stringify([...mudados, ...(aplicacao.pedido.midias?.campos ?? [])]),
        antes: comoJson(antes),
        depois: comoJson(depois),
      },
      // A metade contraria de "sem log, sem mudanca": a linha de auditoria so
      // entra se o `UPDATE` acima tiver mesmo alterado a linha de config.
      { presoAMudanca: true },
    ),
  ]

  // TERCEIRA posicao, e `presoAMudanca` diz por que a posicao importa: sem ele,
  // o `sid` rotacionaria numa gravacao que a trava otimista recusou, e o dono
  // seria deslogado sem receber o cookie novo. A opcao esta escrita aqui, no
  // call site, e nao escondida no SQL.
  if (sessaoNova !== null) {
    lote.push(
      new PainelSessoesRepository(env.DB).statementDeRotacao(sessao.sidHash, sessaoNova.sidHash, {
        presoAMudanca: true,
      }),
    )
  }

  const resultado = await env.DB.batch(lote)

  // §8.8: `meta.changes === 0` e a trava otimista tendo agido entre a leitura e
  // o lote. Divergencia vira erro duro na tela, nunca sucesso silencioso.
  //
  // O indice deixou de ser `0` porque as escritas de midia vao na frente. Ele e
  // calculado, e nao escrito: uma constante aqui erraria em silencio na
  // primeira rota que gravasse midia — e o silencio seria "gravou e disse que
  // nao", que e a direcao que destroi a confianca.
  if ((resultado[indiceDaConfig]?.meta.changes ?? 0) === 0) {
    return erro('versao_desatualizada', contexto)
  }

  // Sem isto o isolate que acabou de gravar continuaria servindo o snapshot
  // antigo ate o TTL vencer, e a tela mostraria o valor de ANTES logo depois de
  // o dono salvar — o jeito mais rapido de destruir a confianca dele.
  invalidarCacheDeConfig()

  // §10.10, fim do passo 4: aplica, **expira o cookie**, rotaciona o `sid`,
  // responde `303`. Os dois `Set-Cookie` juntos sao o que garante que o mesmo
  // step-up nao serve para duas gravacoes: o envelope morre, e o `sid` que ele
  // nomeia deixa de existir.
  const cookies =
    sessaoNova === null
      ? []
      : [
          cookieDoPainel(
            COOKIE_DA_SESSAO,
            sessaoNova.valor,
            Math.floor((sessaoNova.expiraEm - now) / 1000),
          ),
          cookieDeStepUpExpirado(),
        ]

  return redirecionar(`${pedido.para}?ok=${pedido.confirmacao}`, {}, cookies)
}

/** O estado de comportamento no formato das colunas de `painel_config`. */
function comoLinha(estado: EstadoDeComportamento): LinhaGravavel {
  return {
    enabled: estado.enabled ? 1 : 0,
    trigger_keywords: JSON.stringify(estado.triggerKeywords),
    match_mode: estado.matchMode,
    case_sensitive: estado.caseSensitive ? 1 : 0,
    normalize_accents: estado.normalizeAccents ? 1 : 0,
    ignore_punctuation: estado.ignorePunctuation ? 1 : 0,
    process_only_reels: estado.processOnlyReels ? 1 : 0,
    media_scope: estado.mediaScope,
    public_reply_enabled: estado.publicReplyEnabled ? 1 : 0,
    public_reply_text: estado.publicReplyText,
    private_reply_enabled: estado.privateReplyEnabled ? 1 : 0,
    private_reply_text: estado.privateReplyText,
    destination_url: estado.destinationUrl,
    user_cooldown_hours: estado.userCooldownHours,
  }
}
