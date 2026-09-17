/**
 * O step-up de §10.10: **uma operacao, presa ao conteudo**.
 *
 * Nao ha janela, nao ha "modo privilegiado", nao ha `elevadoAte` e nao existe
 * `/painel/api/stepup/verificar` (§7.1, nomes deletados). A verificacao
 * acontece DENTRO da rota de escrita, na mesma requisicao que aplica a
 * mudanca, e e isso que torna impossivel haver uma autorizacao pendurada
 * esperando uma segunda requisicao.
 *
 * **Por que nao uma janela de 5 minutos, que seria mais confortavel.** O
 * inimigo e um painel invadido. Com janela, um XSS que rouba o instante do
 * step-up faz N mudancas dentro dela, inclusive trocar o link DEPOIS que o dono
 * aprovou outra coisa. Preso ao `op_hash`, o autenticador assina *aquela*
 * mudanca. O ganho e categorico; o custo e um toque a mais numa operacao rara.
 * E custa zero estado e zero escrita: a autorizacao e consumida na mesma
 * requisicao que aplica a mudanca.
 *
 * Os quatro passos da cerimonia, e onde cada um vive:
 *
 *   1. a tela monta a mudanca e MOSTRA o valor literal    `telaDeConferencia`
 *   2. `POST /painel/api/stepup/opcoes`                   `handleOpcoesDeStepUp`
 *   3. `navigator.credentials.get()` num campo escondido  `public/painel/painel.js`
 *   4. o formulario e submetido para a rota de escrita    `exigirStepUp`, chamado
 *      pelo funil de `gravar.ts`
 *
 * **Duas mudancas de endereco, e as duas foram medidas antes de decididas.**
 *
 * 1. `exigirStepUp()`, o brief a listava em `guardas.ts`; com ela la, aquele
 *    arquivo ia a **884 linhas**, 84 acima do teto de 800 deste repositorio. O
 *    nome do cookie e o do campo escondido ficaram por la, ao lado dos irmaos
 *    deles; a cerimonia veio para o arquivo que ja e dono dela.
 * 2. A **classificacao de risco por campo** e a passagem do passo 8 vieram de
 *    `gravar.ts`, que chegaria a **923 linhas** com elas. Nao foram reescritas:
 *    `CAMPOS_SEMPRE_PROTEGIDOS`, `alargaOAlcance` e `camposProtegidos` estao
 *    aqui palavra por palavra como a etapa anterior os deixou, e continuam sendo
 *    chamados de UM lugar so em PRODUCAO, o funil, por `passarPeloStepUp`.
 *    `camposProtegidos` e exportada desde o Ruling 77, para a tabela de §10.10
 *    ser afirmada sobre ela em vez de por rota; a exportacao nao cria um segundo
 *    chamador, cria um ponto de medicao. Ruling 63 continua valendo inteiro: nao
 *    nasceu um segundo funil, nasceu um endereco para o que §10.10 descreve
 *    junto.
 *
 * As duas estao declaradas no relatorio, com os numeros.
 */
import { PainelCredenciaisRepository } from '../../repositories/painel-credenciais-repository'
import {
  FALHAS_DE_STEPUP_ATE_APAGAR,
  type LinhaDeSessao,
  PainelSessoesRepository,
} from '../../repositories/painel-sessoes-repository'
import { bytesToBase64Url } from '../../security/base64url'
import { timingSafeEqual } from '../../security/constant-time'
import { PRAZO_DE_ENVELOPE_MS } from '../../security/signed-envelope'
import { limparTexto } from '../../services/config-validation'
import {
  emitirEnvelope,
  fichaCsrf,
  lerEnvelope,
  origemDoPainel,
} from '../../services/panel-session'
import { opcoesDeStepUp, sortearDesafio } from '../../services/webauthn/opcoes'
import { lerRespostaDeAssertion, verificarAssertion } from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import {
  CAMPO_DA_DIGITAL,
  CAMPO_DA_FICHA,
  CAMPO_DA_VERSAO,
  COOKIE_DE_STEPUP,
  cookieDoPainel,
  lerCookie,
} from './campos'
import {
  type CampoDaConfig,
  NOME_DO_CAMPO,
  RECUSA_SEM_VALOR,
  TELA_DOS_REELS,
  valorNaTela,
} from './dicionario'
import type { EstadoDeComportamento, PatchDeEstado } from './formulario'
import { type HtmlSeguro, html } from './html'
import type { RecusaAuditada } from './recusa'
import { erro, json } from './resposta'
import type { EntradaDaRota } from './router'

const codificador = new TextEncoder()

// ---------------------------------------------------------------------------
// `json_canonico` e o `op_hash` (§10.10)
// ---------------------------------------------------------------------------

/**
 * As quatro operacoes que uma mudanca canonica pode ter (§10.10).
 *
 * O objeto `mudanca` SEMPRE carrega `{ acao: "<operacao>"... }`, assim duas
 * operacoes diferentes com o mesmo conteudo nao compartilham assinatura. Uma
 * mudanca de configuracao que por acaso tivesse a mesma forma de um
 * `remover_passkey` produziria o mesmo hash sem o campo `acao`, e um step-up
 * autorizaria a operacao errada.
 *
 * Tres delas, as de passkey e de codigos, sao vocabulario de §10.10 e ainda
 * nao tem rota de escrita que as consuma; a lista de operacoes que a CERIMONIA
 * aceita e menor, e mora em `OPERACOES_ACEITAS`.
 */
