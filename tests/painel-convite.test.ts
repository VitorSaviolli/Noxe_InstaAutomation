import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { handleGerarCodigos } from '../src/routes/painel/parada'
import {
  CAMINHO_DA_VERIFICACAO,
  CAMINHO_DAS_OPCOES,
  CAMINHO_DO_CONVITE,
  handleOpcoesDeRegistro,
  handlePaginaDeConvite,
  handleVerificarRegistro,
  PRAZO_DO_CONVITE_MS,
  TAMANHO_DO_APELIDO,
  TETO_DE_CREDENCIAIS,
  TETO_DO_CORPO_DA_API,
} from '../src/routes/painel/registrar'
import { emitirEnvelope, emitirSessao, fichaCsrf } from '../src/services/panel-session'
import type { Env } from '../src/types/env'
import { AutenticadorFalso, cerimonia, paraBase64Url, semUv } from './fixtures/autenticador'
import { limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoD1,
  D1BatchQuebrado,
  D1Contador,
  RAIZ,
} from './fixtures/dubles'

/**
 * CONV, convite de uso unico e registro da primeira passkey (§13.2, 12
 * garantias), mais o Lema 1 de §10.6 e a garantia de que registrar NAO emite
 * sessao.
 *
 * `now` e sempre injetado: nenhum teste desta suite passa pelo roteador, e por
 * isso nenhum deles depende do relogio real.
 *
 * **O convite e montado aqui do zero, sem importar nada de `src/`**, e a
 * independencia e o ponto. Se a producao passasse a assinar outro texto, um
 * ajudante compartilhado mudaria dos dois lados de uma vez e o teste
 * continuaria verde provando nada. E o mesmo raciocinio do metodo T2 que
 * governa a suite de WebAuthn.
 */

const ROTULO_DO_CONVITE = 'noxe-painel/v1/convite'

/** O mesmo valor ficticio do `vitest.config.ts`. */
const ADMIN = 'admin-token-de-teste'

async function hmacCru(chave: Uint8Array | string, texto: string): Promise<Uint8Array> {
  const bytes = typeof chave === 'string' ? new TextEncoder().encode(chave) : chave
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(texto)))
}

interface OpcoesDoConvite {
  pre?: '0' | 'q'
  expiraEm?: number
  /** A raiz de `k_convite`. Trocar isto e o teste do "outro segredo". */
  raiz?: string
  nonce?: string
  /** O `expira_em` que vai no TEXTO, quando ele precisa divergir do assinado. */
  prazoExibido?: number
}

/** `convite = "cv1" "." nonce "." pre "." expira_em "." hmac` (§10.4). */
async function montarConvite(
  opcoes: OpcoesDoConvite = {},
): Promise<{ token: string; nonce: string }> {
  const nonce = opcoes.nonce ?? paraBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const pre = opcoes.pre ?? '0'
  const assinado = String(opcoes.expiraEm ?? AGORA + PRAZO_DO_CONVITE_MS)
  const exibido = opcoes.prazoExibido === undefined ? assinado : String(opcoes.prazoExibido)

  const chave = await hmacCru(opcoes.raiz ?? env.SETUP_ADMIN_TOKEN, ROTULO_DO_CONVITE)
  const assinatura = paraBase64Url(await hmacCru(chave, `cv1|${nonce}|${pre}|${assinado}`))

  return { token: ['cv1', nonce, pre, exibido, assinatura].join('.'), nonce }
}

function comAmbiente(patch: Record<string, unknown>): Env {
  return { ...(env as unknown as Record<string, unknown>), ...patch } as unknown as Env
}

function postar(caminho: string, corpo: unknown, cabecalhos: Record<string, string> = {}): Request {
  return new Request(`${RAIZ}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: RAIZ, ...cabecalhos },
    body: JSON.stringify(corpo),
  })
}

/** O valor do cookie `__Host-painel_desafio` que a resposta acabou de emitir. */
function bilhete(resposta: Response): string {
  const valor = /__Host-painel_desafio=([^;]*)/.exec(resposta.headers.get('set-cookie') ?? '')?.[1]
  if (valor === undefined || valor === '') throw new Error('resposta sem bilhete de registro')
  return valor
}

async function desafioDe(resposta: Response): Promise<string> {
  return ((await resposta.clone().json()) as { challenge: string }).challenge
}

/** A cerimonia inteira, do convite ao registro gravado. */
async function registrarComConvite(
  token: string,
  ambiente: Env = env,
  now: number = AGORA,
): Promise<{ opcoes: Response; verificacao: Response }> {
  const opcoes = await handleOpcoesDeRegistro(
    postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
    ambiente,
    now,
  )
  if (opcoes.status !== 200) return { opcoes, verificacao: opcoes }

  const aparelho = await AutenticadorFalso.criar()
  const resposta = await aparelho.registrar(
    cerimonia({
      rpId: ambiente.PANEL_RP_ID,
      origem: RAIZ,
      desafio: await desafioDe(opcoes),
      tipo: 'webauthn.create',
    }),
  )

  const verificacao = await handleVerificarRegistro(
    postar(
      CAMINHO_DA_VERIFICACAO,
      { apelido: 'Meu celular', credencial: resposta },
      { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
    ),
    ambiente,
    now,
  )

  return { opcoes, verificacao }
}

async function contarCredenciais(): Promise<number> {
  const linha = await env.DB.prepare('SELECT COUNT(*) AS n FROM painel_credenciais').first<{
    n: number
  }>()
  return linha?.n ?? 0
}

/**
 * Gera um conjunto de codigos pela rota de producao.
 *
 * Passa por `POST /setup/painel/codigos` de proposito: um codigo escrito a mao
 * no banco provaria o hash do teste, e nao o do Worker.
 */
async function gerarCodigosDeRecuperacao(): Promise<string[]> {
  const resposta = await handleGerarCodigos(
    new Request(`${RAIZ}/setup/painel/codigos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env,
    AGORA,
  )
  return ((await resposta.json()) as { recuperacao: string[] }).recuperacao
}

const CREDENCIAL_INVALIDA = {
  erro: 'credencial_invalida',
  mensagem: 'Não foi possível confirmar. Tente de novo.',
}

/**
 * Registra com um autenticador JA CRIADO, em vez de sortear um novo.
 *
 * `registrarComConvite` cria o aparelho por dentro, e por isso nao serve aos
 * testes em que o MESMO `credential_id` precisa aparecer duas vezes, nem
 * aqueles em que o corpo do POST precisa ser outro.
 */
