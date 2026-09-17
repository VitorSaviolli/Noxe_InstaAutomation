#!/usr/bin/env node
/**
 * Trava de seguranca para rodar ANTES do primeiro commit publico.
 *
 * Uso:  node scripts/verificar-antes-de-publicar.mjs
 *
 * Procura os erros que costumam acontecer quando um projeto privado vira
 * publico: segredo esquecido dentro de um arquivo, dado pessoal do autor
 * original ainda no lugar do seu, arquivo de senha rastreado pelo git.
 *
 * Termina com codigo 1 se houver qualquer FALHA e 0 se houver so avisos,
 * para poder ser usado tambem dentro de um fluxo automatizado.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Raiz do projeto: o script funciona mesmo rodado de outra pasta. */
const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/** Este proprio arquivo fica de fora da varredura (explicado mais abaixo). */
const MEU_CAMINHO = 'scripts/verificar-antes-de-publicar.mjs'

/** Pastas que nunca entram numa varredura: sao geradas ou nao vao pro git. */
const PASTAS_IGNORADAS = new Set([
  'node_modules',
  '.git',
  '.wrangler',
  '.mf',
  'dist',
  'build',
  'coverage',
  '.vitest',
  '.idea',
  '.vscode',
])

/** Arquivos binarios nao tem texto para ler. */
const EXTENSOES_BINARIAS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.mov',
  '.wasm',
])

/** Arquivos cheios de hashes legitimos que dariam alarme falso o tempo todo. */
const ARQUIVOS_COM_HASH = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

/** Acima disso uma imagem ja pesa no download de quem clonar o repositorio. */
const TAMANHO_GRANDE_BYTES = 300 * 1024

const relatorio = { passou: 0, falhou: 0, avisos: 0 }

// ---------------------------------------------------------------------------
// Saida na tela
// ---------------------------------------------------------------------------

function secao(texto) {
  console.log(`\n${texto}`)
}

function dicas(linhas) {
  for (const linha of linhas ?? []) console.log(`            ${linha}`)
}

function ok(texto) {
  relatorio.passou += 1
  console.log(`  [ok]      ${texto}`)
}

function falha(texto, comoResolver) {
  relatorio.falhou += 1
  console.log(`  [FALHA]   ${texto}`)
  dicas(comoResolver)
}

function aviso(texto, comoResolver) {
  relatorio.avisos += 1
  console.log(`  [atencao] ${texto}`)
  dicas(comoResolver)
}

// ---------------------------------------------------------------------------
// Leitura de arquivos e apoio ao git
// ---------------------------------------------------------------------------

function lerTexto(caminho) {
  try {
    return readFileSync(caminho, 'utf8')
  } catch {
    return null
  }
}

/** O arquivo cru, sem decodificar. E o que o hash de uma migration exige. */
function lerBytes(caminho) {
  try {
    return readFileSync(caminho)
  } catch {
    return null
  }
}

function temPastaGit() {
  return existsSync(join(RAIZ, '.git'))
}

/** Roda um comando git na raiz. Devolve null se o git nem estiver instalado. */
function rodarGit(argumentos) {
  const resultado = spawnSync('git', argumentos, { cwd: RAIZ, encoding: 'utf8' })
  if (resultado.error) return null
  return resultado
}

/**
 * O conteudo que o PROXIMO COMMIT vai levar, e nao o que esta no disco.
 *
 * A distincao existe porque este projeto separa de proposito as duas coisas
 * (a "Ruling 2" do ledger): a arvore de trabalho carrega os valores REAIS do
 * dono, o `database_id` do banco dele, o host do Worker dele, o e-mail de
 * contato dele, e o commit carrega os placeholders, porque e o commit que
 * vira repositorio-template para outra pessoa clonar.
 *
 * Enquanto a varredura de identidade lia o DISCO, ela era insatisfazivel para o
 * autor original: a checagem 5 exige o contato preenchido em `legal.ts` e a
 * checagem 3 proibia justamente aquele contato. Nenhum estado do arquivo
 * agradava as duas. Lendo o INDICE, a pergunta volta a ser a que o titulo do
 * script faz, "o que vai para o GitHub?", e as duas ficam satisfazivel ao
 * mesmo tempo.
 *
 * Devolve null quando nao ha git, nao ha indice ou o caminho nao esta
 * rastreado; quem chama cai de volta no disco, que e o lado seguro.
 */
function conteudoEstagiado(caminho) {
  const resultado = rodarGit(['show', `:${caminho}`])
  if (resultado === null || resultado.status !== 0) return null
  return resultado.stdout
}

/** True para .env, .env.local, .dev.vars, .dev.vars.bak e parentes. */
function ehArquivoDeSegredo(nome) {
  if (nome.endsWith('.example')) return false
  return ['.env', '.dev.vars'].some((base) => nome === base || nome.startsWith(`${base}.`))
}

function arquivosDeSegredoNaRaiz() {
  return readdirSync(RAIZ, { withFileTypes: true })
    .filter((item) => item.isFile() && ehArquivoDeSegredo(item.name))
    .map((item) => item.name)
}

/** Caminhos relativos, sempre com barra normal, para a saida ficar legivel. */
function caminhoRelativo(completo) {
  return relative(RAIZ, completo).split(sep).join('/')
}

function varrerPasta(pasta, acumulado) {
  for (const item of readdirSync(pasta, { withFileTypes: true })) {
    const completo = join(pasta, item.name)
    if (item.isDirectory()) {
      if (!PASTAS_IGNORADAS.has(item.name)) varrerPasta(completo, acumulado)
      continue
    }
    if (item.isFile()) acumulado.push(caminhoRelativo(completo))
  }
  return acumulado
}

/**
 * Lista os arquivos a varrer.
 *
 * Com git, usamos os arquivos rastreados: sao exatamente os que vao para o
 * GitHub. Sem git (ou sem nenhum commit ainda), varremos a pasta inteira.
 */
function listarArquivos(temGit) {
  if (temGit) {
    const resultado = rodarGit(['ls-files', '-z'])
    if (resultado?.status === 0) {
      const lista = resultado.stdout.split('\0').filter((item) => item.length > 0)
      if (lista.length > 0) return lista
    }
  }
  return varrerPasta(RAIZ, [])
}

// ---------------------------------------------------------------------------
// Checagem 1 - o .gitignore cobre mesmo os arquivos de segredo
// ---------------------------------------------------------------------------

function conferirTextoDoGitignore() {
  const conteudo = lerTexto(join(RAIZ, '.gitignore'))
  if (conteudo === null) {
    falha('Nao existe arquivo .gitignore neste projeto.', [
      'Sem ele, o comando git add pode mandar os seus segredos para o GitHub.',
      'Crie um .gitignore contendo pelo menos: .env, .env.*, .dev.vars, .dev.vars.*',
    ])
    return
  }

  const linhas = conteudo.split('\n').map((linha) => linha.trim())
  const esperados = ['.env', '.env.*', '.dev.vars', '.dev.vars.*']
  const faltando = esperados.filter((padrao) => !linhas.includes(padrao))

  if (faltando.length > 0) {
    falha(`O .gitignore nao lista: ${faltando.join(', ')}`, [
      'Acrescente essas linhas no .gitignore antes de qualquer commit.',
    ])
    return
  }
  ok('O .gitignore lista .env, .env.*, .dev.vars e .dev.vars.*')
}

function checagem1(temGit) {
  secao('1. Arquivos de segredo cobertos pelo .gitignore')
  conferirTextoDoGitignore()

  const presentes = arquivosDeSegredoNaRaiz()
  if (presentes.length === 0) {
    ok('Nenhum arquivo de segredo foi encontrado na pasta do projeto.')
    return
  }

  if (!temGit) {
    aviso('Ainda nao existe a pasta .git aqui, entao a conferencia foi so textual.', [
      'Depois de rodar git init, rode esta verificacao de novo: so entao da para',
      'confirmar de verdade que o git esta ignorando os arquivos.',
    ])
    return
  }

  for (const arquivo of presentes) {
    const resultado = rodarGit(['check-ignore', '-q', arquivo])
    if (resultado === null) {
      aviso('O git nao esta instalado, entao a conferencia foi so textual.', [
        'Instale o git e rode esta verificacao de novo antes de publicar.',
      ])
      return
    }
    if (resultado.status === 0) {
      ok(`O git confirma que esta ignorando o arquivo ${arquivo}`)
    } else {
      falha(`O git NAO esta ignorando o arquivo ${arquivo}`, [
        'Esse arquivo tem segredos e iria parar no GitHub.',
        `Acrescente uma linha com ${arquivo} no .gitignore e confira de novo.`,
      ])
    }
  }
}

// ---------------------------------------------------------------------------
// Checagem 2 - nenhum arquivo de segredo esta rastreado
// ---------------------------------------------------------------------------