export type AcaoDeMudanca = 'config' | 'adicionar_passkey' | 'remover_passkey' | 'gerar_codigos'

/**
 * Os tipos de valor que entram na forma canonica.
 *
 * Fechado de proposito: `number` entra como inteiro, `string` ja normalizada,
 * `boolean` como esta e lista como lista de texto. Um objeto aninhado aqui
 * criaria uma segunda pergunta de ordenacao de chaves onde hoje nao existe
 * nenhuma.
 */
export type ValorCanonico = string | number | boolean | readonly string[]

/**
 * A mudanca que o autenticador assina: a acao, o ALVO e os campos.
 *
 * **`alvo` entrou com o Ruling 96, que emendou o Ruling 90.** Aquele dizia "os
 * ids nao entram no `op_hash`, mantenha assim", e estava certo enquanto nao
 * havia escrita por midia. Com `POST /painel/reel` passou a haver uma que PODE
 * exigir step-up (desfazer uma sobreposicao que estreitava ALARGA, §10.10), e o
 * patch dela e **identico para qualquer Reel**: o `media_id` viajava so num
 * campo escondido que a tela de conferencia reemite e que ficava FORA da
 * assinatura. E a forma exata do Ruling 86, trocar `midia` entre os dois POSTs
 * mantinha o `oh` valido e mudava a entidade gravada, com o autenticador tendo
 * assinado "intervalo por pessoa: 48 -> 24" sem dizer de qual Reel.
 *
 * **Ele e STRING, sempre**, e a outra metade do Ruling 90 continua valendo: um
 * id de 18 digitos sem aspas volta de `JSON.parse` como `number` corrompido, em
 * silencio. O leitor da cerimonia RECUSA um `alvo` que nao seja texto.
 */
export interface MudancaCanonica {
  readonly acao: AcaoDeMudanca
  /** A entidade que a mudanca alcanca, quando ela nao e a linha global. */
  readonly alvo?: string
  readonly campos: Readonly<Record<string, ValorCanonico>>
}

/**
 * `json_canonico(mudanca)`, especificado em §10.10 e congelado em teste.
 *
 * As regras, palavra por palavra: chaves ordenadas lexicograficamente **por
 * code point**, sem espaco entre tokens, numeros como inteiros, strings ja em
 * NFKC e sem `\p{Cc}\p{Cf}`.
 *
 * **A entrada nunca e o corpo cru.** Ela e o mapa de campos ja lido pelos
 * mesmos leitores nos dois caminhos, o formulario urlencoded e o JSON da
 * cerimonia, e a limpeza de texto e a MESMA `limparTexto` de
 * `config-validation.ts`, e nao uma segunda. Sem essa especificacao o hash
 * recalculado divergiria e a trava viraria bug intermitente: o dono apertaria a
 * digital e receberia uma recusa sem entender por que.
 *
 * `JSON.stringify` sobre um objeto montado em ordem ja da "sem espaco entre
 * tokens" e escapes deterministicos; o que ele NAO da e a ordem, e e por isso
 * que as chaves sao inseridas ordenadas em vez de copiadas.
 */
export function jsonCanonico(mudanca: MudancaCanonica): string {
  const tudo: Record<string, ValorCanonico> = { ...mudanca.campos, acao: mudanca.acao }

  // **O `alvo` so entra quando existe, e e isso que mantem os vetores
  // congelados de §13.2 intactos**: sem ele o JSON e byte a byte o de antes do
  // Ruling 96, e STEP-18, STEP-19 e STEP-21 continuam sendo os mesmos vetores
  // escritos a mao. Ele vai DEPOIS do spread, como `acao`, nao existe campo de
  // configuracao chamado `alvo`, e se um dia existir, quem manda e a entidade.
  if (mudanca.alvo !== undefined) tudo.alvo = mudanca.alvo

  const ordenado: Record<string, ValorCanonico> = {}
  for (const chave of Object.keys(tudo).sort(porCodePoint)) {
    ordenado[chave] = normalizar(tudo[chave] as ValorCanonico)
  }

  return JSON.stringify(ordenado)
}

/**
 * Ordem por CODE POINT, e nao a ordem natural de `Array.prototype.sort`.
 *
 * O `sort()` sem comparador ordena por unidade de codigo UTF-16, e as duas
 * ordens divergem acima de U+FFFF. Nenhum nome de campo de hoje chega la, mas
 * `json_canonico` e uma especificacao, e uma especificacao que so vale para as
 * chaves de hoje e a que quebra no dia em que aparecer a de amanha.
 */
function porCodePoint(a: string, b: string): number {
  const esquerda = [...a]
  const direita = [...b]

  for (let i = 0; i < Math.min(esquerda.length, direita.length); i++) {
    const um = (esquerda[i] as string).codePointAt(0) ?? 0
    const outro = (direita[i] as string).codePointAt(0) ?? 0
    if (um !== outro) return um - outro
  }
  return esquerda.length - direita.length
}

