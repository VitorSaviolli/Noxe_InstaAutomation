import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  COLUNAS_DE_SOBREPOSICAO,
  PainelMidiasRepository,
  semSobreposicao,
  TETO_DE_MIDIAS,
} from '../src/repositories/painel-midias-repository'
import { escapeHtml } from '../src/routes/legal'
import { CAMPO_DA_ACAO } from '../src/routes/painel/campos'
import { PALAVRAS_PROIBIDAS, SELO_PROTEGIDO, TELA_DOS_REELS } from '../src/routes/painel/dicionario'
import {
  CACHE_DA_LISTAGEM_MS,
  comoReel,
  ehReel,
  esquecerAListagem,
} from '../src/routes/painel/midias'
import {
  CAMPO_DO_REEL,
  handleReel,
  PAUSAR,
  RELIGAR,
  SEGUIR_O_GERAL,
  validarSobreposicao,
} from '../src/routes/painel/reel'
import { handleReels } from '../src/routes/painel/reels'
import {
  ATUALIZAR,
  CAMPO_DA_MIDIA,
  CAMPO_DO_VISTO,
  CARREGAR,
} from '../src/routes/painel/reels-lista'
import { ROTA_REEL, ROTA_REELS, ROTAS } from '../src/routes/painel/rotas'
import { despachar } from '../src/routes/painel/router'
import { invalidarCacheDeConfig } from '../src/services/config-store'
import { emitirSessao, fichaCsrf, PRAZO_OCIOSO_DE_SESSAO_MS } from '../src/services/panel-session'
import { gravarConfig, gravarMidia, ligarConta, limparBanco } from './fixtures/banco'
import {
  AGORA,
  bytesComprimidos,
  comApiDeListagem,
  contemPalavra,
  itemDeMidia as item,
  MetaDeListagem,
  paginaDeMidias as pagina,
  RAIZ,
  TETO_COMPRIMIDO_DE_REELS,
  TETO_DE_HTML,
  TETO_DE_UMA_PAGINA_DE_REELS,
  TETO_NO_LIMITE_DE_200_REELS,
} from './fixtures/dubles'

/**
 * MID — Reels e automacoes por midia (§12.5, §13.2).
 *
 * As treze garantias MID de §13.2 sao MID-01 a MID-13; a partir de MID-14 estao
 * as travas que elas nao nomeiam mas das quais dependem — a extensao do funil
 * do Ruling 91, o `enabled = 0` do Ruling 92 e a auditoria por Reel.
 *
 * **MID-06 nao existe neste arquivo, e a ausencia esta declarada.** A garantia
 * "`entry[].id` diferente do `ig_user_id` e ignorado" e sobre o WEBHOOK, e
 * entrega-la exige mudar `parseCommentEvents` para carregar o `entry.id` — o
 * que quebra `tests/webhook.test.ts:93`, que compara o evento inteiro com
 * `toEqual` e esta na lista de arquivos que esta tarefa nao edita. Ela tambem
 * nao pode se apoiar em `env.META_IG_USER_ID`, que nasce VAZIO no repositorio:
 * uma guarda com essa chave descartaria todo comentario numa instalacao nova.
 * O relatorio da Etapa 12 registra isso como a unica das treze nao entregue.
 *
 * **Nada de `vi.mock`**: o duble da Meta e uma classe local passada por
 * parametro, como `MetaFalsa` de `tests/fixtures/dubles.ts`. As rotas sao
 * chamadas por `despachar`, a MESMA funcao que o roteador usa.
 *
 * **Nenhum valor da instalacao do dono entra aqui.** Os ids, as legendas e os
 * permalinks sao ficticios, pelo mesmo motivo que `configDeTeste` existe.
 */

const FORMULARIO = 'application/x-www-form-urlencoded'
const CREDENCIAL = 'credencial-de-teste'

/**
 * Ids FICTICIOS de dezoito digitos.
 *
 * Dezoito digitos e o tamanho de verdade, e ele importa: `1.78e17` esta **acima
 * de 2^53** (~9.0e15), entao `Number(id)` perde precisao e casa o Reel errado
 * sem erro nenhum — o dano que a migration `0002` descreve e que o Ruling 90
 * estende ao JSON.
 */
const REEL_A = '178414000000000001'
const REEL_B = '178414000000000002'
const REEL_C = '178414000000000003'

/** Um id cujo `Number()` COLIDE com o de `REEL_A`. E a prova do perigo. */
const REEL_VIZINHO = '178414000000000000'

interface Sessao {
  readonly cookie: string
  readonly ficha: string
}

