import { env } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import { bytesToBase64Url, decodeBase64Url } from '../src/security/base64url'
import { hmacSha256, PRAZO_DE_ENVELOPE_MS } from '../src/security/signed-envelope'
import {
  chaveDeEnvelope,
  derivarSubchave,
  emitirEnvelope,
  emitirSessao,
  lerEnvelope,
  origemDoPainel,
  PRAZO_ABSOLUTO_DE_SESSAO_MS,
  painelHabilitado,
  validarSessao,
} from '../src/services/panel-session'
import type { Env } from '../src/types/env'
import { AGORA, RAIZ } from './fixtures/dubles'

/**
 * SES — a sessao assinada, o envelope de proposito e as subchaves do painel.
 *
 * Esta suite nao tem HTTP de proposito: aqui mora a primitiva sobre a qual todo
 * o resto se apoia. As garantias SES que dependem de uma `Response`
 * — **SES-06** (o cookie sai com os quatro atributos) e **SES-07** (o cookie
 * nao aparece no corpo nem em outro cabecalho) — ficaram verdes na etapa do
 * roteador, onde a rota que EMITE sessao nasceu: elas moram em
 * `tests/painel-rotas.test.ts`, no bloco do login. As que dependem da linha em
 * `painel_sessoes` (SES-08, SES-09, SES-12 e SES-13) chegam com as etapas que
 * as usam — afirmar aqui que "apagar a linha invalida a sessao" seria fingir
 * cobertura que nao existe (§13.1).
 *
 * O portao de sanidade de §10.2 e a origem de §7.4 tambem sao conferidos
 * aqui, citando a secao da spec: eles nao tem ID no registro de §13.2.
 *
 * Nenhum teste toca o D1, entao esta suite nao chama `limparBanco()`.
 */

/** Outra raiz, com os mesmos 32+ caracteres exigidos pelo portao de sanidade. */
const OUTRA_CHAVE_RAIZ = 'outra-chave-de-sessao-do-painel-ficticia'

/**
 * O `env` de teste com campos trocados.
 *
 * `undefined` e o que um binding NAO cadastrado entrega no Workers — nunca
 * string vazia. E por isso que o portao de sanidade comeca pelo `typeof`.
 */
function envCom(mudanca: Record<string, unknown>): Env {
  return { ...env, ...mudanca } as unknown as Env
}

/** Troca uma parte de um valor separado por ponto, sem mexer nas outras. */
function trocarParte(valor: string, indice: number, nova: string): string {
  const partes = valor.split('.')
  partes[indice] = nova
  return partes.join('.')
}

/**
 * Entradas que qualquer pessoa na internet consegue mandar num cookie.
 *
 * A lista tem, de proposito, entradas das DUAS aridades: 4 partes (a da
 * sessao) e 5 partes (a do envelope). Assim cada verificador recebe tanto
 * lixo que morre na contagem de partes quanto lixo que passa dela e chega a
 * guarda de versao e ao HMAC — uma bateria que so exercita a aridade nao
 * prova que o resto nao lanca.
 */
const LIXO = [
  '',
  '.',
  '...',
  's1',
  's1.a.b',
  'v1.stepup.claims',
  'a.b.c.d.e.f',
  's1..1700000000000.',
  's1.###.1700000000000.###',
  'null',
  '__proto__',
  `s1.${'x'.repeat(5000)}.1700000000000.y`,
  // 4 partes com versao errada: guarda de versao da sessao, aridade do envelope.
  's2.AAAA.1700000000000.BBBB',
  // 5 partes com versao errada: guarda de versao do envelope, aridade da sessao.
  'v2.stepup.AAAA.1700000000000.BBBB',
  // 5 partes com versao e proposito certos: chega ao HMAC do envelope.
  'v1.stepup.AAAA.1700000000000.BBBB',
  // 5 partes com claims que nem sao base64url, para o caso de a ordem mudar.
  'v1.stepup.###.1700000000000.BBBB',
]

