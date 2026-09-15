#!/usr/bin/env node
/**
 * Assistente de configuracao do noxe-insta-automation.
 *
 * Conduz a pessoa do zero ate a conta do Instagram conectada, sem exigir
 * conhecimento de programacao e sem instalar nada alem do proprio Node.
 *
 * Uso:
 *   node scripts/configurar.mjs      # abre o menu
 *   node scripts/configurar.mjs 3    # vai direto para a etapa 3
 *
 * O QUE ESTE ASSISTENTE FAZ, E O QUE O PAINEL FAZ:
 * este script cuida do que exige a SUA maquina, gerar segredos, cadastra-los
 * na Cloudflare, fazer o primeiro login OAuth e conferir o deploy. O painel
 * administrativo, que roda no seu Worker, cuida do dia a dia: palavra-gatilho,
 * textos, link, quais Reels respondem, e o historico do que aconteceu.
 *
 * POR QUE O PAINEL PODE EXISTIR SEM VIRAR UMA MAQUINA DE GOLPE. Um painel na
 * internet capaz de editar o texto do Direct seria, se invadido, exatamente
 * isso. As quatro travas que impedem esse desfecho:
 *
 *   1. So entra com PASSKEY (digital, rosto ou chave fisica). Nao existe senha
 *      para vazar, para reusar ou para alguem adivinhar.
 *   2. Mudar o texto do Direct ou o link exige um SEGUNDO gesto de biometria,
 *      preso AO CONTEUDO daquela mudanca: aprovar uma coisa nao aprova outra.
 *   3. O link so pode apontar para os dominios do ALLOWED_LINK_DOMAINS, e essa
 *      lista mora no wrangler.jsonc, mudar exige o repositorio e a credencial
 *      de deploy, que e o que um painel invadido nao tem.
 *   4. O codigo de parada desliga tudo SEM sessao e SEM passkey, de qualquer
 *      aparelho, inclusive com a cota do Worker estourada.
 *
 * Os segredos continuam vivendo so aqui: o painel nunca os le nem os mostra.
 * Nenhum segredo e impresso na tela sem voce pedir, e o que voce digita como
 * senha nao aparece enquanto e digitado.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

/** Raiz do projeto: o script funciona mesmo rodado de outra pasta. */
const RAIZ = fileURLToPath(new URL('..', import.meta.url))

const CAMINHO_CONFIG = join(RAIZ, 'src', 'config.ts')
const CAMINHO_BACKUP = join(RAIZ, 'src', 'config.ts.bak')
const CAMINHO_DEV_VARS = join(RAIZ, '.dev.vars')
const CAMINHO_ENV = join(RAIZ, '.env')
const CAMINHO_VERIFICADOR = join(RAIZ, 'scripts', 'verificar-antes-de-publicar.mjs')

/** Tempo maximo de espera de qualquer chamada de rede. */
const LIMITE_REDE_MS = 15000
/** Intervalo entre as consultas ao /health enquanto esperamos o login. */
const INTERVALO_CHECAGEM_MS = 3000
/** Quanto tempo esperamos, no total, a pessoa concluir a autorizacao. */
const ESPERA_TOTAL_MS = 3 * 60 * 1000
/** O `state` do OAuth vale 10 minutos; abaixo disso nem vale tentar. */
const MINUTOS_VALIDADE_STATE = 10
/** Gatilho curto demais aciona a automacao sem querer. */
const MINIMO_CARACTERES_GATILHO = 3
/** Nome ficticio usado so para mostrar como o Direct vai ficar. */
const NOME_DE_EXEMPLO = 'maria.exemplo'

const LINHA = '-'.repeat(64)

// ---------------------------------------------------------------------------
// Utilidades de tela e de pergunta
// ---------------------------------------------------------------------------

function titulo(texto) {
  console.log(`\n${LINHA}\n${texto}\n${LINHA}`)
}

function ok(texto) {
  console.log(`  [ok]      ${texto}`)
}

function aviso(texto) {
  console.log(`  [atencao] ${texto}`)
}

function erro(texto) {
  console.log(`  [erro]    ${texto}`)
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Pergunta simples de sim ou nao, com um padrao para quem so aperta Enter. */
async function confirmar(rl, texto, padraoSim = false) {
  const dica = padraoSim ? '[S/n]' : '[s/N]'
  const resposta = (await rl.question(`${texto} ${dica} `)).trim().toLowerCase()
  if (resposta.length === 0) return padraoSim
  return resposta === 's' || resposta === 'sim' || resposta === 'y'
}

/** Pergunta mostrando o valor atual entre colchetes; Enter mantem o atual. */
async function perguntarComPadrao(rl, rotulo, padrao) {
  console.log(`\n${rotulo}`)
  console.log(`  Valor atual: ${padrao}`)
  const resposta = await rl.question('  Novo valor (Enter mantem o atual): ')
  const limpa = resposta.trim()
  return limpa.length === 0 ? padrao : limpa
}

/**
 * Le um valor sem mostrar o que esta sendo digitado.
 *
 * Silenciamos temporariamente a saida do terminal: sem isso o token ficaria
 * visivel na tela e no historico de rolagem de quem estivesse por perto.
 */
async function perguntarSegredo(rl, rotulo) {
  process.stdout.write(rotulo)
  const escritaOriginal = process.stdout.write
  process.stdout.write = () => true
  try {
    const valor = await rl.question('')
    return valor.trim()
  } finally {
    process.stdout.write = escritaOriginal
    process.stdout.write('\n')
  }
}

// ---------------------------------------------------------------------------
// Leitura de arquivos de variaveis (.env / .dev.vars)
// ---------------------------------------------------------------------------

/**
 * Le uma unica chave de um arquivo no formato CHAVE=valor.
 *
 * Nunca imprime nada: o valor devolvido pode ser um segredo.
 */
function lerChaveDeArquivo(caminho, chave) {
  try {
    const linhas = readFileSync(caminho, 'utf8').split('\n')
    for (const linha of linhas) {
      const limpa = linha.trim()
      if (limpa.startsWith('#') || !limpa.includes('=')) continue
      const separador = limpa.indexOf('=')
      if (limpa.slice(0, separador).trim() !== chave) continue
      const valor = limpa.slice(separador + 1).trim()
      if (valor.length > 0) return valor
    }
  } catch {
    // Arquivo ausente e situacao normal: quem nunca configurou nao tem .env.
  }
  return null
}

// ---------------------------------------------------------------------------
// Rede: consulta ao /health e traducao de erros
// ---------------------------------------------------------------------------

/** Traduz falha de rede para uma frase util, sem despejar stack trace. */
function descreverFalhaDeRede(falha) {
  const codigo = falha?.cause?.code ?? falha?.code ?? ''
  if (falha?.name === 'TimeoutError' || codigo === 'ETIMEDOUT') {
    return 'O endereco demorou demais para responder. Confira a URL e a sua internet.'
  }
  if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') {
    return 'Endereco nao encontrado. Confira se a URL do Worker esta escrita certa.'
  }
  if (codigo === 'ECONNREFUSED') {
    return 'A conexao foi recusada. Se for ambiente local, rode antes: npm run dev'
  }
  return 'Nao consegui falar com esse endereco. Confira a URL e a sua conexao.'
}

