# Configuração da Cloudflare — do zero ao deploy

Este guia leva você do computador limpo até o Worker publicado e funcionando.
Cada passo tem o comando exato. Se você nunca mexeu com Cloudflare nem com o
painel da Meta, siga na ordem, sem pular.

O projeto é uma automação de comentários do Instagram rodando em
**Cloudflare Workers + TypeScript + D1**.

---

## Onde você está

São **dois** guias, e a ordem entre eles importa:

1. **`SETUP_CLOUDFLARE.md` — este aqui, primeiro.** Você instala o necessário,
   baixa o código, cria o banco, cadastra os segredos e publica o Worker.
2. **`SETUP_META.md` — depois.** Você cria o app no painel da Meta e conecta a
   sua conta profissional do Instagram.

**Por que nessa ordem:** a URL pública do seu Worker (aquele endereço que
termina em `.workers.dev`) **só passa a existir depois do primeiro deploy**, que
acontece no passo 8 deste documento. O painel da Meta pede essa URL em três
campos diferentes. Quem começa pela Meta trava logo no início, sem ter o
endereço para colar.

**O que você precisa ter em mãos antes de começar este documento:**

- Um computador com internet e permissão para instalar programas.
- Uma conta na Cloudflare — o plano gratuito basta e não pede cartão. Se ainda
  não tem, cria no passo 1.3.
- Cerca de 40 minutos sem pressa.

**O que você ainda NÃO precisa:** nada do painel da Meta. Dos quatro segredos do
projeto, três você gera na sua própria máquina (passo 6) e só um
(`META_APP_SECRET`) vem da Meta — ele é cadastrado no fim, já dentro do
`SETUP_META.md`. Ou seja: você percorre este documento inteiro de ida, sem
precisar voltar.

