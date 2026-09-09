import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { handleSair, INTERVALO_DE_VISTA_MS } from '../src/routes/painel/guardas'
import { handleInicio } from '../src/routes/painel/inicio'
import { ROTA_INICIO, ROTA_SAIR, ROTAS } from '../src/routes/painel/rotas'
import { despachar } from '../src/routes/painel/router'
import { invalidarCacheDeConfig } from '../src/services/config-store'
import {
  emitirSessao,
  fichaCsrf,
  PRAZO_ABSOLUTO_DE_SESSAO_MS,
  PRAZO_OCIOSO_DE_SESSAO_MS,
} from '../src/services/panel-session'
import type { Env } from '../src/types/env'
import { gravarConfig, limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoD1,
  D1Contador,
  pedir,
  RAIZ,
  responder,
} from './fixtures/dubles'

/**
 * As tres travas que a rodada de revisao adversarial cobrou, e que compartilham
 * um assunto: **a sessao do painel — o que a mantem viva, o que a encerra e o
 * que o dono ve quando a rede de seguranca dela acabou.**
 *
 *   SAI — `POST /painel/sair` ("sair deste aparelho"), que §7.1 e §10.8
 *         publicam e que o roteador respondia com `404`;
 *   VIS — a gravacao de `vista_em`/`ociosa_ate` que §10.8 orca e que nao
 *         existia, entao a janela de 2 h nunca deslizava;
 *   COD — o aviso bloqueante de §10.11, que so existia na tela de Aparelhos —
 *         a unica tela sem item na barra de baixo.
 *
 * **Por que num arquivo proprio, e nao em `painel-sessao`/`painel-telas`.**
 * As tres correcoes nasceram em paralelo com outras tres frentes no mesmo
 * repositorio, e um teste novo dentro de uma suite que outra frente esta
 * reescrevendo e um conflito garantido. O arquivo e o dono da afirmacao; o
 * assunto continua sendo o mesmo das suites de §13.1.
 */

/** O `env` de teste com um pedaco trocado — o `DB` contador, nos lacos de custo. */
function ambienteCom(patch: Record<string, unknown>): Env {
  return { ...env, ...patch } as unknown as Env
}

/**
 * O SQL de cada statement preparado, alcancavel a partir do proprio statement.
 *
 * `db.batch()` recebe `D1PreparedStatement`, e um statement NAO devolve o SQL
 * que o gerou. Sem esta ponte, um contador de lotes so sabe QUANTOS lotes
 * houve — nunca o que foi DENTRO de cada um, que e a unica pergunta que separa
 * "um lote com as duas escritas" de "um lote e uma escrita solta".
 */
const SQL_DO_STATEMENT = new WeakMap<object, string>()

/** O statement REAL por tras do embrulho: o D1 recebe o dele, nunca o proxy. */
const REAL_DO_STATEMENT = new WeakMap<object, D1PreparedStatement>()

/**
 * Embrulha um statement carregando o SQL consigo.
 *
 * `bind()` devolve um statement NOVO, e e o statement JA vinculado que entra no
 * lote — por isso o embrulho tem de reembalar o resultado de `bind()`, senao o
 * SQL se perderia exatamente em quem usa `.bind()`, que e todo mundo.
 */
function comSql(real: D1PreparedStatement, sql: string): D1PreparedStatement {
  const embrulho = new Proxy(real as unknown as object, {
    get: (alvo, chave) => {
      const valor = Reflect.get(alvo, chave, alvo)
      if (chave === 'bind' && typeof valor === 'function') {
        return (...args: unknown[]) =>
          comSql((valor as (...a: unknown[]) => D1PreparedStatement).apply(alvo, args), sql)
      }
      // `bind(alvo)` porque o D1PreparedStatement do Miniflare guarda campos
      // privados: um metodo chamado com `this` = proxy estouraria.
      return typeof valor === 'function'
        ? (valor as (...a: unknown[]) => unknown).bind(alvo)
        : valor
    },
  }) as D1PreparedStatement

  SQL_DO_STATEMENT.set(embrulho, sql)
  REAL_DO_STATEMENT.set(embrulho, real)
  return embrulho
}