/** Faz GET em {base}/health e devolve o JSON ja interpretado. */
/**
 * Consulta `/health`.
 *
 * Com `token`, manda `Authorization: Bearer`, e ai o campo `painel` vem com os
 * SEIS valores em vez dos tres publicos. O assistente e o unico lugar que ja
 * tem esse token (foi ele quem o cadastrou), e e por isso que ele consegue
 * dizer em portugues o que fazer, em vez de so "sem acesso".
 */
async function consultarSaude(base, token) {
  try {
    const resposta = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(LIMITE_REDE_MS),
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    })
    if (!resposta.ok) {
      return { ok: false, erro: `O Worker respondeu com o codigo ${resposta.status}.` }
    }
    return { ok: true, dados: await resposta.json() }
  } catch (falha) {
    return { ok: false, erro: descreverFalhaDeRede(falha) }
  }
}

/** Normaliza o que a pessoa digitou para uma origem https valida. */
function normalizarUrl(bruto) {
  let texto = bruto.trim().replace(/\/+$/, '')
  if (texto.length === 0) return null
  if (!/^https?:\/\//i.test(texto)) texto = `https://${texto}`
  try {
    const alvo = new URL(texto)
    // http so e aceito em localhost, que e o caso do `npm run dev`.
    if (alvo.protocol !== 'https:' && alvo.hostname !== 'localhost') return null
    return `${alvo.protocol}//${alvo.host}`
  } catch {
    return null
  }
}

/** Pergunta a URL do Worker, sugerindo o que ja estiver no ambiente/.env. */
async function obterUrlDoWorker(rl) {
  const doAmbiente = process.env.WORKER_PUBLIC_URL
  const sugestao = doAmbiente ?? lerChaveDeArquivo(CAMINHO_ENV, 'WORKER_PUBLIC_URL')

  console.log('\nQual o endereco publico do seu Worker?')
  console.log('  Exemplo: https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev')
  console.log('  Ele aparece no fim da saida do comando: npm run deploy')
  if (sugestao) console.log(`  Encontrei este endereco salvo: ${sugestao}`)
  console.log('  (digite "sair" para voltar ao menu)')

  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    const resposta = (await rl.question('  Endereco: ')).trim()
    if (resposta.toLowerCase() === 'sair') return null
    const escolhido = resposta.length === 0 ? (sugestao ?? '') : resposta
    const normalizada = normalizarUrl(escolhido)
    if (normalizada) return normalizada
    erro('Isso nao parece um endereco valido. Use o formato https://algo.workers.dev')
  }
  erro('Nao consegui entender o endereco. Voltando ao menu.')
  return null
}

// ---------------------------------------------------------------------------
// Etapa 1 - segredos
// ---------------------------------------------------------------------------

/** Gera os 4 segredos que o projeto sabe gerar sozinho. */
function gerarSegredos() {
  return {
    // base64url: vai em header e query, entao nao pode ter + / =
    META_WEBHOOK_VERIFY_TOKEN: randomBytes(32).toString('base64url'),
    // base64 puro: e o formato exigido pela chave AES-GCM de 32 bytes.
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SETUP_ADMIN_TOKEN: randomBytes(32).toString('base64url'),
    // Raiz das quatro subchaves do painel. Sem ela o painel responde 503.
    PANEL_SESSION_KEY: randomBytes(32).toString('base64url'),
  }
}

/**
 * Monta o conteudo do .dev.vars.
 *
 * O META_APP_SECRET e preservado porque vem da Meta e o assistente nao sabe
 * gera-lo. As chaves geradas sao trocadas de proposito, e o que a etapa 1 faz.
 *
 * A lista abaixo e a AUTORIDADE deste arquivo: toda chave gerada precisa
 * aparecer aqui, senao ela some de quem ja a tinha. Foi o que acontecia com a
 * PANEL_SESSION_KEY, exigida em `secrets.required` do wrangler.jsonc e ausente
 * daqui: re-rodar a etapa 1 derrubava o painel local para 503.
 */
function montarDevVars(segredos) {
  const appSecretAtual = lerChaveDeArquivo(CAMINHO_DEV_VARS, 'META_APP_SECRET') ?? ''
  return [
    '# Arquivo de segredos para desenvolvimento local (npm run dev).',
    '# Gerado por: node scripts/configurar.mjs',
    '# NUNCA commite este arquivo. Ele ja esta coberto pelo .gitignore.',
    '',
    '# Copie do painel da Meta: Configuracoes do app > Basico > Chave secreta.',
    `META_APP_SECRET=${appSecretAtual}`,
    '',
    `META_WEBHOOK_VERIFY_TOKEN=${segredos.META_WEBHOOK_VERIFY_TOKEN}`,
    `TOKEN_ENCRYPTION_KEY=${segredos.TOKEN_ENCRYPTION_KEY}`,
    `SETUP_ADMIN_TOKEN=${segredos.SETUP_ADMIN_TOKEN}`,
    `PANEL_SESSION_KEY=${segredos.PANEL_SESSION_KEY}`,
    '',
  ].join('\n')
}