| Item | Valor |
|---|---|
| Nome do Worker | `noxe-insta-automation` |
| URL pública | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev` — **exemplo**; a sua ainda não existe e só nasce no passo 8 |
| Banco D1 | `noxe-insta-automation` — **você cria** no passo 4 |
| Arquivo de configuração | `wrangler.jsonc` (**não** é `wrangler.toml`) |
| Versão da Graph API | `v25.0` (variável `META_API_VERSION` no `wrangler.jsonc`) |

> Sempre que este guia mostrar `SEU-WORKER.SEU-SUBDOMINIO.workers.dev`, troque
> pelo endereço real que o passo 8 imprimir na sua tela. Ele é um exemplo, não
> um endereço que funciona.

### Existe um caminho mais curto

Depois dos passos 1 e 2 (instalar o Node e baixar o código), você pode rodar:

```bash
npm run configurar
```

É um assistente que conduz a configuração inteira pelo terminal: gera os
segredos, cadastra na Cloudflare e leva o processo adiante, sem você precisar
copiar e colar valores secretos na mão. Ele evita os dois tropeços mais comuns
deste guia — errar um comando de terminal e perder o prazo de 10 minutos do
login do Instagram (explicado no item 9.4).

O passo a passo manual continua todo aqui, para você entender o que está
acontecendo e para consultar quando algo der errado. Se preferir fazer tudo na
unha, siga na ordem normal.

---

## 1. Pré-requisitos

São três: o Node.js, o git e uma conta na Cloudflare.

### 1.1 Instalar o Node.js (versão 20 ou mais nova)

O Node.js é o programa que executa os comandos deste projeto. Baixe em
<https://nodejs.org>, escolhendo a versão marcada como **LTS**. Instale com as
opções padrão e **abra um terminal novo depois** — um terminal já aberto não
enxerga programas instalados depois dele.

No Windows, "terminal" pode ser o **PowerShell** (procure por *PowerShell* no
menu Iniciar) ou o **Git Bash**, que vem junto com o git do item seguinte. Os
dois funcionam, mas alguns comandos mudam de um para o outro. Sempre que isso
acontecer, este guia mostra as duas versões, lado a lado e com etiqueta.

Confira:

```bash
node --version
npm --version
```

O `node --version` precisa responder `v20.` ou maior. O `npm` vem junto com o
Node; se ele não responder, reinstale o Node.

### 1.2 Instalar o git

O git é o programa que baixa o código do projeto. Baixe em
<https://git-scm.com/downloads> e instale com as opções padrão (no Windows, isso
também instala o Git Bash). Abra um terminal novo e confira:

```bash
git --version
```

### 1.3 Criar a conta na Cloudflare

Crie em <https://dash.cloudflare.com/sign-up>. O **plano gratuito é suficiente**
para tudo que este projeto faz — Workers, banco D1, cron e logs. Confirme o
e-mail antes de seguir.

> O `wrangler` (o programa de linha de comando da Cloudflare) **não** precisa ser
> instalado à parte. Ele já vem como dependência do projeto, e a gente chama via
> `npx`.

---

## 2. Baixar o código e instalar as dependências

Escolha uma pasta onde o projeto vai morar (a sua pasta de documentos serve),
abra o terminal nela e rode:

```bash
git clone https://github.com/VitorSaviolli/Noxe_InstaAutomation.git
cd Noxe_InstaAutomation
npm install
```

O endereço acima é o do repositório oficial. Se você estiver baixando de um
fork, troque pelo endereço que aparece no botão verde **Code** daquela página no
GitHub — copie de lá para não errar.

O que cada comando faz:

- `git clone` baixa os arquivos e cria a pasta `Noxe_InstaAutomation`.
- `cd` entra nessa pasta. **Todos os comandos do resto deste guia precisam ser
  rodados de dentro dela.**
- `npm install` baixa as bibliotecas que o projeto usa, incluindo o próprio
  `wrangler`. Demora um pouco na primeira vez e imprime bastante texto na tela;
  é normal.

> Fechou o terminal e voltou depois? Entre na pasta de novo
> (`cd caminho/para/noxe-insta-automation`) antes de rodar qualquer comando. Se
> aparecer um erro dizendo que o `package.json` não foi encontrado, é quase
> sempre isso: você está na pasta errada.

---

## 3. Fazer login na Cloudflare

```bash
npx wrangler login
```

O que acontece: o comando abre o seu navegador numa página da Cloudflare
pedindo autorização. Você clica em **Allow**, volta para o terminal, e pronto —
está autenticado. O token fica guardado na sua máquina.

**Você NÃO precisa criar API Token para uso local.** Esse login pelo navegador
é suficiente para tudo que este guia faz: criar banco, rodar migrations,
cadastrar segredos, dar deploy, ver logs.

O **API Token só serve para CI/CD** — ou seja, quando um servidor de build
(GitHub Actions, por exemplo) precisa dar deploy sozinho, sem ninguém para
clicar em "Allow" no navegador. Se esse for o seu caso um dia, aí sim você gera
um token no painel da Cloudflare e coloca como variável de ambiente
`CLOUDFLARE_API_TOKEN`. Para trabalhar na sua máquina, esqueça o API Token.

Para confirmar que deu certo:

```bash
npx wrangler whoami
```

---

## 4. Criar o banco D1 e colar o `database_id`

O D1 é o banco de dados da Cloudflare. Ele guarda quais comentários já foram
respondidos (para não mandar dois Directs para a mesma pessoa), o cooldown de
cada usuário e o token do Instagram, cifrado.

**Esse banco ainda não existe na sua conta.** Quem cria é você, agora, com um
comando:

```bash
npx wrangler d1 create noxe-insta-automation
```

A saída do comando mostra um bloco com o `database_id`, algo parecido com:

```
[[d1_databases]]
binding = "DB"
database_name = "noxe-insta-automation"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copie **apenas o valor do `database_id`** (aquele texto longo com hífens) e cole
no arquivo `wrangler.jsonc`, no campo `database_id` dentro de `d1_databases`,
por cima do texto `COLE_AQUI_O_ID_DO_SEU_BANCO_D1`. Deve ficar assim:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "noxe-insta-automation",
    "database_id": "o-id-que-o-comando-te-deu"
  }
]
```

Atenção ao formato: a saída do `wrangler` vem em estilo TOML (com `=`), mas
nosso arquivo é **JSONC** (com `:` e aspas). Não copie o bloco inteiro — copie
só o valor e cole no lugar certo do JSON que já existe. Salve o arquivo.

> O `wrangler.jsonc` tem **dois** valores para você preencher: o
> `database_id`, agora, e o `META_APP_ID` (hoje com o texto
> `COLE_AQUI_O_ID_DO_SEU_APP_META`), que só existe depois de criar o app no
> painel da Meta — isso é feito no `SETUP_META.md`, etapa 6. Deixe esse segundo
> para lá.

Se algum dia você precisar redescobrir o `database_id` de um banco que já criou:

```bash
npx wrangler d1 list
```

---

## 5. Aplicar as migrations

O esquema do banco está em `migrations/0001_initial.sql`.

**No banco local** (usado pelo `npm run dev`):

```bash
npm run db:migrate:local
```

**No banco remoto** (o que roda em produção, na Cloudflare):

```bash
npm run db:migrate:remote
```

Rode os dois. O local serve para você testar na sua máquina; o remoto é o que o
Worker publicado vai usar de verdade. Aplicar a migration duas vezes não é
problema — o Wrangler controla quais já foram aplicadas.

---

## 6. Cadastrar os 4 segredos

São **quatro** segredos. Eles não ficam no `wrangler.jsonc` nem no Git — vão
direto para o cofre da Cloudflare pelo comando `wrangler secret put`.

| Segredo | Para que serve | De onde vem |
|---|---|---|
| `META_WEBHOOK_VERIFY_TOKEN` | Senha do handshake do webhook (o `hub.verify_token`) | você gera |
| `TOKEN_ENCRYPTION_KEY` | Chave AES-GCM 256 que cifra o token do Instagram guardado no D1 | você gera |
| `SETUP_ADMIN_TOKEN` | Protege as rotas administrativas `/setup/authorize` e `/setup/subscribe` | você gera |
| `META_APP_SECRET` | Valida a assinatura `X-Hub-Signature-256` dos webhooks e faz a troca do code do OAuth | painel da Meta |

Repare na última coluna: **três você gera agora, na sua máquina**. Só o
`META_APP_SECRET` vem do painel da Meta, e por isso ele é o último da fila
(item 6.5) — não trave aqui esperando por ele.

### 6.1 Gerar os três valores aleatórios

O projeto já traz um gerador pronto. Este é o caminho recomendado:

```bash
npm run gerar:segredos
```

Ele imprime os três valores já no formato certo. Isso importa: o
`TOKEN_ENCRYPTION_KEY` tem formato obrigatório (**32 bytes aleatórios
codificados em base64**) e os outros dois precisam ser seguros para viajar em
cabeçalho HTTP. O script cuida disso; um valor digitado à mão, não.

De propósito, ele **não grava nada em arquivo nenhum**. Copie a saída para o seu
gerenciador de senhas **antes de fechar o terminal**.

> **Existe um caminho ainda mais curto:** `npm run configurar` conduz a
> configuração inteira — gera os segredos, cadastra na Cloudflare e segue com o
> resto do processo — sem você precisar copiar e colar valor secreto na mão. Se
> preferir esse caminho, rode ele e use os itens abaixo apenas como referência do
> que está acontecendo por baixo.

**Alternativa, se você prefere gerar por fora:** o `openssl` faz o mesmo.

```bash
openssl rand -base64 32
```

No Windows, o `openssl` só costuma existir dentro do **Git Bash** — no
PowerShell ele normalmente não está instalado. É exatamente por isso que o
`npm run gerar:segredos` é o caminho principal aqui: ele funciona igual no
Windows, no Mac e no Linux.

### 6.2 `META_WEBHOOK_VERIFY_TOKEN`

Cadastre o valor que o gerador produziu:

```bash
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN
```

O comando pergunta o valor; cole e dê Enter. O terminal **não mostra** o que
você colou — isso é proposital, não é travamento.

**Guarde esse valor.** Você vai precisar colar exatamente o mesmo texto no
painel da Meta, no campo "Verificar token" do webhook (`SETUP_META.md`,
etapas 9 e 10). Um espaço a mais no começo ou no fim já faz a verificação
falhar.

### 6.3 `TOKEN_ENCRYPTION_KEY`

```bash
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