/** Um valor na forma canonica: texto limpo, numero inteiro, resto como esta. */
function normalizar(valor: ValorCanonico): ValorCanonico {
  if (typeof valor === 'string') return limparTexto(valor)
  if (typeof valor === 'number') return Math.trunc(valor)
  if (Array.isArray(valor)) return valor.map((item) => limparTexto(item))
  return valor
}

/**
 * `op_hash = SHA-256(json_canonico(mudanca))`, em base64url.
 *
 * Ele nasce em dois lugares e tem de dar o MESMO valor: na cerimonia, onde vai
 * assinado dentro do envelope, e na rota de escrita, onde e RECALCULADO a
 * partir do corpo recebido. O teste dos vetores congelados prova a igualdade
 * entre os dois caminhos, porque a divergencia entre eles nao apareceria como
 * erro, apareceria como uma digital que nunca funciona.
 */
export async function opHash(mudanca: MudancaCanonica): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', codificador.encode(jsonCanonico(mudanca)))
  return bytesToBase64Url(new Uint8Array(digest))
}

/**
 * A mudanca canonica de uma gravacao de configuracao.
 *
 * A entrada e o PEDACO DE ESTADO que o corpo carregou, ja lido campo a campo
 * pelo funil, com `sim`/`nao` virando booleano e `"48"` virando 48, e nao o
 * corpo. E o que faz o formulario urlencoded e o JSON da cerimonia chegarem ao
 * mesmo hash: os dois passam por aqui com o mesmo mapa.
 *
 * O escopo e "os campos que esta gravacao esta aplicando", e nao "os campos que
 * mudaram": §12.2 diz que o `op_hash` cobre o **conteudo inteiro**, e e o que
 * faz mexer num campo escondido da tela de conferencia mudar o hash e a
 * gravacao ser recusada. Cobrir so o diff deixaria os campos escondidos que
 * "nao mudaram" livres para serem trocados depois da digital.
 *
 * E "aplicando" e mais que "enviando" (Ruling 86): o que o HANDLER traduziu
 * entra aqui junto com o que o corpo carregou. Um campo que o handler produz
 * `acao=ligar` virando `enabled: true`, e mostrado na tela de conferencia,
 * entao ele tem de ser coberto pela assinatura, senao trocar a operacao entre
 * os dois POSTs mudaria o efeito com o `oh` do envelope ainda valido.
 */
export function mudancaDeConfig(patch: PatchDeEstado, alvo?: string): MudancaCanonica {
  const campos = patch as Readonly<Record<string, ValorCanonico>>
  return alvo === undefined ? { acao: 'config', campos } : { acao: 'config', alvo, campos }
}

// ---------------------------------------------------------------------------
// Passo 2: POST /painel/api/stepup/opcoes
// ---------------------------------------------------------------------------

/**
 * As operacoes que a cerimonia aceita HOJE.
 *
 * Ate a Etapa 12 era so `config`, porque so ela tinha rota de escrita capaz de
 * consumir o envelope: emitir envelope para uma operacao que ninguem sabe
 * verificar seria codigo sem tela (§13.1). A Etapa 13 deu consumidor as outras
 * tres, `adicionar_passkey` em `POST /painel/api/registrar/opcoes` no modo
 * `sessao` (§10.4 passo 1, §10.13) e `remover_passkey` e `gerar_codigos` em
 * `POST /painel/aparelhos`, e por isso elas entram AGORA e nao antes.
 *
 * A lista continua sendo a trava: uma quinta acao so passa a valer aqui depois
 * que existir a rota que recalcula o `op_hash` dela do proprio corpo recebido.
 */
const OPERACOES_ACEITAS: readonly AcaoDeMudanca[] = [
  'config',
  'adicionar_passkey',
  'remover_passkey',
  'gerar_codigos',
]

/**
 * O `Max-Age` do cookie de step-up, DERIVADO do prazo do envelope.
 *
 * Mesmo raciocinio do cookie de desafio do login: escrever `120` aqui seria a
 * segunda grafia de um numero so, e a falha seria silenciosa, o cookie
 * morreria antes do envelope e o step-up passaria a falhar sem nenhum teste
 * reclamar.
 */
const SEGUNDOS_DO_STEPUP = Math.floor(PRAZO_DE_ENVELOPE_MS.stepup / 1000)

/**
 * A forma do corpo da cerimonia: `{ operacao, mudanca }` (§10.10, passo 2).
 *
 * `operacao` e **so roteamento** e precisa ser igual a `mudanca.acao`, as duas
 * grafias existem porque o corpo veio de fora, e um corpo que dissesse
 * `operacao: "config"` com `acao: "remover_passkey"` estaria pedindo um
 * envelope com uma assinatura que nao e a da operacao anunciada.
 */
