/**
 * Envelope assinado com proposito, claims e prazo.
 *
 * Generaliza o desenho de `oauth-state.ts` — que ja e um JWT minimo — para
 * carregar um PROPOSITO e um conjunto de CLAIMS, com prazo proprio de cada
 * proposito. `oauth-state.ts` continua fazendo exatamente o que fazia: as
 * garantias REG de `tests/regressao-oauth.test.ts` congelam o `state` do OAuth
 * byte a byte.
 *
 *   formato: "v1" "." <proposito> "." base64url(json_das_claims) "."
 *            <expira_em> "." base64url(hmac)
 *   hmac   = HMAC-SHA256( chave_do_proposito,
 *                         "v1|" + proposito + "|" + claims_b64 + "|" + expira_em )
 *
 * Sao TRES defesas independentes contra confusao de proposito, e o desenho so
 * esta certo com as tres: o proposito entra no TEXTO ASSINADO, entra na
 * DERIVACAO DA CHAVE (mesmo que um bug de parser ignore o campo, a assinatura
 * nao fecha) e entra no NOME DO COOKIE (§7.2, quem monta o cookie). Sem elas,
 * um desafio de REGISTRO — que qualquer pessoa com um convite consegue — valeria
 * como autorizacao de step-up.
 *
 * A palavra do dominio e "claims". O conteudo assinado nao tem outro nome neste
 * repositorio (§7.8).
 */
import { bytesToBase64Url, decodeBase64Url } from './base64url'
import { timingSafeEqual } from './constant-time'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const VERSAO = 'v1'
const SEPARADOR = '.'
/** versao, proposito, claims, prazo e assinatura. */
const PARTES_DO_ENVELOPE = 5

/** As tres cerimonias que usam envelope. Nao existe uma quarta. */
export type PropositoDeEnvelope = 'entrar' | 'registrar' | 'stepup'

/**
 * O prazo mora AQUI, indexado pelo proposito (§7.6 e §15.4).
 *
 * Registro dura 300 s porque nao e a mesma cerimonia do login: o leigo digita
 * um apelido, encara o primeiro dialogo do sistema operacional que ja viu e as
 * vezes aprova num segundo aparelho. Como o envelope carrega o prazo por
 * proposito, nao existe uma segunda constante para alguem esquecer de mudar.
 *
 * Trava de SES-04: mudar um destes numeros derruba o teste do prazo por
 * proposito em `tests/painel-sessao.test.ts`.
 */
export const PRAZO_DE_ENVELOPE_MS: Record<PropositoDeEnvelope, number> = {
  entrar: 120_000,
  registrar: 300_000,
  stepup: 120_000,
}

/**
 * O conteudo que o envelope carrega.
 *
 * So string: os valores reais sao desafio, nonce, hash e identificador, todos
 * texto. Fechar o tipo aqui evita que alguem enfie um objeto dentro e crie um
 * problema de forma canonica onde hoje nao existe nenhum.
 */
export type ClaimsDoEnvelope = Record<string, string>

export type LeituraDeEnvelope =
  | { valido: true; claims: ClaimsDoEnvelope }
  | { valido: false; motivo: 'malformado' | 'assinatura_invalida' | 'expirado' }

/**
 * HMAC-SHA256 cru.
 *
 * E a unica primitiva de assinatura do painel: o mesmo `crypto.subtle.sign`
 * que o repositorio ja usa, sem HKDF e sem dependencia nova. Devolve bytes
 * porque a derivacao de subchave (§10.1) encadeia um HMAC no outro.
 */
export async function hmacSha256(
  chave: Uint8Array | string,
  mensagem: string,
): Promise<Uint8Array> {
  const bytes = typeof chave === 'string' ? encoder.encode(chave) : chave
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(mensagem))
  return new Uint8Array(mac)
}

/** O texto que a assinatura cobre. O proposito entra nele de proposito. */
function textoAssinado(proposito: string, claimsB64: string, expiraEm: string): string {
  return `${VERSAO}|${proposito}|${claimsB64}|${expiraEm}`
}

