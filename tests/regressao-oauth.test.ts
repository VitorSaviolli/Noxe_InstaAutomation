import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { TokensRepository } from '../src/repositories/tokens-repository'
import { decrypt } from '../src/security/encryption'
import { createState, STATE_TTL_MS, validateState } from '../src/security/oauth-state'
import { storeAccessToken } from '../src/services/token-manager'
import { limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  IG_USER_ID,
  pedir,
  RAIZ,
  responder,
  USERNAME_CONTA,
} from './fixtures/dubles'

/**
 * REG — regressao do fluxo OAuth de instalacao.
 *
 * O `/setup/*` e o `/oauth/callback` sao anteriores ao painel e continuam
 * anteriores a ele: quem entra ali e o dono com o SETUP_ADMIN_TOKEN, ou o
 * navegador voltando da Meta com um `state` assinado. Nao ha cookie, nao ha
 * sessao e nao pode passar a haver.
 *
 * A parte do formato do `state` e a mais importante deste arquivo: ela e a
 * unica prova de que extrair o codificador base64url de `oauth-state.ts` para
 * um modulo proprio nao mudou um unico byte do que sai na URL.
 */

const ADMIN = 'admin-token-de-teste'

/** O `responder` do fixture, ja com o env desta suite. */
function responderComEnv(request: Request): Promise<Response> {
  return responder(request, env)
}