function lerPedidoDaCerimonia(corpo: unknown): MudancaCanonica | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const { operacao, mudanca } = corpo as { operacao?: unknown; mudanca?: unknown }

  if (typeof mudanca !== 'object' || mudanca === null || Array.isArray(mudanca)) return null
  const lida = mudanca as Record<string, unknown>

  const acao = lida.acao
  if (typeof acao !== 'string' || !(OPERACOES_ACEITAS as readonly string[]).includes(acao)) {
    return null
  }
  if (operacao !== acao) return null

  // **O `alvo` e lido a parte, e so como STRING** (Ruling 90, mantido pelo 96).
  // `comoValorCanonico` aceita numero inteiro, e um `alvo` numerico e o caminho
  // que a migration `0002` descreve: acima de 2^53 o `JSON.parse` corrompe o id
  // e casa o Reel errado, sem erro nenhum. Um envelope emitido sobre um id
  // corrompido assinaria a mudanca de outro Reel, entao aqui ele e recusado.
  const alvo = lida.alvo
  if (alvo !== undefined && typeof alvo !== 'string') return null

  const campos = camposDaCerimonia(lida)
  if (campos === null) return null

  return alvo === undefined
    ? { acao: acao as AcaoDeMudanca, campos }
    : { acao: acao as AcaoDeMudanca, alvo, campos }
}

/**
 * Os campos do corpo da cerimonia na forma canonica, ou `null`.
 *
 * Extraida de `lerPedidoDaCerimonia` para caber no teto de complexidade do
 * Biome depois do `alvo` do Ruling 96. `acao` e `alvo` ficam de fora porque os
 * dois tem leitura propria acima.
 */
function camposDaCerimonia(lida: Record<string, unknown>): Record<string, ValorCanonico> | null {
  const campos: Record<string, ValorCanonico> = {}
  for (const [nome, valor] of Object.entries(lida)) {
    if (nome === 'acao' || nome === 'alvo') continue
    const canonico = comoValorCanonico(valor)
    if (canonico === null) return null
    campos[nome] = canonico
  }
  return campos
}

/** Um valor do corpo que cabe na forma canonica, ou `null`. */
function comoValorCanonico(valor: unknown): ValorCanonico | null {
  if (typeof valor === 'string' || typeof valor === 'boolean') return valor
  if (typeof valor === 'number') return Number.isInteger(valor) ? valor : null
  if (Array.isArray(valor) && valor.every((item) => typeof item === 'string')) {
    return valor as readonly string[]
  }
  return null
}

/**
 * `POST /painel/api/stepup/opcoes` (§7.1, §10.10 passo 2). **Zero consulta ao
 * D1** alem da linha de sessao que a escada ja leu.
 *
 * Sorteia 32 bytes, calcula o `op_hash` da mudanca recebida e assina um
 * envelope de proposito `stepup` que carrega os tres: o desafio, o `op_hash` e
 * o `sid_hash` da sessao. Os dois ultimos sao o desenho inteiro, sem o `sid`,
 * um envelope roubado serve em outra sessao; sem o `oh`, a autorizacao vira
 * "modo privilegiado por 120 s".
 *
 * **Que a mudanca chegue do cliente aqui nao autoriza nada**, e essa e a parte
 * que confunde: este `op_hash` e um COMPROMISSO, e nao uma permissao. Quem
 * decide e a rota de escrita, que recalcula o hash do corpo que ela mesma
 * recebeu e compara com o que este envelope assinou. Um cliente que mentir aqui
 * so consegue um envelope que nao vai fechar com nada.
 */
export async function handleOpcoesDeStepUp(entrada: EntradaDaRota): Promise<Response> {
  const { env, now, contexto, corpo, sessao } = entrada

  // Os dois casos sao INALCANCAVEIS pela tabela de rotas, a linha declara
  // `sessao: true` e a familia `/painel/api/*`, e ainda assim cada um responde
  // o codigo que §11.4 escreve para ele: sessao ausente nao e corpo invalido, e
  // a tabela canonica nao admite aproximacao.
  if (sessao === null) return erro('sessao_ausente', contexto)
  if (corpo.familia !== 'json') return erro('corpo_invalido', contexto)

  const mudanca = lerPedidoDaCerimonia(corpo.dados)
  if (mudanca === null) {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'mudanca_invalida' })
  }

  const desafio = sortearDesafio()
  const envelope = await emitirEnvelope(
    env,
    'stepup',
    { c: desafio, oh: await opHash(mudanca), sid: sessao.sidHash },
    now,
  )

  return json(opcoesDeStepUp({ rpId: env.PANEL_RP_ID, desafio }), {
    extras: { 'set-cookie': cookieDoPainel(COOKIE_DE_STEPUP, envelope, SEGUNDOS_DO_STEPUP) },
  })
}

/** O `Set-Cookie` que APAGA o cookie de step-up. `Max-Age=0` (§10.10, passo 4). */
export function cookieDeStepUpExpirado(): string {
  return cookieDoPainel(COOKIE_DE_STEPUP, '', 0)
}

// ---------------------------------------------------------------------------
// Passo 4: a verificacao, dentro da rota de escrita
// ---------------------------------------------------------------------------

/** Tudo o que o passo 8 da escada de §11.3 precisa saber. */
export interface PedidoDeStepUp {
  readonly request: Request
  readonly env: Env
  readonly now: number
  /** O `sha256(sid)` da sessao de AGORA. O envelope tem de apontar para ela. */
  readonly sidHash: string
  /** O conteudo cru do campo escondido `digital`, como o formulario o mandou. */
  readonly digital: string
  /**
   * O `op_hash` que o SERVIDOR acabou de recalcular do corpo recebido.
   *
   * Ele entra por PARAMETRO, e essa e a metade que faz a trava valer: quem sabe
   * transformar o corpo daquela rota na mudanca canonica e o funil de gravacao,
   * e um `op_hash` que chegasse pelo corpo autorizaria qualquer coisa.
   */
  readonly opHashDeAgora: string
}

