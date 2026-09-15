# Painel administrativo: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao dono da instalação um painel web, no próprio Worker, onde ele muda pelo celular, com digital/Face ID e sem redeploy, tudo o que hoje só existe editando TypeScript.

**Architecture:** A configuração migra de `src/config.ts` (que continua sendo a *fábrica*, intocada) para o D1, resolvida por um `config-store` com cache por isolate. O painel entra pelo `default:` do roteador existente, atrás de sessão por passkey (WebAuthn puro, sem dependência nova), com step-up biométrico preso ao conteúdo nos campos perigosos e uma allowlist de domínios que **o painel não pode alterar**. Cada etapa é entregável, testável e verificável sozinha.

**Tech Stack:** TypeScript · Cloudflare Workers (workerd) · D1 · WebAuthn/passkeys implementado à mão (CBOR/COSE/DER mínimos) · vitest + `@cloudflare/vitest-pool-workers` · Biome. **Zero dependências novas em produção.**

**Spec:** `docs/superpowers/specs/2026-09-04-painel-admin-design.md` (3510 linhas)

A spec é a autoridade e foi escrita como fonte **única** de implementação: "nada além deste arquivo precisa ser consultado para implementar". Cada tarefa abaixo aponta intervalos exatos de linha. **Leia os intervalos da sua tarefa antes de escrever qualquer linha**, os valores literais (SQL, códigos de erro, tetos, textos de tela) estão lá, não aqui.

---

## Global Constraints

Valem para **todas** as tarefas. Copiados literalmente da spec.

**Produto e configuração**
- Este é um **produto distribuído**: cada pessoa que instala tem a própria conta Cloudflare, o próprio Worker, o próprio link. **Nada específico de uma instalação pode ser hardcoded.** `PANEL_RP_ID` e `ALLOWED_LINK_DOMAINS` nascem **vazios** no repositório.
- `PANEL_RP_ID` vazio ⇒ painel em `503`. `ALLOWED_LINK_DOMAINS` vazia ⇒ o painel **não altera** link nem texto do Direct. Os dois são o padrão seguro, não um bug.
- **`PANEL_ORIGIN` não existe.** A origem esperada é sempre `'https://' + env.PANEL_RP_ID`, calculada num único helper `origemDoPainel(env)`.
- `src/config.ts` continua sendo a fábrica e **não muda nada** (§9.1).
- Checklist de propagação obrigatório para cada binding novo: `src/types/env.ts` → `wrangler.jsonc` → `.dev.vars.example` → bindings do `vitest.config.ts` → documentação. **Exceção declarada:** os três limitadores de rate limit **não** entram nos bindings de teste, de propósito.

**Nomes**
- **Um nome por conceito. Sinônimo é erro, não estilo.** Os nomes listados como "Deletado"/"Nomes deletados" em §7.7, §7.4 e §15.3 **não podem reaparecer** em nenhum arquivo.
- Erro ao cliente: `{ "erro": "<snake_case>", "mensagem": "<frase em português>" }` em JSON; em HTML, a mesma `mensagem` na tela e o mesmo `erro` no `console.warn`. A tabela canônica de códigos é a de §11.4 e é a **única**. A palavra **"payload" é proibida até em código interno**.
- `allowedMediaIds` **não é campo gravável**. O gravável é `mediaScope: 'todas' | 'selecionadas'`; `allowedMediaIds` é **derivado** das linhas ativas de `painel_midias`.

**Segurança**
- **UV = 1 obrigatório sempre**, no login e no step-up: `userVerification: "required"` nas options **e** a flag UV conferida no `authData` nos dois fluxos.
- **Origem:** exigir `Origin === origemDoPainel(env)` quando presente; se ausente, exigir `Sec-Fetch-Site: same-origin`; se os dois ausentes, `403 origem_invalida`. Comparação de **string inteira**, nunca `includes`/`startsWith`.
- **Nunca** nenhum cabeçalho `Access-Control-*`, em nenhuma hipótese; `OPTIONS` devolve `405`.
- **Nunca** `sleep`/atraso artificial na resposta, no Worker isso é DoS a favor do atacante (§11.3).
- **Nenhum índice novo em `processed_comments`, nunca** (§16.6).
- **Nunca** exibir o `credential_id` inteiro na tela (§10.13).
- O painel **nunca** executa escrita em `processed_comments`, e **nunca** inicia o fluxo OAuth. Ele lê, não age (§6).

**Testes**
- Portão único: `npm run check` (lint + typecheck + test) **verde**. Nenhuma tarefa é entregue com a anterior vermelha.
- `@cloudflare/vitest-pool-workers` (workerd real, D1 real em memória). **Nada de `vi.mock`.** Dublês são classes locais injetadas por parâmetro. `now` **sempre** injetado. `AGORA = 1_700_000_000_000`, **sem fake timers**. Nomes de teste em português descrevendo comportamento. Handlers exportados chamados direto, **não** via `SELF.fetch`.
- Cada garantia tem **ID estável**: o nome do teste em vitest **cita o ID** e o código que implementa a trava **cita o ID num comentário**. Nenhuma etapa entrega enquanto o teste do seu ID não estiver verde.
- **Os seis arquivos de teste atuais não são editados** durante as tarefas 1 a 16 (§13.2, "A regra dura"). Suítes novas, sempre.
- `tests/fixtures/*` não casa com o `include` do vitest, os helpers não viram suítes vazias.
- Nunca empurrar uma afirmação da linha dela para outra (§13.1): teste que finge cobrir o que não cobre é pior que ausência de teste.

**Arquivos fora de escopo**
- `src/routes/legal.ts` **não é movido nem editado** nas tarefas 1 a 16. `escapeHtml` continua exportado dele (`legal.ts:50`) e é **importado** por `html.ts`, não existe segunda cópia. (§16.4 é item de escopo próprio.)

**Commits**
- **NUNCA `git add -A`, `git add .` ou `git commit -a`.** Sempre `git add <caminhos exatos da sua tarefa>`.
- **NUNCA dar `git add` em `wrangler.jsonc` nem em `src/config.ts`.** A árvore de trabalho contém valores reais da instalação do dono (id do banco D1, id do app Meta, link real) que **não podem entrar num repositório público de template**. Quando a sua tarefa exigir mudança em `wrangler.jsonc`, **edite o arquivo normalmente e diga no relatório exatamente quais linhas você acrescentou**, o controlador faz o staging.

---
## Mapa de arquivos

Referência completa em §7.7 (`sed -n '592,645p' $SPEC`). Resumo do que nasce:

| Diretório | Responsabilidade |
|---|---|
| `src/routes/painel/` | 16 arquivos: `router.ts` (despacho), `rotas.ts` (tabela declarativa), `html.ts`, `resposta.ts`, `guardas.ts` + um por tela |
| `src/security/` | `signed-envelope.ts` (envelope com propósito/claims/prazo), `base64url.ts` (encode **+ decode**) |
| `src/services/` | `config-store.ts`, `config-validation.ts`, `link-allowlist.ts`, `panel-session.ts`, `panel-codes.ts`, `webauthn/{opcoes,verificar,cbor,cose,der}.ts` |
| `src/repositories/` | seis `painel-*-repository.ts` |
| `public/painel/` | `painel.css`, `painel.js`, `parar/index.html`, **três arquivos, e nada mais** |
| `migrations/` | `0002_painel_config.sql`, `0003_painel_codigos.sql`, `0004_painel_acesso.sql`, `CHECKSUMS.txt` |
| `tests/` | `fixtures/{banco,autenticador,vetores-webauthn,dubles}.ts` + 16 suítes novas |