async function registrarComAparelho(
  aparelho: AutenticadorFalso,
  token: string,
  corpo: Record<string, unknown> = { apelido: 'Meu celular' },
  ambiente: Env = env,
): Promise<Response> {
  const opcoes = await handleOpcoesDeRegistro(
    postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
    env,
    AGORA,
  )
  if (opcoes.status !== 200) return opcoes

  const resposta = await aparelho.registrar(
    cerimonia({
      rpId: env.PANEL_RP_ID,
      origem: RAIZ,
      desafio: await desafioDe(opcoes),
      tipo: 'webauthn.create',
    }),
  )

  return await handleVerificarRegistro(
    postar(
      CAMINHO_DA_VERIFICACAO,
      { ...corpo, credencial: resposta },
      { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
    ),
    ambiente,
    AGORA,
  )
}

/**
 * D1 cujo `batch()` IGNORA o lote de verdade e forca, no D1 real por baixo,
 * uma violacao `NOT NULL` em `painel_credenciais.apelido`, para provar que
 * `ehConflitoDeChave` (registrar.ts) distingue essa classe da violacao de
 * UNIQUE/PK do passo 8, e nao trata as duas como o mesmo `credencial_invalida`
 * generico.
 *
 * Nao alcancavel pelos caminhos tipados de hoje: e por isso que o "e se"
 * precisa vir de um duble, e nao de um corpo malicioso.
 */
class D1QuebradoPorNotNull {
  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    return this.real.prepare(sql)
  }

  batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.real.batch<T>([
      this.real
        .prepare(
          `INSERT INTO painel_credenciais
             (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
              sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
           VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, 'convite', ?, NULL)`,
        )
        .bind('credencial-de-outro-lote', 'rp', 'handle', '{}', -7, AGORA),
    ])
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    return this.real.dump()
  }
}

/** A unica linha de `painel_credenciais`, nos campos que o saneamento decide. */
async function linhaGravada(): Promise<{ apelido: string; transportes: string | null } | null> {
  return await env.DB.prepare(
    'SELECT apelido, transportes FROM painel_credenciais ORDER BY rowid DESC LIMIT 1',
  ).first<{ apelido: string; transportes: string | null }>()
}

/** Enche a tabela com `quantas` credenciais do `rp_id` deste deploy. */
async function encherAsCredenciais(quantas: number): Promise<void> {
  for (let i = 0; i < quantas; i++) {
    await env.DB.prepare(
      `INSERT INTO painel_credenciais
         (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
          sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
       VALUES (?, ?, 'handle', '{}', -7, NULL, 0, 0, 0, 'aparelho', 'convite', ?, NULL)`,
    )
      .bind(`cred-${i}`, env.PANEL_RP_ID, AGORA)
      .run()
  }
}

// ---------------------------------------------------------------------------