async function abrirSessao(): Promise<Sessao> {
  const emitida = await emitirSessao(env, AGORA)
  await env.DB.prepare(
    `INSERT INTO painel_sessoes
       (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      emitida.sidHash,
      CREDENCIAL,
      env.PANEL_RP_ID,
      AGORA,
      emitida.expiraEm,
      AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
      AGORA,
    )
    .run()

  return {
    cookie: `__Host-painel_sessao=${emitida.valor}`,
    ficha: await fichaCsrf(env, emitida.sidHash),
  }
}

/** `GET /painel/reels`, pela escada de §11.3. */
async function telaDeReels(
  sessao: Sessao,
  falsa: MetaDeListagem,
  agora = AGORA,
): Promise<Response> {
  return await despachar(
    new Request(`${RAIZ}${ROTA_REELS.caminho}`, { headers: { cookie: sessao.cookie } }),
    env,
    agora,
    ROTA_REELS,
    (entrada) => handleReels(entrada, comApiDeListagem(falsa)),
  )
}

/** `POST /painel/reels`, com ficha e versao. */
async function postarReels(
  sessao: Sessao,
  corpo: string,
  falsa: MetaDeListagem,
  versao = 1,
): Promise<Response> {
  return await despachar(
    new Request(`${RAIZ}${ROTA_REELS.caminho}`, {
      method: 'POST',
      headers: { 'content-type': FORMULARIO, origin: RAIZ, cookie: sessao.cookie },
      body: `csrf=${sessao.ficha}&versao=${versao}${corpo === '' ? '' : `&${corpo}`}`,
    }),
    env,
    AGORA,
    ROTA_REELS,
    (entrada) => handleReels(entrada, comApiDeListagem(falsa)),
  )
}

/** `GET /painel/reel?midia=`, o caminho que casa por QUERY STRING (Ruling 93). */
async function telaDeUmReel(sessao: Sessao, busca: string): Promise<Response> {
  return await despachar(
    new Request(`${RAIZ}${ROTA_REEL.caminho}${busca}`, { headers: { cookie: sessao.cookie } }),
    env,
    AGORA,
    ROTA_REEL,
    handleReel,
  )
}

/** `POST /painel/reel`, onde o id vai no CORPO. */
async function postarReel(sessao: Sessao, corpo: string, versao = 1): Promise<Response> {
  return await despachar(
    new Request(`${RAIZ}${ROTA_REEL.caminho}`, {
      method: 'POST',
      headers: { 'content-type': FORMULARIO, origin: RAIZ, cookie: sessao.cookie },
      body: `csrf=${sessao.ficha}&versao=${versao}&${corpo}`,
    }),
    env,
    AGORA,
    ROTA_REEL,
    handleReel,
  )
}

async function linhasDeMidia(): Promise<
  { media_id: string; ativo: number; indisponivel_desde: number | null }[]
> {
  const { results } = await env.DB.prepare(
    'SELECT media_id, ativo, indisponivel_desde FROM painel_midias ORDER BY media_id',
  ).all<{ media_id: string; ativo: number; indisponivel_desde: number | null }>()
  return results ?? []
}

async function auditoria(): Promise<{ acao: string; alvo: string | null; campos: string }[]> {
  const { results } = await env.DB.prepare(
    'SELECT acao, alvo, campos FROM painel_auditoria ORDER BY id',
  ).all<{ acao: string; alvo: string | null; campos: string }>()
  return results ?? []
}

beforeEach(async () => {
  await limparBanco(env.DB)
  invalidarCacheDeConfig()
  // O cache da listagem de §12.5 e por ISOLATE e sobrevive entre testes, como o
  // da configuracao. Esquece-lo aqui e o que impede um teste de herdar a
  // listagem que o anterior guardou — e de afirmar sobre uma Meta que nunca foi
  // chamada.
  esquecerAListagem()
  await ligarConta(env, AGORA)
})

// ---------------------------------------------------------------------------
// As treze garantias MID de §13.2
// ---------------------------------------------------------------------------

describe('MID — Reels e automacoes por midia', () => {
  test('MID-01: `media_id` de 18 digitos sobrevive ao round-trip sem virar `Number`', async () => {
    // O perigo escrito como medicao, e nao como frase: os dois ids abaixo sao
    // DIFERENTES como texto e IGUAIS depois de `Number()`. Se qualquer ponto do
    // caminho os converter, o painel passa a responder no Reel errado e nada
    // falha — o dano exato que a migration `0002` descreve.
    expect(REEL_A).not.toBe(REEL_VIZINHO)
    expect(Number(REEL_A)).toBe(Number(REEL_VIZINHO))

    // E o caminho que a migration NAO cobre e o JSON (Ruling 90): um id de 18
    // digitos SEM aspas volta de `JSON.parse` corrompido, em silencio.
    expect(String(JSON.parse(`{"id":${REEL_A}}`).id)).not.toBe(REEL_A)
    expect(JSON.parse(`{"id":"${REEL_A}"}`).id).toBe(REEL_A)

    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([pagina([item(REEL_A)], null)])

    const salvo = await postarReels(
      sessao,
      `mediaScope=selecionadas&${CAMPO_DA_MIDIA}=${REEL_A}&${CAMPO_DO_VISTO}=${REEL_A}`,
      falsa,
    )
    expect(salvo.status).toBe(303)

    // O round-trip inteiro: formulario -> validacao -> `bind` -> D1 -> leitura.
    // A comparacao e com a STRING, e nao com o numero.
    const linhas = await linhasDeMidia()
    expect(linhas.map((linha) => linha.media_id)).toEqual([REEL_A])
    expect(typeof linhas[0]?.media_id).toBe('string')

    // E o id chega ao `getMediaInfo` como texto, sem passar por numero.
    expect(falsa.consultados).toEqual([REEL_A])
  })

  test('MID-02: id que nao veio da listagem e recusado', async () => {
    // Os campos escondidos vem do cliente, entao a unica coisa que o servidor
    // pode conferir e se aquele Reel e mesmo da conta — e §12.5 manda conferir,
    // com `getMediaInfo`, cada id NOVO. Um id que a conta nao conhece e
    // RECUSADO, e nao ignorado: ignorar deixaria a tela dizer "salvo" e voltar
    // sem aquele Reel, sem nunca dizer por que.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([pagina([item(REEL_A)], null)], { conhecidos: [REEL_A] })

    const resposta = await postarReels(
      sessao,
      `mediaScope=selecionadas&${CAMPO_DA_MIDIA}=${REEL_B}&${CAMPO_DO_VISTO}=${REEL_B}`,
      falsa,
    )

    expect(resposta.status).toBe(400)
    expect(await linhasDeMidia()).toEqual([])
    expect((await auditoria()).map((linha) => linha.acao)).toEqual(['mudanca_recusada'])
  })

  test('MID-03: `selecionadas` com lista vazia e automacao ligada nao pode ser salvo', async () => {
    // §9.7, as duas recusas que nao sao sobre campo isolado. Automacao ligada
    // que nunca dispara parece viva, e e a mesma familia da lista de gatilhos
    // vazia com `enabled = 1`.
    await gravarConfig(env.DB, { enabled: 1, media_scope: 'todas' })
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([pagina([item(REEL_A)], null)])

    const resposta = await postarReels(sessao, 'mediaScope=selecionadas', falsa)

    expect(resposta.status).toBe(400)
    expect(await linhaDeEscopo()).toBe('todas')

    // Contrapositivo: com a automacao DESLIGADA, a mesma gravacao passa — as
    // duas sao seguras, e §12.4 so recusa a que fica confusa no painel.
    await env.DB.prepare('UPDATE painel_config SET enabled = 0 WHERE id = 1').run()
    invalidarCacheDeConfig()
    expect((await postarReels(sessao, 'mediaScope=selecionadas', falsa)).status).toBe(303)
    expect(await linhaDeEscopo()).toBe('selecionadas')
  })

  test('MID-04: falha da Meta nao permite salvar selecao', async () => {
    // §9.7: "se a listagem da Meta falhar na montagem da tela, o painel mostra
    // o erro e NAO deixa salvar a selecao" — salvar a partir de uma lista que
    // nao carregou apagaria a selecao existente.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, REEL_A)
    const sessao = await abrirSessao()
    // A Meta esta muda nas DUAS chamadas que esta tela faz: a listagem e a
    // revalidacao de id novo. `conhecidos: []` e o que representa a segunda.
    const falsa = new MetaDeListagem([], { falharListagem: true, conhecidos: [] })

    const corpo = await (await telaDeReels(sessao, falsa)).text()

    // A tela diz o que aconteceu, promete que a automacao continua funcionando
    // e desabilita o botao de salvar.
    expect(corpo).toContain('Não conseguimos falar com o Instagram agora')
    expect(corpo).toContain('continua funcionando normalmente')
    expect(corpo).toContain('<button type="submit" disabled>')

    // E a lista salva aparece, marcada como "salvo por voce" (§12.5).
    expect(corpo).toContain('salvo por você')

    // A metade do POST: um id NOVO com a Meta muda e recusado, e a linha
    // existente continua ativa.
    const resposta = await postarReels(
      sessao,
      `${CAMPO_DA_MIDIA}=${REEL_B}&${CAMPO_DO_VISTO}=${REEL_B}`,
      falsa,
    )
    expect(resposta.status).toBe(400)
    expect((await linhasDeMidia()).map((linha) => linha.media_id)).toEqual([REEL_A])
  })

  test('MID-05: midia apagada continua marcada como indisponivel', async () => {
    // §3: "Reel apagado no Instagram NAO some da lista: fica cinza, com 'Este
    // Reel nao existe mais' e um botao 'Tirar da lista'. Sumir em silencio faria
    // a pessoa achar que continua ativo."
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, REEL_A)
    const sessao = await abrirSessao()
    // A listagem traz OUTRO Reel: o marcado sumiu do Instagram.
    const falsa = new MetaDeListagem([pagina([item(REEL_B)], null)])

    const corpo = await (await telaDeReels(sessao, falsa)).text()

    expect(corpo).toContain('Este Reel não existe mais')
    expect(corpo).toContain(REEL_A)
    // E a linha continua ATIVA no banco: a tela avisa, o painel nao decide
    // sozinho tirar da lista o que o dono escolheu.
    expect(await linhasDeMidia()).toEqual([
      { media_id: REEL_A, ativo: 1, indisponivel_desde: null },
    ])
  })

  test('MID-07: a tela responde `private, no-store` e `Vary`', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([pagina([item(REEL_A)], null)])

    for (const resposta of [
      await telaDeReels(sessao, falsa),
      await telaDeUmReel(sessao, `?${CAMPO_DO_REEL}=${REEL_A}`),
    ]) {
      // A tela carrega a escolha de Reels do dono: um cache intermediario que a
      // guardasse a entregaria a proxima pessoa que abrisse a mesma URL.
      const cache = resposta.headers.get('cache-control') ?? ''
      expect(cache).toContain('private')
      expect(cache).toContain('no-store')
      expect(resposta.headers.get('vary')).not.toBeNull()
    }
  })

  test('MID-08: `thumbnail_url` nunca e gravada', async () => {
    // §12.5: `thumbnail_url` e `media_url` sao enderecos ASSINADOS que vencem, e
    // a migration `0002` nao tem coluna para eles de proposito. A afirmacao tem
    // duas metades, e as duas importam: o SCHEMA nao tem onde guardar, e a
    // gravacao de verdade nao escreve o valor em coluna nenhuma.
    const { results } = await env.DB.prepare('PRAGMA table_info(painel_midias)').all<{
      name: string
    }>()
    const colunas = (results ?? []).map((coluna) => coluna.name)
    expect(colunas).not.toContain('thumbnail_url')
    expect(colunas).not.toContain('media_url')

    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([pagina([item(REEL_A)], null)])

    expect(
      (await postarReels(sessao, `${CAMPO_DA_MIDIA}=${REEL_A}&${CAMPO_DO_VISTO}=${REEL_A}`, falsa))
        .status,
    ).toBe(303)

    // A linha inteira, lida como texto: o endereco assinado nao esta em lugar
    // nenhum dela. Conferir so as colunas conhecidas deixaria passar o dia em
    // que alguem o escrevesse na `legenda_curta`.
    const linha = await env.DB.prepare('SELECT * FROM painel_midias WHERE media_id = ?')
      .bind(REEL_A)
      .first<Record<string, unknown>>()
    expect(JSON.stringify(linha)).not.toContain('scontent.example')
    expect(JSON.stringify(linha)).not.toContain('assinada-')

    // E a miniatura APARECE na tela, que e o outro lado: ela nao e proibida, e
    // so nao pode ser guardada.
    const corpo = await (await telaDeReels(sessao, falsa)).text()
    expect(corpo).toContain('assinada-')
  })

  test('MID-09: a paginacao para quando `paging.next` some, nao quando vem menos itens', async () => {
    // §12.5, e e a garantia mais facil de escrever errado: receber menos itens
    // que o `limit` NAO significa fim de lista. A primeira pagina traz UM item
    // — muito menos que os 25 do `limit` — e ainda tem `paging.next`; a
    // segunda traz tres e NAO tem. Quem parasse por contagem pararia na
    // primeira e deixaria tres Reels de fora, em silencio.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([
      pagina([item(REEL_A)], 'cursor-da-segunda'),
      pagina([item(REEL_B), item(REEL_C)], null),
    ])

    const corpo = await (await telaDeReels(sessao, falsa)).text()

    // Duas chamadas: a primeira sem cursor, a segunda com o que a primeira deu.
    expect(falsa.cursores).toEqual([undefined, 'cursor-da-segunda'])
    for (const id of [REEL_A, REEL_B, REEL_C]) expect(corpo).toContain(id)

    // E, sem `paging.next`, nao ha "Carregar mais": o fim da lista e o unico
    // que existe.
    expect(corpo).not.toContain('Carregar mais')
  })

  test('MID-10: a tela exige sessao', async () => {
    await gravarConfig(env.DB)
    const falsa = new MetaDeListagem([pagina([item(REEL_A)], null)])

    for (const rota of [ROTA_REELS, ROTA_REEL]) {
      expect({ [rota.caminho]: rota.sessao }).toEqual({ [rota.caminho]: true })
    }

    // Sem cookie nenhum, a rota de pagina desvia para `/painel/entrar` — e nao
    // renderiza a escolha de Reels de ninguem.
    const resposta = await despachar(
      new Request(`${RAIZ}${ROTA_REELS.caminho}`),
      env,
      AGORA,
      ROTA_REELS,
      (entrada) => handleReels(entrada, comApiDeListagem(falsa)),
    )
    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe('/painel/entrar')
    // E a Meta nao foi consultada: a escada de §11.3 recusa antes do handler.
    expect(falsa.cursores).toEqual([])
  })

  test('MID-11: acima de 200 midias e recusado', async () => {
    // §12.5: teto de 200 Reels no total. E o bound de carga fria, de memoria e
    // de CPU do caminho quente, que varre a tabela inteira sem indice.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()

    // 200 ja salvos, e mais um marcado: 201.
    const jaSalvos = idsFicticios(200)
    for (const id of jaSalvos) await gravarMidia(env.DB, id)
    const falsa = new MetaDeListagem([pagina([], null)], { conhecidos: [REEL_A] })

    const corpo = [
      ...jaSalvos.map((id) => `${CAMPO_DA_MIDIA}=${id}&${CAMPO_DO_VISTO}=${id}`),
      `${CAMPO_DA_MIDIA}=${REEL_A}&${CAMPO_DO_VISTO}=${REEL_A}`,
    ].join('&')

    const resposta = await postarReels(sessao, corpo, falsa)
    expect(resposta.status).toBe(400)
    expect((await linhasDeMidia()).length).toBe(200)

    // Contrapositivo: exatamente 200 passa. Sem ele o teste provaria apenas que
    // a tela as vezes recusa.
    const noTeto = jaSalvos.map((id) => `${CAMPO_DA_MIDIA}=${id}&${CAMPO_DO_VISTO}=${id}`).join('&')
    expect((await postarReels(sessao, noTeto, falsa)).status).toBe(303)
  })

  test('MID-12: acima de 20 ids NOVOS por gravacao e recusado', async () => {
    // §12.5: 20 e o bound de SUBREQUESTS — cada id novo custa um `getMediaInfo`.
    // E um bound diferente do de 200: um formulario com 200 ids ja salvos e
    // legitimo, e um com 21 ids novos nao.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()
    const novos = idsFicticios(21)
    const falsa = new MetaDeListagem([pagina([], null)], { conhecidos: novos })

    const corpo = novos.map((id) => `${CAMPO_DA_MIDIA}=${id}&${CAMPO_DO_VISTO}=${id}`).join('&')
    const resposta = await postarReels(sessao, corpo, falsa)

    expect(resposta.status).toBe(400)
    expect(await linhasDeMidia()).toEqual([])
    // E nenhuma chamada a Meta aconteceu: a recusa vem ANTES de gastar os
    // subrequests que o teto existe para proteger.
    expect(falsa.consultados).toEqual([])

    // Contrapositivo: 20 passa, e custa exatamente 20 chamadas.
    const vinte = novos.slice(0, 20)
    const outra = new MetaDeListagem([pagina([], null)], { conhecidos: vinte })
    const corpoDeVinte = vinte
      .map((id) => `${CAMPO_DA_MIDIA}=${id}&${CAMPO_DO_VISTO}=${id}`)
      .join('&')
    expect((await postarReels(sessao, corpoDeVinte, outra)).status).toBe(303)
    expect(outra.consultados.length).toBe(20)
  })

  test('MID-13: `?midia=` casa por query string, e nenhum caminho tem segmento variavel', async () => {
    // Ruling 93 e §7.1. A tabela e declarativa e casa por caminho EXATO; o
    // identificador de uma LEITURA vai na query string, e o de uma escrita vai
    // no corpo do POST.
    for (const rota of ROTAS) {
      expect({ [rota.caminho]: rota.caminho.includes(':') || rota.caminho.includes('*') }).toEqual({
        [rota.caminho]: false,
      })
    }
    expect(ROTA_REEL.caminho).toBe('/painel/reel')

    await gravarConfig(env.DB)
    await gravarMidia(env.DB, REEL_A)
    const sessao = await abrirSessao()

    // Com o Reel na query string, a tela abre.
    expect((await telaDeUmReel(sessao, `?${CAMPO_DO_REEL}=${REEL_A}`)).status).toBe(200)

    // Sem ele, e RECUSA — nao uma tela vazia.
    expect((await telaDeUmReel(sessao, '')).status).toBe(400)

    // Um id que nao casa com linha ativa nem inativa e RECUSADO, e nao ignorado.
    expect((await telaDeUmReel(sessao, `?${CAMPO_DO_REEL}=${REEL_B}`)).status).toBe(400)

    // E um id malformado tambem, sem nunca ser "consertado" (§9.2).
    expect((await telaDeUmReel(sessao, `?${CAMPO_DO_REEL}=nao-e-id`)).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// As travas de que as treze dependem
// ---------------------------------------------------------------------------

describe('MID — a extensao do funil, o `enabled` por Reel e a auditoria', () => {
  test('MID-14: a escrita de midia entra no MESMO lote e cai junto com a trava otimista', async () => {
    // Ruling 91, e e a garantia que decidiu o desenho: as escritas de
    // `painel_midias` carregam a MESMA trava otimista do `UPDATE` global, na
    // propria clausula `WHERE`. Com a versao errada no formulario, a gravacao
    // inteira e recusada — a linha global, a de auditoria E a selecao.
    //
    // A mutacao que este teste mata: tirar `TRAVA_DE_VERSAO` dos statements de
    // `painel-midias-repository.ts`. Sem ela a selecao commitava debaixo de um
    // `409`, e o dono via "recarregue a tela" com a escolha dele ja aplicada.
    await gravarConfig(env.DB, { media_scope: 'selecionadas', versao: 7 })
    // **Um Reel JA ATIVO, e ele e a metade que faz o teste morder.** Sem ele, o
    // `UPDATE ... SET ativo = 0` do comeco do lote nao teria linha nenhuma para
    // alterar, e tirar a trava daquele statement sobreviveria a suite inteira —
    // medi essa mutacao, e foi assim que ela sobreviveu na primeira grafia deste
    // teste. Com o `REEL_B` ativo, a mutacao o DESMARCA debaixo de um `409`: o
    // dono le "recarregue a tela" e a escolha dele ja mudou.
    await gravarMidia(env.DB, REEL_B)
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([pagina([item(REEL_A)], null)], { conhecidos: [REEL_A] })

    const resposta = await postarReels(
      sessao,
      `${CAMPO_DA_MIDIA}=${REEL_A}&${CAMPO_DO_VISTO}=${REEL_A}&${CAMPO_DO_VISTO}=${REEL_B}`,
      falsa,
      6,
    )

    expect(resposta.status).toBe(409)
    // Nem o Reel novo entrou, nem o que ja estava foi desmarcado, nem a linha de
    // auditoria nasceu: "sem log, sem mudanca" vale para as tres escritas.
    expect(await linhasDeMidia()).toEqual([
      { media_id: REEL_B, ativo: 1, indisponivel_desde: null },
    ])
    expect(await auditoria()).toEqual([])

    // Contrapositivo: com a versao certa, a mesma gravacao passa inteira.
    expect(
      (
        await postarReels(
          sessao,
          `${CAMPO_DA_MIDIA}=${REEL_A}&${CAMPO_DO_VISTO}=${REEL_A}&${CAMPO_DO_VISTO}=${REEL_B}`,
          falsa,
          7,
        )
      ).status,
    ).toBe(303)
    expect(await linhasDeMidia()).toEqual([
      { media_id: REEL_A, ativo: 1, indisponivel_desde: null },
      { media_id: REEL_B, ativo: 0, indisponivel_desde: null },
    ])
  })

  test('MID-14b: a trava de versao vive no STATEMENT, e nao so no portao do funil', async () => {
    // **O portao antecipado do funil ESCONDE a trava de SQL, e por isso ela
    // precisa do proprio teste.** `gravarConfiguracao` compara a versao lida com
    // a enviada e responde `409` antes de montar o lote — entao MID-14, que
    // manda a versao errada no formulario, nunca chega ao `db.batch()`. Eu medi
    // isso: tirar `TRAVA_DE_VERSAO` de `statementDeDesmarcarTodas` deixava a
    // suite INTEIRA verde.
    //
    // O que a trava de SQL guarda e a janela que o portao nao alcanca: entre
    // `carregarConfigEfetiva` e o `db.batch()`, outra aba pode ter gravado. Ali
    // o `UPDATE` global falha por `WHERE versao = ?`, e sem a mesma clausula nas
    // escritas de midia a selecao commitaria sozinha — o dono lendo "recarregue
    // a tela" com a escolha dele ja trocada.
    //
    // Medir isso pelo HTTP exigiria uma corrida de verdade dentro de uma
    // transacao. O statement e a mesma afirmacao sem a corrida: com a versao
    // errada, ZERO linhas mudam; com a certa, uma.
    await gravarConfig(env.DB, { versao: 7 })
    await gravarMidia(env.DB, REEL_A)
    const repo = new PainelMidiasRepository(env.DB)

    for (const statement of [
      repo.statementDeDesmarcarTodas(AGORA, 999),
      repo.statementDeReativar(AGORA, 999, REEL_A),
      repo.statementDeMarcarIndisponivel(AGORA, 999, REEL_A),
      repo.statementDeSobreposicao(AGORA, 999, REEL_A, { ...semSobreposicao(), enabled: 0 }),
      repo.statementDeMarcar(AGORA, 999, REEL_B, {
        legendaCurta: null,
        permalink: null,
        mediaProductType: 'REELS',
        postadoEm: null,
      }),
    ]) {
      const [resultado] = await env.DB.batch([statement])
      expect(resultado?.meta.changes ?? -1).toBe(0)
    }

    // Nada mudou no banco depois das cinco tentativas.
    expect(await linhasDeMidia()).toEqual([
      { media_id: REEL_A, ativo: 1, indisponivel_desde: null },
    ])

    // Contrapositivo: com a versao CERTA, os mesmos statements alteram a linha.
    // Sem ele, uma clausula que recusasse tudo passaria por este teste.
    const [certo] = await env.DB.batch([repo.statementDeDesmarcarTodas(AGORA, 7)])
    expect(certo?.meta.changes).toBe(1)
  })

  test('MID-15: a linha de auditoria de um Reel e `midia_alterada`, e nomeia o `alvo`', async () => {
    // **A `acao` mudou nesta rodada, e a mudanca e o conserto de um Critical.**
    // A primeira grafia afirmava `config_alterada`, que era o que `lote.ts`
    // emitia para TODA gravacao. §9.9 lista `midia_alterada` na tabela de
    // acoes desde sempre, e ele nunca era emitido em lugar nenhum de `src/`.
    //
    // O dano nao estava na etiqueta: `ultimasMudancas` filtra
    // `WHERE acao = 'config_alterada' AND antes IS NOT NULL` e NAO le o
    // `alvo`. Com a etiqueta errada, a linha deste Reel entrava no historico da
    // tela de Ajustes indistinguivel de uma mudanca global, com o botao "Voltar
    // a esta versao" ao lado — e o `antes` de uma linha de Reel e a config
    // EFETIVA daquele Reel. O botao gravava o link e o intervalo privados de um
    // Reel por cima da configuracao de todos. A metade silenciosa e a que
    // decide: quando o campo divergente nao e protegido, nao ha step-up nenhum
    // e nada aparece na tela antes de gravar.
    //
    // AUDIT-24, na suite da auditoria, afirma a outra ponta: com esta acao a
    // linha nao chega ao historico. Aqui fica a fonte — quem escolhe a acao.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, REEL_A)
    const sessao = await abrirSessao()

    const resposta = await postarReel(
      sessao,
      `${CAMPO_DA_ACAO}=${PAUSAR}&${CAMPO_DO_REEL}=${REEL_A}`,
    )
    expect(resposta.status).toBe(303)

    // O `alvo` existe desde a migration `0002` e a Etapa 12 e a primeira a
    // preenche-lo: sem ele, a auditoria diria "alguem pausou alguma coisa".
    expect(await auditoria()).toEqual([
      { acao: 'midia_alterada', alvo: REEL_A, campos: '["enabled"]' },
    ])

    // E o `alvo` viaja como TEXT: um `media_id` de 18 digitos que virasse numero
    // nomearia o Reel errado na unica coisa que sobra depois do incidente.
    const linha = await env.DB.prepare('SELECT alvo FROM painel_auditoria').first<{
      alvo: string
    }>()
    expect(typeof linha?.alvo).toBe('string')
    expect(linha?.alvo).toBe(REEL_A)
  })

  test('MID-23: um POST que nao muda nada NAO grava, NAO audita e NAO sobe a versao', async () => {
    // **`mudou: true` fixo derrotava `mudouAlgumaCoisa`**, e o dano tinha tres
    // metades. §9.9 registra GRAVACAO, e um formulario reenviado igual nao e
    // uma: a linha de auditoria nascia com `campos: []`, sem nomear campo
    // nenhum. A `versao` subia, e ela e a trava otimista de TODA aba aberta do
    // painel — reabrir Palavras ou Mensagem passava a dar `409` por causa de um
    // botao que nao mudou nada. E a faixa verde dizia "Pronto, salvo" para uma
    // gravacao que nao gravou, contra §12.1 regra 4.
    //
    // O cenario e o mais barato que existe: `acao=religar` num Reel SEM
    // sobreposicao nenhuma. `enabled` ja e `NULL`, entao a nova sobreposicao e
    // identica a que esta no banco.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, REEL_A)
    const sessao = await abrirSessao()

    const resposta = await postarReel(
      sessao,
      `${CAMPO_DA_ACAO}=${RELIGAR}&${CAMPO_DO_REEL}=${REEL_A}`,
    )

    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe(`${ROTA_REELS.caminho}?ok=sem_mudanca`)
    expect(await auditoria()).toEqual([])
    expect(await versaoDaConfig()).toBe(1)

    // Contrapositivo, e sem ele o teste passaria com uma tela que nunca grava:
    // pausar MUDA a sobreposicao, e ai a gravacao acontece inteira.
    const pausa = await postarReel(sessao, `${CAMPO_DA_ACAO}=${PAUSAR}&${CAMPO_DO_REEL}=${REEL_A}`)

    expect(pausa.headers.get('location')).toBe(`${ROTA_REELS.caminho}?ok=salvo`)
    expect((await auditoria()).map((linha) => linha.acao)).toEqual(['midia_alterada'])
    expect(await versaoDaConfig()).toBe(2)
  })

  test('MID-24: o botao que VAI pedir a digital diz isso ANTES (§12.3)', async () => {
    // §12.3 e literal: "quem garante o aviso e o cadeado no campo mais a tela de
    // conferencia — **nunca uma surpresa biometrica**". Ate esta rodada
    // `blocoDosBotoes` nao emitia sinal nenhum, e "Voltar tudo a seguir a regra
    // geral" cai na cerimonia sempre que desfazer ALARGA (MID-21). O dono
    // descobria pelo leitor de digital.
    //
    // A tela tem tudo para decidir na renderizacao — `antes`, `depois` e
    // `camposProtegidos`, a tabela da propria spec —, e os dois Reels abaixo sao
    // o mesmo botao com a sobreposicao virada para os dois lados.
    await gravarConfig(env.DB, { enabled: 1, user_cooldown_hours: 24 })
    // O A ESTREITAVA (48 > 24): desfazer alarga. O B ALARGAVA (12 < 24):
    // desfazer estreita, e estreitar NUNCA pede a digital (§12.3, o rodape dos
    // Ajustes).
    await gravarMidia(env.DB, REEL_A, { user_cooldown_hours: 48 })
    await gravarMidia(env.DB, REEL_B, { user_cooldown_hours: 12 })
    const sessao = await abrirSessao()

    const avisado = await (await telaDeUmReel(sessao, `?${CAMPO_DO_REEL}=${REEL_A}`)).text()

    expect(avisado).toContain(SELO_PROTEGIDO)
    expect(avisado).toContain(escapeHtml(TELA_DOS_REELS.esteBotaoPedeDigital))
    expect(avisado).toContain(escapeHtml(TELA_DOS_REELS.vaiPedirADigital))

    // E o aviso esta no formulario CERTO: o de "voltar a regra geral", e nao no
    // da chave. Sem esta linha, um aviso solto na pagina passaria.
    expect(formularioDaAcao(avisado, SEGUIR_O_GERAL)).toContain(SELO_PROTEGIDO)
    expect(formularioDaAcao(avisado, PAUSAR)).not.toContain(SELO_PROTEGIDO)

    // O contrapositivo, no Reel B: o botao existe e NAO avisa. Um aviso que
    // mente e defeito na mesma medida que um que falta.
    const livre = await (await telaDeUmReel(sessao, `?${CAMPO_DO_REEL}=${REEL_B}`)).text()

    expect(livre).toContain(TELA_DOS_REELS.seguirRegraGeral)
    expect(livre).not.toContain(SELO_PROTEGIDO)
    expect(livre).not.toContain(escapeHtml(TELA_DOS_REELS.esteBotaoPedeDigital))
  })

  test('MID-25: a listagem tem cache de 10 minutos, e o botao Atualizar e quem o joga fora', async () => {
    // **Ruling 98: as duas metades sao a MESMA peca.** §12.1 regra 5 e
    // `[C]`-dura — "sem auto-refresh, sem polling, sem buscar lista a cada
    // render; Atualizar e sempre um botao explicito" — e §12.5 e `[I]`-explicita
    // sobre os 10 minutos. Ate esta rodada nao havia cache NENHUM (todo `GET`
    // gastava ate quatro chamadas a Meta) e nao havia botao Atualizar em tela
    // nenhuma — enquanto DUAS frases renderizadas mandavam toca-lo:
    // `TELA_DOS_REELS.semReels` e `MOTIVO_DA_RECUSA.reel_desconhecido`. Frase
    // que manda fazer o impossivel e a familia dos Rulings 75 e 82.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([paginaComReel(), paginaComReel(), paginaComReel()])

    // O primeiro render busca.
    const primeira = await (await telaDeReels(sessao, falsa)).text()
    expect(falsa.cursores.length).toBe(1)

    // O botao EXISTE, e a tela diz de quando a lista e.
    expect(primeira).toContain(`value="${ATUALIZAR}"`)
    expect(primeira).toContain(TELA_DOS_REELS.atualizar)
    expect(primeira).toContain(escapeHtml(TELA_DOS_REELS.listaBuscadaAgora))

    // O segundo render, dentro dos 10 minutos, NAO busca. Este e o numero que
    // §12.1 regra 5 protege: um render nao gasta cota.
    const dentro = await (await telaDeReels(sessao, falsa, AGORA + 9 * 60_000)).text()
    expect(falsa.cursores.length).toBe(1)
    expect(dentro).toContain(
      escapeHtml(`${TELA_DOS_REELS.listaBuscadaHa} 9 ${TELA_DOS_REELS.listaBuscadaHaFim}`),
    )

    // E o singular, que ate esta rodada saia "há 1 minutos" — portugues que
    // nenhuma pessoa escreve, na tela que existe para explicar.
    const umMinuto = await (await telaDeReels(sessao, falsa, AGORA + 60_000)).text()
    expect(umMinuto).toContain(
      escapeHtml(`${TELA_DOS_REELS.listaBuscadaHa} 1 ${TELA_DOS_REELS.listaBuscadaHaFimUm}`),
    )
    expect(umMinuto).not.toContain(
      escapeHtml(`${TELA_DOS_REELS.listaBuscadaHa} 1 ${TELA_DOS_REELS.listaBuscadaHaFim}`),
    )

    // Passados os 10 minutos, o cache venceu e a tela busca de novo sozinha.
    await telaDeReels(sessao, falsa, AGORA + CACHE_DA_LISTAGEM_MS + 1)
    expect(falsa.cursores.length).toBe(2)

    // E o botao ignora o cache: dentro da janela, o toque busca. Zero escrita,
    // `200`, a pagina remontada — a mesma forma da paginacao (§7.1).
    const atualizado = await postarReels(sessao, `${CAMPO_DA_ACAO}=${ATUALIZAR}`, falsa)

    expect(atualizado.status).toBe(200)
    expect(falsa.cursores.length).toBe(3)
    expect(await linhasDeMidia()).toEqual([])
    expect(await auditoria()).toEqual([])
  })

  test('MID-26: o botao Atualizar aparece TAMBEM quando o Instagram nao responde', async () => {
    // As duas frases que mandam toca-lo sao justamente as dos estados ruins:
    // `semReels` ("espere alguns minutos e toque em Atualizar") e
    // `reel_desconhecido` ("Toque em Atualizar e escolha de novo na lista"). Um
    // botao que sumisse no estado de falha deixaria as duas frases mentindo
    // exatamente onde elas sao lidas.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()

    const semNada = await (await telaDeReels(sessao, new MetaDeListagem([pagina([], null)]))).text()
    expect(semNada).toContain(escapeHtml(TELA_DOS_REELS.semReels))
    expect(semNada).toContain(`value="${ATUALIZAR}"`)

    esquecerAListagem()
    const semMeta = await (
      await telaDeReels(sessao, new MetaDeListagem([], { falharListagem: true }))
    ).text()
    expect(semMeta).toContain(escapeHtml(TELA_DOS_REELS.metaMuda))
    expect(semMeta).toContain(`value="${ATUALIZAR}"`)
  })

  test('MID-27: o peso da tela de Reels, medido cru E comprimido', async () => {
    // **TELA-29 percorre a lista `TELAS` com UM Reel salvo, e por isso ela nunca
    // mediu esta tela.** Aqui estao as duas pontas de verdade.
    //
    // **De onde vem o peso, medido:**
    //   - uma pagina de `me/media` traz ate 25 publicacoes (§12.5) e uma conta
    //     que so posta Reel rende 25 cartoes de uma vez, cada um com miniatura,
    //     legenda cortada, data e o link da tela do Reel;
    //   - §12.5 permite 200 Reels escolhidos, e a tela emite um campo escondido
    //     por id em DOIS formularios: o de salvar, que preserva o que esta fora
    //     da pagina, e o de "Carregar mais", que carrega a mesma escolha.
    //
    // **A AUTORIDADE dos numeros mudou nesta rodada, e a mudanca e uma divida
    // INVENTADA sendo apagada.** A versao anterior afirmava "§12.5 (200 Reels) e
    // §12.9 (15 KB) nao fecham juntas". Nao ha tal conflito: §12.9 nao impoe
    // teto — a linha diz *"Conexao ruim | ... CSS ~6 KB, HTML ~15 KB por tela"*,
    // com til, como diretriz —, e a pergunta que ela protege e "abre em conexao
    // ruim?". Os tetos crus abaixo sao **trava-crescimento desta branch**, e nao
    // cumprimento de §12.9: eles reprovam quem piorar.
    //
    // **Quem responde a pergunta de §12.9 e a medida COMPRIMIDA**, que entrou
    // agora: a Cloudflare comprime a saida, e 39.473 bytes crus viram 2.499 no
    // fio (a re-revisao mediu 2.507 antes desta rodada). Os 39 KB sao custo de
    // memoria e de parse. Um teto gzipado reprova bloat ESTRUTURAL — um bloco
    // novo por Reel — e nunca reprova repeticao barata, que e a distincao que
    // falta ao numero cru.
    //
    // **Dois consertos valem 65 KB dos 104 medidos no comeco da rodada 1:** (1)
    // o Reel salvo que nao apareceu so e tratado como apagado quando a listagem
    // ACABOU — antes, cada Reel nunca perguntado virava um `<li>` inteiro
    // dizendo "Este Reel nao existe mais", o que alem de pesar era falso; (2) o
    // botao Atualizar carrega so o que o banco ainda nao sabe.
    //
    // A distancia entre estes tetos e `TETO_DE_HTML` e divida DECLARADA de
    // desenho de tela, e vai com o resto de §3 para a Task 13b.
    expect(TETO_DE_UMA_PAGINA_DE_REELS).toBeGreaterThan(TETO_DE_HTML)

    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()
    const todos = idsFicticios(TETO_DE_MIDIAS)
    const paginaCheia = todos.slice(0, 25).map((id) => item(id))

    for (const id of todos.slice(0, 25)) await gravarMidia(env.DB, id)
    const comum = await (
      await telaDeReels(sessao, new MetaDeListagem([pagina(paginaCheia, 'proxima')]))
    ).text()

    expect(new TextEncoder().encode(comum).length).toBeLessThanOrEqual(TETO_DE_UMA_PAGINA_DE_REELS)

    for (const id of todos.slice(25)) await gravarMidia(env.DB, id)
    esquecerAListagem()
    const noTeto = await (
      await telaDeReels(sessao, new MetaDeListagem([pagina(paginaCheia, 'proxima')]))
    ).text()

    expect(new TextEncoder().encode(noTeto).length).toBeLessThanOrEqual(TETO_NO_LIMITE_DE_200_REELS)

    // E o fio, que e o unico numero preso ao que §12.9 protege.
    expect(await bytesComprimidos(noTeto)).toBeLessThanOrEqual(TETO_COMPRIMIDO_DE_REELS)
  })

  test('MID-28: "Este Reel nao existe mais" so vale quando a listagem ACABOU', async () => {
    // **A tela afirmava um fato sobre o Instagram do dono com prova que ela nao
    // tinha.** Uma pagina traz ate 25 publicacoes e um toque para em quatro
    // paginas (§12.5); enquanto `paging.next` existe, o Reel que nao apareceu
    // simplesmente NAO chegou a ser perguntado. O codigo tratava toda ausencia
    // como apagamento, entao um dono com Reels antigos abria a tela e lia "Este
    // Reel nao existe mais" em cada um deles, com o botao de tirar da lista ao
    // lado. §12.1 regra 6: erro nunca inventa, e a tela nao afirma o que nao
    // sabe.
    //
    // A guarda que ja existia — "so vale quando a listagem VEIO" — e a mesma
    // ideia pela metade: com a Meta muda, ausencia nao prova nada; com a lista
    // pela metade, tambem nao.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, REEL_A)
    await gravarMidia(env.DB, REEL_B)
    const sessao = await abrirSessao()

    // A pagina traz so o A, e `paging.next` continua de pe: o B pode estar na
    // proxima. A tela nao pode chama-lo de apagado.
    const parcial = await (
      await telaDeReels(
        sessao,
        // As QUATRO paginas do toque, todas com `paging.next`: o laco para pelo
        // teto de paginas de §12.5, e nao por fim de lista.
        new MetaDeListagem([
          pagina([item(REEL_A)], 'p2'),
          pagina([], 'p3'),
          pagina([], 'p4'),
          pagina([], 'p5'),
        ]),
      )
    ).text()

    expect(parcial).not.toContain(TELA_DOS_REELS.reelApagado)

    // Contrapositivo: com `paging.next` AUSENTE, a lista acabou e a ausencia do
    // B passa a ser prova. Sem esta metade, um `sumidos` fixo em `[]` — que faz
    // o Reel apagado sumir em silencio, o que §3 proibe — passaria verde.
    esquecerAListagem()
    const completa = await (
      await telaDeReels(sessao, new MetaDeListagem([pagina([item(REEL_A)], null)]))
    ).text()

    expect(completa).toContain(TELA_DOS_REELS.reelApagado)
    expect(completa).toContain(REEL_B)
  })

  test('MID-29: o Atualizar nao desmarca o que ja esta salvo, e o Salvar seguinte nao apaga', async () => {
    // **CRITICAL introduzido pela rodada 1, e ele apagava a selecao do dono com
    // faixa VERDE.** `montarTela` fazia `desenho.marcadosNaTela ?? ativos`. No
    // `GET` o campo e `null` e cai em `ativos`, certo; no `POST` do botao
    // Atualizar ele e o array de marcados do corpo — e o formulario do Atualizar
    // so carrega o que o banco AINDA NAO SABE, que numa tela recem-aberta e
    // vazio. `[] ?? ativos` e `[]`: o `??` nao dispara em array vazio. A tela
    // voltava com tudo desmarcado E sem os campos escondidos que preservavam os
    // Reels de fora da pagina, e o Salvar seguinte gravava `ativo = 0` neles,
    // com `303 ?ok=salvo` e a faixa "Pronto, salvo. Ja esta valendo."
    //
    // §12.1 regra 4 — "o que a tela mostra e o que o Worker vai fazer" — e regra
    // 6, na tela que §3 chama de prioridade numero um.
    //
    // **As DUAS pontas sao afirmadas aqui, e a segunda e a que importa:** as
    // marcas depois do toque, e as LINHAS DO BANCO depois do Salvar seguinte.
    // Um teste que so olhasse a tela passaria verde num painel que apaga.
    //
    // Os dois POSTs sao dirigidos pelos formularios RENDERIZADOS, e nao por um
    // corpo escrito a mao: o defeito era exatamente o conteudo desses
    // formularios, e um corpo inventado pelo teste esconderia justo o que
    // falhava.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, REEL_A)
    await gravarMidia(env.DB, REEL_B)
    // O terceiro fica FORA da pagina, e `paging.next` continua de pe: ele nao
    // chegou a ser perguntado, entao nao e apagado (MID-28) e so sobrevive
    // pelos campos escondidos.
    await gravarMidia(env.DB, REEL_C)
    const sessao = await abrirSessao()
    const paginaParcial = () => [
      pagina([item(REEL_A), item(REEL_B)], 'p2'),
      pagina([], 'p3'),
      pagina([], 'p4'),
      pagina([], 'p5'),
    ]

    const tela = await (await telaDeReels(sessao, new MetaDeListagem(paginaParcial()))).text()
    expect(marcadosDoFormulario(formularioDeSalvar(tela))).toEqual([REEL_A, REEL_B, REEL_C])

    // O toque em Atualizar, com o corpo que a PROPRIA tela emitiu.
    esquecerAListagem()
    const atualizada = await postarReels(
      sessao,
      corpoDoFormulario(formularioDaAcao(tela, ATUALIZAR)),
      new MetaDeListagem(paginaParcial()),
    )
    const depoisDoToque = await atualizada.text()

    expect(atualizada.status).toBe(200)
    expect(marcadosDoFormulario(formularioDeSalvar(depoisDoToque))).toEqual([
      REEL_A,
      REEL_B,
      REEL_C,
    ])

    // E o Salvar seguinte, dirigido pelo formulario que o toque devolveu.
    const salvo = await postarReels(
      sessao,
      corpoDoFormulario(formularioDeSalvar(depoisDoToque)),
      new MetaDeListagem(paginaParcial()),
    )

    // **`sem_mudanca`, e nao `salvo`** — e a diferenca e a medida do defeito.
    // Com a selecao intacta nao ha o que gravar (MID-23), entao o funil nem
    // escreve; com o defeito, o mesmo toque devolvia `?ok=salvo` e a faixa
    // "Pronto, salvo. Ja esta valendo." por cima de dois Reels desativados.
    expect(salvo.status).toBe(303)
    expect(salvo.headers.get('location')).toBe(`${ROTA_REELS.caminho}?ok=sem_mudanca`)
    expect(
      (await linhasDeMidia()).map((linha) => `${linha.media_id}:${String(linha.ativo)}`),
    ).toEqual([`${REEL_A}:1`, `${REEL_B}:1`, `${REEL_C}:1`])
  })

  test('MID-30: sem linha em `account_tokens`, a tela de Reels mostra a pendencia de §3', async () => {
    // **A peca central do conserto de subrequests da rodada 1 foi entregue sem
    // trava nenhuma.** `contaConectada` — uma segunda leitura de
    // `account_tokens` na mesma renderizacao — virou `contaDaListagem`, que
    // deduz a resposta do motivo da listagem. A re-revisao mutou a chamada para
    // `true` e depois para `false` e a suite INTEIRA passou nos dois casos: a
    // tela podia afirmar para sempre que a conta nao esta conectada, ou esconder
    // uma conta genuinamente desconectada, e nada ficaria vermelho.
    //
    // O que `contaDaListagem` alimenta nesta tela e a BARRA DO TOPO, que §12.1
    // exige igual em toda tela. Por isso a afirmacao e sobre o estado grande, e
    // nao sobre a faixa da listagem: a faixa le o motivo direto e passaria verde
    // com a pergunta sobre a conta respondendo qualquer coisa.
    await gravarConfig(env.DB)
    // A linha da conta e escrita pelo `beforeEach`. Aqui ela sai, que e a
    // instalacao em que o assistente ainda nao rodou no computador (§3).
    await env.DB.prepare('DELETE FROM account_tokens').run()
    const sessao = await abrirSessao()

    const tela = await (await telaDeReels(sessao, new MetaDeListagem([pagina([], null)]))).text()

    expect(tela).toContain('Ligada, mas nada vai ser enviado')
    expect(tela).toContain('A conta do Instagram não está conectada.')
  })

  test('MID-31: a Meta muda NAO vira "conta desconectada" na barra do topo', async () => {
    // `falha_meta` acontece **com** a conta ligada — o token existe e foi a Meta
    // que nao respondeu. Dizer "nao conectada" ali mandaria o dono reconectar
    // uma conta que nunca desconectou, que e a afirmacao falsa de §12.1 regra 3;
    // e e o contrapositivo sem o qual MID-30 passaria com a pergunta fixada em
    // `false`.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const tela = await (
      await telaDeReels(sessao, new MetaDeListagem([], { falharListagem: true }))
    ).text()

    // A tela avisa que o Instagram nao respondeu...
    expect(tela).toContain(escapeHtml(TELA_DOS_REELS.metaMuda))
    // ...e NAO acusa a conta.
    expect(tela).toContain('Ligada e respondendo')
    expect(tela).not.toContain('A conta do Instagram não está conectada.')
  })

  test('MID-32: um Reel DESMARCADO com regras proprias mantem o selo na lista', async () => {
    // §12.5 e literal: o selo "⚙ Regras proprias" aparece "quando aquela linha
    // de `painel_midias` tem alguma coluna de sobreposicao preenchida" — e ela
    // pode estar INATIVA, porque desmarcar um Reel na tela nao apaga as regras
    // dele. E a razao de esta tela precisar das linhas que o lote da
    // configuracao filtrava com `ativo = 1`.
    //
    // **A trava vale para o conserto de §12.10 desta rodada.** As linhas agora
    // vem do `db.batch()` da configuracao, com a variante `comAsInativas`. Se um
    // dia o `WHERE ativo = 1` voltar para aquele statement, a economia continua
    // de pe e o selo some em silencio de todo Reel desmarcado — que e a metade
    // do defeito que ninguem olha, porque a tela continua carregando.
    await gravarConfig(env.DB, { media_scope: 'selecionadas', user_cooldown_hours: 24 })
    await gravarMidia(env.DB, REEL_A, { user_cooldown_hours: 48 }, 0)
    await gravarMidia(env.DB, REEL_B, {}, 0)
    const sessao = await abrirSessao()

    const tela = await (
      await telaDeReels(sessao, new MetaDeListagem([pagina([item(REEL_A), item(REEL_B)], null)]))
    ).text()

    expect(cartaoDoReel(tela, REEL_A)).toContain(TELA_DOS_REELS.regrasProprias)
    // O contrapositivo: sem coluna preenchida nao ha selo, e um selo em todo
    // cartao nao diria nada.
    expect(cartaoDoReel(tela, REEL_B)).not.toContain(TELA_DOS_REELS.regrasProprias)
  })

  test('MID-16: `enabled` por Reel so aceita `0`, e a trava e do codigo E do banco', async () => {
    // Ruling 92. A recusa nasce no VALIDADOR, com frase de `dicionario.ts`,
    // porque um `CHECK` do SQLite vira erro de banco e erro de banco no Worker
    // vira `500` sem frase de tela. As duas linhas sao afirmadas aqui.
    expect(validarSobreposicao({ ...semSobreposicao(), enabled: 0 })).toBeNull()
    expect(validarSobreposicao(semSobreposicao())).toBeNull()
    expect(validarSobreposicao({ ...semSobreposicao(), enabled: 1 })).toBe('reel_nao_pode_ligar')

    // A segunda linha: o `CHECK` da migration recusa a mesma coisa para quem
    // escrever por fora do painel — `wrangler d1 execute`, ou um bug futuro.
    await gravarConfig(env.DB)
    await expect(
      env.DB.prepare(
        'INSERT INTO painel_midias (media_id, ativo, enabled, criado_em, atualizado_em) VALUES (?, 1, 1, ?, ?)',
      )
        .bind(REEL_A, AGORA, AGORA)
        .run(),
    ).rejects.toThrow()
  })

  test('MID-17: "voltar tudo a seguir a regra geral" zera as treze colunas', async () => {
    // §3: o botao existe e desfazer e a direcao segura. As treze colunas voltam
    // a `NULL` num statement so — escrever "so o que mudou" deixaria a coluna
    // esquecida com o valor velho enquanto a tela dissesse que ela voltou.
    // A sobreposicao escolhida ALARGA — intervalo por pessoa menor que o geral
    // —, entao desfaze-la ESTREITA, e estreitar nunca pede a digital. E a
    // metade de §3 que vale sem ressalva; a outra metade e o MID-21 abaixo.
    await gravarConfig(env.DB, { enabled: 1, user_cooldown_hours: 24 })
    await gravarMidia(env.DB, REEL_A, { enabled: 0, user_cooldown_hours: 12 })
    const sessao = await abrirSessao()

    const resposta = await postarReel(
      sessao,
      `${CAMPO_DA_ACAO}=${SEGUIR_O_GERAL}&${CAMPO_DO_REEL}=${REEL_A}`,
    )
    expect(resposta.status).toBe(303)

    const linha = await new PainelMidiasRepository(env.DB).lerUma(REEL_A)
    for (const coluna of COLUNAS_DE_SOBREPOSICAO) {
      expect({ [coluna]: (linha as unknown as Record<string, unknown>)[coluna] }).toEqual({
        [coluna]: null,
      })
    }
  })

  test('MID-18: a paginacao e um POST que so RENDERIZA — zero escrita, `200`', async () => {
    // §7.1 nomeia as tres excecoes a regra de forma, e esta e uma delas: um
    // `303` perderia o que a pessoa ja marcou, e o desenho tem de funcionar sem
    // JavaScript.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao()
    // A pagina que volta traz SO o `REEL_B`: o `REEL_A`, marcado na pagina
    // anterior, esta fora da tela — e e exatamente ele que precisa sobreviver.
    const falsa = new MetaDeListagem([pagina([item(REEL_B)], null)])

    const resposta = await postarReels(
      sessao,
      `${CAMPO_DA_ACAO}=${CARREGAR}&depois=cursor-da-segunda&${CAMPO_DA_MIDIA}=${REEL_A}&${CAMPO_DO_VISTO}=${REEL_A}`,
      falsa,
    )

    expect(resposta.status).toBe(200)
    // Zero escrita: nem linha de midia, nem linha de auditoria.
    expect(await linhasDeMidia()).toEqual([])
    expect(await auditoria()).toEqual([])

    // O cursor foi usado, e ele NUNCA foi ao D1.
    expect(falsa.cursores).toEqual(['cursor-da-segunda'])

    // E o que ja estava marcado volta na pagina nova, num campo escondido — sem
    // isso, salvar depois de "Carregar mais" apagaria as escolhas das paginas
    // anteriores.
    const corpo = await resposta.text()
    expect(corpo).toContain(`<input type="hidden" name="${CAMPO_DA_MIDIA}" value="${REEL_A}">`)
  })

  test('MID-22: nenhuma palavra proibida do glossario aparece nas duas telas novas', async () => {
    // §12.1 regra 1 e §12.7: a lista de palavras que a tela NUNCA escreve. Ela
    // vale para as telas novas exatamente como para as cinco anteriores, e
    // `TELA-24` nao as alcanca — o laco de la percorre a lista `TELAS` daquele
    // arquivo, e §13.1 nao deixa uma suite emprestar o corpo de outra. Sem esta
    // afirmacao, "media id", "override" e "config" entrariam na tela de Reels
    // sem nada reclamar, e a tela de Reels e justamente a que mais convida a
    // escreve-las.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, REEL_A, { user_cooldown_hours: 48 })
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([pagina([item(REEL_A), item(REEL_B)], null)])

    const telas: readonly [string, Response][] = [
      [ROTA_REELS.caminho, await telaDeReels(sessao, falsa)],
      [ROTA_REEL.caminho, await telaDeUmReel(sessao, `?${CAMPO_DO_REEL}=${REEL_A}`)],
    ]

    for (const [caminho, resposta] of telas) {
      // So o `<body>`: o `<head>` carrega `stylesheet` e `viewport`, que sao
      // atributos de HTML e nao texto que alguem le na tela.
      const corpo = (await resposta.text()).split('<body>')[1] ?? ''
      expect({ [caminho]: corpo.length }).not.toEqual({ [caminho]: 0 })

      for (const proibida of PALAVRAS_PROIBIDAS) {
        expect({ [`${caminho}: ${proibida}`]: contemPalavra(corpo, proibida) }).toEqual({
          [`${caminho}: ${proibida}`]: false,
        })
      }
    }

    // **A varredura das CONSTANTES saiu daqui, e a saida e a honestidade** (§13.1).
    //
    // A grafia anterior percorria `Object.values(TELA_DOS_REELS)` logo depois do
    // laco das telas renderizadas, e o efeito de leitura era "as frases desta
    // tela estao cobertas". Nao estavam: o laco passava em frase MORTA. Duas das
    // constantes que ele varria — `cursorVencido` e `miniaturaVencida` — tem
    // ZERO usos em `src/`, e um teste que da impressao de cobrir a renderizacao
    // sem cobri-la e o que §13.1 chama de pior que ausencia, porque desliga a
    // atencao.
    //
    // Quem varre as constantes do dicionario agora e o DIC-02, e ele varre o
    // modulo INTEIRO — `TELA_DOS_REELS` e `MOTIVO_DA_RECUSA` inclusive —, entao
    // nada se perdeu. O que este teste afirma e so o que o nome dele diz: as
    // duas telas RENDERIZADAS nao escrevem palavra proibida. Os dois estados de
    // §12.5 que ainda nao tem tela vao para a Task 13b, e ate la eles estao
    // registrados no docblock de `TELA_DOS_REELS` como nao renderizados.
  })

  test('MID-21: desfazer a sobreposicao PEDE a digital quando desfazer alarga', async () => {
    // **A tensao entre §3 e §10.10, afirmada.** §3 diz que "Voltar tudo a seguir
    // a regra geral" nao pede digital, "porque desfazer e sempre a direcao
    // segura". Nao e sempre: quando a sobreposicao daquele Reel ESTREITAVA — um
    // intervalo por pessoa MAIOR que o geral —, desfaze-la alarga, e §10.10
    // lista o alargamento entre o que pede a digital.
    //
    // Quem decide e `camposProtegidos`, a tabela da propria spec, e nao um `if`
    // desta tela. O `403` aqui e a tela de conferencia: nada foi gravado, e a
    // sobreposicao continua onde estava.
    await gravarConfig(env.DB, { enabled: 1, user_cooldown_hours: 24 })
    await gravarMidia(env.DB, REEL_A, { user_cooldown_hours: 48 })
    const sessao = await abrirSessao()

    const resposta = await postarReel(
      sessao,
      `${CAMPO_DA_ACAO}=${SEGUIR_O_GERAL}&${CAMPO_DO_REEL}=${REEL_A}`,
    )

    expect(resposta.status).toBe(403)
    expect((await new PainelMidiasRepository(env.DB).lerUma(REEL_A))?.user_cooldown_hours).toBe(48)
    expect((await auditoria()).map((linha) => linha.acao)).toEqual(['stepup_recusado'])
  })

  test('MID-19: `acao` que nao casa e recusa, e nao uma gravacao com outro escopo', async () => {
    // Ruling 85. Ate ele, um `acao=carregarr` caia no `!==` e virava uma
    // gravacao COMUM — a operacao pedida sumia e o que sobrava era um formulario
    // com outro escopo, gravado sem que ninguem tivesse pedido isso.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()
    const falsa = new MetaDeListagem([pagina([], null)])

    expect((await postarReels(sessao, `${CAMPO_DA_ACAO}=carregarr`, falsa)).status).toBe(400)
    expect(
      (await postarReel(sessao, `${CAMPO_DA_ACAO}=pausarr&${CAMPO_DO_REEL}=${REEL_A}`)).status,
    ).toBe(400)
    expect(await auditoria()).toEqual([])
  })

  test('MID-20: o filtro de Reels roda no Worker, e o que nao e Reel nao entra', async () => {
    // §12.5: nao ha filtro server-side por REELS. Quem posta muita foto pode ter
    // tres Reels em vinte e cinco publicacoes, e a tela nao pode oferecer uma
    // foto como se a automacao fosse responder nela.
    expect(ehReel({ media_product_type: 'REELS' })).toBe(true)
    expect(ehReel({ media_type: 'IMAGE' })).toBe(false)
    expect(ehReel({ media_product_type: 'FEED', media_type: 'VIDEO' })).toBe(false)
    // Sem `media_product_type`, `media_type: VIDEO` e o que sobra, e a tela
    // rotula "video/Reel" em vez de afirmar o que nao sabe (§15.2, pendencia 7).
    expect(ehReel({ media_type: 'VIDEO' })).toBe(true)

    // E o id manda: um item sem id de verdade nao vira Reel nenhum.
    expect(comoReel({ id: REEL_A })).not.toBeNull()
    expect(comoReel({})).toBeNull()
    expect(comoReel({ id: 'nao-e-id' })).toBeNull()
  })
})

/**
 * O `<form>` daquela operacao, recortado da tela.
 *
 * Os tres formularios da tela de um Reel sao irmaos e so o `acao` os separa —
 * afirmar sobre a pagina inteira nao distinguiria "o botao certo avisa" de
 * "algum lugar da pagina avisa".
 */
function formularioDaAcao(corpo: string, acao: string): string {
  for (const bloco of corpo.split('<form ').slice(1)) {
    if (bloco.includes(`name="${CAMPO_DA_ACAO}" value="${acao}"`)) {
      return bloco.split('</form>')[0] ?? ''
    }
  }
  throw new Error(`a tela nao trouxe o formulario de ${acao}`)
}

/**
 * O `<form>` de SALVAR, recortado da tela de Reels.
 *
 * E o unico dos tres que NAO carrega `acao`: salvar e o POST sem acao (§7.1).
 * Recortar por ausencia e o que impede o teste de afirmar sobre os campos
 * escondidos do "Carregar mais" achando que sao os do Salvar.
 */
function formularioDeSalvar(corpo: string): string {
  for (const bloco of corpo.split('<form ').slice(1)) {
    const formulario = bloco.split('</form>')[0] ?? ''
    if (!formulario.includes(`name="${CAMPO_DA_ACAO}"`)) return formulario
  }
  throw new Error('a tela nao trouxe o formulario de salvar')
}

/** Um `<input>` da tela, com o que o navegador olha para decidir se envia. */
interface EntradaDoFormulario {
  readonly tipo: string
  readonly nome: string
  readonly valor: string
  readonly marcada: boolean
}

/** Os `<input>` de um formulario, na ordem em que a tela os emitiu. */
function entradasDo(formulario: string): EntradaDoFormulario[] {
  const achadas: EntradaDoFormulario[] = []
  for (const bruto of formulario.match(/<input [^>]*>/g) ?? []) {
    achadas.push({
      tipo: /type="([^"]*)"/.exec(bruto)?.[1] ?? '',
      nome: /name="([^"]*)"/.exec(bruto)?.[1] ?? '',
      valor: /value="([^"]*)"/.exec(bruto)?.[1] ?? '',
      marcada: / checked>/.test(bruto),
    })
  }
  return achadas
}

/**
 * Os Reels que aquele formulario manda de volta: marcados MAIS escondidos.
 *
 * O navegador nao distingue os dois — os dois viram `midia=` no corpo —, e a
 * afirmacao do dono e sobre o conjunto: "o que eu tinha escolhido continua
 * escolhido depois deste toque".
 */
function marcadosDoFormulario(formulario: string): string[] {
  return entradasDo(formulario)
    .filter((entrada) => entrada.nome === CAMPO_DA_MIDIA)
    .filter((entrada) => entrada.tipo === 'hidden' || entrada.marcada)
    .map((entrada) => entrada.valor)
    .sort()
}

/**
 * O corpo que o navegador enviaria daquele formulario.
 *
 * **Ficha e versao ficam de fora**, e `postarReels` as poe: elas ja viajam
 * identicas em todo POST da suite, e manda-las duas vezes so criaria um corpo
 * que navegador nenhum produz.
 */
function corpoDoFormulario(formulario: string): string {
  return entradasDo(formulario)
    .filter((entrada) => entrada.tipo === 'hidden' || entrada.marcada)
    .filter((entrada) => entrada.nome !== 'csrf' && entrada.nome !== 'versao')
    .map((entrada) => `${entrada.nome}=${encodeURIComponent(entrada.valor)}`)
    .join('&')
}

/**
 * O `<li>` daquele Reel, recortado da lista.
 *
 * Afirmar sobre a pagina inteira nao distinguiria "o cartao certo tem o selo"
 * de "algum cartao da pagina tem".
 */
function cartaoDoReel(corpo: string, mediaId: string): string {
  for (const bloco of corpo.split('<li class="cartao-reel"').slice(1)) {
    const cartao = bloco.split('</li>')[0] ?? ''
    if (cartao.includes(`value="${mediaId}"`)) return cartao
  }
  throw new Error(`a tela nao trouxe o cartao de ${mediaId}`)
}

/** Uma pagina com um Reel e um cursor, para o cache buscar alguma coisa. */
function paginaComReel() {
  return pagina([item(REEL_A)], null)
}

/** A `versao` da linha global — a trava otimista de toda aba aberta (§8.8). */
async function versaoDaConfig(): Promise<number | undefined> {
  const linha = await env.DB.prepare('SELECT versao FROM painel_config WHERE id = 1').first<{
    versao: number
  }>()
  return linha?.versao
}

/** O escopo salvo na linha global, lido cru. */
async function linhaDeEscopo(): Promise<string | undefined> {
  const linha = await env.DB.prepare('SELECT media_scope FROM painel_config WHERE id = 1').first<{
    media_scope: string
  }>()
  return linha?.media_scope
}

/** `quantos` ids ficticios de 18 digitos, todos distintos. */
function idsFicticios(quantos: number): string[] {
  return Array.from({ length: quantos }, (_, i) => `1784140000000${String(10000 + i)}`)
}
