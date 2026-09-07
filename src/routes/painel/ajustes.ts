/**
 * `GET, POST /painel/ajustes` — os ajustes finos.
 *
 * A tela cabe numa frase: **onde, com que frequencia e por quais canais a
 * automacao responde**. Sao os ajustes que mudam o ALCANCE da automacao, e por
 * isso ela termina com a regra escrita de §12.3, que e a promessa que o painel
 * inteiro faz sobre quando a digital vai ser pedida.
 *
 * **O que esta tela GRAVA hoje**: as tres chaves de comparacao — maiusculas,
 * acentos, pontuacao — e o intervalo por pessoa, **so para cima**. Diminuir o
 * intervalo alarga o alcance, e alargar exige step-up (§10.10): enquanto o
 * verificador nao existe, o funil RECUSA a mudanca com `403`, nunca a aceita em
 * silencio. O modo de comparacao, o tipo de publicacao e os dois canais
 * continuam em leitura pela mesma razao.
 *
 * **Custo: 4 subrequests ao D1** no `GET` — a linha de sessao, o lote da
 * configuracao, a pergunta sobre a conta e o historico. §12.10 orca 2 para esta
 * tela e a Task 10 ja subiu para 3 por causa da barra do topo; o quarto e o
 * bloco de historico, que a Etapa 10 exige em letras. O numero fica travado num
 * teste, para o custo ficar visivel e nao escondido.
 */
import type { AutomationConfig } from '../../config'
import {
  type MudancaRegistrada,
  PainelAuditoriaRepository,
} from '../../repositories/painel-auditoria-repository'
import {
  type CampoDaConfig,
  dataEmPortugues,
  ESCOPO_DE_MIDIAS,
  escopoDeMidias,
  FRASE_DO_AJUSTE,
  MODO_DE_COMPARACAO,
  NOME_DO_CAMPO,
  ORIGEM_DOS_AJUSTES,
} from './dicionario'
import {
  CAMPOS_DA_RESTAURACAO,
  type EstadoDeComportamento,
  estadoDaConfig,
  lerEstadoGuardado,
  restauracaoPossivel,
  valorDeFormulario,
} from './formulario'
import { gravarConfiguracao } from './gravar'
import { type HtmlSeguro, html } from './html'
import {
  blocoDeConfirmacao,
  camposDoFormulario,
  configDaTela,
  contaConectada,
  fichaDaTela,
  molduraCom,
  panorama,
  seloProtegido,
} from './inicio'
import { ROTA_AJUSTES } from './rotas'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

/**
 * Quantas mudancas o historico mostra.
 *
 * Cinco, e nao as 500 que a auditoria guarda: o bloco responde "o que eu mudei
 * ultimamente, e como volto atras", e uma lista longa numa tela de celular vira
 * rolagem que ninguem le. A poda de §8.9 continua sendo a regra de retencao.
 */
const MUDANCAS_NO_HISTORICO = 5

/**
 * Os campos que o FORMULARIO desta tela grava (Ruling 70).
 *
 * Exatamente os controles que ela emite: as tres chaves de comparacao, o tipo de
 * publicacao e o intervalo por pessoa. Nada de `enabled`, `triggerKeywords` nem
 * `matchMode` — cada um deles tem a sua tela, e META-10 confere que a uniao das
 * quatro listas cobre o conjunto gravavel sem sobra.
 *
 * O botao "Voltar a esta versao" NAO usa esta lista: ele declara a operacao
 * `acao=restaurar`, cujo escopo e a uniao inteira (Ruling 74). §9.9 nomeia o que
 * a restauracao atravessa — mesmo validador, mesmo step-up, allowlist de hoje —
 * e a lista por rota seria um quarto portao que a spec nao sanciona.
 */
export const CAMPOS_DE_AJUSTES: readonly CampoDaConfig[] = [
  'caseSensitive',
  'normalizeAccents',
  'ignorePunctuation',
  'processOnlyReels',
  'userCooldownHours',
]

/** O valor de `acao` que declara a operacao de restauracao (Ruling 74). */
export const RESTAURAR = 'restaurar'

/** Uma linha "nome do ajuste / o que ele quer dizer hoje". */
function linha(rotulo: string, valor: string): HtmlSeguro {
  return html`<div class="linha-de-ajuste">
<p class="rotulo">${rotulo}</p>
<p class="valor">${valor}</p>
</div>`
}