`link-allowlist.ts` fica em **`src/services/`**, não em `src/security/` (§15.3, decisão 6).

Nas tarefas abaixo, `SPEC` = `docs/superpowers/specs/2026-09-04-painel-admin-design.md`.

---

## Task 1: Etapa 0, Rede de segurança (nenhuma linha de painel)

Congelar o presente antes de mexer nele, e corrigir aqui os três achados pré-existentes que o painel **agrava**.

**Leia primeiro (obrigatório):**

    SPEC=docs/superpowers/specs/2026-09-04-painel-admin-design.md
    sed -n '3104,3115p' $SPEC   # Etapa 0, o contrato desta tarefa
    sed -n '3441,3472p' $SPEC   # §16.1 §16.2 §16.3, os três achados a corrigir
    sed -n '2948,2973p' $SPEC   # §13.2 REG (30 garantias) + "A regra dura"
    sed -n '2785,2805p' $SPEC   # §13.1 onde cada afirmação pode morar
    sed -n '1024,1033p' $SPEC   # §8.10 isolamento nos testes
    sed -n '2936,2947p' $SPEC   # §13.2 META: metatestes

**Files:**
- Create: `tests/fixtures/banco.ts` (com `limparBanco()` **único**), `tests/fixtures/dubles.ts` (`D1Contador`)
- Create: `tests/regressao-webhook.test.ts`, `tests/regressao-oauth.test.ts`, `tests/regressao-roteamento.test.ts`
- Create: `tests/painel-metatestes.test.ts` (só o metateste de tabelas nesta tarefa)
- Create: `migrations/CHECKSUMS.txt` (SHA-256 de `0001_initial.sql`)
- Modify: `src/index.ts`, fatiamento do lote (§16.1) e troca do `.replace('{link}'...)` cru da linha 214 por `renderTemplate` (§16.3)
- Modify: `src/services/automation.ts`, remover `configForEvent` (§16.2), código morto

**Interfaces:**
- Consumes: nada. Esta é a primeira tarefa.
- Produces: `limparBanco(db)`, a **única** função de limpeza entre testes, usada por toda suíte daqui em diante. `D1Contador`, dublê que conta consultas ao D1, usado pelos testes de teto de subrequests. `migrations/CHECKSUMS.txt`, consumido pela checagem do `verificar-antes-de-publicar.mjs` na Task 16.

- [ ] **Step 1: Escrever o primeiro teste que falha**

Em `tests/regressao-webhook.test.ts`: *"REG-01: POST assinado sem cookie e sem ficha CSRF continua 200"*. Ele falha porque o arquivo não existe ainda. Esse teste congela o contrato de hoje: o webhook da Meta **não** tem cookie nem CSRF, e o painel não pode passar a exigir isso dele.

- [ ] **Step 2: Rodar e confirmar que falha pelo motivo certo**

Run: `npx vitest run tests/regressao-webhook.test.ts`
Expected: FAIL, arquivo/teste inexistente, não erro de sintaxe.

- [ ] **Step 3: Escrever os fixtures**

`tests/fixtures/banco.ts` com `limparBanco()`; `tests/fixtures/dubles.ts` com `D1Contador`. Seguir §8.10 literalmente.

- [ ] **Step 4: Escrever as três suítes de regressão (30 garantias REG)**

Congelam o comportamento de hoje **antes** de qualquer linha do painel: webhook, OAuth e roteamento. Ver `sed -n '2948,2968p' $SPEC` para a lista das garantias.

- [ ] **Step 5: Escrever o metateste de tabelas**

Todo caminho da tabela nova passa por `limparBanco()`; `PRAGMA table_info` confere o conjunto exato de colunas de cada tabela existente.

- [ ] **Step 6: Corrigir §16.1, o fatiamento do lote**

Hoje, `10 comentários × 5 consultas + 2 do lote = 52 > 50` estoura o teto de subrequests por invocação. Fatiar (p.ex. 5 comentários por invocação), com o resto reagendado pelo cron que já existe. O teste afirma que **um lote de 10 comentários executa menos de 50 consultas**, usando `D1Contador`.

- [ ] **Step 7: Corrigir §16.3, o `replace` cru**

`src/index.ts:214` monta o Direct da retentativa do cron com `.replace('{link}', ...)` **fora** de `renderTemplate`: sem remoção de caracteres de controle, sem teto de tamanho, e trocando só a **primeira** ocorrência. Trocar por `renderTemplate`, que usa `replaceAll` e sanitiza.

- [ ] **Step 8: Corrigir §16.2, remover o código morto**

`configForEvent` em `src/services/automation.ts:240` não tem nenhuma chamada. Removê-lo evita que sobre um segundo caminho lendo configuração direto do módulo, justamente quando a origem da configuração passa a ser o banco.

- [ ] **Step 9: Gerar `migrations/CHECKSUMS.txt`**

SHA-256 de `0001_initial.sql`. Migration entregue nunca é editada; o checksum é o que prova isso.

- [ ] **Step 10: Rodar o portão e commitar**

Rodar `npm run check`. Depois, staging **só** dos arquivos desta tarefa (nunca `-A`, nunca `wrangler.jsonc`, nunca `src/config.ts`):

    tests/fixtures/banco.ts tests/fixtures/dubles.ts
    tests/regressao-webhook.test.ts tests/regressao-oauth.test.ts tests/regressao-roteamento.test.ts
    tests/painel-metatestes.test.ts migrations/CHECKSUMS.txt
    src/index.ts src/services/automation.ts

Mensagem: `test: congela o comportamento atual e corrige os tres achados pre-existentes`

**Garantias verdes ao entregar:** REG-* (30), metateste de tabelas, lote de 10 comentários < 50 consultas.

**Verificação do dono:** `npm run check` verde com ~40 testes novos, produção intocada.

---

## Task 2: Etapa 1, Sessão assinada com claims (sem HTTP)

**Leia primeiro:**

    sed -n '3117,3122p' $SPEC   # Etapa 1
    sed -n '1456,1537p' $SPEC   # §10.1 segredos e subchaves · §10.2 portão de sanidade · §10.3 envelope
    sed -n '1760,1810p' $SPEC   # §10.8 sessão
    sed -n '2808,2815p' $SPEC   # §13.2 SES (13 garantias)
    sed -n '514,553p' $SPEC     # §7.4 bindings, o checklist de propagação
    sed -n '476,493p' $SPEC     # §7.2 cookies

**Files:**
- Create: `src/security/signed-envelope.ts`, `src/services/panel-session.ts`
- Create: `tests/painel-sessao.test.ts`
- Modify: `src/security/base64url.ts`, **ganha o `decode`** (hoje só existe o `encode`, e é privado). Se ainda não existir como módulo próprio, extrair de onde estiver hoje **sem mudar o comportamento do `encode`**.
- Modify: `src/types/env.ts`, `.dev.vars.example`, `vitest.config.ts`, propagar `PANEL_SESSION_KEY`
- Modify (**sem commitar**): `wrangler.jsonc`, `PANEL_SESSION_KEY` em `secrets.required`

