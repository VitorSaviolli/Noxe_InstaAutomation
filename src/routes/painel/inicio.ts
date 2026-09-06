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
 * — e a pergunta sobre a conta. Sao 4 no estado DESLIGADA, e so nele: a data da
 * ultima parada por codigo, que §10.12 exige na confirmacao de religar.
 * `ignorarCache: true` porque mostrar ao dono um valor mais velho que o salvo
 * destroi a confianca mais rapido que qualquer defeito.
 *
 * Este arquivo tambem hospeda `POST /painel/chave`, a chave liga/desliga de
 * §7.1: ela nao tem tela propria e o `303` dela aponta para `/painel?ok=`, que
 * e a tela que a acao mudou.
 */
import { isDestinationUrlConfigured } from '../../config'
import { PainelConfigRepository } from '../../repositories/painel-config-repository'
import { carregarConfigEfetiva, type SnapshotConfig } from '../../services/config-store'
import { fichaCsrf } from '../../services/panel-session'
import type { Env } from '../../types/env'
import { dataEmPortugues, escopoDeMidias, fraseDeConfirmacao, traduzirAviso } from './dicionario'
import { gravarConfiguracao } from './gravar'
import { CAMPO_DA_FICHA } from './guardas'
import { type HtmlSeguro, html } from './html'
import { erro } from './resposta'
import { ROTA_CHAVE, ROTA_INICIO } from './rotas'
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
 *
 * **O `catch` NAO e silencioso, e o `console.warn` e o que o torna honesto.**
 * Sem ele, um D1 fora do ar virava a frase "A conta do Instagram nao esta
 * conectada", afirmada ao dono como FATO, sem rastro em lugar nenhum — e o
 * dono passaria a tarde reconectando uma conta que nunca desconectou. §12.7 e
 * literal: detalhe tecnico vai para o `console`, nunca para a tela. Uma linha
 * so, no formato de `despachar`, para nao amplificar log.
 */