/**
 * O veredito do passo 8.
 *
 * `motivo` e um codigo curto de vocabulario fechado, em snake_case: ele vai
 * para o `console` e para `motivoInterno`, **nunca** para o corpo. A frase ao
 * cliente e sempre a mesma de §11.4, separar os casos daria a um painel
 * invadido um oraculo para descobrir qual metade da trava ainda falta quebrar.
 */
export type VereditoDeStepUp =
  | { readonly ok: true; readonly credentialId: string }
  | { readonly ok: false; readonly motivo: string }

/**
 * O passo 4 de §10.10, na ordem dele, do que custa zero ao que custa uma
 * leitura:
 *
 *   1. o cookie existe                                              (0 D1)
 *   2. envelope de proposito `stepup`, assinatura fechada, 120 s    (0 D1)
 *   3. o `sid` do envelope e o da sessao de AGORA                   (0 D1)
 *   4. o `op_hash` do envelope e o que o servidor RECALCULOU        (0 D1)
 *   5. a forma da assertion                                         (0 D1)
 *   6. a credencial e o dono                                   (1 leitura)
 *   7. `verificarAssertion`, a lista inteira de §10.7, `UV` incluso (0 D1)
 *
 * Os passos 3 e 4 sao o desenho inteiro. Sem o 3, um envelope roubado serve em
 * outra sessao; sem o 4, um step-up feito para trocar uma palavra autoriza
 * trocar o link, que e exatamente o que a janela de 5 minutos permitiria a um
 * XSS, e o motivo de ela nao existir.
 *
 * **Uma verificacao, um lugar.** Ela nao mora tambem no roteador: o roteador
 * nao sabe transformar o corpo de cada rota na mudanca canonica, e uma segunda
 * grafia da trava seria a que alguem chamaria sozinha.
 */
export async function exigirStepUp(pedido: PedidoDeStepUp): Promise<VereditoDeStepUp> {
  const { request, env, now, sidHash, digital, opHashDeAgora } = pedido

  const cookie = lerCookie(request, COOKIE_DE_STEPUP)
  if (cookie === null) return { ok: false, motivo: 'envelope_ausente' }

  // O prazo de 120 s mora no proprio envelope (`PRAZO_DE_ENVELOPE_MS.stepup`) e
  // e conferido aqui dentro: "fora dos 120 s bloqueia" nao e uma comparacao a
  // parte, e a mesma que recusa um envelope forjado.
  const leitura = await lerEnvelope(env, 'stepup', cookie, now)
  if (!leitura.valido) return { ok: false, motivo: `envelope_${leitura.motivo}` }

  const { c: desafio, oh: hashDoEnvelope, sid: sidDoEnvelope } = leitura.claims
  if (sidDoEnvelope === undefined || !timingSafeEqual(sidDoEnvelope, sidHash)) {
    return { ok: false, motivo: 'sessao_diferente' }
  }
  if (hashDoEnvelope === undefined || !timingSafeEqual(hashDoEnvelope, opHashDeAgora)) {
    return { ok: false, motivo: 'conteudo_diferente' }
  }
  if (desafio === undefined || desafio === '') return { ok: false, motivo: 'desafio_ausente' }

  const assertion = lerRespostaDeAssertion(lerJson(digital))
  if (assertion === null) return { ok: false, motivo: 'digital_malformada' }

  const dono = await new PainelCredenciaisRepository(env.DB).buscarParaLogin(assertion.id)
  if (dono === null) return { ok: false, motivo: 'sem_dono' }

  const resultado = await verificarAssertion({
    resposta: assertion,
    rpId: env.PANEL_RP_ID,
    origem: origemDoPainel(env),
    // O desafio vem do ENVELOPE, nunca do corpo: um desafio escolhido por quem
    // responde faria a cerimonia inteira perder o sentido.
    desafioEsperado: desafio,
    credencial: dono.credencial,
    usuarioHandleEsperado: dono.handleDoDono,
  })

  if (!resultado.ok) return { ok: false, motivo: resultado.motivo }
  return { ok: true, credentialId: resultado.assertion.credentialId }
}

