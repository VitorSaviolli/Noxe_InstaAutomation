/**
 * A TELA de aparelhos e o vocabulario do formulario dela.
 *
 * **O corte e por responsabilidade, e o teto de 800 linhas foi so o gatilho.**
 * `aparelhos.ts` chegou a 867 linhas, 67 acima do teto, e a divisao natural
 * ja estava desenhada: aquele arquivo responde "o que cada acao FAZ" (o
 * step-up, os lotes, a regra da ultima, a rota do assistente) e este responde
 * "como a tela se PARECE". E o mesmo corte que `reels.ts` e `reels-lista.ts`
 * fizeram na Etapa 12.
 *
 * **A dependencia e de mao unica**: `aparelhos.ts` importa daqui, e este
 * arquivo nao importa de la. E por isso que o VOCABULARIO do formulario,
 * `CAMPO_DO_APARELHO` e os tres valores de `acao`, mora aqui e nao la: quem
 * DESENHA os `<input>` e a tela, e um `import` de volta fecharia um ciclo. O
 * nome canonico da operacao (`remover_passkey`, o que entra no `op_hash`) fica
 * com `aparelhos.ts`, que e quem monta a mudanca assinada, sao dois espacos de
 * nomes, e cada um mora com o seu dono.
 *
 * **Nada de `<style>`, `onclick=` nem `<script>` inline** (§11.5), como em toda
 * tela: estilo no `painel.css`, comportamento no `painel.js`.
 */

import type { LinhaDeAparelho } from '../../repositories/painel-credenciais-repository'
import { PainelCredenciaisRepository } from '../../repositories/painel-credenciais-repository'
import type { LinhaDeSessao } from '../../repositories/painel-sessoes-repository'
import { fichaCsrf } from '../../services/panel-session'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import { CAMPO_DA_ACAO, CAMPO_DA_DIGITAL, CAMPO_DA_FICHA } from './campos'
import { dataEmPortugues, fraseDeConfirmacao } from './dicionario'
import { type HtmlSeguro, html, pagina } from './html'
import { TETO_DE_CREDENCIAIS } from './registrar'
import { ROTA_APARELHOS, ROTA_SAIR } from './rotas'
import type { EntradaDaRota } from './router'
import { jsonCanonico, type MudancaCanonica } from './stepup'

/**
 * O nome do campo escondido que carrega o aparelho a remover.
 *
 * Ele e o `alvo` da mudanca canonica, e nao um campo de configuracao: por isso
 * o nome fica AQUI, com a rota dona dele, e nao em `campos.ts`, aquele arquivo
 * guarda o vocabulario que atravessa varias telas (§7.2), e este atravessa uma
 * so. Mesma regra que `CAMPO_DO_REEL` segue em `reel.ts`.
 */
export const CAMPO_DO_APARELHO = 'aparelho'

/**
 * Os tres valores de `acao` desta rota. **So o NOME `acao` sobe para
 * `campos.ts`; os valores ficam com a rota dona** (§7.2).
 *
 * **`remover` e nao `remover_passkey`, e a diferenca nao e estetica.** A
 * proibicao de §12.1 alcanca o atributo `value` do HTML, e o metateste do
 * glossario varre o `<body>` inteiro, atributos inclusive. "passkey" esta na
 * lista de palavras que a tela nunca escreve, e um `value="remover_passkey"`
 * a escreveria na tela mais importante do painel. E a mesma razao pela qual
 * `matchMode` viaja como `so_isso`/`no_meio` no formulario das palavras.
 *
 * O nome CANONICO da operacao continua `remover_passkey`, ele e o `acao` da
 * mudanca de §10.10, entra no `op_hash` e nao pode mudar. Sao dois espacos de
 * nomes: o do formulario, que a pessoa le, e o da cerimonia, que o autenticador
 * assina. `ACAO_CANONICA` abaixo e a ponte entre eles, escrita em um lugar so.
 */
export const ACAO_REMOVER = 'remover'
export const ACAO_SAIR_DE_TUDO = 'sair_de_tudo'
export const ACAO_GERAR_CODIGOS = 'gerar_codigos'

/**
 * Os campos que a tela de conferencia NAO reemite no segundo POST.
 *
 * `csrf` e reemitido com o valor de agora e `digital` nasce vazio para receber
 * a assertion, os dois sao escritos pela propria tela, entao ecoar os que
 * chegaram seria emiti-los duas vezes. Nao ha `versao` nem `confirmar` aqui:
 * esta rota nao grava configuracao, entao nao tem trava otimista, e nao tem
 * gesto de religar para carregar por engano (§10.12).
 */
