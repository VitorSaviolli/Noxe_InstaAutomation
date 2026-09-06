import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { PainelAuditoriaRepository } from '../src/repositories/painel-auditoria-repository'
import { escapeHtml } from '../src/routes/legal'
import { handleAjustes } from '../src/routes/painel/ajustes'
import { CONFIRMACOES } from '../src/routes/painel/dicionario'
import { CAMPOS_DE_COMPORTAMENTO } from '../src/routes/painel/gravar'
import { handleChave, handleInicio } from '../src/routes/painel/inicio'
import { handlePalavras } from '../src/routes/painel/palavras'
import {
  ROTA_AJUSTES,
  ROTA_CHAVE,
  ROTA_INICIO,
  ROTA_PALAVRAS,
  ROTAS,
  type RotaDoPainel,
} from '../src/routes/painel/rotas'
import { despachar, type HandlerDoPainel } from '../src/routes/painel/router'
import { carregarConfigEfetiva, invalidarCacheDeConfig } from '../src/services/config-store'
import { emitirSessao, fichaCsrf, PRAZO_OCIOSO_DE_SESSAO_MS } from '../src/services/panel-session'
import { prefixoDeCredencial } from '../src/services/webauthn/verificar'
import { gravarConfig, limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoD1,
  D1Contador,
  D1SegundoBatchQuebrado,
  pedir,
  RAIZ,
} from './fixtures/dubles'

/**
 * AUD · GRAV — a escrita dos campos de risco baixo e a auditoria de §9.9.
 *
 * As rotas sao chamadas por `despachar`, a MESMA funcao que o roteador usa: um
 * teste que chamasse o handler direto pularia a escada de §11.3 — origem,
 * `content-type`, teto de corpo, sessao e ficha — e afirmaria menos do que
 * parece.
 *
 * **Um ID por garantia.** AUD-01 a AUD-05 sao as cinco de §13.2; AUD-06 e
 * AUD-07 sao as duas metades de §10.10 sobre a chave liga/desliga. GRAV cobre a
 * forma de §7.1, a atomicidade de §8.8 e a classificacao de risco de §10.10.
 *
 * **AUD-04 tem um vizinho declarado.** A mecanica da poda — quanto ela le,
 * quanto ela escreve, e que ela entra no cron — mora em `painel-parada.test.ts`,
 * no bloco "AUDITORIA". O que se afirma AQUI e outra coisa: que a linha que a
 * gravacao do painel acabou de escrever esta sujeita ao mesmo teto, e que quem
 * sai e a mais antiga.
 *
 * **Nenhum valor da instalacao do dono entra neste arquivo.** Palavra-gatilho,
 * link e dominio sao ficticios, pelo mesmo motivo que `configDeTeste` existe:
 * este repositorio e um template publico, e um teste preso ao valor de quem o
 * escreveu fica vermelho na maquina de todo mundo que o instala.
 */

/** Palavra FICTICIA. Nunca a da instalacao de quem escreveu o teste. */
const PALAVRA_NOVA = 'quero o cardapio'

/** Dominio FICTICIO, e o mesmo que a linha de config de teste usa. */
const DOMINIO_DE_TESTE = 'exemplo.com'

const FORMULARIO = 'application/x-www-form-urlencoded'

interface Sessao {
  readonly cookie: string
  readonly ficha: string
  readonly credencial: string
}