> Se um dia você trocar essa chave, os tokens já gravados no D1 **não poderão
> mais ser decifrados** — vai ser preciso refazer o OAuth do zero.

### 6.4 `SETUP_ADMIN_TOKEN`

```bash
npx wrangler secret put SETUP_ADMIN_TOKEN
```

Guarde com carinho: é a senha das rotas administrativas. É ela que vai no
cabeçalho `Authorization: Bearer ...` quando você chamar `/setup/authorize` e
`/setup/subscribe`. Quem tiver esse valor consegue iniciar a autorização da sua
conta.

### 6.5 `META_APP_SECRET` — o único que não é você quem gera

Este vem do painel da Meta: é a **chave secreta do app do Instagram**. Se você
ainda não criou o app (o normal, se está seguindo a ordem recomendada), **pule
este item por enquanto**. Você volta aqui — ou melhor, faz isso direto — na
etapa 6 do `SETUP_META.md`, quando o valor existir.

Quando tiver o valor em mãos:

```bash
npx wrangler secret put META_APP_SECRET
```

> **Ponto que você precisa confirmar antes:** no fluxo de *Instagram Login*, os
> valores que valem são o **"ID do app do Instagram"** e a **"Chave secreta do
> app do Instagram"**, que aparecem na tela **Casos de uso > Personalizar** do
> painel da Meta. Eles podem ser **diferentes** do App ID / App Secret que
> aparecem em **Configurações > Básico**. Confirme que o `META_APP_ID` (no
> `wrangler.jsonc`) e o `META_APP_SECRET` são os da tela de Casos de uso.

