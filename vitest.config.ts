import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { unstable_readConfig } from 'wrangler'

/**
 * Testes rodam no runtime real do Workers (workerd) via Miniflare, com um D1
 * de verdade em memoria. Isso evita mock de banco: as queries testadas sao as
 * mesmas que rodam em producao.
 *
 * Os valores de binding aqui sao FICTICIOS e existem so para o teste — nenhum
 * segredo real entra neste arquivo, que e versionado.
 */
const migrations = await readD1Migrations('./migrations')

/**
 * O `wrangler.jsonc` continua sendo a fonte da verdade, e este arquivo le dele
 * o que o ambiente de teste precisa: entrada, data de compatibilidade, banco e
 * as `vars` publicas.
 *
 * O que ele NAO herda sao os tres bindings `ratelimits` — a excecao declarada
 * de §7.4. Passar `wrangler: { configPath }` faria o pool derivar TODOS os
 * bindings do arquivo, os tres limitadores inclusive, e nao existe forma de
 * remover um binding depois que o pool o leu (a fusao de opcoes do Miniflare
 * so acrescenta). Com os limitadores presentes aqui, o `LimitadorDeBinding`
 * assumiria em todos os testes e a suite deixaria de provar exatamente o que
 * §7.4 manda provar: **ausentes os bindings, o painel funciona sem a camada**.
 * Por isso a leitura e explicita, campo a campo.
 */
const producao = unstable_readConfig({ config: './wrangler.jsonc' })

/**
 * Todo nome de binding declarado no `wrangler.jsonc`, entregue ao ambiente de
 * teste para o metateste META-04 conferir a propagacao.
 *
 * A leitura acima e explicita campo a campo, e o preco disso e que um binding
 * NOVO (KV, R2, Durable Object, fila, servico, um D1 a mais) chega ao Worker
 * publicado e NAO chega ao ambiente de teste — a suite continuaria verde
 * provando menos do que promete. Herdar `producao.vars` cobre so as `vars`; o
 * resto some em silencio. Esta lista fecha esse buraco: o conjunto vem do
 * arquivo, e o metateste compara com o `env` de teste.
 *
 * Vai como binding porque o teste roda dentro do workerd, onde nao existe
 * sistema de arquivos nem `unstable_readConfig` — o mesmo caminho que
 * `TEST_MIGRATIONS` ja usa.
 */
/** Containers cujos itens nomeiam o binding em `name`, e nao em `binding`. */
const NOMEADOS_POR_NAME: readonly (readonly string[])[] = [
  ['ratelimits'],
  ['send_email'],
  ['durable_objects', 'bindings'],
  ['unsafe', 'bindings'],
]

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null
}

/**
 * Coleta recursivamente todo `binding: "NOME"`.
 *
 * E generico de proposito: `binding` e a convencao da Cloudflare para KV, R2,
 * D1, Vectorize, Hyperdrive, servicos, filas, assets, AI e o que vier depois.
 * Uma lista escrita a mao de containers envelheceria no primeiro tipo novo, e
 * envelheceria em silencio, que e o defeito que este arquivo esta corrigindo.
 */
function coletarPorBinding(valor: unknown, achados: Set<string>): void {
  if (Array.isArray(valor)) {
    for (const item of valor) coletarPorBinding(item, achados)
    return
  }
  if (!ehObjeto(valor)) return
  if (typeof valor.binding === 'string') achados.add(valor.binding)
  for (const dentro of Object.values(valor)) coletarPorBinding(dentro, achados)
}

function emCaminho(config: Record<string, unknown>, caminho: readonly string[]): unknown {
  let atual: unknown = config
  for (const passo of caminho) {
    if (!ehObjeto(atual)) return undefined
    atual = atual[passo]
  }
  return atual
}

function nomesDeBinding(config: Record<string, unknown>): string[] {
  const achados = new Set<string>()

  // As `vars` publicas chegam ao Worker com o nome da propria chave. Elas
  // ficam FORA da varredura recursiva: o valor de um var pode ser um objeto
  // JSON qualquer, inclusive um que tenha uma chave chamada `binding`.
  for (const nome of Object.keys((config.vars ?? {}) as Record<string, unknown>)) achados.add(nome)

  // Os segredos declarados. Nao sao binding de recurso, mas chegam ao `env`
  // pelo mesmo nome e o teste precisa deles preenchidos.
  const segredos = (config.secrets ?? {}) as { required?: unknown }
  if (Array.isArray(segredos.required)) {
    for (const nome of segredos.required) if (typeof nome === 'string') achados.add(nome)
  }

  for (const [chave, valor] of Object.entries(config)) {
    if (chave === 'vars' || chave === 'secrets') continue
    coletarPorBinding(valor, achados)
  }

  for (const caminho of NOMEADOS_POR_NAME) {
    const lista = emCaminho(config, caminho)
    if (!Array.isArray(lista)) continue
    for (const item of lista) {
      if (ehObjeto(item) && typeof item.name === 'string') achados.add(item.name)
    }
  }

  return [...achados].sort()
}