**Interfaces:**
- Consumes: `src/security/oauth-state.ts` (`createState`/`validateState`), **não alterar**; as regressões REG de OAuth protegem isso. `signed-envelope.ts` **generaliza** esse desenho num módulo novo.
- Produces: envelope assinado com **propósito**, **claims** e **TTL parametrizável**; `origemDoPainel(env)`; as quatro subchaves derivadas de `PANEL_SESSION_KEY` (`k_sessao`, `k_desafio`, `k_csrf`, `k_codigos`). Consumido por praticamente todas as tarefas seguintes.

- [ ] **Step 1: Teste que falha**, *"SES: envelope de propósito errado não autoriza step-up"*.
- [ ] **Step 2: Rodar e confirmar a falha pelo motivo certo.**
- [ ] **Step 3: `base64url.ts` ganha o `decode`**, com teste próprio. O `encode` não muda de comportamento.
- [ ] **Step 4: `signed-envelope.ts`**, propósito, claims, TTL parametrizável. **Assinatura conferida antes do prazo** (preserva o comportamento de `oauth-state.ts`). Desafio de **registro dura 300 s**; os demais, 120 s (§15.4).
- [ ] **Step 5: `PANEL_SESSION_KEY` e as quatro subchaves.** Nunca reusar `SETUP_ADMIN_TOKEN` nem `TOKEN_ENCRYPTION_KEY`. Propagar pelos cinco lugares do checklist de §7.4.
- [ ] **Step 6: O portão de sanidade (§10.2)**, o furo mais fácil de deixar aberto. Atenção: o binding ausente chega como `undefined`, **não** como string vazia; `env.PANEL_RP_ID.length` sem `typeof` lança `TypeError`.
- [ ] **Step 7: As 13 garantias SES + os metatestes de binding.**
- [ ] **Step 8: `npm run check` e commit** (sem `wrangler.jsonc`; relatar no relatório exatamente as linhas acrescentadas).

**Garantias verdes:** SES (13), metatestes de binding.

**Verificação do dono:** nenhuma tela ainda, `npm run check` verde. Esta etapa não tem HTTP, de propósito.

---

## Task 3: Etapa 2, Config no D1, só leitura

**Leia primeiro:**

    sed -n '3124,3130p' $SPEC   # Etapa 2
    sed -n '663,707p' $SPEC     # §8.1 §8.2 §8.3, as quatro regras contra o CREATE TABLE IF NOT EXISTS silencioso
    sed -n '708,859p' $SPEC     # §8.4 migrations/0002_painel_config.sql (SQL literal)
    sed -n '960,1033p' $SPEC    # §8.7 a §8.10
    sed -n '1036,1146p' $SPEC   # §9.1 a §9.5
    sed -n '1147,1270p' $SPEC   # §9.6 cache por isolate · §9.7 o validador único
    sed -n '1436,1449p' $SPEC   # §9.12 como cada armadilha de resolveConfigForMedia morre
    sed -n '2877,2887p' $SPEC   # §13.2 CFG (18 garantias)

**Files:**
- Create: `migrations/0002_painel_config.sql`, `src/repositories/painel-config-repository.ts`, `src/services/config-store.ts`, `src/services/config-validation.ts`
- Create: `tests/painel-config-store.test.ts`
- Modify: `migrations/CHECKSUMS.txt` (acrescentar o SHA da 0002)
- **NÃO tocar:** `src/config.ts`

**Interfaces:**
- Consumes: `limparBanco()` da Task 1.
- Produces: `config-store.ts` expõe o **snapshot** com `origem: 'arquivo' | 'banco'`, o cache por isolate com **TTL assimétrico**, e `invalidarCacheDeConfig()`, chamado por toda tarefa que grava. `config-validation.ts` expõe **um só validador**, usado na escrita **e** na leitura.

- [ ] **Step 1: Teste que falha**, *"CFG: linha ausente usa o padrão de fábrica com `origem: 'arquivo'`"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: `0002_painel_config.sql`**, SQL literal em §8.4. Respeitar §8.3: `CHECK` = teto absurdo, validador = regra de produto. As quatro regras de §8.2 contra o `CREATE TABLE IF NOT EXISTS` silencioso valem aqui.
- [ ] **Step 4: `painel-config-repository.ts` + `config-store.ts`.** §9.3: `NULL` vira **chave ausente**, não valor. §9.5: **uma carga por lote**, nunca por comentário. §9.4: `allowedMediaIds` é **derivado**.
- [ ] **Step 5: `config-validation.ts`**, o validador único, dois chamadores (§9.7).
- [ ] **Step 6: Falha segura.** Configuração corrompida faz a automação **parar**, nunca "consertar". **Nenhum campo inválido é substituído por valor de fábrica em nenhum caminho.** Tabela inexistente tem tratamento próprio (§15.2 pendência 14).
- [ ] **Step 7: As 18 garantias CFG + a primeira versão do `PRAGMA table_info`.**
- [ ] **Step 8: `npm run check` e commit.**

**Garantias verdes:** CFG (18), `PRAGMA table_info` parcial.

**Verificação do dono:** insere uma linha por `wrangler d1 execute` e vê a automação mudar de comportamento **sem redeploy**; corrompe a linha à mão e vê a automação **parar**, não "consertar".

---

## Task 4: Etapa 3, Allowlist de domínios (função pura)

**Leia primeiro:**

    sed -n '3132,3135p' $SPEC   # Etapa 3
    sed -n '1271,1321p' $SPEC   # §9.8 a allowlist de domínios
    sed -n '2847,2855p' $SPEC   # §13.2 LNK (16 garantias)

**Files:**
- Create: `src/services/link-allowlist.ts` (**`services/`**, não `security/`, §15.3 decisão 6)
- Create: `tests/painel-allowlist.test.ts`
- Modify: `src/types/env.ts`, `.dev.vars.example`, `vitest.config.ts`, propagar `ALLOWED_LINK_DOMAINS`
- Modify (**sem commitar**): `wrangler.jsonc`, `ALLOWED_LINK_DOMAINS: ""` em `vars`, **nascendo vazia**

**Interfaces:**
- Consumes: `config-store.ts` da Task 3.
- Produces: a allowlist aplicada **já na leitura** da config, em **link e em texto**, não só na escrita. Consumida pelas Tasks 11 e 12.

- [ ] **Step 1: Teste que falha**, *"LNK: `http://` com host permitido é recusado"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: Implementar.** Separada por vírgula, minúscula, punycode. Host exato aceito; subdomínio conforme a regra de §9.8. Aplicada em link **e** em texto. Lista vazia ⇒ o painel não altera link nem texto.
- [ ] **Step 4: As 16 garantias LNK.** Incluindo: **restaurar uma versão da auditoria com link hoje proibido é recusado pelo mesmo validador**.
- [ ] **Step 5: `npm run check` e commit.**

**Garantias verdes:** LNK-01 a LNK-15 (16).

**Verificação do dono:** com a allowlist estreita e um link fora dela no banco, a automação para.

---

## Task 5: Etapa 4, Parada de emergência, códigos, e o nascimento da auditoria

Entregue **antes** do painel, de propósito: o dono ganha o botão de pânico enquanto o resto ainda está sendo construído.