### Conferindo

Para listar os nomes dos segredos cadastrados (os valores nunca são exibidos,
nem para você):

```bash
npx wrangler secret list
```

Neste ponto do guia é esperado ver **três** nomes na lista. O quarto,
`META_APP_SECRET`, entra depois.

---

## 7. Rodar os testes

Antes de publicar, confirme que está tudo verde. A suíte tem **125 testes**,
distribuídos em 6 arquivos dentro da pasta `tests/`.

```bash
npm test
```

> **Vai aparecer aviso sobre segredo faltando — e isso é esperado.** Num projeto
> recém-baixado, o ambiente de testes avisa que alguns segredos ainda não estão
> definidos na sua máquina. Os testes **não** usam os seus segredos de verdade:
> o arquivo `vitest.config.ts` injeta valores fictícios, criados só para o teste.
> O que vale é a linha final: se ela disser que os testes passaram, passou.
> Aviso não é erro.

Verificação completa (lint + typecheck + testes), o que você deve rodar antes de
qualquer deploy:

```bash
npm run check
```

Comandos individuais, se precisar:

```bash
npm run typecheck
npm run lint
npm run lint:fix
npm run format
npm run test:watch
```

---

## 8. Deploy — é aqui que a sua URL nasce

```bash
npm run deploy
```

No fim, o Wrangler imprime a URL pública do Worker, no formato:

```
https://noxe-insta-automation.SEU-SUBDOMINIO.workers.dev
```

O `SEU-SUBDOMINIO` é a parte pessoal do endereço: você escolhe na primeira vez
que usa Workers, ou a Cloudflare sugere uma a partir da sua conta. **Anote essa
URL agora** — ela é a peça que faltava para começar o `SETUP_META.md`.

Se você perder o endereço, ele reaparece a cada `npm run deploy` e também está
no painel da Cloudflare, em **Workers & Pages > noxe-insta-automation**. Ela é
fixa: enquanto o nome do Worker e a conta forem os mesmos, a URL não muda.

Teste imediatamente. O comando muda conforme o terminal:

**Windows (PowerShell)**

```powershell
Invoke-RestMethod https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/health
```

**Mac, Linux ou Git Bash**

```bash
curl https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/health
```

A resposta é um JSON curto com `"status": "ok"`, a rota do webhook e um bloco
`configurado` dizendo se o `META_APP_ID` já está preenchido e se alguma conta já
foi autorizada. Neste momento é normal que `appId` esteja `false` e
`contaAutorizada` também — isso é resolvido no `SETUP_META.md`.

---

## 9. A URL pública: webhook e callback do OAuth

Esta seção é a **referência técnica** do que a Meta vai precisar da sua URL. O
passo a passo com as telas do painel está no `SETUP_META.md` — vá para lá
depois de ler, e siga de lá até o fim sem precisar voltar para cá.

A sua URL pública tem este formato:

```
https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev
```

Ela saiu no final do `npm run deploy` (passo 8) e também aparece no painel da
Cloudflare em **Workers & Pages > noxe-insta-automation**.

