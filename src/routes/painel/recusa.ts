/**
 * Como o painel RECUSA uma gravacao — a explicacao na tela e a linha no D1.
 *
 * A costura com `gravar.ts` e por responsabilidade, e nao por tamanho: aquele
 * arquivo responde "como o painel grava" e este responde "como o painel
 * recusa". As quatro pecas daqui — o bloco que nomeia o campo, o rascunho que
 * volta, a linha de auditoria da recusa e a recusa do corpo que nem da para
 * julgar — nunca aparecem no caminho de sucesso.
 *
 * **A dependencia e de mao unica**, e ela precisa continuar sendo: `gravar.ts`
 * importa daqui, e este arquivo nao importa de la. E por isso que os nomes dos
 * campos estruturais do formulario chegam por PARAMETRO (`excluir`) em vez de
 * serem lidos do funil — o funil e o dono deles, e um `import` de volta fecharia
 * um ciclo.
 */
import {
  type AcaoDeAuditoria,
  PainelAuditoriaRepository,
} from '../../repositories/painel-auditoria-repository'
import type { SnapshotConfig } from '../../services/config-store'
import { fichaCsrf } from '../../services/panel-session'
import type { Env } from '../../types/env'
import { type CampoDaConfig, NOME_DO_CAMPO } from './dicionario'
import { CAMPO_DA_FICHA, CAMPO_DA_VERSAO } from './guardas'
import { type HtmlSeguro, html } from './html'
import { type CodigoDeErro, type ContextoDoErro, erro } from './resposta'
import type { EntradaDaRota } from './router'

/**
 * O que a TELA mostra debaixo da frase da tabela de erros (§12.4).
 *
 * §11.4 fixa a `mensagem` — "Confira os campos destacados." — e §12.4 exige que
 * a pessoa saiba QUAL campo e POR QUE. Sem este bloco a tela pedia para conferir
 * campos destacados sem destacar campo nenhum, que e a frase mais inutil que o
 * painel poderia escrever.
 *
 * O nome do campo vem de `NOME_DO_CAMPO` e o motivo do dicionario: nenhuma
 * frase de tela nasce fora dele.
 */
export function blocoDaRecusa(
  itens: readonly { readonly campo: string; readonly motivo: string }[],
): HtmlSeguro {
  if (itens.length === 0) return html``

  return html`<ul class="recusa">${itens.map(
    (item) =>
      html`<li><strong>${
        Object.hasOwn(NOME_DO_CAMPO, item.campo)
          ? NOME_DO_CAMPO[item.campo as CampoDaConfig]
          : item.campo
      }</strong>: ${item.motivo}</li>`,
  )}</ul>`
}

/** A explicacao de uma recusa em que todos os campos falham pela mesma razao. */
export function recusaComMotivoUnico(campos: readonly CampoDaConfig[], motivo: string): HtmlSeguro {
  return blocoDaRecusa(campos.map((campo) => ({ campo, motivo })))
}

/** O que muda de um rascunho para outro. */
export interface PedidoDeRascunho {
  /**
   * O caminho do POST — a ROTA que recebeu o formulario, e nunca a tela para
   * onde o sucesso redireciona.
   *
   * A distincao custou um defeito: a primeira grafia usava o destino do `303`, e
   * em `/painel/palavras` e `/painel/ajustes` os dois coincidem. Em
   * `/painel/chave` nao: o `303` dela aponta para `/painel`, que e `GET` e so
   * `GET`, para sempre (§7.1). O botao de recuperacao morria em `405` — e
   * justamente na rota da chave, que e a que desliga a automacao.
   */
  readonly paraOPost: string
  /** Os campos estruturais do funil, que NAO voltam no rascunho. */
  readonly excluir: readonly string[]
  /** A versao que esta valendo AGORA, e nao a que o formulario trouxe. */
  readonly versaoDeAgora: number
  /**
   * O botao de reenvio aparece?
   *
   * `true` so no `409`, onde reenviar FUNCIONA: a trava era de concorrencia, e o
   * rascunho volta com a versao de agora. Numa recusa de conteudo — campo
   * invalido, campo protegido, campo ainda nao gravavel — reenviar o mesmo
   * rascunho bate na mesma recusa, e um botao que sempre falha e a mesma classe
   * de promessa quebrada que esta funcao existe para consertar. Ali o rascunho
   * fica guardado na pagina, sem botao.
   */
  readonly reenviavel: boolean
}

/**
 * O formulario com o rascunho que a pessoa acabou de enviar (§8.8).
 *
 * §8.8 pede, no `409`, a mensagem **e** o formulario preenchido com o que a
 * pessoa digitou. Vale igual para a recusa de conteudo: perder vinte
 * palavras-gatilho digitadas num celular por causa de uma que ficou curta demais
 * e pior do que perde-las por causa de uma aba aberta em outro aparelho.
 *
 * Os campos voltam CRUS, exatamente como chegaram — nada e normalizado nem
 * consertado no caminho.
 *
 * **Os estruturais NAO voltam**, e a lista vem de quem os declara. `csrf` e
 * `versao` sao reemitidos com os valores de agora; `confirmar` fica de fora e
 * essa e a parte que importa: §8.8 desenhou o incremento de versao exatamente
 * para o caso de a parada de emergencia disparar com o formulario aberto —
 * "obrigado a recarregar e ver, em letras grandes, que a automacao foi parada e
 * desde quando". Carregar a confirmacao de §10.12 pelo `409` deixaria religar
 * num clique sem ver a parada mais nova: seria o unico caminho em que aquele
 * gesto e **carregado** em vez de **feito**.
 */