const ESTRUTURAIS = [CAMPO_DA_FICHA, CAMPO_DA_DIGITAL]

/** O que muda de uma renderizacao da tela para outra. */
export interface EstadoDaTela {
  /** O bloco que explica a recusa, quando houve uma. */
  readonly aviso?: HtmlSeguro
}

export async function telaDeAparelhos(
  entrada: EntradaDaRota,
  sessao: LinhaDeSessao,
  estado: EstadoDaTela = {},
): Promise<Response> {
  const { env } = entrada

  // A consulta e a uma lista FECHADA de codigos, e e ela, e nao o escape, que
  // impede a query string de virar conteudo da pagina (§7.1).
  const confirmacao = fraseDeConfirmacao(new URL(entrada.request.url).searchParams.get('ok'))

  const linhas = await new PainelCredenciaisRepository(env.DB).listarParaATela()
  const codigosUtilizaveis = await contarCodigosUtilizaveis(env.DB)

  const ficha = await fichaCsrf(env, sessao.sidHash)
  const desteEndereco = linhas.filter((linha) => linha.rpId === env.PANEL_RP_ID)

  const cartoes: HtmlSeguro[] = []
  for (const linha of linhas) {
    cartoes.push(await cartaoDoAparelho(linha, sessao, env, ficha))
  }

  return pagina({
    titulo: 'Aparelhos e códigos de recuperação',
    // A UNICA tela autenticada que le a digital. Sem ele, os botoes de remover
    // e de gerar codigos ficariam parados depois da tela de conferencia, e um
    // controle que nao faz o que promete e defeito, nao cosmetica.
    comScript: true,
    corpo: html`<header class="topo">
<p class="estado"><span aria-hidden="true">&#128274;</span> Quem entra neste painel</p>
<a class="parar" href="/painel/parar">Desligar a automa&ccedil;&atilde;o</a>
</header>
<main>
${confirmacao === null ? null : html`<p class="faixa faixa-ok" role="status">${confirmacao}</p>`}
${estado.aviso ?? null}
<h1>Aparelhos e c&oacute;digos de recupera&ccedil;&atilde;o</h1>

<p class="aviso-do-endereco"><strong>Estes aparelhos est&atilde;o presos ao endere&ccedil;o
${env.PANEL_RP_ID}.</strong> Se um dia o painel mudar de endere&ccedil;o, todos v&atilde;o precisar
ser cadastrados de novo, usando um c&oacute;digo de recupera&ccedil;&atilde;o. N&atilde;o &eacute;
poss&iacute;vel transferir, &eacute; assim que a digital protege voc&ecirc; de um site falso
com outro endere&ccedil;o.</p>

<h2>Os aparelhos que conseguem entrar</h2>
<ul class="aparelhos">${cartoes}</ul>
<p>Voc&ecirc; pode cadastrar at&eacute; ${String(TETO_DE_CREDENCIAIS)} aparelhos neste
endere&ccedil;o. Hoje s&atilde;o ${String(desteEndereco.length)}.</p>

${formularioDeCadastro(ficha, desteEndereco.length >= TETO_DE_CREDENCIAIS)}
${blocoDosCodigos(ficha, codigosUtilizaveis)}

<h2>Sair deste aparelho</h2>
<p>Encerra o acesso <strong>s&oacute; aqui</strong>. Os seus outros aparelhos continuam entrando, e
este volta a entrar com a sua digital quando voc&ecirc; quiser. &Eacute; o bot&atilde;o para quando
voc&ecirc; usou um computador que n&atilde;o &eacute; seu.</p>
<form method="post" action="${ROTA_SAIR.caminho}">
<input type="hidden" name="${CAMPO_DA_FICHA}" value="${ficha}">
<button type="submit">Sair deste aparelho</button>
</form>

<h2>Sair de todos os aparelhos</h2>
<p>Isso encerra o acesso em <strong>todos</strong> os aparelhos, inclusive neste. Ningu&eacute;m
perde o cadastro: cada aparelho entra de novo com a pr&oacute;pria digital. Use quando achar que
algu&eacute;m pode ter entrado sem voc&ecirc;.</p>
<form method="post" action="${ROTA_APARELHOS.caminho}">
<input type="hidden" name="${CAMPO_DA_FICHA}" value="${ficha}">
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${ACAO_SAIR_DE_TUDO}">
<button type="submit">Sair de todos os aparelhos</button>
</form>
<p>Esta n&atilde;o pede a sua digital, e isso &eacute; de prop&oacute;sito: tirar acesso &eacute;
sempre o lado seguro, e travar quem est&aacute; se protegendo seria o pior momento para pedir uma
confirma&ccedil;&atilde;o a mais.</p>

<p><a href="/painel">Voltar ao in&iacute;cio</a></p>
</main>`,
  })
}

