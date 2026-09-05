/**
 * `GET /painel` — a tela de Inicio, e o panorama que "O que aconteceu" reusa.
 *
 * Inicio cabe numa frase (§3): **"esta funcionando?"**. Ela responde com um
 * estado grande — em cor, icone E palavra, nunca so cor — e com a lista de
 * pendencias, cada uma com o caminho que a resolve.
 *
 * **O estado ambar e a razao de a tela existir.** Hoje a automacao recusa
 * disparar por seguranca — link de fabrica, nenhuma palavra, nenhum Reel
 * marcado, conta desconectada — e nao conta a ninguem. §12.1 regra 3 diz
 * "nada some em silencio", e esta e a tela que torna isso visivel.
 *
 * **Custo: 3 subrequests ao D1** (§12.10): a linha de sessao, que o roteador
 * ja fez, o `db.batch()` da configuracao — um lote inteiro vale UM subrequest
 * — e a pergunta sobre a conta. `ignorarCache: true` porque mostrar ao dono um
 * valor mais velho que o salvo destroi a confianca mais rapido que qualquer
 * defeito.
 */
import { isDestinationUrlConfigured } from '../../config'
import { carregarConfigEfetiva, type SnapshotConfig } from '../../services/config-store'
import type { Env } from '../../types/env'
import { escopoDeMidias, traduzirAviso } from './dicionario'
import { type HtmlSeguro, html } from './html'
import type { EntradaDaRota } from './router'
import { type Aba, type Moldura, telaDoPainel } from './tela'

/**
 * Os tres estados grandes de §3, mais a variacao cinza de §12.6.
 *
 * `parada_por_erro` e cinza como `desligada`, e nao vermelho: para a pessoa,
 * as duas significam "nao esta respondendo". O que muda e a frase, porque so
 * uma delas tem conserto e a tela precisa dizer qual campo consertar.
 */
export type ChaveDeEstado = 'ligada' | 'nada_sera_enviado' | 'desligada' | 'parada_por_erro'

export interface EstadoNaTela {
  readonly chave: ChaveDeEstado
  /** Sempre ao lado da palavra. Icone sozinho nao e estado (§12.9). */
  readonly icone: string
  readonly titulo: string
  readonly explicacao: string
  /** A classe que pinta. A cor e o TERCEIRO sinal, nunca o unico. */
  readonly classe: string
}

/** Uma coisa que falta, e o caminho que a resolve — quando ele ja existe. */
export interface Pendencia {
  readonly texto: string
  readonly acao: { readonly rotulo: string; readonly para: string } | null
}

export interface Panorama {
  readonly estado: EstadoNaTela
  readonly pendencias: readonly Pendencia[]
  /** Avisos do validador, ja traduzidos. Vazio no caminho normal. */
  readonly avisos: readonly string[]
  /** `true` quando o dono nunca salvou nada por aqui (§12.6). */
  readonly aindaDeFabrica: boolean
}

/**
 * A conta do Instagram esta ligada?
 *
 * `SELECT 1` e nao `SELECT *`: a linha carrega o token cifrado, e uma tela de
 * leitura nao tem motivo nenhum para trazer esse campo para a memoria do
 * isolate. O mesmo padrao de `routes/health.ts`.
 *
 * A falha e tratada como "nao conectada", e a direcao e a segura: dizer
 * "conectada" quando nao da para saber e exatamente a promessa que §12.1
 * regra 3 proibe.
 */
export async function contaConectada(db: D1Database): Promise<boolean> {
  try {
    const linha = await db
      .prepare('SELECT 1 AS ligada FROM account_tokens WHERE id = 1')
      .first<{ ligada: number }>()
    return linha !== null
  } catch {
    return false
  }
}

/**
 * O que falta para a automacao responder de verdade.
 *
 * A lista e a de §3, e a ordem e a de quem le: o link primeiro, porque e o
 * unico que faz a automacao recusar disparar mesmo com tudo o mais certo
 * (`link_nao_configurado`, `automation.ts`).
 *
 * Duas pendencias saem SEM botao, e a ausencia e decisao: a tela de Reels
 * nasce na etapa dela, e conectar a conta e um passo do assistente, no
 * computador. Um botao que leva a um `404`, ou a lugar nenhum, ensina a
 * desconfiar dos outros botoes da mesma lista.
 */
