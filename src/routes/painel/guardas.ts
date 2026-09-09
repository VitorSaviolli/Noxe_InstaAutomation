/**
 * As guardas do painel: o limitador de taxa, a origem, o teto de corpo, o
 * portao de sessao e a ficha anti-CSRF — os passos 2, 4, 5, 6, 7 e 9 da escada
 * de §11.3. O passo 8, o step-up, mora em `stepup.ts`: ele precisa da mudanca
 * canonica de §10.10, que nao e assunto de nenhuma guarda.
 *
 * **Os NOMES saem daqui e moram em `campos.ts`** — os tres cookies de §7.2, os
 * cinco campos escondidos e o par que escreve e le um cookie. Este arquivo
 * DECIDE quem passa; aquele so diz como as coisas se chamam, e a diferenca e o
 * que deixa o funil de gravacao e as telas importarem um nome sem arrastar
 * junto o limitador de taxa.
 *
 * **O limitador e uma camada OPCIONAL, e essa e a afirmacao mais importante
 * deste arquivo.** Ausentes os tres bindings, o painel funciona sem a camada e
 * continua correto — nada do desenho pode depender deles (§7.4). O ambiente de
 * teste segue sem os bindings de proposito, e e essa ausencia que transforma a
 * frase acima em prova.
 *
 * **Por que TRES bindings e nao um** (§7.4): na Cloudflare o `limit` e fixo por
 * binding e o `period` so aceita 10 ou 60 `[C]` — a chave do balde nao consegue
 * expressar tetos diferentes. Um binding so obrigaria login e parada de
 * emergencia a dividir o mesmo teto, e o prefixo distinto de cada chave e o
 * que impede que o balde de um consuma a cota do outro.
 *
 * **O que este limitador NAO promete:** segurar um atacante real. O contador da
 * Cloudflare e por data center e eventualmente consistente `[C]`, entao um
 * atacante distribuido multiplica qualquer teto por trezentos. A defesa dos
 * codigos sao os bits de entropia deles (§10.11, §10.12), nunca esta camada.
 *
 * **A UNICA rota que mora aqui e `POST /painel/sair`**, e ela mora aqui porque
 * e a metade contraria do passo 9: `exigirSessaoViva` afirma que a linha e a
 * autoridade, e `handleSair` e quem apaga a linha. As duas leem e escrevem a
 * mesma coluna e o mesmo prazo — separa-las em dois arquivos seria a receita
 * para uma mudar sem a outra.
 */
import { PainelAuditoriaRepository } from '../../repositories/painel-auditoria-repository'
import {
  type LinhaDeSessao,
  PainelSessoesRepository,
} from '../../repositories/painel-sessoes-repository'
import { timingSafeEqual } from '../../security/constant-time'
import {
  fichaCsrf,
  origemDoPainel,
  PRAZO_OCIOSO_DE_SESSAO_MS,
  validarSessao,
} from '../../services/panel-session'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import {
  CABECALHO_DA_FICHA,
  CAMPO_DA_FICHA,
  COOKIE_DA_SESSAO,
  cookieDoPainel,
  lerCookie,
} from './campos'
import type { CodigoDeConfirmacao } from './dicionario'
import { type ContextoDoErro, erro, redirecionar } from './resposta'
import type { EntradaDaRota } from './router'

// ---------------------------------------------------------------------------
// A porta
// ---------------------------------------------------------------------------

/** As tres familias de rota, uma por binding (§7.4). */
export type FamiliaDeLimite = 'login' | 'codigo' | 'parada'

/** O que o limitador responde. Nunca lanca. */
export interface Veredito {
  /** `false` vira `429 muitas_tentativas` na rota. */
  readonly permitido: boolean
  /** Quanto esperar, em segundos. Vira o cabecalho `Retry-After`. */
  readonly esperarSegundos: number
}

/**
 * A porta, com tres implementacoes: `LimitadorDeBinding` (o contador da
 * Cloudflare), `LimitadorDeReserva` (janela por isolate, para quando o binding
 * nao existe) e o duble injetado que vive em `tests/fixtures/dubles.ts`.
 */
export interface Limitador {
  /** Consome uma tentativa do balde `chave`. */
  permitir(chave: string, agora: number): Promise<Veredito>
  /** Devolve o balde `chave` ao estado inicial. */
  zerar(chave: string): void
}

/** A janela. `period` na Cloudflare so aceita 10 ou 60 `[C]`. */
export const JANELA_EM_SEGUNDOS = 60

const JANELA_EM_MILISSEGUNDOS = JANELA_EM_SEGUNDOS * 1000

/**
 * Teto de cada familia, copiado de §7.4.
 *
 * Trava de RL-09: a parada tem limite proprio, e ele e maior que o do login.
 * Igualar estes numeros nao quebraria nenhuma outra garantia — quebraria esta.
 *
 * A parada e o codigo de recuperacao tem teto **mais generoso** que o login de
 * proposito: os dois sao caminho de emergencia, e um bot martelando a tela de
 * entrar nao pode consumir a cota de que o dono precisa quando algo ja deu
 * errado. A troca embutida no teto do codigo esta escrita como troca em §7.4.
 */