export async function contaConectada(db: D1Database): Promise<boolean> {
  try {
    const linha = await db
      .prepare('SELECT 1 AS ligada FROM account_tokens WHERE id = 1')
      .first<{ ligada: number }>()
    return linha !== null
  } catch (cause) {
    console.warn(
      'painel:',
      'indisponivel',
      'conta_nao_verificada',
      cause instanceof Error ? cause.message : cause,
    )
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
// O que toda tela que GRAVA compartilha
// ---------------------------------------------------------------------------

/**
 * A faixa verde que nasce do `?ok=` (§7.1, §12.2).
 *
 * **O valor da query string NUNCA e escrito na pagina.** A frase vem da tabela
 * fechada do dicionario; um `?ok=` desconhecido nao mostra faixa nenhuma. E a
 * consulta a uma lista fechada — e nao o escape — que impede a query string de
 * virar conteudo, e ela vale mesmo se alguem um dia trocar o `html` por outra
 * coisa nesta linha.
 */
export function blocoDeConfirmacao(request: Request): HtmlSeguro {
  const frase = fraseDeConfirmacao(new URL(request.url).searchParams.get('ok'))
  if (frase === null) return html``

  return html`<p class="faixa faixa-ok" role="status" aria-live="polite">${frase}</p>`
}

/**
 * Os dois campos escondidos que todo formulario de gravacao carrega.
 *
 * A ficha e o passo 7 da escada; a `versao` e a trava otimista do passo 9
 * (§8.8). Escritos num lugar so porque um formulario sem `versao` gravaria por
 * cima de uma mudanca feita em outra aba, e um formulario sem ficha seria
 * recusado — o primeiro erro e silencioso, e e o que este helper mata.
 */
export function camposDoFormulario(ficha: string, versao: number): HtmlSeguro {
  return html`<input type="hidden" name="${CAMPO_DA_FICHA}" value="${ficha}">
<input type="hidden" name="versao" value="${String(versao)}">`
}

/** A ficha CSRF daquela sessao, para os formularios da tela. */
export async function fichaDaTela(entrada: EntradaDaRota): Promise<string> {
  // `sessao` e `null` so em rota sem portao de sessao, e nenhuma tela do painel
  // e uma dessas. A string vazia nao "funciona sem ficha": ela e recusada pelo
  // passo 7 como qualquer outra ficha errada.
  if (entrada.sessao === null) return ''
  return await fichaCsrf(entrada.env, entrada.sessao.sidHash)
}

// ---------------------------------------------------------------------------
// GET /painel
// ---------------------------------------------------------------------------

/**
 * O botao de um toque de §3: a chave que liga e desliga a automacao.
 *
 * **Desligar e UM toque**, e a ausencia de confirmacao e a decisao de §10.10:
 * desligar e a direcao segura, e a parada de emergencia depende de desligar ser
 * barato. **Religar pede um gesto a mais** — a caixa de confirmacao — e mostra a
 * data da ultima parada por codigo, que e o que §10.12 exige: "religar exige
 * sessao e confirmacao explicita, com a data vinda de `parado_por_codigo_em`".
 *
 * Nem um nem outro pede a digital, e isso tambem e §10.10: religar nao muda
 * nenhum valor, so devolve a chave ao estado anterior — que o dono ja autorizou
 * quando gravou aqueles campos. Exigir biometria aqui puniria justamente quem
 * acabou de usar o freio.
 *
 * O link de `/painel/parar` na barra do topo continua onde esta, e nao e
 * duplicata: ele e o freio que funciona SEM sessao, com o codigo anotado no
 * papel, para o dia em que o celular nao entrar.
 */
function blocoDaChave(
  snapshot: SnapshotConfig,
  ficha: string,
  paradaEm: number | null,
): HtmlSeguro {
  const campos = camposDoFormulario(ficha, snapshot.versao)

  if (snapshot.global.enabled) {
    return html`<section class="bloco-chave">
<form method="post" action="${ROTA_CHAVE.caminho}">
${campos}
<input type="hidden" name="acao" value="desligar">
<button type="submit" class="botao-desligar">Desligar a automa&ccedil;&atilde;o</button>
</form>
<p>Ela para de responder na hora. Nada do que voc&ecirc; salvou &eacute; apagado.</p>
</section>`
  }

  return html`<section class="bloco-chave">
<form method="post" action="${ROTA_CHAVE.caminho}">
${campos}
<input type="hidden" name="acao" value="ligar">
${
  paradaEm === null
    ? null
    : html`<p>A automa&ccedil;&atilde;o foi desligada pelo c&oacute;digo de emerg&ecirc;ncia em
${dataEmPortugues(paradaEm)}.</p>`
}
<p><label><input type="checkbox" name="confirmar" value="sim"> Quero ligar a
automa&ccedil;&atilde;o de novo, com os ajustes que est&atilde;o salvos.</label></p>
<button type="submit">Ligar a automa&ccedil;&atilde;o</button>
</form>
</section>`
}

/**
 * A tela de Inicio.
 *
 * **Custo: 3 subrequests ao D1 com a automacao ligada, e 4 quando ela esta
 * desligada.** O quarto e a data da ultima parada por codigo, que so a tela de
 * religar usa e que §10.12 torna obrigatoria. Perguntar por ela sempre custaria
 * uma leitura por visita para um dado que a tela nao mostra no estado normal.
 */
export async function handleInicio(entrada: EntradaDaRota): Promise<Response> {
  const snapshot = await configDaTela(entrada.env, entrada.now)
  const conta = await contaConectada(entrada.env.DB)
  const visao = panorama(snapshot, conta)

  const paradaEm = snapshot.global.enabled
    ? null
    : await new PainelConfigRepository(entrada.env.DB).lerParadaPorCodigo()

  const corpo = html`<h1>In&iacute;cio</h1>
${blocoDeConfirmacao(entrada.request)}
${blocoDeEstado(visao)}
${blocoDaChave(snapshot, await fichaDaTela(entrada), paradaEm)}
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

// ---------------------------------------------------------------------------
// POST /painel/chave — a chave liga/desliga
// ---------------------------------------------------------------------------

/** As duas acoes que §7.1 declara para esta rota. Nada mais casa. */
const LIGAR = 'ligar'
const DESLIGAR = 'desligar'

/**
 * `POST /painel/chave` com `acao=ligar|desligar` (§7.1).
 *
 * A rota nao tem tela propria — e por isso o `303` dela aponta para
 * `/painel?ok=<codigo>`, que e a tela que a acao mudou. Toda a ordem de §11.3
 * mora em `gravarConfiguracao`; aqui so acontece a traducao de `acao` para o
 * campo `enabled`, que e o vocabulario que §7.1 escreveu para esta rota.
 *
 * **A caixa de confirmacao so e exigida ao LIGAR** (§10.12). Ela nao e um campo
 * de configuracao: e um gesto, e por isso entra como campo estrutural do
 * pedido. Ausente, a gravacao e recusada como qualquer outro corpo invalido —
 * nunca aceita "por ter vindo de um formulario do painel".
 */
export async function handleChave(entrada: EntradaDaRota): Promise<Response> {
  const { contexto, corpo } = entrada
  if (corpo.familia !== 'formulario') return erro('corpo_invalido', contexto)

  const acao = corpo.campos.get('acao')
  if (acao !== LIGAR && acao !== DESLIGAR) {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'acao_desconhecida' })
  }

  if (acao === LIGAR && corpo.campos.get('confirmar') !== 'sim') {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'confirmacao_ausente' })
  }

  return await gravarConfiguracao(entrada, {
    para: ROTA_INICIO.caminho,
    confirmacao: acao === LIGAR ? 'ligada' : 'desligada',
    estruturais: ['acao', 'confirmar'],
    patchDoHandler: { enabled: acao === LIGAR },
  })
}