**Leia primeiro:**

    sed -n '3137,3160p' $SPEC   # Etapa 4: inclui a contabilidade de escrita das duas pontas
    sed -n '860,885p' $SPEC     # §8.5 migrations/0003_painel_codigos.sql
    sed -n '976,1023p' $SPEC    # §8.8 atomicidade e versionamento · §8.9 poda sem COUNT(*)
    sed -n '1891,2003p' $SPEC   # §10.11 códigos de recuperação · §10.12 código de parada
    sed -n '1322,1388p' $SPEC   # §9.9 auditoria: dois destinos, duas regras opostas · §9.10 contabilidade
    sed -n '2279,2318p' $SPEC   # §11.6 as duas rotas da parada · §11.7 o que pode ser logado
    sed -n '2865,2876p' $SPEC   # §13.2 STOP (14 garantias)

**Files:**
- Create: `migrations/0003_painel_codigos.sql`, `src/services/panel-codes.ts`, `src/repositories/painel-codigos-repository.ts`, `src/repositories/painel-auditoria-repository.ts`
- Create: `src/routes/painel/parada.ts`, `public/painel/parar/index.html`
- Create: `tests/painel-parada.test.ts`
- Modify: `src/index.ts`, `POST /painel/parada`, `GET /painel/parar`, `POST /setup/painel/codigos`, e a poda no cron
- Modify: `migrations/CHECKSUMS.txt`

**Interfaces:**
- Consumes: `signed-envelope.ts` (subchave `k_codigos`) da Task 2; `config-store.ts` da Task 3.
- Produces: `painel_auditoria` **começa a receber escrita aqui**, não na Task 11. `panel-codes.ts` (geração, normalização, verificação) é consumido pela Task 14.

**Contabilidade de escrita: é ela que os testes afirmam:**
- `POST /setup/painel/codigos`: **1 lote** = `DELETE` do conjunto antigo + 7 `INSERT` + **1 linha de auditoria** (`origem='assistente'`, `ator='assistente'`, `antes = depois = NULL`).
- `POST /painel/parada` com código correto e automação ligada: **2 escritas** = `UPDATE` de `painel_config` (`enabled=0`, `parado_por_codigo_em`, `versao+1`) + **1 linha de auditoria** (`origem='parada'`, `ator='parada'`, `antes = depois = NULL`).
- `POST /painel/parada` repetida, ou com código errado: **0 escritas**, auditoria inclusive.

- [ ] **Step 1: Teste que falha**, *"STOP: código correto via POST desliga sem sessão"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: `0003_painel_codigos.sql` + os dois repositórios.**
- [ ] **Step 4: `panel-codes.ts`**, o **Worker** gera os 6+1 códigos; o texto é devolvido **uma única vez**. 100 bits de entropia (§10.11).
- [ ] **Step 5: `POST /painel/parada` e o asset `public/painel/parar/index.html`.** §11.1: a parada é desviada **antes** do portão de sanidade. `GET /painel/parada` **redireciona** (§11.6). Corpo de **1 KB**.
- [ ] **Step 6: `POST /setup/painel/codigos`** sob `SETUP_ADMIN_TOKEN`.
- [ ] **Step 7: A poda de 500 linhas entra no cron**, porque a tabela já recebe linhas. **Sem `COUNT(*)`** (§8.9).
- [ ] **Step 8: As 14 garantias STOP**, incluindo a contabilidade das duas pontas e `PANEL_RP_ID` ausente chegando como `undefined`.
- [ ] **Step 9: `npm run check` e commit.**

**Garantias verdes:** STOP (14), corpo de 1 KB, auditoria nasce.

**Verificação do dono:** do celular, **deslogado**, desliga a automação com o código impresso no papel, e lê uma frase que diz claramente se deu certo.

---
## Task 6: Etapa 5, Rate limit

**Leia primeiro:**

    sed -n '3162,3165p' $SPEC   # Etapa 5
    sed -n '514,553p' $SPEC     # §7.4 os três limitadores, as chaves de balde e a troca declarada
    sed -n '2924,2930p' $SPEC   # §13.2 RL (10 garantias)
    sed -n '3017,3046p' $SPEC   # §13.4 rate limit e o contador de consultas

**Files:**
- Create: `src/routes/painel/guardas.ts` (só a função `limitar()` nesta tarefa; o resto nasce na Task 9)
- Create: `tests/painel-rate-limit.test.ts`
- Modify: `src/routes/painel/parada.ts`, aplicar já na rota de parada
- Modify (**sem commitar**): `wrangler.jsonc`, os **três** bindings `ratelimits` opcionais
- **NÃO** acrescentar os limitadores aos bindings de teste do `vitest.config.ts`, é exceção declarada em §7.4

**Interfaces:**
- Consumes: `parada.ts` da Task 5.
- Produces: a porta `Limitador` com **três implementações**. Consumida pelas Tasks 8, 9 e 14.

**Chaves de balde (há teste que as afirma):** `PANEL_LIMITER_LOGIN` usa `"painel:" + cf-connecting-ip`; `PANEL_LIMITER_CODIGO` usa `"codigo:" + cf-connecting-ip`; `PANEL_LIMITER_STOP` usa `"parada:" + cf-connecting-ip`. Requisição **sem** `CF-Connecting-IP` cai no balde global daquele prefixo (`"painel:global"`, `"codigo:global"`, `"parada:global"`) e **continua limitada, nunca passa livre**.

- [ ] **Step 1: Teste que falha**, *"RL: a décima primeira tentativa em 60 s é recusada com 429"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: A porta `Limitador` com as três implementações.** São três bindings e não um porque `limit` é fixo por binding e `period` só aceita 10 ou 60.
- [ ] **Step 4: Aplicar na rota de parada.**
- [ ] **Step 5: Ausentes os bindings, o painel funciona sem a camada.** Nada do desenho pode depender deles para estar correto, e o ambiente de teste segue **sem** eles, de propósito, justamente para provar isso.
- [ ] **Step 6: As 10 garantias RL**, incluindo a chave enviada ser a esperada.
- [ ] **Step 7: `npm run check` e commit.**

**Garantias verdes:** RL (10).

**Verificação do dono:** nada visível, é camada de defesa. `npm run check` verde.

---

## Task 7: Etapa 6, Verificação WebAuthn (pura, sem rota)

A maior massa de testes do projeto. **Zero dependência nova**: CBOR, COSE e DER são escritos à mão, no mínimo necessário.

**Leia primeiro:**

    sed -n '3167,3171p' $SPEC   # Etapa 6
    sed -n '2832,2846p' $SPEC   # §13.2 WA (29 garantias)
    sed -n '2974,3016p' $SPEC   # §13.3 como testar WebAuthn sem hardware (T2: duas fontes independentes)
    sed -n '646,662p' $SPEC     # §7.8 UV = 1 obrigatório sempre

**Files:**
- Create: `src/services/webauthn/cbor.ts`, `cose.ts`, `der.ts`, `verificar.ts`, `opcoes.ts`
- Create: `tests/fixtures/autenticador.ts` (`AutenticadorFalso`), `tests/fixtures/vetores-webauthn.ts` (vetores congelados de hardware real)
- Create: `tests/painel-webauthn.test.ts`

**Interfaces:**
- Consumes: `signed-envelope.ts` da Task 2 (o desafio é um envelope com propósito e prazo).
- Produces: verificação completa de attestation e assertion, ES256 **e** RS256. Consumida pelas Tasks 8, 9, 12 e 14.