describe('SES — o envelope assinado carrega proposito, claims e prazo', () => {
  test('SES-04: envelope de proposito errado nao autoriza step-up', async () => {
    const deRegistro = await emitirEnvelope(env, 'registrar', { c: 'desafio-de-teste' }, AGORA)

    // O campo do proposito nao e o que o step-up espera.
    expect(await lerEnvelope(env, 'stepup', deRegistro, AGORA)).toEqual({
      valido: false,
      motivo: 'malformado',
    })

    // E reescrever o campo tambem nao resolve: a chave e derivada do
    // proposito, entao a assinatura de um envelope de registro nunca fecha
    // como envelope de step-up.
    const disfarcado = trocarParte(deRegistro, 1, 'stepup')
    expect(await lerEnvelope(env, 'stepup', disfarcado, AGORA)).toEqual({
      valido: false,
      motivo: 'assinatura_invalida',
    })
  })

  test('SES-04: cada proposito tem a sua propria chave', async () => {
    const chaves = await Promise.all(
      (['entrar', 'registrar', 'stepup'] as const).map(async (proposito) =>
        bytesToBase64Url(await chaveDeEnvelope(env, proposito)),
      ),
    )

    expect(new Set(chaves).size).toBe(3)
  })

  test('SES-04: o prazo vem do proposito — registrar 300 s, entrar e stepup 120 s', async () => {
    expect(PRAZO_DE_ENVELOPE_MS).toEqual({
      entrar: 120_000,
      registrar: 300_000,
      stepup: 120_000,
    })

    const deRegistro = await emitirEnvelope(env, 'registrar', { c: 'x' }, AGORA)
    expect(await lerEnvelope(env, 'registrar', deRegistro, AGORA + 300_000)).toMatchObject({
      valido: true,
    })
    expect(await lerEnvelope(env, 'registrar', deRegistro, AGORA + 300_001)).toEqual({
      valido: false,
      motivo: 'expirado',
    })

    const deLogin = await emitirEnvelope(env, 'entrar', { c: 'x' }, AGORA)
    expect(await lerEnvelope(env, 'entrar', deLogin, AGORA + 120_000)).toMatchObject({
      valido: true,
    })
    expect(await lerEnvelope(env, 'entrar', deLogin, AGORA + 120_001)).toEqual({
      valido: false,
      motivo: 'expirado',
    })
  })

  test('SES-04: o envelope valido devolve exatamente as claims que entraram', async () => {
    const claims = { c: 'desafio-de-teste', oh: 'hash-da-operacao', sid: 'hash-do-sid' }
    const envelope = await emitirEnvelope(env, 'stepup', claims, AGORA)

    expect(await lerEnvelope(env, 'stepup', envelope, AGORA)).toEqual({ valido: true, claims })
  })

  test('SES-02: envelope assinado com outra chave raiz e recusado', async () => {
    const outro = envCom({ PANEL_SESSION_KEY: OUTRA_CHAVE_RAIZ })
    const envelope = await emitirEnvelope(outro, 'entrar', { c: 'desafio-de-teste' }, AGORA)

    expect(await lerEnvelope(env, 'entrar', envelope, AGORA)).toEqual({
      valido: false,
      motivo: 'assinatura_invalida',
    })
  })

  test('SES-03: expira_em adulterado no envelope cai na assinatura, nao no prazo', async () => {
    const envelope = await emitirEnvelope(env, 'entrar', { c: 'desafio-de-teste' }, AGORA)
    const esticado = trocarParte(envelope, 3, String(AGORA + 999_999_999))

    expect(await lerEnvelope(env, 'entrar', esticado, AGORA + 120_001)).toEqual({
      valido: false,
      motivo: 'assinatura_invalida',
    })
  })

  test('SES-05: no envelope a assinatura e conferida ANTES do prazo', async () => {
    const envelope = await emitirEnvelope(env, 'entrar', { c: 'desafio-de-teste' }, AGORA)
    const quebrado = trocarParte(envelope, 4, 'assinatura-que-nao-fecha')

    // Vencido E com assinatura quebrada: quem responde e a assinatura. Do
    // contrario um envelope forjado saberia, pela mensagem, que o prazo passou.
    expect(await lerEnvelope(env, 'entrar', quebrado, AGORA + 999_999)).toEqual({
      valido: false,
      motivo: 'assinatura_invalida',
    })
  })

  test('SES-10: envelope malformado nunca lanca', async () => {
    for (const entrada of LIXO) {
      await expect(lerEnvelope(env, 'stepup', entrada, AGORA)).resolves.toMatchObject({
        valido: false,
      })
    }
  })

  test('SES-10: prefixo de versao errado e recusado mesmo com um MAC que fecha', async () => {
    // `textoAssinado` embute a versao como CONSTANTE: trocar so o primeiro
    // campo do valor nao invalida a assinatura. A guarda de versao e a unica
    // coisa entre um "v2" forjado e o envelope aceito.
    const envelope = await emitirEnvelope(env, 'entrar', { c: 'desafio-de-teste' }, AGORA)
    expect(await lerEnvelope(env, 'entrar', envelope, AGORA)).toMatchObject({ valido: true })

    expect(await lerEnvelope(env, 'entrar', trocarParte(envelope, 0, 'v2'), AGORA)).toEqual({
      valido: false,
      motivo: 'malformado',
    })
  })

  test('SES-10: claims que nao sao um mapa de texto sao recusadas', async () => {
    const chave = await chaveDeEnvelope(env, 'entrar')
    const expiraEm = String(AGORA + 120_000)

    for (const conteudo of ['["a"]', '"texto"', '{"c":1}', 'nao-e-json']) {
      const claimsB64 = bytesToBase64Url(new TextEncoder().encode(conteudo))
      const assinatura = bytesToBase64Url(
        await hmacSha256(chave, `v1|entrar|${claimsB64}|${expiraEm}`),
      )
      const envelope = ['v1', 'entrar', claimsB64, expiraEm, assinatura].join('.')

      expect(await lerEnvelope(env, 'entrar', envelope, AGORA)).toEqual({
        valido: false,
        motivo: 'malformado',
      })
    }
  })
})

