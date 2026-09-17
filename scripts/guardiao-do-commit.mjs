#!/usr/bin/env node
/**
 * Trava que roda A CADA COMMIT, sobre o que esta no indice do git.
 *
 * Uso:  node scripts/guardiao-do-commit.mjs
 *       (chamado automaticamente por .githooks/pre-commit)
 *
 * Por que existe, se ja existe o `npm run verificar`: aquele script varre a
 * PASTA e roda quando voce lembra de rodar. Este varre o INDICE e roda sozinho.
 * A diferenca importa no unico caso que interessa: o arquivo que voce editou
 * com os seus dados reais para poder fazer deploy, e que nao pode ir junto no
 * `git add -A`. O `wrangler.jsonc` e exatamente esse arquivo, e o repositorio
 * precisa dele com placeholders enquanto a sua maquina precisa dele preenchido.
 *
 * Ler o INDICE e nao a pasta nao e detalhe: `git add` tira uma fotografia do
 * arquivo naquele instante, e o que sera publicado e a fotografia, nao o que
 * esta em disco agora.
 *
 * Termina com codigo 1 e o commit e recusado se achar qualquer coisa.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Raiz do projeto: o hook roda com o diretorio do git, nao o do script. */
const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/** Arquivos locais que guardam o que NUNCA pode ser publicado. */
const FONTES_DE_SEGREDO = ['.env', '.dev.vars']
const ARQUIVO_IDENTIDADE = '.identidade-local.txt'

/**
 * Arquivos autorizados a conter dado pessoal do autor.
 *
 * `legal.ts` monta a pagina de privacidade e a de exclusao de dados, e a Meta
 * exige um contato de verdade nas duas. Esconder o e-mail ali nao protegeria
 * nada: a pagina e publica por obrigacao legal, e o mesmo endereco ja aparece
 * no autor de todo commit. Marcar a excecao aqui, e por escrito, e melhor do
 * que um alarme que toca sempre e por isso acaba ignorado.
 */
const PODEM_TER_DADO_PESSOAL = new Set(['src/routes/legal.ts'])

/**
 * Campos do `wrangler.jsonc` que o repositorio publica vazios ou com
 * placeholder, e que a sua maquina preenche para o deploy funcionar.
 *
 * O `PANEL_RP_ID` e o mais serio dos tres: e o endereco do painel
 * administrativo. Esconder o endereco nao e a defesa, a passkey e, mas a cota
 * de 100.000 requisicoes por dia e o maior risco residual do projeto, e
 * publicar o alvo entrega de graca o que falta para queima-la.
 */
const CAMPOS_DO_WRANGLER = ['database_id', 'META_APP_ID', 'PANEL_RP_ID']

/** Um valor e placeholder quando esta vazio ou comeca com COLE_AQUI. */
function ehPlaceholder(valor) {
  return valor.length === 0 || valor.startsWith('COLE_AQUI')
}

/** Le um arquivo de texto, ou devolve null se ele nao existe. */
function lerTexto(caminho) {
  if (!existsSync(caminho)) return null
  try {
    return readFileSync(caminho, 'utf8')
  } catch {
    return null
  }
}

/** Roda um comando git e devolve a saida, ou null se ele falhou. */
function git(...args) {
  const r = spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return null
  return r.stdout
}

/**
 * Distingue um segredo de verdade de um valor curto de configuracao.
 *
 * Sem esta peneira, `MATCH_MODE=exact` e `PROCESS_ONLY_REELS=true` entrariam na
 * lista de proibidos e travariam todo commit que tivesse a palavra "true".
 *
 * Duas familias passam: o que tem letra e numero misturados com pelo menos 16
 * caracteres (chaves, tokens, hashes, UUIDs) e o que e so digito com 15 ou
 * mais (identificadores da Meta, que nao tem letra nenhuma).
 */
function pareceSegredo(valor) {
  if (/\s/.test(valor)) return false
  if (/^[0-9]{15,}$/.test(valor)) return true
  if (valor.length < 16) return false
  return /[A-Za-z]/.test(valor) && /[0-9]/.test(valor)
}

