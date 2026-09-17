import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { FALHAS_DE_STEPUP_ATE_APAGAR } from '../src/repositories/painel-sessoes-repository'
import { CAMINHO_DAS_OPCOES, handleOpcoesDeRegistro } from '../src/routes/painel/registrar'
import { ROTA_OPCOES_DE_STEPUP } from '../src/routes/painel/rotas'
import { despachar } from '../src/routes/painel/router'
import { handleOpcoesDeStepUp } from '../src/routes/painel/stepup'
import { emitirSessao, fichaCsrf, PRAZO_OCIOSO_DE_SESSAO_MS } from '../src/services/panel-session'
import { prefixoDeCredencial } from '../src/services/webauthn/verificar'
import { AutenticadorFalso, cerimonia } from './fixtures/autenticador'
import { limparBanco } from './fixtures/banco'
import { AGORA, capturarConsole, RAIZ } from './fixtures/dubles'

/**
 * REGSTEP, o step-up de `adicionar_passkey` em `POST /painel/api/registrar/opcoes`.
 *
 * Duas metades de §10.10 que esta rota nao tinha, e que o funil de gravacao
 * (`lote.ts`) e a tela de Aparelhos (`aparelhos.ts`) sempre tiveram:
 *
 * 1. **O envelope e consumido na requisicao que o usa** (passo 4: "aplica;
 *    expira o cookie"). Sem isso uma digital autorizava N cerimonias de
 *    registro dentro dos 120 s, o "modo privilegiado" que §10.10 recusa por
 *    escrito.
 * 2. **A recusa conta e deixa rastro**: `painel_sessoes.falhas_stepup` sobe, na
 *    decima a sessao e apagada, e sai linha `stepup_recusado` em
 *    `painel_auditoria`. Um caminho que nao conta e um caminho por onde se
 *    tenta a vontade, e sem deixar rastro.
 *
 * As tres rotas de registro NAO passam por `despachar` (`portaDaApi` ja consome
 * o corpo, §11.1), entao elas sao chamadas direto, a mesma excecao conhecida de
 * `painel-recuperacao.test.ts`. A cerimonia de step-up, essa sim, vai pelo
 * roteador: e a rota de escrita normal do passo 2.
 */

const HANDLE_DO_DONO = 'handle-do-dono-de-teste'

interface Sessao {
  readonly cookie: string
  readonly ficha: string
  readonly sidHash: string
}

/** Uma sessao viva de verdade: cookie assinado E linha em `painel_sessoes`. */
async function abrirSessao(credencial: string, falhas = 0): Promise<Sessao> {
  const emitida = await emitirSessao(env, AGORA)
  await env.DB.prepare(
    `INSERT INTO painel_sessoes
       (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      emitida.sidHash,
      credencial,
      env.PANEL_RP_ID,
      AGORA,
      emitida.expiraEm,
      AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
      AGORA,
      falhas,
    )
    .run()

  return {
    cookie: `__Host-painel_sessao=${emitida.valor}`,
    ficha: await fichaCsrf(env, emitida.sidHash),
    sidHash: emitida.sidHash,
  }
}

/** Uma credencial do dono no banco, como o registro a teria deixado. */
async function cadastrarAparelho(aparelho: AutenticadorFalso): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO painel_estado (id, usuario_handle, criado_em, atualizado_em)
     VALUES (1, ?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(HANDLE_DO_DONO, AGORA, AGORA)
    .run()

  await env.DB.prepare(
    `INSERT INTO painel_credenciais
       (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
        sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
     VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, 'Celular do dono', 'convite', ?, NULL)`,
  )
    .bind(
      aparelho.credentialId,
      env.PANEL_RP_ID,
      HANDLE_DO_DONO,
      JSON.stringify(aparelho.jwkParaOBanco),
      aparelho.algCose,
      AGORA,
    )
    .run()
}

/** O passo 2 de §10.10: `POST /painel/api/stepup/opcoes`. */
async function pedirOpcoesDeStepUp(sessao: Sessao, mudanca: unknown): Promise<Response> {
  return await despachar(
    new Request(`${RAIZ}${ROTA_OPCOES_DE_STEPUP.caminho}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: RAIZ,
        cookie: sessao.cookie,
        'x-painel-csrf': sessao.ficha,
      },
      body: JSON.stringify({ operacao: (mudanca as { acao?: unknown }).acao, mudanca }),
    }),
    env,
    AGORA,
    ROTA_OPCOES_DE_STEPUP,
    handleOpcoesDeStepUp,
  )
}