describe('SES — a sessao assinada', () => {
  test('SES-01: sessao expirada e recusada, e o prazo absoluto e de 12 h', async () => {
    const { valor, expiraEm } = await emitirSessao(env, AGORA)

    expect(expiraEm).toBe(AGORA + PRAZO_ABSOLUTO_DE_SESSAO_MS)
    expect(PRAZO_ABSOLUTO_DE_SESSAO_MS).toBe(12 * 60 * 60 * 1000)

    expect(await validarSessao(env, valor, expiraEm)).toMatchObject({ valida: true })
    expect(await validarSessao(env, valor, expiraEm + 1)).toEqual({
      valida: false,
      motivo: 'expirado',
    })
  })

  test('SES-02: sessao assinada com outra chave raiz e recusada', async () => {
    const outro = envCom({ PANEL_SESSION_KEY: OUTRA_CHAVE_RAIZ })
    const { valor } = await emitirSessao(outro, AGORA)

    expect(await validarSessao(env, valor, AGORA)).toEqual({
      valida: false,
      motivo: 'assinatura_invalida',
    })
  })

  test('SES-02: a sessao e assinada com k_sessao, nunca com a raiz nem com outra subchave', async () => {
    const sid = bytesToBase64Url(new Uint8Array(32).fill(7))
    const expiraEm = String(AGORA + PRAZO_ABSOLUTO_DE_SESSAO_MS)
    const textoAssinado = `s1|${sid}|${expiraEm}`

    const chavesErradas = [
      env.PANEL_SESSION_KEY,
      await derivarSubchave(env.PANEL_SESSION_KEY, 'desafio'),
      await derivarSubchave(env.PANEL_SESSION_KEY, 'csrf'),
      await derivarSubchave(env.PANEL_SESSION_KEY, 'codigos'),
      env.SETUP_ADMIN_TOKEN,
      env.TOKEN_ENCRYPTION_KEY,
    ]

    for (const chave of chavesErradas) {
      const assinatura = bytesToBase64Url(await hmacSha256(chave, textoAssinado))
      const forjado = ['s1', sid, expiraEm, assinatura].join('.')

      expect(await validarSessao(env, forjado, AGORA)).toEqual({
        valida: false,
        motivo: 'assinatura_invalida',
      })
    }

    // E a chave certa, a mesma conta, fecha.
    const kSessao = await derivarSubchave(env.PANEL_SESSION_KEY, 'sessao')
    const correta = bytesToBase64Url(await hmacSha256(kSessao, textoAssinado))
    expect(await validarSessao(env, ['s1', sid, expiraEm, correta].join('.'), AGORA)).toMatchObject(
      {
        valida: true,
      },
    )
  })

  test('SES-03: expira_em adulterado cai na assinatura, nao no prazo', async () => {
    const { valor, expiraEm } = await emitirSessao(env, AGORA)
    const esticado = trocarParte(valor, 2, String(expiraEm + PRAZO_ABSOLUTO_DE_SESSAO_MS))

    expect(await validarSessao(env, esticado, expiraEm + 1)).toEqual({
      valida: false,
      motivo: 'assinatura_invalida',
    })
  })

  test('SES-05: na sessao a assinatura e conferida ANTES do prazo', async () => {
    const { valor, expiraEm } = await emitirSessao(env, AGORA)
    const quebrado = trocarParte(valor, 3, 'assinatura-que-nao-fecha')

    expect(await validarSessao(env, quebrado, expiraEm + 1)).toEqual({
      valida: false,
      motivo: 'assinatura_invalida',
    })
  })

  test('SES-10: cookie malformado nunca lanca', async () => {
    for (const entrada of LIXO) {
      await expect(validarSessao(env, entrada, AGORA)).resolves.toMatchObject({ valida: false })
    }
  })

  test('SES-10: prefixo de versao errado e recusado mesmo com um MAC que fecha', async () => {
    // `assinarSessao` embute o "s1" como CONSTANTE: um cookie "s2" com o
    // mesmo MAC fecharia a assinatura, e so a guarda de versao o recusa.
    const { valor } = await emitirSessao(env, AGORA)
    expect(await validarSessao(env, valor, AGORA)).toMatchObject({ valida: true })

    expect(await validarSessao(env, trocarParte(valor, 0, 's2'), AGORA)).toEqual({
      valida: false,
      motivo: 'malformado',
    })
  })

  test('SES-11: dois sid emitidos no mesmo milissegundo diferem', async () => {
    const emitidas = await Promise.all(Array.from({ length: 200 }, () => emitirSessao(env, AGORA)))

    expect(new Set(emitidas.map((s) => s.valor)).size).toBe(200)
    expect(new Set(emitidas.map((s) => s.sidHash)).size).toBe(200)
  })

  test('SES-11: o cookie carrega o sid, e o banco recebe so o sha256 dele', async () => {
    const { valor, sidHash } = await emitirSessao(env, AGORA)
    const sid = valor.split('.')[1] ?? ''

    // 32 bytes em base64url sem padding sao 43 caracteres.
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sidHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(valor).not.toContain(sidHash)

    // Emitir e validar chegam ao mesmo sidHash: e por ele que a linha e achada.
    expect(await validarSessao(env, valor, AGORA)).toMatchObject({ valida: true, sidHash })
  })
})

