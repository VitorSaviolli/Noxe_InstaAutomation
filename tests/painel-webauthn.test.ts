import { env } from 'cloudflare:test'
import { describe, expect, test, vi } from 'vitest'
import {
  CAMINHO_DA_PARADA,
  handleParada,
  TETO_DO_CORPO_DA_PARADA,
} from '../src/routes/painel/parada'
import {
  CAMINHO_DAS_OPCOES,
  handleOpcoesDeRegistro,
  TETO_DO_CORPO_DA_API,
} from '../src/routes/painel/registrar'
import { bytesToBase64Url, decodeBase64Url } from '../src/security/base64url'
import { PRAZO_DE_ENVELOPE_MS, type PropositoDeEnvelope } from '../src/security/signed-envelope'
import { emitirEnvelope, lerEnvelope, origemDoPainel } from '../src/services/panel-session'
import {
  BYTES_MAXIMOS,
  decodificarCbor,
  inteiroDoMapa,
  PROFUNDIDADE_MAXIMA,
  textoDoMapa,
} from '../src/services/webauthn/cbor'
import { ALG_ES256, ALG_RS256, coseParaJwk } from '../src/services/webauthn/cose'
import { derParaBruto, TAMANHO_DA_ASSINATURA_CRUA } from '../src/services/webauthn/der'
import {
  opcoesDeLogin,
  opcoesDeRegistro,
  opcoesDeStepUp,
  sortearDesafio,
} from '../src/services/webauthn/opcoes'
import {
  type CredencialGuardada,
  type MotivoWebauthn,
  prefixoDeCredencial,
  type RespostaDeAssertion,
  type ResultadoDeAssertion,
  verificarAssertion,
  verificarRegistro,
} from '../src/services/webauthn/verificar'
import {
  AutenticadorFalso,
  type Cerimonia,
  cbBytes,
  cbInteiro,
  cbLista,
  cbMapa,
  cbTexto,
  cerimonia,
  codificarCbor,
  comBackup,
  comExtensao,
  comOrigin,
  comRpId,
  comSignCount,
  comTipo,
  cruParaDer,
  deBase64Url,
  paraBase64Url,
  semUp,
  semUv,
  trocarByte,
} from './fixtures/autenticador'
import { AGORA, capturarConsole, comoD1, D1Contador, RAIZ } from './fixtures/dubles'
import {
  faltaOVetor,
  NOMES_DE_VETOR,
  type VetorDeAssertion,
  vetorDeAssertion,
  vetorDeRegistro,
  vetoresAusentes,
  vetoresPresentes,
} from './fixtures/vetores-webauthn'

/**
 * WA, verificacao WebAuthn (§13.2, 29 garantias).
 *
 * Metodo T2 (§13.3): **duas fontes independentes**. O `AutenticadorFalso` de
 * `tests/fixtures/autenticador.ts` gera a variacao, dezenas de cerimonias,
 * cada uma com exatamente uma coisa diferente, e os vetores congelados de
 * `tests/fixtures/vetores-webauthn.ts` provam que essa variacao corresponde ao
 * mundo real. Uma fonte so nao basta: o autenticador sozinho daria testes
 * SIMETRICOS, e os vetores sozinhos dariam cobertura pobre.
 *
 * **Estado do Step 5 desta tarefa: BLOCKED.** Nenhum vetor de hardware foi
 * capturado ainda. Os testes que dependem deles estao aqui, escritos, como
 * `test.todo` que NOMEIA o vetor que falta, a promessa vira alarme em vez de
 * bilhete esquecido. Ver o cabecalho de `vetores-webauthn.ts`.
 *
 * Uma garantia ainda fica em `test.todo` por outro motivo, escrito no lugar
 * dela: WA-28 fala do teto de corpo de FORMULARIO, e as rotas de formulario do
 * painel nascem nas Etapas 9 a 11. Afirma-la aqui seria empurrar uma afirmacao
 * da linha dela para outra, que e exatamente o que §13.1 proibe. WA-25 esteve
 * nesse mesmo estado ate a Etapa 7 criar a familia `/painel/api/*`.
 *
 * `now` e sempre injetado (`AGORA`), sem fake timers. Nenhum teste desta suite
 * toca o D1, salvo os de WA-25 e WA-29, que provam o contrario disso em duas
 * rotas.
 */

// ---------------------------------------------------------------------------
// O cenario
// ---------------------------------------------------------------------------

/** O endereco ficticio do painel de teste. Vem do binding, nunca escrito aqui. */
const RP_ID = env.PANEL_RP_ID
const ORIGEM = origemDoPainel(env)

/** `painel_estado.usuario_handle`: 32 bytes estaveis, como manda §10.4 passo 5. */
const DONO = bytesToBase64Url(new Uint8Array(32).fill(7))

/**
 * A composicao que a rota fara: envelope primeiro, verificacao depois.
 *
 * Escrita aqui porque as garantias do desafio (WA-03 e WA-04) sao sobre essa
 * COMPOSICAO, o desafio so chega ao verificador atraves do envelope assinado,
 * e e o envelope quem confere prazo e proposito. Um teste que passasse o
 * desafio direto ao verificador nao provaria nada sobre prazo nenhum.
 */
async function verificarComEnvelope(entrada: {
  proposito: PropositoDeEnvelope
  envelope: string
  resposta: RespostaDeAssertion
  credencial: CredencialGuardada | null
  now: number
  rpId?: string
}): Promise<ResultadoDeAssertion | { ok: false; motivo: string }> {
  const leitura = await lerEnvelope(env, entrada.proposito, entrada.envelope, entrada.now)
  if (!leitura.valido) return { ok: false, motivo: `envelope_${leitura.motivo}` }

  return verificarAssertion({
    resposta: entrada.resposta,
    rpId: entrada.rpId ?? RP_ID,
    origem: ORIGEM,
    desafioEsperado: leitura.claims.c ?? '',
    credencial: entrada.credencial,
    usuarioHandleEsperado: DONO,
  })
}

/** Emite um envelope de cerimonia com um desafio sorteado, como a rota faz. */
async function bilhete(
  proposito: PropositoDeEnvelope,
  now = AGORA,
): Promise<{ desafio: string; envelope: string }> {
  const desafio = sortearDesafio()
  return { desafio, envelope: await emitirEnvelope(env, proposito, { c: desafio }, now) }
}

/** A linha de `painel_credenciais` que o autenticador produziria. */
function credencialDe(
  autenticador: AutenticadorFalso,
  patch: Partial<CredencialGuardada> = {},
): CredencialGuardada {
  return {
    credentialId: autenticador.credentialId,
    rpId: RP_ID,
    usuarioHandle: DONO,
    jwk: autenticador.jwkParaOBanco,
    algoritmo: autenticador.algCose,
    signCount: 0,
    ...patch,
  }
}

/** A cerimonia padrao de login, com o desafio do bilhete. */
function login(desafio: string): Cerimonia {
  return cerimonia({ rpId: RP_ID, origem: ORIGEM, desafio, tipo: 'webauthn.get' })
}

/** A cerimonia padrao de registro. */
function registro(desafio: string): Cerimonia {
  return cerimonia({ rpId: RP_ID, origem: ORIGEM, desafio, tipo: 'webauthn.create' })
}

/** O motivo da recusa, ou `'aceito'`. Deixa a mensagem do `expect` legivel. */
function motivoDe(resultado: { ok: boolean; motivo?: string }): string {
  return resultado.ok ? 'aceito' : (resultado.motivo ?? 'sem_motivo')
}

// ---------------------------------------------------------------------------
// WA-01 e WA-02, os dois algoritmos aceitos
// ---------------------------------------------------------------------------