const TETO: Record<FamiliaDeLimite, number> = {
  login: 10,
  codigo: 30,
  parada: 30,
}

/**
 * Prefixo do balde de cada familia (§7.4).
 *
 * O prefixo distinto e o que impede que o balde do login e o da parada se
 * misturem mesmo quando as duas familias caem no mesmo limitador de reserva.
 */
const PREFIXO: Record<FamiliaDeLimite, string> = {
  login: 'painel:',
  codigo: 'codigo:',
  parada: 'parada:',
}

/** Binding de cada familia. Todos OPCIONAIS (§7.4). */
const BINDING = {
  login: 'PANEL_LIMITER_LOGIN',
  codigo: 'PANEL_LIMITER_CODIGO',
  parada: 'PANEL_LIMITER_STOP',
} as const satisfies Record<FamiliaDeLimite, keyof Env>

/**
 * Identificador usado quando a requisicao chega sem `CF-Connecting-IP`.
 *
 * Trava de RL-04: sem IP a requisicao cai no balde global daquela familia e
 * **continua limitada — nunca passa livre**. E o primeiro caminho que um
 * atacante tentaria, e o unico jeito de nao ter um balde por cliente e nao ter
 * balde nenhum.
 */
const SEM_IP = 'global'

const LIBERADO: Veredito = { permitido: true, esperarSegundos: 0 }

/**
 * A chave do balde, especificada em §7.4 porque ha teste que a afirma.
 *
 * Trava de RL-03, de RL-04 e de RL-10: o prefixo vem da familia da rota, o
 * resto e o IP que a Cloudflare carimba — e e o IP dentro da chave que faz
 * dois clientes diferentes nunca caem no mesmo balde. A ausencia do carimbo
 * cai no balde global daquela familia, e continua limitada.
 */
export function chaveDoBalde(familia: FamiliaDeLimite, request: Request): string {
  const carimbado = (request.headers.get('cf-connecting-ip') ?? '').trim()
  return PREFIXO[familia] + (carimbado === '' ? SEM_IP : carimbado)
}

// ---------------------------------------------------------------------------
// Implementacao 1: a janela por isolate
// ---------------------------------------------------------------------------

/** Um balde: quando a janela abriu e quantas tentativas ela ja viu. */
interface Balde {
  readonly abertoEm: number
  readonly contagem: number
}

/**
 * Teto de baldes guardados por isolate.
 *
 * Sem ele, um atacante com muitos IPs faria a memoria do isolate crescer sem
 * limite — trocar um limitador por um vazamento de memoria seria um negocio
 * pessimo. Ao estourar, os baldes vencidos saem primeiro e, se ainda faltar
 * espaco, sai o **menos recentemente tocado**.
 *
 * **Por que menos-recentemente-tocado e nao ordem de insercao.** Despejar por
 * ordem de insercao poe justamente o balde do atacante na frente da fila: ele
 * e o mais antigo por construcao, porque ele estourou o teto ANTES de comecar
 * a encher a memoria. Nesse desenho, 9.999 chaves — um `/64` de IPv6 da isso
 * de graca — zeravam o contador de quem o limitador existe para limitar. Com o
 * despejo por recencia o defeito se inverte: quem esta martelando toca o
 * proprio balde a cada tentativa e vira o ULTIMO a sair.
 *
 * Exportado porque o teste do despejo enche ate este numero: uma copia escrita
 * a mao la envelheceria em silencio no dia em que este valor mudasse.
 */
export const TETO_DE_BALDES = 10_000

/**
 * Janela fixa por isolate, para quando o binding nao existe (§13.4).
 *
 * Ela e melhor-esforco por construcao: vale so dentro de um isolate, e a
 * Cloudflare cria e descarta isolates o tempo todo. E exatamente por isso que
 * ela nao pode ser a defesa de nada — ela e a camada que continua limitando
 * quando o binding esta ausente (RL-06), e nada alem disso.
 *
 * **Divergencia declarada de §13.4:** a spec descreve esta implementacao como
 * "janela em memoria por isolate **mais Cache API**". A camada de Cache API
 * ficou de fora: ela e uma leitura-modificacao-escrita sem atomicidade (duas
 * requisicoes simultaneas leem a mesma contagem), sujeita as mesmas ressalvas
 * de consistencia que ja pesam sobre o contador da Cloudflare, nenhuma das dez
 * garantias RL depende dela, e ela acrescentaria uma ida e volta a rede na
 * frente do botao de panico — a rota que §10.12 chama de "a ultima que precisa
 * funcionar". Maquinario nao coberto por teste no caminho da emergencia e pior
 * que maquinario ausente.
 */