/** Statements que gravam — a mesma separacao que o `D1Contador` do fixture faz. */
const ESCRITA = /^\s*(insert|update|delete|replace)/i

/**
 * D1 que guarda a COMPOSICAO de cada `db.batch()`, e nao so a contagem.
 *
 * **Por que aqui, e nao no `D1Contador` de `tests/fixtures/dubles.ts`.** O
 * fixture e compartilhado por uma duzia de suites que rodam em paralelo com
 * esta correcao; a ponte do `Proxy` entra la no ciclo seguinte, junto com a
 * varredura de `grep -n "batches).toBe" tests/` que o achado pede. Enquanto
 * isso, a afirmacao mora com o teste que a precisa.
 */
class D1QueGuardaLotes {
  /** O SQL dos membros de cada lote, na ordem: um array por `db.batch()`. */
  readonly lotes: string[][] = []
  /** Quantos statements de escrita foram PREPARADOS, dentro ou fora de lote. */
  escritas = 0

  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    if (ESCRITA.test(sql)) this.escritas += 1
    return comSql(this.real.prepare(sql), sql)
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.lotes.push(
      statements.map((statement) => SQL_DO_STATEMENT.get(statement) ?? '(preparado fora daqui)'),
    )
    return this.real.batch<T>(
      statements.map((statement) => REAL_DO_STATEMENT.get(statement) ?? statement),
    )
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    return this.real.dump()
  }
}

/**
 * Uma sessao viva no banco, e o cookie dela.
 *
 * `vistaEm` e parametro porque e exatamente o eixo de VIS: uma sessao vista
 * agora nao deve gravar nada, e uma vista ha 20 min deve.
 */
async function abrirSessao(
  opcoes: { vistaEm?: number; ociosaAte?: number; credencial?: string } = {},
): Promise<{ cookie: Record<string, string>; sidHash: string; expiraEm: number }> {
  const sessao = await emitirSessao(env, AGORA)
  await env.DB.prepare(
    `INSERT INTO painel_sessoes
       (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      sessao.sidHash,
      opcoes.credencial ?? 'cred',
      env.PANEL_RP_ID,
      AGORA,
      sessao.expiraEm,
      opcoes.ociosaAte ?? AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
      opcoes.vistaEm ?? AGORA,
    )
    .run()

  return {
    cookie: { cookie: `__Host-painel_sessao=${sessao.valor}` },
    sidHash: sessao.sidHash,
    expiraEm: sessao.expiraEm,
  }
}

/** A linha daquela sessao, ou `null` quando ela ja nao existe. */
async function linhaDaSessao(
  sidHash: string,
): Promise<{ ociosa_ate: number; vista_em: number } | null> {
  return await env.DB.prepare('SELECT ociosa_ate, vista_em FROM painel_sessoes WHERE sid_hash = ?')
    .bind(sidHash)
    .first<{ ociosa_ate: number; vista_em: number }>()
}

/** Quantas linhas de sessao existem no banco inteiro. */
async function quantasSessoes(): Promise<number> {
  const linha = await env.DB.prepare('SELECT COUNT(*) AS total FROM painel_sessoes').first<{
    total: number
  }>()
  return linha?.total ?? 0
}

/** Um `POST /painel/sair` de formulario, com origem e cookie. */
function postDeSair(cookie: Record<string, string>, corpo: string): Request {
  return new Request(`${RAIZ}${ROTA_SAIR.caminho}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: RAIZ,
      ...cookie,
    },
    body: corpo,
  })
}