/** Grava o .dev.vars, sempre pedindo permissao antes de sobrescrever. */
async function gravarDevVars(rl, segredos) {
  if (existsSync(CAMINHO_DEV_VARS)) {
    aviso('Ja existe um arquivo .dev.vars nesta pasta.')
    console.log('  Sobrescrever troca os segredos locais por valores novos.')
    const seguir = await confirmar(rl, '  Quer mesmo sobrescrever?')
    if (!seguir) {
      console.log('  Nada foi gravado. Seus segredos atuais continuam iguais.')
      return
    }
    copyFileSync(CAMINHO_DEV_VARS, `${CAMINHO_DEV_VARS}.bak`)
    ok('Copia de seguranca salva em .dev.vars.bak (tambem ignorada pelo git).')
  }

  writeFileSync(CAMINHO_DEV_VARS, montarDevVars(segredos), 'utf8')
  ok('Segredos gravados em .dev.vars para uso local.')
  console.log('  O META_APP_SECRET continua em branco: cole o valor do painel da Meta.')
}

async function etapaSegredos(rl) {
  titulo('Etapa 1 - Gerar os segredos do projeto')
  console.log('O projeto usa 5 segredos. Quatro deles sao valores aleatorios que este')
  console.log('assistente cria agora. O quinto, o META_APP_SECRET, NAO pode ser gerado')
  console.log('aqui: ele e emitido pela Meta e voce copia do painel do seu app.\n')
  console.log('  META_WEBHOOK_VERIFY_TOKEN  confirma que o webhook e mesmo seu')
  console.log('  TOKEN_ENCRYPTION_KEY       cifra o token da conta guardado no banco')
  console.log('  SETUP_ADMIN_TOKEN          protege as rotas /setup/*')
  console.log('  PANEL_SESSION_KEY          sem ela o painel responde 503 e nao existe')
  console.log('  META_APP_SECRET            vem do painel da Meta (nao e gerado aqui)')

  const segredos = gerarSegredos()

  if (await confirmar(rl, '\nQuer gravar os tres valores no arquivo .dev.vars?', true)) {
    await gravarDevVars(rl, segredos)
  } else {
    console.log('  Tudo bem, nada foi gravado em arquivo.')
  }

  console.log('\nMostrar os valores na tela permite copiar para o gerenciador de senhas,')
  console.log('mas eles ficam visiveis no historico do terminal.')
  if (await confirmar(rl, 'Quer ver os valores agora?')) {
    console.log('')
    for (const [nome, valor] of Object.entries(segredos)) {
      console.log(`  ${nome}=${valor}`)
    }
  }

  console.log('\nPara cadastrar em producao, rode um comando de cada vez e cole o valor:')
  for (const nome of Object.keys(segredos)) {
    console.log(`  npx wrangler secret put ${nome}`)
  }
  console.log('  npx wrangler secret put META_APP_SECRET')
  console.log('\nGuarde os quatro valores num gerenciador de senhas. Se voce perder o')
  console.log('TOKEN_ENCRYPTION_KEY, o token da conta guardado no banco fica ilegivel e')
  console.log('sera preciso refazer o login do Instagram.')
}

// ---------------------------------------------------------------------------
// Etapa 2 - conferir o Worker
// ---------------------------------------------------------------------------

/** Explica em portugues o que veio no /health. */
function explicarSaude(dados) {
  const configurado = dados?.configurado ?? {}
  ok('O Worker esta no ar e respondeu normalmente.')

  if (configurado.appId === true) {
    ok('O META_APP_ID esta preenchido no wrangler.jsonc.')
  } else {
    erro('O META_APP_ID esta vazio no wrangler.jsonc.')
    console.log('    Como resolver: abra o wrangler.jsonc, preencha "META_APP_ID"')
    console.log('    com o ID do seu app da Meta e rode: npm run deploy')
  }

  const versao = configurado.apiVersion ?? 'desconhecida'
  console.log(`  [info]    Versao da API da Meta em uso: ${versao}`)

  if (configurado.contaAutorizada === true) {
    ok('Ja existe uma conta do Instagram conectada.')
  } else {
    aviso('Ainda nao ha nenhuma conta do Instagram conectada.')
    console.log('    Como resolver: rode a etapa 3 deste assistente.')
  }
}

async function etapaSaude(rl) {
  titulo('Etapa 2 - Conferir se o Worker esta no ar')
  const base = await obterUrlDoWorker(rl)
  if (!base) return

  console.log(`\nConsultando ${base}/health ...\n`)
  const resultado = await consultarSaude(base)
  if (!resultado.ok) {
    erro(resultado.erro)
    console.log('    Se o Worker ainda nao foi publicado, rode antes: npm run deploy')
    return
  }

  explicarSaude(resultado.dados)

  console.log('\nPor seguranca o /health nao informa quais segredos estao cadastrados.')
  console.log('Para conferir a lista de segredos em producao, rode:')
  console.log('  npx wrangler secret list')
}

// ---------------------------------------------------------------------------
// Etapa 3 - conectar a conta do Instagram
// ---------------------------------------------------------------------------

/**
 * Abre o navegador padrao do sistema.
 *
 * No Windows o primeiro argumento do comando `start` e o TITULO da janela.
 * Por isso ele vai vazio: sem isso a URL seria lida como titulo e nada abriria.
 * Os argumentos vao entre aspas porque a URL do OAuth tem `&`, que o cmd
 * interpretaria como separador de comandos.
 */