describe('CONV: o convite', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('CONV-01: convite valido gera options, e elas sao as de §10.4', async () => {
    const { token } = await montarConvite()

    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )
    expect(resposta.status).toBe(200)

    const options = (await resposta.json()) as Record<string, unknown>
    expect(options.rp).toEqual({ id: env.PANEL_RP_ID, name: 'Painel da automacao' })
    // `[-7, -257]` e nada mais: ES256 cobre Apple/Google, RS256 o Windows Hello.
    expect(options.pubKeyCredParams).toEqual([
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ])
    // Metade da trava de §7.8: sem `required` aqui, o autenticador honesto nao
    // pede biometria e a flag `UV` chega em 0. A outra metade e o `authData`.
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(options.attestation).toBe('none')
    expect(options.excludeCredentials).toEqual([])
    expect(options.timeout).toBe(300_000)

    const usuario = options.user as { id: string; name: string; displayName: string }
    expect(usuario.name).toBe('@painel')
    expect(usuario.displayName).toBe('Dono da conta')

    // O bilhete e um cookie `__Host-`, com `Path=/` (o prefixo exige) e
    // `SameSite=Strict` (camada 1 das cinco de §10.9).
    const cookie = resposta.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('__Host-painel_desafio=')
    expect(cookie).toContain('Max-Age=300')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  test('CONV-01: o convite que o assistente produz de verdade e aceito', async () => {
    // Vetor CONGELADO, gerado rodando `node scripts/gerar-convite.mjs` com o
    // SETUP_ADMIN_TOKEN ficticio deste ambiente. E o mesmo raciocinio do metodo
    // T2 da suite de WebAuthn: o `montarConvite` acima e uma segunda
    // implementacao escrita pelo mesmo autor, e duas implementacoes simetricas
    // erram juntas. Este token veio do arquivo que o DONO roda, e prova que o
    // script e o Worker concordam byte a byte, se um dos dois mudar o texto
    // assinado, o rotulo da subchave ou a ordem dos campos, este teste cai.
    const DO_ASSISTENTE =
      'cv1.zXItTInxQsUB_wtwck55dA.0.1788626246209.fY0QS8bGH8WNKHfidJIxGXexZXqIQpFr9WQtY5CUZdg'
    // Um minuto antes de o convite vencer: `now` e injetado, entao o vetor nao
    // apodrece com o relogio de parede.
    const dentroDoPrazo = 1788626246209 - 60_000

    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: DO_ASSISTENTE }),
      env,
      dentroDoPrazo,
    )

    expect(resposta.status).toBe(200)

    // E o prazo do vetor e conferido de verdade: um milissegundo depois, nao.
    const tarde = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: DO_ASSISTENTE }),
      env,
      1788626246210,
    )
    expect(tarde.status).toBe(401)
  })

  test('CONV-01: o `usuario_handle` e ESTAVEL entre duas cerimonias', async () => {
    // Se ele mudasse, cada registro criaria uma conta separada no gerenciador
    // de senhas do celular em vez de agrupar as passkeys do dono (§8.6).
    const primeira = await montarConvite()
    const segunda = await montarConvite()

    const um = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: primeira.token }),
      env,
      AGORA,
    )
    const dois = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: segunda.token }),
      env,
      AGORA,
    )

    const handleDeUm = ((await um.json()) as { user: { id: string } }).user.id
    const handleDeDois = ((await dois.json()) as { user: { id: string } }).user.id

    expect(handleDeUm).toBe(handleDeDois)
    expect(handleDeUm.length).toBeGreaterThan(20)
  })

  test('CONV-02: o mesmo convite usado duas vezes falha na segunda', async () => {
    const { token, nonce } = await montarConvite()

    const primeira = await registrarComConvite(token)
    expect(primeira.verificacao.status).toBe(200)

    // O MESMO nonce, agora num convite `pre=q`, que continua valendo com
    // passkey cadastrada. O que morre e o CONSUMO, e nao a precondicao: sem
    // isso o teste provaria CONV-07 outra vez em vez de provar o uso unico.
    const reemitido = await montarConvite({ pre: 'q', nonce })
    const segunda = await registrarComConvite(reemitido.token)

    expect(await segunda.verificacao.json()).toEqual(CREDENCIAL_INVALIDA)
    expect(segunda.verificacao.status).toBe(401)
    expect(await contarCredenciais()).toBe(1)
  })

  test('CONV-03: convite expirado e recusado', async () => {
    const { token } = await montarConvite({ expiraEm: AGORA - 1 })

    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )

    expect(resposta.status).toBe(401)
    expect(await resposta.json()).toEqual(CREDENCIAL_INVALIDA)
  })

  test('CONV-04: convite assinado com outro segredo e recusado', async () => {
    const { token } = await montarConvite({ raiz: 'outro-admin-token-qualquer' })

    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )

    // Trava de §10.1: rotacionar o `SETUP_ADMIN_TOKEN` invalida convites, e e
    // por isso que a chave do convite NAO pode ser a mesma da sessao.
    expect(resposta.status).toBe(401)
    expect(await resposta.json()).toEqual(CREDENCIAL_INVALIDA)
  })

  test('CONV-05: prazo adulterado a mao e recusado', async () => {
    // A assinatura cobre o `expira_em` CRU: esticar o prazo no texto sem
    // reassinar quebra o MAC, e nao adianta que o novo prazo esteja no futuro.
    const { token } = await montarConvite({
      expiraEm: AGORA - 1,
      prazoExibido: AGORA + 10 * PRAZO_DO_CONVITE_MS,
    })

    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )

    expect(resposta.status).toBe(401)
  })

  test('CONV-06: sem convite e sem codigo, recusa antes das options e sem tocar no D1', async () => {
    const contador = new D1Contador(env.DB)
    const ambiente = comAmbiente({ DB: comoD1(contador) })

    for (const corpo of [{}, { tipo: 'nenhum' }, { tipo: 'convite' }, { convite: 'cv1.a.0.1.b' }]) {
      const resposta = await handleOpcoesDeRegistro(
        postar(CAMINHO_DAS_OPCOES, corpo),
        ambiente,
        AGORA,
      )
      expect(resposta.status).toBe(401)
      // Nada de `challenge`, nada de `user`, nada de `excludeCredentials`: as
      // options revelam os `credential_id` ja registrados, e devolve-las a um
      // estranho seria enumeracao de graca (§10.4, passo 3).
      expect(await resposta.json()).toEqual(CREDENCIAL_INVALIDA)
    }

    // Trava da regra de §11.3: nenhuma rota nao autenticada consulta o D1
    // antes de um HMAC fechar.
    expect(contador.prepares).toBe(0)
    expect(contador.batches).toBe(0)
  })

  test('CONV-06: um convite com MAC errado tambem nao custa consulta nenhuma', async () => {
    const { token } = await montarConvite({ raiz: 'segredo-que-nao-e-o-do-worker' })
    const contador = new D1Contador(env.DB)

    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      comAmbiente({ DB: comoD1(contador) }),
      AGORA,
    )

    expect(resposta.status).toBe(401)
    expect(contador.prepares).toBe(0)
  })

  test('CONV-07: com passkey cadastrada, o convite `pre=0` nao abre registro', async () => {
    const primeiro = await montarConvite({ pre: '0' })
    expect((await registrarComConvite(primeiro.token)).verificacao.status).toBe(200)

    const outro = await montarConvite({ pre: '0' })
    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: outro.token }),
      env,
      AGORA,
    )

    expect(resposta.status).toBe(401)
    expect(await contarCredenciais()).toBe(1)
  })

  test('CONV-07: `pre=q` continua valendo com passkey cadastrada', async () => {
    expect((await registrarComConvite((await montarConvite()).token)).verificacao.status).toBe(200)

    const segundo = await montarConvite({ pre: 'q' })
    const { verificacao } = await registrarComConvite(segundo.token)

    expect(verificacao.status).toBe(200)
    expect(await contarCredenciais()).toBe(2)
  })

  test('CONV-07: uma credencial de OUTRO endereco ja fecha o `pre=0`', async () => {
    // Ela nao serve mais para entrar (§10.14), mas prova que a instalacao ja
    // teve dono, e e disso que a precondicao do convite comum fala.
    await env.DB.prepare(
      `INSERT INTO painel_credenciais
         (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
          sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
       VALUES ('antiga', 'endereco-antigo.workers.dev', 'handle', '{}', -7, NULL,
               0, 0, 0, 'aparelho antigo', 'convite', ?, NULL)`,
    )
      .bind(AGORA)
      .run()

    const { token } = await montarConvite({ pre: '0' })
    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )

    expect(resposta.status).toBe(401)
  })

  test('CONV-08: registro recusado nao deixa linha', async () => {
    const { token } = await montarConvite()
    const opcoes = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )

    const aparelho = await AutenticadorFalso.criar()
    // `UV = 0`: chave de seguranca sem PIN. Recusada sempre (§7.8).
    const resposta = await aparelho.registrar(
      semUv(
        cerimonia({
          rpId: env.PANEL_RP_ID,
          origem: RAIZ,
          desafio: await desafioDe(opcoes),
          tipo: 'webauthn.create',
        }),
      ),
    )

    const verificacao = await handleVerificarRegistro(
      postar(
        CAMINHO_DA_VERIFICACAO,
        { apelido: 'Chavinha sem PIN', credencial: resposta },
        { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
      ),
      env,
      AGORA,
    )

    expect(verificacao.status).toBe(401)
    expect(await contarCredenciais()).toBe(0)
    // E o convite continua vivo: a recusa aconteceu ANTES do consumo, entao a
    // pessoa que errou o gesto tenta de novo com o mesmo link.
    expect((await registrarComConvite(token)).verificacao.status).toBe(200)
  })

  test('CONV-12: duas tentativas simultaneas com o mesmo convite, exatamente uma vence', async () => {
    const { token } = await montarConvite()
    const opcoes = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )
    const desafio = await desafioDe(opcoes)
    const cookie = `__Host-painel_desafio=${bilhete(opcoes)}`

    const aparelhos = [await AutenticadorFalso.criar(), await AutenticadorFalso.criar()]
    const dois = await Promise.all(
      aparelhos.map(async (aparelho) => {
        const resposta = await aparelho.registrar(
          cerimonia({ rpId: env.PANEL_RP_ID, origem: RAIZ, desafio, tipo: 'webauthn.create' }),
        )
        return handleVerificarRegistro(
          postar(
            CAMINHO_DA_VERIFICACAO,
            { apelido: 'Simultaneo', credencial: resposta },
            { cookie },
          ),
          env,
          AGORA,
        )
      }),
    )

    // O `ON CONFLICT DO NOTHING` mais `meta.changes` e o mesmo claim atomico do
    // `claimComment`: o D1 e SQLite com escritor unico, e os dois nao podem ver
    // `changes === 1`.
    expect(dois.map((r) => r.status).sort()).toEqual([200, 401])
    expect(await contarCredenciais()).toBe(1)
  })
})

