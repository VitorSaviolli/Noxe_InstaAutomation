/**
 * `GET /painel`, a tela de Inicio, e o panorama que "O que aconteceu" reusa.
 *
 * Inicio cabe numa frase (§3): **"esta funcionando?"**. Ela responde com um
 * estado grande, em cor, icone E palavra, nunca so cor, e com a lista de
 * pendencias, cada uma com o caminho que a resolve.
 *
 * **O estado ambar e a razao de a tela existir.** Hoje a automacao recusa
 * disparar por seguranca, link de fabrica, nenhuma palavra, nenhum Reel
 * marcado, conta desconectada, e nao conta a ninguem. §12.1 regra 3 diz
 * "nada some em silencio", e esta e a tela que torna isso visivel.
 *
 * **Custo: 3 subrequests ao D1** (§12.10): a linha de sessao, que o roteador
 * ja fez, o `db.batch()` da configuracao, um lote inteiro vale UM subrequest
 * e `perguntasDoInicio`, que responde DUAS coisas numa instrucao so: a conta
 * do Instagram e quantos codigos de recuperacao ainda valem. Sao 4 no estado
 * DESLIGADA, e so nele: a data da ultima parada por codigo, que §10.12 exige na
 * confirmacao de religar. `ignorarCache: true` porque mostrar ao dono um valor
 * mais velho que o salvo destroi a confianca mais rapido que qualquer defeito.
 *
 * **O aviso bloqueante de §10.11 abre esta tela**, e ele nasceu aqui pelo lugar
 * onde §10.11 o pediu: "o **painel** abre com aviso bloqueante". A faixa
 * vermelha de "zero codigos" so existia em `/painel/aparelhos`, que e a unica
 * tela sem item na barra de baixo, depois de uma recuperacao o dono ficava
 * sem rede de seguranca e sem nada que ele visse dizendo isso.
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
import { CAMPO_DA_ACAO, CAMPO_DA_CONFIRMACAO, CAMPO_DA_FICHA, CAMPO_DA_VERSAO } from './campos'
import type { CampoDaConfig } from './dicionario'
import {
  dataEmPortugues,
  escopoDeMidias,
  fraseDeConfirmacao,
  RECUSA_SEM_VALOR,
  SELO_PROTEGIDO,
  traduzirAviso,
} from './dicionario'
import { gravarConfiguracao } from './gravar'
import { type HtmlSeguro, html } from './html'
import { erro } from './resposta'
import { ROTA_APARELHOS, ROTA_CHAVE, ROTA_INICIO, ROTA_REELS } from './rotas'
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

/** Uma coisa que falta, e o caminho que a resolve, quando ele ja existe. */
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
 * **`expires_at > ?` e a metade que faltava, e a ausencia dela era uma
 * mentira.** A pergunta era so "existe linha?", e a linha continua existindo
 * depois de o token morrer: um token longo do Instagram vale 60 dias, e quem
 * troca a senha, cai num checkpoint ou fica sem renovar por dois meses tem a
 * linha intacta e nada sendo entregue. As seis telas do painel afirmavam
 * "Conectada. A automacao consegue falar com o Instagram para enviar" a quem
 * nao tinha mais conta nenhuma, e §12.1 regra 3 proibe exatamente isso.
 * `shouldRefresh` era o UNICO lugar do projeto que olhava `expires_at`, e ele
 * DESISTE quando o prazo passa (`if (now >= expiresAt) return false`): nao
 * havia nem renovacao, nem aviso, nem tela dizendo a verdade.
 *
 * O `now` vem por parametro, e nao de `Date.now()`: e a mesma regra dos
 * repositorios, quem compara relogio no painel sao as rotas, que ja recebem
 * o instante da requisicao.
 *
 * A falha e tratada como "nao conectada", e a direcao e a segura: dizer
 * "conectada" quando nao da para saber e exatamente a promessa que §12.1
 * regra 3 proibe.
 *
 * **O `catch` NAO e silencioso, e o `console.warn` e o que o torna honesto.**
 * Sem ele, um D1 fora do ar virava a frase "A conta do Instagram nao esta
 * conectada", afirmada ao dono como FATO, sem rastro em lugar nenhum, e o
 * dono passaria a tarde reconectando uma conta que nunca desconectou. §12.7 e
 * literal: detalhe tecnico vai para o `console`, nunca para a tela. Uma linha
 * so, no formato de `despachar`, para nao amplificar log.
 */