/** Grava um codigo de recuperacao no estado pedido. */
async function gravarCodigo(
  hash: string,
  estado: { usadoEm?: number; invalidadoEm?: number } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO painel_codigos (hash, tipo, versao_hash, criado_em, usado_em, invalidado_em)
     VALUES (?, 'recuperacao', 1, ?, ?, ?)`,
  )
    .bind(hash, AGORA, estado.usadoEm ?? null, estado.invalidadoEm ?? null)
    .run()
}

// ---------------------------------------------------------------------------
// VIS — a janela ociosa desliza, e a escrita e no maximo 1 a cada 15 min (§10.8)
// ---------------------------------------------------------------------------

describe('VIS — `vista_em` e `ociosa_ate` (§10.8)', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
    await gravarConfig(env.DB)
  })

  test('VIS-01: uma requisicao depois dos 15 min desliza `ociosa_ate` e carimba `vista_em`', async () => {
    const { cookie, sidHash } = await abrirSessao()
    const depois = AGORA + INTERVALO_DE_VISTA_MS

    const resposta = await despachar(
      pedir('/painel', cookie),
      env,
      depois,
      ROTA_INICIO,
      handleInicio,
    )
    expect(resposta.status).toBe(200)

    // O que o defeito causava: `ociosa_ate` era gravado UMA vez, no login, e
    // nunca mais. Quem trabalhasse sem parar era jogado para /painel/entrar
    // exatamente 2 h depois de entrar, em plena atividade — e o prazo absoluto
    // de 12 h de §10.8 era inalcancavel.
    expect(await linhaDaSessao(sidHash)).toEqual({
      vista_em: depois,
      ociosa_ate: depois + PRAZO_OCIOSO_DE_SESSAO_MS,
    })
  })

  test('VIS-02: duas requisicoes em menos de 15 min gravam `vista_em` uma vez so (SES)', async () => {
    const { cookie, sidHash } = await abrirSessao()
    const primeira = AGORA + INTERVALO_DE_VISTA_MS
    const segunda = primeira + 60_000

    await despachar(pedir('/painel', cookie), env, primeira, ROTA_INICIO, handleInicio)

    // A segunda passa pelo contador: a afirmacao de §10.8 e sobre a ESCRITA,
    // e nao sobre o valor final — um `UPDATE` que regrava o mesmo numero
    // custaria o mesmo e a linha continuaria parecendo certa.
    invalidarCacheDeConfig()
    const contador = new D1Contador(env.DB)
    await despachar(
      pedir('/painel', cookie),
      ambienteCom({ DB: comoD1(contador) }),
      segunda,
      ROTA_INICIO,
      handleInicio,
    )

    expect(contador.escritas).toBe(0)
    expect(await linhaDaSessao(sidHash)).toEqual({
      vista_em: primeira,
      ociosa_ate: primeira + PRAZO_OCIOSO_DE_SESSAO_MS,
    })
  })

  test('VIS-03: quem usa o painel sem parar continua dentro depois das 2 h', async () => {
    // O cenario do achado, encenado: o dono entra as 9h00 e mexe no painel de
    // meia em meia hora. As 11h01 ele continua dentro.
    const { cookie } = await abrirSessao()
    const MEIA_HORA = 30 * 60 * 1000

    for (let passo = 1; passo <= 4; passo += 1) {
      invalidarCacheDeConfig()
      const resposta = await despachar(
        pedir('/painel', cookie),
        env,
        AGORA + passo * MEIA_HORA,
        ROTA_INICIO,
        handleInicio,
      )
      expect({ passo, status: resposta.status }).toEqual({ passo, status: 200 })
    }

    invalidarCacheDeConfig()
    const passadas = await despachar(
      pedir('/painel', cookie),
      env,
      AGORA + PRAZO_OCIOSO_DE_SESSAO_MS + 60_000,
      ROTA_INICIO,
      handleInicio,
    )
    expect(passadas.status).toBe(200)
  })

  test('VIS-04: a janela deslizante NAO estende o prazo absoluto de 12 h', async () => {
    // Uma sessao que veio sendo usada a manha inteira: `ociosa_ate` ja foi
    // empurrado ate o teto, que e o proprio `expira_em`.
    const quaseNoFim = AGORA + PRAZO_ABSOLUTO_DE_SESSAO_MS - 60_000
    const { cookie, sidHash } = await abrirSessao({
      ociosaAte: AGORA + PRAZO_ABSOLUTO_DE_SESSAO_MS,
    })

    // Uma visita perto do fim: `ociosa_ate` nao pode ultrapassar `expira_em`,
    // senao a linha passaria a anunciar uma janela que a sessao nao tem.
    await despachar(pedir('/painel', cookie), env, quaseNoFim, ROTA_INICIO, handleInicio)

    expect(await linhaDaSessao(sidHash)).toEqual({
      vista_em: quaseNoFim,
      ociosa_ate: AGORA + PRAZO_ABSOLUTO_DE_SESSAO_MS,
    })

    // E o prazo absoluto continua matando a sessao, use-se ela ou nao.
    invalidarCacheDeConfig()
    const fora = await despachar(
      pedir('/painel', cookie),
      env,
      AGORA + PRAZO_ABSOLUTO_DE_SESSAO_MS + 1,
      ROTA_INICIO,
      handleInicio,
    )
    expect(fora.status).toBe(303)
  })

  test('VIS-06: a escrita de `vista_em` falhando NAO derruba a tela', async () => {
    // **O defeito que este teste prende foi introduzido pela propria correcao de
    // §10.8.** `marcarVista` era um `await` pelado dentro da guarda COMUM. Num D1
    // que aceita leitura e recusa escrita — a cota de 100.000 escritas/dia e a
    // MESMA do webhook (§5.3), entao um Reel viral pode esgota-la — a primeira
    // visita depois de 15 min virava `500 falha_interna`; e como a escrita mora
    // na guarda, as SETE telas de leitura caiam juntas. Tirava do dono justamente
    // a tela onde ele iria olhar por que.
    const { cookie, sidHash } = await abrirSessao()
    const antes = await linhaDaSessao(sidHash)
    const depois = AGORA + INTERVALO_DE_VISTA_MS

    /** Le tudo; recusa SO o UPDATE de `painel_sessoes`. */
    const soLeitura = {
      prepare: (sql: string) => {
        if (/^\s*UPDATE\s+painel_sessoes/i.test(sql)) {
          return {
            bind: () => ({
              run: () => Promise.reject(new Error('D1_ERROR: cota de escrita esgotada')),
            }),
          } as unknown as D1PreparedStatement
        }
        return env.DB.prepare(sql)
      },
      batch: <T = unknown>(s: D1PreparedStatement[]) => env.DB.batch<T>(s),
      exec: (q: string) => env.DB.exec(q),
      dump: () => env.DB.dump(),
    } as unknown as D1Database

    const registro = capturarConsole()
    let resposta: Response
    try {
      resposta = await despachar(
        pedir('/painel', cookie),
        ambienteCom({ DB: soLeitura }),
        depois,
        ROTA_INICIO,
        handleInicio,
      )
    } finally {
      registro.parar()
    }

    // A tela ABRE. O que se perde e so o deslizamento desta requisicao.
    expect(resposta.status).toBe(200)

    // A linha fica EXATAMENTE como estava: nada de anunciar uma janela que o
    // banco nao tem.
    expect(await linhaDaSessao(sidHash)).toEqual(antes)

    // E a falha nao passa calada — §11.7, argumentos separados.
    const registrado = registro.linhas.join(' ')
    expect(registrado).toContain('indisponivel')
    expect(registrado).toContain('vista_nao_gravada')
  })

  test('VIS-05: uma sessao ociosa demais e recusada SEM gravar nada', async () => {
    const { cookie, sidHash } = await abrirSessao()

    const contador = new D1Contador(env.DB)
    const resposta = await despachar(
      pedir('/painel', cookie),
      ambienteCom({ DB: comoD1(contador) }),
      AGORA + PRAZO_OCIOSO_DE_SESSAO_MS + 1,
      ROTA_INICIO,
      handleInicio,
    )

    expect(resposta.status).toBe(303)
    expect(contador.escritas).toBe(0)
    expect(await linhaDaSessao(sidHash)).toEqual({
      vista_em: AGORA,
      ociosa_ate: AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
    })
  })
})

// ---------------------------------------------------------------------------
// SAI — POST /painel/sair (§7.1, §10.8, §10.13)
// ---------------------------------------------------------------------------

describe('SAI — `POST /painel/sair` (§10.8)', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
    await gravarConfig(env.DB)
  })

  test('SAI-01: a rota esta na tabela de §11.1, com sessao, ficha e sem step-up', async () => {
    expect(ROTAS).toContain(ROTA_SAIR)
    expect({
      caminho: ROTA_SAIR.caminho,
      metodos: [...ROTA_SAIR.metodos],
      sessao: ROTA_SAIR.sessao,
      csrf: ROTA_SAIR.csrf,
      stepUp: ROTA_SAIR.stepUp,
      escreve: ROTA_SAIR.escreve,
      gravaConfig: ROTA_SAIR.gravaConfig,
    }).toEqual({
      caminho: '/painel/sair',
      metodos: ['POST'],
      sessao: true,
      csrf: true,
      stepUp: false,
      escreve: true,
      gravaConfig: false,
    })
  })

  test('SAI-02: o roteador despacha o caminho — ele nao cai mais no `default:`', async () => {
    // O que o defeito causava: §7.1 e §10.8 publicam `POST /painel/sair`, e o
    // `switch` nao tinha o `case` — quem seguisse o endereco publicado levava
    // `404 rota_desconhecida`. Sem cookie a escada recusa no passo 6, com o
    // `303` de pagina; o que este teste afirma e que ela CHEGOU ao passo 6.
    const resposta = await responder(postDeSair({}, ''), env)

    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe('/painel/entrar')
  })

  test('SAI-03: apaga a linha DAQUELA sessao, e nao as outras', async () => {
    const alvo = await abrirSessao()
    const outro = await abrirSessao({ credencial: 'cred-do-celular' })

    const resposta = await despachar(
      postDeSair(alvo.cookie, `csrf=${await fichaCsrf(env, alvo.sidHash)}`),
      env,
      AGORA,
      ROTA_SAIR,
      handleSair,
    )

    expect(resposta.status).toBe(303)
    // Com `?ok=`: a frase da faixa verde mora na lista fechada do dicionario, e
    // a tela de entrar e quem a le — a sessao que a mostraria ja nao existe.
    expect(resposta.headers.get('location')).toBe('/painel/entrar?ok=saiu')
    expect(await linhaDaSessao(alvo.sidHash)).toBeNull()
    // A diferenca inteira entre "sair deste aparelho" e "sair de todos": o
    // celular do dono continua dentro.
    expect(await linhaDaSessao(outro.sidHash)).not.toBeNull()
    expect(await quantasSessoes()).toBe(1)
  })

  test('SAI-04: o cookie morre junto — `Max-Age=0` e `Clear-Site-Data` (§10.8)', async () => {
    const { cookie, sidHash } = await abrirSessao()

    const resposta = await despachar(
      postDeSair(cookie, `csrf=${await fichaCsrf(env, sidHash)}`),
      env,
      AGORA,
      ROTA_SAIR,
      handleSair,
    )

    const posto = resposta.headers.get('set-cookie') ?? ''
    expect(posto).toContain('__Host-painel_sessao=;')
    expect(posto).toContain('Max-Age=0')
    expect(posto).toContain('Path=/')
    expect(posto).toContain('HttpOnly')
    expect(posto).toContain('Secure')
    expect(posto).toContain('SameSite=Strict')
    expect(resposta.headers.get('clear-site-data')).toBe('"cookies"')
  })

  test('SAI-05: sem a ficha CSRF nao sai ninguem, e nada e gravado', async () => {
    const { cookie, sidHash } = await abrirSessao()

    const contador = new D1Contador(env.DB)
    const resposta = await despachar(
      postDeSair(cookie, 'csrf=ficha-errada'),
      ambienteCom({ DB: comoD1(contador) }),
      AGORA,
      ROTA_SAIR,
      handleSair,
    )

    expect(resposta.status).toBe(403)
    expect(contador.escritas).toBe(0)
    expect(await linhaDaSessao(sidHash)).not.toBeNull()
  })

  test('SAI-06: `GET /painel/sair` e `405`, e nao uma tela', async () => {
    const resposta = await responder(pedir(ROTA_SAIR.caminho), env)

    expect(resposta.status).toBe(405)
    expect(resposta.headers.get('allow')).toBe('POST')
  })

  test('SAI-07: a linha de auditoria `sessao_encerrada` vai no MESMO lote (§8.8)', async () => {
    const { cookie, sidHash } = await abrirSessao()

    const contador = new D1QueGuardaLotes(env.DB)
    await despachar(
      postDeSair(cookie, `csrf=${await fichaCsrf(env, sidHash)}`),
      ambienteCom({ DB: contador as unknown as D1Database }),
      AGORA,
      ROTA_SAIR,
      handleSair,
    )

    const linha = await env.DB.prepare(
      'SELECT acao, origem, ator, step_up, alvo, campos FROM painel_auditoria',
    ).first<{
      acao: string
      origem: string
      ator: string
      step_up: number
      alvo: string | null
      campos: string
    }>()

    expect(linha).toEqual({
      acao: 'sessao_encerrada',
      origem: 'painel',
      // §9.9 e §10.13: o prefixo de 8 hex, nunca o `credential_id` cru.
      ator: expect.stringMatching(/^passkey:[0-9a-f]{8}$/) as unknown as string,
      // Sair e a direcao segura de §10.10: nao passa pela digital.
      step_up: 0,
      alvo: null,
      campos: '["sair"]',
    })

    // **Um lote so, e com as DUAS escritas DENTRO dele.**
    //
    // MUTACAO QUE ESTE BLOCO MATA (medida): em `handleSair`, trocar o lote de
    // dois statements por `env.DB.batch([statementDeApagar(...)])` seguido de um
    // `await statementDeRegistro(...).run()` separado. Com a antiga assercao
    // unica — `contador.batches === 1` — a suite ficava 17/17 VERDE: os dois
    // mundos tem exatamente um lote e exatamente uma linha de auditoria no fim.
    // O que o nome deste teste promete e ATOMICIDADE, e atomicidade e uma
    // afirmacao sobre a COMPOSICAO do lote, nunca sobre a contagem dele. Se as
    // duas escritas podem acontecer separadas, existe um instante em que a
    // sessao morreu e a auditoria nao registrou — e um D1 que caia entre as duas
    // idas deixa o encerramento fora do historico para sempre (§8.8).
    expect(contador.lotes.length).toBe(1)
    // `?? []` so por causa de `noUncheckedIndexedAccess`: a linha de cima ja
    // garante que o lote existe, e um array vazio reprova nas assercoes abaixo.
    const lote = contador.lotes[0] ?? []
    expect(lote.length).toBe(2)
    expect(lote[0]).toMatch(/DELETE\s+FROM\s+painel_sessoes/i)

    // E a ORDEM tambem e garantia, nao arrumacao: `changes()` responde sobre o
    // statement IMEDIATAMENTE anterior DO LOTE. Auditoria primeiro, e o
    // `WHERE changes() > 0` passaria a falar da contagem de outra coisa.
    expect(lote[1]).toMatch(/INSERT\s+INTO\s+painel_auditoria/i)
    // MUTACAO QUE ESTA LINHA MATA: trocar `{ presoAMudanca: true }` por `false`.
    // Sem ela, um segundo `POST /painel/sair` de outra aba — cujo `DELETE`
    // altera zero linhas — gravaria `sessao_encerrada` de novo, enchendo o
    // historico de encerramentos que nao aconteceram (§8.8, "sem mudanca, sem
    // log"). O `?ok=saiu` da tela de entrar continuaria identico nos dois casos.
    expect(lote[1]).toMatch(/WHERE\s+changes\(\)\s*>\s*0/i)

    // Nada de escrita por FORA do lote: duas escritas preparadas, duas dentro.
    // E esta a linha que fecha a porta para "um lote e um `.run()` solto".
    expect(contador.escritas).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// COD — o aviso bloqueante de §10.11, na tela que o dono abre
// ---------------------------------------------------------------------------

/** O que o aviso bloqueante do Inicio diz, palavra por palavra. */
const AVISO_SEM_CODIGOS = 'c&oacute;digo de recupera&ccedil;&atilde;o valendo.'

describe('COD — o aviso de "zero codigos" no Inicio (§10.11)', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
    await gravarConfig(env.DB)
  })

  test('COD-01: depois de uma recuperacao, /painel abre com o aviso bloqueante', async () => {
    // O cenario do achado: o codigo #3 foi consumido e os outros cinco levaram
    // `invalidado_em` no mesmo lote (§10.11). Sobra ZERO codigo utilizavel.
    await gravarCodigo('hash-usado', { usadoEm: AGORA })
    for (const numero of [1, 2, 4, 5, 6]) {
      await gravarCodigo(`hash-invalidado-${numero}`, { invalidadoEm: AGORA })
    }

    const { cookie } = await abrirSessao()
    const resposta = await despachar(
      pedir('/painel', cookie),
      env,
      AGORA,
      ROTA_INICIO,
      handleInicio,
    )
    const corpo = await resposta.text()

    // O que o defeito causava: o dono entrava por codigo, cadastrava o aparelho
    // novo, e o Inicio abria exatamente como sempre. Semanas depois, com o
    // aparelho novo quebrado, ele ficava sem aparelho E sem codigo — o
    // trancamento que os seis codigos existem para impedir.
    expect(corpo).toContain(AVISO_SEM_CODIGOS)
    // O aviso so vale se levar ao lugar que o resolve.
    expect(corpo).toContain('href="/painel/aparelhos"')
  })

  test('COD-02: com codigo valendo, o aviso NAO aparece', async () => {
    await gravarCodigo('hash-vivo')
    await gravarCodigo('hash-usado', { usadoEm: AGORA })

    const { cookie } = await abrirSessao()
    const resposta = await despachar(
      pedir('/painel', cookie),
      env,
      AGORA,
      ROTA_INICIO,
      handleInicio,
    )

    // O contrapositivo, sem o qual COD-01 passaria com uma faixa presa em
    // "sempre" — um aviso que nunca some ensina a ignorar todos os outros.
    expect(await resposta.text()).not.toContain(AVISO_SEM_CODIGOS)
  })

  test('COD-03: sem nenhum codigo cadastrado, o aviso aparece', async () => {
    const { cookie } = await abrirSessao()
    const resposta = await despachar(
      pedir('/painel', cookie),
      env,
      AGORA,
      ROTA_INICIO,
      handleInicio,
    )

    expect(await resposta.text()).toContain(AVISO_SEM_CODIGOS)
  })

  test('COD-04: o aviso nao custa subrequest nenhum — o Inicio continua em 3', async () => {
    // §12.10 orca 3 para o Inicio, e TELA-20 trava o numero. A pergunta sobre
    // os codigos viaja DENTRO da mesma instrucao que ja perguntava pela conta:
    // um `SELECT` com duas subconsultas custa um subrequest, e dois `prepare`
    // custariam dois.
    await gravarCodigo('hash-vivo')
    const { cookie } = await abrirSessao()

    const contador = new D1Contador(env.DB)
    await despachar(
      pedir('/painel', cookie),
      ambienteCom({ DB: comoD1(contador) }),
      AGORA,
      ROTA_INICIO,
      handleInicio,
    )

    expect({ subrequests: contador.prepares - contador.batches, lotes: contador.batches }).toEqual({
      subrequests: 3,
      lotes: 1,
    })
  })
})
