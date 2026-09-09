# Como contribuir

Obrigado por querer ajudar. Este documento explica como preparar o ambiente, quais comandos rodar e quais regras a contribuição precisa respeitar para ser aceita.

Uma coisa importante para entender antes de tudo: **cada pessoa que usa este projeto roda a própria instância**. Não existe um servidor central com todo mundo dentro. Quando você muda uma linha aqui, você está mudando o comportamento do Worker de várias pessoas diferentes, cada uma com a própria conta do Instagram, o próprio banco e as próprias palavras-gatilho. É por isso que as regras abaixo são mais rígidas do que o normal.

---

## Índice

1. [Preparar o ambiente](#1-preparar-o-ambiente)
2. [Comandos do dia a dia](#2-comandos-do-dia-a-dia)
3. [Padrão de código](#3-padrão-de-código)
4. [Regra inegociável: nenhum segredo em commit](#4-regra-inegociável-nenhum-segredo-em-commit)
5. [Testes](#5-testes)
6. [Padrão de commit](#6-padrão-de-commit)
7. [Abrir bug ou reportar vulnerabilidade](#7-abrir-bug-ou-reportar-vulnerabilidade)
8. [Fluxo de um Pull Request](#8-fluxo-de-um-pull-request)

---

## 1. Preparar o ambiente

Você precisa do **Node.js 20 ou mais novo**. Para conferir a versão instalada:

```
node --version
```

Se aparecer algo menor que `v20`, baixe uma versão atual em <https://nodejs.org> antes de continuar.

Depois disso são três passos:

```
git clone https://github.com/VitorSaviolli/Noxe_InstaAutomation.git
cd Noxe_InstaAutomation
npm install
```

E, por último, crie o arquivo de variáveis locais a partir do exemplo:

```
# Linux, macOS ou Git Bash
cp .dev.vars.example .dev.vars
```

```
# PowerShell no Windows
Copy-Item .dev.vars.example .dev.vars
```

O `.dev.vars` é onde ficam os segredos usados quando você roda o projeto na sua máquina. Ele é ignorado pelo git e **nunca** deve ser commitado.

> **Você não precisa preencher o `.dev.vars` para rodar os testes.** A suíte usa valores fictícios injetados pelo `vitest.config.ts` através do Miniflare, então `npm test` funciona num clone recém-feito, sem nenhuma credencial da Meta ou da Cloudflare. O `.dev.vars` só é necessário se você quiser subir o Worker de verdade com `npm run dev`.

---

## 2. Comandos do dia a dia

O comando que decide se a sua mudança está pronta é este:

```
npm run check
```

Ele roda, em sequência, **lint + typecheck + testes**. Se ele passar na sua máquina, sua contribuição passa também na verificação automática do GitHub. Se ele falhar, o Pull Request não vai ser aceito — então rode antes de abrir.

Os comandos individuais, para quando você quiser isolar um problema:

| Comando | O que faz |
|---|---|
| `npm run check` | Roda lint, typecheck e testes. É o comando principal. |
| `npm test` | Roda a suíte de testes uma vez. |
| `npm run test:watch` | Roda os testes e fica observando os arquivos, re-executando a cada salvamento. Ótimo enquanto você desenvolve. |
| `npm run lint` | Confere estilo e regras de qualidade com o Biome, sem alterar nada. |
| `npm run lint:fix` | Faz o Biome **corrigir sozinho** tudo o que ele consegue corrigir. Use quando o lint reclamar de formatação. |
| `npm run typecheck` | Confere os tipos do TypeScript (`tsc --noEmit`), sem gerar arquivos. |

Existem ainda comandos de deploy (`npm run deploy`, `npm run db:migrate:remote`, `npm run tail`). Eles mexem na **sua** conta Cloudflare e não têm nenhum papel numa contribuição — não os rode achando que fazem parte do fluxo de PR.

---

## 3. Padrão de código

A formatação é decidida pelo **Biome**, configurado em `biome.json`. Você não precisa decorar as regras: rode `npm run lint:fix` e ele arruma. Mas vale saber o que ele vai fazer, para não estranhar:

- **Aspas simples** em strings (`'texto'`, não `"texto"`).
- **Sem ponto e vírgula** no fim das linhas.
- **Indentação de 2 espaços**, nunca tabulação.
- **Largura máxima de 100 colunas**.
- Vírgula final em listas e objetos escritos em várias linhas.

Além do que o Biome checa automaticamente, existem duas convenções que só uma pessoa consegue avaliar:

**Comentários em português, explicando o PORQUÊ e não o QUE.**

O código já diz o que ele faz. O comentário existe para registrar a decisão que não está visível na linha — o motivo, a restrição da API da Meta, o ataque que aquilo previne. Se o comentário pode ser deduzido lendo a linha logo abaixo, ele está sobrando.

```ts
// Ruim: repete o que a linha ja diz
// incrementa o contador
contador = contador + 1

// Bom: registra a decisao
// A Meta anexa um sufixo '#_' ao final do code do OAuth. Se ele nao for
// removido, a troca de code por token falha com erro generico.
const codeLimpo = code.replace(/#_$/, '')
```

**Identificadores sem acento.** Nomes de variáveis, funções e arquivos são escritos em português, mas sem acentuação (`codigoLimpo`, e não `códigoLimpo`). O texto dos comentários e da documentação usa acento normalmente.

Vale também o que já vale no resto do projeto: funções pequenas e com uma responsabilidade só, arquivos coesos, e nada de aninhar `if` dentro de `if` dentro de `if` quando um retorno antecipado resolve.

---

## 4. Regra inegociável: nenhum segredo em commit

Esta é a única regra do projeto que não tem exceção, atenuante nem "só dessa vez".

Os cinco segredos deste projeto são `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `TOKEN_ENCRYPTION_KEY`, `SETUP_ADMIN_TOKEN` e `PANEL_SESSION_KEY`. Nenhum deles pode aparecer em arquivo versionado — nem no código, nem nos testes, nem no `wrangler.jsonc`, nem em um exemplo de documentação, nem "mascarado" trocando alguns caracteres por `x`.

O `PANEL_SESSION_KEY` é a raiz das subchaves do painel administrativo. Ele **nunca** repete o valor de outro segredo: rotacionar o `SETUP_ADMIN_TOKEN` não pode derrubar as sessões do painel, e vazar um dos dois não pode entregar o que o outro protege.

Todo binding novo é propagado, e quantos lugares dependem de ele ser segredo ou não:

- **Segredo** (vai por `wrangler secret put`): cinco lugares — `src/types/env.ts`, `wrangler.jsonc` em `secrets.required`, `.dev.vars.example`, os bindings de teste do `vitest.config.ts` e a documentação.
- **`var` pública** (fica no `wrangler.jsonc`, versionada): quatro — os mesmos, **menos** o `.dev.vars.example`, que só existe para segredos. É o que já vale para `META_APP_ID` e `META_IG_USER_ID`.

Os valores no `vitest.config.ts` são fictícios e existem só para o teste; o metateste `META-04` falha se um binding obrigatório não chegar lá.

Os arquivos onde segredos reais podem existir na sua máquina são:

- **`.dev.vars`** — segredos do desenvolvimento local.
- **`.env`** — se você tiver criado um.

Os dois já estão cobertos pelo `.gitignore`. Os arquivos `.dev.vars.example` e `.env.example`, que **são** versionados, existem só para mostrar os nomes das variáveis e devem continuar com os valores vazios.

Antes de commitar, rode a verificação do projeto:

```
npm run verificar
```

Ela varre o repositório e avisa se algum segredo escapou para um arquivo versionado. Não substitui o olho humano: dê também um `git diff --staged` e leia o que você está mandando.

**Se um segredo já foi commitado**, apagar a linha no commit seguinte **não resolve** — o valor continua no histórico do git e, se o repositório for público, considere que ele vazou. O caminho é: rotacionar o segredo imediatamente (gerar um novo e substituir no Worker) e só depois limpar o histórico. O `SECURITY.md` tem o procedimento de rotação de cada um dos quatro segredos.

---

## 5. Testes

**Testes são obrigatórios para qualquer mudança de comportamento.** Correção de texto na documentação não precisa; qualquer coisa que altere o que o Worker faz, precisa.

A suíte hoje tem **822 testes em 25 arquivos**, dentro da pasta `tests/`:

| Arquivo | Cobre |
|---|---|
| `tests/automation.test.ts` | A regra de negócio: quando o comentário aciona a automação e a ordem claim → Direct → resposta pública. |
| `tests/normalize.test.ts` | A normalização do texto do comentário (minúsculas, acentos, pontuação). |
| `tests/repositories.test.ts` | O acesso ao banco D1, incluindo o claim atômico. |
| `tests/security.test.ts` | Assinatura HMAC, comparação em tempo constante, `state` do OAuth e cifragem. |
| `tests/templates.test.ts` | A montagem das mensagens enviadas. |
| `tests/webhook.test.ts` | O tratamento da requisição que chega da Meta. |

Coloque o teste novo no arquivo que já cobre aquela área, em vez de criar um arquivo novo.

### Duas áreas que exigem atenção redobrada

Como cada pessoa roda a própria instância, existem duas partes do código onde uma mudança sem teste chega direto no Direct de gente real:

1. **O texto enviado por Direct** (`src/utils/templates.ts`). É a mensagem que a pessoa que comentou vai receber. Um erro aqui vira uma mensagem quebrada, com placeholder aparecendo cru ou com o link errado, enviada em nome do perfil de outra pessoa.
2. **A lógica de gatilho** (`src/utils/normalize.ts` e `src/services/automation.ts`). É o que decide se um comentário aciona ou não a automação. Um erro aqui significa ou não responder quem deveria ser respondido, ou — bem pior — responder quem não pediu nada.

Mudança em qualquer uma dessas duas áreas **só é aceita com teste cobrindo explicitamente o novo comportamento**, incluindo o caso em que ele **não** deve disparar. "Passou nos testes que já existiam" não basta: se o comportamento mudou e nenhum teste quebrou nem foi adicionado, é sinal de que o novo comportamento não está coberto.

### Como escrever o teste

Siga o padrão dos arquivos existentes: prepare os dados, execute, verifique. O nome do teste descreve o comportamento, não a função:

```ts
it('nao dispara quando a palavra-gatilho aparece dentro de outra palavra', async () => {
  // ...
})
```

---

## 6. Padrão de commit

O projeto usa **Conventional Commits**. O formato é:

```
<tipo>: <descrição curta em português, no imperativo>

<corpo opcional explicando o motivo>
```

Os tipos aceitos:

| Tipo | Quando usar |
|---|---|
| `feat` | Funcionalidade nova. |
| `fix` | Correção de bug. |
| `docs` | Só documentação. |
| `refactor` | Reorganização de código sem mudar comportamento. |
| `test` | Só testes. |
| `chore` | Dependências, configuração, tarefas de manutenção. |

Exemplos:

```
fix: remover sufixo #_ do code antes de trocar por token
feat: permitir varias palavras-gatilho por Reel
docs: explicar por que o Direct sai antes da resposta publica
```

A descrição deve dizer o que mudou de um jeito que alguém entenda sem abrir o diff. `fix: ajustes` não ajuda ninguém daqui a seis meses.

---

## 7. Abrir bug ou reportar vulnerabilidade

São dois caminhos diferentes, e a diferença importa muito.

### Bug comum → issue pública

Se algo não funciona, funciona diferente do documentado, ou você travou em algum passo da configuração, abra uma issue. Existem dois modelos prontos:

- **Bug** — para algo quebrado no funcionamento.
- **Dúvida de configuração** — para quem empacou seguindo o `README.md`, o `SETUP_META.md` ou o `SETUP_CLOUDFLARE.md`.

Em qualquer um dos dois, **não cole segredos**. Nem token, nem App Secret, nem o conteúdo do seu `.dev.vars`, nem URL contendo `code=` ou `state=`. Se precisar mostrar um valor, troque por `<REMOVIDO>`. Os dois modelos têm uma confirmação obrigatória sobre isso justamente porque é o erro mais comum.

### Vulnerabilidade de segurança → NUNCA em issue pública

Se você encontrou uma falha de segurança — algo que permita forjar um webhook, burlar a validação de assinatura, driblar a proteção das rotas `/setup/*`, ler um token cifrado, ou fazer o Worker enviar Direct em nome de alguém —, **não abra issue, não comente em issue existente, não poste em rede social e não escreva no Discussions**.

Uma issue pública é lida por qualquer pessoa na internet, e cada pessoa que subiu a própria instância continuaria vulnerável enquanto a correção não sai.

O canal correto é o **GitHub Security Advisories**: vá na aba **Security** do repositório e clique em **"Report a vulnerability"**. Isso abre um relato privado, visível apenas para quem mantém o projeto.

O `SECURITY.md` tem o restante do procedimento: o que incluir no relato, até onde é aceitável explorar a falha para demonstrá-la, e como funciona a divulgação depois da correção. Leia antes de reportar.

---

## 8. Fluxo de um Pull Request

1. Faça um fork do repositório e crie uma branch a partir da branch principal. Dê à branch um nome que descreva a mudança: `fix/sufixo-do-code`, `feat/multiplas-palavras-gatilho`.
2. Faça a mudança e escreva os testes.
3. Rode `npm run check` e garanta que passa.
4. Confira que nenhum segredo entrou no diff.
5. Abra o Pull Request. O modelo de PR tem uma checklist curta — preencha com honestidade; ela existe para você não descobrir na revisão que esqueceu algo.
6. A verificação automática do GitHub Actions vai rodar `npm run lint`, `npm run typecheck` e `npm test` num clone limpo. Se falhar lá e passar na sua máquina, quase sempre é porque a mudança depende de algo que só existe localmente — um arquivo não commitado ou uma variável do seu `.dev.vars`.

Pull Requests pequenos e com um propósito só são revisados muito mais rápido do que um PR grande que mistura correção, refatoração e funcionalidade nova. Se a sua mudança for grande, vale abrir uma issue antes para combinar o caminho.