### 9.1 Rotas implementadas

| Método | Caminho | O que é |
|---|---|---|
| GET | `/health` | Checagem de saúde |
| GET | `/privacy-policy` | Política de privacidade (a Meta exige) |
| GET | `/data-deletion` | Instruções de exclusão de dados (a Meta exige) |
| GET | `/webhooks/instagram` | Handshake do webhook (`hub.mode`, `hub.verify_token`, `hub.challenge`) |
| POST | `/webhooks/instagram` | Recebe os eventos; valida `X-Hub-Signature-256`, responde 200 rápido e processa em `waitUntil` |
| GET | `/setup/authorize` | Inicia o OAuth — protegida por `Authorization: Bearer SETUP_ADMIN_TOKEN` |
| GET | `/oauth/callback` | Recebe o retorno do OAuth — protegida pelo `state` assinado |
| POST | `/setup/subscribe` | Inscreve a conta no webhook — protegida por Bearer |

### 9.2 Os três lugares onde a sua URL é colada no painel da Meta

Todos são preenchidos **à mão**, no painel — não existe API para essa parte. O
passo a passo com as telas está no `SETUP_META.md` (etapas 4, 9 e 10); a tabela
abaixo é só para você já saber o que vem pela frente.

| Onde, no painel da Meta | O que colar |
|---|---|
| Casos de uso > Personalizar > Webhooks > **URL de callback** | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/webhooks/instagram` |
| Instagram Login > **URI de redirecionamento OAuth válidos** | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/oauth/callback` |
| Instagram Login > **URL da política de privacidade** e **exclusão de dados** | `.../privacy-policy` e `.../data-deletion` |

No campo **Verificar token** do webhook vai o mesmo valor que você cadastrou
como `META_WEBHOOK_VERIFY_TOKEN` no item 6.2 — não é a URL.

Depois de salvo o webhook, ainda é preciso **assinar o campo `comments`** na
lista de campos. É o erro mais comum: salvar a URL e esquecer de assinar.

### 9.3 Por que a URL precisa bater caractere por caractere

O `redirect_uri` que o Worker envia é montado a partir do endereço em que ele
está rodando, e a Meta compara com o que está cadastrado **letra por letra**.
Qualquer diferença — uma barra sobrando no fim, `http` no lugar de `https`, um
`www` a mais — faz a Meta recusar o redirecionamento com erro de URI inválida.

Copie e cole; não digite.

### 9.4 Autorizar a conta (rodar o OAuth)

> **Este passo pertence ao `SETUP_META.md`, etapa 8**, e só funciona depois que
> o app da Meta estiver configurado. Os comandos ficam registrados aqui porque é
> para cá que você volta no dia em que precisar **refazer** a autorização — por
> exemplo, se o token de 60 dias expirar.

> ⏱️ **Você tem 10 minutos.** A URL de consentimento devolvida por esta rota
> carrega um `state` assinado que **expira em 10 minutos**. Se demorar mais que
> isso entre pedir a URL e clicar em "Permitir" na tela do Instagram, o Worker
> recusa com "State inválido ou expirado" e você precisa pedir uma URL nova. Só
> rode o comando quando estiver com o navegador aberto e pronto para autorizar.
>
> **`npm run configurar` evita essa corrida:** ele pede a URL e já abre o
> navegador para você, sem copiar e colar um endereço gigante de dentro de um
> JSON.

**Windows (PowerShell)**

```powershell
$resposta = Invoke-RestMethod `
  -Uri "https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/authorize" `
  -Headers @{ Authorization = "Bearer SEU_TOKEN_ADMIN" }
$resposta.authorizationUrl
Start-Process $resposta.authorizationUrl
```

A última linha abre a URL no seu navegador padrão. Se preferir abrir à mão,
apague ela e copie o endereço que a linha anterior imprimiu.

**Mac, Linux ou Git Bash**

```bash
curl -i \
  -H "Authorization: Bearer SEU_TOKEN_ADMIN" \
  https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/authorize
```

> **Por que dois comandos?** No PowerShell do Windows, `curl` é apenas um apelido
> para o `Invoke-WebRequest`, que **não entende** as opções `-H` e `-i`. Colar ali
> o comando de Mac/Linux devolve um erro confuso sobre parâmetro desconhecido. Use
> sempre o bloco do seu sistema.