describe('CONV: o codigo de recuperacao', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('CONV-09: codigo correto abre registro e e consumido', async () => {
    const codigos = await gerarCodigosDeRecuperacao()
    const codigo = codigos[0] as string

    const opcoes = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'recuperacao', codigo }),
      env,
      AGORA,
    )
    expect(opcoes.status).toBe(200)

    // Trava de §10.4, passo 4: gerar as options NAO consome o codigo. Quem
    // cancela a biometria tenta de novo com o mesmo papel na mao.
    const aindaVivo = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM painel_codigos WHERE tipo = 'recuperacao' AND usado_em IS NULL",
    ).first<{ n: number }>()
    expect(aindaVivo?.n).toBe(6)

    const aparelho = await AutenticadorFalso.criar()
    const resposta = await aparelho.registrar(
      cerimonia({
        rpId: env.PANEL_RP_ID,
        origem: RAIZ,
        desafio: await desafioDe(opcoes),
        tipo: 'webauthn.create',
      }),
    )
    const verificacao = await handleVerificarRegistro(
      postar(
        CAMINHO_DA_VERIFICACAO,
        { apelido: 'Celular novo', credencial: resposta },
        { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
      ),
      env,
      AGORA,
    )

    expect(verificacao.status).toBe(200)
    expect(await contarCredenciais()).toBe(1)

    // Invalidacao em bloco (§10.11): o usado fica `usado_em`, e os outros cinco
    // ficam `invalidado_em`, se um codigo foi usado por quem nao devia, os
    // outros estao na mesma lista vazada.
    const usados = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM painel_codigos WHERE tipo = 'recuperacao' AND usado_em IS NOT NULL",
    ).first<{ n: number }>()
    const invalidados = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM painel_codigos WHERE tipo = 'recuperacao' AND invalidado_em IS NOT NULL",
    ).first<{ n: number }>()
    expect({ usados: usados?.n, invalidados: invalidados?.n }).toEqual({
      usados: 1,
      invalidados: 5,
    })

    // O codigo de PARADA nao entra na invalidacao: derrubar o freio de
    // emergencia junto seria punir o dono no pior dia possivel.
    const parada = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM painel_codigos WHERE tipo = 'parada' AND invalidado_em IS NULL",
    ).first<{ n: number }>()
    expect(parada?.n).toBe(1)

    // E a linha de auditoria e a de §10.11, nao a de uma passkey qualquer.
    const linha = await env.DB.prepare(
      'SELECT acao, origem, ator, step_up FROM painel_auditoria ORDER BY id DESC LIMIT 1',
    ).first<{ acao: string; origem: string; ator: string; step_up: number }>()
    expect(linha?.acao).toBe('recuperacao_usada')
    expect(linha?.origem).toBe('painel')
    expect(linha?.step_up).toBe(0)
    // Nunca o `credential_id` cru, em nenhum dos tres destinos (§10.13).
    expect(linha?.ator).toMatch(/^passkey:[0-9a-f]{8}$/)
  })

  test('CONV-09: usar o codigo apaga TODAS as sessoes', async () => {
    await env.DB.prepare(
      `INSERT INTO painel_sessoes
         (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
       VALUES ('sessao-de-alguem', 'cred', ?, ?, ?, ?, ?, 0)`,
    )
      .bind(env.PANEL_RP_ID, AGORA, AGORA + 1_000_000, AGORA + 1_000_000, AGORA)
      .run()

    const codigo = (await gerarCodigosDeRecuperacao())[0] as string
    const opcoes = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'recuperacao', codigo }),
      env,
      AGORA,
    )
    const aparelho = await AutenticadorFalso.criar()
    const resposta = await aparelho.registrar(
      cerimonia({
        rpId: env.PANEL_RP_ID,
        origem: RAIZ,
        desafio: await desafioDe(opcoes),
        tipo: 'webauthn.create',
      }),
    )
    await handleVerificarRegistro(
      postar(
        CAMINHO_DA_VERIFICACAO,
        { apelido: 'Celular novo', credencial: resposta },
        { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
      ),
      env,
      AGORA,
    )

    const sessoes = await env.DB.prepare('SELECT COUNT(*) AS n FROM painel_sessoes').first<{
      n: number
    }>()
    expect(sessoes?.n).toBe(0)
  })

  test('CONV-10: o mesmo codigo nao serve duas vezes', async () => {
    const codigo = (await gerarCodigosDeRecuperacao())[0] as string

    const registrar = async (apelido: string) => {
      const opcoes = await handleOpcoesDeRegistro(
        postar(CAMINHO_DAS_OPCOES, { tipo: 'recuperacao', codigo }),
        env,
        AGORA,
      )
      if (opcoes.status !== 200) return opcoes

      const aparelho = await AutenticadorFalso.criar()
      const resposta = await aparelho.registrar(
        cerimonia({
          rpId: env.PANEL_RP_ID,
          origem: RAIZ,
          desafio: await desafioDe(opcoes),
          tipo: 'webauthn.create',
        }),
      )
      return handleVerificarRegistro(
        postar(
          CAMINHO_DA_VERIFICACAO,
          { apelido, credencial: resposta },
          { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
        ),
        env,
        AGORA,
      )
    }

    expect((await registrar('primeiro')).status).toBe(200)
    // Na segunda o codigo ja esta `usado_em`, e quem recusa e o `changes === 1`
    // do consumo, e por isso que o uso unico e ATOMICO, e nao uma leitura.
    expect((await registrar('segundo')).status).toBe(401)
    expect(await contarCredenciais()).toBe(1)
  })

  test('CONV-11: codigo errado responde igual a codigo inexistente', async () => {
    // Sem nenhum codigo cadastrado.
    const semNenhum = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'recuperacao', codigo: 'ABCDE-FGHJK-MNPQR-STVWX' }),
      env,
      AGORA,
    )

    await gerarCodigosDeRecuperacao()
    const comCodigos = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'recuperacao', codigo: 'ABCDE-FGHJK-MNPQR-STVWX' }),
      env,
      AGORA,
    )

    expect(semNenhum.status).toBe(comCodigos.status)
    expect(await semNenhum.json()).toEqual(await comCodigos.json())
    expect(comCodigos.status).toBe(401)
  })

  test('CONV-11: codigo malformado nao custa consulta nenhuma', async () => {
    const contador = new D1Contador(env.DB)

    const resposta = await handleOpcoesDeRegistro(
      // O tamanho errado nao tem conserto, e a recusa acontece antes do D1.
      postar(CAMINHO_DAS_OPCOES, { tipo: 'recuperacao', codigo: 'curto' }),
      comAmbiente({ DB: comoD1(contador) }),
      AGORA,
    )

    expect(resposta.status).toBe(401)
    expect(contador.prepares).toBe(0)
  })
})

describe('CONV: o que o registro NAO faz', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('registro bem-sucedido NAO emite cookie de sessao', async () => {
    const { verificacao } = await registrarComConvite((await montarConvite()).token)

    expect(verificacao.status).toBe(200)
    expect(await verificacao.json()).toEqual({ ok: true, para: '/painel/entrar' })

    // Trava de §15.3, decisao 5: a sessao nasce SEMPRE de um login com
    // `webauthn.get` e `UV` conferido, num ponto unico do codigo. E o que faz o
    // codigo de recuperacao nunca virar sessao, nem indiretamente.
    const cookies = verificacao.headers.get('set-cookie') ?? ''
    expect(cookies).not.toContain('__Host-painel_sessao')
    // O bilhete e expirado: uma autorizacao que sobrevive ao proprio uso e uma
    // autorizacao pendurada esperando uma segunda requisicao.
    expect(cookies).toContain('__Host-painel_desafio=; Max-Age=0')

    const sessoes = await env.DB.prepare('SELECT COUNT(*) AS n FROM painel_sessoes').first<{
      n: number
    }>()
    expect(sessoes?.n).toBe(0)
  })

  test('Lema 1 de §10.6: `INSERT INTO painel_credenciais` mora em UM arquivo de src/', () => {
    const fontes = import.meta.glob('../src/**/*.ts', {
      query: '?raw',
      eager: true,
      import: 'default',
    }) as Record<string, string>

    const arquivos = Object.keys(fontes)
    // Contrapositivo do proprio teste: uma varredura quebrada devolveria lista
    // vazia e a comparacao abaixo passaria comparando nada com nada.
    expect(arquivos.length).toBeGreaterThan(20)

    const comInsercao = arquivos
      .filter((nome) => /INSERT\s+INTO\s+painel_credenciais/i.test(fontes[nome] ?? ''))
      .sort()

    // O teorema de §10.6 vale porque existe UM caminho de insercao. Um segundo
    // caminho escrito de boa fe amanha nao acionaria nenhum outro alarme.
    expect(comInsercao).toEqual(['../src/repositories/painel-credenciais-repository.ts'])
  })

  test('verificar sem bilhete e `401`, e o parser CBOR nem roda (Lema 2)', async () => {
    const contador = new D1Contador(env.DB)

    const resposta = await handleVerificarRegistro(
      postar(CAMINHO_DA_VERIFICACAO, { apelido: 'x', credencial: { id: 'a' } }),
      comAmbiente({ DB: comoD1(contador) }),
      AGORA,
    )

    expect(resposta.status).toBe(401)
    expect(contador.prepares).toBe(0)
  })

  test('um bilhete de OUTRO proposito nao autoriza registro', async () => {
    // Terceira defesa de §10.3: o proposito entra no texto assinado, na
    // derivacao da chave e no nome do cookie. Um desafio de `entrar`, que
    // qualquer anonimo consegue, nao pode virar autorizacao de cadastro.
    const doLogin = await emitirEnvelope(
      env,
      'entrar',
      { c: 'x', a: 'convite', k: 'n', h: 'h' },
      AGORA,
    )

    const resposta = await handleVerificarRegistro(
      postar(
        CAMINHO_DA_VERIFICACAO,
        { apelido: 'x', credencial: { id: 'a' } },
        { cookie: `__Host-painel_desafio=${doLogin}` },
      ),
      env,
      AGORA,
    )

    expect(resposta.status).toBe(401)
  })

  test('o bilhete vencido nao autoriza, e o desafio morre com ele', async () => {
    const { token } = await montarConvite()
    const opcoes = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )
    const aparelho = await AutenticadorFalso.criar()
    const resposta = await aparelho.registrar(
      cerimonia({
        rpId: env.PANEL_RP_ID,
        origem: RAIZ,
        desafio: await desafioDe(opcoes),
        tipo: 'webauthn.create',
      }),
    )

    const verificacao = await handleVerificarRegistro(
      postar(
        CAMINHO_DA_VERIFICACAO,
        { apelido: 'Atrasado', credencial: resposta },
        { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
      ),
      env,
      // 300 s e um milissegundo depois: o desafio WebAuthn nao tem prazo
      // proprio, o prazo dele e o do envelope (§10.4).
      AGORA + 300_001,
    )

    expect(verificacao.status).toBe(401)
    expect(await contarCredenciais()).toBe(0)
  })
})

