import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { type AutomationConfig, automationConfig } from '../src/config'
import { carregarConfigEfetiva, invalidarCacheDeConfig } from '../src/services/config-store'
import { type Achado, validarConfig } from '../src/services/config-validation'
import {
  type Allowlist,
  hostPermitido,
  lerAllowlist,
  validarConfigComAllowlist,
} from '../src/services/link-allowlist'
import type { Env } from '../src/types/env'
import { limparBanco } from './fixtures/banco'
import { AGORA, configDeTeste } from './fixtures/dubles'

/**
 * LNK — a allowlist de dominios (16 garantias).
 *
 * A afirmacao que esta suite existe para provar: **o painel nao consegue
 * apontar o link do Direct para fora da lista escrita no repositorio** — nem
 * pelo campo do link, nem escrevendo o endereco dentro do texto, nem por uma
 * escrita feita fora do painel, direto no banco.
 *
 * Nenhum dominio de nenhuma instalacao aparece aqui: este repositorio e um
 * template publico e a lista nasce VAZIA nele — inclusive nos bindings de
 * teste. Cada teste declara a propria allowlist, do mesmo jeito que `now` e
 * sempre injetado.
 *
 * Os casos foram escritos do lado do atacante: o que ele tentaria para fazer
 * um endereco de fora parecer de dentro.
 */

/** O host da lista em todos os testes. Ficticio, como todo o resto da suite. */
const PERMITIDO = 'exemplo.com'
/** A lista estreita: so o host exato, nenhum subdominio. */
const SO_O_HOST = lerAllowlist(PERMITIDO)
/** A lista larga: o host e os subdominios dele. */
const COM_SUBDOMINIOS = lerAllowlist(`.${PERMITIDO}`)

/** O `env` de teste com a allowlist trocada. Nada mais muda. */
function envComAllowlist(dominios: string): Env {
  return { ...env, ALLOWED_LINK_DOMAINS: dominios } as unknown as Env
}

/**
 * Os achados de uma config, como `campo/codigo`.
 *
 * Quase sempre e o codigo e o campo que o teste afirma — o codigo e o
 * contrato de §11.4 e a frase muda com a redacao. A excecao e onde a FRASE e
 * a garantia: §9.8 exige que o aviso nomeie o host, e ha teste que confere o
 * host dentro dela.
 */
function codigos(valores: AutomationConfig, allowlist: Allowlist): string[] {
  return achadosDe(valores, allowlist).map((achado) => `${achado.campo}/${achado.codigo}`)
}

function achadosDe(valores: AutomationConfig, allowlist: Allowlist): readonly Achado[] {
  const resultado = validarConfigComAllowlist(valores, allowlist)
  return resultado.ok ? [] : resultado.achados
}

/** Os achados de uma config que so troca o link. */
function comLink(link: string, allowlist: Allowlist = SO_O_HOST): string[] {
  return codigos(configDeTeste({ destinationUrl: link }), allowlist)
}

const RECUSA_DO_DOMINIO = 'destinationUrl/dominio_nao_permitido'

beforeEach(async () => {
  await limparBanco(env.DB)
  // Sem isto, um teste que usa AGORA deixa um cache "valido ate o futuro"
  // que contamina o teste seguinte.
  invalidarCacheDeConfig()
})

// ---------------------------------------------------------------------------