export async function blocoDoRascunho(
  entrada: EntradaDaRota,
  campos: URLSearchParams,
  pedido: PedidoDeRascunho,
): Promise<HtmlSeguro> {
  const { env, sessao } = entrada
  if (sessao === null) return html``

  const excluidos = new Set(pedido.excluir)
  const escondidos = [...campos]
    .filter(([nome]) => !excluidos.has(nome))
    .map(([nome, valor]) => html`<input type="hidden" name="${nome}" value="${valor}">`)

  return html`<form method="post" action="${pedido.paraOPost}">
<input type="hidden" name="${CAMPO_DA_FICHA}" value="${await fichaCsrf(env, sessao.sidHash)}">
<input type="hidden" name="${CAMPO_DA_VERSAO}" value="${String(pedido.versaoDeAgora)}">
${escondidos}
${
  pedido.reenviavel
    ? html`<p>O que voc&ecirc; escreveu n&atilde;o foi perdido. Recarregue a tela para ver o
que mudou, ou envie de novo por cima.</p>
<button type="submit">Enviar de novo por cima</button>`
    : html`<p>O que voc&ecirc; escreveu continua guardado nesta p&aacute;gina. Volte, corrija
o que est&aacute; apontado acima e salve de novo.</p>`
}
</form>`
}

/**
 * A recusa de um corpo que nao da nem para julgar — e a linha que ela deixa.
 *
 * **Ruling 59.** Campo desconhecido, `versao` ausente e valor fora da
 * enumeracao chegam numa sessao AUTENTICADA: e a coisa mais parecida com sinal
 * de sequestro deste conjunto, e §9.9 diz que a linha existe justamente para
 * uma sequencia dessas nao passar sem rastro. A excecao de §9.9 — "fracasso de
 * requisicao NAO autenticada nao gera linha" — nao alcanca aqui.
 *
 * `versao: 0` e `campos: '[]'` porque nada foi lido nem julgado: a recusa
 * acontece antes de qualquer consulta a `painel_config`, e o preco continua
 * sendo uma escrita e nenhuma leitura de configuracao. E o mesmo `0` que
 * `codigos_gerados` usa, pelo mesmo motivo (§9.9).
 *
 * **Sem rascunho, e a ausencia e decisao**: o corpo nao foi entendido, entao
 * reemiti-lo seria devolver o que provocou a recusa.
 */
export async function recusarCorpoMalformado(
  env: Env,
  now: number,
  contexto: ContextoDoErro,
  ator: string,
  motivoInterno: string,
): Promise<Response> {
  await new PainelAuditoriaRepository(env.DB)
    .statementDeRegistro({
      ocorridoEm: now,
      versao: 0,
      origem: 'painel',
      ator,
      stepUp: false,
      acao: 'mudanca_recusada',
      alvo: null,
      campos: '[]',
      antes: null,
      depois: null,
    })
    .run()

  return erro('dados_invalidos', { ...contexto, motivoInterno })
}

/** Tudo o que uma recusa auditada precisa dizer. */
export interface PedidoDeRecusa {
  readonly acao: Extract<AcaoDeAuditoria, 'mudanca_recusada' | 'stepup_recusado'>
  /** Nomes tecnicos. Vao para a linha, para o JSON e para a traducao da tela. */
  readonly campos: readonly string[]
  readonly codigo: CodigoDeErro
  readonly motivoInterno?: string
  readonly explicacao?: HtmlSeguro
}

/**
 * A linha de auditoria de uma recusa, e a recusa em si, num lugar so.
 *
 * §9.9 e Ruling 54: a tentativa recusada de quem JA passou pelo portao de
 * sessao tambem deixa rastro, com `antes = depois = NULL`. Nao contradiz "nao
 * gravar fracasso de estranho": aqui a escrita ja esta limitada por uma
 * credencial, e uma sequencia de tentativas de sequestro nao pode passar sem
 * registro.
 *
 * **A recusa por versao desatualizada NAO passa por aqui**, e a ausencia e
 * decisao do controlador (Ruling 59): nada do conteudo enviado chegou a ser
 * julgado — a pessoa esta com uma tela velha aberta. Auditar isso faria uma aba
 * esquecida custar uma escrita a cada F5, num caminho que §9.10 orca em zero.
 */
export class RecusaAuditada {
  constructor(
    private readonly env: Env,
    private readonly now: number,
    private readonly contexto: ContextoDoErro,
    private readonly snapshot: SnapshotConfig,
    /** `passkey:<8 hex do sha256 do credential_id>`, nunca o id cru (§9.9). */
    readonly ator: string,
  ) {}

  async registrar(pedido: PedidoDeRecusa): Promise<Response> {
    const campos = [...new Set(pedido.campos)]

    await new PainelAuditoriaRepository(this.env.DB)
      .statementDeRegistro({
        ocorridoEm: this.now,
        // A versao RESULTANTE de uma recusa e a que continua valendo: nada
        // mudou, entao ela e a mesma de antes.
        versao: this.snapshot.versao,
        origem: 'painel',
        ator: this.ator,
        stepUp: false,
        acao: pedido.acao,
        alvo: null,
        // Nomes de campo, NUNCA valores (§9.9). E o que permite investigar uma
        // sequencia de tentativas sem guardar o que elas tentaram escrever.
        campos: JSON.stringify(campos),
        antes: null,
        depois: null,
      })
      .run()

    return erro(pedido.codigo, {
      ...this.contexto,
      campos,
      ...(pedido.motivoInterno === undefined ? {} : { motivoInterno: pedido.motivoInterno }),
      ...(pedido.explicacao === undefined ? {} : { explicacao: pedido.explicacao }),
    })
  }
}
