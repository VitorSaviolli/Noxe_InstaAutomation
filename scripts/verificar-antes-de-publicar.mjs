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

function temPastaGit() {
  return existsSync(join(RAIZ, '.git'))
}

/** Roda um comando git na raiz. Devolve null se o git nem estiver instalado. */
function rodarGit(argumentos) {
  const resultado = spawnSync('git', argumentos, { cwd: RAIZ, encoding: 'utf8' })
  if (resultado.error) return null
  return resultado
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
 * Os trechos ficam quebrados em pedacos de proposito.
 *
 * Se as palavras estivessem inteiras aqui, este proprio script apareceria na
 * varredura como se fosse um vazamento.
 */
const IDENTIDADE = [
  { rotulo: 'usuario pessoal do autor original (workers.dev)', pedacos: ['vitors', 'gonsalez'] },
  // So o handle COMPLETO conta como vazamento. O nome "Noxelora" sozinho e a
  // empresa que assina o projeto e aparece de proposito nos creditos; barrar
  // ele aqui daria falso positivo em LICENSE, README e package.json.
  { rotulo: 'handle pessoal de Instagram do autor original', pedacos: ['noxe', 'lora.official'] },
  { rotulo: 'inicio do ID do banco D1 do autor original', pedacos: ['8fc2', '8619'] },
  { rotulo: 'META_APP_ID do app do autor original', pedacos: ['46839990', '81820430'] },
  { rotulo: 'e-mail pessoal do autor original', pedacos: ['vitors', 'gonsalez@gmail', '.com'] },
]

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
 * como vazamento em toda execucao — e um alarme que toca sempre acaba sendo
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
      achados.push({
        caminho,
        numeroDaLinha: indice + 1,
        rotulo: regra.rotulo,
        trecho: encurtar(encontrado[1]),
      })
    })
  }
}

function procurarIdentidadeNoTexto(caminho, linhas, achados) {
  for (const item of IDENTIDADE) {
    const agulha = item.pedacos.join('').toLowerCase()
    linhas.forEach((linha, indice) => {
      if (!linha.toLowerCase().includes(agulha)) return
      achados.push({
        caminho,
        numeroDaLinha: indice + 1,
        rotulo: item.rotulo,
        trecho: 'trocar pelo placeholder do README',
      })
    })
  }
}

function checagem3(arquivos) {
  secao('3. Nenhum segredo ou dado pessoal dentro dos arquivos')
  const achados = []

  for (const caminho of arquivos) {
    if (!ehVarrivel(caminho)) continue
    const conteudo = lerTexto(join(RAIZ, caminho))
    if (conteudo === null) continue
    const linhas = conteudo.split('\n')
    procurarSegredosNoTexto(caminho, linhas, achados)
    procurarIdentidadeNoTexto(caminho, linhas, achados)
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
  const conteudo = lerTexto(join(RAIZ, 'wrangler.jsonc'))
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
  checagem5()
  checagem6()
  checagem7(arquivos)

  imprimirResumo()
  process.exit(relatorio.falhou > 0 ? 1 : 0)
}

principal()