describe('LNK — a lista e a regra de casamento', () => {
  test('LNK-02: host exato aceito', () => {
    expect(hostPermitido(PERMITIDO, SO_O_HOST)).toBe(true)
    expect(comLink('https://exemplo.com/promo')).toEqual([])
  })

  test('LNK-03: so a entrada com ponto inicial libera subdominio', () => {
    // Sem ponto inicial, `exemplo.com` e o host inteiro e mais nada.
    expect(hostPermitido('loja.exemplo.com', SO_O_HOST)).toBe(false)

    // Com ponto inicial, o proprio dominio e os subdominios, em qualquer
    // profundidade.
    expect(hostPermitido('exemplo.com', COM_SUBDOMINIOS)).toBe(true)
    expect(hostPermitido('loja.exemplo.com', COM_SUBDOMINIOS)).toBe(true)
    expect(hostPermitido('a.b.loja.exemplo.com', COM_SUBDOMINIOS)).toBe(true)

    // E o que a regra NAO pode deixar passar, nas duas listas.
    expect(hostPermitido('exemplo.com.atacante.com', COM_SUBDOMINIOS)).toBe(false)
    expect(hostPermitido('atacanteexemplo.com', COM_SUBDOMINIOS)).toBe(false)
  })

  test('LNK-04: https://evil-exemplo.com e recusado', () => {
    // O erro que um `includes` cometeria: `evil-exemplo.com` contem
    // `exemplo.com`, e nao e ele.
    expect(comLink('https://evil-exemplo.com/promo')).toEqual([RECUSA_DO_DOMINIO])
    expect(comLink('https://evil-exemplo.com/promo', COM_SUBDOMINIOS)).toEqual([RECUSA_DO_DOMINIO])
  })

  test('LNK-05: https://exemplo.com.evil.com e recusado', () => {
    // O erro que um `startsWith` cometeria. E o sufixo mais barato de
    // registrar: quem le a barra de endereco no celular ve o comeco.
    expect(comLink('https://exemplo.com.evil.com/promo')).toEqual([RECUSA_DO_DOMINIO])
    expect(comLink('https://exemplo.com.evil.com/promo', COM_SUBDOMINIOS)).toEqual([
      RECUSA_DO_DOMINIO,
    ])
  })

  test('LNK-06: https://exemplo.com@evil.com e recusado pela propria allowlist', () => {
    // O host de verdade e `evil.com`: tudo antes do `@` e usuario e senha.
    // O validador tambem recusa (`link_com_credencial`), e a allowlist recusa
    // sozinha — sao duas travas independentes, e este teste prova a daqui.
    expect(comLink('https://exemplo.com@evil.com/promo')).toContain(RECUSA_DO_DOMINIO)
  })

  test('LNK-07: http:// e recusado mesmo com o host na lista', () => {
    // O host esta liberado, e ainda assim a config inteira e recusada: a
    // allowlist responde por hosts, e o `https` obrigatorio e regra do
    // validador — as duas rodam sempre juntas, e e por isso que estar na
    // lista nao compra o esquema.
    expect(hostPermitido(PERMITIDO, SO_O_HOST)).toBe(true)
    expect(comLink('http://exemplo.com/promo')).toEqual(['destinationUrl/link_sem_https'])
  })

  test('LNK-08: javascript:, data: e // sao recusados', () => {
    // Esses esquemas nao tem host: nao ha o que comparar com a lista, e quem
    // os recusa e o `https` obrigatorio do validador — que roda sempre junto.
    const semHost = ['destinationUrl/link_sem_https', 'destinationUrl/link_nao_normalizado']
    expect(comLink('javascript:alert(1)')).toEqual(semHost)
    expect(comLink('data:text/html,<h1>oi</h1>')).toEqual(semHost)
    // Sem esquema, `new URL` nem constroi: nao existe base para "//" herdar.
    expect(comLink('//exemplo.com/promo')).toEqual(['destinationUrl/link_invalido'])
  })

  test('LNK-09: punycode e homografo sao recusados', () => {
    // `exemplo.com` escrito com o "e" cirilico. `new URL` converte para
    // punycode, e o punycode nao e o que esta na lista.
    expect(comLink('https://еxemplo.com/promo')).toContain(RECUSA_DO_DOMINIO)
    // O mesmo endereco ja escrito em punycode — a forma exata para a qual
    // `new URL` converte o de cima —, para o caso de alguem gravar a forma
    // convertida direto no banco.
    expect(comLink('https://xn--xemplo-2of.com/promo')).toEqual([RECUSA_DO_DOMINIO])
  })

  test('LNK-09: porta, maiuscula e ponto final no host nao viram excecao', () => {
    // Porta diferente da padrao: `url.host` a carrega, e host com porta nao
    // casa entrada nenhuma.
    expect(comLink('https://exemplo.com:8443/promo')).toContain(RECUSA_DO_DOMINIO)
    // Maiuscula: `new URL` normaliza o host, entao a allowlist aceita — e o
    // validador recusa, porque o texto guardado deixa de ser o endereco que o
    // navegador visita.
    expect(comLink('https://EXEMPLO.com/promo')).toEqual(['destinationUrl/link_nao_normalizado'])
    // Ponto final: `exemplo.com.` e um host diferente de `exemplo.com` para a
    // comparacao de string inteira, e resolve o mesmo nome no DNS.
    expect(comLink('https://exemplo.com./promo')).toContain(RECUSA_DO_DOMINIO)
  })

  test('LNK-09: redirecionador aberto dentro do proprio link e recusado', () => {
    // Host permitido, destino de fora: e o contorno mais barato quando o
    // site do dono tem um `?r=`. A query e o fragmento passam pelo detector.
    expect(comLink('https://exemplo.com/ir?r=https://atacante.com')).toEqual([RECUSA_DO_DOMINIO])
    expect(comLink('https://exemplo.com/ir#atacante.com')).toEqual([RECUSA_DO_DOMINIO])
    // O caminho fica de fora de proposito: um arquivo no caminho tem cara de
    // dominio para o detector, e recusar isso quebraria link legitimo.
    expect(comLink('https://exemplo.com/guias/index.html')).toEqual([])
  })

  test('LNK-09: ponto percent-encoded na query nao atravessa a varredura', () => {
    // `%2E` no lugar do ponto some do detector, e um redirecionador de verdade
    // decodifica o parametro antes de redirecionar — o contorno funciona de
    // ponta a ponta. Por isso a query e varrida tambem decodificada.
    expect(comLink('https://exemplo.com/ir?u=https%3A%2F%2Fatacante%2Ecom')).toEqual([
      RECUSA_DO_DOMINIO,
    ])
    // Duplo encode: `%252E` vira `%2E` na primeira volta e `.` na segunda.
    expect(comLink('https://exemplo.com/ir?u=https%253A%252F%252Fatacante%252Ecom')).toEqual([
      RECUSA_DO_DOMINIO,
    ])
  })

  test('LNK-06: barra invertida, espaco unicode e controle nao enganam o parser', () => {
    // O olho le "@exemplo.com" e pensa em usuario e senha; o parser WHATWG
    // trata a barra invertida como barra normal, entao a autoridade termina
    // ali e o host de verdade e `atacante.com`.
    expect(comLink('https://atacante.com\\@exemplo.com')).toContain(RECUSA_DO_DOMINIO)
    // Espaco ideografico e caractere de controle antes do `@`: o host continua
    // sendo o que vem DEPOIS do `@`, e a lista responde sobre ele.
    expect(comLink('https://exemplo.com　@atacante.com')).toContain(RECUSA_DO_DOMINIO)
    expect(comLink('https://exemplo.com\t@atacante.com')).toContain(RECUSA_DO_DOMINIO)
    // O espelho do primeiro caso, para o teste nao virar "recusa tudo que tem
    // barra invertida": aqui o navegador VAI para `exemplo.com` e o resto e
    // caminho, entao passar e o comportamento certo.
    expect(comLink('https://exemplo.com\\@atacante.com')).toEqual([])
  })
})