describe('SES — as quatro subchaves de §10.1', () => {
  test('SES-02: as quatro subchaves diferem entre si e da raiz', async () => {
    const rotulos = ['sessao', 'desafio', 'csrf', 'codigos'] as const
    const derivadas = await Promise.all(
      rotulos.map(async (rotulo) =>
        bytesToBase64Url(await derivarSubchave(env.PANEL_SESSION_KEY, rotulo)),
      ),
    )

    expect(new Set(derivadas).size).toBe(rotulos.length)
    expect(derivadas).not.toContain(env.PANEL_SESSION_KEY)
  })

  test('SES-02: a mesma raiz e o mesmo rotulo dao sempre a mesma subchave', async () => {
    const uma = await derivarSubchave(env.PANEL_SESSION_KEY, 'codigos')
    const outra = await derivarSubchave(env.PANEL_SESSION_KEY, 'codigos')

    expect(bytesToBase64Url(uma)).toBe(bytesToBase64Url(outra))
    // 32 bytes de HMAC-SHA256.
    expect(uma).toHaveLength(32)
  })
})

describe('SES — base64url', () => {
  test('SES-10: decodeBase64Url devolve null, e nunca lanca, fora do alfabeto', () => {
    // O `=` do padding, o `+` e o `/` do base64 padrao nao entram: o codificador
    // deste projeto nunca os emite, e aceitar duas grafias do mesmo valor daria
    // ao atacante mais de um texto para o mesmo conteudo.
    for (const entrada of ['a+b', 'a/b', 'AAA=', 'A', 'á', ' AA', 'AA AA', '.']) {
      expect(decodeBase64Url(entrada)).toBeNull()
    }
  })

  test('SES-10: um conteudo tem exatamente UMA grafia aceita', () => {
    // `atob` implementa o forgiving-base64 e ignora os bits residuais do
    // ultimo grupo: 'AQ' e 'AR' devolvem o mesmo byte. Quem garante que so a
    // grafia canonica passa e a recodificacao dentro do decode.
    expect(Array.from(decodeBase64Url('AQ') ?? [])).toEqual([1])
    expect(decodeBase64Url('AR')).toBeNull()

    const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

    // So tamanhos que NAO sao multiplo de 3 tem bits residuais no ultimo
    // caractere; com multiplo de 3 nao existe grafia alternativa para testar.
    for (const tamanho of [1, 2, 4, 5, 7, 8]) {
      const bytes = crypto.getRandomValues(new Uint8Array(tamanho))
      const canonica = bytesToBase64Url(bytes)
      const esperado = Array.from(bytes).join(',')

      const grafiasDoMesmoConteudo = [...ALFABETO]
        .map((caractere) => canonica.slice(0, -1) + caractere)
        .filter((texto) => {
          const lido = decodeBase64Url(texto)
          return lido !== null && Array.from(lido).join(',') === esperado
        })

      expect(grafiasDoMesmoConteudo).toEqual([canonica])
    }
  })

  test('SES-10: encode e decode fecham o circulo de 0 a 300 bytes', () => {
    for (let tamanho = 0; tamanho <= 300; tamanho++) {
      const bytes = crypto.getRandomValues(new Uint8Array(tamanho))
      const texto = bytesToBase64Url(bytes)

      expect(texto).toMatch(/^[A-Za-z0-9_-]*$/)
      expect(Array.from(decodeBase64Url(texto) ?? [])).toEqual(Array.from(bytes))
    }
  })
})