describe('CONV: o modo sessao, e a ficha CSRF que §15.4 exige', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('sem cookie de sessao a resposta e `sessao_ausente`', async () => {
    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'sessao' }),
      env,
      AGORA,
    )

    expect(resposta.status).toBe(401)
    expect(await resposta.json()).toEqual({
      erro: 'sessao_ausente',
      mensagem: 'Você precisa entrar de novo.',
    })
  })

  test('com sessao e SEM ficha CSRF a resposta e `csrf_invalido`', async () => {
    const sessao = await emitirSessao(env, AGORA)

    const resposta = await handleOpcoesDeRegistro(
      postar(
        CAMINHO_DAS_OPCOES,
        { tipo: 'sessao' },
        { cookie: `__Host-painel_sessao=${sessao.valor}` },
      ),
      env,
      AGORA,
    )

    // Trava de §15.4: cadastrar passkey nova e precisamente a operacao que um
    // atacante mais gostaria de executar em nome do dono, e por isso este POST
    // que corre com cookie de sessao, exige a ficha como qualquer outro.
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toEqual({
      erro: 'csrf_invalido',
      mensagem: 'Bloqueado por segurança. Abra a tela de novo e tente outra vez.',
    })
  })

  test('a ficha de OUTRA sessao nao serve', async () => {
    const minha = await emitirSessao(env, AGORA)
    const outra = await emitirSessao(env, AGORA)

    const resposta = await handleOpcoesDeRegistro(
      postar(
        CAMINHO_DAS_OPCOES,
        { tipo: 'sessao' },
        {
          cookie: `__Host-painel_sessao=${minha.valor}`,
          'x-painel-csrf': await fichaCsrf(env, outra.sidHash),
        },
      ),
      env,
      AGORA,
    )

    // A ficha e DERIVADA do `sid_hash`: se ela nao dependesse dele, seria uma
    // constante do deploy e a camada 3 de §10.9 nao valeria nada.
    expect(resposta.status).toBe(403)
  })

  test('com sessao e ficha validas, o step-up ainda barra: e a falha e FECHADA', async () => {
    const sessao = await emitirSessao(env, AGORA)

    const resposta = await handleOpcoesDeRegistro(
      postar(
        CAMINHO_DAS_OPCOES,
        { tipo: 'sessao' },
        {
          cookie: `__Host-painel_sessao=${sessao.valor}`,
          'x-painel-csrf': await fichaCsrf(env, sessao.sidHash),
        },
      ),
      env,
      AGORA,
    )

    // §10.4 exige sessao + ficha + assertion de step-up. O verificador do
    // step-up nasce com a etapa dele; ate la o ramo recusa, que e a direcao
    // segura: uma autorizacao que nao da para verificar nao e concedida.
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toEqual({
      erro: 'step_up_necessario',
      mensagem: 'Confirme com a sua digital para continuar.',
    })
  })

  test('com o step-up ligado, o ramo `sessao` registra sem consumir nada', async () => {
    const sessao = await emitirSessao(env, AGORA)
    await env.DB.prepare(
      `INSERT INTO painel_sessoes
         (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
       VALUES (?, 'credencial-de-quem-esta-dentro', ?, ?, ?, ?, ?, 0)`,
    )
      .bind(sessao.sidHash, env.PANEL_RP_ID, AGORA, sessao.expiraEm, sessao.expiraEm, AGORA)
      .run()

    const deps = { conferirStepUp: async () => true }
    const cabecalhos = {
      cookie: `__Host-painel_sessao=${sessao.valor}`,
      'x-painel-csrf': await fichaCsrf(env, sessao.sidHash),
    }

    const opcoes = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'sessao' }, cabecalhos),
      env,
      AGORA,
      deps,
    )
    expect(opcoes.status).toBe(200)

    const aparelho = await AutenticadorFalso.criar('RS256')
    const resposta = await aparelho.registrar(
      cerimonia({
        rpId: env.PANEL_RP_ID,
        origem: RAIZ,
        desafio: await desafioDe(opcoes),
        tipo: 'webauthn.create',
      }),
    )
    const verificacao = await handleVerificarRegistro(
      postar(
        CAMINHO_DA_VERIFICACAO,
        { apelido: 'Segundo aparelho', credencial: resposta },
        { ...cabecalhos, cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
      ),
      env,
      AGORA,
    )

    expect(verificacao.status).toBe(200)

    const linha = await env.DB.prepare(
      'SELECT origem_registro, algoritmo, apelido FROM painel_credenciais LIMIT 1',
    ).first<{ origem_registro: string; algoritmo: number; apelido: string }>()
    // RS256 e o Windows Hello com TPM: os dois algoritmos de §10.4 gravam.
    expect(linha).toEqual({
      origem_registro: 'sessao',
      algoritmo: -257,
      apelido: 'Segundo aparelho',
    })

    // Nada a consumir: a autorizacao ja foi o step-up (§10.5). Sao 2 escritas,
    // e nenhum convite nem codigo foi queimado.
    const auditoria = await env.DB.prepare(
      'SELECT acao, step_up FROM painel_auditoria ORDER BY id DESC LIMIT 1',
    ).first<{ acao: string; step_up: number }>()
    expect(auditoria).toEqual({ acao: 'passkey_registrada', step_up: 1 })
  })

  test('a sessao cuja LINHA foi apagada nao autoriza', async () => {
    const sessao = await emitirSessao(env, AGORA)

    const resposta = await handleOpcoesDeRegistro(
      postar(
        CAMINHO_DAS_OPCOES,
        { tipo: 'sessao' },
        {
          cookie: `__Host-painel_sessao=${sessao.valor}`,
          'x-painel-csrf': await fichaCsrf(env, sessao.sidHash),
        },
      ),
      env,
      AGORA,
      { conferirStepUp: async () => true },
    )

    // O cookie fecha o HMAC, mas a LINHA e a autoridade (§10.13).
    expect(resposta.status).toBe(401)
    expect(await resposta.json()).toEqual({
      erro: 'sessao_ausente',
      mensagem: 'Você precisa entrar de novo.',
    })
  })
})