describe('LNK — o texto', () => {
  test('LNK-10: URL dentro do texto do Direct passa pela allowlist', () => {
    // Sem isto a trava seria contornada em dez segundos: bastaria deixar o
    // campo do link em paz e escrever o endereco do golpe na mensagem.
    const valores = configDeTeste({
      privateReplyText: 'Ola, {username}! Corre em https://atacante.com antes de {link}',
    })

    expect(codigos(valores, SO_O_HOST)).toEqual(['privateReplyText/dominio_nao_permitido'])
  })

  test('LNK-11: URL dentro do texto publico passa pela allowlist', () => {
    const valores = configDeTeste({ publicReplyText: 'Ver em atacante.com' })

    expect(codigos(valores, SO_O_HOST)).toEqual(['publicReplyText/dominio_nao_permitido'])
  })

  test('LNK-10: endereco sem esquema no texto tambem e pego', () => {
    // Um endereco escrito sem `https://` continua sendo clicavel no Direct.
    const valores = configDeTeste({
      privateReplyText: 'Ola, {username}! Visite atacante.com e pegue o {link}',
    })

    expect(codigos(valores, SO_O_HOST)).toEqual(['privateReplyText/dominio_nao_permitido'])
  })

  test('LNK-10: disfarce com zero-width e largura total nao escapa do detector', () => {
    // A limpeza vem ANTES de procurar: NFKC junta a largura total e a remocao
    // de Cc/Cf mata o zero-width usado para partir o dominio no meio.
    const comZeroWidth = configDeTeste({
      privateReplyText: 'Ola! Veja ataca​nte.com aqui {link}',
    })
    const comLarguraTotal = configDeTeste({
      privateReplyText: 'Ola! Veja ａｔａｃａｎｔｅ.com aqui {link}',
    })

    // O host DENTRO da frase e o que separa a limpeza de um acaso: sem NFKC e
    // sem tirar o zero-width, o detector veria "nte.com" e nao "atacante.com"
    // — recusaria do mesmo jeito, mas por engano, e o aviso mentiria.
    expect(achadosDe(comZeroWidth, SO_O_HOST).map((achado) => achado.mensagem)).toEqual([
      'O endereco atacante.com nao esta na lista liberada no deploy.',
    ])
    expect(achadosDe(comLarguraTotal, SO_O_HOST).map((achado) => achado.mensagem)).toEqual([
      'O endereco atacante.com nao esta na lista liberada no deploy.',
    ])
  })

  test('LNK-09: homografo dentro do TEXTO e recusado', () => {
    // O contorno que fecha o circulo do golpe: o campo do link fica em paz e o
    // domínio de golpe vai na mensagem, escrito com um "e" cirilico. NFKC nao
    // toca alfabeto cirilico — quem resolve e a canonizacao do candidato pelo
    // mesmo `new URL` que o campo do link ja usa.
    const valores = configDeTeste({
      privateReplyText: 'Ola, {username}! Corre em atacantе.com antes de {link}',
    })

    // A frase nomeia o PUNYCODE, que e o endereco que o navegador visitaria —
    // sem isso o aviso mostraria dois textos identicos ao olho do dono.
    expect(achadosDe(valores, SO_O_HOST).map((achado) => achado.mensagem)).toEqual([
      'O endereco xn--atacant-ehg.com nao esta na lista liberada no deploy.',
    ])
  })

  test('LNK-09: dominio em outro alfabeto dentro do texto e recusado', () => {
    const valores = configDeTeste({ publicReplyText: 'Corre em пример.com' })

    expect(achadosDe(valores, SO_O_HOST).map((achado) => achado.mensagem)).toEqual([
      'O endereco xn--e1afmkfd.com nao esta na lista liberada no deploy.',
    ])
  })

  test('LNK-09: dominio liberado com TLD em punycode pode ser citado no texto', () => {
    // O contrapositivo do teste acima, e o que impede a trava de virar "recusa
    // qualquer coisa que nao seja ASCII": uma instalacao com TLD em punycode
    // precisa conseguir citar o proprio dominio na mensagem.
    const lista = lerAllowlist('exemplo.xn--p1ai')
    const valores = configDeTeste({
      destinationUrl: 'https://exemplo.xn--p1ai/promo',
      privateReplyText: 'Ola, {username}! Tudo em exemplo.xn--p1ai: {link}',
    })

    expect(codigos(valores, lista)).toEqual([])
  })

  test('LNK-10: host em maiuscula no texto e recusado', () => {
    const valores = configDeTeste({ publicReplyText: 'Ver em ATACANTE.COM' })

    expect(achadosDe(valores, SO_O_HOST).map((achado) => achado.mensagem)).toEqual([
      'O endereco atacante.com nao esta na lista liberada no deploy.',
    ])
  })

  test('LNK-10: porta citada no texto nao esconde o host', () => {
    // No texto a pergunta e sobre o DOMINIO: `atacante.com:8080` e recusado
    // pelo host, sem a porta atrapalhar. (No campo do link a porta entra na
    // comparacao, porque la `url.host` a carrega — e recusar e o lado seguro.)
    const valores = configDeTeste({ publicReplyText: 'Ver em atacante.com:8080' })

    expect(achadosDe(valores, SO_O_HOST).map((achado) => achado.mensagem)).toEqual([
      'O endereco atacante.com nao esta na lista liberada no deploy.',
    ])
  })

  test('LNK-10: redirecionador aberto dentro do texto e recusado', () => {
    const valores = configDeTeste({
      privateReplyText: 'Ola! Vai por https://exemplo.com/ir?u=https://atacante.com {link}',
    })

    expect(codigos(valores, SO_O_HOST)).toEqual(['privateReplyText/dominio_nao_permitido'])
  })

  test('LNK-10: texto que so cita o dominio liberado continua passando', () => {
    const valores = configDeTeste({
      privateReplyText: 'Ola, {username}! Tudo em loja.exemplo.com: {link}',
    })

    expect(codigos(valores, COM_SUBDOMINIOS)).toEqual([])
    // E a mesma frase na lista estreita para tudo, porque `loja.exemplo.com`
    // nao e `exemplo.com`.
    expect(codigos(valores, SO_O_HOST)).toEqual(['privateReplyText/dominio_nao_permitido'])
  })
})