export class LimitadorDeReserva implements Limitador {
  /**
   * Um balde por chave (§7.4), e a ORDEM do `Map` e a ordem de recencia.
   *
   * Trava de RL-03: a chave e o que separa um cliente do outro — IPs
   * diferentes nunca compartilham contador porque nunca compartilham entrada.
   */
  private readonly baldes = new Map<string, Balde>()

  constructor(private readonly teto: number) {}

  async permitir(chave: string, agora: number): Promise<Veredito> {
    this.podar(agora)

    const balde = this.baldes.get(chave)
    if (balde === undefined || this.venceu(balde, agora)) {
      this.tocar(chave, { abertoEm: agora, contagem: 1 })
      return LIBERADO
    }

    const contagem = balde.contagem + 1
    this.tocar(chave, { abertoEm: balde.abertoEm, contagem })

    // Trava de RL-01: a tentativa seguinte ao teto dentro da janela e recusada,
    // e e este `>` que vira o `429 muitas_tentativas` la na rota.
    if (contagem > this.teto) {
      return { permitido: false, esperarSegundos: this.faltam(balde, agora) }
    }
    return LIBERADO
  }

  zerar(chave: string): void {
    this.baldes.delete(chave)
  }

  /** Esquece todos os baldes. Existe para o isolamento entre testes (§8.10). */
  esquecerTudo(): void {
    this.baldes.clear()
  }

  /** Quantos baldes o isolate guarda agora. Existe para o teste do despejo. */
  get baldesGuardados(): number {
    return this.baldes.size
  }

  /**
   * Trava de RL-02: relogio que anda PARA TRAS nao libera o balde.
   *
   * A subtracao negativa nunca passa da janela, entao um `agora` menor que o
   * `abertoEm` mantem o balde fechado em vez de abrir um novo. Um limitador
   * que confia num relogio que pode voltar e um limitador que se desliga
   * sozinho quando o relogio volta.
   */
  private venceu(balde: Balde, agora: number): boolean {
    return agora - balde.abertoEm >= JANELA_EM_MILISSEGUNDOS
  }

  /** Quanto falta para a janela virar, em segundos, sempre entre 1 e a janela. */
  private faltam(balde: Balde, agora: number): number {
    const restante = balde.abertoEm + JANELA_EM_MILISSEGUNDOS - agora
    return Math.min(JANELA_EM_SEGUNDOS, Math.max(1, Math.ceil(restante / 1000)))
  }

  /**
   * Grava o balde e o move para o FIM da ordem do `Map`.
   *
   * O `delete` antes do `set` nao e enfeite: um `set` numa chave que ja existe
   * mantem a posicao original, e sem a remocao a ordem do `Map` seria a de
   * INSERCAO, nunca a de recencia. E a ordem do `Map` e exatamente o que
   * `podar()` usa para escolher quem sai.
   */
  private tocar(chave: string, balde: Balde): void {
    this.baldes.delete(chave)
    this.baldes.set(chave, balde)
  }

  /**
   * Vencidos primeiro; se ainda estourar o teto, sai o menos recentemente
   * tocado — que e o primeiro da ordem do `Map`, mantida por `tocar()`.
   *
   * Quem esta martelando o painel toca o proprio balde a cada tentativa, entao
   * ele e o ultimo candidato ao despejo: encher a memoria do isolate deixou de
   * ser o jeito barato de zerar o proprio contador.
   */
  private podar(agora: number): void {
    if (this.baldes.size < TETO_DE_BALDES) return

    for (const [chave, balde] of this.baldes) {
      if (this.venceu(balde, agora)) this.baldes.delete(chave)
    }

    for (const chave of this.baldes.keys()) {
      if (this.baldes.size < TETO_DE_BALDES) break
      this.baldes.delete(chave)
    }
  }
}

// ---------------------------------------------------------------------------
// Implementacao 2: o contador da Cloudflare
// ---------------------------------------------------------------------------

/**
 * O adaptador do binding `ratelimits`.
 *
 * Trava de RL-06: uma excecao do binding cai no limitador de reserva, e nunca
 * abre o portao nem tranca a rota. As duas falhas opostas sao inaceitaveis por
 * motivos diferentes — abrir entregaria o login a um atacante que so precisa
 * derrubar o contador; trancar poria o limitador entre o dono e o freio dele,
 * na rota que existe justamente para o dia em que tudo o mais falhou.
 */
export class LimitadorDeBinding implements Limitador {
  /**
   * Se a queda do binding ja virou linha de log NESTA invocacao.
   *
   * Esta instancia nasce e morre dentro de uma invocacao, entao o campo limita
   * o log a UMA linha por invocacao, e nao uma por chamada: a escada de §11.3
   * pode consultar o limitador mais de uma vez, e a segunda linha nao
   * acrescentaria informacao nenhuma — so volume nos Workers Logs do dono,
   * pago por ele, no exato momento em que alguem esta martelando a rota.
   */
  private jaRegistrou = false

  constructor(
    private readonly binding: RateLimit,
    private readonly reserva: Limitador,
  ) {}