> ⚠️ **Cuidado com o histórico do terminal.** Colar o `SETUP_ADMIN_TOKEN` direto
> na linha de comando grava ele **em texto puro** no histórico: no PowerShell,
> num arquivo cujo caminho você vê com `(Get-PSReadlineOption).HistorySavePath`;
> no Git Bash, no `~/.bash_history`. Qualquer pessoa com acesso à sua máquina lê
> depois. O `npm run configurar` faz essa mesma chamada **sem** expor o token no
> histórico — é o caminho recomendado. Se usar o comando na mão, apague a linha
> do arquivo de histórico quando terminar.

A resposta traz a URL de consentimento do Instagram (campo `authorizationUrl`).
Abra essa URL **no navegador**, logado na conta profissional do Instagram, e
aceite as permissões. Você é redirecionado para `/oauth/callback`, que valida o
`state` assinado, troca o code por token, guarda o token cifrado no D1 e **já
inscreve a conta no webhook automaticamente**.

Se precisar refazer só a inscrição da conta (nível CONTA), sem repetir o OAuth:

**Windows (PowerShell)**

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/subscribe" `
  -Headers @{ Authorization = "Bearer SEU_TOKEN_ADMIN" }
```

**Mac, Linux ou Git Bash**

```bash
curl -i -X POST \
  -H "Authorization: Bearer SEU_TOKEN_ADMIN" \
  https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/subscribe
```

### 9.5 Os dois níveis de webhook — os dois são obrigatórios

Essa é a parte que mais confunde. São **duas inscrições diferentes**:

- **(a) Nível APP** — no painel da Meta, em *Casos de uso > Personalizar >
  Webhooks*: Callback URL + Verify Token + assinar o campo `comments`.
  **Manual, não tem API.** É o que a tabela do item 9.2 resume, e o
  `SETUP_META.md` detalha nas etapas 9 e 11a.
- **(b) Nível CONTA** — `POST /me/subscribed_apps` na Graph API. É feito
  **automaticamente** pelo `/oauth/callback`, ou manualmente pelo
  `POST /setup/subscribe`.

Se só o (a) estiver feito, nada chega. Se só o (b) estiver feito, nada chega.
Precisa dos dois.

### 9.6 Permissões pedidas

O fluxo pede exatamente estes escopos:

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Os nomes antigos, sem o prefixo `instagram_`, foram **descontinuados em
27/01/2025**. E não peça `instagram_business_content_publish` — este projeto não
publica mídia.

### 9.7 Nível de acesso: você provavelmente não precisa de App Review

- **Standard Access basta** para automatizar a **sua própria conta**. Não exige
  App Review.
- **Advanced Access** (que exige App Review + Verificação de Negócio) só é
  necessário para atender contas de **terceiros/clientes**.

### 9.8 Próximo passo: abra o `SETUP_META.md`

Se você chegou até aqui com o Worker no ar e a URL anotada, a parte da
Cloudflare está feita. **Agora vá para o `SETUP_META.md` e siga do começo ao
fim.** Lá você cria o app da Meta, pega o `META_APP_ID` (que vai no
`wrangler.jsonc`) e o `META_APP_SECRET` (que vai por `wrangler secret put`),
cadastra a URL nos três campos do painel e conecta a sua conta.

As seções que sobram aqui embaixo (10 a 12) são de **operação do dia a dia** —
rodar localmente, ver logs, conferir o cron. Você lê quando precisar; não são
pré-requisito para o `SETUP_META.md`.

---

## 10. Desenvolvimento local

Para rodar na sua máquina, os segredos vêm de um arquivo local chamado
`.dev.vars` (que fica fora do Git). Crie a partir do exemplo:

**Windows (PowerShell)**

```powershell
Copy-Item .dev.vars.example .dev.vars
```

**Mac, Linux ou Git Bash**

```bash
cp .dev.vars.example .dev.vars
```

Abra o `.dev.vars` e preencha os quatro valores — os mesmos nomes do passo 6:
`META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `TOKEN_ENCRYPTION_KEY`,
`SETUP_ADMIN_TOKEN`. Para desenvolvimento, pode usar valores aleatórios de
teste; só o `META_APP_SECRET` precisa ser o real se você for testar assinatura
de webhook de verdade.