describe('LNK — a lista vazia e as entradas invalidas', () => {
  test('LNK-12: allowlist vazia nao permite host nenhum, e nao "passa tudo"', () => {
    const vazia = lerAllowlist('')

    expect(vazia.configurada).toBe(false)
    expect(vazia.dominios).toEqual([])
    // A pergunta que a gravacao do painel faz: nada e permitido, nem o host
    // que estaria na lista se ela existisse.
    expect(hostPermitido(PERMITIDO, vazia)).toBe(false)
    expect(hostPermitido('atacante.com', vazia)).toBe(false)
  })

  test('LNK-12: sem lista configurada a ENTREGA continua, e e de proposito', () => {
    // A outra face da mesma regra (§9.8): quem atualiza o codigo com um
    // `destinationUrl` no arquivo e sem a variavel nova nao pode ter a
    // automacao parada por uma configuracao que ainda nao teve chance de
    // fazer. A recusa acontece na ESCRITA, perguntando a `configurada`.
    const valores = configDeTeste({ destinationUrl: 'https://atacante.com/promo' })

    expect(codigos(valores, lerAllowlist(''))).toEqual([])
    expect(codigos(valores, lerAllowlist(undefined))).toEqual([])
  })

  test('LNK-12: entrada invalida e descartada sem alargar a lista', () => {
    // `exemplo.com@atacante.com` e o caso que decide o desenho: um
    // `new URL` "consertando" a entrada devolveria `atacante.com` e alargaria
    // a lista em silencio. Aqui ela simplesmente nao entra.
    const lista = lerAllowlist(
      'exemplo.com@atacante.com, https://outro.com, /barra.com, exemplo.com',
    )

    expect(lista.dominios).toEqual(['exemplo.com'])
    expect(hostPermitido('atacante.com', lista)).toBe(false)
    expect(hostPermitido('outro.com', lista)).toBe(false)
  })

  test('LNK-12: lista toda invalida e o mesmo que lista ausente', () => {
    const lista = lerAllowlist('  ,  , sem-ponto, .., 1.2, exemplo, https://exemplo.com')

    expect(lista.configurada).toBe(false)
    expect(hostPermitido(PERMITIDO, lista)).toBe(false)
  })

  test('LNK-12: espaco em volta e maiuscula na variavel nao mudam quem entra', () => {
    // A unica normalizacao e a que `new URL` tambem faz com o host. Um dono
    // que escreveu com shift nao pode ficar com o painel travado por isso.
    const lista = lerAllowlist(' Exemplo.COM , .Loja.Exemplo.com ')

    expect(lista.dominios).toEqual(['exemplo.com', '.loja.exemplo.com'])
    expect(hostPermitido('a.loja.exemplo.com', lista)).toBe(true)
  })
})