/**
 * Um aparelho na tela: apelido, datas, o aviso de BE/BS e o bot&atilde;o de
 * remover (§3, §10.13).
 *
 * **O aviso das flags BE/BS e a informacao que mais importa nesta tela.** Elas
 * sao lidas do `authData` no registro (§10.5, passo 6) e traduzidas aqui para a
 * unica pergunta que a pessoa realmente faz: se este celular quebrar, eu perco
 * o acesso? "Salvo na conta do celular" e `BE=1 e BS=1`; qualquer outra
 * combinacao vive so neste aparelho.
 */
async function cartaoDoAparelho(
  linha: LinhaDeAparelho,
  sessao: LinhaDeSessao,
  env: Env,
  ficha: string,
): Promise<HtmlSeguro> {
  const salvoNaConta = linha.backupElegivel && linha.backupAtivo
  const desteEndereco = linha.rpId === env.PANEL_RP_ID
  const ehOAtual = linha.credentialId === sessao.credentialId

  return html`<li class="aparelho">
<h3>${linha.apelido}</h3>
<p class="datas">Cadastrado em ${dataEmPortugues(linha.criadoEm)}. ${
    linha.usadoEm === null
      ? html`Ainda n&atilde;o foi usado para entrar.`
      : html`&Uacute;ltima entrada em ${dataEmPortugues(linha.usadoEm)}.`
  }</p>
<p class="${salvoNaConta ? 'salvo' : 'so-aqui'}">${
    salvoNaConta
      ? html`<span aria-hidden="true">&#10003;</span> Est&aacute; salvo na conta do celular,
se voc&ecirc; trocar de aparelho, continua entrando.`
      : html`<span aria-hidden="true">&#9650;</span> Existe s&oacute; neste aparelho. Se ele quebrar
ou for formatado, este acesso se perde.`
  }</p>
${
  desteEndereco
    ? null
    : html`<p class="endereco-antigo"><span aria-hidden="true">&#9650;</span> Foi cadastrado no
endere&ccedil;o antigo <code>${linha.rpId}</code> e <strong>n&atilde;o consegue mais
entrar</strong>. Pode ser removido sem medo.</p>`
}
${ehOAtual ? avisoDoAparelhoDeAgora() : null}
<p class="identificacao">Identifica&ccedil;&atilde;o curta:
<code>${await prefixoDeCredencial(linha.credentialId)}</code></p>
<form method="post" action="${ROTA_APARELHOS.caminho}">
<input type="hidden" name="${CAMPO_DA_FICHA}" value="${ficha}">
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${ACAO_REMOVER}">
<input type="hidden" name="${CAMPO_DO_APARELHO}" value="${linha.credentialId}">
<button type="submit">Remover este aparelho</button>
</form>
</li>`
}

/**
 * O aviso obrigatorio de §10.13, escrito em UM lugar so.
 *
 * Ele aparece em dois lugares, no cartao da lista e na tela de conferencia da
 * remocao, e a frase e literal na spec. Duas grafias envelheceriam separadas, e
 * a que envelhecesse seria justamente a da tela de conferencia: aquela e a
 * ultima coisa que o dono le antes de encostar o dedo.
 */
function avisoDoAparelhoDeAgora(): HtmlSeguro {
  return html`<p class="e-este"><strong>Este &eacute; o aparelho que voc&ecirc; est&aacute; usando
agora.</strong> Ao remov&ecirc;-lo voc&ecirc; vai sair do painel e vai precisar entrar de novo com
outro aparelho ou com um c&oacute;digo de recupera&ccedil;&atilde;o.</p>`
}

/**
 * O aparelho que a remocao vai alcancar, na TELA, antes da digital (§10.10).
 *
 * §10.10 e categorica: "a tela **tem que** mostrar o valor literal antes da
 * biometria; se o humano nao leu o que assinou, a amarracao ao conteudo nao vale
 * nada". Em `remover_passkey` o valor literal E o aparelho, e ate esta funcao
 * existir a tela de conferencia mostrava apenas campos escondidos, um botao e a
 * frase "confira o aparelho abaixo", com nada abaixo. O dono encostava o dedo
 * sem nenhuma forma de saber se o alvo era o celular velho ou o aparelho em que
 * ele estava; um XSS que trocasse o `value` do campo antes do primeiro POST
 * fazia o dono assinar a remocao de outro aparelho sem nada na tela
 * contradize-lo, que e precisamente o que a amarracao ao `op_hash` deveria
 * tornar visivel.
 *
 * **A leitura so acontece no caminho da RECUSA**, que e onde a tela de
 * conferencia nasce: quem chama passa esta funcao como uma promessa, e o envio
 * que ja traz a digital nao paga leitura nenhuma.
 *
 * O `credential_id` inteiro nao entra aqui (§10.13): sai o apelido, as datas e o
 * mesmo prefixo de 8 hex da lista. O id cru continua existindo em UM lugar da
 * pagina, o campo escondido que diz ao POST qual linha apagar.
 */