  async permitir(chave: string, agora: number): Promise<Veredito> {
    try {
      const { success } = await this.binding.limit({ key: chave })
      if (success) return LIBERADO
      return { permitido: false, esperarSegundos: JANELA_EM_SEGUNDOS }
    } catch (cause) {
      this.registrarQueda(cause)
      return this.reserva.permitir(chave, agora)
    }
  }

  /**
   * A queda do binding no log, uma vez so por invocacao.
   *
   * O codigo e `limitador_indisponivel`, e nao o `indisponivel` da tabela de
   * §11.4: aquele e o codigo do `503`, e esta rota nao responde `503` aqui —
   * ela cai no limitador de reserva e segue. Usar a mesma grafia para as duas
   * coisas faria o log dizer "o servico caiu" toda vez que uma camada
   * OPCIONAL falhou. A grafia nova sobe para a tabela de §11.4 na Task 16.
   *
   * Mesmo padrao do resto do painel: o codigo vai para o log, o valor nunca. A
   * chave carrega um IP e por isso nao entra na linha (§11.7).
   */
  private registrarQueda(cause: unknown): void {
    if (this.jaRegistrou) return
    this.jaRegistrou = true
    console.error(
      'painel:',
      'limitador_indisponivel',
      cause instanceof Error ? cause.message : cause,
    )
  }

  /**
   * O contador da Cloudflare nao expoe como zerar um balde `[C]`, entao o que
   * da para zerar e o de reserva. Escrito aqui em vez de silenciado: RL-08 vale
   * inteiro onde a reserva manda, e vale pela metade onde o binding manda.
   */
  zerar(chave: string): void {
    this.reserva.zerar(chave)
  }
}

// ---------------------------------------------------------------------------
// A escolha, e a funcao que as rotas chamam
// ---------------------------------------------------------------------------

/**
 * Um limitador de reserva por familia, vivo enquanto o isolate viver.
 *
 * Sao instancias de modulo porque um balde recriado a cada requisicao nao
 * conta nada. O preco e estado global entre testes, e o remedio e o mesmo do
 * cache de configuracao (§8.10): `invalidarBaldesDeReserva()` no `beforeEach`.
 */
const RESERVAS: Record<FamiliaDeLimite, LimitadorDeReserva> = {
  login: new LimitadorDeReserva(TETO.login),
  codigo: new LimitadorDeReserva(TETO.codigo),
  parada: new LimitadorDeReserva(TETO.parada),
}

/** Zera os baldes de reserva das tres familias. So o isolamento de teste usa. */
export function invalidarBaldesDeReserva(): void {
  for (const reserva of Object.values(RESERVAS)) reserva.esquecerTudo()
}

/**
 * O limitador desta familia de rota.
 *
 * Trava de RL-10: cada familia fala com o binding DELA e com mais nenhum. O
 * `typeof` na frente do `limit` nao e estilo — um binding nao cadastrado chega
 * como `undefined` em Workers, e a camada opcional viraria `TypeError`.
 */
export function limitadorDaFamilia(env: Env, familia: FamiliaDeLimite): Limitador {
  const reserva = RESERVAS[familia]
  const binding = env[BINDING[familia]]

  // Trava de RL-06: binding ausente NAO significa passar livre. A reserva
  // assume, e a rota continua limitada.
  if (binding === undefined || typeof binding.limit !== 'function') return reserva
  return new LimitadorDeBinding(binding, reserva)
}

/**
 * O passo 5 da escada de §11.3: consome uma tentativa e diz se ela passa.
 *
 * Custa ZERO consulta ao D1 — este arquivo nao importa repositorio nenhum, e e
 * assim que "tentativa recusada nao gasta cota de banco" (RL-05) deixa de ser
 * uma promessa e vira uma propriedade do codigo.
 */
export async function limitar(
  request: Request,
  env: Env,
  familia: FamiliaDeLimite,
  agora: number,
  injetado?: Limitador,
): Promise<Veredito> {
  const limitador = injetado ?? limitadorDaFamilia(env, familia)
  return limitador.permitir(chaveDoBalde(familia, request), agora)
}

// ---------------------------------------------------------------------------
// As duas guardas que nao custam D1 nenhum: origem e teto de corpo
// ---------------------------------------------------------------------------

/**
 * Passo 2 da escada de §11.3, e camada 2 das cinco de §10.9.
 *
 * `Origin` exato quando presente; na ausencia dele, `Sec-Fetch-Site:
 * same-origin`; os dois ausentes, recusa. O fallback e o que impede trancar o
 * dono para fora num navegador que nao mande `Origin` — deixou de ser
 * pendencia de projeto e virou esta funcao.
 *
 * Comparacao de string INTEIRA, nunca `includes` nem `startsWith`:
 * `https://exemplo.workers.dev.evil.com` passaria nos dois, e passaria
 * carregando o nome do painel dentro dele.
 */