/** Uma sessao viva de verdade: cookie assinado E linha em `painel_sessoes`. */
async function abrirSessao(credencial = 'credencial-de-teste'): Promise<Sessao> {
  const emitida = await emitirSessao(env, AGORA)
  await env.DB.prepare(
    `INSERT INTO painel_sessoes
       (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      emitida.sidHash,
      credencial,
      env.PANEL_RP_ID,
      AGORA,
      emitida.expiraEm,
      AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
      AGORA,
    )
    .run()

  return {
    cookie: `__Host-painel_sessao=${emitida.valor}`,
    ficha: await fichaCsrf(env, emitida.sidHash),
    credencial,
  }
}

/** A rota e o handler de cada uma das tres que gravam nesta etapa. */
const GRAVADORAS: readonly { rota: RotaDoPainel; handler: HandlerDoPainel }[] = [
  { rota: ROTA_CHAVE, handler: handleChave },
  { rota: ROTA_PALAVRAS, handler: handlePalavras },
  { rota: ROTA_AJUSTES, handler: handleAjustes },
]

/** Um corpo valido para cada rota que grava, para os lacos da tabela. */
const CORPO_VALIDO: Record<string, string> = {
  [ROTA_CHAVE.caminho]: 'acao=desligar',
  [ROTA_PALAVRAS.caminho]: `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
  [ROTA_AJUSTES.caminho]: 'userCooldownHours=48',
}

function postar(
  caminho: string,
  corpo: string,
  sessao: Sessao,
  cabecalhos: Record<string, string> = {},
): Request {
  return new Request(`${RAIZ}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': FORMULARIO, origin: RAIZ, cookie: sessao.cookie, ...cabecalhos },
    body: corpo,
  })
}

/** Um POST completo — ficha, versao e o corpo da rota — pela escada de §11.3. */
async function gravar(
  alvo: { rota: RotaDoPainel; handler: HandlerDoPainel },
  campos: string,
  sessao: Sessao,
  opcoes: { versao?: number; ambiente?: typeof env } = {},
): Promise<Response> {
  const versao = opcoes.versao ?? 1
  const corpo = `csrf=${sessao.ficha}&versao=${versao}${campos === '' ? '' : `&${campos}`}`

  return await despachar(
    postar(alvo.rota.caminho, corpo, sessao),
    (opcoes.ambiente ?? env) as typeof env,
    AGORA,
    alvo.rota,
    alvo.handler,
  )
}

interface LinhaDeAuditoria {
  ocorrido_em: number
  versao: number
  origem: string
  ator: string
  step_up: number
  acao: string
  alvo: string | null
  campos: string
  antes: string | null
  depois: string | null
}

async function auditoria(): Promise<LinhaDeAuditoria[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM painel_auditoria ORDER BY id',
  ).all<LinhaDeAuditoria>()
  return results ?? []
}

async function unicaLinha(): Promise<LinhaDeAuditoria> {
  const linhas = await auditoria()
  expect(linhas.length).toBe(1)
  return linhas[0] as LinhaDeAuditoria
}

async function linhaDeConfig(): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare('SELECT * FROM painel_config WHERE id = 1').first<
    Record<string, unknown>
  >()
}

/**
 * D1 que grava POR CIMA entre a leitura da versao e o lote da rota.
 *
 * Duble local injetado por parametro, como todo duble deste projeto. Ele existe
 * para produzir o unico caso que a trava otimista de §8.8 cobre e que nenhum
 * teste consegue provocar de fora: a corrida entre `carregarConfigEfetiva` e o
 * `db.batch()` da gravacao.
 */
class D1QueCorreNaFrente {
  private lotes = 0

  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    return this.real.prepare(sql)
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.lotes++
    // O primeiro lote e a LEITURA da configuracao; o segundo e a gravacao. A
    // versao anda entre os dois, que e exatamente a janela da corrida.
    if (this.lotes === 2) {
      await this.real.prepare('UPDATE painel_config SET versao = versao + 1 WHERE id = 1').run()
    }
    return await this.real.batch<T>(statements)
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    return this.real.dump()
  }
}

/** A tela de Ajustes, ja lida, com a sessao viva. */
async function telaDeAjustes(sessao: Sessao): Promise<string> {
  return await (
    await despachar(
      pedir(ROTA_AJUSTES.caminho, { cookie: sessao.cookie }),
      env,
      AGORA,
      ROTA_AJUSTES,
      handleAjustes,
    )
  ).text()
}

/**
 * O corpo que o botao "Voltar a esta versao" enviaria, extraido da tela.
 *
 * O recorte e o formulario DO BOTAO, e nao a pagina toda: o formulario de cima
 * usa os mesmos nomes de campo, e uma extracao solta juntaria os dois. Sao os
 * campos de comportamento, todos eles — a `versao` e a ficha entram por
 * `gravar`, como em qualquer outro POST.
 */
function camposDoBotaoDeVoltar(corpo: string): string {
  const doBotao = corpo.split('<form').find((pedaco) => pedaco.includes('Voltar a esta vers'))
  expect(doBotao).toBeDefined()

  const escondidos = [...(doBotao ?? '').matchAll(/name="([a-zA-Z]+)" value="([^"]*)"/g)]
    .filter(([, nome]) => (CAMPOS_DE_COMPORTAMENTO as readonly string[]).includes(nome ?? ''))
    .map(([, nome, valor]) => `${nome}=${encodeURIComponent(desescapar(valor ?? ''))}`)

  // O `antes` e reenviado INTEIRO: um campo a menos significaria "nao mexe
  // nisso", e a restauracao ficaria pela metade sem ninguem perceber.
  expect(escondidos.length).toBe(CAMPOS_DE_COMPORTAMENTO.length)
  return escondidos.join('&')
}

/** O que o navegador faz com o valor de um atributo antes de enviar de volta. */
function desescapar(valor: string): string {
  return valor
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

beforeEach(async () => {
  await limparBanco(env.DB)
  invalidarCacheDeConfig()
})

// ---------------------------------------------------------------------------
// AUD — a auditoria de §9.9 e §13.2
// ---------------------------------------------------------------------------

describe('AUD — a auditoria da gravacao', () => {
  test('AUD-01: toda gravacao registra data, credencial usada e campos alterados', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao('credencial-do-dono')

    await gravar(GRAVADORAS[1] as (typeof GRAVADORAS)[number], 'triggerKeywords=um%0Adois', sessao)

    const linha = await unicaLinha()
    expect({
      ocorrido_em: linha.ocorrido_em,
      versao: linha.versao,
      origem: linha.origem,
      acao: linha.acao,
      step_up: linha.step_up,
      alvo: linha.alvo,
      campos: linha.campos,
    }).toEqual({
      ocorrido_em: AGORA,
      // A versao RESULTANTE (§8.8, terceira funcao da versao).
      versao: 2,
      origem: 'painel',
      acao: 'config_alterada',
      step_up: 0,
      alvo: null,
      campos: '["triggerKeywords"]',
    })

    // A CREDENCIAL usada, e nunca o `credential_id` cru: 8 hex do sha256 dele.
    expect(linha.ator).toBe(`passkey:${await prefixoDeCredencial('credencial-do-dono')}`)
  })

  test('AUD-02: o registro nao guarda cookie, credencial inteira, IP nem User-Agent', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao('credencial-longa-do-dono')

    await despachar(
      postar(
        ROTA_PALAVRAS.caminho,
        `csrf=${sessao.ficha}&versao=1&triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
        sessao,
        { 'user-agent': 'Mozilla/5.0 (Teste)', 'cf-connecting-ip': '203.0.113.7' },
      ),
      env,
      AGORA,
      ROTA_PALAVRAS,
      handlePalavras,
    )

    const inteira = JSON.stringify(await unicaLinha())

    for (const proibido of [
      'credencial-longa-do-dono',
      sessao.cookie,
      sessao.ficha,
      'Mozilla/5.0 (Teste)',
      '203.0.113.7',
    ]) {
      expect({ [proibido.slice(0, 24)]: inteira.includes(proibido) }).toEqual({
        [proibido.slice(0, 24)]: false,
      })
    }

    // Contrapositivo: o prefixo de 8 hex ESTA la — sem ele o teste passaria com
    // uma linha vazia, que nao prova nada sobre o que ela nao guarda.
    expect(inteira).toContain(await prefixoDeCredencial('credencial-longa-do-dono'))
  })

  test('AUD-03: tentativa recusada tambem registra, com antes = depois = NULL', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    // Baixar o intervalo ALARGA o alcance, e alargar exige step-up (§10.10).
    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=1',
      sessao,
    )

    expect(resposta.status).toBe(403)

    const linha = await unicaLinha()
    expect({
      acao: linha.acao,
      antes: linha.antes,
      depois: linha.depois,
      campos: linha.campos,
      versao: linha.versao,
    }).toEqual({
      acao: 'stepup_recusado',
      antes: null,
      depois: null,
      campos: '["userCooldownHours"]',
      // A versao continua a mesma: nada mudou.
      versao: 1,
    })

    // E a configuracao nao andou.
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(24)
  })

  test('AUD-04: o teto de 500 alcanca a linha que a gravacao acabou de escrever', async () => {
    // A mecanica da poda mora em `painel-parada.test.ts`. O que se afirma aqui e
    // que a linha do painel entra no MESMO teto, e que quem sai e a mais antiga.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    for (let inicio = 0; inicio < 500; inicio += 100) {
      await env.DB.batch(
        Array.from({ length: 100 }, (_, i) =>
          env.DB.prepare(
            `INSERT INTO painel_auditoria
               (id, ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
             VALUES (?, ?, 1, 'painel', 'migracao', 0, 'login', NULL, '[]', NULL, NULL)`,
          ).bind(inicio + i + 1, AGORA),
        ),
      )
    }

    await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
    )

    expect(await new PainelAuditoriaRepository(env.DB).podar()).toBe(1)

    const restantes = await env.DB.prepare(
      "SELECT COUNT(*) AS total, MIN(id) AS menor, SUM(acao = 'config_alterada') AS mudancas FROM painel_auditoria",
    ).first<{ total: number; menor: number; mudancas: number }>()

    expect(restantes).toEqual({ total: 500, menor: 2, mudancas: 1 })
  })

  test('AUD-05: NENHUM valor de configuracao vai para o console, nem gravando nem recusando', async () => {
    // §9.9: os dois destinos tem regras OPOSTAS. O D1 do dono guarda o estado
    // completo em `antes`/`depois`; o `console` recebe metodo, caminho, status e
    // codigo — nenhum valor, nunca.
    await gravarConfig(env.DB, { destination_url: `https://${DOMINIO_DE_TESTE}/pagina-secreta` })
    const sessao = await abrirSessao()

    const registrado = capturarConsole()
    try {
      await gravar(
        GRAVADORAS[1] as (typeof GRAVADORAS)[number],
        `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
        sessao,
      )
      // E o caminho de recusa, que e onde a tentacao de logar o valor e maior.
      await gravar(
        GRAVADORAS[2] as (typeof GRAVADORAS)[number],
        `destinationUrl=${encodeURIComponent(`https://${DOMINIO_DE_TESTE}/outra`)}`,
        sessao,
        { versao: 2 },
      )
    } finally {
      registrado.parar()
    }

    const tudo = registrado.linhas.join('\n')
    for (const valor of [
      PALAVRA_NOVA,
      'pagina-secreta',
      DOMINIO_DE_TESTE,
      'eu quero',
      'quero o link',
    ]) {
      expect({ [valor]: tudo.includes(valor) }).toEqual({ [valor]: false })
    }

    // Contrapositivo: o D1 guardou os mesmos valores que o console nao pode ter.
    const linhas = await auditoria()
    expect(JSON.stringify(linhas)).toContain(PALAVRA_NOVA)
  })

  test('AUD-06: desligar a automacao NAO exige step-up', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=desligar',
      sessao,
    )

    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe(`${ROTA_INICIO.caminho}?ok=desligada`)

    const linha = await linhaDeConfig()
    expect({ enabled: linha?.enabled, versao: linha?.versao }).toEqual({ enabled: 0, versao: 2 })
    expect((await unicaLinha()).acao).toBe('config_alterada')
  })

  test('AUD-07: religar tambem NAO exige step-up, e pede a confirmacao explicita', async () => {
    // §10.10: religar nao muda nenhum valor, so devolve a chave ao estado
    // anterior. Exigir biometria puniria quem acabou de usar o freio.
    await gravarConfig(env.DB, { enabled: 0, parado_por_codigo_em: AGORA })
    const sessao = await abrirSessao()

    const semConfirmar = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=ligar',
      sessao,
    )
    expect(semConfirmar.status).toBe(400)
    expect((await linhaDeConfig())?.enabled).toBe(0)
    // A confirmacao ausente e corpo malformado, e nao mudanca recusada: nada foi
    // julgado, e por isso nao ha linha nenhuma.
    expect(await auditoria()).toEqual([])

    const comConfirmar = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=ligar&confirmar=sim',
      sessao,
    )
    expect(comConfirmar.status).toBe(303)
    expect(comConfirmar.headers.get('location')).toBe(`${ROTA_INICIO.caminho}?ok=ligada`)
    expect((await linhaDeConfig())?.enabled).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// GRAV — a forma de §7.1, a atomicidade de §8.8 e a classificacao de §10.10
// ---------------------------------------------------------------------------

describe('GRAV — a forma da gravacao', () => {
  test('GRAV-01: toda rota de PAGINA com `escreve: true` responde 303 (§7.1)', async () => {
    // A outra metade da regra de forma. O laco vem da TABELA, e nao de tres
    // handlers escritos a mao: uma rota nova entra nele sozinha. O gemeo —
    // "toda rota com `escreve: false` executa zero escritas" — mora em
    // `painel-rotas.test.ts`.
    const dePagina = ROTAS.filter(
      (rota) => rota.escreve && !rota.caminho.startsWith('/painel/api/'),
    )

    // Contrapositivo: uma tabela sem rota de pagina que grava faria o laco
    // passar sem provar nada.
    expect(dePagina.map((rota) => rota.caminho)).toEqual(
      GRAVADORAS.map((gravadora) => gravadora.rota.caminho),
    )

    for (const alvo of GRAVADORAS) {
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB)
      const sessao = await abrirSessao()

      const resposta = await gravar(alvo, CORPO_VALIDO[alvo.rota.caminho] ?? '', sessao)

      expect({ [alvo.rota.caminho]: resposta.status }).toEqual({ [alvo.rota.caminho]: 303 })
      expect(resposta.headers.get('location')).toMatch(/^\/painel[^?]*\?ok=[a-z_]+$/)
    }
  })

  test('GRAV-02: a faixa verde nasce do `?ok=`, e a query string nunca vira conteudo', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const comOk = await despachar(
      pedir(`${ROTA_PALAVRAS.caminho}?ok=salvo`, { cookie: sessao.cookie }),
      env,
      AGORA,
      ROTA_PALAVRAS,
      handlePalavras,
    )
    expect(await comOk.text()).toContain(escapeHtml(CONFIRMACOES.salvo))

    // Um `?ok=` que nao esta na tabela nao mostra faixa nenhuma E nao aparece na
    // pagina: a frase vem da lista fechada, nunca da query string.
    const inventado = await despachar(
      pedir(`${ROTA_PALAVRAS.caminho}?ok=%3Cscript%3Ealert(1)%3C/script%3E`, {
        cookie: sessao.cookie,
      }),
      env,
      AGORA,
      ROTA_PALAVRAS,
      handlePalavras,
    )
    const corpo = await inventado.text()
    expect(corpo).not.toContain('alert(1)')
    expect(corpo).not.toContain('faixa-ok')
  })

  test('GRAV-03: `antes` e `depois` carregam o estado de comportamento COMPLETO, e nada alem', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    await gravar(GRAVADORAS[2] as (typeof GRAVADORAS)[number], 'userCooldownHours=48', sessao)

    const linha = await unicaLinha()
    const antes = JSON.parse(linha.antes ?? 'null') as Record<string, unknown>
    const depois = JSON.parse(linha.depois ?? 'null') as Record<string, unknown>

    // O conjunto EXATO de chaves nos dois, e ele e o de §9.9 — **na ordem**.
    // A ordem lexicografica nao e enfeite: e ela que torna `antes` e `depois`
    // dois JSON comparaveis como texto, e e a mesma que §10.10 vai exigir do
    // `json_canonico` do step-up. Comparar so o CONJUNTO deixaria a ordem livre.
    expect(Object.keys(antes)).toEqual([...CAMPOS_DE_COMPORTAMENTO])
    expect(Object.keys(depois)).toEqual([...CAMPOS_DE_COMPORTAMENTO])
    expect([...CAMPOS_DE_COMPORTAMENTO]).toEqual([...CAMPOS_DE_COMPORTAMENTO].sort())

    expect({ antes: antes.userCooldownHours, depois: depois.userCooldownHours }).toEqual({
      antes: 24,
      depois: 48,
    })

    // O que §9.9 mantem FORA: carimbo de linha e todo metadado de exibicao —
    // `legenda_curta` e recorte da `caption` do Reel, que esta na lista de
    // proibidos dos dois destinos (§15.4).
    for (const proibido of [
      'versao',
      'parado_por_codigo_em',
      'criado_em',
      'atualizado_em',
      'allowedMediaIds',
      'legenda_curta',
      'permalink',
      'caption',
      'media_url',
      'thumbnail_url',
    ]) {
      expect({ [proibido]: proibido in antes || proibido in depois }).toEqual({ [proibido]: false })
    }
  })

  test('GRAV-04: a config e a auditoria vao no MESMO lote — sem log, sem mudanca', async () => {
    // §8.8, regra de ouro. "Grava a config, depois tenta logar" passaria verde
    // em qualquer contagem que olhasse so o estado final, porque os dois lotes
    // gravam a mesma coisa. Aqui o SEGUNDO lote de escrita nao existe: o
    // primeiro `batch` e a LEITURA da configuracao, o segundo e a gravacao, e um
    // terceiro derruba a rota.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const contador = new D1Contador(env.DB)
    await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
      { ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    // §9.10: salvar uma tela global custa 1 lote e 2 escritas. Os lotes sao dois
    // porque a leitura da configuracao tambem e um.
    expect({ lotes: contador.batches, escritas: contador.escritas }).toEqual({
      lotes: 2,
      escritas: 2,
    })
    expect((await auditoria()).length).toBe(1)
  })

  test('GRAV-05: quando o lote da gravacao falha, NEM a config NEM a auditoria mudam', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const quebrado = new D1SegundoBatchQuebrado(env.DB)
    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await gravar(
        GRAVADORAS[1] as (typeof GRAVADORAS)[number],
        `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
        sessao,
        { ambiente: { ...env, DB: quebrado as unknown as D1Database } as typeof env },
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(500)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["eu quero","quero o link"]')
    expect(await auditoria()).toEqual([])
  })

  test('GRAV-06: a linha de auditoria NAO entra sem a mudanca que ela audita', async () => {
    // A metade contraria de "sem log, sem mudanca". Um `UPDATE` que perde a
    // trava otimista e um statement que RODOU sem alterar nada, e `db.batch()`
    // nao rejeita por isso: sem a condicao, a linha de auditoria commitaria
    // sozinha, afirmando um `antes`/`depois` que nunca aconteceu.
    //
    // O teste roda o statement na POSICAO em que ele vive — dentro de um lote,
    // logo depois da escrita que ele audita —, porque e so nessa posicao que
    // `changes()` responde sobre a escrita certa.
    await gravarConfig(env.DB, { versao: 7 })
    const repositorio = new PainelAuditoriaRepository(env.DB)

    const evento = {
      ocorridoEm: AGORA,
      versao: 8,
      origem: 'painel' as const,
      ator: 'passkey:00000000',
      stepUp: false,
      acao: 'config_alterada' as const,
      alvo: null,
      campos: '["enabled"]',
      antes: '{}',
      depois: '{}',
    }

    const gravacaoQuePerde = env.DB.prepare(
      'UPDATE painel_config SET versao = 8 WHERE id = 1 AND versao = 6',
    )
    await env.DB.batch([
      gravacaoQuePerde,
      repositorio.statementDeRegistro(evento, { presoAMudanca: true }),
    ])
    expect(await auditoria()).toEqual([])

    // Contrapositivo, sem o qual um `WHERE` sempre falso passaria verde.
    const gravacaoQueGanha = env.DB.prepare(
      'UPDATE painel_config SET versao = 8 WHERE id = 1 AND versao = 7',
    )
    await env.DB.batch([
      gravacaoQueGanha,
      repositorio.statementDeRegistro(evento, { presoAMudanca: true }),
    ])
    expect((await auditoria()).length).toBe(1)
  })

  test('GRAV-19: perdendo a trava DENTRO do lote, nem a config nem a auditoria mudam', async () => {
    // O caso que o `WHERE` de §8.8 existe para cobrir, montado de ponta a ponta:
    // alguem grava entre a leitura da versao e o lote. O `UPDATE` vira um no-op
    // de zero linhas — e `db.batch()` NAO rejeita por isso.
    //
    // Este teste ja encontrou um defeito real: a primeira grafia da condicao da
    // auditoria comparava `versao` e `atualizado_em` da linha de config, e o
    // escritor concorrente satisfazia os dois. A linha de auditoria entrava
    // afirmando uma mudanca que nao aconteceu.
    await gravarConfig(env.DB, { versao: 1 })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
      { ambiente: { ...env, DB: new D1QueCorreNaFrente(env.DB) } as unknown as typeof env },
    )

    expect(resposta.status).toBe(409)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["eu quero","quero o link"]')
    expect(await auditoria()).toEqual([])
  })

  test('GRAV-07: a trava otimista recusa a versao velha com 409 e ZERO escritas', async () => {
    await gravarConfig(env.DB, { versao: 3 })
    const sessao = await abrirSessao()

    const contador = new D1Contador(env.DB)
    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
      { versao: 2, ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    expect(resposta.status).toBe(409)
    expect(await resposta.text()).toContain('A configuração mudou em outro lugar')
    expect(contador.escritas).toBe(0)
    expect(await auditoria()).toEqual([])
  })

  test('GRAV-08: a primeira gravacao MATERIALIZA a linha, com a versao 0 do arquivo', async () => {
    // Sem linha, `carregarConfigEfetiva` devolve `origem: 'arquivo'` e
    // `versao: 0` (§8.3). O `INSERT` do `upsert` e o unico ramo em que a versao
    // nao vem de `versao + 1`.
    const sessao = await abrirSessao()
    expect(await linhaDeConfig()).toBeNull()

    const resposta = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=desligar',
      sessao,
      {
        versao: 0,
      },
    )

    expect(resposta.status).toBe(303)
    const linha = await linhaDeConfig()
    expect({ enabled: linha?.enabled, versao: linha?.versao }).toEqual({ enabled: 0, versao: 1 })
    expect((await unicaLinha()).versao).toBe(1)
  })

  test('GRAV-09: o corpo com campo desconhecido e recusado, e sem tocar no D1', async () => {
    // §11.3 passo 6: na entrada vinda de humano, estranheza e erro de digitacao
    // ou cliente adulterado. A recusa vem ANTES de qualquer leitura, e por isso
    // ela e a unica que NAO deixa linha: nada do conteudo chegou a ser julgado.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const contador = new D1Contador(env.DB)
    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      'triggerKeywords=oi&campoInventado=1',
      sessao,
      { ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    expect(resposta.status).toBe(400)
    // UMA consulta, e ela e a linha de sessao do passo 9 da escada, que
    // `despachar` ja fez antes de chamar o handler. A LEITURA DA CONFIGURACAO
    // nao aconteceu: o campo desconhecido e recusado antes dela, na cota que o
    // painel divide com o webhook.
    expect({ prepares: contador.prepares, escritas: contador.escritas }).toEqual({
      prepares: 1,
      escritas: 0,
    })
    expect(contador.sqls.some((sql) => sql.includes('painel_config'))).toBe(false)
  })

  test('GRAV-10: campo ainda nao gravavel e recusado com 400 e `mudanca_recusada`', async () => {
    // Estreitar o alcance NAO exige step-up (§10.10), mas `matchMode` ainda nao
    // e gravavel nesta etapa. A recusa e explicita — nunca campo ignorado em
    // silencio, que seria a mudanca que acontece sem a pessoa ver.
    await gravarConfig(env.DB, { match_mode: 'contains', trigger_keywords: '["quero o link"]' })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'matchMode=exact',
      sessao,
    )

    expect(resposta.status).toBe(400)
    expect({ acao: (await unicaLinha()).acao, campos: (await unicaLinha()).campos }).toEqual({
      acao: 'mudanca_recusada',
      campos: '["matchMode"]',
    })
    expect((await linhaDeConfig())?.match_mode).toBe('contains')
  })

  test('GRAV-11: campo protegido e recusado com 403, mesmo junto de um campo permitido', async () => {
    // §10.10: se QUALQUER campo do lote exige step-up, o lote inteiro exige — e
    // gravacao parcial e impossivel.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      `userCooldownHours=48&destinationUrl=${encodeURIComponent(`https://${DOMINIO_DE_TESTE}/novo`)}`,
      sessao,
    )

    expect(resposta.status).toBe(403)
    expect((await unicaLinha()).acao).toBe('stepup_recusado')
    // Nem o campo permitido do mesmo lote foi gravado.
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(24)
  })

  test('GRAV-12: o cooldown sobe; descer e recusado — a direcao decide, nao o campo', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    const subindo = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=48',
      sessao,
    )
    expect(subindo.status).toBe(303)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(48)

    const descendo = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=24',
      sessao,
      { versao: 2 },
    )
    expect(descendo.status).toBe(403)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(48)
  })

  test('GRAV-13: reenviar o mesmo valor nao grava nada e diz que nada mudou', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    const contador = new D1Contador(env.DB)
    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=24',
      sessao,
      { ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe(`${ROTA_AJUSTES.caminho}?ok=sem_mudanca`)
    expect(contador.escritas).toBe(0)
    expect(await auditoria()).toEqual([])

    // A mesma coisa com a LISTA de palavras, que e o campo em que "igual"
    // precisa ser comparado item a item: uma comparacao por referencia acharia
    // que toda visita mudou as palavras e gravaria uma versao por reenvio.
    const listaIgual = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('eu quero\nquero o link')}`,
      sessao,
      { ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    expect(listaIgual.headers.get('location')).toBe(`${ROTA_PALAVRAS.caminho}?ok=sem_mudanca`)
    expect(contador.escritas).toBe(0)
    expect(await auditoria()).toEqual([])
  })

  test('GRAV-14: com a configuracao salva ilegivel, a gravacao e recusada e a linha do dono fica', async () => {
    // O snapshot em vigor e a FABRICA desligada, e nao a linha do dono. Gravar
    // aqui escreveria valores de fabrica por cima do que o dono salvou — o
    // "inventar um substituto para o valor recusado" que §12.6 e §9.2 proibem.
    // O `CHECK` da migration cobre `match_mode` e os booleanos; `destination_url`
    // so tem teto de tamanho, e e por isso que ele e o campo que consegue chegar
    // ao banco invalido e reprovar no validador — exatamente o caso que §9.9
    // descreve: uma escrita feita FORA do painel.
    await gravarConfig(env.DB, { destination_url: 'isto-nao-e-um-endereco' })
    const sessao = await abrirSessao()

    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await gravar(
        GRAVADORAS[1] as (typeof GRAVADORAS)[number],
        `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
        sessao,
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(400)
    expect((await unicaLinha()).acao).toBe('mudanca_recusada')
    // A linha do dono continua exatamente como estava, inclusive a versao — e,
    // principalmente, o valor de fabrica NAO foi escrito por cima dela.
    const linha = await linhaDeConfig()
    expect({ destination_url: linha?.destination_url, versao: linha?.versao }).toEqual({
      destination_url: 'isto-nao-e-um-endereco',
      versao: 1,
    })
  })

  test('GRAV-15: a palavra salva vale na hora, sem redeploy — o cache do isolate cai', async () => {
    // A verificacao do dono desta etapa, inteira: "muda uma palavra-gatilho pelo
    // celular e ve valer sem redeploy".
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    // Enche o cache do isolate com o valor ANTIGO, como o webhook faria.
    const antes = await carregarConfigEfetiva(env, AGORA)
    expect(antes.global.triggerKeywords).toEqual(['eu quero', 'quero o link'])

    await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
    )

    // SEM `invalidarCacheDeConfig()` no teste, e SEM `ignorarCache`: e o proprio
    // caminho quente do webhook perguntando de novo, no mesmo instante.
    const depois = await carregarConfigEfetiva(env, AGORA)
    expect(depois.global.triggerKeywords).toEqual([PALAVRA_NOVA])
  })

  test('GRAV-16: o historico mostra o valor anterior, e o botao volta a ele pela rota normal', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
    )

    // Duas linhas que o historico da tela de Ajustes NAO pode mostrar: uma de
    // outra entidade (a mudanca de um Reel, que chega na etapa das midias) e uma
    // cujo `antes` esta truncado. A primeira nao e desta tela; a segunda nao da
    // para reenviar, e um botao que posta um corpo pela metade e pior que
    // nenhum botao.
    await env.DB.prepare(
      `INSERT INTO painel_auditoria
         (ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
       VALUES (?, 2, 'painel', 'passkey:00000000', 0, 'midia_alterada', '17900000000000000',
               '["enabled"]', '{"enabled":false}', '{"enabled":true}')`,
    )
      .bind(AGORA)
      .run()

    const corpo = await telaDeAjustes(sessao)

    expect(corpo).not.toContain('17900000000000000')
    // Nem como linha ilegivel: a de midia nao e desta tela, e nao aparece de
    // jeito nenhum. Sem esta linha, tirar o filtro de `acao` da consulta
    // passaria verde — a linha entraria e so ficaria sem botao.
    expect(corpo).not.toContain('conseguimos ler o que estava salvo')
    // Uma linha so no historico: a de `config_alterada`.
    expect(corpo.split('Voltar a esta vers').length - 1).toBe(1)

    expect(corpo).toContain('Voltar a esta vers')
    // O valor ANTERIOR esta na tela, em campo escondido, pronto para reenvio.
    expect(corpo).toContain(escapeHtml('eu quero\nquero o link'))

    // O botao reenvia o `antes` INTEIRO pela rota normal de gravacao (Ruling 55):
    // nao ha rota de restauracao, e por isso o mesmo validador, a mesma allowlist
    // de hoje e a mesma classificacao de risco valem para ele.
    const volta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      camposDoBotaoDeVoltar(corpo),
      sessao,
      { versao: 2 },
    )

    expect(volta.status).toBe(303)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["eu quero","quero o link"]')
  })

  test('GRAV-18: a restauracao de uma versao com campo protegido e recusada hoje', async () => {
    // A consequencia aceita de Ruling 55, e ela e a mesma forma da recusa que
    // §9.9 ja declara certa: o botao passa pelo funil normal, entao uma versao
    // cujo `antes` carregue campo de step-up e recusada — e passa a funcionar na
    // etapa do step-up sem que o botao mude.
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    // Subir o intervalo e a direcao segura, entao esta gravacao passa.
    await gravar(GRAVADORAS[2] as (typeof GRAVADORAS)[number], 'userCooldownHours=48', sessao)

    // Voltar a esta versao DESCE o intervalo de volta para 24, e descer alarga.
    const volta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      camposDoBotaoDeVoltar(await telaDeAjustes(sessao)),
      sessao,
      { versao: 2 },
    )

    expect(volta.status).toBe(403)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(48)
    expect((await auditoria()).map((linha) => linha.acao)).toEqual([
      'config_alterada',
      'stepup_recusado',
    ])
  })

  test('GRAV-20: a caixa de texto e uma palavra por linha, e linha em branco nao vira palavra', async () => {
    // Descartar a linha vazia e ler o FORMATO da caixa de texto — e o Enter que
    // a pessoa deu antes de escrever a proxima —, e nao consertar um valor. O
    // item que fica vazio DEPOIS da normalizacao (so pontuacao, so emoji) chega
    // inteiro ao validador, que o recusa; e esse o contrapositivo do fim.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('  quero o cardapio  \n\n   \nquero a tabela\n')}`,
      sessao,
    )

    expect(resposta.status).toBe(303)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["quero o cardapio","quero a tabela"]')

    // E o que NAO e conserto: uma palavra que normaliza para vazio e RECUSADA,
    // nunca descartada em silencio.
    const soPontuacao = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('quero o cardapio\n!!!')}`,
      sessao,
      { versao: 2 },
    )
    expect(soPontuacao.status).toBe(400)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["quero o cardapio","quero a tabela"]')
  })

  test('GRAV-17: o Inicio mostra a chave, e a data da parada quando ela existe', async () => {
    await gravarConfig(env.DB, { enabled: 0, parado_por_codigo_em: AGORA })
    const sessao = await abrirSessao()

    const corpo = await (
      await despachar(
        pedir(ROTA_INICIO.caminho, { cookie: sessao.cookie }),
        env,
        AGORA,
        ROTA_INICIO,
        handleInicio,
      )
    ).text()

    expect(corpo).toContain(`action="${ROTA_CHAVE.caminho}"`)
    expect(corpo).toContain('name="acao" value="ligar"')
    expect(corpo).toContain('14/11/2023')
    // A ficha viaja no campo escondido, nunca na query string (§10.9).
    expect(corpo).toContain(`name="csrf" value="${sessao.ficha}"`)
  })
})