export async function resumoDoAparelho(
  env: Env,
  alvo: string,
  sessao: LinhaDeSessao,
): Promise<HtmlSeguro> {
  const linhas = await new PainelCredenciaisRepository(env.DB).listarParaATela()
  const linha = linhas.find((atual) => atual.credentialId === alvo)

  // Alvo que nao esta mais na lista: outra aba removeu, ou o campo veio
  // adulterado. Dizer isso e melhor do que desenhar um aparelho inventado, e a
  // remocao vai falhar de qualquer jeito, depois da digital.
  if (linha === undefined) {
    return html`<p class="conferir-aparelho">Este aparelho <strong>n&atilde;o est&aacute; mais na
lista</strong>. Volte para a p&aacute;gina de aparelhos e confira.</p>`
  }

  return html`<section class="conferir-aparelho">
<h2>${linha.apelido}</h2>
<p class="datas">Cadastrado em ${dataEmPortugues(linha.criadoEm)}. ${
    linha.usadoEm === null
      ? html`Ainda n&atilde;o foi usado para entrar.`
      : html`&Uacute;ltima entrada em ${dataEmPortugues(linha.usadoEm)}.`
  }</p>
<p class="identificacao">Identifica&ccedil;&atilde;o curta:
<code>${await prefixoDeCredencial(linha.credentialId)}</code></p>
${
  linha.rpId === env.PANEL_RP_ID
    ? null
    : html`<p class="endereco-antigo">Foi cadastrado no endere&ccedil;o antigo
<code>${linha.rpId}</code> e j&aacute; n&atilde;o consegue entrar.</p>`
}
${linha.credentialId === sessao.credentialId ? avisoDoAparelhoDeAgora() : null}
</section>`
}

/**
 * "Cadastrar outro aparelho" (§10.13).
 *
 * O formulario e o MESMO `id="registrar"` da pagina do convite, e o
 * `data-tipo="sessao"` e o que diz ao `painel.js` de onde a autorizacao vem:
 * la, do token no fragmento; aqui, de dois gestos de biometria seguidos, um
 * para confirmar que e voce, outro para criar a chave nova.
 *
 * No teto de dez o formulario nao aparece, e no lugar dele vai a frase que
 * explica: um botao que so pode falhar e a mesma promessa quebrada que §13.1
 * chama de defeito.
 */
function formularioDeCadastro(ficha: string, noTeto: boolean): HtmlSeguro {
  if (noTeto) {
    return html`<h2>Cadastrar outro aparelho</h2>
<p>Voc&ecirc; j&aacute; chegou ao limite de aparelhos deste endere&ccedil;o. Para cadastrar mais um,
remova antes algum que voc&ecirc; n&atilde;o usa.</p>`
  }

  return html`<h2>Cadastrar outro aparelho</h2>
<p>Abra este painel <strong>no aparelho novo</strong> e use o bot&atilde;o abaixo l&aacute;. Vai
pedir a sua digital duas vezes: a primeira confirma que &eacute; voc&ecirc;, a segunda cria a chave
do aparelho novo.</p>
<form id="registrar" method="dialog" data-tipo="sessao" data-ficha="${ficha}">
<label for="apelido">Como voc&ecirc; chama este aparelho</label>
<input id="apelido" name="apelido" type="text" maxlength="40" autocomplete="off"
enterkeyhint="done" required>
<button type="submit">Cadastrar este aparelho</button>
</form>
<noscript>
<p><strong>Este navegador est&aacute; com o JavaScript desligado.</strong> Cadastrar a digital
precisa dele. Sem JavaScript continuam funcionando: sair de todos os aparelhos, entrar com um
c&oacute;digo de recupera&ccedil;&atilde;o e a p&aacute;gina de parada de emerg&ecirc;ncia.</p>
</noscript>`
}