export function origemConfere(request: Request, env: Env): boolean {
  const origem = request.headers.get('origin')
  if (origem !== null) return origem === origemDoPainel(env)

  return request.headers.get('sec-fetch-site') === 'same-origin'
}

/**
 * Passo 4 da escada de §11.3: le o corpo com teto. `null` quando estoura.
 *
 * Mora aqui porque e guarda, custa ZERO consulta ao D1 e vale para as tres
 * familias de §7.6 — 8 KB em `/painel/api/*`, 32 KB em formulario, 1 KB na
 * parada. O teto entra por parametro exatamente para que exista UMA
 * implementacao e tres numeros, e nao tres implementacoes.
 *
 * Dois portoes, e o segundo e que e o teto de verdade:
 *
 * 1. O `content-length`, quando vem, corta antes de ler um unico byte. Ele e
 *    barato, mas vem de quem chama e pode mentir para os dois lados — um teto
 *    que confia nele nao e teto.
 * 2. A leitura CORTA DURANTE o `ReadableStream`, pedaco a pedaco. Um POST
 *    `chunked` nao tem `content-length`, e `arrayBuffer()` sobre ele
 *    bufferizaria o corpo inteiro na memoria do isolate ANTES de qualquer
 *    conferencia: "capado em 8 KB" viraria "medido depois de aceitar tudo".
 *
 * Mede BYTES, e nao caracteres: `content-length` conta bytes, e recontar sobre
 * a string decodificada seria uma segunda conta, com outro resultado em
 * acentos.
 *
 * Nao lanca por conta propria — mas o stream lanca quando a conexao cai, e por
 * isso quem chama a mantem dentro do `try`.
 */
export async function lerCorpoCapado(request: Request, teto: number): Promise<string | null> {
  // WA-25, primeira metade: o `content-length` DECLARADO, conferido ANTES de
  // ler qualquer byte. So dispara quando o cabecalho existe e mente PARA CIMA
  // — por isso o teste que a prende sozinha tem de SETAR o cabecalho a mao
  // (`@cloudflare/vitest-pool-workers` nao o preenche por conta propria nem
  // para corpo string nem para `ReadableStream`; sem o valor manual, todo
  // corpo grande cai direto na segunda metade, e este `if` nunca dispara).
  const declarado = request.headers.get('content-length')
  if (declarado !== null) {
    const tamanho = Number.parseInt(declarado, 10)
    if (!Number.isFinite(tamanho) || tamanho > teto) return null
  }

  if (request.body === null) return ''

  const leitor = request.body.getReader()
  const pedacos: Uint8Array[] = []
  let lidos = 0

  while (true) {
    const { done, value } = await leitor.read()
    if (done) break

    lidos += value.byteLength
    if (lidos > teto) {
      // WA-25, segunda metade: este corte e o teto de verdade, e o teste que o
      // prende manda um `ReadableStream` SEM `content-length` — a unica forma
      // de fazer o portao de cima nao disparar antes. Sem ele, apagar estas
      // quatro linhas deixaria a suite inteira verde e "capado em 8 KB" viraria
      // "medido depois de aceitar tudo".
      //
      // O resto do corpo nao interessa e nao vai ocupar memoria nenhuma.
      await leitor.cancel().catch(() => undefined)
      return null
    }

    pedacos.push(value)
  }

  const bytes = new Uint8Array(lidos)
  let escritos = 0
  for (const pedaco of pedacos) {
    bytes.set(pedaco, escritos)
    escritos += pedaco.byteLength
  }

  return new TextDecoder().decode(bytes)
}

/**
 * Devolve o balde daquele cliente ao estado inicial.
 *
 * Trava de RL-08: quem prova quem e nao pode continuar pagando pelas tentativas
 * de quem nao provou. Chamado pelo login quando a assinatura fecha.
 */
export function zerarLimite(
  request: Request,
  env: Env,
  familia: FamiliaDeLimite,
  injetado?: Limitador,
): void {
  const limitador = injetado ?? limitadorDaFamilia(env, familia)
  limitador.zerar(chaveDoBalde(familia, request))
}

// ---------------------------------------------------------------------------
// Os passos 6, 7 e 2 da escada: sessao, ficha CSRF e origem
// ---------------------------------------------------------------------------

/**
 * O corpo ja lido, na forma da familia da rota.
 *
 * Quem le e o roteador, uma vez so: o `ReadableStream` de uma requisicao e
 * consumivel UMA vez, e um segundo leitor receberia corpo vazio. E tambem por
 * isso que a ficha CSRF de formulario e conferida a partir DESTE objeto, e nao
 * relendo a requisicao.
 */
export type CorpoDaRota =
  | { readonly familia: 'json'; readonly dados: unknown }
  | { readonly familia: 'formulario'; readonly campos: URLSearchParams }
  | { readonly familia: 'vazio' }

/** O corpo de uma requisicao sem corpo — `GET` e `HEAD`. */
export const CORPO_VAZIO: CorpoDaRota = { familia: 'vazio' }

