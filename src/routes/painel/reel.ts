/**
 * `GET (?midia=), POST /painel/reel` — "Este Reel responde diferente" (§3).
 *
 * **A palavra "sobreposicao" nunca aparece na tela** (§3): cada linha mostra o
 * que vale hoje naquele Reel, e o valor herdado fica escrito entre parenteses.
 *
 * **O Reel vem na QUERY STRING, e nenhum caminho tem segmento variavel** (§7.1,
 * Ruling 93). `media_id` nao e segredo — ele aparece no permalink publico do
 * Reel —, entao a regra "segredo nunca na query string" nao e violada. Na
 * ESCRITA ele vai no corpo do POST, como todo identificador de escrita. E um id
 * que nao casa com linha nenhuma e **recusado**, nao ignorado.
 *
 * **Tres operacoes declaradas**, todas pela extensao do funil (Ruling 91):
 *
 *   - `acao=pausar`  — este Reel para de responder (`enabled = 0`)
 *   - `acao=religar` — este Reel volta a seguir a chave geral (`enabled = NULL`)
 *   - `acao=geral`   — "Voltar tudo a seguir a regra geral": as treze colunas
 *                      de sobreposicao voltam a `NULL` num statement so
 *
 * **Ruling 92 vive aqui**: `enabled` por midia so aceita `0`. A recusa nasce no
 * validador, com frase de `dicionario.ts`; o `CHECK (enabled IS NULL OR
 * enabled = 0)` da migration `0002` e a segunda linha, e um erro de banco no
 * Worker viraria `500` sem frase de tela.
 *
 * **§3 x §10.10, uma tensao que a spec carrega e que este arquivo resolve pelo
 * classificador.** §3 diz que "Voltar tudo a seguir a regra geral" nao pede
 * digital, "porque desfazer e sempre a direcao segura". Nao e sempre: se a
 * sobreposicao daquele Reel ESTREITAVA — um intervalo por pessoa maior que o
 * geral, por exemplo —, desfaze-la ALARGA, e §10.10 lista o alargamento entre o
 * que pede a digital. Quem decide aqui e `camposProtegidos`, a tabela da propria
 * spec: no caso comum, em que a sobreposicao alargava ou era neutra, o botao nao
 * pede nada e §3 esta cumprida a letra; no caso em que desfazer alarga, ele
 * pede. Errar para o lado de perguntar e a direcao segura das duas.
 */