/**
 * Quantos codigos de recuperacao AINDA DAO PARA USAR. UMA leitura.
 *
 * **Nao e `hashesVivos('recuperacao').length`, e a diferenca e o defeito que
 * esta funcao existe para consertar.** Aquele metodo filtra so
 * `invalidado_em IS NULL`, e deixa `usado_em` de fora **de proposito**: o codigo
 * de PARADA nao e de uso unico (§10.12), e o de recuperacao confere o uso unico
 * na hora de consumir. Mas o consumo de §10.11 marca `usado_em` no codigo usado
 * e `invalidado_em` em TODOS OS OUTROS, entao, depois de uma recuperacao,
 * "vivos" devolve exatamente um hash: o do codigo ja queimado. A tela escrevia
 * "voce ainda tem 1 codigos que nunca foram usados", em verde, com ZERO codigos
 * utilizaveis, e a faixa vermelha de `quantosValem === 0` nunca disparava. O
 * dono so descobria na proxima perda de aparelho, trancado fora do painel, com
 * saida so por `/setup/painel/zerar` na maquina do deploy.
 *
 * **Um `COUNT`, e nao a lista.** A tela so usava o `.length`: trazer os HMAC dos
 * codigos para dentro da camada que monta HTML era carregar o segredo do banco
 * ate a beira do `console.log` de depuracao por nada.
 */
async function contarCodigosUtilizaveis(db: D1Database): Promise<number> {
  const linha = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM painel_codigos
        WHERE tipo = 'recuperacao' AND usado_em IS NULL AND invalidado_em IS NULL`,
    )
    .first<{ total: number }>()

  return linha?.total ?? 0
}

/** A area dos seis codigos de recuperacao (§3, §10.11). */
function blocoDosCodigos(ficha: string, quantosValem: number): HtmlSeguro {
  return html`<h2>C&oacute;digos de recupera&ccedil;&atilde;o</h2>
${
  quantosValem === 0
    ? html`<p class="faixa faixa-erro" role="status"><strong>Voc&ecirc; n&atilde;o tem nenhum
c&oacute;digo de recupera&ccedil;&atilde;o valendo.</strong> Gere um conjunto novo agora e anote no
papel. Sem eles, perder todos os aparelhos significa perder o painel.</p>`
    : html`<p>Voc&ecirc; ainda tem <strong>${String(
        quantosValem,
      )}</strong> c&oacute;digos que nunca foram usados.</p>`
}
<p>Gerar um conjunto novo <strong>apaga o conjunto antigo inteiro</strong>, inclusive o
c&oacute;digo do papel que desliga a automa&ccedil;&atilde;o. Os c&oacute;digos novos aparecem
<strong>uma vez s&oacute;</strong>, nesta tela, e n&atilde;o d&aacute; para v&ecirc;-los de novo
depois.</p>
<form method="post" action="${ROTA_APARELHOS.caminho}">
<input type="hidden" name="${CAMPO_DA_FICHA}" value="${ficha}">
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${ACAO_GERAR_CODIGOS}">
<button type="submit">Gerar c&oacute;digos novos</button>
</form>`
}

/**
 * O `<form id="confirmar">` desta rota, o passo 1 de §10.10 sem campo de
 * configuracao nenhum para mostrar.
 *
 * A mudanca canonica viaja no atributo `data-mudanca`, e nao num campo
 * escondido, pela mesma razao da tela de conferencia do funil: ela e insumo do
 * `painel.js`, e nao do POST. Num campo escondido ela voltaria no corpo e
 * viraria um segundo lugar de onde a mudanca poderia vir.
 *
 * Os escondidos sao o corpo recebido MENOS os estruturais: e o `acao` e o
 * `aparelho` que o servidor vai reler para recalcular o `op_hash`. Mexer em
 * qualquer um deles muda o hash, e a acao e recusada.
 */
export function telaDeConferencia(
  mudanca: MudancaCanonica,
  campos: URLSearchParams,
  ficha: string,
): HtmlSeguro {
  const excluidos = new Set(ESTRUTURAIS)
  const escondidos = [...campos]
    .filter(([nome]) => !excluidos.has(nome))
    .map(([nome, valor]) => html`<input type="hidden" name="${nome}" value="${valor}">`)

  return html`<section class="conferencia">
<form method="post" action="${ROTA_APARELHOS.caminho}" id="confirmar"
data-mudanca="${jsonCanonico(mudanca)}">
<input type="hidden" name="${CAMPO_DA_FICHA}" value="${ficha}">
<input type="hidden" name="${CAMPO_DA_DIGITAL}" value="">
${escondidos}
<button type="submit">Confirmar com a digital</button>
</form>
<p><a href="${ROTA_APARELHOS.caminho}">Cancelar</a>, nada muda.</p>
</section>`
}