/**
 * Passo 2 da escada, e camada 2 das cinco de §10.9.
 *
 * `origemConfere` e a pergunta; esta e a recusa de §11.4. Duas funcoes porque
 * sao duas coisas: o predicado nao conhece a tabela de erros, e o passo da
 * escada nao reimplementa a comparacao.
 *
 * **So em POST.** Uma navegacao `GET` vinda de fora — o link do painel colado
 * no WhatsApp — chega com `Sec-Fetch-Site: cross-site` e sem `Origin`, e §10.8
 * escreve o que acontece nela: o navegador nao manda o cookie e o dono cai em
 * `GET /painel/entrar`. Exigir origem no `GET` transformaria esse caso — que e
 * o caminho normal de quem abre o painel pela primeira vez no dia — num
 * `403 origem_invalida` sem saida.
 */
export function exigirOrigem(
  request: Request,
  env: Env,
  contexto: ContextoDoErro,
): Response | null {
  if (request.method !== 'POST') return null
  if (origemConfere(request, env)) return null
  return erro('origem_invalida', contexto)
}

/** O que o passo 6 devolve: o `sha256(sid)` daquele cookie, ou a recusa. */
export type PortaDeSessao =
  | { readonly sidHash: string; readonly expiraEm: number }
  | { readonly recusa: Response }

/**
 * Passo 6 da escada: cookie presente **e** HMAC valido. **ZERO consulta ao D1.**
 *
 * O HMAC e o filtro gratis de §10.8: um bot mandando cookies aleatorios e
 * recusado sem tocar na cota compartilhada com o webhook. A linha do banco — a
 * autoridade — e o passo 9, e mora em `exigirSessaoViva`.
 *
 * A recusa tem duas formas, e a diferenca importa: `401 sessao_ausente` em
 * JSON, porque quem chamou foi o `painel.js`; `303` para `/painel/entrar` numa
 * pagina, porque quem chegou foi uma pessoa com o navegador aberto (§11.3).
 */
export async function exigirSessao(
  request: Request,
  env: Env,
  now: number,
  contexto: ContextoDoErro,
): Promise<PortaDeSessao> {
  const cookie = lerCookie(request, COOKIE_DA_SESSAO)
  if (cookie !== null) {
    const leitura = await validarSessao(env, cookie, now)
    if (leitura.valida) return { sidHash: leitura.sidHash, expiraEm: leitura.expiraEm }
  }

  return { recusa: recusarSemSessao(contexto) }
}

/**
 * A recusa do passo 6, na forma da familia da rota.
 *
 * O `303` da pagina nao carrega `?de=` nem nada parecido: um destino vindo da
 * URL e um redirecionador aberto esperando para nascer, e o painel tem uma tela
 * inicial so.
 */
function recusarSemSessao(contexto: ContextoDoErro): Response {
  if (contexto.formato === 'json') return erro('sessao_ausente', contexto)

  console.warn('painel:', contexto.request.method, contexto.caminho, 303, 'sessao_ausente')
  return redirecionar(CAMINHO_DE_ENTRAR)
}

/** Para onde o passo 6 manda quem chegou sem sessao numa pagina (§11.3). */
export const CAMINHO_DE_ENTRAR = '/painel/entrar'

/**
 * Passo 7 da escada, e camada 3 das cinco de §10.9: a ficha anti-CSRF.
 *
 *   ficha = base64url( HMAC-SHA256( k_csrf, "csrf|v1|" + sid_hash ) )
 *
 * **Derivada, e nao sorteada**, entao ela nao precisa de coluna nem de segundo
 * cookie e e impossivel de dessincronizar. Comparada com `timingSafeEqual`.
 *
 * De onde ela pode vir: do cabecalho `X-Painel-CSRF` nas rotas
 * `/painel/api/*`, e do campo escondido `csrf` nos formularios. **Nunca da
 * query string** — e a ausencia de `url.searchParams` nesta funcao e a trava:
 * uma ficha aceita na URL vazaria em `Referer`, em historico e em log de proxy,
 * e passaria a valer num link que alguem clica.
 */
export async function exigirCsrf(
  request: Request,
  env: Env,
  sidHash: string,
  corpo: CorpoDaRota,
  contexto: ContextoDoErro,
): Promise<Response | null> {
  const ficha =
    corpo.familia === 'formulario'
      ? corpo.campos.get(CAMPO_DA_FICHA)
      : request.headers.get(CABECALHO_DA_FICHA)

  if (ficha === null || ficha === '') return erro('csrf_invalido', contexto)
  if (!timingSafeEqual(await fichaCsrf(env, sidHash), ficha)) {
    return erro('csrf_invalido', contexto)
  }

  return null
}

/** O que o passo 9 devolve: a linha viva daquela sessao, ou a recusa. */
export type PortaDeSessaoViva = { readonly linha: LinhaDeSessao } | { readonly recusa: Response }