describe('WA: as duas cerimonias felizes', () => {
  test('WA-01: assertion ES256 valida e aceita', async () => {
    const autenticador = await AutenticadorFalso.criar('ES256')
    const { desafio, envelope } = await bilhete('entrar')

    const resposta = await autenticador.autenticar(login(desafio), DONO)
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('aceito')
  })

  test('WA-01: attestation ES256 valida e aceita, e devolve a chave importavel', async () => {
    const autenticador = await AutenticadorFalso.criar('ES256')
    const { desafio } = await bilhete('registrar')

    const resultado = await verificarRegistro({
      resposta: await autenticador.registrar(registro(desafio)),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('aceito')
    if (!resultado.ok) return
    expect(resultado.credencial.credentialId).toBe(autenticador.credentialId)
    expect(resultado.credencial.algoritmo).toBe(ALG_ES256)
    expect(resultado.credencial.jwk.kty).toBe('EC')
    expect(resultado.credencial.jwk.crv).toBe('P-256')
  })

  test('WA-01: o id do corpo tem que ser o credentialId de dentro do authData', async () => {
    const autenticador = await AutenticadorFalso.criar('ES256')
    const { desafio } = await bilhete('registrar')

    // Quem envia escolhe o `id` do corpo. Se o servidor gravasse a chave sob
    // ESSE identificador, o banco guardaria a chave publica do dono sob um
    // nome escolhido por outra pessoa, e o login por aquele nome passaria a
    // ser verificado contra a chave errada.
    const resultado = await verificarRegistro({
      resposta: await autenticador.registrar(registro(desafio), {
        idDoCorpo: bytesToBase64Url(new Uint8Array(32).fill(0x5a)),
      }),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('campo_ausente')
  })

  test('WA-01: chave EC com o tamanho certo mas fora da curva nao entra no banco', async () => {
    const autenticador = await AutenticadorFalso.criar('ES256')
    const { desafio } = await bilhete('registrar')

    // `x` e `y` de 32 bytes cada, `kty`, `alg` e `crv` corretos: o mapa COSE
    // passa por `cose.ts` inteiro. O que recusa isto e o `importKey` chamado
    // AGORA, no registro (§10.5, passo 7), se a chave nao importa, a
    // credencial nunca vira linha. Adiar a importacao para o login gravaria
    // uma passkey que nunca mais consegue entrar.
    const foraDaCurva = codificarCbor(
      cbMapa([
        [cbInteiro(1), cbInteiro(2)],
        [cbInteiro(3), cbInteiro(ALG_ES256)],
        [cbInteiro(-1), cbInteiro(1)],
        [cbInteiro(-2), cbBytes(new Uint8Array(32).fill(0x01))],
        [cbInteiro(-3), cbBytes(new Uint8Array(32).fill(0x02))],
      ]),
    )

    const resultado = await verificarRegistro({
      resposta: await autenticador.registrar(registro(desafio), { coseSubstituto: foraDaCurva }),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('chave_nao_importa')
  })

  test('WA-02: attestation RS256 valida e aceita: o caminho do Windows Hello', async () => {
    const autenticador = await AutenticadorFalso.criar('RS256')
    const { desafio } = await bilhete('registrar')

    const resultado = await verificarRegistro({
      resposta: await autenticador.registrar(registro(desafio)),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('aceito')
    if (!resultado.ok) return
    expect(resultado.credencial.algoritmo).toBe(ALG_RS256)
    expect(resultado.credencial.jwk.kty).toBe('RSA')
    // 2048 bits: o modulo tem 256 bytes, e o piso de §10.5 e exatamente esse.
    expect(decodeBase64Url(resultado.credencial.jwk.n ?? '')?.length).toBe(256)
  })

  test('WA-02: assertion RS256 valida e aceita, e a assinatura NAO passa por DER', async () => {
    const autenticador = await AutenticadorFalso.criar('RS256')
    const { desafio, envelope } = await bilhete('entrar')

    const resposta = await autenticador.autenticar(login(desafio), DONO)
    // RS256 ja vem bruta do autenticador: 256 bytes, e nao um SEQUENCE.
    expect(deBase64Url(resposta.signature).length).toBe(256)
    expect(derParaBruto(deBase64Url(resposta.signature))).toBeNull()

    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('aceito')
  })
})

// ---------------------------------------------------------------------------
// WA-03 a WA-05, o desafio
// ---------------------------------------------------------------------------

describe('WA: o desafio vem do envelope assinado, e so dele', () => {
  test('WA-03: desafio expirado e recusado', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')
    const resposta = await autenticador.autenticar(login(desafio), DONO)

    // No ultimo milissegundo do prazo ainda passa...
    const noPrazo = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA + PRAZO_DE_ENVELOPE_MS.entrar,
    })
    expect(motivoDe(noPrazo)).toBe('aceito')

    // ...e um milissegundo depois, nao. A mesma resposta, byte a byte.
    const vencido = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA + PRAZO_DE_ENVELOPE_MS.entrar + 1,
    })
    expect(motivoDe(vencido)).toBe('envelope_expirado')
  })

  test('WA-04: desafio de outro proposito e recusado', async () => {
    const autenticador = await AutenticadorFalso.criar()
    // Um bilhete de REGISTRO, que qualquer pessoa com um convite consegue.
    const { desafio, envelope } = await bilhete('registrar')
    const resposta = await autenticador.autenticar(login(desafio), DONO)

    // Apresentado como se fosse de login...
    const comoLogin = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    expect(motivoDe(comoLogin)).toBe('envelope_malformado')

    // ...e como se fosse de step-up. Nenhum dos dois abre.
    const comoStepUp = await verificarComEnvelope({
      proposito: 'stepup',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    expect(motivoDe(comoStepUp)).toBe('envelope_malformado')
  })

  test('WA-05: o desafio vindo do corpo e ignorado', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { envelope } = await bilhete('entrar')

    // Quem envia escolhe o desafio, assina tudo corretamente sobre ele e ainda
    // manda o valor num campo extra do corpo, na esperanca de que o servidor o
    // aceite. O verificador so olha o desafio que veio do envelope.
    const escolhido = sortearDesafio()
    const resposta = await autenticador.autenticar(login(escolhido), DONO)
    const comCampoExtra = { ...resposta, challenge: escolhido, desafio: escolhido }

    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta: comCampoExtra,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('desafio_diferente')
  })
})

// ---------------------------------------------------------------------------
// WA-06, o tipo da cerimonia
// ---------------------------------------------------------------------------

describe('WA: o tipo da cerimonia e literal', () => {
  test('WA-06: webauthn.create e recusado no login', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    // A cerimonia inteira e RE-ASSINADA com o tipo trocado: a unica coisa
    // errada e o `type`, e por isso a recusa so pode vir da conferencia dele.
    const resposta = await autenticador.autenticar(comTipo(login(desafio), 'webauthn.create'), DONO)

    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('tipo_de_cerimonia')
  })

  test('WA-06: webauthn.get e recusado no registro', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio } = await bilhete('registrar')

    const resultado = await verificarRegistro({
      resposta: await autenticador.registrar(comTipo(registro(desafio), 'webauthn.get')),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('tipo_de_cerimonia')
  })
})

// ---------------------------------------------------------------------------
// WA-07 e WA-08, a origem
// ---------------------------------------------------------------------------

describe('WA: a origem e comparada por string inteira', () => {
  test('WA-07: origem ...workers.dev.evil.com e recusada', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    const maliciosa = `${ORIGEM}.evil.com`
    // A testemunha da regressao: um `includes` teria deixado passar.
    expect(maliciosa.includes(ORIGEM)).toBe(true)
    expect(maliciosa.startsWith(ORIGEM)).toBe(true)

    const resposta = await autenticador.autenticar(comOrigin(login(desafio), maliciosa), DONO)
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('origem_desconhecida')
  })

  test('WA-08: origem com barra final, com porta ou em http e recusada', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const variantes = [
      `${ORIGEM}/`,
      `${ORIGEM}:443`,
      ORIGEM.replace('https://', 'http://'),
      ORIGEM.toUpperCase(),
      `${ORIGEM}#`,
    ]

    for (const origemTorta of variantes) {
      const { desafio, envelope } = await bilhete('entrar')
      const resposta = await autenticador.autenticar(comOrigin(login(desafio), origemTorta), DONO)
      const resultado = await verificarComEnvelope({
        proposito: 'entrar',
        envelope,
        resposta,
        credencial: credencialDe(autenticador),
        now: AGORA,
      })

      expect({ [origemTorta]: motivoDe(resultado) }).toEqual({
        [origemTorta]: 'origem_desconhecida',
      })
    }
  })

  test('WA-08: crossOrigin true e recusado mesmo com a origem certa', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    const resposta = await autenticador.autenticar({ ...login(desafio), crossOrigin: true }, DONO)
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('cross_origin')
  })
})

// ---------------------------------------------------------------------------
// WA-09 a WA-12, o `rpIdHash` e as flags
// ---------------------------------------------------------------------------