import type { AutomationConfig } from '../../config'
import {
  COLUNAS_DE_SOBREPOSICAO,
  PainelMidiasRepository,
  type Sobreposicao,
  semSobreposicao,
  sobreposicaoDaLinha,
  temRegrasProprias,
} from '../../repositories/painel-midias-repository'
import { ehMediaIdValido } from '../../services/config-validation'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import { CAMPO_DA_ACAO } from './campos'
import {
  type CampoDaConfig,
  motivoDaRecusa,
  NOME_DO_CAMPO,
  TELA_DOS_REELS,
  valorNaTela,
} from './dicionario'
import {
  camposQueMudaram,
  type EstadoDeComportamento,
  estadoDaConfig,
  type PatchDeEstado,
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
import { estadoEfetivo, linhaDoReel } from './midias'
import { blocoDaRecusa, RecusaAuditada } from './recusa'
import { erro } from './resposta'
import { ROTA_REEL, ROTA_REELS } from './rotas'
import type { EntradaDaRota } from './router'
import { camposProtegidos } from './stepup'
import { telaDoPainel } from './tela'

/** O nome do parametro que nomeia o Reel, na query string e no corpo (§7.1). */
export const CAMPO_DO_REEL = 'midia'

/** As tres operacoes de §3. Nada mais casa (Ruling 85). */
export const PAUSAR = 'pausar'
export const RELIGAR = 'religar'
export const SEGUIR_O_GERAL = 'geral'

/**
 * Os campos que ESTA rota grava (Ruling 70).
 *
 * Sao os da uniao gravavel **menos `mediaScope`**: o escopo e uma decisao da
 * conta inteira, e um Reel nao tem como dizer "em quais Reels a automacao
 * responde". A lista entra no META-11 como qualquer outra, e a uniao continua
 * fechando com `CAMPOS_DA_RESTAURACAO` porque ela e um subconjunto proprio.
 */
export const CAMPOS_DO_REEL: readonly CampoDaConfig[] = [
  'enabled',
  'triggerKeywords',
  'matchMode',
  'caseSensitive',
  'normalizeAccents',
  'ignorePunctuation',
  'processOnlyReels',
  'publicReplyText',
  'privateReplyText',
  'destinationUrl',
  'userCooldownHours',
]

/**
 * Ruling 92: uma sobreposicao pode PAUSAR um Reel, nunca liga-lo.
 *
 * Devolve o codigo da recusa, ou `null` quando a sobreposicao presta. A recusa
 * nasce AQUI, e nao no `CHECK` do banco, porque um erro de D1 dentro do Worker
 * vira `500` sem frase de tela — e a pessoa ficaria com "algo deu errado" no
 * lugar de "a chave geral e quem manda". O `CHECK` continua sendo a segunda
 * linha, e ele existe porque uma linha pode entrar por `wrangler d1 execute`.
 */
export function validarSobreposicao(sobreposicao: Sobreposicao): string | null {
  if (sobreposicao.enabled !== null && sobreposicao.enabled !== 0) return 'reel_nao_pode_ligar'
  return null
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

/** Uma linha "o que vale hoje / de onde veio". */
function linhaDoAjuste(
  campo: CampoDaConfig,
  efetivo: EstadoDeComportamento,
  global: EstadoDeComportamento,
  propria: boolean,
): HtmlSeguro {
  return html`<li class="linha-de-ajuste">
<p class="rotulo">${NOME_DO_CAMPO[campo]}</p>
<p class="valor">${valorNaTela(campo, efetivo[campo])}</p>
${
  propria
    ? html`<p class="herdado">Na regra geral: ${valorNaTela(campo, global[campo])}</p>`
    : html`<p class="herdado">Usando as mesmas de sempre.</p>`
}
</li>`
}

/**
 * As linhas que a tela mostra, e so elas.
 *
 * Sao os campos de `CAMPOS_DO_REEL`: o que este Reel pode ter de proprio. Os
 * dois interruptores de canal ficam de fora pela mesma razao das outras telas —
 * eles ainda nao tem formulario em lugar nenhum (Ruling 82).
 */
function blocoDosAjustes(
  efetivo: EstadoDeComportamento,
  global: EstadoDeComportamento,
  sobreposicao: Sobreposicao,
): HtmlSeguro {
  const proprio = (campo: CampoDaConfig): boolean => efetivo[campo] !== global[campo]

  return html`<ul class="ajustes-do-reel">${CAMPOS_DO_REEL.map((campo) =>
    linhaDoAjuste(campo, efetivo, global, proprio(campo)),
  )}</ul>
<p class="resumo">${
    temRegrasProprias(sobreposicao)
      ? 'Este Reel tem alguma coisa diferente da regra geral. As linhas acima dizem o quê.'
      : TELA_DOS_REELS.seguindoOGeral
  }</p>`
}

/**
 * O `depois` que uma das tres operacoes produz, sem gravar nada.
 *
 * **Uma grafia so, e ela serve a tela E a gravacao.** `gravarNoReel` a usa para
 * montar o `patchDoHandler`, e a tela a usa para saber, ANTES de desenhar o
 * botao, se aquele toque vai pedir a digital. Duas expressoes separadas eram o
 * caminho para a tela dizer "livre" onde o funil diz "protegido" — e a
 * divergencia apareceria como surpresa biometrica, que e o que §12.3 proibe
 * com todas as letras.
 */
function patchDaOperacao(
  acao: typeof PAUSAR | typeof RELIGAR | typeof SEGUIR_O_GERAL,
  estadoGlobal: EstadoDeComportamento,
): PatchDeEstado {
  if (acao === SEGUIR_O_GERAL) {
    return Object.fromEntries(CAMPOS_DO_REEL.map((campo) => [campo, estadoGlobal[campo]]))
  }
  return { enabled: acao === PAUSAR ? false : estadoGlobal.enabled }
}

/**
 * Os campos de §10.10 que aquela operacao alcanca, do jeito que o funil os
 * classificaria.
 *
 * `camposProtegidos` e a tabela da propria spec, exportada desde o Ruling 77
 * justamente para poder ser consultada fora do funil. Ela recebe o mesmo
 * `antes`, o mesmo `depois` e a mesma lista de mudados que o passo 8 receberia.
 */
function protegidosDaOperacao(
  acao: typeof PAUSAR | typeof RELIGAR | typeof SEGUIR_O_GERAL,
  antes: EstadoDeComportamento,
  estadoGlobal: EstadoDeComportamento,
): readonly CampoDaConfig[] {
  const depois: EstadoDeComportamento = { ...antes, ...patchDaOperacao(acao, estadoGlobal) }
  return camposProtegidos(camposQueMudaram(antes, depois), antes, depois)
}

/**
 * Os botoes das tres operacoes, cada um no proprio formulario.
 *
 * **§12.3, e esta tela era a unica que o descumpria**: "quem garante o aviso e
 * o cadeado no campo mais a tela de conferencia — **nunca uma surpresa
 * biometrica**". "Voltar tudo a seguir a regra geral" PODE cair na cerimonia
 * (MID-21): quando a sobreposicao daquele Reel estreitava, desfaze-la alarga, e
 * §10.10 lista o alargamento entre o que pede a digital. Ate esta rodada o
 * botao nao dizia nada, e o dono descobria pelo leitor de digital.
 *
 * A tela tem tudo para decidir na renderizacao — `antes`, `depois` e a tabela
 * de §10.10 —, entao ela decide, e emite os tres sinais de §12.3 juntos: o
 * cadeado com a palavra "protegido", a classe que pinta a borda ambar e a frase
 * antes do botao. E o botao diz o que vai acontecer.
 */
function blocoDosBotoes(
  mediaId: string,
  ficha: string,
  versao: number,
  antes: EstadoDeComportamento,
  estadoGlobal: EstadoDeComportamento,
  sobreposicao: Sobreposicao,
): HtmlSeguro {
  const pausado = sobreposicao.enabled === 0
  const acaoDaChave = pausado ? RELIGAR : PAUSAR
  const campos = html`${camposDoFormulario(ficha, versao)}
<input type="hidden" name="${CAMPO_DO_REEL}" value="${mediaId}">`

  return html`${formularioDaOperacao(
    campos,
    acaoDaChave,
    pausado ? TELA_DOS_REELS.religarEsteReel : TELA_DOS_REELS.pausarEsteReel,
    protegidosDaOperacao(acaoDaChave, antes, estadoGlobal),
  )}
${
  temRegrasProprias(sobreposicao)
    ? formularioDaOperacao(
        campos,
        SEGUIR_O_GERAL,
        TELA_DOS_REELS.seguirRegraGeral,
        protegidosDaOperacao(SEGUIR_O_GERAL, antes, estadoGlobal),
      )
    : null
}`
}

/** Um botao de operacao, com os tres sinais de §12.3 quando ele e protegido. */
function formularioDaOperacao(
  campos: HtmlSeguro,
  acao: string,
  rotulo: string,
  protegidos: readonly CampoDaConfig[],
): HtmlSeguro {
  const protegido = protegidos.length > 0

  return html`<form method="post" action="${ROTA_REEL.caminho}"${
    protegido ? html` class="protegidos"` : null
  }>
${campos}
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${acao}">
${
  protegido
    ? html`<p class="rotulo">${seloProtegido()}</p>
<p>${TELA_DOS_REELS.esteBotaoPedeDigital}</p>`
    : null
}
<button type="submit">${protegido ? `${rotulo} ${TELA_DOS_REELS.vaiPedirADigital}` : rotulo}</button>
</form>`
}

// ---------------------------------------------------------------------------
// O handler
// ---------------------------------------------------------------------------

export async function handleReel(entrada: EntradaDaRota): Promise<Response> {
  const { env, now, contexto, request } = entrada

  // O id vem da query string no `GET` e do corpo no `POST` (§7.1, regra de
  // identificador). Sao dois lugares porque sao duas perguntas: um endereco que
  // se cola e uma escrita que se declara.
  const mediaId =
    request.method === 'POST'
      ? entrada.corpo.familia === 'formulario'
        ? entrada.corpo.campos.get(CAMPO_DO_REEL)
        : null
      : new URL(request.url).searchParams.get(CAMPO_DO_REEL)

  if (mediaId === null || !ehMediaIdValido(mediaId)) {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'reel_invalido' })
  }

  // **A linha daquele Reel sai do LOTE da configuracao, e nao de uma consulta
  // propria** (§12.10). `configDaTela` pede `painel_midias` inteira dentro do
  // `db.batch()` que a configuracao ja fazia, e um `batch` vale UM subrequest:
  // esta tela caiu de 4 para os 3 da tabela, e o desvio declarado no TELA-20
  // saiu junto. A ordem inverteu — a config vem antes da recusa por id
  // desconhecido —, e nao ha custo nisso: os dois caminhos leem o mesmo lote, e
  // a recusa continua acontecendo antes de qualquer escrita.
  const snapshot = await configDaTela(env, now)
  const linha = linhaDoReel(snapshot, mediaId)
  if (linha === null) {
    // Ruling 93: um `media_id` que nao casa com linha e RECUSADO, e nao
    // ignorado. Renderizar uma tela vazia ensinaria que o painel conhece Reels
    // que ele nao conhece.
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'reel_desconhecido' })
  }

  const sobreposicao = sobreposicaoDaLinha(linha)

  if (request.method === 'POST') {
    return await gravarNoReel(entrada, mediaId, sobreposicao, snapshot.global, snapshot.versao)
  }

  const global = estadoDaConfig(snapshot.global)
  const efetivo = estadoEfetivo(snapshot.global, sobreposicao)
  const visao = panorama(snapshot, await contaConectada(env.DB))
  const ficha = await fichaDaTela(entrada)

  const corpo = html`<h1>${TELA_DOS_REELS.tituloDoReel}</h1>
${blocoDeConfirmacao(request)}
${
  linha.ativo === 1
    ? null
    : // §12.5 escreve o rotulo como acao — "[Incluir este Reel na lista]" — e o
      // que a tela entrega e um LINK para "Meus Reels", onde a pessoa marca o
      // Reel e salva. Aceitavel sem JavaScript: incluir um Reel e uma GRAVACAO,
      // e uma gravacao precisa da ficha, da versao e do funil inteiro — um
      // `<form>` aqui seria a segunda grafia do POST de `/painel/reels`, com a
      // revalidacao dos ids novos e o teto de 200 por conta propria. Fica
      // REGISTRADO como divergencia de rotulo, e nao como funcionalidade
      // entregue.
      html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.foraDaLista}
<a href="${ROTA_REELS.caminho}">${TELA_DOS_REELS.incluirNaLista}</a></p>`
}
${
  linha.indisponivel_desde === null
    ? null
    : html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.reelApagado}</p>`
}
${faixaDeLinhaInvalida(sobreposicao)}
${blocoDosAjustes(efetivo, global, sobreposicao)}
${blocoDosBotoes(mediaId, ficha, snapshot.versao, efetivo, global, sobreposicao)}
<p><a href="${ROTA_REELS.caminho}">${TELA_DOS_REELS.titulo}</a></p>`

  return telaDoPainel(molduraCom('reels', TELA_DOS_REELS.tituloDoReel, visao, corpo))
}