describe('LNK — na leitura', () => {
  test('LNK-13: config com link proibido no banco para a automacao', async () => {
    // A verificacao do dono desta etapa, encenada: a allowlist estreita, um
    // link de fora gravado direto no banco, e a automacao parada.
    await gravarConfig({ destination_url: 'https://atacante.com/golpe' })

    const snapshot = await carregarConfigEfetiva(envComAllowlist(PERMITIDO), AGORA)

    expect(snapshot.origem).toBe('parado_por_erro')
    expect(snapshot.global.enabled).toBe(false)
  })

  test('LNK-01: nada da linha proibida e aproveitado, e o aviso nomeia o host', async () => {
    await gravarConfig({ destination_url: 'https://atacante.com/golpe' })

    const snapshot = await carregarConfigEfetiva(envComAllowlist(PERMITIDO), AGORA)

    // Nem o link, nem qualquer outro campo: a config parada e a de fabrica
    // desligada. Trocar so o link seria inventar uma config que ninguem viu.
    expect(snapshot.global.destinationUrl).toBe(automationConfig.destinationUrl)
    expect(snapshot.global.destinationUrl).not.toBe('https://atacante.com/golpe')
    expect(snapshot.avisos).toEqual([
      'destinationUrl: O endereco atacante.com nao esta na lista liberada no deploy.',
    ])
  })

  test('LNK-13: texto do Direct com endereco de fora tambem para a automacao', async () => {
    await gravarConfig({ private_reply_text: 'Ola! Corre em atacante.com pelo {link}' })

    const snapshot = await carregarConfigEfetiva(envComAllowlist(PERMITIDO), AGORA)

    expect(snapshot.origem).toBe('parado_por_erro')
  })

  test('LNK-14: encolher a allowlist para a automacao que ja estava rodando', async () => {
    await gravarConfig({ destination_url: 'https://loja.exemplo.com/promo' })

    const antes = await carregarConfigEfetiva(envComAllowlist(`.${PERMITIDO}`), AGORA)
    expect(antes.origem).toBe('banco')
    expect(antes.global.destinationUrl).toBe('https://loja.exemplo.com/promo')

    // Encolher a lista exige deploy, e o deploy descarta os isolates com o
    // cache dentro. Aqui esse descarte e explicito.
    invalidarCacheDeConfig()

    const depois = await carregarConfigEfetiva(envComAllowlist(PERMITIDO), AGORA)
    expect(depois.origem).toBe('parado_por_erro')
    expect(depois.global.enabled).toBe(false)
  })

  test('LNK-15: midia com link proprio fora da lista e barrada, e so ela', async () => {
    await gravarConfig()
    await gravarMidia(MIDIA_A, { destination_url: 'https://atacante.com/golpe' })
    await gravarMidia(MIDIA_B, { destination_url: 'https://exemplo.com/outro' })

    const snapshot = await carregarConfigEfetiva(envComAllowlist(PERMITIDO), AGORA)

    // A global continua valendo: barrar a midia nao pode derrubar o resto.
    expect(snapshot.origem).toBe('banco')
    expect(snapshot.overrides).toEqual([
      { mediaIds: [MIDIA_A], enabled: false },
      { mediaIds: [MIDIA_B], destinationUrl: 'https://exemplo.com/outro' },
    ])
  })

  test('LNK-16: restaurar uma versao com link hoje proibido e recusado', () => {
    // A restauracao passa pelo mesmo funil da gravacao normal (§9.9): mesmo
    // validador, allowlist de HOJE. O `JSON.parse` encena a volta do valor
    // guardado na coluna `antes` de `painel_auditoria`. O botao "Voltar a
    // esta versao" da etapa 11 nao pode ter caminho proprio: se a lista
    // encolheu, a versao antiga nao volta.
    const versaoGuardada: AutomationConfig = JSON.parse(
      JSON.stringify(configDeTeste({ destinationUrl: 'https://loja.exemplo.com/antiga' })),
    )

    expect(validarConfigComAllowlist(versaoGuardada, COM_SUBDOMINIOS).ok).toBe(true)
    expect(codigos(versaoGuardada, SO_O_HOST)).toEqual([RECUSA_DO_DOMINIO])
  })
})