function cookieDoEnvelope(resposta: Response): string {
  const achado = /__Host-painel_stepup=([^;]*)/.exec(resposta.headers.get('set-cookie') ?? '')
  if (achado === null) throw new Error('a cerimonia nao emitiu o cookie de step-up')
  return `__Host-painel_stepup=${achado[1] as string}`
}

/** A digital, serializada do jeito que o `painel.js` a monta. */
async function digitalPara(aparelho: AutenticadorFalso, desafio: string): Promise<string> {
  const credencial = await aparelho.autenticar(
    cerimonia({
      rpId: env.PANEL_RP_ID,
      origem: `https://${env.PANEL_RP_ID}`,
      desafio,
      tipo: 'webauthn.get',
    }),
    HANDLE_DO_DONO,
  )
  return JSON.stringify({ credencial })
}

/** O POST de `/opcoes` no modo `sessao`, com tudo o que §10.4 passo 1 exige. */
async function pedirOpcoesDeRegistro(
  sessao: Sessao,
  digital: string,
  envelope: string | null,
): Promise<Response> {
  const cookie = envelope === null ? sessao.cookie : `${sessao.cookie}; ${envelope}`

  return await handleOpcoesDeRegistro(
    new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: RAIZ,
        cookie,
        'x-painel-csrf': sessao.ficha,
      },
      body: JSON.stringify({ tipo: 'sessao', digital, apelido: 'Aparelho novo' }),
    }),
    env,
    AGORA,
  )
}

/** A cerimonia inteira: envelope de `adicionar_passkey` mais a digital dele. */
async function cerimoniaDeAdicionar(
  sessao: Sessao,
  aparelho: AutenticadorFalso,
): Promise<{ envelope: string; digital: string }> {
  const resposta = await pedirOpcoesDeStepUp(sessao, { acao: 'adicionar_passkey' })
  const { challenge } = (await resposta.json()) as { challenge: string }

  return { envelope: cookieDoEnvelope(resposta), digital: await digitalPara(aparelho, challenge) }
}

async function linhasDeAuditoria(): Promise<{ acao: string; ator: string; step_up: number }[]> {
  const resultado = await env.DB.prepare(
    'SELECT acao, ator, step_up FROM painel_auditoria ORDER BY id ASC',
  ).all<{ acao: string; ator: string; step_up: number }>()
  return resultado.results ?? []
}

async function falhasDaSessao(sidHash: string): Promise<number | null> {
  const linha = await env.DB.prepare('SELECT falhas_stepup FROM painel_sessoes WHERE sid_hash = ?')
    .bind(sidHash)
    .first<{ falhas_stepup: number }>()
  return linha?.falhas_stepup ?? null
}

describe('REGSTEP: o envelope morre na requisicao que o usa (§10.10, passo 4)', () => {
  let aparelho: AutenticadorFalso

  beforeEach(async () => {
    await limparBanco(env.DB)
    aparelho = await AutenticadorFalso.criar()
    await cadastrarAparelho(aparelho)
  })

  test('REGSTEP-01: `/opcoes` no modo sessao expira `__Host-painel_stepup` junto com o bilhete', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)
    const { envelope, digital } = await cerimoniaDeAdicionar(sessao, aparelho)

    const opcoes = await pedirOpcoesDeRegistro(sessao, digital, envelope)
    expect(opcoes.status).toBe(200)

    const cookies = opcoes.headers.getSetCookie()
    // O bilhete do registro continua saindo: a segunda metade da cerimonia
    // depende dele, e um `Set-Cookie` a mais nao pode ter comido o primeiro.
    expect(cookies.some((linha) => /^__Host-painel_desafio=[^;]+;/.test(linha))).toBe(true)
    // E o envelope morre AQUI. O verificador de §10.10 e sem estado, nao ha
    // registro de desafio usado, entao o `Max-Age=0` E o consumo: sem ele o
    // par (cookie + assertion) continua fechando o mesmo `op_hash` pelo resto
    // dos 120 s, e como a mudanca canonica de `adicionar_passkey` nao tem alvo,
    // cada repeticao emite um bilhete de registro NOVO.
    expect(cookies).toContain(
      '__Host-painel_stepup=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict',
    )
  })

  test('REGSTEP-02: o modo convite nao mexe no cookie de step-up (nao ha envelope a matar)', async () => {
    const registrado = capturarConsole()
    let opcoes: Response
    try {
      opcoes = await handleOpcoesDeRegistro(
        new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: RAIZ },
          body: JSON.stringify({ tipo: 'convite', convite: 'cv1.n.0.1.assinatura-errada' }),
        }),
        env,
        AGORA,
      )
    } finally {
      registrado.parar()
    }

    // A recusa nem chega perto de cookie nenhum; o que este teste prende e que
    // o `Set-Cookie` novo e do RAMO `sessao`, e nao um carimbo cego da rota.
    expect(opcoes.status).toBe(401)
    expect(opcoes.headers.getSetCookie().join(' ')).not.toContain('__Host-painel_stepup')
  })
})