function pendenciasDe(snapshot: SnapshotConfig, conta: boolean): readonly Pendencia[] {
  const { global } = snapshot
  const lista: Pendencia[] = []

  if (!isDestinationUrlConfigured(global)) {
    lista.push({
      texto: 'O link ainda não foi configurado, e por isso nada é enviado.',
      acao: { rotulo: 'Ver o link', para: '/painel/mensagem' },
    })
  }

  if (global.triggerKeywords.length === 0) {
    lista.push({
      texto: 'Você não tem nenhuma palavra que aciona a automação.',
      acao: { rotulo: 'Ver as palavras', para: '/painel/palavras' },
    })
  }

  if (escopoDeMidias(global) === 'selecionadas' && global.allowedMediaIds.length === 0) {
    lista.push({
      texto:
        'Você escolheu “só nos Reels que eu escolher”, mas não marcou nenhum. A tela de escolher os Reels chega junto com a próxima parte do painel.',
      acao: null,
    })
  }

  if (!conta) {
    lista.push({
      texto:
        'A conta do Instagram não está conectada. Quem conecta é o assistente, no computador onde o projeto foi publicado.',
      acao: null,
    })
  }

  return lista
}

/**
 * A frase do estado cinza de parada por erro, que **nomeia o campo** (§12.6).
 *
 * Nomear e o ponto: "algum ajuste esta errado" manda a pessoa procurar em
 * quatro telas. E a tela nunca inventa um substituto para o valor recusado —
 * erro nunca alarga, e erro nunca inventa um valor que o dono nao viu.
 */
function explicacaoDaParada(crus: readonly string[]): string {
  const primeiro = crus[0]
  if (primeiro === undefined) {
    return 'A automação está parada por segurança: não conseguimos entender os seus ajustes salvos. Nada foi alterado.'
  }
  return `A automação está parada por segurança. ${traduzirAviso(primeiro)}`
}

/**
 * O estado grande, a partir do snapshot e da conta.
 *
 * A ordem dos ramos e a afirmacao: `parado_por_erro` ganha de "desligada"
 * porque as duas tem `enabled: false` e so uma delas tem conserto; e
 * "desligada" ganha do ambar porque quem desligou de proposito nao precisa
 * ouvir que faltam coisas.
 */
function estadoDe(snapshot: SnapshotConfig, pendencias: readonly Pendencia[]): EstadoNaTela {
  if (snapshot.origem === 'parado_por_erro') {
    return {
      chave: 'parada_por_erro',
      icone: '▲',
      titulo: 'Parada por segurança',
      // Os avisos CRUS, e nao os ja traduzidos: `traduzirAviso` le o prefixo
      // `<campo>:` do achado, e traduzir duas vezes perderia o campo e
      // devolveria a frase generica — que e justamente a que §12.6 proibe.
      explicacao: explicacaoDaParada(snapshot.avisos),
      classe: 'estado-desligada',
    }
  }

  if (!snapshot.global.enabled) {
    return {
      chave: 'desligada',
      icone: '■',
      titulo: 'Desligada',
      explicacao:
        'A automação não responde a nenhum comentário enquanto estiver assim. Nada do que você salvou foi perdido.',
      classe: 'estado-desligada',
    }
  }

  if (pendencias.length > 0) {
    return {
      chave: 'nada_sera_enviado',
      icone: '▲',
      titulo: 'Ligada, mas nada vai ser enviado',
      explicacao:
        'A automação está ligada e, mesmo assim, recusa enviar — por segurança. Resolva o que está listado abaixo e ela volta a responder.',
      classe: 'estado-atencao',
    }
  }

  return {
    chave: 'ligada',
    icone: '✓',
    titulo: 'Ligada e respondendo',
    explicacao:
      'Quem comentar uma das suas palavras num Reel da sua lista recebe o Direct com o link.',
    classe: 'estado-ligada',
  }
}

/**
 * O panorama inteiro: estado, pendencias e avisos.
 *
 * Funcao PURA, com o snapshot e a conta injetados: e o que permite testar os
 * quatro estados sem montar quatro bancos, e e o que "O que aconteceu"
 * importa em vez de recalcular (§3 pede os mesmos tres estados nas duas
 * telas, e duas contas divergiriam).
 */