/**
 * O intervalo por pessoa, escrito como frase.
 *
 * `0` nao e "sem intervalo escrito como zero": e "a mesma pessoa pode acionar
 * quantas vezes quiser", e essa e a leitura que muda a decisao de quem esta na
 * tela.
 */
function frasedoIntervalo(horas: number): string {
  if (horas === 0) return 'A mesma pessoa pode acionar quantas vezes quiser, sem espera.'
  if (horas === 1) return 'A mesma pessoa só aciona de novo depois de 1 hora.'
  return `A mesma pessoa só aciona de novo depois de ${horas} horas.`
}

function blocoDeCanais(config: AutomationConfig): HtmlSeguro {
  return html`<section>
<h2>O que a automa&ccedil;&atilde;o envia</h2>
${linha(
  'Direct',
  config.privateReplyEnabled
    ? 'Ligado: quem comenta recebe o Direct com o link.'
    : 'Desligado: ninguém recebe Direct.',
)}
${linha(
  'Resposta no comentário',
  config.publicReplyEnabled
    ? 'Ligada: a automação responde embaixo do Reel.'
    : 'Desligada: nada é escrito embaixo do Reel.',
)}
${
  config.privateReplyEnabled || config.publicReplyEnabled
    ? null
    : html`<p class="faixa faixa-aviso" role="status">Com os dois desligados, a
automa&ccedil;&atilde;o n&atilde;o envia nada &mdash; nem no Direct, nem embaixo do Reel.</p>`
}
</section>`
}

/**
 * Uma escolha de sim/nao, com as DUAS frases inteiras do dicionario.
 *
 * Nunca "Ligado"/"Desligado": `caseSensitive: false` quer dizer "tanto faz
 * maiuscula ou minuscula", e um rotulo de liga/desliga ao lado do nome do campo
 * deixaria a pessoa adivinhando o que fica desligado (§12.9). As duas opcoes
 * saem escritas por extenso, e a que esta valendo vem marcada.
 */
function escolhaDeChave(
  campo: 'caseSensitive' | 'normalizeAccents' | 'ignorePunctuation',
  config: AutomationConfig,
): HtmlSeguro {
  const frases = FRASE_DO_AJUSTE[campo]

  return html`<fieldset>
<legend>${NOME_DO_CAMPO[campo]}</legend>
<p><label><input type="radio" name="${campo}" value="sim"${
    config[campo] ? html` checked` : null
  }> ${frases.verdadeiro}</label></p>
<p><label><input type="radio" name="${campo}" value="nao"${
    config[campo] ? null : html` checked`
  }> ${frases.falso}</label></p>
</fieldset>`
}

/**
 * Onde a automacao responde: so nos Reels, ou em qualquer publicacao.
 *
 * **A segunda opcao leva cadeado, a primeira nao** (§12.3): `processOnlyReels`
 * indo para `false` amplia o raio para qualquer publicacao, e §10.10 lista isso
 * como alargamento. Voltar para "so nos Reels" estreita, e estreitar nunca pede
 * a digital — que e a promessa escrita no rodape desta mesma tela.
 *
 * As duas frases vem de `FRASE_DO_AJUSTE`, o mesmo par que a linha de leitura
 * usava: nao nasce aqui uma segunda traducao do campo.
 */
function escolhaDoTipoDePublicacao(config: AutomationConfig): HtmlSeguro {
  const frases = FRASE_DO_AJUSTE.processOnlyReels

  return html`<fieldset>
<legend>${NOME_DO_CAMPO.processOnlyReels}</legend>
<p><label><input type="radio" name="processOnlyReels" value="sim"${
    config.processOnlyReels ? html` checked` : null
  }> ${frases.verdadeiro}</label></p>
<p><label><input type="radio" name="processOnlyReels" value="nao"${
    config.processOnlyReels ? null : html` checked`
  }> ${frases.falso} ${seloProtegido()}</label></p>
</fieldset>`
}

/**
 * O formulario dos ajustes que esta etapa grava.
 *
 * O intervalo entra como numero, e o rotulo diz qual e a direcao que nao pede a
 * digital — a mesma regra que o rodape da tela escreve por extenso (§12.3).
 * Diminuir continua possivel de digitar: quem recusa e o funil, com a frase da
 * tabela de erros, e e assim que a promessa fica honesta em vez de escondida
 * atras de um campo desabilitado que ninguem explica.
 */