Suba o servidor local:

```bash
npm run dev
```

Ele usa o **banco D1 local** (por isso o `npm run db:migrate:local` do passo 5).
Teste:

**Windows (PowerShell)**

```powershell
Invoke-RestMethod http://localhost:8787/health
```

**Mac, Linux ou Git Bash**

```bash
curl http://localhost:8787/health
```

> O `.dev.vars` nunca deve ser commitado. Ele contém segredos.

---

## 11. Ver os logs

Para acompanhar em tempo real o que o Worker publicado está fazendo:

```bash
npm run tail
```

Deixe rodando numa aba do terminal e provoque um evento (mande um comentário no
post automatizado, por exemplo). Os logs aparecem ao vivo.

O projeto foi escrito para **não registrar nenhum segredo em log**, e a coleta é
mínima: **não guardamos o texto do comentário nem o username**; o IGSID do autor
é armazenado apenas como **SHA-256**. Então não espere ver o conteúdo do
comentário no log — isso é intencional.

---

## 12. Conferir o cron

O cron (Cron Trigger) é o que mantém o token do Instagram renovado. Ele está
declarado no `wrangler.jsonc` e é atendido pelo handler `scheduled` do
`src/index.ts`.

**Conferir se está configurado e ativo:**

1. Abra o `wrangler.jsonc` e veja a seção de triggers/crons — é ali que a
   expressão de agendamento está definida.
2. No painel da Cloudflare, vá em **Workers & Pages > noxe-insta-automation >
   Settings > Trigger Events** (ou *Cron Triggers*). O agendamento aparece
   listado ali depois do deploy. Se não aparecer, o `npm run deploy` não foi
   executado depois de você adicionar o cron.
3. Depois que ele rodar, a execução aparece no `npm run tail` como um evento
   `scheduled` (deixe o tail aberto no horário do disparo).

**Por que isso importa — os prazos dos tokens:**

- Token curto: **1 hora**.
- Token longo: **60 dias** (5184000s).
- O refresh exige um token com **no mínimo 24h de idade** e que **ainda não
  tenha expirado**.
- Se passarem os **60 dias** sem renovar, **não existe refresh** — a única saída
  é refazer o OAuth do zero (seção 9.4).

Ou seja: se o cron não estiver rodando, um dia a automação simplesmente para.

---

## Referência rápida dos comandos

```bash
npm install               # instala dependências
npm run configurar        # assistente que conduz a configuração inteira
npm run gerar:segredos    # gera os 3 segredos que não vêm da Meta
npm run dev               # servidor local (usa .dev.vars e D1 local)
npm run deploy            # publica na Cloudflare
npm run typecheck         # checagem de tipos
npm run lint              # lint
npm run lint:fix          # lint corrigindo o que dá
npm run format            # formatação
npm test                  # roda os 125 testes
npm run test:watch        # testes em modo watch
npm run test:webhook      # simula um webhook contra o servidor local
npm run db:migrate:local  # migrations no banco local
npm run db:migrate:remote # migrations no banco remoto
npm run tail              # logs ao vivo do Worker publicado
npm run check             # lint + typecheck + testes
```

---

## Como o sistema funciona (resumo)

### Estrutura de arquivos

```
src/config.ts                  automationConfig + mediaAutomations (config NÃO secreta)
src/index.ts                   roteador + handler scheduled do cron
src/routes/                    webhook.ts, oauth.ts, health.ts, legal.ts
src/services/                  meta-api.ts, automation.ts, token-manager.ts
src/repositories/              comments-repository.ts, tokens-repository.ts
src/security/                  webhook-signature.ts, encryption.ts, oauth-state.ts, constant-time.ts
src/types/                     env.ts, meta.ts
src/utils/                     normalize.ts, templates.ts, hash.ts
migrations/0001_initial.sql
scripts/                       gerar-segredos.mjs, simular-webhook.mjs
tests/                         125 testes em 6 arquivos
```

### Hosts da Meta — cada etapa usa um host diferente

Isso costuma gerar erro de configuração, então vale memorizar:

