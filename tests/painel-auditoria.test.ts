import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { PainelAuditoriaRepository } from '../src/repositories/painel-auditoria-repository'
import { escapeHtml } from '../src/routes/legal'
import { handleAjustes } from '../src/routes/painel/ajustes'
import {
  CONFIRMACOES,
  fraseDeConfirmacao,
  MOTIVO_DA_RECUSA,
  NOME_DO_CAMPO,
  PALAVRAS_PROIBIDAS,
} from '../src/routes/painel/dicionario'
import { CAMPOS_DE_COMPORTAMENTO, codigoDaRecusaDeValidacao } from '../src/routes/painel/gravar'
import { handleChave, handleInicio } from '../src/routes/painel/inicio'
import { handlePalavras } from '../src/routes/painel/palavras'
import { erro } from '../src/routes/painel/resposta'
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
import { gravarConfig, ligarConta, limparBanco } from './fixtures/banco'
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

/**
 * O primeiro `<form method="post">` da pagina, ja lido em campos.
 *
 * Existe para o unico teste que fecha o elo entre a tela e o funil: todos os
 * outros montam o corpo a mao, e um campo escondido apagado do formulario
 * passaria despercebido por todos eles.
 *
 * A extracao e boba de proposito — os formularios do painel nao tem `<select>`,
 * nem `textarea` fora do de palavras, nem campo repetido. Um parser esperto aqui
 * seria uma segunda implementacao de navegador para manter.
 */
function primeiroFormularioDeGravacao(corpo: string): {
  action: string
  campos: URLSearchParams
} {
  const pedaco = corpo.split('<form').find((parte) => parte.includes('method="post"')) ?? ''
  const action = /action="([^"]*)"/.exec(pedaco)?.[1] ?? ''
  const campos = new URLSearchParams()

  for (const [, nome, valor] of pedaco.matchAll(/name="([a-zA-Z]+)" value="([^"]*)"/g)) {
    campos.set(nome ?? '', desescapar(valor ?? ''))
  }

  // O que o navegador manda de um `<textarea>` e o conteudo dele.
  const area = /<textarea[^>]*name="([a-zA-Z]+)"[^>]*>([\s\S]*?)<\/textarea>/.exec(pedaco)
  if (area !== null) campos.set(area[1] ?? '', desescapar(area[2] ?? ''))

  // E de um grupo de radios, o valor do que estiver marcado.
  for (const [, nome, valor] of pedaco.matchAll(/name="([a-zA-Z]+)" value="([^"]*)" checked/g)) {
    campos.set(nome ?? '', valor ?? '')
  }

  // E de um `<input type="number">`, o `value` dele.
  const numero = /<input type="number"[^>]*name="([a-zA-Z]+)"[^>]*\nvalue="([^"]*)"/.exec(pedaco)
  if (numero !== null) campos.set(numero[1] ?? '', numero[2] ?? '')

  return { action, campos }
}