/**
 * Passo 9 da escada, e o PRIMEIRO que toca o D1: a linha e a autoridade.
 *
 * O HMAC do cookie prova que o `sid` saiu daqui; a linha prova que ele ainda
 * vale. E a diferenca entre as duas que faz "sair", "sair de todos os
 * aparelhos" e "remover a passkey" derrubarem uma sessao emitida de verdade
 * (§10.8, §10.13) — sem ela, o cookie sozinho valeria as 12 horas inteiras.
 *
 * Confere os dois prazos: o absoluto (`expira_em`, 12 h, nunca estendido) e o
 * ocioso (`ociosa_ate`, 2 h deslizante). Uma sessao ociosa demais e recusada
 * mesmo dentro das 12 h — e o celular esquecido na mesa.
 *
 * **E aqui que a janela DESLIZA**, com a escrita que §10.8 orca: no maximo 1 a
 * cada 15 min. Ela nao existia, e a ausencia dela nao era economia — era o
 * prazo ocioso virando um segundo prazo absoluto, mais curto: `ociosa_ate` era
 * gravado uma unica vez, no login, e quem usasse o painel sem parar era jogado
 * para `/painel/entrar` exatamente 2 h depois de entrar, no meio do trabalho.
 * O prazo de 12 h que §10.8 chama de absoluto era, na pratica, inalcancavel.
 */
export async function exigirSessaoViva(
  db: D1Database,
  sidHash: string,
  now: number,
  contexto: ContextoDoErro,
): Promise<PortaDeSessaoViva> {
  const repositorio = new PainelSessoesRepository(db)
  const linha = await repositorio.buscarPorHash(sidHash)
  if (linha === null || now > linha.expiraEm || now > linha.ociosaAte) {
    return { recusa: recusarSemSessao(contexto) }
  }

  // A escrita vem DEPOIS da recusa, e a ordem e a garantia: uma sessao morta
  // nao ganha folego por ter sido visitada. Antes do `if`, um cookie de uma
  // sessao ociosa ha tres horas ressuscitaria a linha dela.
  if (now - linha.vistaEm < INTERVALO_DE_VISTA_MS) return { linha }

  // O teto do prazo absoluto: `ociosa_ate` nunca ultrapassa `expira_em`. A
  // guarda confere os dois, entao nada mudaria hoje — mas a linha passaria a
  // ANUNCIAR uma janela que a sessao nao tem, e a poda do cron (`DELETE ...
  // WHERE expira_em < ? OR ociosa_ate < ?`) e outra leitora dessa coluna.
  const ociosaAte = Math.min(now + PRAZO_OCIOSO_DE_SESSAO_MS, linha.expiraEm)

  try {
    await repositorio.marcarVista(sidHash, now, ociosaAte)
  } catch (cause) {
    // **Esta escrita e escrituracao, e escrituracao nao derruba tela.** Sem o
    // `try`, a rejeicao subia ate o `catch` de `despachar` e virava
    // `500 falha_interna` — e como a escrita mora na guarda COMUM, as sete telas
    // de leitura caiam juntas. O cenario nao e hipotetico: a cota de 100.000
    // escritas/dia do D1 e a MESMA do webhook (§5.3), entao um Reel que viralize
    // pode esgota-la, e a primeira visita depois de 15 min tirava do dono
    // justamente a tela "O que aconteceu" — onde ele iria olhar por que.
    //
    // Engolir e a direcao SEGURA: a janela deixa de deslizar nesta requisicao e
    // a sessao morre no prazo que a linha JA anuncia. Ninguem ganha folego.
    //
    // Formato de §11.7: argumentos separados, nunca template string com dado
    // variavel dentro.
    console.warn(
      'painel:',
      'indisponivel',
      'vista_nao_gravada',
      cause instanceof Error ? cause.message : cause,
    )

    // Devolve a linha ANTIGA, e isto e load-bearing: devolver `vistaEm: now`
    // depois de a escrita falhar faria a resposta anunciar uma janela que o
    // banco nao tem — exatamente o defeito que o comentario do `Math.min` acima
    // existe para impedir.
    return { linha }
  }

  // A linha DEVOLVIDA carrega os valores novos: o handler que a recebe le
  // `ociosaAte` do mesmo objeto, e devolver o valor velho faria a tela e o
  // banco discordarem dentro da mesma requisicao.
  return { linha: { ...linha, vistaEm: now, ociosaAte } }
}

/**
 * De quanto em quanto tempo `vista_em` pode ser regravado: **15 min** (§10.8).
 *
 * O numero e a troca inteira: uso intenso do painel nao pode virar uma escrita
 * por requisicao (a cota do D1 e a mesma do webhook), e a janela ociosa de 2 h
 * nao pode deixar de deslizar. Com 15 min, uma hora de uso continuo custa no
 * maximo 4 escritas e o pior caso da janela e "2 h desde algum instante nos
 * ultimos 15 min" — dentro do que §10.8 desenha.
 *
 * Mora AQUI, e nao ao lado dos dois prazos em `panel-session.ts`, porque ele
 * nao e prazo de sessao: e a cadencia da unica escrita que esta guarda faz, e
 * quem o le e so ela. Os dois prazos continuam vindo de la, importados — duas
 * grafias do prazo ocioso fariam a sessao morrer cedo ou tarde demais, que sao
 * os dois defeitos que ninguem reporta.
 */