function abrirNavegador(endereco) {
  try {
    if (process.platform === 'win32') {
      const argumentos = ['/c', 'start', '""', `"${endereco}"`]
      const processo = spawn('cmd.exe', argumentos, {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      })
      processo.unref()
      return true
    }
    const comando = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const processo = spawn(comando, [endereco], { stdio: 'ignore', detached: true })
    processo.unref()
    return true
  } catch {
    return false
  }
}

/** Pega o SETUP_ADMIN_TOKEN sem nunca mostra-lo na tela. */
async function obterTokenAdmin(rl) {
  const guardado = lerChaveDeArquivo(CAMINHO_DEV_VARS, 'SETUP_ADMIN_TOKEN')
  if (guardado) {
    console.log('\nEncontrei um SETUP_ADMIN_TOKEN salvo no arquivo .dev.vars.')
    console.log('Atencao: esse e o valor de uso LOCAL. Se voce cadastrou outro valor em')
    console.log('producao com wrangler secret put, o certo aqui e o de producao.')
    if (await confirmar(rl, 'Quer usar o valor do .dev.vars?', true)) return guardado
  }

  console.log('\nCole agora o SETUP_ADMIN_TOKEN de producao.')
  console.log('Nada aparece na tela enquanto voce digita ou cola. Isso e proposital.')
  const digitado = await perguntarSegredo(rl, '  Token: ')
  if (digitado.length === 0) {
    erro('Nenhum token informado.')
    return null
  }
  return digitado
}

/** Pede a URL de autorizacao ao Worker usando o header Authorization. */
async function pedirUrlDeAutorizacao(base, token) {
  try {
    const resposta = await fetch(`${base}/setup/authorize`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(LIMITE_REDE_MS),
    })

    if (resposta.status === 401) {
      return {
        ok: false,
        erro: 'O Worker recusou o token (codigo 401).',
        dica: [
          'O SETUP_ADMIN_TOKEN informado nao confere com o cadastrado no Worker.',
          'Confira se copiou o valor inteiro, sem espaco sobrando no fim.',
          'Para cadastrar de novo: npx wrangler secret put SETUP_ADMIN_TOKEN',
          'Depois do secret put e preciso rodar: npm run deploy',
        ],
      }
    }

    if (!resposta.ok) {
      return {
        ok: false,
        erro: `O Worker respondeu com o codigo ${resposta.status}.`,
        dica: ['Veja os detalhes com: npm run tail'],
      }
    }

    const dados = await resposta.json()
    const destino = typeof dados?.authorizationUrl === 'string' ? dados.authorizationUrl : ''
    if (!destino.startsWith('https://')) {
      return { ok: false, erro: 'A resposta do Worker veio sem um endereco de login valido.' }
    }
    return { ok: true, destino }
  } catch (falha) {
    return { ok: false, erro: descreverFalhaDeRede(falha) }
  }
}

/** Fica consultando o /health ate a conta aparecer conectada. */
async function aguardarConexao(base) {
  const tentativas = Math.floor(ESPERA_TOTAL_MS / INTERVALO_CHECAGEM_MS)
  for (let numero = 1; numero <= tentativas; numero += 1) {
    const resultado = await consultarSaude(base)
    if (resultado.ok && resultado.dados?.configurado?.contaAutorizada === true) {
      process.stdout.write('\n')
      return true
    }
    const segundos = numero * (INTERVALO_CHECAGEM_MS / 1000)
    process.stdout.write(`\r  Aguardando a autorizacao... ${segundos}s`)
    await esperar(INTERVALO_CHECAGEM_MS)
  }
  process.stdout.write('\n')
  return false
}

function explicarTempoEsgotado() {
  aviso('Passaram 3 minutos e a conta ainda nao aparece conectada.')
  console.log('  Isso nao quer dizer que deu errado. Confira, nesta ordem:')
  console.log('   1. A janela do navegador chegou a pedir a sua autorizacao?')
  console.log('   2. Voce marcou TODAS as permissoes pedidas? Faltando uma, o login falha.')
  console.log('   3. A conta usada e profissional (Comercial ou Criador de conteudo)?')
  console.log('   4. O endereco de retorno cadastrado no painel da Meta termina em')
  console.log('      /oauth/callback e aponta para este mesmo Worker?')
  console.log('  Para ver o motivo exato, rode em outro terminal: npm run tail')
  console.log('  Depois de ajustar, rode esta etapa 3 de novo.')
}

async function etapaConectar(rl) {
  titulo('Etapa 3 - Conectar a conta do Instagram')
  console.log('Esta etapa faz o login oficial da Meta e guarda o token da sua conta,')
  console.log('ja criptografado, no banco. E o passo que liga a automacao de verdade.')

  const base = await obterUrlDoWorker(rl)
  if (!base) return

  const token = await obterTokenAdmin(rl)
  if (!token) return

  console.log('\nPedindo o endereco de login ao seu Worker...')
  const pedido = await pedirUrlDeAutorizacao(base, token)
  if (!pedido.ok) {
    erro(pedido.erro)
    for (const linha of pedido.dica ?? []) console.log(`    ${linha}`)
    return
  }

  console.log('')
  aviso(`Este endereco de login vale por ${MINUTOS_VALIDADE_STATE} minutos.`)
  console.log('  Conclua a autorizacao agora. Se demorar, e so rodar a etapa 3 de novo.')
  console.log('  Faca o login com a conta profissional que vai usar a automacao.')

  if (abrirNavegador(pedido.destino)) {
    ok('Abri o navegador. Se nao apareceu nada, copie o endereco abaixo.')
  } else {
    aviso('Nao consegui abrir o navegador daqui. Copie o endereco abaixo.')
  }
  console.log(`\n${pedido.destino}\n`)

  console.log('Vou checar sozinho, a cada 3 segundos, se a conta ja conectou.')
  const conectou = await aguardarConexao(base)

  if (!conectou) {
    explicarTempoEsgotado()
    return
  }

  ok('Conta conectada com sucesso.')
  console.log('\nFalta UM passo que nao tem como ser automatizado, porque a Meta nao')
  console.log('oferece API para ele: cadastrar o webhook no NIVEL DO APP.')
  console.log('  1. Abra o painel em developers.facebook.com e va no seu app.')
  console.log('  2. Em Webhooks, escolha o objeto "Instagram".')
  console.log(`  3. Callback URL: ${base}/webhooks/instagram`)
  console.log('  4. Verify Token: o valor do seu META_WEBHOOK_VERIFY_TOKEN.')
  console.log('  5. Assine o campo "comments".')
  console.log('  O passo a passo com telas esta no arquivo SETUP_META.md.')
}