/** A palavra aparece com fronteira de palavra? Substring nao conta (§12.7). */
function contemPalavraNoCorpo(corpo: string, palavra: string): boolean {
  const escapada = palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '\\x2d')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapada}([^\\p{L}\\p{N}]|$)`, 'iu').test(corpo)
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

  test('AUD-08: a linha de uma recusa carrega os SEIS campos de §9.9, nao so a acao', async () => {
    // AUD-01 afirma origem, ator, step_up e alvo no caminho de sucesso; o
    // caminho de RECUSA ficava com quatro deles descobertos, e trocar
    // `origem: painel` por `assistente` passava na suite inteira.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao('credencial-da-recusa')

    await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      `destinationUrl=${encodeURIComponent(`https://${DOMINIO_DE_TESTE}/outro`)}`,
      sessao,
    )

    const linha = await unicaLinha()
    expect({
      ocorrido_em: linha.ocorrido_em,
      versao: linha.versao,
      origem: linha.origem,
      ator: linha.ator,
      step_up: linha.step_up,
      acao: linha.acao,
      alvo: linha.alvo,
      campos: linha.campos,
      antes: linha.antes,
      depois: linha.depois,
    }).toEqual({
      ocorrido_em: AGORA,
      // A versao NAO anda numa recusa: nada mudou.
      versao: 1,
      origem: 'painel',
      ator: `passkey:${await prefixoDeCredencial('credencial-da-recusa')}`,
      // `step_up: 0` porque nao houve reautenticacao nenhuma — e este e o campo
      // que responde "essa troca foi autorizada com a passkey presente?" numa
      // investigacao (§9.9).
      step_up: 0,
      acao: 'stepup_recusado',
      // `alvo` e `NULL` na configuracao global: ele nomeia a MIDIA, e so ela.
      alvo: null,
      campos: '["destinationUrl"]',
      antes: null,
      depois: null,
    })
  })

  test('AUD-09: nem o corpo malformado leva valor de configuracao para o console', async () => {
    // O caminho que AUD-05 nao cobria. Ele e o mais tentador de todos: o corpo
    // inteiro esta na mao, e `motivoInterno` vai direto para o `console.warn`.
    // §9.9 nao abre excecao — nenhum valor, nunca, nos Workers Logs.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const segredos = [
      'quero o cardapio secreto',
      `https://${DOMINIO_DE_TESTE}/promocao-que-ninguem-viu`,
      'Ola! Aqui esta o link que voce pediu',
    ]

    const registrado = capturarConsole()
    try {
      await gravar(
        GRAVADORAS[1] as (typeof GRAVADORAS)[number],
        [
          `triggerKeywords=${encodeURIComponent(segredos[0] as string)}`,
          `destinationUrl=${encodeURIComponent(segredos[1] as string)}`,
          `privateReplyText=${encodeURIComponent(segredos[2] as string)}`,
          'campoInventado=1',
        ].join('&'),
        sessao,
      )
    } finally {
      registrado.parar()
    }

    const tudo = registrado.linhas.join('\n')
    for (const segredo of segredos) {
      expect({ [segredo.slice(0, 20)]: tudo.includes(segredo) }).toEqual({
        [segredo.slice(0, 20)]: false,
      })
    }

    // Contrapositivo: a linha do log EXISTE, com o codigo e o motivo em
    // snake_case. Sem ela o teste passaria com um `console` mudo, que nao prova
    // nada sobre o que ele nao escreve.
    expect(tudo).toContain('400 dados_invalidos campo_desconhecido')
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
    // A confirmacao ausente e uma mudanca JULGADA e recusada: a linha existe,
    // com `antes = depois = NULL` e o campo que ela tentou mexer.
    const recusada = await unicaLinha()
    expect({ acao: recusada.acao, campos: recusada.campos, antes: recusada.antes }).toEqual({
      acao: 'mudanca_recusada',
      campos: '["enabled"]',
      antes: null,
    })
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

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
    // Duas consultas: a linha de sessao, que `despachar` ja fez antes de chamar
    // o handler, e a linha de auditoria da recusa (Ruling 59). A LEITURA DA
    // CONFIGURACAO nao aconteceu: o campo desconhecido e recusado antes dela, na
    // cota que o painel divide com o webhook.
    expect({ prepares: contador.prepares, escritas: contador.escritas }).toEqual({
      prepares: 2,
      escritas: 1,
    })
    expect(contador.sqls.some((sql) => sql.includes('painel_config'))).toBe(false)

    // Ruling 59: numa sessao autenticada, um corpo que nem da para julgar e o
    // sinal mais parecido com sequestro deste conjunto, e §9.9 diz que a linha
    // existe para uma sequencia dessas nao passar sem rastro. `versao: 0` porque
    // nada foi lido — o mesmo `0` de `codigos_gerados`.
    const linha = await unicaLinha()
    expect({ acao: linha.acao, versao: linha.versao, campos: linha.campos }).toEqual({
      acao: 'mudanca_recusada',
      versao: 0,
      campos: '[]',
    })
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

  test('GRAV-21: `enabled=sim` por QUALQUER tela precisa da confirmacao de §10.12', async () => {
    // A falha que a rodada 1 de revisao encontrou: `enabled` e campo gravavel,
    // entao a confirmacao conferida so em `handleChave` era contornavel por
    // `POST /painel/ajustes` — e alcancavel pela propria UI, porque o botao
    // "Voltar a esta versao" reenvia TODOS os campos, `enabled` incluso. Um
    // clique desfazia a parada de emergencia, sem confirmacao e sem a data.
    await gravarConfig(env.DB, { enabled: 0, parado_por_codigo_em: AGORA })
    const sessao = await abrirSessao()

    const semConfirmar = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'enabled=sim',
      sessao,
    )

    expect(semConfirmar.status).toBe(400)
    expect((await linhaDeConfig())?.enabled).toBe(0)
    expect((await unicaLinha()).acao).toBe('mudanca_recusada')
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

    // E a mesma rota, com o gesto: liga. A confirmacao e um campo estrutural de
    // TODA rota, e nao um privilegio de `/painel/chave`.
    const comConfirmar = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'enabled=sim&confirmar=sim',
      sessao,
    )
    expect(comConfirmar.status).toBe(303)
    expect((await linhaDeConfig())?.enabled).toBe(1)

    // DESLIGAR pela mesma rota continua sendo um gesto so: §10.10 e explicito, e
    // a parada de emergencia depende de desligar ser barato.
    const desligando = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'enabled=nao',
      sessao,
      { versao: 2 },
    )
    expect(desligando.status).toBe(303)
    expect((await linhaDeConfig())?.enabled).toBe(0)
  })

  test('GRAV-22: o formulario que a tela RENDERIZA e aceito pelo funil que o le', async () => {
    // O elo que faltava. Todos os outros testes montam o corpo a mao, entao
    // apagar um campo escondido do formulario deixava a suite verde enquanto em
    // producao toda gravacao de toda tela passava a ser recusada. Aqui o corpo
    // sai do HTML de verdade, campo por campo.
    for (const tela of [
      { rota: ROTA_INICIO, handler: handleInicio, alvo: GRAVADORAS[0] },
      { rota: ROTA_PALAVRAS, handler: handlePalavras, alvo: GRAVADORAS[1] },
      { rota: ROTA_AJUSTES, handler: handleAjustes, alvo: GRAVADORAS[2] },
    ]) {
      // Cada tela parte do mesmo estado: o formulario do Inicio DESLIGA a
      // automacao, e sem o reset a versao andaria por baixo das seguintes.
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB)
      await ligarConta(env, AGORA)
      const sessao = await abrirSessao()

      const corpo = await (
        await despachar(
          pedir(tela.rota.caminho, { cookie: sessao.cookie }),
          env,
          AGORA,
          tela.rota,
          tela.handler,
        )
      ).text()

      const formulario = primeiroFormularioDeGravacao(corpo)
      // O formulario existe e carrega os dois campos escondidos que o funil
      // exige. Sem esta afirmacao, uma tela sem formulario nenhum passaria.
      expect(formulario.action).toBe((tela.alvo as (typeof GRAVADORAS)[number]).rota.caminho)
      expect(formulario.campos.get('csrf')).toBe(sessao.ficha)
      expect(formulario.campos.get('versao')).toBe('1')

      // E o corpo do formulario, EXATAMENTE como o navegador o enviaria, e
      // aceito: nenhum campo escondido a mais, nenhum a menos.
      const resposta = await despachar(
        postar(formulario.action, formulario.campos.toString(), sessao),
        env,
        AGORA,
        (tela.alvo as (typeof GRAVADORAS)[number]).rota,
        (tela.alvo as (typeof GRAVADORAS)[number]).handler,
      )

      expect({ [tela.rota.caminho]: resposta.status }).toEqual({ [tela.rota.caminho]: 303 })
      // E o `303` aponta para a tela com um `?ok=` da lista fechada — nunca uma
      // recusa. O Inicio desliga (o formulario dele e o botao de desligar); as
      // outras duas reenviam o que ja estava salvo.
      const ok = new URL(resposta.headers.get('location') ?? '', RAIZ).searchParams.get('ok')
      expect({ [tela.rota.caminho]: fraseDeConfirmacao(ok) !== null }).toEqual({
        [tela.rota.caminho]: true,
      })
    }
  })

  test('GRAV-23: a recusa NOMEIA o campo e diz por que, na lingua do dono (§12.4)', async () => {
    // "Confira os campos destacados" sem destacar campo nenhum e a frase mais
    // inutil que o painel poderia escrever. §11.4 fixa a frase; §12.4 exige o
    // campo e o motivo, e as duas coisas convivem em camadas diferentes.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('a')}`,
      sessao,
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(400)
    expect(corpo).toContain(escapeHtml('Confira os campos destacados.'))
    // O campo, com o NOME do dicionario — nunca `triggerKeywords` cru.
    expect(corpo).toContain(escapeHtml(NOME_DO_CAMPO.triggerKeywords))
    // O nome tecnico aparece SO como `name=` do rascunho que volta, nunca como
    // texto que a pessoa le. O laco confere cada ocorrencia, e nao a ausencia:
    // a ausencia deixaria de valer no dia em que o rascunho passasse a existir —
    // que e exatamente o que aconteceu.
    for (const posicao of [...corpo.matchAll(/triggerKeywords/g)].map((a) => a.index ?? 0)) {
      expect({ [posicao]: corpo.slice(posicao - 6, posicao) }).toEqual({ [posicao]: 'name="' })
    }
    // E o motivo de §12.4.
    expect(corpo).toContain(escapeHtml(MOTIVO_DA_RECUSA.gatilho_curto as string))

    // A pagina de recusa obedece §12.1 como qualquer outra tela: nenhuma das
    // palavras proibidas. E o motivo de a traducao ser pelo CODIGO do achado — a
    // `mensagem` do validador diz "no modo contains", e `contains` esta na lista.
    for (const proibida of PALAVRAS_PROIBIDAS) {
      expect({ [proibida]: contemPalavraNoCorpo(corpo, proibida) }).toEqual({ [proibida]: false })
    }
  })

  test('GRAV-24: o `409` devolve o rascunho que a pessoa digitou (§8.8)', async () => {
    await gravarConfig(env.DB, { versao: 3 })
    const sessao = await abrirSessao()

    const rascunho = 'quero o cardapio\nquero a tabela'
    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(rascunho)}`,
      sessao,
      { versao: 2 },
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(409)
    expect(corpo).toContain(escapeHtml('A configuração mudou em outro lugar; recarregue a tela.'))
    // O que a pessoa escreveu volta na tela, inteiro.
    expect(corpo).toContain(escapeHtml(rascunho))
    // Com a versao de AGORA, para que reenviar funcione em vez de bater na
    // mesma trava para sempre.
    expect(corpo).toContain('name="versao" value="3"')
    expect(corpo).toContain(`action="${ROTA_PALAVRAS.caminho}"`)

    // E reenviar o rascunho daquela pagina grava mesmo.
    const formulario = primeiroFormularioDeGravacao(corpo)
    const segunda = await despachar(
      postar(formulario.action, formulario.campos.toString(), sessao),
      env,
      AGORA,
      ROTA_PALAVRAS,
      handlePalavras,
    )
    expect(segunda.status).toBe(303)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["quero o cardapio","quero a tabela"]')
  })

  test('GRAV-31: o `409` da CHAVE posta de volta para /painel/chave, e nao para /painel', async () => {
    // O irmao do GRAV-24, e a rota em que o defeito era visivel. `pedido.para` e
    // a tela para onde o `303` aponta; em Palavras e Ajustes ela coincide com o
    // caminho do POST, e em `/painel/chave` NAO: o `303` dela vai para `/painel`,
    // que e `GET` e so `GET`, para sempre (§7.1). Com o `action` errado, o botao
    // de recuperacao morria em `405` — na rota que desliga a automacao.
    await gravarConfig(env.DB, { enabled: 1, versao: 3 })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=desligar',
      sessao,
      { versao: 2 },
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(409)
    expect(corpo).toContain(`action="${ROTA_CHAVE.caminho}"`)
    expect(corpo).not.toContain(`action="${ROTA_INICIO.caminho}"`)

    // E o botao FUNCIONA: postar o formulario daquela pagina desliga mesmo, em
    // vez de bater no `405 metodo_nao_permitido` de uma rota so de leitura.
    const formulario = primeiroFormularioDeGravacao(corpo)
    const segunda = await despachar(
      postar(formulario.action, formulario.campos.toString(), sessao),
      env,
      AGORA,
      ROTA_CHAVE,
      handleChave,
    )

    expect(segunda.status).toBe(303)
    expect((await linhaDeConfig())?.enabled).toBe(0)
  })

  test('GRAV-32: o rascunho do `409` NAO carrega a confirmacao de §10.12', async () => {
    // §8.8 desenhou o incremento de versao exatamente para o caso da parada de
    // emergencia disparar com o formulario aberto: "obrigado a recarregar e ver,
    // em letras grandes, que a automacao foi parada e desde quando". Carregar a
    // confirmacao pelo `409` seria o unico caminho em que aquele gesto e
    // CARREGADO em vez de FEITO — religar num clique sem ver a parada mais nova.
    await gravarConfig(env.DB, { enabled: 0, versao: 3 })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=ligar&confirmar=sim',
      sessao,
      { versao: 2 },
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(409)
    // A acao volta — ela e o que a pessoa pediu.
    expect(corpo).toContain('name="acao" value="ligar"')
    // O GESTO nao volta.
    expect(corpo).not.toContain('name="confirmar"')

    // E a prova de que a ausencia MORDE: reenviar o formulario daquela pagina
    // nao liga a automacao.
    const formulario = primeiroFormularioDeGravacao(corpo)
    const segunda = await despachar(
      postar(formulario.action, formulario.campos.toString(), sessao),
      env,
      AGORA,
      ROTA_CHAVE,
      handleChave,
    )

    expect(segunda.status).toBe(400)
    expect((await linhaDeConfig())?.enabled).toBe(0)
  })

  test('GRAV-33: a recusa de CONTEUDO tambem devolve o rascunho, e sem botao que falha', async () => {
    // Perder vinte palavras digitadas num celular porque uma ficou curta demais
    // e pior do que perde-las por causa de uma aba aberta em outro aparelho. O
    // rascunho volta; o BOTAO nao, porque reenviar o mesmo rascunho bate na
    // mesma recusa — e um botao que sempre falha e a promessa quebrada que o
    // rascunho existe para consertar.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const rascunho = 'quero o cardapio\nquero a tabela\na'
    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(rascunho)}`,
      sessao,
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(400)
    expect(corpo).toContain(escapeHtml(rascunho))
    expect(corpo).not.toContain('<button type="submit"')

    // O `409` continua com botao: la reenviar FUNCIONA, porque a trava era de
    // concorrencia e o rascunho volta com a versao de agora.
    await env.DB.prepare('UPDATE painel_config SET versao = 9 WHERE id = 1').run()
    invalidarCacheDeConfig()
    const conflito = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('quero o cardapio')}`,
      sessao,
      { versao: 8 },
    )
    expect(await conflito.text()).toContain('<button type="submit"')
  })

  test('GRAV-34: a recusa por campo protegido tambem guarda o rascunho', async () => {
    // O `403` de step-up e uma recusa de CONTEUDO como as outras: o que a pessoa
    // digitou no mesmo envio nao pode sumir so porque um dos campos do lote
    // exigia a digital. Vale mais aqui do que em qualquer outro lugar, porque na
    // etapa do step-up este e o caminho que passa a ter continuacao.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      [
        'userCooldownHours=48',
        `destinationUrl=${encodeURIComponent(`https://${DOMINIO_DE_TESTE}/novo`)}`,
      ].join('&'),
      sessao,
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(403)
    expect(corpo).toContain('name="userCooldownHours" value="48"')
    expect(corpo).toContain(escapeHtml(`https://${DOMINIO_DE_TESTE}/novo`))
  })

  test('GRAV-25: a tabela de §10.10 inteira — o que alarga pede a digital, o que estreita nao', async () => {
    // A enumeracao fechada de §10.10, entrada por entrada, nas DUAS direcoes.
    // A rodada 1 de revisao mostrou que so tres das sete estavam exercidas:
    // `mediaScope`, `processOnlyReels` e os dois textos passavam com a
    // classificacao desligada.
    const ALARGAM: readonly { campo: string; corpo: string; partida: Record<string, unknown> }[] = [
      { campo: 'matchMode', corpo: 'matchMode=contains', partida: { match_mode: 'exact' } },
      {
        campo: 'userCooldownHours',
        corpo: 'userCooldownHours=1',
        partida: { user_cooldown_hours: 24 },
      },
      { campo: 'mediaScope', corpo: 'mediaScope=todas', partida: { media_scope: 'selecionadas' } },
      {
        campo: 'processOnlyReels',
        corpo: 'processOnlyReels=nao',
        partida: { process_only_reels: 1 },
      },
      {
        campo: 'destinationUrl',
        corpo: `destinationUrl=${encodeURIComponent(`https://${DOMINIO_DE_TESTE}/outro`)}`,
        partida: {},
      },
      {
        campo: 'privateReplyText',
        corpo: `privateReplyText=${encodeURIComponent('Outro texto com o {link}')}`,
        partida: {},
      },
      {
        campo: 'publicReplyText',
        corpo: `publicReplyText=${encodeURIComponent('Outro texto publico.')}`,
        partida: {},
      },
    ]

    for (const caso of ALARGAM) {
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB, caso.partida)
      const sessao = await abrirSessao()

      const resposta = await gravar(
        GRAVADORAS[2] as (typeof GRAVADORAS)[number],
        caso.corpo,
        sessao,
      )

      expect({ [caso.campo]: resposta.status }).toEqual({ [caso.campo]: 403 })
      expect({ [caso.campo]: (await unicaLinha()).acao }).toEqual({
        [caso.campo]: 'stepup_recusado',
      })
    }

    // E o contrapositivo, que e a promessa do rodape dos Ajustes: ESTREITAR
    // nunca pede a digital. Os dois campos abaixo ainda nao sao gravaveis, entao
    // a recusa e `400 dados_invalidos` — e nao o `403` de quem alarga.
    const ESTREITAM: readonly { campo: string; corpo: string; partida: Record<string, unknown> }[] =
      [
        { campo: 'matchMode', corpo: 'matchMode=exact', partida: { match_mode: 'contains' } },
        {
          campo: 'mediaScope',
          corpo: 'mediaScope=selecionadas',
          partida: { media_scope: 'todas' },
        },
        {
          campo: 'processOnlyReels',
          corpo: 'processOnlyReels=sim',
          partida: { process_only_reels: 0 },
        },
      ]

    for (const caso of ESTREITAM) {
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB, { trigger_keywords: '["quero o link"]', ...caso.partida })
      const sessao = await abrirSessao()

      const resposta = await gravar(
        GRAVADORAS[2] as (typeof GRAVADORAS)[number],
        caso.corpo,
        sessao,
      )

      expect({ [caso.campo]: resposta.status }).toEqual({ [caso.campo]: 400 })
      expect({ [caso.campo]: (await unicaLinha()).acao }).toEqual({
        [caso.campo]: 'mudanca_recusada',
      })
    }
  })

  test('GRAV-26: `codigoDaRecusaDeValidacao` separa dominio de campo invalido (§11.4)', async () => {
    // A funcao e testada DIRETO porque o ramo do dominio nao e alcancavel pela
    // rota nesta etapa — os tres campos que produzem esse achado sao sempre
    // protegidos, e um link ja gravado fora da lista derruba a leitura para
    // `parado_por_erro`, recusado antes ainda. Um teste de rota para este ramo
    // dependeria do valor de `src/config.ts`, que muda em cada instalacao.
    expect(
      codigoDaRecusaDeValidacao([
        { campo: 'triggerKeywords', codigo: 'gatilho_curto', mensagem: 'x' },
      ]),
    ).toBe('dados_invalidos')

    expect(
      codigoDaRecusaDeValidacao([
        { campo: 'triggerKeywords', codigo: 'gatilho_curto', mensagem: 'x' },
        { campo: 'destinationUrl', codigo: 'dominio_nao_permitido', mensagem: 'x' },
      ]),
    ).toBe('dominio_nao_permitido')

    expect(codigoDaRecusaDeValidacao([])).toBe('dados_invalidos')
  })

  test('GRAV-27: o historico mostra a mais NOVA primeiro, e no maximo cinco', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    // Seis gravacoes, cada uma com um intervalo diferente: a sexta empurra a
    // primeira para fora da lista, e a ordem diz qual e qual.
    for (let i = 0; i < 6; i++) {
      const resposta = await gravar(
        GRAVADORAS[2] as (typeof GRAVADORAS)[number],
        `userCooldownHours=${25 + i}`,
        sessao,
        { versao: 1 + i },
      )
      expect({ [`salvo ${i}`]: resposta.status }).toEqual({ [`salvo ${i}`]: 303 })
    }

    const corpo = await telaDeAjustes(sessao)
    expect(corpo.split('Voltar a esta vers').length - 1).toBe(5)

    // A ordem: o `antes` da mudanca mais recente e 29, e ele vem PRIMEIRO. Com
    // `ORDER BY id ASC` a lista comecaria em 24, que e o `antes` mais antigo — e
    // ele nem estaria na lista, porque a poda de cinco corta do lado velho.
    const intervalos = [...corpo.matchAll(/name="userCooldownHours" value="(\d+)"/g)].map(
      (achado) => achado[1],
    )
    expect(intervalos).toEqual(['29', '28', '27', '26', '25'])
  })

  test('GRAV-28: uma configuracao no tamanho MAXIMO legal ainda cabe na auditoria', async () => {
    // O `CHECK` de 4000 da migration 0002 era alcancavel por uma configuracao
    // inteiramente legal: 20 gatilhos de 40, dois textos de 500 e um link de
    // 2048 dao ~4230 no JSON de `antes`. O lote inteiro falhava, e o dono nao
    // conseguia mais salvar nem uma palavra. A migration 0005 sobe o teto.
    const gatilhos = Array.from(
      { length: 20 },
      (_, i) => `${String(i).padStart(2, '0')}${'a'.repeat(38)}`,
    )
    const linkLongo = `https://${DOMINIO_DE_TESTE}/${'c'.repeat(2048 - 8 - DOMINIO_DE_TESTE.length - 1)}`

    // O Direct sai DESLIGADO, e isso e o que faz esta ser a configuracao mais
    // longa que o validador aceita: com ele ligado, o texto precisa conter
    // `{link}`, e o link de 2048 renderizado dentro dele estouraria o teto de
    // 1000 do Direct — os dois maximos nao cabem juntos.
    await gravarConfig(env.DB, {
      trigger_keywords: JSON.stringify(gatilhos),
      destination_url: linkLongo,
      private_reply_enabled: 0,
      private_reply_text: 'd'.repeat(500),
      public_reply_text: 'e'.repeat(500),
    })
    const sessao = await abrirSessao()

    // A premissa: a linha e LEGAL — o validador da leitura a aceitou, senao o
    // snapshot viria `parado_por_erro` e a gravacao seria recusada por outro
    // motivo, e o teste passaria sem provar nada sobre o teto.
    expect((await carregarConfigEfetiva(env, AGORA, { ignorarCache: true })).origem).toBe('banco')

    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=48',
      sessao,
    )

    expect(resposta.status).toBe(303)
    const linha = await unicaLinha()
    // E a prova de que o teste morde: o JSON gravado passa dos 4000 do teto
    // antigo.
    expect((linha.antes ?? '').length).toBeGreaterThan(4000)
    expect((linha.depois ?? '').length).toBeGreaterThan(4000)
  })

  test('GRAV-29: `dados_invalidos` em JSON acompanha `campos` com NOMES (§11.4)', async () => {
    // A tabela de §11.4 e explicita: `dados_invalidos` "acompanha `campos:
    // string[]` com **nomes**, nunca valores". Nenhuma rota de gravacao fala
    // JSON hoje — as tres sao de pagina —, entao a afirmacao e sobre `erro()`,
    // que e quem monta o corpo nos dois formatos a partir do mesmo contexto.
    const resposta = erro('dados_invalidos', {
      request: pedir('/painel/api/qualquer'),
      caminho: '/painel/api/qualquer',
      formato: 'json',
      campos: ['triggerKeywords', 'userCooldownHours'],
    })

    expect(resposta.status).toBe(400)
    expect(await resposta.json()).toEqual({
      erro: 'dados_invalidos',
      mensagem: 'Confira os campos destacados.',
      campos: ['triggerKeywords', 'userCooldownHours'],
    })

    // Sem campos, a chave nao aparece: `{erro, mensagem}` continua sendo a forma
    // de toda recusa que nao acusa campo nenhum.
    const semCampos = erro('csrf_invalido', {
      request: pedir('/painel/api/qualquer'),
      caminho: '/painel/api/qualquer',
      formato: 'json',
    })
    expect(await semCampos.json()).toEqual({
      erro: 'csrf_invalido',
      mensagem: 'Requisição bloqueada por segurança.',
    })
  })

  test('GRAV-30: `motivoInterno` fora da forma de codigo e DESCARTADO do log', async () => {
    // A trava estrutural que sustenta AUD-05 e AUD-09. `motivoInterno` e o unico
    // campo do contexto de erro que vai para o `console`, e um
    // `motivoInterno: corpo.campos.toString()` escrito por engano publicaria o
    // formulario inteiro nos Workers Logs. A forma e conferida em tempo de
    // execucao, e o que nao casa nao e escrito — nem truncado, nem mascarado.
    const registrado = capturarConsole()
    try {
      erro('dados_invalidos', {
        request: pedir('/painel/palavras'),
        caminho: '/painel/palavras',
        formato: 'pagina',
        motivoInterno: `triggerKeywords=${PALAVRA_NOVA}&destinationUrl=https://${DOMINIO_DE_TESTE}/x`,
      })
      // E o contrapositivo: um codigo bem formado CONTINUA no log, senao a
      // guarda estaria simplesmente apagando o motivo de todo mundo.
      erro('dados_invalidos', {
        request: pedir('/painel/palavras'),
        caminho: '/painel/palavras',
        formato: 'pagina',
        motivoInterno: 'campo_desconhecido',
      })
    } finally {
      registrado.parar()
    }

    const tudo = registrado.linhas.join('\n')
    expect(tudo).not.toContain(PALAVRA_NOVA)
    expect(tudo).not.toContain(DOMINIO_DE_TESTE)
    expect(tudo).toContain('400 dados_invalidos campo_desconhecido')
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