export const INTERVALO_DE_VISTA_MS = 15 * 60 * 1000

// ---------------------------------------------------------------------------
// POST /painel/sair — "sair deste aparelho" (§7.1, §10.8, §10.13)
// ---------------------------------------------------------------------------

/**
 * `POST /painel/sair`: apaga a linha DESTA sessao, e so dela (§10.8).
 *
 * **A rota existia em §7.1 e em §10.8 e nao existia no codigo.** O `switch` do
 * roteador nao tinha o `case`, entao quem seguisse o endereco publicado levava
 * `404 rota_desconhecida`, e o unico jeito de encerrar a propria sessao passou
 * a ser "sair de todos os aparelhos" — que derruba tambem o celular de quem so
 * queria sair do computador emprestado.
 *
 * **Mora em `guardas.ts` porque e a metade contraria de `exigirSessaoViva`.**
 * Aquela funcao afirma "a linha e a autoridade"; esta e a que apaga a linha, e
 * ler as duas juntas e o que impede que uma mude sem a outra. A tela que a
 * chama e a de Aparelhos (§10.13), mas o efeito nao e sobre aparelho nenhum:
 * e sobre esta sessao.
 *
 * **Sem step-up**, e §7.1 e literal nisso: sair e a direcao segura de §10.10,
 * e cobrar biometria de quem esta se protegendo puniria o uso correto. Sessao
 * e ficha CSRF, que o roteador ja exigiu pela tabela.
 *
 * **O `303` aponta para `/painel/entrar`**, pela mesma razao de `sair_de_tudo`:
 * a acao apaga a sessao de quem apertou, e um `303` para qualquer tela do
 * painel cairia no `303` do passo 6 da escada — dois redirects para chegar ao
 * mesmo lugar.
 *
 * `Clear-Site-Data` acompanha o cookie morto porque §10.8 o nomeia, e com a
 * ressalva que a propria spec escreve: suporte irregular no Safari, entao ele
 * e **reforco, nunca a defesa**. A defesa e a linha apagada — a partir dela o
 * cookie nao vale mais em navegador nenhum.
 */
export async function handleSair(entrada: EntradaDaRota): Promise<Response> {
  const { env, now, sessao } = entrada

  // `sessao` e `null` so em rota sem portao de sessao, e esta declara
  // `sessao: true`. O ramo existe porque o tipo o admite, e a direcao e a
  // segura: sem linha para apagar, nao ha o que auditar.
  if (sessao === null) return redirecionar(CAMINHO_DE_ENTRAR)

  await env.DB.batch([
    new PainelSessoesRepository(env.DB).statementDeApagar(sessao.sidHash),
    new PainelAuditoriaRepository(env.DB).statementDeRegistro(
      {
        ocorridoEm: now,
        // `0` porque nada aqui muda configuracao, o mesmo `0` de `login` e de
        // `codigos_gerados` (§9.9): perguntar a versao atual custaria uma
        // leitura de `painel_config` que esta rota nao tem no orcamento.
        versao: 0,
        origem: 'painel',
        ator: `passkey:${await prefixoDeCredencial(sessao.credentialId)}`,
        stepUp: false,
        acao: 'sessao_encerrada',
        alvo: null,
        campos: JSON.stringify([ACAO_DE_SAIR]),
        antes: null,
        depois: null,
      },
      // "Sem mudanca, sem log" (§8.8): se a linha ja tiver sido apagada por
      // outra aba, por "sair de todos" ou pela remocao da passkey, o `DELETE`
      // altera zero linhas e a auditoria nao afirma um encerramento que nao
      // aconteceu. `changes()` responde sobre o statement ANTERIOR, e por isso
      // a ordem deste lote e parte da garantia.
      { presoAMudanca: true },
    ),
  ])

  return redirecionar(
    `${CAMINHO_DE_ENTRAR}?ok=${CONFIRMACAO_DE_SAIDA}`,
    {
      'clear-site-data': '"cookies"',
    },
    [cookieDoPainel(COOKIE_DA_SESSAO, '', 0)],
  )
}

/** O nome que a coluna `campos` da auditoria carrega para esta acao (§9.9). */
const ACAO_DE_SAIR = 'sair'

/**
 * O `?ok=` que a tela de entrar le depois da saida (§7.1, §12.2).
 *
 * A frase mora no dicionario, que e a lista FECHADA de codigos: a tela procura
 * o codigo la e escreve a frase DE LA, e um `?ok=` desconhecido nao mostra
 * faixa nenhuma. E essa consulta, e nao o escape, que impede a query string de
 * virar conteudo da pagina.
 */
const CONFIRMACAO_DE_SAIDA: CodigoDeConfirmacao = 'saiu'