describe('CONV: os passos 8, 9 e 10 de §10.5, e o codigo de erro de §11.4', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('§11.4: excecao que escapa do lote e `500 falha_interna`, e nunca `503`', async () => {
    // A tabela canonica de §11.4 da `indisponivel` (503) a "D1 indisponivel ou
    // cota estourada" e `falha_interna` (500) a "qualquer excecao nao
    // prevista", e diz que o `try/catch` generico devolve a segunda. Um
    // `catch` que pega TUDO nao sabe qual dos dois aconteceu: anunciar 503
    // mandaria o dono conferir o status da Cloudflare por um defeito nosso.
    const { token } = await montarConvite()

    const registrado = capturarConsole()
    let verificacao: Response
    try {
      verificacao = await registrarComAparelho(
        await AutenticadorFalso.criar(),
        token,
        {},
        comAmbiente({ DB: new D1BatchQuebrado(env.DB) }),
      )
    } finally {
      registrado.parar()
    }

    expect(verificacao.status).toBe(500)
    expect(await verificacao.json()).toEqual({
      erro: 'falha_interna',
      mensagem: 'Algo deu errado. Tente de novo.',
    })
    // Nunca `detalhe`, `stack` nem mensagem de excecao no corpo, e no log, o
    // mesmo codigo canonico que o corpo carrega, e nao outro.
    expect(registrado.linhas.join('\n')).toContain('falha_interna')
    expect(registrado.linhas.join('\n')).not.toContain('indisponivel')
    expect(await contarCredenciais()).toBe(0)
  })

  test('§10.5 passo 8: `credential_id` repetido e recusa GENERICA, e nao `503`', async () => {
    // O `INSERT` vai sem `ON CONFLICT`, e o tombo do lote E a verificacao do
    // passo 8. Sem ler essa excecao ela virava `503`, com o convite ja
    // queimado, porque o consumo do nonce sai sozinho e ANTES do lote.
    const aparelho = await AutenticadorFalso.criar()

    const primeiro = await montarConvite()
    expect((await registrarComAparelho(aparelho, primeiro.token)).status).toBe(200)

    // `pre=q` porque `pre=0` ja nao valeria com uma passkey cadastrada
    // (CONV-07): o que este teste exercita e o conflito, e nao a precondicao.
    const segundo = await montarConvite({ pre: 'q' })

    const registrado = capturarConsole()
    let verificacao: Response
    try {
      verificacao = await registrarComAparelho(aparelho, segundo.token)
    } finally {
      registrado.parar()
    }

    // A recusa e a MESMA de assinatura invalida: distinguir "este
    // `credential_id` ja existe" daria um oraculo de enumeracao (§11.4).
    expect(verificacao.status).toBe(401)
    expect(await verificacao.json()).toEqual(CREDENCIAL_INVALIDA)
    // E o valor nunca vai para o log, em nenhuma das linhas (§10.13, §11.7).
    expect(registrado.linhas.join('\n')).not.toContain(aparelho.credentialId)

    // O lote inteiro caiu: nem credencial nova, nem linha de auditoria.
    expect(await contarCredenciais()).toBe(1)
    const auditoria = await env.DB.prepare('SELECT COUNT(*) AS n FROM painel_auditoria').first<{
      n: number
    }>()
    expect(auditoria?.n).toBe(1)

    // O convite do segundo aparelho FOI queimado, e §10.5 aceita esse preco de
    // proposito: a ordem inversa abriria a corrida em que duas requisicoes com
    // o mesmo convite inserem duas credenciais.
    const convites = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM painel_convites_usados',
    ).first<{ n: number }>()
    expect(convites?.n).toBe(2)
  })

  test('§10.5 passo 8: uma violacao `NOT NULL` no mesmo lote NAO e confundida com PK', async () => {
    // Robustez e observabilidade, nao um bug ao vivo (nenhum caminho tipado
    // hoje deixa uma das dez colunas `NOT NULL` de `painel_credenciais`
    // chegar nula neste INSERT): se o regex de `ehConflitoDeChave` casasse
    // QUALQUER `constraint failed`/`SQLITE_CONSTRAINT`, como casava antes,
    // este "e se" sairia como `401 credencial_invalida`, a mesma recusa
    // generica do passo 8, escondendo um defeito NOSSO atras da mesma frase de
    // "assinatura invalida". A tabela de §11.4 nao admite isso: excecao nao
    // prevista e `falha_interna`.
    const aparelho = await AutenticadorFalso.criar()
    const { token } = await montarConvite()

    const registrado = capturarConsole()
    let verificacao: Response
    try {
      verificacao = await registrarComAparelho(
        aparelho,
        token,
        {},
        comAmbiente({ DB: new D1QuebradoPorNotNull(env.DB) }),
      )
    } finally {
      registrado.parar()
    }

    expect(verificacao.status).toBe(500)
    expect(await verificacao.json()).toEqual({
      erro: 'falha_interna',
      mensagem: 'Algo deu errado. Tente de novo.',
    })
    expect(registrado.linhas.join('\n')).toContain('falha_interna')
    expect(registrado.linhas.join('\n')).not.toContain('credencial_invalida')
    // A credencial de verdade (a do aparelho autenticado) tambem nao entrou: o
    // duble substitui o lote inteiro pelo INSERT quebrado, entao nem ELA
    // deveria existir.
    expect(await contarCredenciais()).toBe(0)
  })

  test('§10.5 passo 9: com 10 credenciais, as options nem saem', async () => {
    // O numero vai LITERAL aqui e no `encherAsCredenciais` de proposito: um
    // teste escrito com `TETO_DE_CREDENCIAIS` acompanharia qualquer valor novo
    // e ficaria verde provando nada. §10.5 diz **10**, e mudar isso tem de
    // custar uma decisao consciente, com tres asserts vermelhos no caminho.
    expect(TETO_DE_CREDENCIAIS).toBe(10)

    await encherAsCredenciais(10)
    const { token } = await montarConvite({ pre: 'q' })

    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )

    // Conferido ja na primeira metade: uma cerimonia que so pudesse ser
    // recusada no fim gastaria uma biometria do dono para nada.
    expect(resposta.status).toBe(401)
    expect(await resposta.json()).toEqual(CREDENCIAL_INVALIDA)
    expect(resposta.headers.get('set-cookie')).toBeNull()
  })

  test('§10.5 passo 9: o teto tambem vale na GRAVACAO, e nao so nas options', async () => {
    // "Um teto que so vale na primeira metade nao e teto": entre uma
    // requisicao e outra o dono pode ter cadastrado por outro caminho. Aqui a
    // decima credencial nasce DEPOIS das options e ANTES da verificacao.
    await encherAsCredenciais(9)
    const { token } = await montarConvite({ pre: 'q' })

    const opcoes = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )
    expect(opcoes.status).toBe(200)

    await env.DB.prepare(
      `INSERT INTO painel_credenciais
         (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
          sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
       VALUES ('decima', ?, 'handle', '{}', -7, NULL, 0, 0, 0, 'aparelho', 'convite', ?, NULL)`,
    )
      .bind(env.PANEL_RP_ID, AGORA)
      .run()

    const aparelho = await AutenticadorFalso.criar()
    const resposta = await aparelho.registrar(
      cerimonia({
        rpId: env.PANEL_RP_ID,
        origem: RAIZ,
        desafio: await desafioDe(opcoes),
        tipo: 'webauthn.create',
      }),
    )
    const verificacao = await handleVerificarRegistro(
      postar(
        CAMINHO_DA_VERIFICACAO,
        { apelido: 'Decimo primeiro', credencial: resposta },
        { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
      ),
      env,
      AGORA,
    )

    expect(verificacao.status).toBe(401)
    expect(await verificacao.json()).toEqual(CREDENCIAL_INVALIDA)
    expect(await contarCredenciais()).toBe(10)
    // O teto barra ANTES de consumir: o convite continua inteiro.
    const convites = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM painel_convites_usados',
    ).first<{ n: number }>()
    expect(convites?.n).toBe(0)
  })

  test('WA-05 na ROTA: o desafio do corpo nao substitui o do bilhete', async () => {
    // Substituicao de desafio, e nao questao de estilo: se o
    // `desafioEsperado` virasse `corpo.desafio ?? bilhete.desafio`, quem envia
    // escolheria o que assina e o cookie viraria enfeite. WA-05 prende a regra
    // dentro do verificador; nenhum teste a prendia AQUI, onde o
    // `desafioEsperado` e escolhido.
    const { token } = await montarConvite()

    const opcoes = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: token }),
      env,
      AGORA,
    )
    expect(opcoes.status).toBe(200)

    // O desafio que o atacante escolheu, assinado por um autenticador honesto,
    // e diferente do que o bilhete carrega.
    const escolhido = paraBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    expect(escolhido).not.toBe(await desafioDe(opcoes))

    const aparelho = await AutenticadorFalso.criar()
    const resposta = await aparelho.registrar(
      cerimonia({
        rpId: env.PANEL_RP_ID,
        origem: RAIZ,
        desafio: escolhido,
        tipo: 'webauthn.create',
      }),
    )

    const registrado = capturarConsole()
    let verificacao: Response
    try {
      verificacao = await handleVerificarRegistro(
        postar(
          CAMINHO_DA_VERIFICACAO,
          // As duas grafias no corpo, na esperanca de que uma delas seja lida.
          { apelido: 'x', desafio: escolhido, challenge: escolhido, credencial: resposta },
          { cookie: `__Host-painel_desafio=${bilhete(opcoes)}` },
        ),
        env,
        AGORA,
      )
    } finally {
      registrado.parar()
    }

    expect(verificacao.status).toBe(401)
    expect(await verificacao.json()).toEqual(CREDENCIAL_INVALIDA)
    expect(registrado.linhas.join('\n')).toContain('desafio_diferente')
    expect(await contarCredenciais()).toBe(0)
  })

  test('§10.5 passo 10: o apelido e SANEADO, e nunca motivo de recusa', async () => {
    // "Saneado", e nao "recusado": um apelido longo ou esquisito digitado num
    // celular nao pode custar a cerimonia de biometria do dono, no limite,
    // trancaria quem instala para fora do proprio painel.
    const { token } = await montarConvite()
    const comLixo = `  Celular\u0000 do\u200b João${'!'.repeat(80)}  `

    expect(
      (await registrarComAparelho(await AutenticadorFalso.criar(), token, { apelido: comLixo }))
        .status,
    ).toBe(200)

    const linha = await linhaGravada()
    // Sem caracteres de controle nem de formatacao, cortado em 40, sem espaco
    // nas pontas, e o texto util sobreviveu.
    expect(linha?.apelido).toBe(`Celular do João${'!'.repeat(25)}`)
    expect(linha?.apelido).toHaveLength(TAMANHO_DO_APELIDO)
    expect(linha?.apelido).not.toMatch(/[\p{Cc}\p{Cf}]/u)
  })

  test('§10.5 passo 10: apelido ausente, vazio ou de outro tipo vira o padrao', async () => {
    for (const [i, apelido] of [undefined, '   ', '\u0000\u200b', 42, { a: 1 }].entries()) {
      await limparBanco(env.DB)
      const { token } = await montarConvite()
      const corpo = apelido === undefined ? {} : { apelido }

      expect(
        (await registrarComAparelho(await AutenticadorFalso.criar(), token, corpo)).status,
      ).toBe(200)
      expect(`${i}=${(await linhaGravada())?.apelido}`).toBe(`${i}=Aparelho`)
    }
  })

  test('§10.5 passo 10: o apelido NAO e escapado na gravacao', async () => {
    // Ele e escapado na RENDERIZACAO, automaticamente. Escapar aqui gravaria
    // `&amp;` no banco e o dono veria a propria escapatoria na tela.
    const { token } = await montarConvite()

    expect(
      (
        await registrarComAparelho(await AutenticadorFalso.criar(), token, {
          apelido: '<b>Zé & Cia</b>',
        })
      ).status,
    ).toBe(200)

    expect((await linhaGravada())?.apelido).toBe('<b>Zé & Cia</b>')
  })

  test('§8.6: `transportes` guarda so o vocabulario da WebAuthn, e nada alem', async () => {
    // O campo vem de um corpo NAO confiavel e e so dica de interface: nenhuma
    // decisao do painel olha para ele. O que o protege e a allowlist.
    const { token } = await montarConvite()

    expect(
      (
        await registrarComAparelho(await AutenticadorFalso.criar(), token, {
          transportes: ['internal', '<script>', 'hybrid', 42, null, 'usb'],
        })
      ).status,
    ).toBe(200)

    expect((await linhaGravada())?.transportes).toBe('["internal","hybrid","usb"]')
  })

  test('§8.6: `transportes` que nao e lista, ou so tem lixo, vira NULL', async () => {
    for (const [i, transportes] of [
      undefined,
      'internal',
      [],
      ['bluetooth', 'wifi'],
      { 0: 'usb' },
    ].entries()) {
      await limparBanco(env.DB)
      const { token } = await montarConvite()
      const corpo = transportes === undefined ? {} : { transportes }

      expect(
        (await registrarComAparelho(await AutenticadorFalso.criar(), token, corpo)).status,
      ).toBe(200)
      expect(`${i}=${(await linhaGravada())?.transportes}`).toBe(`${i}=null`)
    }
  })
})