**Método T2: duas fontes independentes, e o motivo:** só o `AutenticadorFalso` daria testes **simétricos** (o mesmo autor comete o mesmo erro dos dois lados e tudo passa); só os vetores dariam cobertura pobre. Juntos, o software gera variação e os vetores provam que a variação corresponde ao mundo real.

- [ ] **Step 1: Teste que falha**, *"WA: assertion ES256 válida é aceita"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: CBOR mínimo, COSE→JWK, DER→raw.**
- [ ] **Step 4: `AutenticadorFalso`**, autenticador de software escrito no próprio repositório.
- [ ] **Step 5: Capturar os vetores congelados de hardware real.** Isto **exige o checklist manual de hardware nesta etapa**, não no fim. Se você não puder capturar vetores de hardware, **pare e reporte `BLOCKED`**, não invente vetores, não pule o item, não substitua por saída do `AutenticadorFalso`: isso destruiria exatamente a independência que T2 existe para garantir.
- [ ] **Step 6: A verificação completa.** ES256 **e** RS256 aceitos; desafio expirado recusado; desafio de outro propósito recusado; **`UV=0` recusado**.
- [ ] **Step 7: As 29 garantias WA.**
- [ ] **Step 8: `npm run check` e commit.**

**Garantias verdes:** WA (26 de 29). As outras tres nao cabem nesta task, e o
plano registra para onde elas vao em vez de deixar a conta fechada no papel:

- **WA-16** (`r` de 31 bytes em DER) fica **BLOCKED com o Step 5**: §13.3 manda o
  `r` curto vir do vetor de hardware, nao do `AutenticadorFalso`, e o conversor
  puro ja e exercitado com `r = 31` no teste de DER. Volta a verde no dia em que
  o vetor chegar: o laco dos vetores ja confere `der[3] === 31` por nome.
- **WA-25** (corpo de `/painel/api/*` acima de 8 KB) migra para a **Task 8**: a
  familia de rotas `/painel/api/` nasce la.
- **WA-28** (corpo de formulario acima de 32 KB) migra para a **Task 9**, que ja
  declara "corpo de 32 KB" entre as garantias verdes dela.

**Verificação do dono:** ainda sem tela. `npm run check` verde, e o checklist de hardware desta etapa assinado.

---

## Task 8: Etapa 7, Convite de uso único e registro da primeira passkey

**Decisão do dono já tomada:** o `rpId` fica no endereço `.workers.dev` do próprio Worker de cada instalação. `PANEL_RP_ID` nasce **vazio** no repositório e é preenchido por quem instala. O `rpId` é gravado dentro da passkey e **não pode ser corrigido depois**.

**Leia primeiro:**

    sed -n '3173,3178p' $SPEC   # Etapa 7
    sed -n '886,959p' $SPEC     # §8.6 migrations/0004_painel_acesso.sql
    sed -n '1538,1606p' $SPEC   # §10.4 as três, e apenas três, autorizações de registro
    sed -n '1607,1669p' $SPEC   # §10.5 verificação da attestation
    sed -n '1670,1699p' $SPEC   # §10.6 prova de que não existe janela para um estranho se registrar
    sed -n '2822,2831p' $SPEC   # §13.2 CONV (12 garantias)
    sed -n '2045,2065p' $SPEC   # §10.14 a consequência do rpId preso ao workers.dev

**Files:**
- Create: `migrations/0004_painel_acesso.sql`, `src/repositories/painel-credenciais-repository.ts`, `src/repositories/painel-sessoes-repository.ts`
- Create: `src/routes/painel/registrar.ts`
- Create: `tests/painel-convite.test.ts`
- Modify: `src/index.ts` (rotas de convite), `migrations/CHECKSUMS.txt`
- Modify (**sem commitar**): `wrangler.jsonc`, `PANEL_RP_ID: ""` em `vars`

**Interfaces:**
- Consumes: WebAuthn da Task 7; envelope da Task 2; `Limitador` da Task 6.
- Produces: `GET /painel/convite`, `POST /painel/api/registrar/opcoes`, `POST /painel/api/registrar/verificar`. Consumidos pelas Tasks 9 e 14.

**Contrato crítico:** `POST /painel/api/registrar/verificar` **não emite sessão**. Três escritas no caso do convite (consumo do nonce, credencial, auditoria). A sessão nasce **sempre** de um login com `webauthn.get` e UV conferido, num ponto único do código (§15.3 decisão 5).

- [ ] **Step 1: Teste que falha**, *"CONV: convite usado duas vezes falha na segunda"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: `0004_painel_acesso.sql` + os dois repositórios.**
- [ ] **Step 4: As três, e apenas três, autorizações de registro (§10.4).** Nenhuma quarta.
- [ ] **Step 5: `registro sem convite e sem código é recusado ANTES de gerar as options`.** Com passkey já cadastrada, o convite é recusado.
- [ ] **Step 6: O teste do caminho único de `INSERT`** e a prova de §10.6: não existe janela em que um estranho se registre.
- [ ] **Step 7: `/painel/api/registrar/opcoes` exige ficha CSRF no modo sessão** (§15.4), cadastrar passkey nova é precisamente a operação que um atacante mais gostaria de executar em nome do dono.
- [ ] **Step 8: As 12 garantias CONV + `PRAGMA table_info` completo.**
- [ ] **Step 9: `npm run check` e commit.**

**Garantias verdes:** CONV (12), **WA-25** (herdada da Task 7: corpo de `/painel/api/*` acima de 8 KB recusado antes do parse), `PRAGMA table_info` completo.

**Verificação do dono:** gera o convite no terminal e registra a passkey do próprio celular; tenta de novo com o mesmo link e é **recusado**.

---

## Task 9: Etapa 8, Login, cookie e o portão de rotas

**Leia primeiro:**

    sed -n '3180,3186p' $SPEC   # Etapa 8
    sed -n '412,493p' $SPEC     # §7.1 rotas (a tabela canônica) · §7.2 cookies
    sed -n '1700,1829p' $SPEC   # §10.7 login · §10.8 sessão · §10.9 CSRF: cinco camadas
    sed -n '2068,2189p' $SPEC   # §11.1 onde o painel entra · §11.2 assets · §11.3 escada de verificação
    sed -n '2190,2278p' $SPEC   # §11.4 tabela canônica de erros · §11.5 cabeçalhos e CSP
    sed -n '2319,2346p' $SPEC   # §11.8 separação painel/webhook/OAuth, sete regras verificáveis
    sed -n '2816,2821p' $SPEC   # §13.2 CSRF (9 garantias)
    sed -n '2936,2947p' $SPEC   # §13.2 META (9 metatestes)

**Files:**
- Create: `src/routes/painel/rotas.ts`, `router.ts`, `html.ts`, `resposta.ts`, `entrar.ts`
- Create: `public/painel/painel.css`, `public/painel/painel.js`
- Create: `tests/painel-csrf.test.ts`, `tests/painel-rotas.test.ts`
- Modify: `src/routes/painel/guardas.ts`, `exigirSessao()`, `exigirCsrf()`, `exigirOrigem()` (o `exigirStepUp()` nasce na Task 12)
- Modify: `src/index.ts`, o painel entra pelo `default:` do roteador
- Modify: `tests/painel-metatestes.test.ts`, os metatestes de rota