describe('SES — o portao de sanidade de §10.2 e a origem de §7.4', () => {
  test('§10.2: binding ausente chega como undefined e nao lanca TypeError', () => {
    expect(painelHabilitado(envCom({ PANEL_SESSION_KEY: undefined }))).toEqual({
      ok: false,
      motivo: 'chave_de_sessao_ausente',
    })
    expect(painelHabilitado(envCom({ SETUP_ADMIN_TOKEN: undefined }))).toEqual({
      ok: false,
      motivo: 'admin_token_ausente',
    })
    // O caso que ja quebrou um esboco: `env.PANEL_RP_ID.length` sem `typeof`.
    expect(painelHabilitado(envCom({ PANEL_RP_ID: undefined }))).toEqual({
      ok: false,
      motivo: 'endereco_do_painel_nao_configurado',
    })
  })

  test('§10.2: chave curta, admin token curto e endereco vazio desligam o painel', () => {
    expect(painelHabilitado(envCom({ PANEL_SESSION_KEY: 'a'.repeat(31) }))).toEqual({
      ok: false,
      motivo: 'chave_de_sessao_ausente',
    })
    expect(painelHabilitado(envCom({ PANEL_SESSION_KEY: 'a'.repeat(32) }))).toEqual({ ok: true })

    expect(painelHabilitado(envCom({ SETUP_ADMIN_TOKEN: 'a'.repeat(19) }))).toEqual({
      ok: false,
      motivo: 'admin_token_ausente',
    })
    expect(painelHabilitado(envCom({ SETUP_ADMIN_TOKEN: 'a'.repeat(20) }))).toEqual({ ok: true })

    // Vazio e o padrao do repositorio: template publico, endereco de cada um.
    expect(painelHabilitado(envCom({ PANEL_RP_ID: '' }))).toEqual({
      ok: false,
      motivo: 'endereco_do_painel_nao_configurado',
    })
  })

  test('§7.4: origemDoPainel e https:// + PANEL_RP_ID, sem PANEL_ORIGIN no meio', () => {
    expect(painelHabilitado(env)).toEqual({ ok: true })
    expect(origemDoPainel(env)).toBe(RAIZ)
    expect(origemDoPainel(envCom({ PANEL_RP_ID: 'painel.exemplo.com.br' }))).toBe(
      'https://painel.exemplo.com.br',
    )
  })
})