/**
 * Emite um envelope. `now` e injetado: o modulo nunca le o relogio sozinho.
 *
 * A `chave` ja vem derivada do proposito — quem deriva e
 * `chaveDeEnvelope()` em `src/services/panel-session.ts`.
 */
export async function criarEnvelope(
  proposito: PropositoDeEnvelope,
  claims: ClaimsDoEnvelope,
  chave: Uint8Array,
  now: number,
): Promise<string> {
  const claimsB64 = bytesToBase64Url(encoder.encode(JSON.stringify(claims)))
  const expiraEm = String(now + PRAZO_DE_ENVELOPE_MS[proposito])
  const assinatura = bytesToBase64Url(
    await hmacSha256(chave, textoAssinado(proposito, claimsB64, expiraEm)),
  )

  return [VERSAO, proposito, claimsB64, expiraEm, assinatura].join(SEPARADOR)
}

/**
 * Le um envelope e diz se ele autoriza `proposito`.
 *
 * Ordem de validacao IDENTICA a do `validateState` do OAuth: formato ->
 * assinatura em tempo constante -> prazo. Nunca o contrario. Conferir o prazo
 * antes deixaria um envelope forjado se distinguir de um vencido pelo tempo de
 * resposta e pela mensagem.
 *
 * As claims so sao decodificadas DEPOIS que a assinatura fecha: JSON de origem
 * desconhecida nao entra no `JSON.parse` sem MAC.
 */
export async function abrirEnvelope(
  envelope: string,
  proposito: PropositoDeEnvelope,
  chave: Uint8Array,
  now: number,
): Promise<LeituraDeEnvelope> {
  const partes = envelope.split(SEPARADOR)
  if (partes.length !== PARTES_DO_ENVELOPE) return { valido: false, motivo: 'malformado' }

  const [versao, propositoRecebido, claimsB64, expiraEmCru, assinatura] = partes as [
    string,
    string,
    string,
    string,
    string,
  ]
  // Trava de SES-10: `textoAssinado` embute a versao como CONSTANTE, entao um
  // envelope "v2" com um MAC calculado sobre o texto "v1" fecharia a
  // assinatura. Esta linha e a unica coisa que o recusa.
  if (versao !== VERSAO) return { valido: false, motivo: 'malformado' }
  // Primeira das tres defesas contra confusao de proposito (§10.3).
  // Trava de SES-04.
  if (propositoRecebido !== proposito) return { valido: false, motivo: 'malformado' }

  // Travas de SES-05 e SES-03: a assinatura vem ANTES do prazo, e cobre o
  // `expira_em` cru. Inverter estas duas linhas derruba os dois testes.
  const esperada = bytesToBase64Url(
    await hmacSha256(chave, textoAssinado(proposito, claimsB64, expiraEmCru)),
  )
  if (!timingSafeEqual(esperada, assinatura)) {
    return { valido: false, motivo: 'assinatura_invalida' }
  }

  const expiraEm = Number.parseInt(expiraEmCru, 10)
  if (!Number.isFinite(expiraEm)) return { valido: false, motivo: 'malformado' }
  if (now > expiraEm) return { valido: false, motivo: 'expirado' }

  const claims = lerClaims(claimsB64)
  if (claims === null) return { valido: false, motivo: 'malformado' }

  return { valido: true, claims }
}

/** Le as claims ja autenticadas. Devolve `null` para qualquer forma inesperada. */
function lerClaims(claimsB64: string): ClaimsDoEnvelope | null {
  const bytes = decodeBase64Url(claimsB64)
  if (bytes === null) return null

  try {
    const lido: unknown = JSON.parse(decoder.decode(bytes))
    if (typeof lido !== 'object' || lido === null || Array.isArray(lido)) return null
    for (const valor of Object.values(lido)) {
      if (typeof valor !== 'string') return null
    }
    return lido as ClaimsDoEnvelope
  } catch {
    return null
  }
}