describe('REGSTEP: a recusa conta e deixa rastro (§10.10)', () => {
  let aparelho: AutenticadorFalso

  beforeEach(async () => {
    await limparBanco(env.DB)
    aparelho = await AutenticadorFalso.criar()
    await cadastrarAparelho(aparelho)
  })

  test('REGSTEP-03: digital que nao fecha o `op_hash` incrementa `falhas_stepup` e audita', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)

    // Uma digital COLHIDA DE VERDADE, mas para outra operacao: o envelope de
    // `gerar_codigos` nao fecha o `op_hash` de `adicionar_passkey`. E o cenario
    // do achado, quem tem o cookie de sessao martelando assertions que nao
    // servem, com uma assertion legitima, e nao lixo.
    const outra = await pedirOpcoesDeStepUp(sessao, { acao: 'gerar_codigos' })
    const { challenge } = (await outra.json()) as { challenge: string }
    const envelope = cookieDoEnvelope(outra)
    const digital = await digitalPara(aparelho, challenge)

    const registrado = capturarConsole()
    let recusa: Response
    try {
      recusa = await pedirOpcoesDeRegistro(sessao, digital, envelope)
    } finally {
      registrado.parar()
    }

    expect(recusa.status).toBe(403)
    expect(await recusa.json()).toEqual({
      erro: 'step_up_necessario',
      mensagem: 'Confirme com a sua digital para continuar.',
    })

    // A regra das 10 falhas so trava a conta se TODO caminho contar.
    expect(await falhasDaSessao(sessao.sidHash)).toBe(1)
    // E a linha de auditoria: `ator` com o prefixo de 8 hex de §9.9, nunca o
    // `credential_id` cru, e `step_up = 0` porque recusa nunca e passagem.
    expect(await linhasDeAuditoria()).toEqual([
      {
        acao: 'stepup_recusado',
        ator: `passkey:${await prefixoDeCredencial(aparelho.credentialId)}`,
        step_up: 0,
      },
    ])
  })

  test('REGSTEP-04: na decima falha a sessao e apagada', async () => {
    const sessao = await abrirSessao(aparelho.credentialId, FALHAS_DE_STEPUP_ATE_APAGAR - 1)

    const outra = await pedirOpcoesDeStepUp(sessao, { acao: 'gerar_codigos' })
    const { challenge } = (await outra.json()) as { challenge: string }
    const envelope = cookieDoEnvelope(outra)
    const digital = await digitalPara(aparelho, challenge)

    const registrado = capturarConsole()
    try {
      expect((await pedirOpcoesDeRegistro(sessao, digital, envelope)).status).toBe(403)
    } finally {
      registrado.parar()
    }

    // A LINHA e a autoridade (§10.13): apagada, o cookie assinado nao vale mais
    // nada, e e assim que o martelo para de martelar.
    expect(await falhasDaSessao(sessao.sidHash)).toBe(null)
    expect((await linhasDeAuditoria()).map((linha) => linha.acao)).toEqual(['stepup_recusado'])
  })

  test('REGSTEP-05: step-up AUSENTE audita, mas nao incrementa o contador', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)

    const registrado = capturarConsole()
    try {
      expect((await pedirOpcoesDeRegistro(sessao, '', null)).status).toBe(403)
    } finally {
      registrado.parar()
    }

    // A MESMA separacao de `aparelhos.ts`: a falha INVALIDA incrementa, a
    // AUSENTE nao, ausente e o primeiro envio, o caminho normal de quem
    // apertou o botao. Mas §10.10 manda auditar as duas.
    expect(await falhasDaSessao(sessao.sidHash)).toBe(0)
    expect((await linhasDeAuditoria()).map((linha) => linha.acao)).toEqual(['stepup_recusado'])
  })

  test('REGSTEP-06: sem LINHA de sessao nao ha o que punir, e a recusa continua fechada', async () => {
    // O cookie fecha o HMAC, mas a linha nao existe: nao ha contador a subir nem
    // `ator` a nomear. A recusa segue sendo `step_up_necessario`, e o banco fica
    // como estava, uma escrita provocada por quem nao tem sessao seria escrita
    // de estranho na cota compartilhada com o webhook (§9.9, regra 2).
    const emitida = await emitirSessao(env, AGORA)

    const registrado = capturarConsole()
    let recusa: Response
    try {
      recusa = await pedirOpcoesDeRegistro(
        {
          cookie: `__Host-painel_sessao=${emitida.valor}`,
          ficha: await fichaCsrf(env, emitida.sidHash),
          sidHash: emitida.sidHash,
        },
        '',
        null,
      )
    } finally {
      registrado.parar()
    }

    expect(recusa.status).toBe(403)
    expect(await linhasDeAuditoria()).toEqual([])
  })

  test(`REGSTEP-04b: o teto e ${FALHAS_DE_STEPUP_ATE_APAGAR}, e nem uma antes nem uma depois`, async () => {
    // MUTACAO QUE ESTE TESTE MATA (nao enfraquecer): trocar o `+ 1 >=` de
    // `registrar.ts:901` por `+ 2 >=` ou `+ 9 >=`, isto e, divergir o teto
    // desta rota das outras duas copias da mesma regra (`aparelhos.ts:240` e
    // `stepup.ts:799`, o risco C declarado). Com as amostras de REGSTEP-03
    // (uma falha a partir de 0) e REGSTEP-04 (uma a partir de nove) a suite
    // ficava VERDE com o teto em 2: as duas mediam as PONTAS do intervalo e
    // ninguem olhava o meio. Uma regra que existe para travar a conta na
    // decima nao esta protegida por um teste que nao ve o numero.
    //
    // §10.10 promete DEZ ("em **10**, a sessao e apagada"). O laco abaixo
    // deriva o numero da constante, de proposito, para que mudar o teto mude
    // o teste junto, e por isso ele nao veria uma troca na PROPRIA
    // constante. Esta linha e que amarra a promessa escrita ao valor.
    expect(FALHAS_DE_STEPUP_ATE_APAGAR).toBe(10)

    const sessao = await abrirSessao(aparelho.credentialId)

    // Um envelope de OUTRA operacao serve para as dez recusas: o verificador de
    // §10.10 e sem estado, entao o mesmo par (cookie + assertion) deixa de
    // fechar o `op_hash` de `adicionar_passkey` toda vez, igual. Colher uma
    // digital nova por volta custaria dez cerimonias e nao provaria nada a
    // mais, o que se mede aqui e o CONTADOR, nao a criptografia.
    const outra = await pedirOpcoesDeStepUp(sessao, { acao: 'gerar_codigos' })
    const { challenge } = (await outra.json()) as { challenge: string }
    const envelope = cookieDoEnvelope(outra)
    const digital = await digitalPara(aparelho, challenge)

    const registrado = capturarConsole()
    try {
      // As NOVE primeiras sobem o contador e NAO apagam. Travar cedo demais e
      // tao defeito quanto travar tarde: o dono abre Aparelhos para cadastrar
      // o celular novo, o Touch ID falha duas vezes com o dedo molhado, coisa
      // banal, e ele seria jogado para /painel/entrar no meio do cadastro,
      // sem mensagem nenhuma que explique, contra as dez que §10.10 promete.
      for (let tentativa = 1; tentativa < FALHAS_DE_STEPUP_ATE_APAGAR; tentativa++) {
        const recusa = await pedirOpcoesDeRegistro(sessao, digital, envelope)
        expect({ tentativa, status: recusa.status }).toEqual({ tentativa, status: 403 })
        // A linha VIVE, com o contador exatamente na tentativa: `null` aqui e
        // trava precoce, e um numero diferente e contagem quebrada.
        expect({ tentativa, falhas: await falhasDaSessao(sessao.sidHash) }).toEqual({
          tentativa,
          falhas: tentativa,
        })
      }

      // A DECIMA apaga a linha em vez de incrementar, e e a fronteira que
      // prende o teto por cima: com o teto em 11 o contador chegaria a 10.
      expect((await pedirOpcoesDeRegistro(sessao, digital, envelope)).status).toBe(403)
      expect(await falhasDaSessao(sessao.sidHash)).toBe(null)

      // E o martelo PARA de martelar: sem linha nao ha contador a subir nem
      // `ator` a nomear, entao a recusa seguinte nao deixa rastro nenhum (o
      // mesmo caminho de REGSTEP-06). E o que a decima existe para comprar.
      expect((await pedirOpcoesDeRegistro(sessao, digital, envelope)).status).toBe(403)
    } finally {
      registrado.parar()
    }

    // Dez recusas INVALIDAS, dez linhas: a decima audita antes de apagar (o
    // `registro` viaja no mesmo lote do `statementDeApagar`, §8.8), e a
    // decima-primeira nao audita porque nao houve sessao a punir.
    expect((await linhasDeAuditoria()).map((linha) => linha.acao)).toEqual(
      Array.from({ length: FALHAS_DE_STEPUP_ATE_APAGAR }, () => 'stepup_recusado'),
    )
  })
})