/** `JSON.parse` que nunca lanca: o campo escondido veio de fora. */
function lerJson(bruto: string): unknown {
  try {
    return JSON.parse(bruto) as unknown
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Passo 1: a tela "Confira o que vai mudar" (§12.2, §12.3)
// ---------------------------------------------------------------------------

/** O que muda de uma tela de conferencia para outra. */
export interface PedidoDeConferencia {
  /** Os campos que mudaram, em ordem. Cada um vira uma linha antes/depois. */
  readonly mudados: readonly CampoDaConfig[]
  readonly antes: EstadoDeComportamento
  readonly depois: EstadoDeComportamento
  /** O corpo recebido, CRU: e ele que volta em campos escondidos. */
  readonly campos: URLSearchParams
  /** Os nomes de campo que o funil trata como estruturais e nao reemite. */
  readonly excluir: readonly string[]
  readonly ficha: string
  readonly versao: number
  /** O caminho do POST, a ROTA que recebeu o formulario. */
  readonly paraOPost: string
  /** A tela de origem, para onde o Cancelar volta (com o `?midia=` do Reel). */
  readonly voltar: string
  /**
   * A legenda do Reel, quando a mudanca e sobre um Reel e ele tem legenda. A
   * tela mostra a legenda para a pessoa reconhecer o Reel; o numero continua ao
   * lado, pequeno, porque e ele que entra na assinatura.
   */
  readonly legendaDoAlvo?: string
  /** A mudanca canonica, que o `painel.js` manda para a cerimonia. */
  readonly mudanca: MudancaCanonica
  /**
   * Quantas mudancas este UM toque confirma.
   *
   * §15.4 quer que a pessoa saiba, antes do gesto, que o toque cobre mais do que
   * o campo que ela editou. A primeira grafia disto era um booleano
   * (`cobreATelaInteira`) e a frase dizia "os **tres** campos desta tela",
   * verdadeira em `/painel/mensagem` e **falsa** em `/painel/ajustes` com um
   * unico cooldown baixado, que e onde ela tambem aparecia. Contar e dizer o
   * numero e a unica versao que nao mente em tela nenhuma, e a frase so sai
   * quando ha mais de uma mudanca, com uma so, nao ha o que avisar.
   */
  readonly mudancasNoToque: number
}

/**
 * A tela intermediaria de §12.2: o antes e o depois lado a lado, em portugues.
 *
 * Ela existe por dois motivos. Para a pessoa, e a ultima chance de ler o que vai
 * assinar, e §10.10 e literal: "se o humano nao leu o que assinou, a amarracao
 * ao conteudo nao vale nada". Para a arquitetura, e onde o rascunho vive **sem
 * ser gravado**: em campos escondidos, em texto comum, sem assinatura propria,
 * porque o `op_hash` dentro do cookie ja cobre o conteudo inteiro e o servidor o
 * recalcula do corpo recebido. Mexer num campo escondido muda o hash e a
 * gravacao e recusada.
 *
 * **Cancelar nao grava nada**, e o rascunho continua na tela.
 *
 * A mudanca canonica viaja num atributo `data-`, e nao num campo escondido: ela
 * e insumo do `painel.js`, nao do POST. Num campo escondido ela voltaria no
 * corpo, e o funil a recusaria como campo desconhecido, ou, pior, alguem a
 * declararia estrutural e ela viraria um segundo lugar de onde a mudanca poderia
 * vir.
 */
export function telaDeConferencia(pedido: PedidoDeConferencia): HtmlSeguro {
  const excluidos = new Set(pedido.excluir)
  const escondidos = [...pedido.campos]
    .filter(([nome]) => !excluidos.has(nome))
    .map(([nome, valor]) => html`<input type="hidden" name="${nome}" value="${valor}">`)

  const linhas = pedido.mudados.map(
    (campo) => html`<li class="campo-protegido">
<p class="rotulo">${NOME_DO_CAMPO[campo]}</p>
<p class="antes"><span class="etiqueta">Hoje:</span> ${valorNaTela(campo, pedido.antes[campo])}</p>
<p class="depois"><span class="etiqueta">Vai ficar:</span> ${valorNaTela(
      campo,
      pedido.depois[campo],
    )}</p>
</li>`,
  )

  return html`<section class="conferencia">
${
  // §10.10, literal: "a tela **tem que** mostrar o valor literal antes da
  // biometria. Se o humano nao leu o que assinou, a amarracao ao conteudo nao
  // vale nada." Ate o Ruling 96 a tela dizia "Intervalo por pessoa: 48 -> 24" e
  // ficava nisso, a mudanca era a mesma para qualquer Reel, e o dono nao tinha
  // como saber em qual delas encostava o dedo.
  //
  // O que a tela escreve e o proprio `media_id`, e nao a legenda: e ELE que
  // entra na assinatura, e mostrar um rotulo bonito ao lado de um hash sobre
  // outro valor seria a mesma mentira em outra forma. O id nao e segredo, ele
  // aparece no permalink publico do Reel.
  pedido.mudanca.alvo === undefined
    ? null
    : html`<p class="alvo-da-mudanca">${TELA_DOS_REELS.soNesteReel} ${
        pedido.legendaDoAlvo === undefined || pedido.legendaDoAlvo === ''
          ? null
          : html`<strong>${pedido.legendaDoAlvo}</strong> `
      }<small>(n&ordm; <code>${pedido.mudanca.alvo}</code>)</small></p>`
}
<ul class="mudancas">${linhas}</ul>
${
  pedido.mudancasNoToque > 1
    ? html`<p>Um toque s&oacute; confirma <strong>as ${String(
        pedido.mudancasNoToque,
      )} mudan&ccedil;as acima de uma vez</strong>. Se voc&ecirc; s&oacute; queria mudar uma delas,
cancele e volte.</p>`
    : null
}
<p>Cada mudan&ccedil;a protegida &eacute; confirmada uma vez. &Eacute; por isso que &eacute; seguro.</p>
<form method="post" action="${pedido.paraOPost}" id="confirmar"
data-mudanca="${jsonCanonico(pedido.mudanca)}">
<input type="hidden" name="${CAMPO_DA_FICHA}" value="${pedido.ficha}">
<input type="hidden" name="${CAMPO_DA_VERSAO}" value="${String(pedido.versao)}">
<input type="hidden" name="${CAMPO_DA_DIGITAL}" value="">
${escondidos}
<button type="submit">Confirmar com a digital</button>
</form>
<p><a class="acao" href="${pedido.voltar}" data-voltar="">Cancelar</a></p>
<p>Cancelar n&atilde;o salva nada.</p>
</section>`
}

// ---------------------------------------------------------------------------
// A classificacao de risco por campo (§10.10)
// ---------------------------------------------------------------------------

/** Os tres campos que exigem step-up SEMPRE, em qualquer direcao (§10.10). */
const CAMPOS_SEMPRE_PROTEGIDOS: readonly CampoDaConfig[] = [
  'destinationUrl',
  'privateReplyText',
  'publicReplyText',
]

/**
 * A mudanca daquele campo ALARGA o envelope de alcance? (§10.10)
 *
 * A enumeracao e fechada e vem da spec, palavra por palavra: `matchMode` para
 * `contains`, cooldown ABAIXO do atual, `mediaScope` para `'todas'`,
 * `processOnlyReels` para `false`. Tudo o mais e estreitar, e estreitar nunca
 * pede a digital, que e a promessa escrita no rodape dos Ajustes (§12.3).
 *
 * **`enabled` nao esta aqui, e a ausencia e a decisao de §10.10**: religar a
 * automacao parece alargamento e nao e, porque nao muda nenhum valor, apenas
 * devolve a chave ao estado anterior, que o dono ja autorizou quando gravou
 * aqueles campos. Exigir biometria aqui puniria justamente quem acabou de usar
 * o freio de emergencia, e a parada de emergencia depende de desligar ser
 * barato nas duas direcoes.
 */
function alargaOAlcance(
  campo: CampoDaConfig,
  antes: EstadoDeComportamento,
  depois: EstadoDeComportamento,
): boolean {
  if (campo === 'matchMode') return depois.matchMode === 'contains'
  if (campo === 'userCooldownHours') return depois.userCooldownHours < antes.userCooldownHours
  if (campo === 'mediaScope') return depois.mediaScope === 'todas'
  if (campo === 'processOnlyReels') return depois.processOnlyReels === false
  return false
}

/**
 * Os campos do lote que exigem step-up. Um so ja tranca o lote inteiro.
 *
 * **Exportada para ser afirmada DIRETO** (Ruling 77). Ate esta rodada a tabela
 * de §10.10 so era alcancavel por rota, e foi por isso que mover a recusa de
 * escopo para antes da cerimonia (Ruling 73) a esvaziou sem ninguem perceber:
 * seis das sete entradas passaram a ser recusadas por escopo, e a suite
 * continuou verde afirmando `403` que ja nao vinha daqui. Um teste sobre a
 * funcao e estritamente mais forte que a versao por HTTP, cobre `mediaScope`,
 * que nao tem rota dona ate a Task 13, e imune a mudanca de escopo de rota.
 *
 * Continua sendo chamada de UM lugar so em producao: o funil, por
 * `passarPeloStepUp`, logo abaixo.
 */
export function camposProtegidos(
  mudados: readonly CampoDaConfig[],
  antes: EstadoDeComportamento,
  depois: EstadoDeComportamento,
): readonly CampoDaConfig[] {
  return mudados.filter(
    (campo) => CAMPOS_SEMPRE_PROTEGIDOS.includes(campo) || alargaOAlcance(campo, antes, depois),
  )
}

// ---------------------------------------------------------------------------
// O passo 8 da escada de §11.3, visto do funil de gravacao
// ---------------------------------------------------------------------------

/** Tudo o que o passo 8 precisa do funil. */
export interface PassagemDeStepUp {
  readonly entrada: EntradaDaRota
  readonly sessao: LinhaDeSessao
  readonly recusa: RecusaAuditada
  /** O corpo recebido, CRU: e ele que volta na tela de conferencia. */
  readonly campos: URLSearchParams
  /**
   * A mudanca INTEIRA que este POST aplica, ja lida campo a campo: o patch do
   * corpo mais o que o handler traduziu. E dela que sai o `op_hash`.
   *
   * **O funil monta UM objeto e o usa nos dois lugares**, o `depois` que a tela
   * mostra e este, porque separa-los era o defeito do Ruling 86: um campo
   * produzido pelo handler aparecia na conferencia sem entrar na assinatura.
   */
  readonly patch: PatchDeEstado
  readonly estruturais: readonly string[]
  readonly mudados: readonly CampoDaConfig[]
  readonly antes: EstadoDeComportamento
  readonly depois: EstadoDeComportamento
  readonly versaoEnviada: number
  /**
   * O `media_id` quando a gravacao e sobre UM Reel (Ruling 96).
   *
   * Ele entra na mudanca ASSINADA **e** e nomeado na tela de conferencia: as
   * duas metades sao a mesma exigencia de §10.10, "se o humano nao leu o que
   * assinou, a amarracao ao conteudo nao vale nada".
   */
  readonly alvo?: string
  /** A tela de origem, para o Cancelar da tela de conferencia. */
  readonly voltar: string
  /** A legenda do Reel do `alvo`, quando ha uma. */
  readonly legendaDoAlvo?: string
}

/**
 * Ou a recusa pronta, ou a credencial que confirmou a mudanca.
 *
 * `credentialId: null` e o lote que NAO exige step-up: nenhum campo protegido
 * mudou, e a gravacao segue sem cerimonia nenhuma. Ele e um desfecho de sucesso
 * como o outro, e nao um caso a parte, para que o funil tenha UM ponto de saida
 * do passo 8 em vez de dois.
 */
export type ResultadoDaPassagem =
  | { readonly resposta: Response }
  | { readonly credentialId: string | null }

/**
 * O passo 8 inteiro: classifica o lote e, quando ele exige, exerce a cerimonia.
 *
 * Sem digital, a tela de conferencia; com digital valida e presa ao `op_hash`, a
 * passagem. §10.10 e explicito: se **qualquer** campo do lote exige step-up, o
 * lote inteiro exige, e gravacao parcial e impossivel, por isso quem classifica
 * e quem verifica sao a mesma chamada, e nao duas que alguem possa desencontrar.
 *
 * **Os dois desfechos de recusa sao o MESMO `403 step_up_necessario` com a
 * MESMA linha de auditoria** (`acao: 'stepup_recusado'`, `antes = depois =
 * NULL`), porque §10.10 os trata junto: "uma tentativa de gravacao recusada por
 * step-up **ausente ou invalido** tambem gera linha de auditoria". O que os
 * separa e uma coisa so, e ela nao aparece na resposta: a falha INVALIDA
 * incrementa `falhas_stepup`, e a AUSENTE nao. Ausente e o primeiro envio, o
 * caminho normal de quem apertou Salvar, se ele contasse, dez gravacoes
 * protegidas seguidas derrubariam a sessao de quem esta usando o painel certo.
 */
export async function passarPeloStepUp(passagem: PassagemDeStepUp): Promise<ResultadoDaPassagem> {
  const { entrada, sessao, recusa, campos, mudados, versaoEnviada } = passagem
  const { env, now } = entrada

  const protegidos = camposProtegidos(mudados, passagem.antes, passagem.depois)
  if (protegidos.length === 0) return { credentialId: null }

  // A mudanca canonica sai do PEDACO DE ESTADO que este corpo carregou, o
  // mesmo mapa que o JSON da cerimonia produz, e o `op_hash` e recalculado
  // AQUI, no servidor, a cada requisicao. Um hash vindo do cliente autorizaria
  // qualquer coisa.
  const mudanca = mudancaDeConfig(passagem.patch, passagem.alvo)
  const opHashDeAgora = await opHash(mudanca)
  const ficha = await fichaCsrf(env, sessao.sidHash)

  const explicacao = (): HtmlSeguro =>
    html`<p>${RECUSA_SEM_VALOR.protegido}</p>${telaDeConferencia({
      mudados,
      antes: passagem.antes,
      depois: passagem.depois,
      campos,
      excluir: passagem.estruturais,
      ficha,
      // A versao ENVIADA, e nao a de agora: e ela que a pessoa esta
      // confirmando, e reemitir a de agora transformaria a trava otimista num
      // carimbo automatico no unico formulario que pede biometria.
      versao: versaoEnviada,
      paraOPost: entrada.rota.caminho,
      voltar: passagem.voltar,
      ...(passagem.legendaDoAlvo === undefined ? {} : { legendaDoAlvo: passagem.legendaDoAlvo }),
      mudanca,
      mudancasNoToque: mudados.length,
    })}`

  const recusar = async (motivoInterno: string, extras: readonly D1PreparedStatement[]) => ({
    resposta: await recusa.registrar({
      acao: 'stepup_recusado' as const,
      campos: protegidos,
      codigo: 'step_up_necessario' as const,
      motivoInterno,
      comScript: true,
      extras,
      explicacao: explicacao(),
    }),
  })

  const digital = campos.get(CAMPO_DA_DIGITAL) ?? ''
  if (digital === '') return await recusar('step_up_ausente', [])

  const veredito = await exigirStepUp({
    request: entrada.request,
    env,
    now,
    sidHash: sessao.sidHash,
    digital,
    opHashDeAgora,
  })

  if (veredito.ok) return { credentialId: veredito.credentialId }

  // §10.10: falha de step-up incrementa `falhas_stepup`, e na DECIMA a sessao e
  // apagada. A escrita entra no MESMO lote da linha de auditoria da recusa, a
  // recusa ja custava uma escrita (Ruling 59), e esta nao acrescenta uma ida ao
  // banco nem sobrevive sem a linha que a explica.
  const sessoes = new PainelSessoesRepository(env.DB)
  const decima = sessao.falhasStepup + 1 >= FALHAS_DE_STEPUP_ATE_APAGAR

  return await recusar(veredito.motivo, [
    decima
      ? sessoes.statementDeApagar(sessao.sidHash)
      : sessoes.statementDeFalhaDeStepup(sessao.sidHash),
  ])
}