**Interfaces:**
- Consumes: Tasks 2, 6, 7, 8.
- Produces: a tag `` html`` `` com escape por padrão, `cru()`, `pagina()`, `cabecalhos(perfil)`; `erro()`, `redirecionar()`, `json()`; a tabela declarativa `{caminho, metodos, sessao, csrf, stepUp}` que os metatestes leem. **Toda tela das Tasks 10 a 15 é construída sobre isto.**

- [ ] **Step 1: Teste que falha**, *"META: toda rota exige sessão, salvo a allowlist escrita no teste"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: `rotas.ts` + `router.ts`.** Despacho por **switch de string exata** + método. Nenhum caminho tem segmento variável. Três POSTs só renderizam, a tabela carrega `escreve: true | false` para o metateste afirmar a regra sem nascer contra o desenho (§15.4).
- [ ] **Step 4: `html.ts`** importando `escapeHtml` de `legal.ts:50`, **sem segunda cópia**.
- [ ] **Step 5: `resposta.ts`** com a tabela canônica de erros de §11.4. As nove grafias divergentes de §15.3 decisão 2 estão **deletadas**.
- [ ] **Step 6: `guardas.ts`, CSRF em cinco camadas (§10.9)** e a escada de verificação do mais barato ao mais caro (§11.3). **Sem `sleep`.**
- [ ] **Step 7: Cabeçalhos e CSP (§11.5).** CSP canônica em toda página, **sem `unsafe-inline`** e sem nonce; CSS e JS externos.
- [ ] **Step 8: `GET /painel/entrar` renderiza com 0 consulta ao D1.**
- [ ] **Step 9: `src/index.ts`, o painel entra pelo `default:`.** As sete regras verificáveis de §11.8 de separação entre painel, webhook e OAuth.
- [ ] **Step 10: As garantias CSRF (9), HDR de cabeçalho, META de rota (9), corpo de 32 KB.**
- [ ] **Step 11: `npm run check` e commit.**

**Garantias verdes:** CSRF (9), HDR de cabeçalho, META de rota (9), corpo de 32 KB.

**Verificação do dono:** entra no painel **com a digital** e vê uma página que ainda não edita nada.

---

## Task 10: Etapa 9, Leitura da configuração na tela

**Leia primeiro:**

    sed -n '3188,3194p' $SPEC   # Etapa 9
    sed -n '2400,2449p' $SPEC   # §12.1 as seis regras que governam toda a tela · §12.2 fluxos
    sed -n '2645,2695p' $SPEC   # §12.7 catálogo de erros na tela, e o glossário
    sed -n '2696,2761p' $SPEC   # §12.8 os cinco trabalhos do painel.js · §12.9 celular · §12.10 orçamento por tela
    sed -n '2911,2923p' $SPEC   # §13.2 HDR (10 garantias)
    sed -n '136,263p' $SPEC     # §3 o que o painel deixa fazer, tela por tela

**Files:**
- Create: `src/routes/painel/inicio.ts`, `palavras.ts`, `mensagem.ts`, `ajustes.ts`, `atividade.ts`
- Create: `tests/painel-telas.test.ts`
- Modify: `public/painel/painel.css`, `public/painel/painel.js`

**Interfaces:**
- Consumes: `html.ts`/`resposta.ts`/`guardas.ts` da Task 9; `config-store.ts` da Task 3.
- Produces: o **dicionário de tradução** (nome técnico → frase em português), consumido pelas Tasks 11 a 15.

- [ ] **Step 1: Teste que falha**, *"HDR: valor vindo do banco interpolado no HTML passa por `escapeHtml`"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: Início, Palavras, Mensagem e Ajustes em modo leitura.**
- [ ] **Step 4: `/painel/atividade` na versão SEM lista**, três estados grandes + pendências com botão. Lendo só `painel_config`, `painel_midias` e `account_tokens`. A lista com o @ ao vivo é a Task 15.
- [ ] **Step 5: O dicionário de tradução e as garantias de escape**, incluindo o laço de `<script>`.
- [ ] **Step 6: Celular e acessibilidade (§12.9) e o orçamento por tela (§12.10).**
- [ ] **Step 7: As 10 garantias HDR.**
- [ ] **Step 8: `npm run check` e commit.**

**Garantias verdes:** HDR-06 e o laço de `<script>`, dicionário.

**Verificação do dono:** vê, do celular, a configuração que hoje só existe em TypeScript.

---

## Task 11: Etapa 10, Escrita dos campos de risco baixo

**Leia primeiro:**

    sed -n '3196,3203p' $SPEC   # Etapa 10
    sed -n '1322,1388p' $SPEC   # §9.9 auditoria: dois destinos, duas regras opostas · §9.10 contabilidade
    sed -n '976,998p' $SPEC     # §8.8 atomicidade e versionamento
    sed -n '2450,2482p' $SPEC   # §12.3 sinalização do que é perigoso · §12.4 limites das palavras-gatilho
    sed -n '2931,2935p' $SPEC   # §13.2 AUD (5 garantias)

**Files:**
- Modify: `src/routes/painel/palavras.ts`, `ajustes.ts`, `inicio.ts`, os POSTs
- Create: `tests/painel-auditoria.test.ts`
- Modify: `src/repositories/painel-auditoria-repository.ts`, as linhas com `antes`/`depois`

**Interfaces:**
- Consumes: `config-validation.ts` (Task 3), `link-allowlist.ts` (Task 4), `painel-auditoria-repository.ts` (Task 5).
- Produces: o padrão POST → `303` → `GET ...?ok=`, reusado pelas Tasks 12 a 14. A rota normal de gravação, reusada pelo botão "Voltar a esta versão".

**A Task 5 já criou a auditoria.** Esta tarefa acrescenta apenas as linhas de **mudança de configuração**, que são as únicas que preenchem `antes` e `depois` (§15.3 decisão 4).

- [ ] **Step 1: Teste que falha**, *"AUD: desligar a automação não exige step-up"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: POST → `303` → `GET ...?ok=`.** Gatilhos, flags de normalização, `enabled`, cooldown **para cima**.
- [ ] **Step 4: A auditoria de configuração com `antes`/`depois` completos no D1 e NENHUM valor no `console`**, os dois destinos têm regras **opostas** (§9.9).
- [ ] **Step 5: `invalidarCacheDeConfig()` em toda gravação.** Atomicidade e `versao+1` conforme §8.8.
- [ ] **Step 6: O bloco somente-leitura de histórico no fim de `/painel/ajustes`**, com o botão "Voltar a esta versão", que **reenvia o `antes` pela rota normal de gravação, com a allowlist de hoje**. Sem rota nova.
- [ ] **Step 7: `antes`/`depois` de linha de mídia carregam só os campos de comportamento**, `legenda_curta` é recorte da `caption`, que está na lista de proibidos (§15.4).
- [ ] **Step 8: As 5 garantias AUD + a restauração.**
- [ ] **Step 9: `npm run check` e commit.**

**Garantias verdes:** AUD (5) com `antes`/`depois`, restauração.

**Verificação do dono:** muda uma palavra-gatilho pelo celular e vê valer **sem redeploy**; abre o histórico e vê o valor anterior.

---

## Task 12: Etapa 11, Step-up e os campos de risco alto