// ---------------------------------------------------------------------------
// Etapa 4 - configurar a automacao
// ---------------------------------------------------------------------------

/** Aspas aceitas na leitura. As curvas aparecem quando se cola de um editor. */
const ASPAS = ["'", '"', '`', '‘', '’', '“', '”']

const MARCA_BLOCO = 'export const automationConfig: AutomationConfig = {'

/** Isola o bloco automationConfig para nao mexer em nenhuma outra parte. */
function lerBlocoConfig() {
  const conteudo = readFileSync(CAMINHO_CONFIG, 'utf8')
  const inicio = conteudo.indexOf(MARCA_BLOCO)
  if (inicio === -1) return null
  const fechamento = conteudo.indexOf('\n}', inicio)
  if (fechamento === -1) return null
  const fim = fechamento + 2
  return { conteudo, inicio, fim, bloco: conteudo.slice(inicio, fim) }
}

function tirarAspas(bruto) {
  const texto = bruto.trim()
  if (texto.length < 2) return texto
  const primeira = texto.slice(0, 1)
  const ultima = texto.slice(-1)
  if (ASPAS.includes(primeira) && ASPAS.includes(ultima)) return texto.slice(1, -1)
  return texto
}

/** Pega o valor bruto de uma chave, ancorando a busca na propria chave. */
function valorBruto(bloco, chave) {
  const regex = new RegExp(`^[ \\t]*${chave}:[ \\t]*(.*?),?[ \\t]*$`, 'm')
  const achado = bloco.match(regex)
  return achado ? achado[1].trim() : null
}

function lerTexto(bloco, chave) {
  const bruto = valorBruto(bloco, chave)
  return bruto === null ? '' : tirarAspas(bruto)
}

function lerBooleano(bloco, chave) {
  return valorBruto(bloco, chave) === 'true'
}

function lerNumero(bloco, chave, padrao) {
  const numero = Number.parseInt(valorBruto(bloco, chave) ?? '', 10)
  return Number.isFinite(numero) ? numero : padrao
}

/**
 * Le a lista de palavras-gatilho.
 *
 * A separacao por virgula e a mesma usada na pergunta, entao uma palavra com
 * virgula no meio nao seria representavel de qualquer jeito.
 */
function lerLista(bloco, chave) {
  const bruto = valorBruto(bloco, chave) ?? ''
  const interior = bruto.replace(/^\[/, '').replace(/\]$/, '')
  return interior
    .split(',')
    .map((item) => tirarAspas(item))
    .filter((item) => item.length > 0)
}

/** Transforma texto em literal de string no estilo do projeto (aspas simples). */
function comoLiteral(texto) {
  const escapado = texto.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `'${escapado}'`
}

/** Troca APENAS a linha daquela chave, preservando comentarios e indentacao. */
function trocarValor(bloco, chave, novoTexto) {
  const regex = new RegExp(`^([ \\t]*${chave}:[ \\t]*).*?,?[ \\t]*$`, 'm')
  if (!regex.test(bloco)) return null
  return bloco.replace(regex, (_todo, prefixo) => `${prefixo}${novoTexto},`)
}

function validarLink(valor) {
  const texto = valor.trim()
  if (texto.length === 0) return { ok: false, motivo: 'O link nao pode ficar vazio.' }
  let alvo
  try {
    alvo = new URL(texto)
  } catch {
    return { ok: false, motivo: 'Isso nao parece um endereco. Comece com https://' }
  }
  if (alvo.protocol === 'http:') {
    return {
      ok: false,
      motivo: 'Endereco http:// nao e aceito aqui.',
      detalhe: 'Sem criptografia o link pode ser trocado no caminho. Use https://',
    }
  }
  if (alvo.protocol !== 'https:') {
    return { ok: false, motivo: 'Use um endereco comecando com https://' }
  }
  if (!alvo.hostname.includes('.')) {
    return { ok: false, motivo: 'O endereco do site parece incompleto (falta o dominio).' }
  }
  return { ok: true, valor: texto }
}

/** Pergunta o link ate vir um valido. Enter mantem o atual, se ja for valido. */
async function perguntarLink(rl, atual) {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const resposta = await perguntarComPadrao(
      rl,
      'Link que sera entregue no Direct (precisa comecar com https://):',
      atual,
    )
    const validado = validarLink(resposta)
    if (validado.ok) return validado.valor
    erro(validado.motivo)
    if (validado.detalhe) console.log(`            ${validado.detalhe}`)
  }
  return null
}

async function perguntarModo(rl, atual) {
  console.log('\nComo o comentario deve ser comparado com a palavra-gatilho?')
  console.log('  exact    = so aciona quando o comentario for exatamente a palavra.')
  console.log('             "eu quero" aciona; "eu quero saber o preco" nao aciona.')
  console.log('  contains = aciona quando a palavra aparecer em qualquer lugar do texto.')
  console.log('             Pega mais gente, mas dispara sem querer com muito mais')
  console.log('             frequencia. Por isso o padrao recomendado e "exact".')
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const resposta = await perguntarComPadrao(rl, 'Modo de comparacao (exact ou contains):', atual)
    const escolha = resposta.trim().toLowerCase()
    if (escolha === 'exact' || escolha === 'contains') return escolha
    erro('Responda exatamente "exact" ou "contains".')
  }
  return null
}