export async function contaConectada(db: D1Database, now: number): Promise<boolean> {
  try {
    const linha = await db
      .prepare(`SELECT 1 AS ligada FROM account_tokens WHERE ${CONTA_VIVA}`)
      .bind(now)
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
 * O predicado de "a conta ainda fala com o Instagram", numa grafia so.
 *
 * Ele vive em duas consultas, a de `contaConectada`, que as outras cinco telas
 * chamam, e a do Inicio, que pergunta as duas coisas de uma vez, e duas
 * grafias divergiriam no dia em que uma delas ganhasse um `AND`. Uma tela
 * dizendo "conectada" e a outra "nao esta" na mesma instalacao e pior que as
 * duas erradas juntas.
 */
const CONTA_VIVA = 'id = 1 AND expires_at > ?'

/**
 * Um codigo de recuperacao que AINDA da para usar (§10.11).
 *
 * As duas colunas, e nao so `invalidado_em`: o consumo marca `usado_em` no
 * codigo usado e `invalidado_em` em todos os outros, no mesmo lote. Contar so
 * `invalidado_em IS NULL` faria a tela achar que ha um codigo valendo
 * justamente depois de uma recuperacao, o codigo ja queimado.
 */
const CODIGO_UTILIZAVEL = "tipo = 'recuperacao' AND usado_em IS NULL AND invalidado_em IS NULL"

/** O que o Inicio pergunta ao D1 alem da configuracao, numa consulta so. */
export interface PerguntasDoInicio {
  readonly conta: boolean
  /**
   * Quantos codigos de recuperacao ainda valem, ou `null` quando nao deu para
   * saber. `null` NAO e zero: §12.1 regra 3 proibe afirmar o que nao se sabe, e
   * "voce esta sem rede de seguranca" e uma afirmacao e tanto para fazer a
   * partir de um D1 que nao respondeu.
   */
  readonly codigos: number | null
}

/**
 * As duas perguntas do Inicio, num **unico** `SELECT`, e um unico subrequest.
 *
 * §12.10 orca **3 subrequests** para esta tela (a linha da sessao, o lote da
 * configuracao e esta pergunta), e TELA-20 trava o numero. O aviso de §10.11
 * precisava de uma contagem de `painel_codigos` que a tela nao tinha: um
 * segundo `prepare` custaria o quarto subrequest, e um lote a mais quebraria a
 * premissa da conta de TELA-20. Duas subconsultas escalares dentro da MESMA
 * instrucao respondem as duas perguntas pelo preco de uma.
 *
 * A falha vira "nao conectada" e "nao deu para saber", as duas na direcao
 * segura de §12.1 regra 3, e cada uma para o seu lado: afirmar "conectada" sem
 * saber esconde uma automacao muda, e afirmar "sem codigos" sem saber acende um
 * alarme falso na tela que mais precisa ser levada a serio.
 */
export async function perguntasDoInicio(db: D1Database, now: number): Promise<PerguntasDoInicio> {
  try {
    const linha = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM account_tokens WHERE ${CONTA_VIVA}) AS conta,
                (SELECT COUNT(*) FROM painel_codigos WHERE ${CODIGO_UTILIZAVEL}) AS codigos`,
      )
      .bind(now)
      .first<{ conta: number; codigos: number }>()

    if (linha === null) return { conta: false, codigos: null }
    return { conta: linha.conta > 0, codigos: linha.codigos }
  } catch (cause) {
    console.warn(
      'painel:',
      'indisponivel',
      'inicio_nao_verificado',
      cause instanceof Error ? cause.message : cause,
    )
    return { conta: false, codigos: null }
  }
}

/**
 * O que falta para a automacao responder de verdade.
 *
 * A lista e a de §3, e a ordem e a de quem le: o link primeiro, porque e o
 * unico que faz a automacao recusar disparar mesmo com tudo o mais certo
 * (`link_nao_configurado`, `automation.ts`).
 *
 * UMA pendencia sai SEM botao, e a ausencia e decisao: conectar a conta e um
 * passo do assistente, no computador. Um botao que leva a um `404`, ou a lugar
 * nenhum, ensina a desconfiar dos outros botoes da mesma lista. A dos Reels
 * tinha a mesma forma ate a Etapa 12, e ganhou o botao junto com a tela.
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
    // **A frase mudou na Etapa 12, e a mudanca e uma divida quitada.** Ela dizia
    // "a tela de escolher os Reels chega junto com a proxima parte do painel", e
    // a tela chegou: mandar a pessoa esperar por uma tela pronta e a mesma
    // familia de defeito dos Rulings 75 e 82. Com ela existindo, a pendencia
    // ganha o botao que a resolve, que e o que §3 pede de toda pendencia cujo
    // caminho ja exista.
    lista.push({
      texto:
        'Você escolheu “só nos Reels que eu escolher”, mas não marcou nenhum, então a automação não responde em lugar nenhum.',
      acao: { rotulo: 'Escolher os Reels', para: ROTA_REELS.caminho },
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
 * quatro telas. E a tela nunca inventa um substituto para o valor recusado,
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
      // devolveria a frase generica, que e justamente a que §12.6 proibe.
      explicacao: `${explicacaoDaParada(snapshot.avisos)} ${RECUSA_SEM_VALOR.configIlegivel}`,
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
        'A automação está ligada e, mesmo assim, recusa enviar, por segurança. Resolva o que está listado abaixo e ela volta a responder.',
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

/** O bloco do estado grande. Icone, palavra e cor, os tres juntos (§3). */
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

/**
 * O aviso bloqueante de §10.11: **"gere um novo conjunto de codigos agora"**.
 *
 * **Por que ele mora no Inicio.** A faixa vermelha existia so em
 * `/painel/aparelhos`, que e, por decisao declarada no cabecalho daquele
 * arquivo, a UNICA tela sem item na barra de baixo: o acesso a ela e um `<li>`
 * no fim desta pagina. Depois de uma recuperacao, §10.11 invalida em bloco
 * todos os outros codigos, e o dono ficava com ZERO codigo utilizavel sem que
 * nada que ele visse dissesse isso. O desfecho e o trancamento que os seis
 * codigos existem para impedir: o proximo aparelho que quebrar deixa o painel
 * sem aparelho E sem codigo, e a unica saida vira `POST /setup/painel/zerar` na
 * maquina que publicou o projeto. §10.11 e literal, "**o painel** abre com
 * aviso bloqueante", e o painel abre aqui.
 *
 * **`null` nao acende o aviso.** Quando a consulta falhou nao ha resposta, e
 * §12.1 regra 3 proibe afirmar o que nao se sabe: uma faixa vermelha que
 * aparece por indisponibilidade do D1 ensina o dono a ignorar a faixa vermelha.
 *
 * A frase e a MESMA da tela de Aparelhos, de proposito: quem seguir o link
 * precisa reconhecer o que leu, e duas frases para o mesmo estado sao duas
 * chances de uma delas envelhecer.
 */
export function blocoDosCodigos(codigos: number | null): HtmlSeguro {
  if (codigos === null || codigos > 0) return html``

  return html`<p class="faixa faixa-erro" role="alert"><strong>Voc&ecirc; n&atilde;o tem nenhum
c&oacute;digo de recupera&ccedil;&atilde;o valendo.</strong> Gere um conjunto novo agora e anote no
papel. Sem eles, perder todos os aparelhos significa perder o painel.
<a class="acao" href="${ROTA_APARELHOS.caminho}">Gerar c&oacute;digos novos</a></p>`
}

/** A frase de "ainda com os ajustes de fabrica" (§12.6). Nao e erro. */
export function blocoDeFabrica(panorama: Panorama): HtmlSeguro {
  if (!panorama.aindaDeFabrica) return html``
  return html`<p class="faixa">Seus ajustes ainda s&atilde;o os que vieram no programa. Salve uma
vez para o painel passar a mandar.</p>`
}

/**
 * Os tres sinais de §12.3, num lugar so: cadeado, palavra e a classe da borda.
 *
 * §12.3 pede os tres **sempre juntos, nunca so cor**. As tres telas que tem
 * campo protegido, Mensagem, Palavras e Ajustes, chamavam a mesma marcacao
 * escrita a mao, e a terceira copia ja tinha nascido com a quebra de linha em
 * outro lugar. Uma funcao, tres chamadas.
 *
 * Mora aqui, e nao em `dicionario.ts`, porque isto e MARCACAO e nao frase: o
 * dicionario nao conhece a tag `html`. A palavra, essa sim, vem de la.
 */
export function seloProtegido(): HtmlSeguro {
  return html`<span class="selo-protegido"><span aria-hidden="true">&#128274;</span> ${SELO_PROTEGIDO}</span>`
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
 *
 * **`comAsInativas` tambem mora aqui, e ele e o conserto do orcamento de
 * §12.10.** As duas telas de Reels precisam das linhas que o lote da
 * configuracao filtra (`ativo = 1`) e pagavam uma consulta PROPRIA por elas, o
 * quarto subrequest que a tabela de §12.10 nao orca. Pedindo no MESMO lote, a
 * pergunta custa zero: um `batch` vale um subrequest. As outras cinco telas
 * carregam algumas linhas a mais na memoria e nao pagam nada por isso; separar
 * "a tela que precisa" da "que nao precisa" custaria uma segunda grafia de
 * `configDaTela`, e a segunda grafia e a que um dia esqueceria o `ignorarCache`.
 */
export async function configDaTela(env: Env, now: number): Promise<SnapshotConfig> {
  return await carregarConfigEfetiva(env, now, { ignorarCache: true, comAsInativas: true })
}

// ---------------------------------------------------------------------------
// O que toda tela que GRAVA compartilha
// ---------------------------------------------------------------------------

/**
 * A faixa verde que nasce do `?ok=` (§7.1, §12.2).
 *
 * **O valor da query string NUNCA e escrito na pagina.** A frase vem da tabela
 * fechada do dicionario; um `?ok=` desconhecido nao mostra faixa nenhuma. E a
 * consulta a uma lista fechada, e nao o escape, que impede a query string de
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
 * recusado, o primeiro erro e silencioso, e e o que este helper mata.
 */
export function camposDoFormulario(ficha: string, versao: number): HtmlSeguro {
  return html`<input type="hidden" name="${CAMPO_DA_FICHA}" value="${ficha}">
<input type="hidden" name="${CAMPO_DA_VERSAO}" value="${String(versao)}">`
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
 * barato. **Religar pede um gesto a mais**, a caixa de confirmacao, e mostra a
 * data da ultima parada por codigo, que e o que §10.12 exige: "religar exige
 * sessao e confirmacao explicita, com a data vinda de `parado_por_codigo_em`".
 *
 * Nem um nem outro pede a digital, e isso tambem e §10.10: religar nao muda
 * nenhum valor, so devolve a chave ao estado anterior, que o dono ja autorizou
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
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${DESLIGAR}">
<button type="submit" class="botao-desligar">Desligar a automa&ccedil;&atilde;o</button>
</form>
<p>Ela para de responder na hora. Nada do que voc&ecirc; salvou &eacute; apagado.</p>
</section>`
  }

  return html`<section class="bloco-chave">
<form method="post" action="${ROTA_CHAVE.caminho}">
${campos}
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${LIGAR}">
${
  paradaEm === null
    ? null
    : html`<p>A automa&ccedil;&atilde;o foi desligada pelo c&oacute;digo de emerg&ecirc;ncia em
${dataEmPortugues(paradaEm)}.</p>`
}
<p><label><input type="checkbox" name="${CAMPO_DA_CONFIRMACAO}" value="sim"> Quero ligar a
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
  // UMA consulta para as DUAS perguntas: a conta e a contagem de codigos de
  // recuperacao. O orcamento de §12.10 continua em 3 subrequests.
  const perguntas = await perguntasDoInicio(entrada.env.DB, entrada.now)
  const visao = panorama(snapshot, perguntas.conta)

  const paradaEm = snapshot.global.enabled
    ? null
    : await new PainelConfigRepository(entrada.env.DB).lerParadaPorCodigo()

  const corpo = html`<h1>In&iacute;cio</h1>
${blocoDeConfirmacao(entrada.request)}
${
  // ANTES do estado grande, e nao no rodape ao lado do link: §10.11 pede um
  // aviso BLOQUEANTE, e um aviso que exige rolagem nao bloqueia nada.
  blocoDosCodigos(perguntas.codigos)
}
${blocoDeEstado(visao)}
${blocoDaChave(snapshot, await fichaDaTela(entrada), paradaEm)}
${blocoDeAvisos(visao)}
${blocoDeFabrica(visao)}
${blocoDePendencias(visao)}
<section>
<h2>Onde mexer</h2>
<ul>
<li><a href="${ROTA_REELS.caminho}">Em quais Reels a automa&ccedil;&atilde;o responde</a></li>
<li><a href="/painel/palavras">As palavras que ligam a automa&ccedil;&atilde;o</a></li>
<li><a href="/painel/mensagem">A mensagem e o link</a></li>
<li><a href="/painel/ajustes">Ajustes finos</a></li>
<li><a href="/painel/atividade">O que aconteceu</a></li>
<!-- A tela dos aparelhos nao tem item na barra de baixo: §12.1 desenha SEIS
     itens e a setima vaga so nasce com o "Mais". Sem este link ela ficaria sem
     porta de entrada nenhuma, e uma tela que existe e ninguem alcanca e a
     mesma classe de promessa quebrada que §13.1 chama de defeito. -->
<li><a href="${ROTA_APARELHOS.caminho}">Aparelhos e c&oacute;digos de
recupera&ccedil;&atilde;o</a></li>
</ul>
</section>`

  return telaDoPainel(molduraCom('inicio', 'Início', visao, corpo))
}

// ---------------------------------------------------------------------------
// POST /painel/chave, a chave liga/desliga
// ---------------------------------------------------------------------------

/**
 * Os campos que `POST /painel/chave` escreve (Ruling 70).
 *
 * UM campo, e e o que o `acao` do corpo traduz. Exportado porque META-10 confere
 * a uniao das quatro listas contra o conjunto gravavel da etapa.
 */
export const CAMPOS_DA_CHAVE: readonly CampoDaConfig[] = ['enabled']

/** As duas acoes que §7.1 declara para esta rota. Nada mais casa. */
const LIGAR = 'ligar'
const DESLIGAR = 'desligar'

/**
 * `POST /painel/chave` com `acao=ligar|desligar` (§7.1).
 *
 * A rota nao tem tela propria, e por isso o `303` dela aponta para
 * `/painel?ok=<codigo>`, que e a tela que a acao mudou. Toda a ordem de §11.3
 * mora em `gravarConfiguracao`; aqui so acontece a traducao de `acao` para o
 * campo `enabled`, que e o vocabulario que §7.1 escreveu para esta rota.
 *
 * **A caixa de confirmacao de §10.12 e exigida pelo FUNIL**, e nao por esta
 * rota: `enabled` chega la por DOIS veiculos, esta rota, que o declara em
 * `CAMPOS_DA_CHAVE`, e `acao=restaurar` de `/painel/ajustes`, cujo escopo e a
 * uniao gravavel inteira (Ruling 74). Uma conferencia so aqui deixava o botao
 * "Voltar a esta versao" desfazer a parada de emergencia com um clique, porque
 * ele reenvia o estado anterior inteiro, `enabled` incluso.
 *
 * A frase antiga dizia "qualquer formulario do painel pode carrega-lo", e ela
 * so era verdadeira enquanto toda rota escrevia todo campo (Rulings 79 e 83).
 */
export async function handleChave(entrada: EntradaDaRota): Promise<Response> {
  const { contexto, corpo } = entrada
  if (corpo.familia !== 'formulario') return erro('corpo_invalido', contexto)

  const acao = corpo.campos.get(CAMPO_DA_ACAO)
  if (acao !== LIGAR && acao !== DESLIGAR) {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'acao_desconhecida' })
  }

  return await gravarConfiguracao(entrada, {
    para: ROTA_INICIO.caminho,
    confirmacao: acao === LIGAR ? 'ligada' : 'desligada',
    campos: CAMPOS_DA_CHAVE,
    // So `acao`, a confirmacao de §10.12 e estrutural de TODA rota, e quem a
    // exige e o funil, na transicao `desligada -> ligada`. Conferi-la aqui
    // deixava o OUTRO veiculo de `enabled`, o `acao=restaurar` de
    // `/painel/ajustes`, desfazer a parada de emergencia sem confirmacao
    // nenhuma (Rulings 74, 79 e 83).
    estruturais: [CAMPO_DA_ACAO],
    patchDoHandler: { enabled: acao === LIGAR },
  })
}