**Leia primeiro:**

    sed -n '3205,3211p' $SPEC   # Etapa 11
    sed -n '1830,1890p' $SPEC   # §10.10 step-up: uma operação, presa ao conteúdo
    sed -n '2450,2460p' $SPEC   # §12.3 sinalização do que é perigoso
    sed -n '2856,2864p' $SPEC   # §13.2 STEP (17 garantias)

**Files:**
- Create: `src/routes/painel/stepup.ts`
- Modify: `src/routes/painel/guardas.ts`, `exigirStepUp()`
- Modify: `src/routes/painel/mensagem.ts`, os campos de risco alto
- Create: `tests/painel-stepup.test.ts`

**Interfaces:**
- Consumes: WebAuthn (Task 7), `guardas.ts` (Task 9), o padrão de gravação (Task 11).
- Produces: `json_canonico`, `op_hash`, o cookie `__Host-painel_stepup`. Consumidos pelas Tasks 13 e 14.

**Regra que NÃO vale (revertida em §15.4):** ligar a automação **não** exige step-up. Religar não muda valor nenhum, e cobrar biometria de quem acabou de usar o freio de emergência é punir o uso correto. `/painel/chave` → step-up **não**.

- [ ] **Step 1: Teste que falha**, *"STEP: step-up ausente bloqueia o texto do Direct"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: Classificação de risco por campo** e `POST /painel/api/stepup/opcoes`.
- [ ] **Step 4: O cookie `__Host-painel_stepup`.** O prefixo `__Host-` fica, **não há plano B aceitável** (§15.2 pendência 11).
- [ ] **Step 5: `json_canonico` especificado e testado; `op_hash` recalculado NO SERVIDOR.** Uma operação, **presa ao conteúdo**, não é um "modo autorizado" por tempo.
- [ ] **Step 6: A tela intermediária "Confira o que vai mudar"** mostrando o **valor literal**. Em `/painel/mensagem`, a tela diz **antes do gesto** que aquele toque cobre a tela inteira (§15.4).
- [ ] **Step 7: As 17 garantias STEP.** `UV=0` recusado; fora dos 120 s bloqueia.
- [ ] **Step 8: `npm run check` e commit.**

**Garantias verdes:** STEP (17).

**Verificação do dono:** trocar o link **sem** digital é barrado; **com** digital funciona; link fora da allowlist é barrado **mesmo com digital**; e duas mudanças seguidas pedem **duas** digitais.

---

## Task 13: Etapa 12, Reels e automações por mídia (a prioridade do dono)

É o que ele pediu em primeiro lugar.

**Leia primeiro:**

    sed -n '3213,3217p' $SPEC   # Etapa 12
    sed -n '155,184p' $SPEC     # §3 "Meus Reels" e "Este Reel responde diferente"
    sed -n '2483,2517p' $SPEC   # §12.5 os quatro estados especiais da tela de Reels
    sed -n '2888,2895p' $SPEC   # §13.2 MID (13 garantias)
    sed -n '1104,1122p' $SPEC   # §9.4 derivação de allowedMediaIds

**Files:**
- Create: `src/routes/painel/reels.ts`, `src/repositories/painel-midias-repository.ts`
- Create: `tests/painel-midias.test.ts`

**Interfaces:**
- Consumes: `meta-api.ts` (existente), step-up (Task 12), o padrão de gravação (Task 11).
- Produces: `mediaScope: 'todas' | 'selecionadas'` gravável; `allowedMediaIds` **derivado** das linhas ativas de `painel_midias`.

- [ ] **Step 1: Teste que falha**, *"MID: `media_id` de 18 dígitos sobrevive ao round-trip sem virar `Number`"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: Listagem paginada com miniatura e legenda.** **Nunca** uma chamada extra por item, se `media_product_type`/`caption` não vierem na listagem, filtrar por `media_type=VIDEO` e rotular "vídeo/Reel" (§15.2 pendência 7).
- [ ] **Step 4: Seleção por clique, `mediaScope`, sobreposições por mídia, unicidade de `media_id`.**
- [ ] **Step 5: `/painel/reel?midia=` casa por query string**, **nenhum caminho tem segmento variável**.
- [ ] **Step 6: Os quatro estados especiais da tela de Reels (§12.5).**
- [ ] **Step 7: As 13 garantias MID.** Id que não casa é recusado.
- [ ] **Step 8: `npm run check` e commit.**

**Garantias verdes:** MID (13).

**Verificação do dono:** **escolhe os Reels clicando.**

---

## Task 14: Etapa 13, Recuperação, múltiplos aparelhos e revogação

**Leia primeiro:**

    sed -n '3219,3223p' $SPEC   # Etapa 13
    sed -n '1891,1940p' $SPEC   # §10.11 códigos de recuperação
    sed -n '2004,2065p' $SPEC   # §10.13 várias passkeys e a regra da última · §10.14 rpId
    sed -n '234,246p' $SPEC     # §3 "Aparelhos e códigos de recuperação"

**Files:**
- Create: `src/routes/painel/aparelhos.ts`
- Modify: `src/routes/painel/entrar.ts`, `GET`+`POST /painel/entrar/codigo`
- Modify: `src/routes/painel/registrar.ts`, o modo recuperação
- Modify: `src/index.ts`, `POST /setup/painel/zerar`
- Create: `tests/painel-recuperacao.test.ts`

**Interfaces:**
- Consumes: `panel-codes.ts` (Task 5), registro (Task 8), step-up (Task 12).
- Produces: nada consumido adiante. É a rede de segurança do dono.

**Contrato crítico (§15.3 decisão 1):** `POST /painel/entrar/codigo` **NÃO emite sessão**. O código de recuperação só permite **cadastrar uma passkey nova**, um código não pode virar senha. O POST faz **1 leitura**, **não consome** o código, e renderiza a tela "crie a passkey nova". O consumo acontece em `/painel/api/registrar/verificar` (5 escritas no caso de recuperação).

- [ ] **Step 1: Teste que falha**, *"apagar a linha invalida a sessão emitida"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: Entrada por código de recuperação**, sob `PANEL_LIMITER_CODIGO`.
- [ ] **Step 4: Várias passkeys, teto de 10, e a regra da última (§10.13).**
- [ ] **Step 5: Tela de Aparelhos** com apelido e flags BE/BS. **Nunca exibir o `credential_id` inteiro.**
- [ ] **Step 6: Remoção com step-up; geração de códigos pela tela com step-up.** `POST /painel/aparelhos` com `acao=sair_de_tudo` **NÃO** exige step-up, **desligar é barato** (§10.10, §15.4).
- [ ] **Step 7: `POST /setup/painel/zerar`.**
- [ ] **Step 8: `npm run check` e commit.**

**Garantias verdes:** recuperação, aparelhos, rotas administrativas.

**Verificação do dono:** **ensaio completo de perda de aparelho, feito de verdade.**

---

## Task 15: Etapa 14, "O que aconteceu" com o @ ao vivo

**PRÉ-REQUISITO:** o teste `[V]` de §12.6 (leitura de nó de comentário por id devolve `username`) precisa ter sido feito em **conta real** antes desta tarefa. Se ele falhar, a decisão já tomada em §15.1 pergunta 3 é: **subir sem o arroba** (lista com horário e resultado), não sem a lista.