async function perguntarTexto(rl, rotulo, atual, obrigatorio) {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const resposta = await perguntarComPadrao(rl, rotulo, atual)
    if (resposta.trim().length > 0 || !obrigatorio) return resposta.trim()
    erro('Este texto esta ligado na automacao, entao nao pode ficar vazio.')
  }
  return null
}

async function perguntarGatilhos(rl, atuais) {
  const resposta = await perguntarComPadrao(
    rl,
    'Palavras-gatilho, separadas por virgula:',
    atuais.join(', '),
  )
  const lista = resposta
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  if (lista.length === 0) {
    erro('Sem nenhuma palavra-gatilho a automacao nunca dispara.')
    return null
  }
  for (const palavra of lista) {
    if (palavra.length < MINIMO_CARACTERES_GATILHO) {
      aviso(`"${palavra}" tem menos de ${MINIMO_CARACTERES_GATILHO} letras.`)
      console.log('    Palavras muito curtas acionam a automacao sem querer.')
    }
  }
  return lista
}

async function perguntarCooldown(rl, atual) {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const resposta = await perguntarComPadrao(
      rl,
      'Quantas horas a mesma pessoa precisa esperar para acionar de novo?',
      String(atual),
    )
    const numero = Number.parseInt(resposta, 10)
    if (Number.isFinite(numero) && numero >= 0 && numero <= 8760) return numero
    erro('Informe um numero inteiro de horas, entre 0 e 8760.')
  }
  return null
}

/** Mostra o resumo e um exemplo do Direct ja montado, como a pessoa vai receber. */
function mostrarResumo(novo) {
  titulo('Resumo do que sera gravado')
  console.log(`  Palavras-gatilho ....: ${novo.gatilhos.join(', ')}`)
  console.log(`  Modo de comparacao ..: ${novo.modo}`)
  console.log(`  Resposta publica ....: ${novo.publico}`)
  console.log(`  Texto do Direct .....: ${novo.direto}`)
  console.log(`  Link de destino .....: ${novo.link}`)
  console.log(`  Intervalo por pessoa : ${novo.cooldown} hora(s)`)

  const exemplo = novo.direto
    .replaceAll('{username}', NOME_DE_EXEMPLO)
    .replaceAll('{link}', novo.link)
  console.log('\n  Assim o Direct vai chegar para quem comentar:')
  console.log(`  > ${exemplo}`)
}

/** Coleta todas as respostas da etapa 4. Devolve null se a pessoa desistir. */
async function coletarNovaConfig(rl, atual) {
  const gatilhos = await perguntarGatilhos(rl, atual.gatilhos)
  if (!gatilhos) return null

  const modo = await perguntarModo(rl, atual.modo)
  if (!modo) return null

  const publico = await perguntarTexto(
    rl,
    'Texto da resposta publica no comentario:',
    atual.publico,
    atual.publicoLigado,
  )
  if (publico === null) return null

  const direto = await perguntarTexto(
    rl,
    'Texto do Direct. Use {username} para o nome e {link} para o link:',
    atual.direto,
    atual.diretoLigado,
  )
  if (direto === null) return null

  const link = await perguntarLink(rl, atual.link)
  if (!link) return null

  const cooldown = await perguntarCooldown(rl, atual.cooldown)
  if (cooldown === null) return null

  return { gatilhos, modo, publico, direto, link, cooldown }
}

/** Escreve as trocas no arquivo, sempre com copia de seguranca antes. */
function gravarConfig(alvo, novo) {
  const trocas = [
    ['triggerKeywords', `[${novo.gatilhos.map(comoLiteral).join(', ')}]`],
    ['matchMode', comoLiteral(novo.modo)],
    ['publicReplyText', comoLiteral(novo.publico)],
    ['privateReplyText', comoLiteral(novo.direto)],
    ['destinationUrl', comoLiteral(novo.link)],
    ['userCooldownHours', String(novo.cooldown)],
  ]

  let bloco = alvo.bloco
  for (const [chave, valor] of trocas) {
    const resultado = trocarValor(bloco, chave, valor)
    if (resultado === null) {
      return { ok: false, erro: `Nao encontrei a linha "${chave}" em src/config.ts.` }
    }
    bloco = resultado
  }

  copyFileSync(CAMINHO_CONFIG, CAMINHO_BACKUP)
  const novoConteudo = alvo.conteudo.slice(0, alvo.inicio) + bloco + alvo.conteudo.slice(alvo.fim)
  writeFileSync(CAMINHO_CONFIG, novoConteudo, 'utf8')
  return { ok: true }
}

async function etapaConfigurar(rl) {
  titulo('Etapa 4 - Configurar a automacao')

  const alvo = lerBlocoConfig()
  if (!alvo) {
    erro('Nao consegui entender o arquivo src/config.ts.')
    console.log('    Ele pode ter sido editado a mao. Edite direto no arquivo, entao.')
    return
  }

  const atual = {
    gatilhos: lerLista(alvo.bloco, 'triggerKeywords'),
    modo: lerTexto(alvo.bloco, 'matchMode') || 'exact',
    publico: lerTexto(alvo.bloco, 'publicReplyText'),
    direto: lerTexto(alvo.bloco, 'privateReplyText'),
    link: lerTexto(alvo.bloco, 'destinationUrl'),
    cooldown: lerNumero(alvo.bloco, 'userCooldownHours', 24),
    publicoLigado: lerBooleano(alvo.bloco, 'publicReplyEnabled'),
    diretoLigado: lerBooleano(alvo.bloco, 'privateReplyEnabled'),
  }

  console.log('Vou perguntar um item por vez. Aperte Enter para manter o valor atual.')
  console.log(`  Resposta publica ligada: ${atual.publicoLigado ? 'sim' : 'nao'}`)
  console.log(`  Envio de Direct ligado .: ${atual.diretoLigado ? 'sim' : 'nao'}`)
  console.log('  (para ligar ou desligar, edite src/config.ts direto)')

  const novo = await coletarNovaConfig(rl, atual)
  if (!novo) {
    console.log('\nNada foi alterado.')
    return
  }

  if (atual.diretoLigado && !novo.direto.includes('{link}')) {
    console.log('')
    aviso('O texto do Direct nao tem o marcador {link}.')
    console.log('    Do jeito que esta, a pessoa vai receber uma mensagem SEM o link,')
    console.log('    que e justamente o motivo de existir esta automacao.')
    if (!(await confirmar(rl, '    Quer mesmo continuar assim?'))) {
      console.log('\nNada foi alterado. Rode a etapa 4 de novo e inclua {link} no texto.')
      return
    }
  }

  mostrarResumo(novo)

  if (!(await confirmar(rl, '\nGravar essa configuracao em src/config.ts?', true))) {
    console.log('Nada foi alterado.')
    return
  }

  const resultado = gravarConfig(alvo, novo)
  if (!resultado.ok) {
    erro(resultado.erro)
    console.log('    Nada foi gravado. Edite src/config.ts direto no editor de texto.')
    return
  }

  ok('src/config.ts atualizado. A versao anterior ficou em src/config.ts.bak')
  console.log('\nIMPORTANTE: a mudanca ainda nao esta valendo no ar.')
  console.log('Para publicar, rode:  npm run deploy')
}