const BINDINGS_DO_WRANGLER = nomesDeBinding(producao as unknown as Record<string, unknown>)

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: producao.main,
      miniflare: {
        compatibilityDate: producao.compatibility_date,
        compatibilityFlags: producao.compatibility_flags,
        // D1 em memoria, com o mesmo NOME de binding de producao. O id nao
        // importa: o Miniflare nao fala com a Cloudflare nos testes.
        d1Databases: ['DB'],
        bindings: {
          // As `vars` publicas vem do wrangler.jsonc, exatamente como chegam
          // ao Worker publicado. As duas do painel sao sobrescritas abaixo.
          ...producao.vars,
          META_APP_SECRET: 'segredo-de-teste',
          META_WEBHOOK_VERIFY_TOKEN: 'verify-token-de-teste',
          // base64 de exatamente 32 bytes
          TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
          SETUP_ADMIN_TOKEN: 'admin-token-de-teste',
          // Host ficticio do painel. Casa com o RAIZ de tests/fixtures/dubles.ts,
          // para que origemDoPainel(env) seja exatamente a origem das requisicoes
          // de teste. Em wrangler.jsonc este var nasce VAZIO: o endereco e de
          // quem instala, nunca do repositorio.
          PANEL_RP_ID: 'exemplo.workers.dev',
          // Allowlist de dominios VAZIA, igual ao wrangler.jsonc: e o estado
          // em que a entrega continua funcionando e o painel nao altera link
          // nem texto (§9.8). Cada teste que exercita a trava declara a
          // propria lista, do mesmo jeito que `now` e sempre injetado — uma
          // lista fixa aqui esconderia qual regra cada teste esta provando.
          ALLOWED_LINK_DOMAINS: '',
          // Raiz das quatro subchaves do painel. Ficticia, e DIFERENTE do
          // SETUP_ADMIN_TOKEN e do TOKEN_ENCRYPTION_KEY de proposito — o
          // metateste META-05 falha se alguem repetir um valor aqui.
          PANEL_SESSION_KEY: 'chave-de-sessao-do-painel-de-teste',
          // Consumido por tests/setup.ts para criar o schema antes dos testes.
          TEST_MIGRATIONS: migrations,
          // Consumido pelo metateste META-04: os nomes de binding que o
          // wrangler.jsonc declara, para conferir a propagacao ate aqui.
          TEST_BINDINGS_DO_WRANGLER: BINDINGS_DO_WRANGLER,
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // UM arquivo de cada vez, e a razao e MEDIDA, nao gosto (2026-09-09).
    //
    // Cada arquivo de teste sobe o seu proprio workerd. Rodando varios ao mesmo
    // tempo, isolates de verdade disputam CPU e sockets, e o portao unico
    // passou a mentir de tres jeitos na mesma tarde:
    //
    //   - `ECONNRESET` matando um worker inteiro: 26 arquivos "passaram" e 50
    //     testes simplesmente nao rodaram. Verde por nao ter olhado, que e o
    //     pior estado possivel de uma trava.
    //   - dois testes de teto (`TELA-19`, `TELA-20`) estourando os 5000ms
    //     padrao por espera, e nao por defeito.
    //   - o mesmo `npm run check` dando resultado diferente a cada execucao,
    //     que e o que treina uma equipe a rodar de novo em vez de investigar.
    //
    // E serial e mais RAPIDO aqui, o que encerra a discussao: 31,9s de teste
    // contra 175,6s em paralelo, na mesma arvore. O paralelismo cobrava
    // contencao e nao entregava nada em troca.
    //
    // Se um dia esta suite rodar numa maquina com muitos nucleos ociosos, meca
    // antes de tirar esta linha: o numero de cima e o que precisa ser batido.
    fileParallelism: false,
  },
})
