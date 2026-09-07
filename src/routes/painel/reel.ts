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
import { type EstadoDeComportamento, estadoDaConfig, type PatchDeEstado } from './formulario'
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
} from './inicio'
import { estadoEfetivo } from './midias'
import { blocoDaRecusa, RecusaAuditada } from './recusa'
import { erro } from './resposta'
import { ROTA_REEL, ROTA_REELS } from './rotas'
import type { EntradaDaRota } from './router'
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

/** Os botoes das tres operacoes, cada um no proprio formulario. */
function blocoDosBotoes(
  mediaId: string,
  ficha: string,
  versao: number,
  pausado: boolean,
  temProprias: boolean,
): HtmlSeguro {
  const campos = html`${camposDoFormulario(ficha, versao)}
<input type="hidden" name="${CAMPO_DO_REEL}" value="${mediaId}">`

  return html`<form method="post" action="${ROTA_REEL.caminho}">
${campos}
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${pausado ? RELIGAR : PAUSAR}">
<button type="submit">${
    pausado ? TELA_DOS_REELS.religarEsteReel : TELA_DOS_REELS.pausarEsteReel
  }</button>
</form>
${
  temProprias
    ? html`<form method="post" action="${ROTA_REEL.caminho}">
${campos}
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${SEGUIR_O_GERAL}">
<button type="submit">${TELA_DOS_REELS.seguirRegraGeral}</button>
</form>`
    : null
}`
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

  const linha = await new PainelMidiasRepository(env.DB).lerUma(mediaId)
  if (linha === null) {
    // Ruling 93: um `media_id` que nao casa com linha e RECUSADO, e nao
    // ignorado. Renderizar uma tela vazia ensinaria que o painel conhece Reels
    // que ele nao conhece.
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'reel_desconhecido' })
  }

  const sobreposicao = sobreposicaoDaLinha(linha)
  const snapshot = await configDaTela(env, now)

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
    : html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.foraDaLista}
<a href="${ROTA_REELS.caminho}">${TELA_DOS_REELS.incluirNaLista}</a></p>`
}
${
  linha.indisponivel_desde === null
    ? null
    : html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.reelApagado}</p>`
}
${faixaDeLinhaInvalida(sobreposicao)}
${blocoDosAjustes(efetivo, global, sobreposicao)}
${blocoDosBotoes(
  mediaId,
  ficha,
  snapshot.versao,
  sobreposicao.enabled === 0,
  temRegrasProprias(sobreposicao),
)}
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

  const patchDoHandler: PatchDeEstado =
    acao === SEGUIR_O_GERAL
      ? Object.fromEntries(CAMPOS_DO_REEL.map((campo) => [campo, estadoGlobal[campo]]))
      : { enabled: acao === PAUSAR ? false : estadoGlobal.enabled }

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
      mudou: true,
    },
  })
}