describe('WA: rpIdHash, UP e UV', () => {
  test('WA-09: rpIdHash de outro RP e recusado', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    const resposta = await autenticador.autenticar(
      comRpId(login(desafio), 'outro.workers.dev'),
      DONO,
    )
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('rp_id_hash_diferente')
  })

  test('WA-09: rpIdHash de outro RP e recusado tambem no registro', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio } = await bilhete('registrar')

    const resultado = await verificarRegistro({
      resposta: await autenticador.registrar(comRpId(registro(desafio), 'outro.workers.dev')),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('rp_id_hash_diferente')
  })

  test('WA-10: UP = 0 e recusado nos dois fluxos', async () => {
    const autenticador = await AutenticadorFalso.criar()

    const { desafio, envelope } = await bilhete('entrar')
    const noLogin = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta: await autenticador.autenticar(semUp(login(desafio)), DONO),
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    expect(motivoDe(noLogin)).toBe('presenca_ausente')

    const bilheteDeRegistro = await bilhete('registrar')
    const noRegistro = await verificarRegistro({
      resposta: await autenticador.registrar(semUp(registro(bilheteDeRegistro.desafio))),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: bilheteDeRegistro.desafio,
    })
    expect(motivoDe(noRegistro)).toBe('presenca_ausente')
  })

  test('WA-11: UV = 0 e recusado no login', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    // A unica diferenca para a cerimonia feliz e o bit UV. Tudo o mais, tipo,
    // desafio, origem, rpIdHash e assinatura, esta correto.
    const resposta = await autenticador.autenticar(semUv(login(desafio)), DONO)
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('verificacao_de_usuario_ausente')
  })

  test('WA-11: UV = 0 e recusado tambem no registro', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio } = await bilhete('registrar')

    const resultado = await verificarRegistro({
      resposta: await autenticador.registrar(semUv(registro(desafio))),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('verificacao_de_usuario_ausente')
  })

  test('WA-12: UV = 0 e recusado no step-up', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('stepup')

    // O step-up passa pelo MESMO verificador do login, e e isso que impede que
    // alguem confira `UV` num fluxo e esqueca no outro (§7.8).
    const comUv = await verificarComEnvelope({
      proposito: 'stepup',
      envelope,
      resposta: await autenticador.autenticar(login(desafio), DONO),
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    expect(motivoDe(comUv)).toBe('aceito')

    const outro = await bilhete('stepup')
    const semVerificacao = await verificarComEnvelope({
      proposito: 'stepup',
      envelope: outro.envelope,
      resposta: await autenticador.autenticar(semUv(login(outro.desafio)), DONO),
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    expect(motivoDe(semVerificacao)).toBe('verificacao_de_usuario_ausente')
  })

  test('WA-12: as options das tres cerimonias pedem userVerification required', () => {
    const desafio = sortearDesafio()

    expect(opcoesDeLogin({ rpId: RP_ID, desafio }).userVerification).toBe('required')
    expect(opcoesDeStepUp({ rpId: RP_ID, desafio }).userVerification).toBe('required')

    const registrar = opcoesDeRegistro({
      rpId: RP_ID,
      usuarioHandle: DONO,
      nomeDeUsuario: '@painel',
      desafio,
      excluir: [],
    })
    expect(registrar.authenticatorSelection.userVerification).toBe('required')
    expect(registrar.authenticatorSelection.residentKey).toBe('required')
    expect(registrar.attestation).toBe('none')
    expect(registrar.pubKeyCredParams.map((par) => par.alg)).toEqual([ALG_ES256, ALG_RS256])
    // O `allowCredentials` vazio e enumeracao que NAO acontece (§10.7).
    expect(opcoesDeLogin({ rpId: RP_ID, desafio }).allowCredentials).toEqual([])
  })

  test('OPCOES: `excluir` nao vazio vira excludeCredentials no formato do navegador', () => {
    // Ate agora `excluir` so era exercitado vazio, entao o formato de cada
    // entrada nunca foi travado. Quem filtra por `rp_id` atual e o chamador da
    // Etapa 7, aqui so se prova a forma, que e o que o navegador le.
    const opcoes = opcoesDeRegistro({
      rpId: RP_ID,
      usuarioHandle: DONO,
      nomeDeUsuario: '@painel',
      desafio: sortearDesafio(),
      excluir: ['credencial-um', 'credencial-dois'],
    })

    expect(opcoes.excludeCredentials).toEqual([
      { type: 'public-key', id: 'credencial-um' },
      { type: 'public-key', id: 'credencial-dois' },
    ])
  })
})

// ---------------------------------------------------------------------------
// WA-13 e WA-14, a assinatura
// ---------------------------------------------------------------------------

describe('WA: a assinatura cobre authData || SHA-256(clientDataJSON)', () => {
  test('WA-13: assinatura de outra chave e recusada', async () => {
    const dono = await AutenticadorFalso.criar()
    const estranho = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    // O estranho assina a cerimonia inteira corretamente; o banco tem a chave
    // do dono sob o mesmo `credential_id`.
    const resposta = await estranho.autenticar(login(desafio), DONO)
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta: { ...resposta, id: dono.credentialId },
      credencial: credencialDe(dono),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('assinatura_invalida')
  })

  test('WA-14: um byte alterado no authData invalida', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')
    const resposta = await autenticador.autenticar(login(desafio), DONO)

    // Byte 36: o ultimo do `signCount`, que nenhuma outra conferencia olha
    // antes da assinatura. So a assinatura pode recusar isto.
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta: { ...resposta, authenticatorData: trocarByte(resposta.authenticatorData, 36) },
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('assinatura_invalida')
  })

  test('WA-14: um byte alterado no clientDataJSON invalida', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    // Um campo de enchimento no `clientDataJSON`, exatamente como um navegador
    // real acrescenta campos que o servidor nao confere. O byte trocado cai
    // dentro dele: nenhuma conferencia de tipo, desafio ou origem o alcanca.
    const comEnchimento: Cerimonia = {
      ...login(desafio),
      extras: { enchimento: 'nnnnnnnnnnnnnnnnnnnn' },
    }
    const resposta = await autenticador.autenticar(comEnchimento, DONO)

    const texto = new TextDecoder().decode(deBase64Url(resposta.clientDataJSON))
    const indice = texto.indexOf('nnnn')
    expect(indice).toBeGreaterThan(0)

    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta: { ...resposta, clientDataJSON: trocarByte(resposta.clientDataJSON, indice) },
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('assinatura_invalida')
  })

  test('WA-14: assinatura feita sobre o JSON, e nao sobre authData || hash, e recusada', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    // O bug classico do passo 8 de §10.7, encenado: um verificador que
    // assinasse o `clientDataJSON` aceitaria esta resposta.
    const resposta = await autenticador.autenticarAssinandoOJson(login(desafio), DONO)
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('assinatura_invalida')
  })
})

// ---------------------------------------------------------------------------
// WA-15 a WA-17, DER
// ---------------------------------------------------------------------------

describe('WA: DER, a armadilha numero um', () => {
  test('WA-15: DER com r de 33 bytes (padding 0x00) verifica', async () => {
    const autenticador = await AutenticadorFalso.criar('ES256')
    const { desafio, envelope } = await bilhete('entrar')

    const resposta = await autenticador.autenticarComRAlto(login(desafio), DONO)

    // A prova de que o caso exercitado e mesmo o do `r` de 33 bytes: no DER,
    // `[0]=0x30 [1]=len [2]=0x02 [3]=tamanho de r`.
    const der = deBase64Url(resposta.signature)
    expect(der[0]).toBe(0x30)
    expect(der[2]).toBe(0x02)
    expect(der[3]).toBe(33)
    expect(der[4]).toBe(0x00)

    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('aceito')
  })

  test.todo(
    `WA-16: DER com r de 31 bytes verifica, ${faltaOVetor('loginEs256DerRCurto')}. ` +
      'Um r curto aparece em ~1/256 assinaturas: o laco do AutenticadorFalso precisaria ' +
      'de ~1500 voltas, e §13.3 decidiu que ele vem do hardware. O conversor puro ja e ' +
      'exercitado com r de 31 bytes em "DER, o conversor puro"; o que falta e a ponta a ponta.',
  )

  test('WA-17: assinatura crua de 64 bytes e recusada', async () => {
    const autenticador = await AutenticadorFalso.criar('ES256')
    const { desafio, envelope } = await bilhete('entrar')

    const resposta = await autenticador.autenticarComAssinaturaCrua(login(desafio), DONO)
    expect(deBase64Url(resposta.signature).length).toBe(TAMANHO_DA_ASSINATURA_CRUA)

    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })

    // Nao fixamos o MOTIVO: uma assinatura crua pode, muito raramente, ate
    // parecer um DER bem formado, mas os inteiros lidos seriam outros e a
    // verificacao cairia mesmo assim. O que a garantia afirma e a RECUSA.
    expect(resultado.ok).toBe(false)
  })
})