function formularioDosAjustes(config: AutomationConfig, ficha: string, versao: number): HtmlSeguro {
  return html`<form method="post" action="${ROTA_AJUSTES.caminho}">
${camposDoFormulario(ficha, versao)}
<h2>Como o coment&aacute;rio &eacute; comparado</h2>
${linha('Modo', MODO_DE_COMPARACAO[config.matchMode])}
${escolhaDeChave('caseSensitive', config)}
${escolhaDeChave('normalizeAccents', config)}
${escolhaDeChave('ignorePunctuation', config)}
<h2>Onde a automa&ccedil;&atilde;o responde</h2>
${escolhaDoTipoDePublicacao(config)}
<h2>Intervalo por pessoa</h2>
<p><label for="userCooldownHours">Quantas horas a mesma pessoa espera para acionar de novo.
Aumentar &eacute; a dire&ccedil;&atilde;o segura.</label></p>
<input type="number" id="userCooldownHours" name="userCooldownHours" min="0" step="1"
value="${String(config.userCooldownHours)}">
<p><button type="submit">Salvar</button></p>
</form>`
}

/**
 * Os nomes em portugues dos campos que aquela mudanca tocou.
 *
 * `campos` vem do D1, que e entrada NAO confiavel: um JSON quebrado, ou um nome
 * que nao e campo nenhum, vira a frase generica em vez de aparecer cru na tela.
 */
function nomesDosCampos(cru: string): string {
  let lista: unknown
  try {
    lista = JSON.parse(cru)
  } catch {
    return 'você mudou os seus ajustes.'
  }

  if (!Array.isArray(lista)) return 'você mudou os seus ajustes.'

  const nomes = lista
    .filter(
      (item): item is CampoDaConfig =>
        typeof item === 'string' && Object.hasOwn(NOME_DO_CAMPO, item),
    )
    .map((campo) => NOME_DO_CAMPO[campo])

  if (nomes.length === 0) return 'você mudou os seus ajustes.'
  return `você mudou: ${nomes.join(', ')}.`
}

/**
 * Uma linha do historico: quando, o que mudou e o botao de voltar.
 *
 * O botao **reenvia o `antes` pela rota normal de gravacao** (§9.9, Ruling 55):
 * mesmo validador, mesma allowlist de HOJE, mesma classificacao de risco. Nao
 * existe rota de restauracao, e a ausencia e a garantia — uma segunda porta
 * seria uma segunda chance de esquecer uma das travas. A consequencia aceita e
 * que uma versao antiga cujo `antes` toque campo protegido e recusada hoje, e
 * passa a funcionar quando o step-up existir, sem mudar este botao.
 *
 * Um `antes` que nao parseia sai SEM botao: melhor uma linha so de leitura do
 * que um botao que posta um corpo pela metade.
 */
function linhaDoHistorico(
  mudanca: MudancaRegistrada,
  ficha: string,
  versao: number,
  hoje: EstadoDeComportamento,
): HtmlSeguro {
  const estado = lerEstadoGuardado(mudanca.antes)

  // **O botao so sai quando a versao volta INTEIRA** (R-6). `mediaScope` e os
  // dois interruptores de canal nao sao gravaveis por rota nenhuma nesta etapa,
  // entao uma versao que difira em qualquer um deles voltaria pela metade — e um
  // botao que promete recuperacao e recupera parte dela e a mesma promessa
  // quebrada que §12.4 recusa. Sem botao, e a linha diz por que.
  const inteira = estado !== null && restauracaoPossivel(estado, hoje)

  // Os campos escondidos sao os da UNIAO gravavel, e nao `CAMPOS_DE_COMPORTAMENTO`:
  // mandar um campo que nenhuma rota escreve so serviria para a gravacao ser
  // recusada por ele.
  const escondidos =
    estado === null
      ? null
      : CAMPOS_DA_RESTAURACAO.map(
          (campo) =>
            html`<input type="hidden" name="${campo}" value="${valorDeFormulario(campo, estado)}">`,
        )

  return html`<li>
<p><strong>${dataEmPortugues(mudanca.ocorridoEm)}</strong> &mdash; ${nomesDosCampos(
    mudanca.campos,
  )}</p>
${
  estado === null
    ? html`<p>N&atilde;o conseguimos ler o que estava salvo nesta vers&atilde;o, ent&atilde;o
n&atilde;o d&aacute; para voltar a ela por aqui.</p>`
    : inteira
      ? html`<form method="post" action="${ROTA_AJUSTES.caminho}">
${camposDoFormulario(ficha, versao)}
<input type="hidden" name="acao" value="${RESTAURAR}">
${escondidos}
<button type="submit">Voltar a esta vers&atilde;o</button>
</form>`
      : html`<p>Esta vers&atilde;o tinha ajustes que o painel ainda n&atilde;o sabe mudar, ent&atilde;o
voltar a ela deixaria uma parte para tr&aacute;s. Por isso n&atilde;o h&aacute; bot&atilde;o aqui.</p>`
}
</li>`
}

