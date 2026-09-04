/**
 * As guardas do painel. Nesta etapa mora aqui so o limitador de taxa; o resto
 * da escada de §11.3 (sessao, ficha CSRF, step-up) chega com o roteador.
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
 */
import type { Env } from '../../types/env'

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
 * Trava de RL-04 e de RL-10: o prefixo vem da familia da rota, o resto e o IP
 * que a Cloudflare carimba, e a ausencia do carimbo cai no balde global.
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
 * espaco, os mais antigos saem junto.
 */
const TETO_DE_BALDES = 10_000

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
  private readonly baldes = new Map<string, Balde>()

  constructor(private readonly teto: number) {}

  async permitir(chave: string, agora: number): Promise<Veredito> {
    this.podar(agora)

    const balde = this.baldes.get(chave)
    if (balde === undefined || this.venceu(balde, agora)) {
      this.baldes.set(chave, { abertoEm: agora, contagem: 1 })
      return LIBERADO
    }

    const contagem = balde.contagem + 1
    this.baldes.set(chave, { abertoEm: balde.abertoEm, contagem })

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

  /** Vencidos primeiro; se ainda estourar o teto, os mais antigos vao junto. */
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
      // Mesmo padrao do resto do painel: o codigo vai para o log, o valor
      // nunca. A chave carrega um IP e por isso nao entra na linha.
      console.error('painel:', 'indisponivel', cause instanceof Error ? cause.message : cause)
      return this.reserva.permitir(chave, agora)
    }
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