| Etapa | Host |
|---|---|
| Tela de consentimento | `https://www.instagram.com/oauth/authorize` |
| Troca do code por token | `POST https://api.instagram.com/oauth/access_token` (**único** uso desse host) |
| Todo o resto | `https://graph.instagram.com` |

`graph.facebook.com` **não é usado** neste projeto — ele pertence ao fluxo com
Facebook Login, que é outro caminho.

### Endpoints usados

| Ação | Chamada |
|---|---|
| Resposta pública | `POST https://graph.instagram.com/v25.0/{comment-id}/replies` — body `{"message":"..."}` |
| Direct | `POST https://graph.instagram.com/v25.0/{ig-user-id}/messages` — body `{"recipient":{"comment_id":"..."},"message":{"text":"..."}}` |
| Dados da conta | `GET https://graph.instagram.com/v25.0/me?fields=user_id,username` (o campo correto é `user_id`, **não** `id`) |
| Token longo | `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` (**sem** versão no path) |
| Refresh | `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` (**sem** versão no path) |
| Inscrição da conta | `POST https://graph.instagram.com/v25.0/me/subscribed_apps?subscribed_fields=comments` |

### Ordem do fluxo (crítica)

```
claim atômico no D1  ->  Direct  ->  resposta pública
```

Se o Direct falhar, a **resposta pública NÃO é publicada**. Isso é proposital:
evita responder publicamente prometendo um link que a pessoa nunca recebeu.

### Limites confirmados

- **Private reply: apenas UMA por comentário.** Janela de **7 dias** a partir da
  criação do comentário.
- Rate limit de private replies: **750 chamadas por hora** por conta
  profissional.
- Code do OAuth: vale **1 hora**, é de **uso único**, e a Meta anexa `#_` no
  final, que precisa ser removido (o projeto já faz isso).

### Segurança implementada

- HMAC-SHA256 do webhook via `crypto.subtle.verify` (comparação em tempo
  constante).
- Comparação de tokens em tempo constante (`src/security/constant-time.ts`).
- `state` do OAuth assinado com HMAC e com expiração de **10 minutos**.
- Token cifrado com **AES-GCM 256** no D1, com IV aleatório por operação.
- Coleta mínima: não guarda texto do comentário nem username; o IGSID do autor é
  guardado apenas como SHA-256.
- Limite de **512KB** no corpo do webhook.
- Nenhum segredo em log.

---

## Pendências que você precisa resolver

Estas quatro coisas vêm com um texto de exemplo no lugar do valor de verdade.
Resolva antes de considerar a automação pronta:

1. **`database_id` em `wrangler.jsonc`** vem como
   `COLE_AQUI_O_ID_DO_SEU_BANCO_D1`. É preenchido no passo 4 deste guia.
2. **`META_APP_ID` em `wrangler.jsonc`** vem como
   `COLE_AQUI_O_ID_DO_SEU_APP_META`. É o ID público do seu app; você pega ele na
   etapa 6 do `SETUP_META.md`.
3. **`destinationUrl` em `src/config.ts`** vem como
   `[COLOQUE_O_SEU_LINK_AQUI]`. É o link que a automação envia por Direct. Sem
   isso, a mensagem sai com o texto de exemplo no lugar do link — o projeto
   inclusive detecta esse caso e avisa.
4. **`CONTATO_EMAIL` e `NOME_RESPONSAVEL` em `src/routes/legal.ts`** também são
   textos de exemplo. Essas páginas (`/privacy-policy` e `/data-deletion`) são
   exigidas pela Meta e precisam ter dados reais de contato.

E uma conferência, que não é um arquivo mas trava tudo quando está errada:
verifique se o **"ID do app do Instagram"** e a **"Chave secreta do app do
Instagram"** — os que aparecem na tela **Casos de uso > Personalizar** — são os
mesmos valores que você colocou em `META_APP_ID` e `META_APP_SECRET`. No fluxo
de Instagram Login são **esses** que valem, e não os de **Configurações >
Básico**.

---

## Se algo não estiver aqui

Este guia cobre apenas o que foi verificado no projeto e na documentação
oficial. Se você precisar de um endpoint, permissão, limite ou tela do painel
que não aparece acima, **consulte a documentação oficial da Meta e da
Cloudflare** em vez de supor — a Meta muda nomes de permissão e de tela com
frequência, e chutar aqui custa horas de depuração.
