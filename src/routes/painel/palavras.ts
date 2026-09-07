/**
 * `GET /painel/palavras` — as palavras que ligam a automacao, em modo leitura.
 *
 * A tela cabe numa frase: **o que uma pessoa precisa comentar para receber o
 * Direct**. Ela mostra as palavras salvas, o modo de comparacao escrito sem
 * jargao (§3) e exemplos gerados a partir da palavra e dos ajustes REAIS do
 * dono.
 *
 * **Os exemplos usam `matchKeyword`, a funcao de producao** (§12.1 regra 4).
 * Nao existe segunda implementacao do casamento — nem aqui, nem em JavaScript
 * no navegador. Uma copia que divergisse mostraria "✓ aciona" numa tela para um
 * comentario que o Worker ignora, e a pessoa so descobriria pelo cliente que
 * nao recebeu.
 *
 * **Custo: 3 subrequests ao D1**: a sessao, o lote da configuracao e a
 * pergunta sobre a conta. Nenhuma chamada a Meta. §12.10 orca 2 para esta
 * tela, e o terceiro e a conta: a barra do topo e a MESMA em toda tela (§12.1)
 * e carrega o estado global, e sem a conta ela diria "Ligada e respondendo"
 * numa instalacao que nao consegue enviar nada — o silencio que §12.1 regra 3
 * existe para acabar. O mesmo vale para Mensagem e Ajustes.
 */
import type { AutomationConfig } from '../../config'
import { MAX_GATILHOS } from '../../services/config-validation'
import { matchKeyword, normalizeOptionsFrom } from '../../utils/normalize'
import { type CampoDaConfig, fraseDoAjuste, MODO_DE_COMPARACAO } from './dicionario'
import { comoLinhas, MODO_NO_FORMULARIO } from './formulario'
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
import { ROTA_PALAVRAS } from './rotas'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

/**
 * Os campos que ESTA tela grava (Ruling 70).
 *
 * As palavras e o modo de comparacao — os dois controles do formulario, e nada
 * alem deles. `matchMode` para "basta aparecer no meio" alarga o alcance e pede
 * a digital (§10.10); voltar estreita e nao pede.
 */
export const CAMPOS_DE_PALAVRAS: readonly CampoDaConfig[] = ['triggerKeywords', 'matchMode']

/** Um exemplo de comentario e o veredito da funcao de producao. */
interface Exemplo {
  readonly comentario: string
  readonly aciona: boolean
  /** O rotulo honesto de §3, so quando o acionamento pode surpreender. */
  readonly surpreende: boolean
}

/**
 * Tres variacoes da palavra que o dono escolheu.
 *
 * Elas sao MECANICAS — a mesma, em maiusculas com ponto, e com um pedaco a
 * mais depois — e nao frases prontas. Uma frase pronta em portugues ("nao e
 * isso que eu quero") so funciona para a palavra do exemplo da spec; gerada
 * para "cardapio" ela sairia errada, e §3 e explicito: os exemplos sao da
 * palavra da pessoa, nao genericos.
 */
function exemplosPara(palavra: string, config: AutomationConfig): readonly Exemplo[] {
  const opcoes = normalizeOptionsFrom(config)
  const variacoes = [palavra, `${palavra.toUpperCase()}!`, `${palavra} e mais alguma coisa`]

  return variacoes.map((comentario, indice) => {
    const aciona =
      matchKeyword(comentario, config.triggerKeywords, config.matchMode, opcoes) !== null
    return {
      comentario,
      aciona,
      // A terceira e a que muda de veredito entre os dois modos: e nela que
      // "basta aparecer no meio" responde a coisas que a pessoa talvez nao
      // queira, e §3 manda dizer isso com essas palavras.
      surpreende: indice === 2 && aciona,
    }
  })
}

function blocoDeExemplos(config: AutomationConfig): HtmlSeguro {
  const primeira = config.triggerKeywords[0]
  if (primeira === undefined) return html``

  const linhas = exemplosPara(primeira, config).map(
    (exemplo) =>
      html`<li><span aria-hidden="true">${exemplo.aciona ? '✓' : '✕'}</span> &ldquo;${
        exemplo.comentario
      }&rdquo; &mdash; ${exemplo.aciona ? 'aciona' : 'não aciona'}${
        exemplo.surpreende
          ? html` <em>(responde tamb&eacute;m, e talvez voc&ecirc; n&atilde;o queira)</em>`
          : null
      }</li>`,
  )

  return html`<section>
<h2>O que aciona, com a sua palavra</h2>
<p>Estes exemplos s&atilde;o conferidos com a mesma fun&ccedil;&atilde;o que a automa&ccedil;&atilde;o
usa para responder de verdade.</p>
<ul class="exemplos">${linhas}</ul>
</section>`
}