export function panorama(snapshot: SnapshotConfig, conta: boolean): Panorama {
  const avisos = snapshot.avisos.map(traduzirAviso)
  const pendencias = pendenciasDe(snapshot, conta)

  return {
    estado: estadoDe(snapshot, pendencias),
    pendencias,
    avisos,
    aindaDeFabrica: snapshot.origem === 'arquivo',
  }
}

/** O bloco do estado grande. Icone, palavra e cor — os tres juntos (§3). */
export function blocoDeEstado(panorama: Panorama): HtmlSeguro {
  return html`<section class="bloco-estado ${panorama.estado.classe}">
<h2 class="titulo-estado"><span aria-hidden="true">${panorama.estado.icone}</span> ${
    panorama.estado.titulo
  }</h2>
<p>${panorama.estado.explicacao}</p>
</section>`
}

/** As pendencias, cada uma com o caminho que a resolve quando ele existe. */
export function blocoDePendencias(panorama: Panorama): HtmlSeguro {
  if (panorama.pendencias.length === 0) return html``

  const itens = panorama.pendencias.map(
    (pendencia) =>
      html`<li>${pendencia.texto}${
        pendencia.acao === null
          ? null
          : html` <a class="acao" href="${pendencia.acao.para}">${pendencia.acao.rotulo}</a>`
      }</li>`,
  )

  return html`<section>
<h2>O que falta resolver</h2>
<ul class="pendencias">${itens}</ul>
</section>`
}

/** As faixas de aviso do validador, ja em portugues. */
export function blocoDeAvisos(panorama: Panorama): HtmlSeguro {
  return html`${panorama.avisos.map(
    (aviso) => html`<p class="faixa faixa-aviso" role="status" aria-live="polite">${aviso}</p>`,
  )}`
}

/** A frase de "ainda com os ajustes de fabrica" (§12.6). Nao e erro. */
export function blocoDeFabrica(panorama: Panorama): HtmlSeguro {
  if (!panorama.aindaDeFabrica) return html``
  return html`<p class="faixa">Seus ajustes ainda s&atilde;o os que vieram no programa. Salve uma
vez para o painel passar a mandar.</p>`
}

/** A moldura pronta, com o estado global ja na barra do topo. */
export function molduraCom(
  aba: Aba,
  titulo: string,
  panorama: Panorama,
  corpo: HtmlSeguro,
): Moldura {
  return {
    titulo,
    aba,
    resumo: panorama.estado.titulo,
    iconeDoResumo: panorama.estado.icone,
    classeDoResumo: panorama.estado.classe,
    corpo,
  }
}

/**
 * O snapshot que toda tela do painel le, sempre fresco.
 *
 * Um lugar so para que nenhuma tela esqueca o `ignorarCache` e mostre um valor
 * de ate um minuto atras (o TTL de desligado, §9.6) logo depois de o dono
 * salvar.
 */
export async function configDaTela(env: Env, now: number): Promise<SnapshotConfig> {
  return await carregarConfigEfetiva(env, now, { ignorarCache: true })
}

// ---------------------------------------------------------------------------
// GET /painel
// ---------------------------------------------------------------------------

/**
 * A tela de Inicio.
 *
 * Sem `<form>` e sem botao que grave: esta etapa sobe as telas em modo
 * LEITURA. O botao de um toque de §3 e um `POST /painel/chave`, que nasce com
 * a etapa da escrita; ate la, o freio que funciona e o link de `/painel/parar`
 * na barra do topo, com o codigo anotado no papel.
 */
export async function handleInicio(entrada: EntradaDaRota): Promise<Response> {
  const snapshot = await configDaTela(entrada.env, entrada.now)
  const conta = await contaConectada(entrada.env.DB)
  const visao = panorama(snapshot, conta)

  const corpo = html`<h1>In&iacute;cio</h1>
${blocoDeEstado(visao)}
${blocoDeAvisos(visao)}
${blocoDeFabrica(visao)}
${blocoDePendencias(visao)}
<section>
<h2>Onde mexer</h2>
<ul>
<li><a href="/painel/palavras">As palavras que ligam a automa&ccedil;&atilde;o</a></li>
<li><a href="/painel/mensagem">A mensagem e o link</a></li>
<li><a href="/painel/ajustes">Ajustes finos</a></li>
<li><a href="/painel/atividade">O que aconteceu</a></li>
</ul>
</section>`

  return telaDoPainel(molduraCom('inicio', 'Início', visao, corpo))
}