// ---------------------------------------------------------------------------
// Etapa 5 - verificacao antes de publicar
// ---------------------------------------------------------------------------

function etapaVerificar() {
  titulo('Etapa 5 - Verificar se esta tudo pronto para publicar no GitHub')
  if (!existsSync(CAMINHO_VERIFICADOR)) {
    erro('Nao encontrei o arquivo scripts/verificar-antes-de-publicar.mjs.')
    return
  }
  const resultado = spawnSync(process.execPath, [CAMINHO_VERIFICADOR], {
    cwd: RAIZ,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (resultado.error) {
    erro('Nao consegui rodar a verificacao.')
    console.log('    Tente direto no terminal: node scripts/verificar-antes-de-publicar.mjs')
  }
}

// ---------------------------------------------------------------------------
// Etapa 6 - conferir o painel
// ---------------------------------------------------------------------------

/**
 * O que dizer para cada um dos seis estados de `corpo.painel`.
 *
 * Cada entrada tem o diagnostico e o PROXIMO PASSO. Um estado sem proximo passo
 * seria so um codigo com cara de frase: quem abre este assistente nao programa,
 * e "sem_passkey" na tela nao ajuda ninguem.
 */
const RECADO_DO_PAINEL = {
  desativado: {
    diagnostico: 'O painel ainda nao esta ligado. Falta cadastrar os segredos.',
    passos: [
      'Rode a opcao 1 deste assistente para gerar os segredos, e confira que a',
      'PANEL_SESSION_KEY foi cadastrada em producao:',
      '  npx wrangler secret list',
      'Confira tambem se o PANEL_RP_ID do wrangler.jsonc esta preenchido com o',
      'endereco do seu Worker, sem "https://" e sem barra no fim.',
    ],
  },
  sem_passkey: {
    diagnostico: 'O painel esta ligado mas ninguem consegue entrar. Gere um convite agora.',
    passos: [
      'Rode:  npm run gerar:convite',
      'Abra o link no CELULAR e cadastre a sua digital ou o seu rosto.',
      'O convite comum vale so enquanto nao existe nenhuma passkey: assim que a',
      'primeira nascer, ele para de funcionar sozinho.',
    ],
  },
  sem_codigo_parada: {
    diagnostico: 'Voce ainda nao tem botao de panico. Gere os codigos.',
    passos: [
      'O codigo de parada desliga a automacao SEM precisar entrar no painel -',
      'e o que salva o dia se voce perder o celular com a passkey.',
      'Gere os codigos pelo painel, na tela de Aparelhos, ou pelo assistente.',
      'Anote no papel. Eles aparecem UMA vez so.',
    ],
  },
  pronto_arquivo: {
    diagnostico: 'Tudo certo. A configuracao ainda vem do arquivo.',
    passos: [
      'O painel esta pronto, mas quem manda hoje e o src/config.ts.',
      'Salve uma vez em qualquer tela do painel para ele passar a mandar.',
    ],
  },
  pronto_banco: {
    diagnostico: 'Tudo certo. A configuracao VIVE NO PAINEL.',
    passos: [
      'Editar o src/config.ts aqui no computador nao muda mais nada:',
      'quem manda agora e o que esta salvo no painel.',
      'Para mudar palavra-gatilho, texto ou link, use o painel.',
    ],
  },
  pronto_parado: {
    diagnostico: 'A automacao esta parada por um campo invalido.',
    passos: [
      'Abra o painel para ver QUAL campo. A tela nomeia o campo e diz o que',
      'esperava encontrar.',
      'Enquanto isso a automacao nao responde ninguem, parar e sempre menos',
      'perigoso do que enviar um link que voce nao conferiu.',
    ],
  },
}

/** Os tres valores publicos, para quando o token nao foi informado. */
const RECADO_PUBLICO = {
  desativado: RECADO_DO_PAINEL.desativado,
  sem_acesso: {
    diagnostico: 'O painel esta ligado, mas ainda falta alguma coisa para usa-lo.',
    passos: [
      'Sem o SETUP_ADMIN_TOKEN o /health nao diz O QUE falta, e isso e de',
      'proposito: a resposta publica nao pode entregar o instante em que um',
      'convite ainda funciona.',
      'Rode esta opcao de novo informando o token para ver o recado exato.',
    ],
  },
  pronto: {
    diagnostico: 'O painel esta pronto para uso.',
    passos: ['Informe o SETUP_ADMIN_TOKEN para saber de onde vem a configuracao.'],
  },
}

async function etapaPainel(rl) {
  titulo('Etapa 6 - Conferir o painel')
  console.log('Esta opcao pergunta ao SEU Worker em que estado o painel esta,')
  console.log('e diz em portugues o que fazer a seguir.\n')

  const base = await obterUrlDoWorker(rl)
  if (!base) return

  // O token e opcional de proposito: sem ele a consulta ainda funciona e devolve
  // os tres valores publicos. Melhor um recado vago do que uma etapa que a
  // pessoa nao consegue rodar por nao achar o token agora.
  const token = await obterTokenAdmin(rl)

  console.log(`\nConsultando ${base}/health ...\n`)
  const resultado = await consultarSaude(base, token)
  if (!resultado.ok) {
    erro(resultado.erro)
    console.log('    Se o Worker ainda nao foi publicado, rode antes: npm run deploy')
    return
  }

  const estado = resultado.dados?.painel
  if (typeof estado !== 'string') {
    erro('Este Worker respondeu sem o campo "painel".')
    console.log('    Ele esta rodando uma versao anterior ao painel administrativo.')
    console.log('    Publique a versao atual com: npm run deploy')
    return
  }

  const recado = RECADO_DO_PAINEL[estado] ?? RECADO_PUBLICO[estado]
  if (!recado) {
    erro(`Nao conheco o estado "${estado}".`)
    console.log('    Provavelmente este assistente esta mais velho que o Worker.')
    return
  }

  console.log(`  ${recado.diagnostico}\n`)
  for (const linha of recado.passos) console.log(`    ${linha}`)

  if (!token) {
    console.log('\n  (Sem o SETUP_ADMIN_TOKEN o /health responde de forma resumida.)')
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

const OPCOES = [
  {
    codigo: '1',
    nome: 'Gerar os segredos do projeto',
    executar: etapaSegredos,
  },
  {
    codigo: '2',
    nome: 'Conferir se o Worker esta no ar',
    executar: etapaSaude,
  },
  {
    codigo: '3',
    nome: 'Conectar a conta do Instagram (fazer o login OAuth)',
    executar: etapaConectar,
  },
  {
    codigo: '4',
    nome: 'Configurar a automacao (palavra-gatilho, textos e link)',
    executar: etapaConfigurar,
  },
  {
    codigo: '5',
    nome: 'Verificar se esta tudo pronto para publicar no GitHub',
    executar: etapaVerificar,
  },
  {
    codigo: '6',
    nome: 'Conferir o painel (em que estado ele esta, e o que fazer)',
    executar: etapaPainel,
  },
]

/**
 * Creditos, mostrados quando a pessoa sai do assistente.
 *
 * Fica na saida de proposito: quem chegou ate aqui ja usou a ferramenta, e e
 * nesse momento que o pedido de estrela faz sentido. Nada e enviado para lugar
 * nenhum, e so texto na tela.
 */
function mostrarCreditos() {
  titulo('Ate logo')
  console.log('Software sem fins lucrativos. Este projeto nao rouba e nao coleta')
  console.log('informacoes de ninguem: tudo o que ele guarda fica no SEU banco de')
  console.log('dados, na SUA conta da Cloudflare. Nada e enviado ao autor do')
  console.log('codigo nem a terceiros.\n')
  console.log('Desenvolvido por Vitor S. Gonsalez - Noxelora.\n')
  console.log('Se o projeto deu certo para voce, nao esqueca de dar uma forca com')
  console.log('a sua estrela no GitHub. E totalmente de graca e ajuda outras')
  console.log('pessoas a encontrarem o projeto:')
  console.log('  https://github.com/VitorSaviolli/Noxe_InstaAutomation\n')
  console.log('Quer fazer uma doacao? PIX: saviolligonsalez@gmail.com')
  console.log('Isso ajuda a manter projetos como este 100% gratuitos.')
  console.log(`${LINHA}\n`)
}

function mostrarMenu() {
  titulo('Assistente do noxe-insta-automation')
  console.log('Escolha o que voce quer fazer agora:\n')
  for (const opcao of OPCOES) {
    console.log(`  ${opcao.codigo}. ${opcao.nome}`)
  }
  console.log('  0. Sair')
}

async function executarEtapa(codigo, rl) {
  const opcao = OPCOES.find((item) => item.codigo === codigo)
  if (!opcao) {
    erro(`Nao existe a opcao "${codigo}". Escolha um numero de 0 a ${OPCOES.length}.`)
    return
  }
  await opcao.executar(rl)
}

async function loopDoMenu(rl) {
  for (;;) {
    mostrarMenu()
    const escolha = (await rl.question('\nNumero da opcao: ')).trim()
    if (escolha === '0' || escolha.toLowerCase() === 'sair') {
      mostrarCreditos()
      return
    }
    await executarEtapa(escolha, rl)
    await rl.question('\nAperte Enter para voltar ao menu... ')
  }
}

async function principal() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  // Marca as saidas que nos mesmos provocamos, para nao avisar duas vezes.
  let encerrandoDeProposito = false

  // Ctrl+C nao deve deixar o terminal travado nem despejar erro na tela.
  rl.on('SIGINT', () => {
    encerrandoDeProposito = true
    console.log('\n\nSaindo a pedido. Nenhuma alteracao foi deixada pela metade.')
    rl.close()
    process.exit(0)
  })

  // Acontece com Ctrl+D ou quando a entrada do terminal acaba.
  rl.on('close', () => {
    if (encerrandoDeProposito) return
    console.log('\nEntrada encerrada. Saindo sem alterar nada.')
  })

  const atalho = process.argv[2]
  try {
    if (atalho) {
      await executarEtapa(atalho.trim(), rl)
      return
    }
    await loopDoMenu(rl)
  } finally {
    encerrandoDeProposito = true
    rl.close()
  }
}

principal().catch((falha) => {
  // Erro inesperado: mostramos so a frase, nunca a stack, que pode conter dado
  // sensivel de uma resposta de rede.
  const mensagem = falha instanceof Error ? falha.message : String(falha)
  console.error(`\nAlgo deu errado: ${mensagem}`)
  console.error('Se o problema continuar, rode: npm run tail  para ver os logs do Worker.')
  process.exit(1)
})