/** O bloco somente-leitura do fim da tela, com o botao de voltar (§3). */
function blocoDoHistorico(
  mudancas: readonly MudancaRegistrada[],
  ficha: string,
  versao: number,
  hoje: EstadoDeComportamento,
): HtmlSeguro {
  return html`<section>
<h2>O que voc&ecirc; mudou por aqui</h2>
${
  mudancas.length === 0
    ? html`<p>Voc&ecirc; ainda n&atilde;o mudou nada por aqui. Quando mudar, as
&uacute;ltimas altera&ccedil;&otilde;es aparecem nesta lista, com um bot&atilde;o para voltar a
qualquer uma delas.</p>`
    : html`<ul class="historico">${mudancas.map((mudanca) =>
        linhaDoHistorico(mudanca, ficha, versao, hoje),
      )}</ul>`
}
</section>`
}

export async function handleAjustes(entrada: EntradaDaRota): Promise<Response> {
  if (entrada.request.method === 'POST') {
    // Duas operacoes, uma rota (§7.1: nenhuma rota nova, e o identificador de uma
    // escrita vai no corpo do POST). O formulario de ajustes escreve os
    // controles desta tela; o botao "Voltar a esta versao" declara
    // `acao=restaurar` e escreve a uniao gravavel — que e o escopo que §9.9 da a
    // restauracao (Ruling 74). A protecao dela nao muda: mesmo validador, mesmo
    // step-up preso ao conteudo, allowlist de hoje, e a tela de conferencia
    // mostrando literalmente cada campo que muda.
    const restaurando =
      entrada.corpo.familia === 'formulario' && entrada.corpo.campos.get('acao') === RESTAURAR

    return await gravarConfiguracao(entrada, {
      para: ROTA_AJUSTES.caminho,
      confirmacao: 'salvo',
      estruturais: ['acao'],
      campos: restaurando ? CAMPOS_DA_RESTAURACAO : CAMPOS_DE_AJUSTES,
    })
  }

  const snapshot = await configDaTela(entrada.env, entrada.now)
  const visao = panorama(snapshot, await contaConectada(entrada.env.DB))
  const mudancas = await new PainelAuditoriaRepository(entrada.env.DB).ultimasMudancas(
    MUDANCAS_NO_HISTORICO,
  )
  const ficha = await fichaDaTela(entrada)
  const { global } = snapshot

  const corpo = html`<h1>Ajustes finos</h1>
${blocoDeConfirmacao(entrada.request)}
<section>
<h2>Como est&aacute; agora</h2>
${linha('Quais Reels', ESCOPO_DE_MIDIAS[escopoDeMidias(global)])}
${linha('Intervalo por pessoa', frasedoIntervalo(global.userCooldownHours))}
</section>
${formularioDosAjustes(global, ficha, snapshot.versao)}
${blocoDeCanais(global)}
${blocoDoHistorico(mudancas, ficha, snapshot.versao, estadoDaConfig(global))}
<footer>
<p>Os ajustes que est&atilde;o valendo agora s&atilde;o ${ORIGEM_DOS_AJUSTES[snapshot.origem]}.</p>
<p><strong>Diminuir o alcance da automa&ccedil;&atilde;o nunca pede a sua digital ou o seu rosto.
Aumentar, sim.</strong></p>
</footer>`

  return telaDoPainel(molduraCom('ajustes', 'Ajustes finos', visao, corpo))
}