function checagem2(temGit) {
  secao('2. Nenhum arquivo de segredo esta rastreado pelo git')
  if (!temGit) {
    aviso('Sem pasta .git ainda: nao existe nada rastreado para conferir.')
    return
  }

  const resultado = rodarGit(['ls-files', '-z'])
  if (resultado === null || resultado.status !== 0) {
    aviso('Nao consegui rodar git ls-files para conferir.', [
      'Rode manualmente: git ls-files   e olhe se aparece .env ou .dev.vars.',
    ])
    return
  }

  const rastreados = resultado.stdout
    .split('\0')
    .filter((caminho) => caminho.length > 0)
    .filter((caminho) => ehArquivoDeSegredo(basename(caminho)))

  if (rastreados.length === 0) {
    ok('Nenhum arquivo de segredo esta rastreado.')
    return
  }

  falha(`Estes arquivos de segredo estao rastreados: ${rastreados.join(', ')}`, [
    'Rastreado quer dizer que o proximo commit publica o conteudo deles.',
    'Para tirar do git sem apagar do seu disco, rode para cada arquivo:',
    '  git rm --cached <arquivo>',
    'E trate os segredos que estavam nele como vazados: gere valores novos.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 3 - varredura de segredo e de dado pessoal dentro dos arquivos
// ---------------------------------------------------------------------------

/**
 * Os seus dados pessoais moram num arquivo LOCAL, fora do git.
 *
 * Eles ja moraram aqui, quebrados em pedacos. So que este script vai para o
 * GitHub junto com o resto, e os pedacos juntos entregavam exatamente o que a
 * varredura existe para proteger. Uma lista de "o que nao pode vazar" nao pode
 * estar num arquivo publico.
 *
 * Formato: um trecho por linha, sem aspas. Linha vazia e linha comecando com
 * `#` sao ignoradas. A comparacao nao diferencia maiuscula de minuscula.
 * Coloque o que so voce tem: seu e-mail, seu usuario do workers.dev, o comeco
 * do ID do seu banco D1, o META_APP_ID do seu app. Nao coloque o nome de
 * empresa que aparece de proposito nos creditos: daria alarme em LICENSE e
 * README em toda execucao.
 */
const ARQUIVO_IDENTIDADE = '.identidade-local.txt'

/** Os trechos do arquivo local, ou null se ele nao existe. */
function carregarIdentidade() {
  const conteudo = lerTexto(join(RAIZ, ARQUIVO_IDENTIDADE))
  if (conteudo === null) return null
  return conteudo
    .split('\n')
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith('#'))
    .map((trecho) => trecho.toLowerCase())
}

/** Valor aleatorio de verdade mistura minuscula, maiuscula e numero. */
function pareceAleatorio(texto) {
  return /[a-z]/.test(texto) && /[A-Z]/.test(texto) && /[0-9]/.test(texto)
}

/**
 * Distingue uma chave de verdade de um valor de exemplo escrito a mao.
 *
 * Uma chave aleatoria de 32 bytes, ao ser decodificada, vira lixo binario.
 * Um valor de teste como "0123456789abcdef..." decodifica para texto legivel.
 * Sem esta conferencia, os valores ficticios usados nos testes apareceriam
 * como vazamento em toda execucao, e um alarme que toca sempre acaba sendo
 * ignorado justo no dia em que estiver certo.
 */
function decodificaParaLixoBinario(valor, codificacao) {
  try {
    const bytes = Buffer.from(valor, codificacao)
    if (bytes.length < 16) return false
    let legiveis = 0
    for (const byte of bytes) {
      if (byte >= 0x20 && byte <= 0x7e) legiveis += 1
    }
    return legiveis / bytes.length < 0.9
  } catch {
    return false
  }
}

const REGRAS_DE_SEGREDO = [
  {
    rotulo: 'chave base64 de 32 bytes (com cara de TOKEN_ENCRYPTION_KEY)',
    // O caractere antes do valor nao pode ser base64, senao pegariamos um
    // pedaco do meio de um texto maior. O `=` fica de fora dessa exclusao:
    // o caso mais comum e justamente CHAVE=valor.
    padrao: /(?:^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{43}=)(?![A-Za-z0-9+/=])/,
    codificacao: 'base64',
    pularArquivosComHash: true,
  },
  {
    rotulo: 'token base64url de 32 bytes (com cara de SETUP_ADMIN_TOKEN)',
    padrao: /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/,
    codificacao: 'base64url',
    pularArquivosComHash: true,
  },
  {
    rotulo: 'sequencia hexadecimal de 32 caracteres (com cara de META_APP_SECRET)',
    padrao: /(?:^|[^0-9A-Fa-f])([0-9a-f]{32})(?![0-9A-Fa-f])/,
    codificacao: null,
    pularArquivosComHash: true,
  },
  {
    rotulo: 'token de acesso da Meta (comeca com EAA)',
    padrao: /\b(EAA[A-Za-z0-9]{20,})/,
    codificacao: null,
    pularArquivosComHash: false,
  },
]

/**
 * Valores que PARECEM chave e provadamente nao sao, cada um pelo seu motivo.
 *
 * A chave e o sha256 do valor, e nao o valor: assim a lista nao vira ela mesma
 * um lugar onde segredo mora, e trocar o vetor por outro derruba a checagem em
 * vez de continuar liberando o antigo em silencio.
 *
 * A alternativa era isentar os ARQUIVOS, e ela e pior: um segredo de verdade
 * colado depois em `tests/regressao-oauth.test.ts` deixaria de ser visto.
 * Aqui a isencao vale para UM valor, e acrescentar outro e uma decisao que
 * aparece na revisao, o mesmo desenho de AUTORIZADOS_A_USAR_CRU.
 *
 * Por que cada um esta aqui, e nao "porque o alarme incomodava":
 *   - as duas primeiras sao as coordenadas x e y de uma chave EC P-256
 *     PUBLICA (`CHAVE_DESCARTAVEL`, trava de WA-19). Coordenada de chave
 *     publica nao e segredo por definicao: ela existe para ser publicada.
 *   - a terceira e o convite congelado de T2, assinado com o SETUP_ADMIN_TOKEN
 *     ficticio do ambiente de teste. O que ela prova e que o script do dono e o
 *     Worker concordam byte a byte.
 *   - as duas ultimas sao a MESMA saida de HMAC nas duas codificacoes,
 *     escolhida porque produz `+`, `/` e `=` de uma vez. Saida de HMAC com
 *     chave de teste, e nao chave.
 *
 * Nenhum deles decodifica para texto legivel, entao os dois filtros de
 * `pareceChaveDeVerdade` os deixam passar, e e por isso que o alarme tocava
 * em toda execucao. Um alarme que toca sempre e o comentario de `decodifica-
 * ParaLixoBinario` ja diz: ignorado justo no dia em que estiver certo.
 */
const VETORES_DECLARADOS = new Map([
  ['b4a652d3d2c683c31b80b8e5ebf31c18a6bf39965e73692df4cd714cdc6d2714', 'CHAVE_DESCARTAVEL.x (chave publica, WA-19)'],
  ['ed5ce7ad62c8bd9e415343c78336300c5720915c707756c636c94af25b471c04', 'CHAVE_DESCARTAVEL.y (chave publica, WA-19)'],
  ['3f6725dffa2dc0d96c048a9f8ef11764c80e208e3b494cdd20e2f7d9b3ac3006', 'convite congelado de T2 (token ficticio de teste)'],
  ['c2dbd7649eeaf00e68be25a927c7bd761f39646150276dab26a14a0b77ce1ed1', 'assinatura de ouro do OAuth, base64url'],
  ['16e256085cc74fac2efbd8e77fa69430c9207cc08990a5583d204c9f90ff3a5b', 'a mesma assinatura de ouro, base64 padrao'],
])

/** True se o valor e um dos vetores declarados acima. */
function ehVetorDeclarado(valor) {
  return VETORES_DECLARADOS.has(createHash('sha256').update(valor).digest('hex'))
}

/** Aplica os dois filtros que separam chave de verdade de valor de exemplo. */
function pareceChaveDeVerdade(regra, valor) {
  if (regra.codificacao === null) return true
  if (!pareceAleatorio(valor)) return false
  return decodificaParaLixoBinario(valor, regra.codificacao)
}

/** Mostra so o comeco do achado: o resto pode ser um segredo de verdade. */
function encurtar(texto) {
  return `${texto.slice(0, 6)}... (${texto.length} caracteres)`
}

function ehVarrivel(caminho) {
  if (caminho === MEU_CAMINHO) return false
  if (caminho === ARQUIVO_IDENTIDADE) return false
  if (ehArquivoDeSegredo(basename(caminho))) return false
  if (caminho.endsWith('.bak')) return false
  return !EXTENSOES_BINARIAS.has(extname(caminho).toLowerCase())
}

function procurarSegredosNoTexto(caminho, linhas, achados) {
  const temHashLegitimo = ARQUIVOS_COM_HASH.has(basename(caminho))
  const ehExemplo = caminho.includes('.example')

  for (const regra of REGRAS_DE_SEGREDO) {
    if (regra.pularArquivosComHash && (temHashLegitimo || ehExemplo)) continue
    linhas.forEach((linha, indice) => {
      const encontrado = linha.match(regra.padrao)
      if (!encontrado) return
      if (!pareceChaveDeVerdade(regra, encontrado[1])) return
      if (ehVetorDeclarado(encontrado[1])) return
      achados.push({
        caminho,
        numeroDaLinha: indice + 1,
        rotulo: regra.rotulo,
        trecho: encurtar(encontrado[1]),
      })
    })
  }
}

function procurarIdentidadeNoTexto(caminho, linhas, identidade, achados) {
  for (const agulha of identidade) {
    linhas.forEach((linha, indice) => {
      if (!linha.toLowerCase().includes(agulha)) return
      achados.push({
        caminho,
        numeroDaLinha: indice + 1,
        rotulo: `dado pessoal listado em ${ARQUIVO_IDENTIDADE}`,
        trecho: 'trocar pelo placeholder do README',
      })
    })
  }
}

function checagem3(arquivos) {
  secao('3. Nenhum segredo ou dado pessoal dentro dos arquivos')
  const achados = []
  const identidade = carregarIdentidade() ?? []

  if (identidade.length === 0) {
    aviso(`Sem ${ARQUIVO_IDENTIDADE}: a busca por dado pessoal esta desligada.`, [
      'A busca por segredo continua valendo. Para ligar a de dado pessoal, crie',
      `o arquivo ${ARQUIVO_IDENTIDADE} na raiz do projeto com um trecho por linha`,
      '(seu e-mail, seu usuario do workers.dev, o META_APP_ID do seu app).',
      'Ele ja esta no .gitignore: nunca vai para o GitHub.',
    ])
  }

  for (const caminho of arquivos) {
    if (!ehVarrivel(caminho)) continue

    // SEGREDO: sempre o DISCO, que e o estado mais rigoroso dos dois. Um valor
    // colado num arquivo e ainda nao estagiado ja e um vazamento a um `git add`
    // de distancia, e esta e a ultima tela antes daquele comando.
    const naArvore = lerTexto(join(RAIZ, caminho))
    if (naArvore !== null) {
      procurarSegredosNoTexto(caminho, naArvore.split('\n'), achados)
    }

    // IDENTIDADE: o que vai para o GITHUB, que e o indice. Ver o comentario de
    // `conteudoEstagiado`: os valores reais do dono moram na arvore de proposito,
    // e acusa-los aqui tornava a checagem 3 e a checagem 5 insatisfazivel juntas.
    const paraOGitHub = conteudoEstagiado(caminho) ?? naArvore
    if (paraOGitHub !== null) {
      procurarIdentidadeNoTexto(caminho, paraOGitHub.split('\n'), identidade, achados)
    }
  }

  if (achados.length === 0) {
    ok(`Varri ${arquivos.length} arquivo(s) e nao achei nada suspeito.`)
    return
  }

  falha(`Encontrei ${achados.length} trecho(s) suspeito(s):`, [])
  for (const achado of achados) {
    console.log(`            ${achado.caminho}:${achado.numeroDaLinha}`)
    console.log(`              tipo: ${achado.rotulo}`)
    console.log(`              inicio: ${achado.trecho}`)
  }
  dicas([
    '',
    'Abra cada arquivo na linha indicada e confira.',
    'Se for um segredo de verdade, apague o valor do arquivo E gere um novo:',
    '  node scripts/configurar.mjs 1',
    'Se for so o dado pessoal do autor original, troque pelo placeholder.',
    'Pode haver alarme falso (um codigo longo qualquer). Confira antes de mexer.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 4 - os placeholders continuam no wrangler.jsonc
// ---------------------------------------------------------------------------

function valorNoJsonc(conteudo, chave) {
  const regex = new RegExp(`"${chave}"\\s*:\\s*"([^"]*)"`)
  return conteudo.match(regex)?.[1] ?? null
}

function conferirIdDoBanco(valor) {
  const ehUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor)
  if (!ehUuid) {
    ok('O database_id do wrangler.jsonc esta com placeholder, nao com um ID real.')
    return
  }
  falha('O wrangler.jsonc tem um database_id de verdade.', [
    'Quem clonar o repositorio nao consegue usar esse banco, e o ID revela',
    'qual banco e o seu. Troque o valor por COLE_AQUI_O_ID_DO_SEU_BANCO_D1',
    'e explique no README que ele vem do comando:',
    '  npx wrangler d1 create noxe-insta-automation',
  ])
}

function conferirIdDoApp(valor) {
  if (!/^\d{8,}$/.test(valor)) {
    ok('O META_APP_ID do wrangler.jsonc esta com placeholder, nao com um ID real.')
    return
  }
  falha('O wrangler.jsonc tem um META_APP_ID de verdade.', [
    'Troque o valor por COLE_AQUI_O_ID_DO_SEU_APP_META. Cada pessoa precisa',
    'usar o ID do proprio app criado no developers.facebook.com.',
  ])
}

function checagem4() {
  secao('4. Os placeholders continuam no lugar no wrangler.jsonc')

  // O INDICE, e nao o disco, pelo mesmo motivo da varredura de identidade: esta
  // checagem pergunta "o que quem clonar vai receber?", e quem clona recebe o
  // commit. O disco tem os valores reais do dono de proposito, sem eles o
  // `npm run deploy` nao acha o banco nem o app.
  //
  // As checagens 9 e 10 continuam lendo o DISCO, e a diferenca e deliberada:
  // elas fazem a outra pergunta, "o Worker DESTA pessoa sobe?", e a resposta
  // depende do valor real, nunca do placeholder.
  const conteudo = conteudoEstagiado('wrangler.jsonc') ?? lerTexto(join(RAIZ, 'wrangler.jsonc'))
  if (conteudo === null) {
    falha('Nao encontrei o arquivo wrangler.jsonc.', [
      'Sem ele o projeto nao publica. Confira se voce esta na pasta certa.',
    ])
    return
  }

  const idBanco = valorNoJsonc(conteudo, 'database_id') ?? ''
  const idApp = valorNoJsonc(conteudo, 'META_APP_ID') ?? ''

  if (idBanco.includes('COLE_AQUI')) ok('O database_id esta com o texto COLE_AQUI, como deve ser.')
  else conferirIdDoBanco(idBanco)

  if (idApp.includes('COLE_AQUI')) ok('O META_APP_ID esta com o texto COLE_AQUI, como deve ser.')
  else conferirIdDoApp(idApp)
}

// ---------------------------------------------------------------------------
// Checagem 4b - a lista de segredos nao pode divergir entre os arquivos
// ---------------------------------------------------------------------------

/**
 * Os nomes de `secrets.required` do wrangler.jsonc.
 *
 * `valorNoJsonc` so le valor escalar, e este e um array, por isso o recorte
 * do bloco antes do split.
 */
function segredosExigidos(conteudo) {
  const bloco = conteudo.match(/"required"\s*:\s*\[([^\]]*)\]/)
  if (bloco === null) return []
  return [...bloco[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1])
}

/**
 * Confere que todo segredo exigido aparece onde o operador vai encontra-lo.
 *
 * Esta checagem existe por um caso real: a `PANEL_SESSION_KEY` estava em
 * `secrets.required` e em `src/types/env.ts`, e em lugar nenhum do
 * `gerar-segredos.mjs`, do `configurar.mjs` ou dos quatro guias. Quem seguia a
 * documentacao a risca publicava sem ela, e o painel, o recurso principal do
 * projeto, respondia 503 sem nenhum documento explicando por que.
 *
 * A lista mora em cinco arquivos. Enquanto morar, alguem precisa compara-los.
 */
function checagem4b() {
  secao('4b. Todo segredo exigido aparece nos geradores e nos guias')
  const wrangler = lerTexto(join(RAIZ, 'wrangler.jsonc'))
  if (wrangler === null) return

  const exigidos = segredosExigidos(wrangler)
  if (exigidos.length === 0) {
    aviso('Nao consegui ler secrets.required do wrangler.jsonc.')
    return
  }

  // O META_APP_SECRET vem da Meta: nao e gerado, entao nao entra nos geradores.
  const gerados = exigidos.filter((nome) => nome !== 'META_APP_SECRET')

  const fontes = [
    ['scripts/gerar-segredos.mjs', gerados],
    ['scripts/configurar.mjs', gerados],
    ['.dev.vars.example', exigidos],
    ['SETUP_CLOUDFLARE.md', exigidos],
  ]

  // O readmeiniciante.md fica FORA de proposito: ele nao enumera segredo por
  // nome, delega ao `npm run configurar` e fala em "N vezes, uma por segredo".
  // Exigir os nomes la seria pedir que ele deixe de ser o guia curto que e.

  const faltando = []
  for (const [caminho, esperados] of fontes) {
    const conteudo = lerTexto(join(RAIZ, ...caminho.split('/')))
    if (conteudo === null) continue
    for (const nome of esperados) {
      if (!conteudo.includes(nome)) faltando.push(`${nome} nao aparece em ${caminho}`)
    }
  }

  if (faltando.length === 0) {
    ok(`Os ${exigidos.length} segredos exigidos aparecem nos geradores e nos guias.`)
    return
  }

  falha('Um segredo exigido nao esta documentado nem gerado.', [
    ...faltando,
    '',
    'Quem seguir os guias vai publicar sem esse valor. Se ele for a',
    'PANEL_SESSION_KEY, o painel responde 503 e nada explica por que.',
    'Acrescente o segredo no gerador e no guia, ou tire de secrets.required.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 15 - as migrations entregues nao mudaram
// ---------------------------------------------------------------------------
//
// O NUMERO E 15, e nao "4c", porque e o numero que 13.5 reserva a ela e e o
// numero que as pessoas citam em revisao. A POSICAO no arquivo continua aqui,
// colada na 4 e na 4b, porque as tres leem manifestos e fazem a mesma pergunta:
// "o arquivo continua sendo o que foi entregue?". A ordem em que ela aparece na
// tela vem de `principal()`, onde e chamada entre a 14 e a 16.

/**
 * `migrations/CHECKSUMS.txt` confere com os arquivos que estao no disco.
 *
 * O proprio CHECKSUMS.txt explica por que uma migration entregue nunca e
 * editada: os testes aplicam as MESMAS migrations de producao, e
 * `CREATE TABLE IF NOT EXISTS` transforma "a tabela ja existe com outra forma"
 * num no-op silencioso que so quebra la na frente, com `no such column`.
 *
 * O que faltava era quem confere. A regra estava escrita, e o arquivo sugeria
 * `sha256sum -c`, um comando que so roda se alguem lembrar dele, num projeto
 * cujo publico-alvo nao sabe programar. Editar a 0001 e publicar passava por
 * `npm run verificar` inteiro sem uma linha vermelha.
 *
 * FALHA, e nao aviso: uma migration divergente e a classe de erro que aparece
 * como dado corrompido semanas depois, e nao como erro na hora de publicar.
 */
function checagem15() {
  secao('15. As migrations entregues continuam identicas ao CHECKSUMS.txt')

  const pasta = join(RAIZ, 'migrations')
  const manifesto = lerTexto(join(pasta, 'CHECKSUMS.txt'))
  if (manifesto === null) {
    aviso('Nao encontrei migrations/CHECKSUMS.txt para conferir.')
    return
  }

  const esperado = new Map()
  for (const linha of manifesto.split('\n')) {
    const casou = /^([0-9a-f]{64})\s+migrations\/(\S+)$/.exec(linha.trim())
    if (casou) esperado.set(casou[2], casou[1])
  }

  if (esperado.size === 0) {
    aviso('O CHECKSUMS.txt nao tem nenhuma linha de hash reconhecivel.')
    return
  }

  const noDisco = existsSync(pasta)
    ? readdirSync(pasta).filter((nome) => nome.endsWith('.sql'))
    : []

  const divergentes = []
  const sumidas = []

  for (const [nome, hash] of esperado) {
    const bruto = lerBytes(join(pasta, nome))
    if (bruto === null) {
      sumidas.push(nome)
      continue
    }
    // `.gitattributes` fixa `eol=lf`, entao o hash e o mesmo no Windows, no Mac
    // e no Linux, e por isso o arquivo e lido como BYTES, sem normalizar nada:
    // normalizar aqui esconderia justamente um fim de linha que escapou.
    if (createHash('sha256').update(bruto).digest('hex') !== hash) divergentes.push(nome)
  }

  // O outro lado, e o que pega o erro mais provavel: uma migration NOVA que
  // ninguem acrescentou ao manifesto. Ela nao aparece em nenhum laco acima.
  const semLinha = noDisco.filter((nome) => !esperado.has(nome))

  if (divergentes.length === 0 && sumidas.length === 0 && semLinha.length === 0) {
    ok(`As ${esperado.size} migrations conferem com o CHECKSUMS.txt.`)
    return
  }

  if (divergentes.length > 0) {
    falha(`Migration alterada depois de entregue: ${divergentes.join(', ')}`, [
      'Migration ja publicada NUNCA e editada. Os testes aplicam as mesmas',
      'migrations de producao, e um CREATE TABLE IF NOT EXISTS sobre uma',
      'tabela que ja existe com outra forma nao da erro: ele nao faz nada, e o',
      'defeito so aparece depois, como "no such column".',
      'Desfaca a edicao e crie uma migration NOVA com ALTER TABLE.',
    ])
  }

  if (sumidas.length > 0) {
    falha(`Migration listada no CHECKSUMS.txt mas ausente: ${sumidas.join(', ')}`, [
      'Um banco ja publicado aplicou essa migration. Sem o arquivo, um banco',
      'novo nasce com outra forma, e as duas instalacoes divergem em silencio.',
    ])
  }

  if (semLinha.length > 0) {
    falha(`Migration sem linha no CHECKSUMS.txt: ${semLinha.join(', ')}`, [
      'Acrescente o hash ao final de migrations/CHECKSUMS.txt:',
      '  sha256sum migrations/<arquivo>.sql >> migrations/CHECKSUMS.txt',
      'Sem a linha, o arquivo pode ser editado depois sem ninguem perceber.',
    ])
  }
}

// ---------------------------------------------------------------------------
// Checagem 5 - paginas legais preenchidas
// ---------------------------------------------------------------------------

function checagem5() {
  secao('5. Paginas de privacidade e exclusao de dados preenchidas')
  const conteudo = lerTexto(join(RAIZ, 'src', 'routes', 'legal.ts'))
  if (conteudo === null) {
    aviso('Nao encontrei src/routes/legal.ts para conferir.')
    return
  }

  const pendentes = ['[SEU_EMAIL_DE_CONTATO]', '[NOME_DO_RESPONSAVEL]'].filter((marca) =>
    conteudo.includes(marca),
  )

  if (pendentes.length === 0) {
    ok('As paginas legais nao tem mais placeholder de nome nem de e-mail.')
    return
  }

  aviso(`As paginas legais ainda tem: ${pendentes.join(' e ')}`, [
    'Isso nao impede publicar o codigo no GitHub, entao aqui e so um aviso.',
    'Mas a Meta exige a politica de privacidade e a pagina de exclusao de',
    'dados preenchidas para aprovar o app. Sem isso a automacao nao sai do',
    'modo de desenvolvimento. Edite src/routes/legal.ts com o seu nome e um',
    'e-mail de contato que voce realmente leia.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 6 - existe LICENSE
// ---------------------------------------------------------------------------

function checagem6() {
  secao('6. O projeto tem arquivo de licenca')
  const nomes = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
  const achado = nomes.find((nome) => existsSync(join(RAIZ, nome)))
  if (achado) {
    ok(`Encontrei o arquivo ${achado}`)
    return
  }
  falha('Nao existe arquivo LICENSE na raiz do projeto.', [
    'Sem licenca, quem encontrar o repositorio nao tem permissao legal de usar',
    'nem de modificar o codigo, mesmo estando publico.',
    'Crie um arquivo chamado LICENSE com o texto da licenca MIT.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 7 - imagens grandes sem uso
// ---------------------------------------------------------------------------

/** Junta o texto de todos os arquivos varriveis para procurar as referencias. */
function juntarTextos(arquivos) {
  const partes = []
  for (const caminho of arquivos) {
    if (!ehVarrivel(caminho)) continue
    const conteudo = lerTexto(join(RAIZ, caminho))
    if (conteudo !== null) partes.push(conteudo)
  }
  return partes.join('\n')
}

function checagem7(arquivos) {
  secao('7. Imagens grandes que nenhum documento usa')
  const pasta = join(RAIZ, 'images')
  if (!existsSync(pasta)) {
    ok('Nao existe pasta images/ para conferir.')
    return
  }

  const textoDoProjeto = juntarTextos(arquivos)
  const orfas = readdirSync(pasta, { withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => ({ nome: item.name, bytes: statSync(join(pasta, item.name)).size }))
    .filter((item) => item.bytes >= TAMANHO_GRANDE_BYTES)
    .filter((item) => !textoDoProjeto.includes(item.nome))

  if (orfas.length === 0) {
    ok('Nenhuma imagem grande sobrando na pasta images/.')
    return
  }

  const lista = orfas.map((item) => `${item.nome} (${Math.round(item.bytes / 1024)} KB)`)
  aviso(`Imagens grandes que nenhum arquivo cita: ${lista.join(', ')}`, [
    'Elas entram no repositorio e todo mundo que clonar vai baixar esse peso.',
    'Se nao forem usadas, apague. Se forem, cite-as em algum documento.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 8 - todo binding de Env chegou nos tres lugares que o usam
// ---------------------------------------------------------------------------
//
// O erro que esta checagem pega e sempre o mesmo, e ele NAO da erro de
// compilacao: alguem acrescenta um campo em `src/types/env.ts`, usa no codigo,
// e esquece de propagar. Em producao o valor chega `undefined`; nos testes,
// pior, o binding nem existe e o teste passa por outro caminho, provando
// outra coisa.
//
// Os tres destinos nao sao intercambiaveis, e por isso a regra nao e "o nome
// aparece nos tres arquivos":
//   - `wrangler.jsonc`    -> onde o valor nasce em producao (vars, secrets, D1)
//   - `.dev.vars.example` -> so os SEGREDOS, que e o que a pessoa copia
//   - `vitest.config.ts`  -> sem o binding la, o teste roda com outro ambiente
//
// EXCECAO DECLARADA: os tres `PANEL_LIMITER_*`. Eles sao opcionais (`?` em
// `Env`) e a ausencia deles no ambiente de teste NAO e esquecimento, e a
// prova, exigida por 7.4, de que o painel funciona sem a camada de limitacao.

/**
 * As chaves do bloco `"vars"` do wrangler.jsonc.
 *
 * Elas importam porque o `vitest.config.ts` NAO lista var por var: ele escreve
 * `...producao.vars` e deixa todas entrarem de uma vez. Procurar o nome literal
 * naquele arquivo acusaria `META_APP_ID` de nao ter sido propagado justamente
 * quando a propagacao esta certa, e um alarme falso em trava de seguranca
 * custa mais do que a trava vale.
 */
function varsDoWrangler(conteudo) {
  const bloco = /"vars"\s*:\s*\{([\s\S]*?)\n {2}\}/.exec(conteudo)
  if (bloco === null) return new Set()
  return new Set([...bloco[1].matchAll(/"([A-Z][A-Z0-9_]*)"\s*:/g)].map((m) => m[1]))
}

/** Nomes dos campos declarados em `export interface Env { ... }`. */
function camposDoEnv(conteudo) {
  const bloco = /export interface Env \{([\s\S]*?)\n\}/.exec(conteudo)
  if (bloco === null) return []
  const nomes = []
  for (const linha of bloco[1].split('\n')) {
    // So o que esta na coluna do corpo da interface: dois espacos, o nome, um
    // `?` opcional e os dois pontos. Comentario e linha de prosa ficam de fora
    // sozinhos, porque nenhum dos dois casa este formato.
    const casou = /^ {2}([A-Z][A-Za-z0-9_]*)\??\s*:/.exec(linha)
    if (casou) nomes.push(casou[1])
  }
  return nomes
}

function checagem8() {
  secao('8. Todo binding de src/types/env.ts chegou no wrangler, no exemplo e nos testes')

  const env = lerTexto(join(RAIZ, 'src/types/env.ts'))
  const wrangler = lerTexto(join(RAIZ, 'wrangler.jsonc'))
  const exemplo = lerTexto(join(RAIZ, '.dev.vars.example'))
  const vitest = lerTexto(join(RAIZ, 'vitest.config.ts'))

  if (env === null || wrangler === null || vitest === null || exemplo === null) {
    falha('Nao consegui ler os quatro arquivos que esta checagem compara.', [
      'Sao eles: src/types/env.ts, wrangler.jsonc, .dev.vars.example e',
      'vitest.config.ts. Confira se voce esta na pasta certa do projeto.',
    ])
    return
  }

  const campos = camposDoEnv(env)
  if (campos.length === 0) {
    aviso('Nao consegui ler os campos de `interface Env` em src/types/env.ts.')
    return
  }

  const segredos = new Set(segredosExigidos(wrangler))
  const vars = varsDoWrangler(wrangler)

  // `...producao.vars` entrega TODAS as vars do wrangler.jsonc ao ambiente de
  // teste de uma vez. Onde ele aparece, o nome literal da var nao precisa
  // aparecer, e exigi-lo transformaria a propagacao correta em falha.
  const espalhaAsVars = vitest.includes('...producao.vars')

  const pendencias = []

  for (const nome of campos) {
    // A excecao declarada, e a unica: ver o comentario do bloco acima.
    if (nome.startsWith('PANEL_LIMITER_')) continue

    if (!wrangler.includes(nome)) pendencias.push(`${nome} nao aparece em wrangler.jsonc`)

    const chegaPeloEspalhamento = espalhaAsVars && vars.has(nome)
    if (!chegaPeloEspalhamento && !vitest.includes(nome)) {
      pendencias.push(`${nome} nao aparece em vitest.config.ts`)
    }

    // O `.dev.vars.example` e o arquivo dos SEGREDOS. Exigir `DB` ou
    // `META_APP_ID` la seria pedir que ele deixe de ser o que a pessoa copia
    // para `.dev.vars`, e um campo a mais nesse arquivo e um campo a mais que
    // alguem preenche com um valor que nao vai a lugar nenhum.
    if (segredos.has(nome) && !exemplo.includes(nome)) {
      pendencias.push(`${nome} e segredo exigido e nao aparece em .dev.vars.example`)
    }
  }

  if (pendencias.length === 0) {
    ok(`Os ${campos.length} campos de Env estao propagados (menos os tres limitadores, por regra).`)
    return
  }

  falha('Um binding de Env nao foi propagado.', [
    ...pendencias,
    '',
    'Nada disso quebra a compilacao: o campo existe no tipo, o codigo usa, e o',
    'valor chega `undefined` em producao. Nos testes e pior, o binding nem',
    'existe e o teste passa por outro caminho.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 9 - o painel consegue mesmo trocar o link
// ---------------------------------------------------------------------------
//
// `ALLOWED_LINK_DOMAINS` vazia NAO e um defeito do repositorio: ela nasce
// vazia de proposito, e vazia significa "o painel nao altera link nem texto do
// Direct, e a entrega segue com o link que ja esta valendo". E o padrao seguro.
//
// O que esta checagem afirma e outra coisa: quem esta prestes a publicar o
// PROPRIO Worker com a lista vazia vai abrir o painel, digitar o link novo,
// salvar, e o painel vai recusar. Sem esta linha vermelha a pessoa descobre
// isso no meio de uma troca de link, achando que o painel quebrou.

/** Dominios que so existem em exemplo de documentacao. */
const DOMINIOS_DE_EXEMPLO = ['exemplo.com', 'exemplo.com.br', 'example.com', 'meusite.com.br']

function checagem9() {
  secao('9. A lista de dominios permitidos deixa o painel trocar o link')

  const conteudo = lerTexto(join(RAIZ, 'wrangler.jsonc'))
  if (conteudo === null) return

  const valor = (valorNoJsonc(conteudo, 'ALLOWED_LINK_DOMAINS') ?? '').trim()

  if (valor === '') {
    falha('ALLOWED_LINK_DOMAINS esta vazia no wrangler.jsonc.', [
      'Vazia e o padrao seguro do repositorio, e por isso ela nasce assim.',
      'Mas com a lista vazia o painel NAO consegue trocar o link do Direct nem',
      'o texto: ele recusa a gravacao e a entrega segue com o link antigo.',
      'Antes de publicar o SEU Worker, escreva aqui o seu dominio, em',
      'minusculas e sem "https://". Exemplo: "meusite.com.br,www.meusite.com.br".',
      'Um item que comeca com ponto (".meusite.com.br") libera os subdominios.',
    ])
    return
  }

  const itens = valor.split(',').map((item) => item.trim().toLowerCase())
  const deExemplo = itens.filter((item) => DOMINIOS_DE_EXEMPLO.includes(item.replace(/^\./, '')))

  if (deExemplo.length > 0) {
    falha(`ALLOWED_LINK_DOMAINS ainda tem dominio de exemplo: ${deExemplo.join(', ')}`, [
      'Esse dominio veio da documentacao e nao e seu. Se ele ficar, o painel',
      'aceita apontar o link do Direct para um site que nao e o seu.',
      'Troque pelo dominio real para onde voce quer mandar as pessoas.',
    ])
    return
  }

  ok(`ALLOWED_LINK_DOMAINS tem ${itens.length} dominio(s) proprio(s).`)
}

// ---------------------------------------------------------------------------
// Checagem 10 - o PANEL_RP_ID e um host, e nao uma URL
// ---------------------------------------------------------------------------
//
// O `PANEL_RP_ID` e o `rpId` do WebAuthn E a base da origem esperada. Tres
// erros o matam, e nenhum deles produz mensagem compreensivel no navegador:
//   1. vazio                -> painel em 503 (padrao seguro, nao publicavel)
//   2. `workers.dev` puro   -> e um eTLD na Public Suffix List; o navegador recusa
//   3. com esquema ou barra -> `https://x.dev/` nao e um host
//
// E o erro caro nao e o 503: e cadastrar uma passkey com `rpId` errado.
// Credencial criada assim e IRRECUPERAVEL, nao ha login que a leia depois.

function checagem10() {
  secao('10. O PANEL_RP_ID e um host valido para o WebAuthn')

  const conteudo = lerTexto(join(RAIZ, 'wrangler.jsonc'))
  if (conteudo === null) return

  const valor = (valorNoJsonc(conteudo, 'PANEL_RP_ID') ?? '').trim()

  if (valor === '') {
    falha('PANEL_RP_ID esta vazio no wrangler.jsonc.', [
      'Vazio e o padrao seguro do repositorio: o painel responde 503 e nao',
      'existe. Mas o SEU Worker nao sobe assim com painel.',
      'Escreva o host exato que aparece na barra de endereco do navegador,',
      'sem "https://" e sem barra no fim. Exemplo:',
      '  meu-worker.minha-conta.workers.dev',
    ])
    return
  }

  if (/^[a-z]+:\/\//i.test(valor) || valor.includes('/')) {
    falha(`PANEL_RP_ID tem esquema ou barra: "${valor}"`, [
      'Ele e um HOST, nao uma URL. Tire o "https://" e a barra do fim.',
      'Com esquema ou barra o navegador recusa o cadastro da passkey, e a',
      'mensagem que ele mostra nao diz que o problema esta aqui.',
    ])
    return
  }

  if (valor.toLowerCase() === 'workers.dev') {
    falha('PANEL_RP_ID esta como "workers.dev" puro.', [
      '"workers.dev" esta na secao de dominios privados da Public Suffix List,',
      'ou seja, e um eTLD, e o navegador RECUSA um rpId assim.',
      'Use o host COMPLETO do seu Worker, com o subdominio da sua conta:',
      '  meu-worker.minha-conta.workers.dev',
      'Nunca use so "<conta>.workers.dev": isso faria qualquer outro Worker seu',
      'compartilhar as passkeys deste painel.',
    ])
    return
  }

  ok(`PANEL_RP_ID esta preenchido com um host: "${valor}".`)
}

// ---------------------------------------------------------------------------
// Checagem 12 - a chave do painel nao repete nenhum outro segredo
// ---------------------------------------------------------------------------
//
// O numero 11 NAO EXISTE, de proposito: a checagem 11 foi apagada quando o
// `PANEL_ORIGIN` deixou de existir, e renumerar faria "checagem 13", "15" e
// "18" significarem coisas diferentes em partes diferentes do projeto.
//
// Por que reutilizar e grave, sendo os tres segredos igualmente aleatorios:
// eles tem CICLOS DE VIDA diferentes. Rotacionar o `SETUP_ADMIN_TOKEN` e
// rotina; se ele for tambem a chave de sessao, cada rotacao derruba todos os
// aparelhos e invalida os codigos de recuperacao, no exato momento em que a
// pessoa mais precisa entrar. E um convite vazado, que e assinado com o admin
// token, passaria a entregar tambem a chave das sessoes.

function checagem12() {
  secao('12. A PANEL_SESSION_KEY nao repete o admin token nem a chave de cifra')

  const caminho = join(RAIZ, '.dev.vars')
  if (!existsSync(caminho)) {
    // Sem `.dev.vars` nao ha o que comparar, e isso e o normal em quem acabou
    // de clonar. Nao e falha: e ausencia de material.
    ok('Nao existe .dev.vars nesta pasta; nada a comparar.')
    return
  }

  const conteudo = lerTexto(caminho)
  if (conteudo === null) return

  const valores = new Map()
  for (const linha of conteudo.split('\n')) {
    const casou = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(linha)
    if (casou === null) continue
    // Aspas em volta do valor sao aceitas pelo wrangler; tirar aqui evita
    // dizer que dois valores diferem quando so as aspas diferem.
    valores.set(casou[1], casou[2].trim().replace(/^["']|["']$/g, ''))
  }

  const chave = valores.get('PANEL_SESSION_KEY') ?? ''
  if (chave === '') {
    aviso('PANEL_SESSION_KEY esta vazia ou ausente no .dev.vars.', [
      'Sem ela o painel inteiro responde 503 no `npm run dev`.',
      'Gere uma com: npm run gerar:segredos',
    ])
    return
  }

  const repetidos = ['TOKEN_ENCRYPTION_KEY', 'SETUP_ADMIN_TOKEN'].filter(
    (nome) => valores.get(nome) === chave,
  )

  if (repetidos.length > 0) {
    falha(`No .dev.vars a PANEL_SESSION_KEY repete: ${repetidos.join(', ')}`, [
      'Os tres sao aleatorios, mas tem ciclos de vida diferentes.',
      'Rotacionar o admin token e rotina; se ele for tambem a chave de sessao,',
      'cada rotacao derruba TODOS os aparelhos e invalida os codigos de',
      'recuperacao, bem na hora em que voce mais precisa entrar.',
      'Gere valores separados com: npm run gerar:segredos',
    ])
    return
  }

  ok('A PANEL_SESSION_KEY do .dev.vars e diferente dos outros dois segredos.')
}

// ---------------------------------------------------------------------------
// Checagem 13 - os arquivos de public/ nao carregam script embutido
// ---------------------------------------------------------------------------
//
// Esta checagem cobre SO `public/`. A proibicao de `onclick=` e `javascript:`
// no HTML GERADO pelo Worker e teste (familia HDR), nao grep, e essa e uma
// das consequencias praticas de o HTML nascer dentro do Worker.
//
// `public/` e diferente porque esses arquivos sao servidos pela plataforma,
// FORA do Worker: nenhum cabecalho que o codigo aplica passa por eles, e a
// pagina da parada de emergencia precisa abrir mesmo com a cota estourada.
// Um `<script>` ali e codigo que roda sem nenhuma das travas do resto.

/** Os tres assets de `public/`. O `_headers` e diretiva de plataforma. */
const ASSETS_DO_PAINEL = [
  'public/painel/painel.css',
  'public/painel/painel.js',
  'public/painel/parar/index.html',
]

function checagem13() {
  secao('13. Os tres arquivos de public/ nao tem script embutido')

  const achados = []
  for (const caminho of ASSETS_DO_PAINEL) {
    const conteudo = lerTexto(join(RAIZ, ...caminho.split('/')))
    if (conteudo === null) {
      falha(`Nao encontrei ${caminho}.`, [
        'Os tres arquivos de public/ sao servidos pela plataforma e sao a unica',
        'parte do painel que abre mesmo com a cota do Worker estourada.',
      ])
      continue
    }
    // `painel.js` e um arquivo de script, e por isso a busca e por `<script`,
    // por manipulador em atributo e por `javascript:`, nunca por "tem codigo
    // dentro". O que se proibe e script EMBUTIDO em marcacao.
    if (/<script\b/i.test(conteudo)) achados.push(`${caminho}: tem <script> embutido`)
    if (/\son[a-z]+\s*=\s*["']/i.test(conteudo)) {
      achados.push(`${caminho}: tem manipulador em atributo (onclick= e parentes)`)
    }
    if (/javascript:/i.test(conteudo)) achados.push(`${caminho}: tem "javascript:"`)
  }

  if (achados.length === 0) {
    ok('Os tres arquivos de public/ estao sem script embutido.')
    return
  }

  falha('Um arquivo de public/ carrega script embutido.', [
    ...achados,
    '',
    'Esses arquivos sao servidos FORA do Worker: nenhum cabecalho que o codigo',
    'aplica passa por eles. Ponha o comportamento no painel.js, que e carregado',
    'como arquivo separado e cabe na CSP.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 14 - a varredura de segredos alcanca public/ e o handler dos codigos
// ---------------------------------------------------------------------------
//
// Esta e uma checagem SOBRE outra checagem, e existe porque a checagem 3 varre
// "os arquivos rastreados pelo git", uma lista que muda sozinha quando alguem
// mexe no `.gitignore` ou acrescenta uma pasta a PASTAS_IGNORADAS. No dia em
// que `public/` sair dessa lista, a checagem 3 continua VERDE e passa a nao
// olhar mais o que precisa olhar. Verde por nao ter olhado e o pior estado
// possivel de uma trava de seguranca.
//
// O handler de `/setup/painel/codigos` entra pelo motivo de 10.11: o corpo da
// resposta dele leva os codigos em texto claro, uma unica vez, e um
// `console.log` esquecido ali vaza os seis codigos de recuperacao para os
// Workers Logs.

function checagem14() {
  secao('14. A varredura de segredos alcanca public/ e o handler dos codigos')

  const varridos = new Set(listarArquivos(temPastaGit()))

  const obrigatorios = [...ASSETS_DO_PAINEL, 'public/_headers']
  const ausentes = obrigatorios.filter((caminho) => !varridos.has(caminho))

  // O handler dos codigos nao tem caminho fixo garantido: procuramos quem
  // declara a rota, para a checagem nao morrer se o arquivo for renomeado.
  const donosDaRota = [...varridos].filter((caminho) => {
    if (!caminho.startsWith('src/')) return false
    const conteudo = lerTexto(join(RAIZ, ...caminho.split('/')))
    return conteudo !== null && conteudo.includes('/setup/painel/codigos')
  })

  const problemas = []
  if (ausentes.length > 0) problemas.push(`Fora da varredura: ${ausentes.join(', ')}`)
  if (donosDaRota.length === 0) {
    problemas.push('Nenhum arquivo varrido menciona /setup/painel/codigos')
  }

  if (problemas.length === 0) {
    ok(`public/ e o handler dos codigos estao dentro da varredura (${donosDaRota.length} arquivo(s)).`)
    return
  }

  falha('A varredura de segredos nao cobre tudo que precisa cobrir.', [
    ...problemas,
    '',
    'A checagem 3 varre a lista de arquivos rastreados pelo git. Quando um',
    'caminho sai dessa lista, por .gitignore ou por PASTAS_IGNORADAS, ela',
    'continua VERDE e simplesmente deixa de olhar. O corpo da resposta de',
    '/setup/painel/codigos leva os codigos de recuperacao em texto claro.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 15 - vive acima, junto das outras checagens de manifesto
// ---------------------------------------------------------------------------
//
// Ela nasceu como "4c" porque e prima da 4 e da 4b, as tres leem manifestos e
// perguntam "o arquivo continua sendo o que foi entregue?". So que 13.5 reserva
// o NUMERO 15 para ela, e o numero e o que as pessoas citam em revisao. Ficou
// com o numero da spec e com a vizinhanca que ajuda a ler: a funcao se chama
// `checagem15` e mora logo depois da 4b, e a ordem de SAIDA vem de
// `principal()`, onde ela e chamada entre a 14 e a 16.

// ---------------------------------------------------------------------------
// Checagem 16 - o manifesto do assistente nao diz mais que painel e perigoso
// ---------------------------------------------------------------------------
//
// AVISO, e nao falha: um texto desatualizado nao quebra ninguem hoje. Mas o
// cabecalho do `configurar.mjs` explicava por que este projeto NAO tinha
// painel, e o projeto passou a ter um. Quem abre o assistente e le que um
// painel na internet "viraria uma maquina de golpe" e depois encontra o painel
// no menu conclui, com razao, que alguem fez o que o proprio codigo desaconselha.
//
// O texto novo nao apaga o argumento: ele diz por que ESTE painel e diferente
// (passkey obrigatoria, step-up preso ao conteudo, allowlist que so o deploy
// muda, parada de emergencia sem sessao).

/** Marcas do manifesto antigo, aquele que existia para negar o painel. */
const MARCAS_ANTI_PAINEL = [
  'POR QUE UM ASSISTENTE LOCAL E NAO UM PAINEL',
  'maquina de golpe',
]

function checagem16() {
  secao('16. O manifesto do configurar.mjs fala do painel que existe hoje')

  const conteudo = lerTexto(join(RAIZ, 'scripts/configurar.mjs'))
  if (conteudo === null) return

  // So o cabecalho: o argumento pode aparecer legitimamente mais para baixo,
  // dentro da explicacao de por que o painel e seguro.
  const cabecalho = conteudo.split('\n').slice(0, 30).join('\n')
  const encontradas = MARCAS_ANTI_PAINEL.filter((marca) => cabecalho.includes(marca))

  if (encontradas.length === 0) {
    ok('O cabecalho do configurar.mjs nao tem mais o texto anti-painel.')
    return
  }

  aviso(`O cabecalho do configurar.mjs ainda diz que painel e perigoso: ${encontradas.join('; ')}`, [
    'Esse texto foi escrito quando o projeto NAO tinha painel. Ele tem painel.',
    'Quem le isso e depois encontra o painel no menu conclui que alguem fez o',
    'que o proprio codigo desaconselha.',
    'Reescreva para "por que o painel e seguro": passkey obrigatoria, step-up',
    'preso ao conteudo, allowlist que so o deploy muda, e a parada de',
    'emergencia que funciona sem sessao.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 17 - a documentacao acompanhou a ultima mudanca do painel
// ---------------------------------------------------------------------------
//
// AVISO, e nao falha: nem toda mudanca em `src/routes/painel/` muda o que a
// documentacao promete, e transformar isso em falha treinaria a pessoa a
// tocar num arquivo so para calar o script, que e o oposto do objetivo.
//
// O sinal e barato e util: se o painel mudou depois da ultima vez que alguem
// mexeu nos cinco documentos, provavelmente ha uma frase la que envelheceu.

/** Os documentos que a etapa 15 obriga a revisar. */
const DOCUMENTOS_DO_PAINEL = [
  'README.md',
  'readmeiniciante.md',
  'SECURITY.md',
  'SETUP_CLOUDFLARE.md',
  'SETUP_META.md',
]

/** Instante do ultimo commit que tocou o caminho. `null` se nunca. */
function ultimoCommitEm(caminho) {
  const resultado = rodarGit(['log', '-1', '--format=%ct', '--', caminho])
  if (resultado === null || resultado.status !== 0) return null
  const bruto = resultado.stdout.trim()
  return bruto === '' ? null : Number(bruto)
}

function checagem17() {
  secao('17. A documentacao acompanhou a ultima mudanca do painel')

  if (!temPastaGit()) {
    ok('Sem pasta .git para comparar datas; nada a conferir.')
    return
  }

  const doPainel = ultimoCommitEm('src/routes/painel')
  if (doPainel === null) {
    ok('Ainda nao ha commit tocando src/routes/painel/.')
    return
  }

  const atrasados = []
  for (const documento of DOCUMENTOS_DO_PAINEL) {
    const quando = ultimoCommitEm(documento)
    if (quando === null || quando < doPainel) atrasados.push(documento)
  }

  if (atrasados.length === 0) {
    ok(`Os ${DOCUMENTOS_DO_PAINEL.length} documentos foram tocados depois da ultima mudanca do painel.`)
    return
  }

  aviso(`Documento mais antigo que a ultima mudanca do painel: ${atrasados.join(', ')}`, [
    'Nem toda mudanca no painel muda o que a documentacao promete, por isso',
    'isto e aviso e nao falha. Mas vale reler esses arquivos procurando frase',
    'que envelheceu: nome de tela, nome de campo, ou passo que mudou de ordem.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 18 - nenhuma tabela nasce em mais de uma migration
// ---------------------------------------------------------------------------
//
// O modo de falha e silencioso, e e o mesmo que o CHECKSUMS.txt existe para
// impedir pelo outro lado: `CREATE TABLE IF NOT EXISTS` sobre uma tabela que
// ja existe COM OUTRA FORMA nao da erro, ele nao faz nada. Duas migrations
// criando `painel_config` significa que, num banco que aplicou as duas, vale a
// forma da PRIMEIRA, e o defeito aparece semanas depois como `no such column`.
//
// Num banco novo, que aplica as duas na ordem, o resultado e o mesmo. Ou seja:
// o erro nao aparece em teste nenhum, porque teste roda em banco novo.

/** Tira comentario de SQL, para nao achar CREATE TABLE dentro de prosa. */
function semComentarioSql(conteudo) {
  return conteudo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

function checagem18() {
  secao('18. Nenhuma tabela e criada em mais de uma migration')

  const pasta = join(RAIZ, 'migrations')
  if (!existsSync(pasta)) {
    aviso('Nao encontrei a pasta migrations/.')
    return
  }

  const arquivos = readdirSync(pasta)
    .filter((nome) => nome.endsWith('.sql'))
    .sort()

  /** nome da tabela -> arquivos que a criam */
  const donos = new Map()

  for (const nome of arquivos) {
    const conteudo = lerTexto(join(pasta, nome))
    if (conteudo === null) continue
    const limpo = semComentarioSql(conteudo)
    for (const casou of limpo.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      const tabela = casou[1]
      if (!donos.has(tabela)) donos.set(tabela, [])
      if (!donos.get(tabela).includes(nome)) donos.get(tabela).push(nome)
    }
  }

  const repetidas = [...donos.entries()].filter(([, arquivosDaTabela]) => arquivosDaTabela.length > 1)

  if (repetidas.length === 0) {
    ok(`As ${donos.size} tabelas nascem cada uma em uma migration so.`)
    return
  }

  falha('Uma tabela e criada em mais de uma migration.', [
    ...repetidas.map(([tabela, onde]) => `${tabela}: ${onde.join(', ')}`),
    '',
    'CREATE TABLE IF NOT EXISTS sobre uma tabela que ja existe com OUTRA forma',
    'nao da erro: ele nao faz nada. Num banco que aplicou as duas migrations,',
    'vale a forma da primeira, e o defeito aparece semanas depois como',
    '"no such column". Em banco novo o resultado e o mesmo, entao nenhum teste',
    'pega isso: teste sempre roda em banco novo.',
    'Para mudar uma tabela ja entregue, use ALTER TABLE numa migration nova.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 19 - o `cru(` so aparece onde foi autorizado
// ---------------------------------------------------------------------------
//
// `cru()` e a valvula de escape da tag `html``: ela marca uma string como HTML
// seguro e PULA o escape. Cada uso e um lugar onde um valor vindo do banco
// poderia virar marcacao, ou seja, cada uso e um XSS em potencial, e a lista
// autorizada existe para que acrescentar um seja uma decisao consciente e
// visivel na revisao, nunca um detalhe que passa no diff.
//
// POR QUE AQUI, E NAO NUM TESTE: a garantia e sobre ARQUIVOS, e de dentro do
// workerd nao existe sistema de arquivos. Sob `vitest-pool-workers` o `?raw`
// devolve string vazia, e um teste escrito assim passaria sempre, inclusive
// com dez `cru(` novos espalhados. E o mesmo motivo que poe a checagem 20 aqui:
// uma garantia que pode nascer quebrada por detalhe de bundler ensina a equipe
// a ignora-la.

/**
 * Onde `cru(` pode aparecer.
 *
 * `html.ts` e a casa da funcao: e la que ela e declarada e usada para montar o
 * documento. Acrescentar um caminho a esta lista e decisao de revisao, e a
 * pergunta a responder e sempre a mesma: o que entra nesse `cru()` pode, algum
 * dia, conter texto que veio do banco ou da Meta?
 */
const AUTORIZADOS_A_USAR_CRU = ['src/routes/painel/html.ts']

/**
 * Tira comentario de TypeScript, para a busca ver so codigo.
 *
 * Sem isto o script acusava `src/routes/painel/recusa.ts`, que nao usa a
 * funcao: o comentario de la diz "nunca o id cru (9.9)", a palavra "cru" em
 * portugues, seguida de um parenteses de prosa. Uma trava que grita no arquivo
 * errado e uma trava que a proxima pessoa aprende a ignorar.
 *
 * A string entre aspas fica: um `cru(` escondido dentro de string ainda seria
 * codigo suspeito, e nao ha razao para dar a ele um esconderijo.
 */
function semComentarioTs(conteudo) {
  return conteudo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

function checagem19() {
  secao('19. O `cru(` so aparece nos arquivos autorizados')

  const pasta = join(RAIZ, 'src')
  if (!existsSync(pasta)) {
    aviso('Nao encontrei a pasta src/.')
    return
  }

  const intrusos = []
  for (const caminho of varrerPasta(pasta, [])) {
    if (!caminho.endsWith('.ts')) continue
    if (AUTORIZADOS_A_USAR_CRU.includes(caminho)) continue
    const conteudo = lerTexto(join(RAIZ, ...caminho.split('/')))
    if (conteudo === null) continue
    // Duas bordas, e as duas custaram um alarme falso:
    //   - a esquerda, para um identificador terminado em "cru" (`recru(`) nao contar;
    //   - a direita, SEM `\s*`, porque "cru (9.9)" em portugues nao e chamada.
    if (/(^|[^A-Za-z0-9_$.])cru\(/m.test(semComentarioTs(conteudo))) intrusos.push(caminho)
  }

  if (intrusos.length === 0) {
    ok(`O \`cru(\` so aparece nos ${AUTORIZADOS_A_USAR_CRU.length} arquivo(s) autorizado(s).`)
    return
  }

  falha('Um arquivo nao autorizado usa `cru(`.', [
    ...intrusos,
    '',
    '`cru()` marca uma string como HTML seguro e PULA o escape. Cada uso e um',
    'lugar onde um valor vindo do banco ou da Meta pode virar marcacao.',
    'Se o uso for mesmo necessario, acrescente o caminho a lista',
    'AUTORIZADOS_A_USAR_CRU deste script, de proposito, para que a decisao',
    'apareca na revisao em vez de passar escondida no diff.',
  ])
}

// ---------------------------------------------------------------------------
// Checagem 20 - o painel.css nao cresce sozinho nem busca nada de fora
// ---------------------------------------------------------------------------
//
// **Por que aqui, e nao num teste.** A garantia e sobre um ARQUIVO, e de dentro
// do workerd nao existe sistema de arquivos: sob `vitest-pool-workers` o
// `?raw` de um `.css` devolve string VAZIA, conferido no `import` direto e no
// `import.meta.glob`. Um teste escrito assim passa sempre, inclusive com a
// folha dobrando de tamanho e com um `@import` de outro host dentro. E a mesma
// razao que §13.5 escreve para a checagem 19 morar aqui: "uma garantia que pode
// nascer quebrada por detalhe de bundler ensina a equipe a ignora-la".
//
// **O numero 20 vem depois do bloco 8..19 que §13.5 reserva**, de proposito:
// renumerar faria "checagem 13" e "checagem 19" significarem coisas diferentes
// em partes diferentes do projeto.

/**
 * O teto do `painel.css`, em bytes. §12.9 orca "~6 KB"; ver o texto abaixo.
 *
 * Subiu de 9 para 12 KB com a arquitetura de informacao do painel: a tela
 * Mais, os passos numerados do Inicio, o Salvar fixo e as caixas esmaecidas dos
 * Reels (feitas em CSS para nao depender de JavaScript) e os botoes de sair
 * lado a lado. Comprimida, a folha continua abaixo de 4 KB.
 */
const TETO_DO_CSS_DO_PAINEL = 12 * 1024

/** Fonte, imagem ou folha buscada de outro host. */
const BUSCA_EXTERNA = /@import|url\(\s*["']?(https?:)?\/\//

function checagem20() {
  secao('20. O painel.css cabe no orcamento e nao busca nada de fora')
  const caminho = join(RAIZ, 'public/painel/painel.css')
  const conteudo = lerTexto(caminho)

  if (conteudo === null) {
    falha('Nao consegui ler public/painel/painel.css.', [
      'Ele e a folha de estilo do painel e precisa existir: a CSP nao permite',
      '<style> inline, entao sem este arquivo o painel abre sem estilo nenhum.',
    ])
    return
  }

  const bytes = Buffer.byteLength(conteudo, 'utf8')
  if (bytes > TETO_DO_CSS_DO_PAINEL) {
    falha(`public/painel/painel.css esta com ${Math.round(bytes / 1024)} KB.`, [
      `O teto deste projeto e ${TETO_DO_CSS_DO_PAINEL / 1024} KB.`,
      'A secao 12.9 do desenho orca "~6 KB" pensando em conexao ruim; o arquivo',
      'passa disso porque quase todo o excedente e comentario explicando por que',
      'cada trava existe (area segura, alvo de 44px, foco de 2px, estado que',
      'nunca e so cor), e neste projeto o comentario e o motivo de a trava',
      'sobreviver a proxima etapa. O arquivo nao passa por build, entao o',
      'comentario viaja junto; ele viaja comprimido.',
      'Se voce chegou aqui, a folha cresceu ALEM disso. Confira se o bloco novo',
      'e mesmo necessario antes de subir o teto.',
    ])
  } else {
    ok(`public/painel/painel.css tem ${Math.round(bytes / 1024)} KB, dentro do teto.`)
  }

  if (BUSCA_EXTERNA.test(conteudo)) {
    falha('public/painel/painel.css busca alguma coisa de outro endereco.', [
      'A secao 12.9 pede "sem fonte externa, sem imagem alem das miniaturas":',
      'num celular com conexao ruim cada pedido a mais e uma tela em branco a',
      'mais. E a CSP do painel nao libera outro host, entao o pedido falharia',
      'em silencio em producao, a folha carregaria sem a fonte.',
      'Use as fontes do proprio sistema, como o resto do arquivo ja faz.',
    ])
  } else {
    ok('Nenhuma fonte, imagem ou folha buscada de fora.')
  }
}

// ---------------------------------------------------------------------------
// Execucao
// ---------------------------------------------------------------------------

function imprimirResumo() {
  console.log(`\n${'='.repeat(64)}`)
  console.log('RESUMO')
  console.log(`  Checagens que passaram: ${relatorio.passou}`)
  console.log(`  Checagens que falharam: ${relatorio.falhou}`)
  console.log(`  Avisos ...............: ${relatorio.avisos}`)
  console.log('='.repeat(64))

  if (relatorio.falhou > 0) {
    console.log('\nAINDA NAO PUBLIQUE. Resolva cada item marcado com [FALHA] acima')
    console.log('e rode esta verificacao de novo.')
  } else if (relatorio.avisos > 0) {
    console.log('\nNenhuma falha. Os itens marcados com [atencao] nao impedem publicar,')
    console.log('mas vale ler cada um antes de seguir.')
  } else {
    console.log('\nTudo certo por aqui.')
  }

  console.log('\nEste script e uma ajuda, nao uma garantia. Ele nao substitui olhar')
  console.log('com calma o que voce esta prestes a enviar. Antes do commit, rode:')
  console.log('  git status')
  console.log('  git diff --cached')
  console.log('e confira arquivo por arquivo se e mesmo aquilo que voce quer publicar.')
}

function principal() {
  console.log('Verificacao antes de publicar o repositorio no GitHub')
  console.log(`Pasta analisada: ${RAIZ}`)

  const temGit = temPastaGit()
  const arquivos = listarArquivos(temGit)

  checagem1(temGit)
  checagem2(temGit)
  checagem3(arquivos)
  checagem4()
  checagem4b()
  checagem5()
  checagem6()
  checagem7(arquivos)

  // O bloco 8..19 que 13.5 reserva. O 11 nao existe: ele foi apagado quando o
  // `PANEL_ORIGIN` deixou de existir, e renumerar faria "checagem 13", "15" e
  // "18" significarem coisas diferentes em partes diferentes do projeto.
  checagem8()
  checagem9()
  checagem10()
  checagem12()
  checagem13()
  checagem14()
  checagem15()
  checagem16()
  checagem17()
  checagem18()
  checagem19()

  checagem20()

  imprimirResumo()
  process.exit(relatorio.falhou > 0 ? 1 : 0)
}

principal()