**Leia primeiro:**

    sed -n '3225,3233p' $SPEC   # Etapa 14
    sed -n '2518,2644p' $SPEC   # §12.6 "O que aconteceu": o @ ao vivo, especificado
    sed -n '2896,2910p' $SPEC   # §13.2 ATV (11 garantias)
    sed -n '108,135p' $SPEC     # §2.3 a decisão do dono sobre esta tela
    sed -n '3487,3493p' $SPEC   # §16.6 nenhum índice novo em processed_comments

**Files:**
- Modify: `src/routes/painel/atividade.ts`, a versão com lista
- Create: `tests/painel-atividade.test.ts`

**Interfaces:**
- Consumes: `comments-repository.ts` (existente, `CommentStatus` em `comments-repository.ts:11-20`), `meta-api.ts`.
- Produces: nada consumido adiante.

**A tela não sobe sem esta frase:** o aviso obrigatório de que **só os comentários atendidos aparecem** (§12.6). Sem ela, a etapa entrega menos do que §3 promete. Motivo: todos os `skipped` acontecem **antes** do único `INSERT` da tabela, e **não** passamos a gravar linha para comentário ignorado, a conta de escrita proíbe.

- [ ] **Step 1: Teste que falha**, *"ATV: a tela não emite mais de 20 chamadas à Meta"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: Consulta paginada a `processed_comments` com colunas nomeadas.** **Nenhum índice novo**, nunca. **Nenhuma consulta do painel retorna `commenter_scoped_id_hash`.** **O painel nunca executa escrita em `processed_comments`.**
- [ ] **Step 4: A busca do @ em blocos de 6**, com o orçamento de subrequests **conferido antes de disparar**.
- [ ] **Step 5: Texto de comentário apagado; degradação quando a Graph API falha; "Ver mais".**
- [ ] **Step 6: O dicionário de `CommentStatus`**, e **só** ele. `SkipReason` e `ProcessOutcome` são resultados em memória e **não chegam ao banco** (§15.3 decisão 7).
- [ ] **Step 7: O aviso obrigatório na tela.**
- [ ] **Step 8: As 11 garantias ATV.**
- [ ] **Step 9: `npm run check` e commit.**

**Garantias verdes:** ATV (11).

**Verificação do dono:** abre a tela e vê quem recebeu, e lê, **sem procurar**, por que quem não recebeu não está ali.

---

## Task 16: Etapa 15, Portões de publicação e documentação

O público desta tarefa é **quem não sabe programar**: a pessoa sobe o código na Cloudflare e faz o resto pela interface. Escreva para ela.

**Leia primeiro:**

    sed -n '3235,3241p' $SPEC   # Etapa 15
    sed -n '2347,2393p' $SPEC   # §11.9 o único campo novo em /health (três valores sem Bearer, seis com)
    sed -n '379,405p' $SPEC     # §6 o que continua exigindo o computador, e por quê
    sed -n '3047,3097p' $SPEC   # §13.5 o que não dá para cobrir com teste automático
    sed -n '3494,3510p' $SPEC   # §16.7 documentação desatualizada · §16.8 o SETUP_ADMIN_TOKEN
    sed -n '308,378p' $SPEC     # §5 custo e limites do plano gratuito, com a conta feita
    sed -n '3292,3310p' $SPEC   # §15.2 as 14 pendências [V], cada uma bloqueia uma frase

**Files:**
- Modify: `scripts/verificar-antes-de-publicar.mjs`, checagens **8 a 10** e **12 a 19**
- Modify: `scripts/configurar.mjs`, a opção "6. Conferir o painel"; e a reescrita do manifesto das linhas 12-19
- Modify: `src/routes/health.ts`, o único campo novo
- Modify: `README.md`, `readmeiniciante.md`, `SECURITY.md`, `SETUP_CLOUDFLARE.md`, `SETUP_META.md`
- Modify: `src/routes/legal.ts`, **exceção única e explícita à regra de não editar `legal.ts`**: as três frases novas na política de privacidade (§11.7). Nada mais nesse arquivo.

**Interfaces:**
- Consumes: tudo.
- Produces: o portão de publicação.

- [ ] **Step 1: Teste que falha**, *"checagem 8 vermelha por binding não propagado"*.
- [ ] **Step 2: Rodar e confirmar a falha.**
- [ ] **Step 3: As checagens 8 a 10 e 12 a 19** do `verificar-antes-de-publicar.mjs`. Inclui a checagem **19**: a garantia sobre `cru(` mora **no script Node**, não num teste dependente de comportamento não verificado do bundler (§13.5).
- [ ] **Step 4: O campo de `/health`.** **Sem `Authorization`: três valores** (`desativado | sem_acesso | pronto`). **Com `Authorization: Bearer <SETUP_ADMIN_TOKEN>`: seis.** `/health` é rota **pública**; `sem_passkey` a anônimo entregaria o instante em que um convite interceptado ainda funciona.
- [ ] **Step 5: A opção "6. Conferir o painel" no assistente**, pergunta ao Worker em que estado o painel está e diz **em português** o que fazer.
- [ ] **Step 6: A reescrita do manifesto de `configurar.mjs:12-19`** de anti-painel para **"por que o painel é seguro"**.
- [ ] **Step 7: As três frases novas na política de privacidade** (§11.7).
- [ ] **Step 8: A documentação de §16.7**, escrita para quem não programa. Obrigatório em todas: o aviso de cota de §5.3 na mesma página em que o painel é anunciado; e §16.8, o `SETUP_ADMIN_TOKEN` **vira mais importante** com o painel, porque assina convites e gera códigos. Quem tem esse token cadastra uma passkey.
- [ ] **Step 9: Registrar o resultado de cada pendência `[V]` de §15.2 com data**, ou marcar explicitamente as que não foram testadas. Nunca prometer na documentação o que não foi verificado, em especial o binding `ratelimits` no plano gratuito.
- [ ] **Step 10: `npm run check` e `npm run verificar` verdes; commit.**

**Garantias verdes:** checagens 8..10 e 12..19.

**Verificação do dono:** `npm run check` e `npm run verificar` verdes, e o **checklist manual assinado com data e aparelhos**.

---

## Rulings feitos ao escrever este plano

1. **Os valores exatos ficam na spec, não duplicados aqui.** Cada tarefa carrega os intervalos `sed -n` precisos. A spec foi escrita como fonte única ("nada além deste arquivo precisa ser consultado para implementar") e duplicá-la num plano de 300 KB criaria duas fontes que divergem. *Custo se errado:* implementadores leem mais linhas do que um brief autocontido exigiria.
2. **`wrangler.jsonc` é editado pelos implementadores mas commitado pelo controlador.** A árvore contém valores reais da instalação do dono (id do D1, id do app Meta) e o repositório é um template público, se eles entrarem no histórico, quem clonar recebe o banco e o link de outra pessoa. *Custo se errado:* dois ou três commits do controlador a mais.
3. **`ALLOWED_LINK_DOMAINS` e `PANEL_RP_ID` nascem vazios.** O dono esclareceu que cada pessoa terá a própria instalação. *Custo se errado:* o painel sobe sem poder mudar link até a pessoa preencher, que é o padrão seguro da spec, não um defeito.
4. **A Task 7 pode reportar `BLOCKED` sem penalidade** se não houver hardware para capturar os vetores congelados. Fabricá-los com o `AutenticadorFalso` destruiria a independência que o método T2 existe para garantir. *Custo se errado:* a Task 7 para e exige o dono com um celular na mão.