describe('DER: o conversor puro (§10.7, passo 9)', () => {
  test('DER: r de 33 bytes com padding 0x00 vira 32 bytes alinhados', () => {
    const r = new Uint8Array(32).fill(0xaa)
    const s = new Uint8Array(32).fill(0xbb)
    const bruto = new Uint8Array([...r, ...s])
    const der = cruParaDer(bruto)

    // `0xaa` tem o bit alto ligado, entao o DER poe o `0x00` de sinal.
    expect(der[3]).toBe(33)
    expect(derParaBruto(der)).toEqual(bruto)
  })

  test('DER: r de 31 bytes ganha o zero a esquerda de volta', () => {
    // Este e o conteudo que o vetor `loginEs256DerRCurto` traria do hardware.
    // Aqui ele exercita o CONVERSOR; a garantia ponta a ponta (WA-16) continua
    // esperando o vetor, porque so o hardware prova que o formato e esse.
    const r = new Uint8Array(32)
    r.set(new Uint8Array(31).fill(0x11), 1)
    const s = new Uint8Array(32).fill(0x22)
    const bruto = new Uint8Array([...r, ...s])
    const der = cruParaDer(bruto)

    expect(der[3]).toBe(31)
    expect(derParaBruto(der)).toEqual(bruto)
  })

  test('DER: 64 bytes crus e lixo variado sao recusados sem lancar', () => {
    const casos: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0x30]),
      new Uint8Array(64).fill(0xaa),
      // SEQUENCE cujo comprimento nao cobre o buffer.
      new Uint8Array([0x30, 0x02, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
      // INTEGER de 33 bytes significativos: nao cabe em P-256.
      Uint8Array.from([0x30, 0x26, 0x02, 0x21, ...new Uint8Array(33).fill(0x11), 0x02, 0x01, 0x01]),
      // DER valido com um byte sobrando no fim: o comprimento do SEQUENCE nao
      // cobre o buffer.
      Uint8Array.from([...cruParaDer(new Uint8Array(64).fill(0x01)), 0x00]),
      // E o caso que so o consumo exato pega: o comprimento do SEQUENCE COBRE
      // o buffer inteiro, mas sobra um byte depois do `s`. Sem o passo 7, este
      // conteudo seria lido como uma assinatura valida com lixo anexado.
      (() => {
        const bom = cruParaDer(new Uint8Array(64).fill(0x01))
        const inflado = Uint8Array.from([...bom, 0x00])
        inflado[1] = (bom[1] as number) + 1
        return inflado
      })(),
      // Forma longa de dois octetos: acima do teto de 72 bytes.
      new Uint8Array([0x30, 0x82, 0x00, 0x46]),
    ]

    for (const caso of casos) {
      expect({ tamanho: caso.length, saida: derParaBruto(caso) }).toEqual({
        tamanho: caso.length,
        saida: null,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// WA-18, WA-19 e WA-26, a credencial
// ---------------------------------------------------------------------------

describe('WA: a credencial guardada', () => {
  test('WA-18: credencial de rp_id antigo e ignorada, com um motivo compreensivel', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    // A cerimonia e do endereco ATUAL, o autenticador nao teria como saber do
    // endereco antigo. O que esta velho e a LINHA do banco (§10.14).
    const resultado = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta: await autenticador.autenticar(login(desafio), DONO),
      credencial: credencialDe(autenticador, { rpId: 'endereco-antigo.workers.dev' }),
      now: AGORA,
    })

    expect(motivoDe(resultado)).toBe('credencial_de_endereco_antigo')
  })

  test('WA-19: credencialId desconhecido responde exatamente como assinatura invalida', async () => {
    const dono = await AutenticadorFalso.criar()
    const estranho = await AutenticadorFalso.criar()

    const primeiro = await bilhete('entrar')
    const desconhecida = await verificarComEnvelope({
      proposito: 'entrar',
      envelope: primeiro.envelope,
      resposta: await dono.autenticar(login(primeiro.desafio), DONO),
      credencial: null,
      now: AGORA,
    })

    const segundo = await bilhete('entrar')
    const assinaturaErrada = await verificarComEnvelope({
      proposito: 'entrar',
      envelope: segundo.envelope,
      resposta: {
        ...(await estranho.autenticar(login(segundo.desafio), DONO)),
        id: dono.credentialId,
      },
      credencial: credencialDe(dono),
      now: AGORA,
    })

    // O MESMO motivo, nao dois motivos parecidos: e isso que fecha o oraculo
    // de enumeracao de §11.4.
    expect(motivoDe(desconhecida)).toBe(motivoDe(assinaturaErrada))
    expect(motivoDe(desconhecida)).toBe('assinatura_invalida')
  })

  test('WA-19: as tres recusas de credencial pagam o MESMO verify', async () => {
    // Nao se mede relogio num teste, daria flake. Mede-se o TRABALHO: se as
    // tres recusas passam pelo mesmo numero de `crypto.subtle.verify` que uma
    // credencial boa, nenhuma delas se denuncia pelo tempo. Um `return`
    // antecipado em qualquer uma faria a contagem cair para 0 aqui.
    const dono = await AutenticadorFalso.criar()
    const outroHandle = bytesToBase64Url(new Uint8Array(32).fill(9))

    const verifysGastos = async (credencial: CredencialGuardada | null): Promise<number> => {
      // A cerimonia e montada FORA da janela do espiao: assinar nao pode
      // contar como conferir.
      const { desafio, envelope } = await bilhete('entrar')
      const resposta = await dono.autenticar(login(desafio), DONO)

      const original = crypto.subtle.verify.bind(crypto.subtle)
      let chamadas = 0
      const espiao = vi
        .spyOn(crypto.subtle, 'verify')
        .mockImplementation((...args: Parameters<typeof original>) => {
          chamadas++
          return original(...args)
        })

      try {
        await verificarComEnvelope({
          proposito: 'entrar',
          envelope,
          resposta,
          credencial,
          now: AGORA,
        })
      } finally {
        espiao.mockRestore()
      }
      return chamadas
    }

    expect({
      desconhecida: await verifysGastos(null),
      enderecoAntigo: await verifysGastos(
        credencialDe(dono, { rpId: 'endereco-antigo.workers.dev' }),
      ),
      outroDono: await verifysGastos(credencialDe(dono, { usuarioHandle: outroHandle })),
      boa: await verifysGastos(credencialDe(dono)),
    }).toEqual({ desconhecida: 1, enderecoAntigo: 1, outroDono: 1, boa: 1 })
  })

  test('WA-26: credencial de outro dono nao e aceita', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const outroDono = bytesToBase64Url(new Uint8Array(32).fill(9))

    const pelaLinha = await bilhete('entrar')
    const linhaDeOutro = await verificarComEnvelope({
      proposito: 'entrar',
      envelope: pelaLinha.envelope,
      resposta: await autenticador.autenticar(login(pelaLinha.desafio), DONO),
      credencial: credencialDe(autenticador, { usuarioHandle: outroDono }),
      now: AGORA,
    })
    expect(motivoDe(linhaDeOutro)).toBe('dono_diferente')

    const peloCorpo = await bilhete('entrar')
    const handleDeOutro = await verificarComEnvelope({
      proposito: 'entrar',
      envelope: peloCorpo.envelope,
      resposta: await autenticador.autenticar(login(peloCorpo.desafio), outroDono),
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    expect(motivoDe(handleDeOutro)).toBe('dono_diferente')
  })
})

// ---------------------------------------------------------------------------
// WA-20 a WA-22, signCount e as flags de backup
// ---------------------------------------------------------------------------

describe('WA: signCount e as flags BE/BS', () => {
  test('WA-20: signCount que regride avisa mas NAO recusa', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    const registrado = capturarConsole()
    let resultado: Awaited<ReturnType<typeof verificarComEnvelope>>
    try {
      resultado = await verificarComEnvelope({
        proposito: 'entrar',
        envelope,
        resposta: await autenticador.autenticar(comSignCount(login(desafio), 3), DONO),
        credencial: credencialDe(autenticador, { signCount: 7 }),
        now: AGORA,
      })
    } finally {
      registrado.parar()
    }

    expect(motivoDe(resultado)).toBe('aceito')
    if (resultado.ok && 'assertion' in resultado) {
      expect(resultado.assertion.signCountRegrediu).toBe(true)
    }

    // Avisou, e o aviso NAO carrega o `credential_id` inteiro (§10.13).
    expect(registrado.linhas.length).toBe(1)
    expect(registrado.linhas[0]).toContain('sign_count_regrediu')
    expect(registrado.linhas[0]).toContain(await prefixoDeCredencial(autenticador.credentialId))
    expect(registrado.linhas[0]).not.toContain(autenticador.credentialId)
  })

  test('WA-21: signCount sempre 0 e aceito, e sem aviso', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')

    const registrado = capturarConsole()
    let resultado: Awaited<ReturnType<typeof verificarComEnvelope>>
    try {
      // Passkey sincronizada por iCloud Keychain: 0 no banco e 0 na resposta,
      // para sempre. Recusar aqui trancaria o dono legitimo do lado de fora.
      resultado = await verificarComEnvelope({
        proposito: 'entrar',
        envelope,
        resposta: await autenticador.autenticar(comSignCount(login(desafio), 0), DONO),
        credencial: credencialDe(autenticador, { signCount: 0 }),
        now: AGORA,
      })
    } finally {
      registrado.parar()
    }

    expect(motivoDe(resultado)).toBe('aceito')
    if (resultado.ok && 'assertion' in resultado) {
      expect(resultado.assertion.signCountRegrediu).toBe(false)
    }
    expect(registrado.linhas).toEqual([])
  })

  test('WA-22: flags BE e BS sao extraidas e expostas nos dois fluxos', async () => {
    const autenticador = await AutenticadorFalso.criar()

    const doRegistro = await bilhete('registrar')
    const registrado = await verificarRegistro({
      resposta: await autenticador.registrar(comBackup(registro(doRegistro.desafio))),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: doRegistro.desafio,
    })
    expect(motivoDe(registrado)).toBe('aceito')
    if (registrado.ok) {
      expect({
        be: registrado.credencial.backupElegivel,
        bs: registrado.credencial.backupAtivo,
      }).toEqual({ be: true, bs: true })
    }

    const doLogin = await bilhete('entrar')
    const entrou = await verificarComEnvelope({
      proposito: 'entrar',
      envelope: doLogin.envelope,
      resposta: await autenticador.autenticar(comBackup(login(doLogin.desafio)), DONO),
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    expect(motivoDe(entrou)).toBe('aceito')
    if (entrou.ok && 'assertion' in entrou) {
      expect({ be: entrou.assertion.backupElegivel, bs: entrou.assertion.backupAtivo }).toEqual({
        be: true,
        bs: true,
      })
    }

    // E o contrapositivo: sem as flags, os dois campos saem `false`.
    const semBackup = await bilhete('entrar')
    const simples = await verificarComEnvelope({
      proposito: 'entrar',
      envelope: semBackup.envelope,
      resposta: await autenticador.autenticar(login(semBackup.desafio), DONO),
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    // O `expect` vem ANTES do `if`: sem ele, uma cerimonia que deixasse de ser
    // aceita faria o bloco inteiro sumir e o teste continuaria verde. Os irmaos
    // WA-20 e WA-21 ja fazem assim.
    expect(motivoDe(simples)).toBe('aceito')
    if (simples.ok && 'assertion' in simples) {
      expect({ be: simples.assertion.backupElegivel, bs: simples.assertion.backupAtivo }).toEqual({
        be: false,
        bs: false,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// WA-23 e WA-24, attestation e COSE
// ---------------------------------------------------------------------------

describe('WA: o attestationObject e a chave COSE', () => {
  test('WA-23: fmt diferente de none e recusado', async () => {
    const autenticador = await AutenticadorFalso.criar()

    for (const fmt of ['packed', 'tpm', 'android-key', 'apple', '']) {
      const { desafio } = await bilhete('registrar')
      const resultado = await verificarRegistro({
        resposta: await autenticador.registrar(registro(desafio), { fmt }),
        rpId: RP_ID,
        origem: ORIGEM,
        desafioEsperado: desafio,
      })

      expect({ [fmt || '(vazio)']: motivoDe(resultado) }).toEqual({
        [fmt || '(vazio)']: 'formato_de_attestation',
      })
    }
  })

  test('WA-23: attStmt com conteudo e recusado, mesmo com fmt none', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio } = await bilhete('registrar')

    // §10.5, passo 5: `fmt === "none"` E `attStmt` mapa VAZIO. Um statement
    // dentro de um formato que nao tem statement e conteudo que ninguem
    // examinou, e a spec manda recusar, nao ignorar.
    const resultado = await verificarRegistro({
      resposta: await autenticador.registrar(registro(desafio), { attStmtComConteudo: true }),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('formato_de_attestation')
  })

  test('WA-23: credentialId acima do teto de 1023 bytes e recusado', async () => {
    const autenticador = await AutenticadorFalso.criar()

    // Logo abaixo do teto passa...
    const abaixo = await bilhete('registrar')
    const aceito = await verificarRegistro({
      resposta: await autenticador.registrar(registro(abaixo.desafio), {
        tamanhoDoCredentialId: 1023,
        idDoCorpo: 'nao-importa',
      }),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: abaixo.desafio,
    })
    // O `id` do corpo nao casa com o do authData, entao a recusa aqui e a de
    // WA-01, o que prova que o teto de 1023 NAO foi o que barrou.
    expect(motivoDe(aceito)).toBe('campo_ausente')

    // ...e um byte acima, nao. §10.5, passo 6.
    const acima = await bilhete('registrar')
    const recusado = await verificarRegistro({
      resposta: await autenticador.registrar(registro(acima.desafio), {
        tamanhoDoCredentialId: 1024,
        idDoCorpo: 'nao-importa',
      }),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: acima.desafio,
    })
    expect(motivoDe(recusado)).toBe('authdata_invalido')
  })

  test('WA-23: attestationObject com uma chave a mais e recusado', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio } = await bilhete('registrar')
    const c = registro(desafio)

    // Montado a mao com o codificador do teste: `fmt`, `attStmt`, `authData` e
    // uma quarta chave. Tres chaves e o que existe; a quarta e conteudo que
    // ninguem examinou, entrando junto de uma attestation por todo o resto
    // valida.
    const comChaveExtra = codificarCbor(
      cbMapa([
        [cbTexto('fmt'), cbTexto('none')],
        [cbTexto('attStmt'), cbMapa([])],
        [cbTexto('authData'), cbBytes(await autenticador.authData(c, true))],
        [cbTexto('epAtt'), cbInteiro(1)],
      ]),
    )

    const resultado = await verificarRegistro({
      resposta: {
        id: autenticador.credentialId,
        type: 'public-key',
        clientDataJSON: paraBase64Url(autenticador.clientData(c)),
        attestationObject: paraBase64Url(comChaveExtra),
      },
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: desafio,
    })

    expect(motivoDe(resultado)).toBe('formato_de_attestation')
  })

  test('WA-23: authData com bloco de extensao (ED = 1) e recusado nos dois fluxos', async () => {
    const autenticador = await AutenticadorFalso.criar()

    // O painel nao pede extensao nenhuma. Aceitar um bloco CBOR extra depois
    // da chave publica seria aceitar conteudo que ninguem examinou, e, no
    // registro, o bloco fica exatamente onde a chave COSE deveria terminar.
    const doRegistro = await bilhete('registrar')
    const registrado = await verificarRegistro({
      resposta: await autenticador.registrar(comExtensao(registro(doRegistro.desafio))),
      rpId: RP_ID,
      origem: ORIGEM,
      desafioEsperado: doRegistro.desafio,
    })
    expect(motivoDe(registrado)).toBe('authdata_invalido')

    const doLogin = await bilhete('entrar')
    const entrou = await verificarComEnvelope({
      proposito: 'entrar',
      envelope: doLogin.envelope,
      resposta: await autenticador.autenticar(comExtensao(login(doLogin.desafio)), DONO),
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    expect(motivoDe(entrou)).toBe('authdata_invalido')
  })

  test('WA-24: COSE com alg fora de -7/-257 e recusado', async () => {
    const autenticador = await AutenticadorFalso.criar()

    for (const algDeclarado of [-8, -37, -65535, 0, 7, 257]) {
      const { desafio } = await bilhete('registrar')
      const resultado = await verificarRegistro({
        resposta: await autenticador.registrar(registro(desafio), { algDeclarado }),
        rpId: RP_ID,
        origem: ORIGEM,
        desafioEsperado: desafio,
      })

      expect({ [algDeclarado]: motivoDe(resultado) }).toEqual({
        [algDeclarado]: 'chave_publica_invalida',
      })
    }
  })

  test('WA-24: o modulo RSA tem piso E teto', () => {
    // Sem teto, o unico limite seria o `BYTES_MAXIMOS` do CBOR e caberia um
    // modulo de ~16 mil bits. Quem tivesse convite valido poderia registrar
    // essa chave e fazer todo login seguinte pagar um `verify`
    // desproporcional, CPU faturada e limitada por invocacao no Worker.
    const rsaCom = (bytesDoModulo: number): Uint8Array =>
      codificarCbor(
        cbMapa([
          [cbInteiro(1), cbInteiro(3)],
          [cbInteiro(3), cbInteiro(ALG_RS256)],
          [cbInteiro(-1), cbBytes(new Uint8Array(bytesDoModulo).fill(1))],
          [cbInteiro(-2), cbBytes(new Uint8Array([1, 0, 1]))],
        ]),
      )

    // 2048 bits passa; 4096 bits, o teto, tambem, o TPM do Windows Hello
    // entrega 2048, entao nenhum autenticador real esbarra aqui.
    expect(coseParaJwk(rsaCom(256)).ok).toBe(true)
    expect(coseParaJwk(rsaCom(512)).ok).toBe(true)

    // Um byte abaixo do piso e um byte acima do teto: os dois recusados, com o
    // mesmo motivo.
    expect(coseParaJwk(rsaCom(255))).toEqual({ ok: false, motivo: 'modulo_invalido' })
    expect(coseParaJwk(rsaCom(513))).toEqual({ ok: false, motivo: 'modulo_invalido' })
  })

  test('WA-24: coseParaJwk recusa alg desconhecido, curva errada e coordenada curta', () => {
    const x = new Uint8Array(32).fill(1)
    const y = new Uint8Array(32).fill(2)

    const comAlgErrado = codificarCbor(
      cbMapa([
        [cbInteiro(1), cbInteiro(2)],
        [cbInteiro(3), cbInteiro(-8)],
        [cbInteiro(-1), cbInteiro(6)],
        [cbInteiro(-2), cbBytes(x)],
        [cbInteiro(-3), cbBytes(y)],
      ]),
    )
    expect(coseParaJwk(comAlgErrado)).toEqual({ ok: false, motivo: 'alg_nao_suportado' })

    const comCurvaErrada = codificarCbor(
      cbMapa([
        [cbInteiro(1), cbInteiro(2)],
        [cbInteiro(3), cbInteiro(ALG_ES256)],
        [cbInteiro(-1), cbInteiro(2)],
        [cbInteiro(-2), cbBytes(x)],
        [cbInteiro(-3), cbBytes(y)],
      ]),
    )
    expect(coseParaJwk(comCurvaErrada)).toEqual({ ok: false, motivo: 'curva_nao_suportada' })

    const comCoordenadaCurta = codificarCbor(
      cbMapa([
        [cbInteiro(1), cbInteiro(2)],
        [cbInteiro(3), cbInteiro(ALG_ES256)],
        [cbInteiro(-1), cbInteiro(1)],
        [cbInteiro(-2), cbBytes(x.subarray(0, 31))],
        [cbInteiro(-3), cbBytes(y)],
      ]),
    )
    expect(coseParaJwk(comCoordenadaCurta)).toEqual({ ok: false, motivo: 'coordenada_invalida' })

    // RSA com modulo abaixo de 2048 bits.
    const comModuloCurto = codificarCbor(
      cbMapa([
        [cbInteiro(1), cbInteiro(3)],
        [cbInteiro(3), cbInteiro(ALG_RS256)],
        [cbInteiro(-1), cbBytes(new Uint8Array(128).fill(3))],
        [cbInteiro(-2), cbBytes(new Uint8Array([1, 0, 1]))],
      ]),
    )
    expect(coseParaJwk(comModuloCurto)).toEqual({ ok: false, motivo: 'modulo_invalido' })

    // Par kty/alg incoerente: diz RSA e alega ES256.
    const incoerente = codificarCbor(
      cbMapa([
        [cbInteiro(1), cbInteiro(3)],
        [cbInteiro(3), cbInteiro(ALG_ES256)],
        [cbInteiro(-1), cbBytes(new Uint8Array(256).fill(3))],
        [cbInteiro(-2), cbBytes(new Uint8Array([1, 0, 1]))],
      ]),
    )
    expect(coseParaJwk(incoerente)).toEqual({ ok: false, motivo: 'alg_nao_suportado' })
  })
})

describe('CBOR: o decodificador de producao (§10.5)', () => {
  test('CBOR: o codificador do teste e o decodificador de producao concordam', () => {
    const original = cbMapa([
      [cbTexto('fmt'), cbTexto('none')],
      [cbTexto('attStmt'), cbMapa([])],
      [cbTexto('authData'), cbBytes(new Uint8Array([1, 2, 3, 250]))],
      [cbTexto('numeros'), cbInteiro(-257)],
      [cbTexto('grande'), cbInteiro(70000)],
    ])

    const lido = decodificarCbor(codificarCbor(original))
    expect(lido.ok).toBe(true)
    if (!lido.ok) return
    expect(textoDoMapa(lido.valor, 'fmt')).toBe('none')
    expect(inteiroDoMapa(lido.valor, 'numeros')).toBe(-257)
    expect(inteiroDoMapa(lido.valor, 'grande')).toBe(70000)
  })

  test('CBOR: argumento em forma nao-minima e recusado', () => {
    // `05` e a grafia canonica do valor 5. `18 05` diz a mesma coisa gastando um
    // byte a mais, e grafia dupla e por onde entra confusao de forma canonica,
    // a mesma razao pela qual o comprimento indefinido nao entra. Hoje nada no
    // painel compara ou hasheia os bytes crus do CBOR; a trava fecha a porta
    // antes de existir um caminho que passe por ela.
    expect(decodificarCbor(new Uint8Array([0x05]))).toEqual({
      ok: true,
      valor: { tipo: 'inteiro', numero: 5 },
    })
    expect(decodificarCbor(new Uint8Array([0x18, 0x05]))).toEqual({
      ok: false,
      motivo: 'forma_nao_canonica',
    })

    // O mesmo em 2 e em 4 bytes: 200 cabe em `18`, 70000 cabe em `1a`.
    expect(decodificarCbor(new Uint8Array([0x19, 0x00, 0xc8]))).toEqual({
      ok: false,
      motivo: 'forma_nao_canonica',
    })
    expect(decodificarCbor(new Uint8Array([0x1a, 0x00, 0x00, 0x01, 0x11]))).toEqual({
      ok: false,
      motivo: 'forma_nao_canonica',
    })

    // E a fronteira, para a trava nao virar recusa cega: 24 e 256 sao os
    // menores valores que cada largura tem direito de carregar.
    expect(decodificarCbor(new Uint8Array([0x18, 0x18]))).toEqual({
      ok: true,
      valor: { tipo: 'inteiro', numero: 24 },
    })
    expect(decodificarCbor(new Uint8Array([0x19, 0x01, 0x00]))).toEqual({
      ok: true,
      valor: { tipo: 'inteiro', numero: 256 },
    })
  })

  test('CBOR: comprimento indefinido, sobra, profundidade e byte string grande sao recusados', () => {
    // `0x5f` = byte string de comprimento indefinido (RFC 8949 §3.2.2).
    expect(decodificarCbor(new Uint8Array([0x5f, 0x40, 0xff]))).toEqual({
      ok: false,
      motivo: 'comprimento_indefinido',
    })

    // Um valor valido com um byte sobrando depois.
    expect(decodificarCbor(new Uint8Array([0x01, 0x02]))).toEqual({ ok: false, motivo: 'sobra' })

    // Cinco niveis de lista: um a mais que o teto.
    let fundo = cbInteiro(1)
    for (let i = 0; i < PROFUNDIDADE_MAXIMA; i++) fundo = cbLista([fundo])
    expect(decodificarCbor(codificarCbor(fundo))).toEqual({ ok: false, motivo: 'profundidade' })

    // Byte string de 2 KB + 1.
    const grande = codificarCbor(cbBytes(new Uint8Array(BYTES_MAXIMOS + 1)))
    expect(decodificarCbor(grande)).toEqual({ ok: false, motivo: 'bytes_grandes_demais' })

    // Chave repetida no mapa.
    const repetida = codificarCbor(
      cbMapa([
        [cbInteiro(3), cbInteiro(-7)],
        [cbInteiro(3), cbInteiro(-257)],
      ]),
    )
    expect(decodificarCbor(repetida)).toEqual({ ok: false, motivo: 'chave_repetida' })

    // `true`, `null` e float: tipo maior 7, fora do subconjunto.
    for (const byte of [0xf4, 0xf5, 0xf6, 0xfb]) {
      expect(decodificarCbor(new Uint8Array([byte])).ok).toBe(false)
    }
  })

  test('CBOR: lixo de qualquer forma nao lanca', () => {
    const lixo: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0xa1]),
      new Uint8Array([0x58]),
      new Uint8Array([0x1b, 1, 2, 3, 4, 5, 6, 7, 8]),
      new Uint8Array([0x1c]),
      new Uint8Array([0x63, 0xff, 0xfe, 0xfd]),
      crypto.getRandomValues(new Uint8Array(64)),
    ]

    for (const caso of lixo) {
      expect(() => decodificarCbor(caso)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// WA-25, WA-27, WA-28 e WA-29, os tetos de corpo e a limitacao conhecida
// ---------------------------------------------------------------------------

describe('WA: os tetos de corpo e a limitacao conhecida do desafio', () => {
  test('WA-25: corpo de /painel/api/* acima de 8 KB e recusado antes do parse', async () => {
    // A familia `/painel/api/*` nasceu na Etapa 7, e esta garantia esperava por
    // ela: o teto pequeno e o que protege os 10 ms de CPU do parser CBOR, entao
    // ele precisa cortar ANTES de qualquer parse, e nao depois de aceitar
    // tudo (§11.3, passo 4).
    const contador = new D1Contador(env.DB)

    const resposta = await handleOpcoesDeRegistro(
      new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: RAIZ },
        body: JSON.stringify({ tipo: 'convite', convite: 'x'.repeat(TETO_DO_CORPO_DA_API + 1) }),
      }),
      { ...env, DB: comoD1(contador) },
      AGORA,
    )

    expect(resposta.status).toBe(413)
    expect(contador.prepares).toBe(0)
  })

  test('WA-25: corpo em `ReadableStream`, sem `content-length`, tambem e recusado', async () => {
    // O teto de §11.3 passo 4 tem DUAS metades, "`content-length` conferido
    // **e** relido na leitura." Neste runtime (`@cloudflare/vitest-pool-workers`)
    // o cabecalho NAO nasce sozinho: um `Request` construido com corpo STRING ou
    // `ReadableStream` chega com `content-length` igual a `null`, sempre, entao
    // o teste ACIMA (a string gigante) tambem passa so pela segunda metade,
    // nunca pela primeira. "Um corpo montado de string sempre chega com
    // content-length" e exatamente a premissa falsa que este comentario tinha
    // antes: quem prende a primeira metade de proposito, com o cabecalho SETADO
    // A MAO, e o teste seguinte, "WA-25: content-length mentiroso...".
    //
    // Este teste aqui prende a SEGUNDA metade para a familia de 8 KB, com o
    // corpo chegando em pedacos DE VERDADE, um `pull()` por vez, do jeito que
    // um POST `chunked` de conexao lenta chegaria, e nao uma string unica que o
    // runtime pode entregar num `read()` so. `prepares === 0` e a afirmacao que
    // importa: nada chega ao D1.
    const contador = new D1Contador(env.DB)
    const pedaco = new TextEncoder().encode('x'.repeat(4096))
    let restantes = 4

    const corpo = new ReadableStream<Uint8Array>({
      pull(controlador) {
        if (restantes === 0) {
          controlador.close()
          return
        }
        restantes -= 1
        controlador.enqueue(pedaco)
      },
    })

    const pedido = new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: RAIZ },
      body: corpo,
      // Exigido pelo fetch quando o corpo e um stream. Sem ele o Request nem
      // e construido, e e por isso que nenhum teste tinha chegado aqui.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    // O `content-length` REALMENTE nao existe: sem isto o teste voltaria a
    // provar so a primeira metade, com mais cerimonia.
    expect(pedido.headers.get('content-length')).toBeNull()

    const resposta = await handleOpcoesDeRegistro(pedido, { ...env, DB: comoD1(contador) }, AGORA)

    expect(resposta.status).toBe(413)
    expect(contador.prepares).toBe(0)
    // E o corpo nao foi bufferizado inteiro antes de medir: o leitor foi
    // cancelado no primeiro pedaco que estourou o teto, com pedacos por enviar.
    expect(restantes).toBeGreaterThan(0)
  })

  test('WA-25: content-length mentiroso acima de 8 KB e recusado antes de qualquer leitura', async () => {
    // A PRIMEIRA metade de verdade do teto de §11.3 passo 4, o precheck do
    // `content-length` DECLARADO, que nao existe sozinho neste runtime (ver os
    // dois testes acima): para provar que ele funciona por conta propria, o
    // cabecalho precisa ser SETADO A MAO, do jeito que
    // `tests/painel-parada.test.ts:915` e `tests/regressao-webhook.test.ts:110`
    // ja fazem para as outras duas familias de teto.
    //
    // A forma mais afiada: um `content-length` MENTIROSO, acima do teto, sobre
    // um corpo REAL pequeno. Se a segunda metade (o corte dentro do stream)
    // fosse a unica coisa rodando, um corpo pequeno passaria batido e a rota
    // devolveria outra coisa que nao `413`, e e exatamente essa diferenca que
    // prova que o portao de CIMA disparou sozinho, sem ler nenhum byte.
    const contador = new D1Contador(env.DB)
    const pedido = new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: RAIZ,
        'content-length': String(TETO_DO_CORPO_DA_API + 1),
      },
      body: JSON.stringify({ tipo: 'sessao' }),
    })

    const resposta = await handleOpcoesDeRegistro(pedido, { ...env, DB: comoD1(contador) }, AGORA)

    expect(resposta.status).toBe(413)
    expect(contador.prepares).toBe(0)
    // A prova de que o corte veio ANTES de ler: o corpo real, pequeno, nunca
    // chegou a ser tocado (mesma afirmacao de REG-04 para o webhook).
    expect(pedido.bodyUsed).toBe(false)
  })

  test.todo(
    'WA-28: corpo de formulario acima de 32 KB e recusado, as rotas de formulario do ' +
      'painel nascem nas Etapas 9 a 11 (Tasks 10 a 12). Mesmo motivo de WA-25.',
  )

  test('WA-29: corpo de POST /painel/parada acima de 1 KB e recusado antes de tocar o D1', async () => {
    // A parada e a unica rota do painel que ja existe, e o teto dela protege
    // justamente o parser das cerimonias de crescer sem limite (§11.3, passo 4).
    const contador = new D1Contador(env.DB)
    const corpo = `codigo=${'x'.repeat(TETO_DO_CORPO_DA_PARADA + 1)}`

    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await handleParada(
        new Request(`${RAIZ}${CAMINHO_DA_PARADA}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: corpo,
        }),
        { ...env, DB: comoD1(contador) },
        AGORA,
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(413)
    expect(contador.prepares).toBe(0)
  })

  test('WA-27: o mesmo desafio reapresentado dentro dos 120 s ainda e aceito', async () => {
    const autenticador = await AutenticadorFalso.criar()
    const { desafio, envelope } = await bilhete('entrar')
    const resposta = await autenticador.autenticar(login(desafio), DONO)

    // **Limitacao conhecida, documentada como teste** (§13.2). Nao existe uso
    // unico de desafio neste desenho: o que limita o replay e o prazo de 120 s
    // do envelope. Se um dia alguem implementar uso unico de verdade, ESTE
    // teste fica vermelho e obriga a decisao consciente, em vez de a mudanca
    // passar despercebida.
    const primeira = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA,
    })
    const segunda = await verificarComEnvelope({
      proposito: 'entrar',
      envelope,
      resposta,
      credencial: credencialDe(autenticador),
      now: AGORA + PRAZO_DE_ENVELOPE_MS.entrar - 1,
    })

    expect(motivoDe(primeira)).toBe('aceito')
    expect(motivoDe(segunda)).toBe('aceito')
  })
})

// ---------------------------------------------------------------------------
// Os vetores congelados, a outra metade do metodo T2
// ---------------------------------------------------------------------------

/**
 * Os nomes que ainda esperam hardware, escritos A MAO.
 *
 * A lista existe justamente para NAO derivar de `vetoresAusentes()`: um assert
 * que compara o conjunto com ele mesmo nunca falha. Quando um vetor chegar,
 * esta lista deixa de casar e a suite fica vermelha ate alguem apagar o nome
 * daqui e converter o `test.todo` correspondente num teste de verdade.
 */
const NOMES_EM_TODO = [
  'registroEs256Android',
  'registroRs256WindowsHello',
  'loginEs256Icloud',
  'loginEs256DerRAlto',
  'loginEs256DerRCurto',
  'loginSemUv',
]

/**
 * O que CADA vetor prova, alem de simplesmente ser aceito ou recusado.
 *
 * Sem isto, `loginEs256DerRCurto` passaria pelo laco geral sem ninguem conferir
 * o `r` de 31 bytes, e WA-16 continuaria nao provada mesmo com o vetor ja no
 * repositorio, que e o pior dos mundos: cobertura aparente.
 */
function conferirOQueOVetorProva(
  nome: string,
  vetor: VetorDeAssertion,
  resultado: ResultadoDeAssertion,
): void {
  if (nome === 'loginEs256DerRCurto' || nome === 'loginEs256DerRAlto') {
    const der = decodeBase64Url(vetor.assinatura)
    // `der[3]` e o comprimento do `r` (SEQUENCE, tamanho, INTEGER, tamanho).
    expect({ [nome]: der?.[3] }).toEqual({ [nome]: nome === 'loginEs256DerRCurto' ? 31 : 33 })
    return
  }

  if (nome === 'loginSemUv') {
    // O vetor NEGATIVO tem que ser recusado pelo motivo certo, nao por acaso.
    expect({ [nome]: motivoDe(resultado) }).toEqual({ [nome]: 'verificacao_de_usuario_ausente' })
    return
  }

  if (nome === 'loginEs256Icloud' && resultado.ok) {
    // A passkey sincronizada: `signCount` sempre 0 (nao conta como regressao) e
    // as duas flags de backup ligadas.
    expect({
      regrediu: resultado.assertion.signCountRegrediu,
      be: resultado.assertion.backupElegivel,
      bs: resultado.assertion.backupAtivo,
    }).toEqual({ regrediu: false, be: true, bs: true })
  }
}

describe('WA: os vetores congelados de hardware real (§13.3)', () => {
  test('VETORES: o registro dos seis nomes existe e diz quais faltam', () => {
    // Este teste fica VERDE com o conjunto vazio de proposito: ele nao afirma
    // que os vetores existem, afirma que o registro deles esta escrito e sabe
    // dizer o que falta. O alarme sao os `test.todo` abaixo.
    expect(NOMES_DE_VETOR.length).toBe(6)
    expect([...vetoresAusentes(), ...vetoresPresentes()].sort()).toEqual([...NOMES_DE_VETOR].sort())
  })

  test('VETORES: cada vetor presente e conferido contra os proprios rpId, origem e desafio', async () => {
    // Enquanto o conjunto estiver vazio, o laco nao roda e o teste so afirma o
    // contrapositivo. Quando o primeiro vetor chegar, ele passa a ser
    // verificado aqui automaticamente, sem ninguem precisar lembrar de voltar.
    for (const nome of vetoresPresentes()) {
      const doRegistro = vetorDeRegistro(nome)
      if (doRegistro !== null) {
        const resultado = await verificarRegistro({
          resposta: {
            id: doRegistro.id,
            type: 'public-key',
            clientDataJSON: doRegistro.clientDataJSON,
            attestationObject: doRegistro.attestationObject,
          },
          rpId: doRegistro.rpId,
          origem: doRegistro.origem,
          desafioEsperado: doRegistro.desafio,
        })
        expect({ [nome]: motivoDe(resultado) }).toEqual({ [nome]: 'aceito' })
        if (resultado.ok) {
          expect(resultado.credencial.algoritmo).toBe(doRegistro.algoritmoEsperado)
        }
        continue
      }

      const daAssertion = vetorDeAssertion(nome)
      if (daAssertion === null) continue

      const resultado = await verificarAssertion({
        resposta: {
          id: daAssertion.id,
          type: 'public-key',
          clientDataJSON: daAssertion.clientDataJSON,
          authenticatorData: daAssertion.authenticatorData,
          signature: daAssertion.assinatura,
          userHandle: daAssertion.userHandle,
        },
        rpId: daAssertion.rpId,
        origem: daAssertion.origem,
        desafioEsperado: daAssertion.desafio,
        credencial: {
          credentialId: daAssertion.id,
          rpId: daAssertion.rpId,
          usuarioHandle: daAssertion.usuarioHandle,
          jwk: daAssertion.chavePublicaJwk,
          algoritmo: daAssertion.algoritmo,
          signCount: 0,
        },
        usuarioHandleEsperado: daAssertion.usuarioHandle,
      })

      expect({ [nome]: resultado.ok }).toEqual({ [nome]: daAssertion.deveSerAceito })
      conferirOQueOVetorProva(nome, daAssertion, resultado)
    }
  })

  test('VETORES: nenhum vetor presente pode ter saido do AutenticadorFalso', () => {
    // O laco acima aceita QUALQUER vetor presente. Sozinho, ele ficaria verde
    // com vetores fabricados, e "os vetores de hardware sao aceitos" passaria a
    // dizer apenas que o autenticador de software concorda consigo mesmo,
    // destruindo a independencia que o metodo T2 existe para garantir (§13.3, e
    // o ruling 4 do plano). Este teste e a trava.
    //
    // A impressao digital mais barata: o `AutenticadorFalso` so sabe assinar
    // para o `rpId` e a origem do ambiente de teste. Hardware de verdade foi
    // capturado noutro endereco, noutro momento, por alguem que teve que
    // escrever de onde ele veio.
    for (const nome of vetoresPresentes()) {
      const vetor = vetorDeRegistro(nome) ?? vetorDeAssertion(nome)
      expect(vetor).not.toBeNull()
      if (vetor === null) continue

      expect({ [nome]: vetor.rpId }).not.toEqual({ [nome]: RP_ID })
      expect({ [nome]: vetor.origem }).not.toEqual({ [nome]: ORIGEM })
      expect(vetor.procedencia.trim().length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(vetor.capturadoEm))).toBe(false)
    }
  })

  test('VETORES: a lista de `test.todo` congelada casa com o que falta', () => {
    // Substitui um assert tautologico (`presentes === 6 - ausentes`, que deriva
    // dos dois lados do mesmo array e nunca podia falhar). Este compara com uma
    // lista ESCRITA A MAO: quando o primeiro vetor chegar, a suite fica
    // vermelha e obriga a converter o `test.todo` correspondente, em vez de
    // deixar a promessa envelhecer em silencio.
    expect([...vetoresAusentes()].sort()).toEqual([...NOMES_EM_TODO].sort())
  })

  test.todo(
    `VETORES: ${faltaOVetor('registroEs256Android')}, attestation ES256 de hardware. ` +
      'O dono NAO tem Android: este vetor vira de Windows Hello em modo ES256 ou de iPhone, ' +
      'e a procedencia real fica no campo `procedencia` do vetor.',
  )

  test.todo(
    `VETORES: ${faltaOVetor('registroRs256WindowsHello')}, attestation RS256 de TPM. ` +
      'E o unico caminho RS256 do mundo real, e o que prova que o ramo RSA de cose.ts nao ' +
      'esta apenas concordando com o AutenticadorFalso.',
  )

  test.todo(
    `VETORES: ${faltaOVetor('loginEs256Icloud')}, assertion com signCount sempre 0 e ` +
      'BE = 1, BS = 1. E o vetor que prova, com hardware, que WA-21 e WA-22 valem.',
  )

  test.todo(
    `VETORES: ${faltaOVetor('loginEs256DerRAlto')}, assertion cujo r em DER tem 33 bytes. ` +
      'Reforca WA-15, que hoje esta provada so pelo laco do AutenticadorFalso.',
  )

  test.todo(
    `VETORES: ${faltaOVetor('loginEs256DerRCurto')}, assertion cujo r em DER tem 31 bytes. ` +
      'E o unico vetor que NAO tem substituto em software: WA-16 depende dele.',
  )

  test.todo(
    `VETORES: ${faltaOVetor('loginSemUv')}, vetor NEGATIVO, com UV = 0. ` +
      'Provavel BLOCKED permanente: o dono nao tem chave USB, e Windows Hello e iCloud ' +
      'sempre confirmam identidade. Se ele nunca chegar, UV = 0 continua provado em ' +
      'software por WA-11 e WA-12, e a ausencia fica registrada em vetores-webauthn.ts.',
  )
})

// ---------------------------------------------------------------------------
// O que sustenta o resto: base64url e o registro de motivos
// ---------------------------------------------------------------------------

describe('WA: as duas pontas do metodo T2 concordam no basico', () => {
  test('T2: o base64url do teste e o de producao produzem o mesmo texto', () => {
    for (let tamanho = 0; tamanho <= 40; tamanho++) {
      const bytes = crypto.getRandomValues(new Uint8Array(tamanho))
      const doTeste = paraBase64Url(bytes)
      expect({ tamanho, texto: doTeste }).toEqual({ tamanho, texto: bytesToBase64Url(bytes) })
      expect({ tamanho, volta: [...deBase64Url(doTeste)] }).toEqual({
        tamanho,
        volta: [...(decodeBase64Url(doTeste) ?? new Uint8Array())],
      })
    }
  })

  test('T2: nenhum motivo de recusa distingue credencial desconhecida', () => {
    // O registro de motivos e a superficie que o `console.warn` expoe. Um
    // motivo chamado "credencial_desconhecida" reabriria o oraculo de §11.4,
    // entao ele nao pode nascer por descuido.
    const motivos: MotivoWebauthn[] = [
      'tipo_de_credencial',
      'campo_ausente',
      'base64url_invalido',
      'client_data_invalido',
      'tipo_de_cerimonia',
      'desafio_diferente',
      'origem_desconhecida',
      'cross_origin',
      'attestation_invalida',
      'formato_de_attestation',
      'authdata_invalido',
      'rp_id_hash_diferente',
      'presenca_ausente',
      'verificacao_de_usuario_ausente',
      'sem_credencial_anexada',
      'chave_publica_invalida',
      'chave_nao_importa',
      'credencial_de_endereco_antigo',
      'dono_diferente',
      'assinatura_malformada',
      'assinatura_invalida',
    ]

    // As grafias que reabririam o oraculo. `origem_desconhecida` NAO esta na
    // lista: ela fala da origem da requisicao, nao da existencia da credencial.
    const proibidas = [
      'credencial_desconhecida',
      'credencial_inexistente',
      'credencial_nao_encontrada',
      'passkey_desconhecida',
    ]
    expect(motivos.filter((motivo) => proibidas.includes(motivo))).toEqual([])
    expect(new Set(motivos).size).toBe(motivos.length)
  })
})
