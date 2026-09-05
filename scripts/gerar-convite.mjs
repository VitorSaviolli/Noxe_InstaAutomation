#!/usr/bin/env node
/**
 * Imprime o link do convite que cadastra a primeira passkey do painel.
 *
 * Uso:  node scripts/gerar-convite.mjs [--qualquer-estado]
 *
 * **Roda sem rede e sem rota, e isso e o desenho, nao uma comodidade.** O
 * Worker NAO tem rota que emita convite: uma rota assim seria um segundo
 * caminho para o servidor produzir autorizacao de cadastro, e o painel inteiro
 * existe para que exista apenas um. Quem assina aqui e a sua maquina, com a
 * chave derivada do SETUP_ADMIN_TOKEN que ja esta no seu .dev.vars.
 *
 *   convite   = "cv1" "." nonce "." pre "." expira_em "." hmac
 *   hmac      = HMAC-SHA256( k_convite, "cv1|" + nonce + "|" + pre + "|" + expira_em )
 *   k_convite = HMAC-SHA256( SETUP_ADMIN_TOKEN, "noxe-painel/v1/convite" )
 *
 * O token sai depois do "#", e nao na query string: o que vem depois do "#"
 * NAO e enviado ao servidor, nao entra em log de proxy nem no cabecalho
 * Referer. E a mesma regra que o OAuth deste projeto ja segue.
 *
 * Vale 20 minutos e serve UMA vez. Se voce demorar, rode de novo — e de graca.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Rotulo de derivacao. Tem de ser IGUAL ao do Worker, byte a byte. */
const ROTULO = 'noxe-painel/v1/convite'
/** 20 minutos: da para sair do terminal e pegar o celular, e nada alem disso. */
const VALIDADE_MS = 20 * 60 * 1000
/** Piso do SETUP_ADMIN_TOKEN, o mesmo do portao de sanidade do Worker. */
const MINIMO_DO_TOKEN = 20

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

/** Le uma chave de um arquivo no formato `NOME=valor`, ignorando comentarios. */
function lerDoArquivo(caminho, chave) {
  let texto
  try {
    texto = readFileSync(caminho, 'utf8')
  } catch {
    return null
  }

  for (const linha of texto.split(/\r?\n/)) {
    const limpa = linha.trim()
    if (limpa === '' || limpa.startsWith('#')) continue

    const igual = limpa.indexOf('=')
    if (igual === -1) continue
    if (limpa.slice(0, igual).trim() !== chave) continue

    // Aspas sao aceitas porque muita gente as poe por habito.
    return limpa
      .slice(igual + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }

  return null
}

/**
 * O host do painel, de `wrangler.jsonc`.
 *
 * O PANEL_RP_ID fica gravado DENTRO da passkey e nao pode ser corrigido
 * depois: cadastrar apontando para o endereco errado produz uma credencial
 * irrecuperavel. Por isso ele e lido do arquivo de configuracao, e nao
 * digitado de novo aqui.
 */
function lerHost() {
  const texto = readFileSync('wrangler.jsonc', 'utf8')
  const achado = /"PANEL_RP_ID"\s*:\s*"([^"]*)"/.exec(texto)
  return achado === null ? '' : achado[1]
}

function morrer(mensagem, comoResolver) {
  console.error(`\n${mensagem}\n`)
  console.error(comoResolver)
  process.exit(1)
}

const token = process.env.SETUP_ADMIN_TOKEN ?? lerDoArquivo('.dev.vars', 'SETUP_ADMIN_TOKEN')
if (token === null || token === '' || token.length < MINIMO_DO_TOKEN) {
  morrer(
    'Nao achei um SETUP_ADMIN_TOKEN utilizavel.',
    'Preencha SETUP_ADMIN_TOKEN no arquivo .dev.vars (copie de .dev.vars.example)\n' +
      'com o MESMO valor que voce cadastrou no Worker:\n' +
      '  npx wrangler secret put SETUP_ADMIN_TOKEN\n' +
      'Se ele estiver diferente do que esta publicado, o convite sera recusado.',
  )
}

const host = lerHost()
if (host === '') {
  morrer(
    'O endereco do painel (PANEL_RP_ID) esta vazio no wrangler.jsonc.',
    'Preencha "PANEL_RP_ID" com o endereco exato do seu Worker, sem https:// e\n' +
      'sem barra no fim. Exemplo:\n' +
      '  "PANEL_RP_ID": "noxe-insta-automation.SEU-USUARIO.workers.dev"\n\n' +
      'ATENCAO: este endereco fica gravado dentro da passkey e nao pode ser\n' +
      'corrigido depois. Se ele mudar, todo aparelho precisa ser cadastrado de\n' +
      'novo. Publique (npm run deploy) antes de gerar o convite.',
  )
}

// `q` vale em qualquer estado; `0` so vale enquanto NAO existir passkey
// nenhuma. O padrao e o mais restrito de proposito: um convite comum pode
// acabar num print de tutorial, e ele deixa de funcionar no instante em que a
// primeira passkey existe.
const qualquerEstado = process.argv.includes('--qualquer-estado')
const pre = qualquerEstado ? 'q' : '0'

const nonce = base64url(randomBytes(16))
const expiraEm = String(Date.now() + VALIDADE_MS)

const chave = createHmac('sha256', token).update(ROTULO).digest()
const assinatura = base64url(
  createHmac('sha256', chave).update(`cv1|${nonce}|${pre}|${expiraEm}`).digest(),
)

const convite = ['cv1', nonce, pre, expiraEm, assinatura].join('.')

console.log('\nAbra este link NO CELULAR que voce quer cadastrar:\n')
console.log(`  https://${host}/painel/convite#c=${convite}\n`)
console.log('Vale 20 minutos e serve uma vez so.')
if (qualquerEstado) {
  console.log(
    '\nATENCAO: este convite foi gerado com --qualquer-estado. Ele funciona MESMO\n' +
      'que ja exista passkey cadastrada, entao quem tiver este link cadastra um\n' +
      'aparelho. Use so para recuperar acesso, e nao guarde o link em lugar nenhum.',
  )
} else {
  console.log('Ele para de funcionar assim que a primeira passkey for cadastrada.')
}
console.log('\nDepois de cadastrar, o painel pede a digital DE NOVO para entrar.')
console.log('Isso e proposital: cadastrar um aparelho e entrar com ele sao duas coisas.\n')