/** Os segredos reais da sua maquina, mapeados para o nome da chave. */
function carregarSegredos() {
  const proibidos = new Map()
  for (const arquivo of FONTES_DE_SEGREDO) {
    const texto = lerTexto(join(RAIZ, arquivo))
    if (texto === null) continue
    for (const linha of texto.split('\n')) {
      const par = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (par === null) continue
      const valor = par[2].trim().replace(/^["']|["']$/g, '')
      if (!pareceSegredo(valor)) continue
      proibidos.set(valor, `${par[1]}, do ${arquivo}`)
    }
  }
  return proibidos
}

/** Os trechos pessoais do `.identidade-local.txt`, um por linha. */
function carregarIdentidade() {
  const texto = lerTexto(join(RAIZ, ARQUIVO_IDENTIDADE))
  if (texto === null) return []
  return texto
    .split('\n')
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith('#'))
}

/** Os arquivos que vao neste commit: adicionados, alterados ou renomeados. */
function arquivosNoIndice() {
  const saida = git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
  if (saida === null) return []
  return saida
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** O conteudo do arquivo COMO ESTA NO INDICE, que e o que sera publicado. */
function conteudoNoIndice(caminho) {
  return git('show', `:${caminho}`)
}

/** Mostra o bastante para voce reconhecer o valor, sem reimprimi-lo inteiro. */
function mascarar(valor) {
  if (valor.length <= 10) return `${valor.slice(0, 2)}...`
  return `${valor.slice(0, 4)}...${valor.slice(-3)}`
}

/** Procura segredo e dado pessoal dentro do que esta indo no commit. */
function procurarVazamento(arquivos, segredos, identidade) {
  const achados = []
  for (const arquivo of arquivos) {
    const conteudo = conteudoNoIndice(arquivo)
    if (conteudo === null) continue
    for (const [valor, origem] of segredos) {
      if (conteudo.includes(valor)) {
        achados.push({ arquivo, tipo: 'segredo', detalhe: origem, valor })
      }
    }
    if (PODEM_TER_DADO_PESSOAL.has(arquivo)) continue
    const minusculo = conteudo.toLowerCase()
    for (const trecho of identidade) {
      if (minusculo.includes(trecho.toLowerCase())) {
        achados.push({ arquivo, tipo: 'dado pessoal', detalhe: ARQUIVO_IDENTIDADE, valor: trecho })
      }
    }
  }
  return achados
}

/** Confere se o `wrangler.jsonc` do indice manteve os campos sem valor real. */
function conferirWrangler(arquivos) {
  if (!arquivos.includes('wrangler.jsonc')) return []
  const conteudo = conteudoNoIndice('wrangler.jsonc')
  if (conteudo === null) return []
  const achados = []
  for (const campo of CAMPOS_DO_WRANGLER) {
    const par = conteudo.match(new RegExp(`"${campo}"\\s*:\\s*"([^"]*)"`))
    if (par === null) continue
    if (ehPlaceholder(par[1])) continue
    achados.push({ campo, valor: par[1] })
  }
  return achados
}

/** Explica o que travou e como destravar, sem mandar ninguem burlar a trava. */
function relatar(vazamentos, wrangler) {
  console.error('')
  console.error('================================================================')
  console.error('  COMMIT RECUSADO: tem dado seu indo para o repositorio publico')
  console.error('================================================================')
  for (const a of wrangler) {
    console.error('')
    console.error(`  [FALHA] wrangler.jsonc: o campo "${a.campo}" esta preenchido.`)
    console.error(`          Valor no indice: ${mascarar(a.valor)}`)
    console.error('          No repositorio esse campo e vazio ou COLE_AQUI_...:')
    console.error('          quem instala preenche o dele. O SEU valor fica so na')
    console.error('          sua maquina, e e por isso que o deploy continua')
    console.error('          funcionando sem commitar nada.')
  }
  for (const a of vazamentos) {
    console.error('')
    console.error(`  [FALHA] ${a.arquivo}: ${a.tipo} encontrado.`)
    console.error(`          E o ${a.detalhe}, valor ${mascarar(a.valor)}.`)
  }
  console.error('')
  console.error('  Como resolver, sem desligar a trava:')
  console.error('    git restore --staged wrangler.jsonc   # tira do commit')
  console.error('    git status                            # confira o que sobrou')
  console.error('')
  console.error('  O arquivo continua preenchido na sua pasta e o deploy segue')
  console.error('  igual. So nao vai junto para o GitHub.')
  console.error('')
}

function principal() {
  const arquivos = arquivosNoIndice()
  if (arquivos.length === 0) process.exit(0)

  const segredos = carregarSegredos()
  const identidade = carregarIdentidade()
  const vazamentos = procurarVazamento(arquivos, segredos, identidade)
  const wrangler = conferirWrangler(arquivos)

  if (vazamentos.length === 0 && wrangler.length === 0) {
    console.log(`[ok] guardiao: ${arquivos.length} arquivo(s) conferido(s), nada seu no commit.`)
    process.exit(0)
  }

  relatar(vazamentos, wrangler)
  process.exit(1)
}

principal()