/** As tres frases de comparacao, geradas dos ajustes reais do dono (§3). */
function blocoDeRegras(config: AutomationConfig): HtmlSeguro {
  // O MODO nao aparece mais aqui: ele virou escolha dentro do formulario, e um
  // eco em leitura ao lado de um controle editavel seriam duas telas dizendo o
  // mesmo valor — a primeira a divergir seria a que ninguem atualizou.
  return html`<section>
<h2>Como o coment&aacute;rio &eacute; comparado</h2>
<ul>
<li>${fraseDoAjuste('caseSensitive', config)}</li>
<li>${fraseDoAjuste('normalizeAccents', config)}</li>
<li>${fraseDoAjuste('ignorePunctuation', config)}</li>
</ul>
</section>`
}

/**
 * O formulario das palavras: uma caixa de texto, uma palavra por linha.
 *
 * **Uma caixa de texto, e nao vinte campos.** Sem JavaScript nao ha como
 * acrescentar um campo, e vinte campos fixos numa tela de celular seriam vinte
 * caixas vazias. Uma linha por palavra e o formato que a propria pessoa ja usa
 * quando escreve uma lista, e a linha em branco e o Enter dela — nao um item.
 *
 * O formulario grava SO as palavras. As tres chaves de comparacao aparecem
 * aqui como explicacao e sao editadas em Ajustes (§3), onde elas moram: dois
 * formularios gravando o mesmo campo seriam duas telas discordando sobre quem
 * manda.
 */
function formularioDasPalavras(
  config: AutomationConfig,
  ficha: string,
  versao: number,
): HtmlSeguro {
  return html`<form method="post" action="${ROTA_PALAVRAS.caminho}">
${camposDoFormulario(ficha, versao)}
<p><label for="triggerKeywords">Uma palavra ou frase por linha, at&eacute;
${String(MAX_GATILHOS)}.</label></p>
<textarea id="triggerKeywords" name="triggerKeywords" rows="6"
>${comoLinhas(config.triggerKeywords)}</textarea>
${escolhaDeModo(config)}
<p><button type="submit">Salvar</button></p>
</form>`
}

/**
 * O modo de comparacao, com as duas frases inteiras do dicionario.
 *
 * **Uma das duas opcoes leva cadeado, e a outra nao** (§12.3): ir para "basta
 * aparecer no meio" ALARGA o envelope de alcance, e alargar pede a digital;
 * voltar para "o comentario tem que ser so isso" estreita, e estreitar nunca
 * pede. E a promessa do rodape dos Ajustes escrita dentro do controle que a
 * exerce, e por isso o botao diz so "Salvar": §12.3 manda que, nas telas em que
 * so PARTE dos campos e protegida, quem avisa seja o cadeado no campo mais a
 * tela de conferencia — nunca uma surpresa biometrica.
 */
function escolhaDeModo(config: AutomationConfig): HtmlSeguro {
  return html`<fieldset>
<legend>Como o coment&aacute;rio &eacute; comparado</legend>
<p><label><input type="radio" name="matchMode" value="${MODO_NO_FORMULARIO.exact}"${
    config.matchMode === 'exact' ? html` checked` : null
  }> ${MODO_DE_COMPARACAO.exact}</label></p>
<p><label><input type="radio" name="matchMode" value="${MODO_NO_FORMULARIO.contains}"${
    config.matchMode === 'contains' ? html` checked` : null
  }> ${MODO_DE_COMPARACAO.contains} ${seloProtegido()}</label></p>
</fieldset>`
}

export async function handlePalavras(entrada: EntradaDaRota): Promise<Response> {
  if (entrada.request.method === 'POST') {
    return await gravarConfiguracao(entrada, {
      para: ROTA_PALAVRAS.caminho,
      confirmacao: 'salvo',
      // Ruling 70: os dois controles que o formulario desta tela emite. O link
      // e os textos sao de `/painel/mensagem`, e a lista e o que impede um
      // formulario adulterado daqui de grava-los sob a digital pedida aqui.
      campos: CAMPOS_DE_PALAVRAS,
    })
  }

  const snapshot = await configDaTela(entrada.env, entrada.now)
  const visao = panorama(snapshot, await contaConectada(entrada.env.DB))
  const { global } = snapshot

  const fichas = global.triggerKeywords.map((palavra) => html`<li class="ficha">${palavra}</li>`)

  const corpo = html`<h1>Palavras que ligam a automa&ccedil;&atilde;o</h1>
${blocoDeConfirmacao(entrada.request)}
${
  global.triggerKeywords.length === 0
    ? html`<p class="faixa faixa-aviso" role="status">Sem nenhuma palavra a automa&ccedil;&atilde;o
nunca responde. Ou escreva pelo menos uma, ou desligue &mdash; as duas s&atilde;o seguras, mas
s&oacute; uma fica clara no seu painel.</p>`
    : html`<ul class="fichas">${fichas}</ul>`
}
${formularioDasPalavras(global, await fichaDaTela(entrada), snapshot.versao)}
${blocoDeRegras(global)}
${blocoDeExemplos(global)}`

  return telaDoPainel(molduraCom('palavras', 'Palavras', visao, corpo))
}