/**
 * §12.5: linha de midia invalida no banco vira cartao DESLIGADO com faixa ambar
 * que **nomeia o campo**.
 *
 * Nomear e o ponto, e e a mesma regra de §12.6: "este Reel esta parado por um
 * problema na configuracao dele" sem dizer qual campo manda a pessoa procurar
 * em onze linhas.
 */
function faixaDeLinhaInvalida(sobreposicao: Sobreposicao): HtmlSeguro {
  const codigo = validarSobreposicao(sobreposicao)
  if (codigo === null) return html``

  return html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.reelParado} ${
    NOME_DO_CAMPO.enabled
  }. ${TELA_DOS_REELS.reelParadoComoResolver}</p>`
}

/**
 * A gravacao por Reel, pela extensao do funil (Ruling 91).
 *
 * `antes` e o estado EFETIVO deste Reel; `patchDoHandler` e o `depois` que a
 * operacao produz. Com os dois, a classificacao de risco de §10.10, a tela de
 * conferencia, o `op_hash` e o JSON da auditoria sao os MESMOS de sempre — nao
 * ha uma segunda grafia de nenhum dos quatro.
 */
async function gravarNoReel(
  entrada: EntradaDaRota,
  mediaId: string,
  atual: Sobreposicao,
  global: AutomationConfig,
  versao: number,
): Promise<Response> {
  const { env, now, contexto, corpo, sessao } = entrada
  if (corpo.familia !== 'formulario' || sessao === null) return erro('corpo_invalido', contexto)

  const acao = corpo.campos.get(CAMPO_DA_ACAO)
  if (acao !== PAUSAR && acao !== RELIGAR && acao !== SEGUIR_O_GERAL) {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'acao_desconhecida' })
  }

  const estadoGlobal = estadoDaConfig(global)
  const antes = estadoEfetivo(global, atual)

  const nova: Sobreposicao =
    acao === SEGUIR_O_GERAL ? semSobreposicao() : { ...atual, enabled: acao === PAUSAR ? 0 : null }

  // Ruling 92, primeira linha: a recusa nasce no validador, com frase de tela.
  // O `CHECK` da migration continua sendo a segunda, para a linha que entrar
  // por fora do painel.
  const invalida = validarSobreposicao(nova)
  if (invalida !== null) {
    return await new RecusaAuditada(
      env,
      now,
      contexto,
      await configDaTela(env, now),
      `passkey:${await prefixoDeCredencial(sessao.credentialId)}`,
    ).registrar({
      acao: 'mudanca_recusada',
      campos: ['enabled'],
      codigo: 'dados_invalidos',
      motivoInterno: invalida,
      explicacao: html`${blocoDaRecusa([{ campo: 'enabled', motivo: motivoDaRecusa(invalida) }])}`,
    })
  }

  // A MESMA funcao que a tela consultou para decidir o cadeado (§12.3).
  const patchDoHandler: PatchDeEstado = patchDaOperacao(acao, estadoGlobal)

  return await gravarConfiguracao(entrada, {
    para: ROTA_REELS.caminho,
    confirmacao: 'salvo',
    estruturais: [CAMPO_DA_ACAO, CAMPO_DO_REEL],
    campos: CAMPOS_DO_REEL,
    patchDoHandler,
    midias: {
      // §9.9: o `alvo` nomeia a entidade. Um `media_id` cabe nos 32 caracteres
      // da coluna, e ele viaja como TEXT do formulario ate o `bind` (Ruling 90).
      alvo: mediaId,
      statements: [
        new PainelMidiasRepository(env.DB).statementDeSobreposicao(now, versao, mediaId, nova),
      ],
      antes,
      // **Calculado, e nao `true` fixo.** Um `true` fixo derrotava
      // `mudouAlgumaCoisa` no funil e transformava todo POST desta tela numa
      // gravacao: `acao=religar` num Reel SEM sobreposicao nenhuma respondia
      // `303 ?ok=salvo`, gravava uma linha de auditoria com `campos: []` — que
      // nao nomeia campo nenhum — e subia `painel_config.versao`, invalidando a
      // trava otimista de TODA aba aberta do painel, Palavras e Mensagem
      // inclusive. E a faixa verde dizia "Pronto, salvo" para uma gravacao que
      // nao gravou, contra §12.1 regra 4. §9.9 registra GRAVACAO, e um
      // formulario reenviado igual nao e uma.
      mudou: mudouASobreposicao(atual, nova),
    },
  })
}

/**
 * A sobreposicao nova difere da que esta no banco?
 *
 * `COLUNAS_DE_SOBREPOSICAO` e a lista FECHADA do schema, e comparar por ela — e
 * nao por `Object.keys` de um dos dois — e o que impede uma coluna nova de
 * entrar no banco e ficar de fora desta pergunta em silencio.
 */
function mudouASobreposicao(atual: Sobreposicao, nova: Sobreposicao): boolean {
  return COLUNAS_DE_SOBREPOSICAO.some((coluna) => atual[coluna] !== nova[coluna])
}