describe('REG — /setup/* continua protegido so pelo SETUP_ADMIN_TOKEN', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('REG-11: /setup/authorize sem cabecalho continua 401', async () => {
    const resposta = await responderComEnv(pedir('/setup/authorize'))

    expect(resposta.status).toBe(401)
    expect(await resposta.text()).toBe('Nao autorizado')
  })

  test('REG-12: /setup/authorize com Bearer continua devolvendo authorizationUrl', async () => {
    const resposta = await responderComEnv(
      pedir('/setup/authorize', { authorization: `Bearer ${ADMIN}` }),
    )

    expect(resposta.status).toBe(200)
    const corpo = (await resposta.json()) as { authorizationUrl?: string }
    expect(corpo.authorizationUrl).toBeDefined()

    const destino = new URL(corpo.authorizationUrl ?? '')
    expect(destino.origin).toBe('https://www.instagram.com')
    expect(destino.pathname).toBe('/oauth/authorize')
    expect(destino.searchParams.get('redirect_uri')).toBe(`${RAIZ}/oauth/callback`)
    // O state sai assinado na propria URL de consentimento.
    expect(destino.searchParams.get('state')?.split('.')).toHaveLength(3)
  })

  test('REG-13: token na query string continua nao sendo aceito', async () => {
    const porQuery = await responderComEnv(pedir(`/setup/authorize?token=${ADMIN}`))
    expect(porQuery.status).toBe(401)

    const comoBearer = await responderComEnv(pedir(`/setup/authorize?access_token=${ADMIN}`))
    expect(comoBearer.status).toBe(401)
  })

  test('REG-17: /setup/subscribe continua exigindo Bearer', async () => {
    const semNada = await responderComEnv(
      new Request(`${RAIZ}/setup/subscribe`, { method: 'POST' }),
    )
    expect(semNada.status).toBe(401)

    const comTokenErrado = await responderComEnv(
      new Request(`${RAIZ}/setup/subscribe`, {
        method: 'POST',
        headers: { authorization: 'Bearer token-errado' },
      }),
    )
    expect(comTokenErrado.status).toBe(401)

    // Com o token certo e sem conta ligada, para em 409 — sem tocar a rede.
    const comTokenCerto = await responderComEnv(
      new Request(`${RAIZ}/setup/subscribe`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    )
    expect(comTokenCerto.status).toBe(409)
  })

  test('REG-18: o token da conta continua cifrado no banco e nao e devolvido', async () => {
    const TOKEN = 'IGQVJXsegredo-do-token-de-acesso-longo'
    await storeAccessToken(env, {
      igUserId: IG_USER_ID,
      username: USERNAME_CONTA,
      accessToken: TOKEN,
      expiresInSeconds: 60 * 24 * 60 * 60,
      now: AGORA,
    })

    const registro = await new TokensRepository(env.DB).get()
    expect(registro?.encrypted_token).toBeDefined()
    expect(registro?.encrypted_token).not.toContain(TOKEN)
    expect(await decrypt(registro?.encrypted_token ?? '', env.TOKEN_ENCRYPTION_KEY)).toBe(TOKEN)

    // Nenhuma rota publica devolve o token.
    const saude = await responderComEnv(pedir('/health'))
    expect(await saude.text()).not.toContain(TOKEN)

    const autorizar = await responderComEnv(
      pedir('/setup/authorize', { authorization: `Bearer ${ADMIN}` }),
    )
    expect(await autorizar.text()).not.toContain(TOKEN)
  })

  test('REG-19: /setup/* e /oauth/callback nao emitem, nao leem e nao aceitam cookie', async () => {
    const comCookie = { cookie: 'painel_sessao=qualquer-coisa' }

    // Nao aceitam: o cookie nao substitui o Bearer.
    const autorizar = await responderComEnv(pedir('/setup/authorize', comCookie))
    expect(autorizar.status).toBe(401)
    expect(autorizar.headers.get('set-cookie')).toBeNull()

    const inscrever = await responderComEnv(
      new Request(`${RAIZ}/setup/subscribe`, { method: 'POST', headers: comCookie }),
    )
    expect(inscrever.status).toBe(401)
    expect(inscrever.headers.get('set-cookie')).toBeNull()

    // Nao emitem: nem no caminho autorizado.
    const autorizado = await responderComEnv(
      pedir('/setup/authorize', { authorization: `Bearer ${ADMIN}`, ...comCookie }),
    )
    expect(autorizado.status).toBe(200)
    expect(autorizado.headers.get('set-cookie')).toBeNull()

    // E o callback tambem nao, nem quando recusa.
    const callback = await responderComEnv(
      pedir('/oauth/callback?state=invalido&code=abc', comCookie),
    )
    expect(callback.status).toBe(403)
    expect(callback.headers.get('set-cookie')).toBeNull()
  })

  test('REG-21: /setup/painel/codigos exige Bearer e nunca loga o corpo', async () => {
    // Sem cabecalho, com Bearer errado e com cookie no lugar do Bearer: as tres
    // recusas sao a mesma, e nenhuma delas grava linha nenhuma.
    const recusas: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer token-errado' },
      { cookie: `painel_sessao=${ADMIN}` },
    ]

    for (const cabecalhos of recusas) {
      const recusada = await responderComEnv(
        new Request(`${RAIZ}/setup/painel/codigos`, { method: 'POST', headers: cabecalhos }),
      )

      expect(recusada.status).toBe(401)
      expect(await recusada.text()).toBe('Nao autorizado')
      expect(recusada.headers.get('set-cookie')).toBeNull()
      expect(await contarCodigos()).toBe(0)
    }

    // Com o Bearer certo, os codigos saem — uma unica vez, no corpo.
    const registrado = capturarConsole()
    let corpo: { recuperacao: string[]; parada: string }
    try {
      const aceita = await responderComEnv(
        new Request(`${RAIZ}/setup/painel/codigos`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ADMIN}` },
        }),
      )

      expect(aceita.status).toBe(200)
      expect(aceita.headers.get('cache-control')).toBe('private, no-store')
      corpo = (await aceita.json()) as { recuperacao: string[]; parada: string }
    } finally {
      registrado.parar()
    }

    expect(corpo.recuperacao).toHaveLength(6)
    expect(await contarCodigos()).toBe(7)

    // E o corpo NUNCA foi para o log, em nivel nenhum: nem o codigo formatado,
    // nem o codigo sem os hifens da exibicao.
    const tudoQueFoiLogado = registrado.linhas.join(' | ')
    for (const codigo of [...corpo.recuperacao, corpo.parada]) {
      expect(tudoQueFoiLogado).not.toContain(codigo)
      expect(tudoQueFoiLogado).not.toContain(codigo.replaceAll('-', ''))
    }
  })

  test.todo('REG-22: /setup/painel/zerar exige Bearer e nao toca account_tokens (etapa 7)')
})

describe('REG — o `state` do OAuth continua exatamente como e hoje', () => {
  /**
   * Vetor de ouro. `n0.1700000600000` foi escolhido porque o HMAC-SHA256 dele
   * com o SETUP_ADMIN_TOKEN de teste produz, em base64 PADRAO, os tres
   * caracteres que separam base64 de base64url ao mesmo tempo: `+`, `/` e o
   * `=` do padding. Qualquer troca no codificador quebra este teste.
   */
  const NONCE = 'n0'
  const EXPIRA_EM = AGORA + STATE_TTL_MS
  const ASSINATURA_BASE64URL = 'oHpYE8r6ToW4iOxjtL2w_IofAq7N4Rj8FxVzO--16O0'
  const ASSINATURA_BASE64_PADRAO = 'oHpYE8r6ToW4iOxjtL2w/IofAq7N4Rj8FxVzO++16O0='
  const STATE_DE_OURO = `${NONCE}.${EXPIRA_EM}.${ASSINATURA_BASE64URL}`

  /** Somente o alfabeto base64url, e nunca o padding. */
  const BASE64URL = /^[A-Za-z0-9_-]+$/

  test('REG-14: o vetor de ouro e aceito byte a byte', async () => {
    expect(await validateState(STATE_DE_OURO, ADMIN, AGORA)).toEqual({ valid: true })
  })

  test('REG-14: a MESMA assinatura em base64 padrao (+ / =) e recusada', async () => {
    const emBase64Padrao = `${NONCE}.${EXPIRA_EM}.${ASSINATURA_BASE64_PADRAO}`

    expect(await validateState(emBase64Padrao, ADMIN, AGORA)).toEqual({
      valid: false,
      reason: 'assinatura_invalida',
    })
  })

  test('REG-14: a assinatura com padding restaurado tambem e recusada', async () => {
    const comPadding = `${NONCE}.${EXPIRA_EM}.${ASSINATURA_BASE64URL}=`

    expect(await validateState(comPadding, ADMIN, AGORA)).toEqual({
      valid: false,
      reason: 'assinatura_invalida',
    })
  })

  test('REG-14: o formato e nonce.expiraEm.assinatura, os dois em base64url sem padding', async () => {
    const state = await createState(ADMIN, AGORA)
    const partes = state.split('.')

    expect(partes).toHaveLength(3)

    const [nonce, expiraEm, assinatura] = partes as [string, string, string]
    // 16 bytes aleatorios em base64url sem padding sao 22 caracteres.
    expect(nonce).toMatch(BASE64URL)
    expect(nonce).toHaveLength(22)
    // 32 bytes de HMAC-SHA256 em base64url sem padding sao 43 caracteres.
    expect(assinatura).toMatch(BASE64URL)
    expect(assinatura).toHaveLength(43)
    expect(expiraEm).toBe(String(AGORA + STATE_TTL_MS))
  })

  test('REG-14: o state e assinado com SETUP_ADMIN_TOKEN e nao com outro segredo', async () => {
    const state = await createState(ADMIN, AGORA)

    expect(await validateState(state, ADMIN, AGORA)).toEqual({ valid: true })
    expect(await validateState(state, 'outra-chave-qualquer', AGORA)).toEqual({
      valid: false,
      reason: 'assinatura_invalida',
    })
  })

  test('REG-14: nenhum state emitido em 200 tentativas escapa do alfabeto base64url', async () => {
    for (let i = 0; i < 200; i++) {
      const [nonce, , assinatura] = (await createState(ADMIN, AGORA)).split('.') as [
        string,
        string,
        string,
      ]
      expect(nonce).toMatch(BASE64URL)
      expect(assinatura).toMatch(BASE64URL)
    }
  })

  test('REG-15: callback com state expirado continua recusado', async () => {
    const state = await createState(ADMIN, AGORA)

    expect(await validateState(state, ADMIN, AGORA + STATE_TTL_MS)).toEqual({ valid: true })
    expect(await validateState(state, ADMIN, AGORA + STATE_TTL_MS + 1)).toEqual({
      valid: false,
      reason: 'expirado',
    })

    const resposta = await responderComEnv(
      pedir(`/oauth/callback?state=${encodeURIComponent(state)}&code=qualquer`),
    )
    // O callback usa o relogio real, muito depois de AGORA: state vencido.
    expect(resposta.status).toBe(403)
  })

  test('REG-16: callback com state de outro segredo continua recusado', async () => {
    const forjado = await createState('segredo-do-atacante', Date.now())
    const resposta = await responderComEnv(
      pedir(`/oauth/callback?state=${encodeURIComponent(forjado)}&code=qualquer`),
    )

    expect(resposta.status).toBe(403)
    expect(await resposta.text()).toContain('State invalido')
  })

  test('REG-20: STATE_TTL_MS continua 10 minutos', () => {
    expect(STATE_TTL_MS).toBe(10 * 60 * 1000)
  })
})

/** Quantas linhas a tabela de codigos tem agora. */
async function contarCodigos(): Promise<number> {
  const linha = await env.DB.prepare('SELECT COUNT(*) AS total FROM painel_codigos').first<{
    total: number
  }>()
  return linha?.total ?? -1
}