describe('CONV: a escada de §11.3 e a pagina do convite', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('metodo errado devolve 405 com `Allow`, e `OPTIONS` cai nele', async () => {
    for (const metodo of ['GET', 'PUT', 'OPTIONS']) {
      const resposta = await handleOpcoesDeRegistro(
        new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, { method: metodo, headers: { origin: RAIZ } }),
        env,
        AGORA,
      )
      expect(`${metodo}=${resposta.status}`).toBe(`${metodo}=405`)
      expect(resposta.headers.get('allow')).toBe('POST')
      // `OPTIONS` cai em 405 de proposito: nenhuma rota do painel emite
      // `Access-Control-*`, em nenhuma hipotese (§10.9, camada 5).
      expect(resposta.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  test('§11.3: o passo 0 vem ANTES do passo 1, e `OPTIONS` sem `PANEL_RP_ID` e 503', async () => {
    // A ordem da escada e artefato de especificacao, e `router.ts` a copia:
    // la o portao de sanidade roda antes do `switch` de caminhos. Se o metodo
    // fosse conferido primeiro AQUI, a mesma requisicao teria duas respostas
    // conforme quem chamasse o handler, 405 pelo handler, 503 pelo roteador.
    const desligado = comAmbiente({ PANEL_RP_ID: '' })

    for (const metodo of ['OPTIONS', 'GET', 'PUT']) {
      const resposta = await handleOpcoesDeRegistro(
        new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, { method: metodo, headers: { origin: RAIZ } }),
        desligado,
        AGORA,
      )
      expect(`${metodo}=${resposta.status}`).toBe(`${metodo}=503`)
      expect(resposta.headers.get('allow')).toBeNull()
    }

    // Na pagina do convite vale a mesma ordem, e pelo mesmo motivo.
    const pagina = handlePaginaDeConvite(
      new Request(`${RAIZ}${CAMINHO_DO_CONVITE}`, { method: 'POST' }),
      desligado,
    )
    expect(pagina.status).toBe(503)
  })

  test('sem `PANEL_RP_ID` o painel responde 503, e nao adivinha o endereco', async () => {
    const resposta = await handleOpcoesDeRegistro(
      postar(CAMINHO_DAS_OPCOES, { tipo: 'convite', convite: 'x' }),
      comAmbiente({ PANEL_RP_ID: '' }),
      AGORA,
    )

    // Credencial criada com `rpId` errado e IRRECUPERAVEL (§10.14): vazio e
    // 503, nunca `url.hostname`, que e controlado pelo cliente.
    expect(resposta.status).toBe(503)
    expect(await resposta.json()).toEqual({
      erro: 'painel_desativado',
      mensagem: 'O painel ainda não foi ativado.',
    })
  })

  test('origem ausente ou errada e 403; `Sec-Fetch-Site: same-origin` salva', async () => {
    const semOrigem = new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect((await handleOpcoesDeRegistro(semOrigem, env, AGORA)).status).toBe(403)

    // Comparacao de string INTEIRA: um sufixo hostil que CONTEM o nome do
    // painel passaria em `includes` e em `startsWith`.
    const hostil = postar(CAMINHO_DAS_OPCOES, {}, { origin: `${RAIZ}.evil.com` })
    expect((await handleOpcoesDeRegistro(hostil, env, AGORA)).status).toBe(403)

    // O fallback existe para nao trancar o dono num navegador que nao mande
    // `Origin`, deixou de ser pendencia de projeto e virou este teste.
    const comFetchSite = new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ tipo: 'convite', convite: 'nao-e-convite' }),
    })
    expect((await handleOpcoesDeRegistro(comFetchSite, env, AGORA)).status).toBe(401)
  })

  test('`content-type` errado e 415; com `charset` continua valendo', async () => {
    const formulario = new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: RAIZ },
      body: 'tipo=convite',
    })
    expect((await handleOpcoesDeRegistro(formulario, env, AGORA)).status).toBe(415)

    // Media type e case-INSENSITIVE por RFC 9110, e o `; charset=utf-8` que os
    // navegadores anexam e legitimo.
    const comCharset = new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
      method: 'POST',
      headers: { 'content-type': 'Application/JSON; charset=utf-8', origin: RAIZ },
      body: JSON.stringify({ tipo: 'convite', convite: 'nao-e-convite' }),
    })
    expect((await handleOpcoesDeRegistro(comCharset, env, AGORA)).status).toBe(401)
  })

  test('corpo acima de 8 KB e 413, e nao custa consulta nenhuma', async () => {
    const contador = new D1Contador(env.DB)
    const gigante = postar(CAMINHO_DAS_OPCOES, {
      tipo: 'convite',
      convite: 'x'.repeat(TETO_DO_CORPO_DA_API + 1),
    })

    const resposta = await handleOpcoesDeRegistro(
      gigante,
      comAmbiente({ DB: comoD1(contador) }),
      AGORA,
    )

    expect(resposta.status).toBe(413)
    expect(contador.prepares).toBe(0)
  })

  test('JSON malformado e `corpo_invalido`, nunca `500`', async () => {
    const quebrado = new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: RAIZ },
      body: '{"tipo": "convite",',
    })

    const resposta = await handleOpcoesDeRegistro(quebrado, env, AGORA)

    expect(resposta.status).toBe(400)
    expect(await resposta.json()).toEqual({
      erro: 'corpo_invalido',
      mensagem: 'Não foi possível ler os dados enviados.',
    })
  })

  test('a pagina do convite nao consulta o D1 e avisa o que §10.14 manda avisar', async () => {
    const contador = new D1Contador(env.DB)

    const resposta = handlePaginaDeConvite(
      new Request(`${RAIZ}${CAMINHO_DO_CONVITE}#c=um-convite-qualquer`),
      comAmbiente({ DB: comoD1(contador) }),
    )
    const html = await resposta.text()

    expect(resposta.status).toBe(200)
    expect(contador.prepares).toBe(0)
    // O token viaja no FRAGMENTO, e o fragmento nunca chega ao servidor: nao
    // pode haver rastro dele na pagina que o Worker devolve.
    expect(html).not.toContain('um-convite-qualquer')
    // Os dois avisos obrigatorios ANTES do primeiro cadastro (§10.14 item 6).
    expect(html).toContain('cadastrado de novo')
    expect(html).toContain('sem PIN n&atilde;o entra')
    expect(resposta.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(resposta.headers.get('cache-control')).toBe('private, no-store')
  })

  test('a pagina do convite aceita `HEAD`, e o `Allow` do 405 diz os dois metodos', async () => {
    const cabeca = handlePaginaDeConvite(
      new Request(`${RAIZ}${CAMINHO_DO_CONVITE}`, { method: 'HEAD' }),
      env,
    )
    expect(cabeca.status).toBe(200)

    const recusado = handlePaginaDeConvite(
      new Request(`${RAIZ}${CAMINHO_DO_CONVITE}`, { method: 'POST' }),
      env,
    )

    expect(recusado.status).toBe(405)
    // `Allow` existe justamente para nao mentir: `GET` sozinho omitia o `HEAD`
    // que a linha acima acabou de provar que o handler atende.
    expect(recusado.headers.get('allow')).toBe('GET, HEAD')
    // E o corpo e HTML, como o `content-type` promete, com a frase canonica
    // de §11.4 para `metodo_nao_permitido`, e nao um texto solto.
    expect(recusado.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await recusado.text()).toContain('<h1>M&eacute;todo n&atilde;o permitido.</h1>')
  })

  test('sem o painel ativado, a pagina do convite responde 503', async () => {
    const resposta = handlePaginaDeConvite(
      new Request(`${RAIZ}${CAMINHO_DO_CONVITE}`),
      comAmbiente({ PANEL_RP_ID: '' }),
    )

    expect(resposta.status).toBe(503)
    expect(await resposta.text()).toContain('ainda n&atilde;o foi ativado')
  })
})