describe('LNK — carry-forward da revisao da Task 3', () => {
  test('o host permitido escondido na query nao normaliza o link', () => {
    // `config-validation.ts` comparava com `bruto.includes(url.host)`, e
    // `https://EXEMPLO.com/?r=exemplo.com` passava: o host normalizado
    // aparecia na query. A comparacao passou a ser da origem inteira.
    const disfarcado = configDeTeste({ destinationUrl: 'https://EXEMPLO.com/?r=exemplo.com' })
    const resultado = validarConfig(disfarcado)

    expect(resultado.ok).toBe(false)
    expect(resultado.ok ? [] : resultado.achados.map((achado) => achado.codigo)).toEqual([
      'link_nao_normalizado',
    ])
  })

  test('o link legitimo sem barra final continua passando', () => {
    // O contrapositivo: comparar com `url.href` exigiria a barra que o `href`
    // acrescenta e recusaria um link que a pessoa escreveu certo.
    expect(validarConfig(configDeTeste({ destinationUrl: 'https://exemplo.com' })).ok).toBe(true)
    expect(validarConfig(configDeTeste({ destinationUrl: 'https://exemplo.com/a?b=1#c' })).ok).toBe(
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// Escrita no banco: so as colunas que esta suite precisa trocar
// ---------------------------------------------------------------------------

const MIDIA_A = '17900000000000001'
const MIDIA_B = '17900000000000002'

/** Uma linha de `painel_config` valida, com os campos trocados que vierem. */
async function gravarConfig(patch: Record<string, string | number> = {}): Promise<void> {
  const linha = {
    enabled: 1,
    trigger_keywords: '["eu quero","quero o link"]',
    match_mode: 'exact',
    case_sensitive: 0,
    normalize_accents: 1,
    ignore_punctuation: 1,
    process_only_reels: 1,
    media_scope: 'todas',
    public_reply_enabled: 1,
    public_reply_text: 'Enviei as informacoes no seu Direct.',
    private_reply_enabled: 1,
    private_reply_text: 'Ola, {username}! Aqui esta o link: {link}',
    destination_url: 'https://exemplo.com/do-banco',
    user_cooldown_hours: 24,
    versao: 1,
    ...patch,
  }

  await env.DB.prepare(
    `INSERT INTO painel_config
       (id, enabled, trigger_keywords, match_mode, case_sensitive, normalize_accents,
        ignore_punctuation, process_only_reels, media_scope, public_reply_enabled,
        public_reply_text, private_reply_enabled, private_reply_text, destination_url,
        user_cooldown_hours, versao, parado_por_codigo_em, criado_em, atualizado_em)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      linha.enabled,
      linha.trigger_keywords,
      linha.match_mode,
      linha.case_sensitive,
      linha.normalize_accents,
      linha.ignore_punctuation,
      linha.process_only_reels,
      linha.media_scope,
      linha.public_reply_enabled,
      linha.public_reply_text,
      linha.private_reply_enabled,
      linha.private_reply_text,
      linha.destination_url,
      linha.user_cooldown_hours,
      linha.versao,
      AGORA,
      AGORA,
    )
    .run()
}

/** Uma linha de `painel_midias`. As colunas ausentes ficam `NULL`. */
async function gravarMidia(
  mediaId: string,
  sobreposicao: Record<string, string | number> = {},
): Promise<void> {
  const colunas = Object.keys(sobreposicao)
  const nomes = ['media_id', 'ativo', 'criado_em', 'atualizado_em', ...colunas].join(', ')
  const marcas = new Array(4 + colunas.length).fill('?').join(', ')

  await env.DB.prepare(`INSERT INTO painel_midias (${nomes}) VALUES (${marcas})`)
    .bind(mediaId, 1, AGORA, AGORA, ...colunas.map((coluna) => sobreposicao[coluna]))
    .run()
}
