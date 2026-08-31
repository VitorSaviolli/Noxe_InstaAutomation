#!/usr/bin/env node
/**
 * Simula um evento de comentario da Meta, com assinatura HMAC valida.
 *
 * Serve para exercitar o pipeline (assinatura -> parsing -> automacao) sem
 * depender do Instagram. NAO substitui o teste real: a resposta publica e o
 * Direct so acontecem de verdade quando ha uma conta conectada.
 *
 * Uso:
 *   node scripts/simular-webhook.mjs                      # texto padrao "eu quero"
 *   node scripts/simular-webhook.mjs "nao quero nada"      # texto customizado
 *   node scripts/simular-webhook.mjs "eu quero" --local    # contra wrangler dev
 *
 * Sem `--local`, o destino vem de WORKER_PUBLIC_URL (variavel de ambiente ou
 * linha do .env). NAO existe endereco padrao de proposito: um padrao faria
 * este script disparar eventos falsos no Worker de outra pessoa.
 *
 * O META_APP_SECRET e lido do .env ou da variavel de ambiente. Ele NUNCA e
 * impresso na saida.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const URL_LOCAL = 'http://localhost:8787'
const CAMINHO_WEBHOOK = '/webhooks/instagram'

/** Le uma chave do .env sem depender de biblioteca externa. */
function lerDoEnv(chave) {
  try {
    const linhas = readFileSync('.env', 'utf8').split('\n')
    for (const linha of linhas) {
      const limpa = linha.trim()
      if (limpa.startsWith('#') || !limpa.includes('=')) continue
      const separador = limpa.indexOf('=')
      if (limpa.slice(0, separador).trim() === chave) {
        return limpa.slice(separador + 1).trim()
      }
    }
  } catch {
    // .env ausente e um caso normal: cai na variavel de ambiente.
  }
  return null
}

/** Explica o que preencher e encerra: melhor parar do que chutar um destino. */
function abortarSemDestino() {
  console.error('Nao sei para qual endereco enviar o webhook simulado.')
  console.error('')
  console.error('Abra o arquivo .env na raiz do projeto (se ele nao existir, copie')
  console.error('o .env.example para .env) e preencha a linha WORKER_PUBLIC_URL com')
  console.error('o endereco do SEU Worker. Exemplo:')
  console.error('')
  console.error('  WORKER_PUBLIC_URL=https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev')
  console.error('')
  console.error('Esse endereco aparece no final do `npm run deploy` e tambem no painel')
  console.error('da Cloudflare, em Workers & Pages, dentro do seu Worker.')
  console.error('')
  console.error('Para testar o servidor local (`npm run dev`) em vez da nuvem, rode:')
  console.error('  node scripts/simular-webhook.mjs "eu quero" --local')
  process.exit(1)
}

/**
 * Descobre o endereco publico do SEU Worker.
 *
 * Ordem: variavel de ambiente WORKER_PUBLIC_URL, depois a mesma chave no .env.
 * Se as duas estiverem vazias, o script para — nunca cai num endereco padrao.
 */
function resolverUrlPublica() {
  const bruta = process.env.WORKER_PUBLIC_URL ?? lerDoEnv('WORKER_PUBLIC_URL') ?? ''
  const url = bruta.trim().replace(/\/+$/, '')

  if (url.length === 0) abortarSemDestino()

  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    console.error(`WORKER_PUBLIC_URL invalido: "${url}"`)
    console.error('O endereco precisa comecar com https:// — cole a URL completa.')
    process.exit(1)
  }

  return url
}

const appSecret = process.env.META_APP_SECRET ?? lerDoEnv('META_APP_SECRET')
if (!appSecret) {
  console.error('META_APP_SECRET nao encontrado no .env nem no ambiente.')
  process.exit(1)
}

const argumentos = process.argv.slice(2)
const local = argumentos.includes('--local')
const texto = argumentos.find((a) => !a.startsWith('--')) ?? 'eu quero'
const base = local ? URL_LOCAL : resolverUrlPublica()

// IDs unicos por execucao: sem isso a segunda rodada bateria no dedup e o
// teste pareceria quebrado quando na verdade a protecao esta funcionando.
const sufixo = randomUUID().slice(0, 8)

const payload = JSON.stringify({
  object: 'instagram',
  entry: [
    {
      id: 'conta-simulada',
      time: Math.floor(Date.now() / 1000),
      changes: [
        {
          field: 'comments',
          value: {
            id: `comment-sim-${sufixo}`,
            text: texto,
            from: { id: `igsid-sim-${sufixo}`, username: 'visitante_simulado' },
            media: { id: 'media-sim', media_product_type: 'REELS' },
          },
        },
      ],
    },
  ],
})

const assinatura = `sha256=${createHmac('sha256', appSecret).update(payload).digest('hex')}`

console.log(`Destino: ${base}${CAMINHO_WEBHOOK}`)
console.log(`Texto do comentario: "${texto}"`)
console.log('')

const resposta = await fetch(`${base}${CAMINHO_WEBHOOK}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hub-signature-256': assinatura,
  },
  body: payload,
})

const corpo = await resposta.text()
console.log(`HTTP ${resposta.status} — ${corpo}`)
console.log('')

if (resposta.status === 200) {
  console.log('Assinatura aceita e evento recebido.')
  console.log('O processamento roda em segundo plano: veja com `npm run tail`.')
} else if (resposta.status === 401) {
  console.log('Assinatura recusada. O META_APP_SECRET local difere do cadastrado')
  console.log('no Worker (`npx wrangler secret put META_APP_SECRET`).')
} else {
  console.log('Resposta inesperada. Confira os logs com `npm run tail`.')
}

// Controle negativo: a mesma requisicao com assinatura invalida deve dar 401.
const recusada = await fetch(`${base}${CAMINHO_WEBHOOK}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
  },
  body: payload,
})

console.log('')
console.log(
  recusada.status === 401
    ? 'Controle negativo OK: assinatura falsa foi recusada com 401.'
    : `ATENCAO: assinatura falsa devolveu ${recusada.status}, esperado 401.`,
)
