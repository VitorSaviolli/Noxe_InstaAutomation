# SETUP_META.md — Guia do zero no Meta for Developers

Guia passo a passo para quem **nunca** abriu o painel do Meta for Developers.
Leia na ordem. Não pule etapas: várias delas dependem da anterior.

Este guia é específico do projeto **noxe-insta-automation** (automação de
comentários do Instagram rodando em Cloudflare Workers + TypeScript + D1).

---

## Onde você está

Este é o **segundo** dos dois guias de instalação, e ele começa onde o outro
termina:

1. **`SETUP_CLOUDFLARE.md` primeiro** — banco criado, segredos cadastrados e
   Worker publicado.
2. **`SETUP_META.md` — este aqui, depois.**

**Por que nessa ordem:** a URL pública do seu Worker (o endereço terminado em
`.workers.dev`) **só passa a existir depois do primeiro deploy**, feito no outro
guia. O painel da Meta pede essa URL em três campos e não aceita nada no lugar
dela. Sem o deploy feito, você trava na etapa 4 daqui.

### O que você precisa ter em mãos antes de começar

- [ ] **A URL pública do seu Worker**, anotada, saída do `npm run deploy`. Se
      você não tem essa URL, pare e faça o `SETUP_CLOUDFLARE.md` até o passo 8.
- [ ] **O `SETUP_ADMIN_TOKEN`** que você gerou e cadastrou no outro guia
      (passo 6.4 de lá). É a senha das rotas administrativas.
- [ ] **Uma conta no Facebook.** É ela que vira a sua conta de desenvolvedor —
      não tem como fugir disso, mesmo o projeto sendo do Instagram.
- [ ] **Uma conta profissional no Instagram** (Comercial ou Criador de
      conteúdo), que é a conta que será automatizada. Conta pessoal **não
      funciona**. Veja logo abaixo como converter.

### Obrigatório: a conta do Instagram precisa ser profissional

A API que este projeto usa (responder comentários e mandar Direct) **só existe
para contas profissionais**. Se a sua conta ainda é pessoal, converta antes de
qualquer outra coisa — leva menos de dois minutos, é gratuito e reversível:

1. Abra o **app do Instagram** no celular, com a conta que será automatizada.
2. Toque no seu perfil e vá em **Menu (☰) → Configurações e privacidade**.
3. Entre em **Tipo de conta e ferramentas → Mudar para conta profissional**.
4. Escolha uma categoria e, quando perguntarem, selecione **Criador de
   conteúdo** ou **Comercial** — os dois servem para este projeto.
5. Se o app oferecer **vincular a uma Página do Facebook**, aceite e vincule à
   sua conta do Facebook. Isso facilita o resto do caminho no painel da Meta.

Depois de converter, confira em **Configurações → Tipo de conta e
ferramentas**: deve aparecer que a conta é profissional.

> As telas do app do Instagram e do painel da Meta mudam de nome com alguma
> frequência. Se o caminho descrito não bater exatamente com o que você vê,
> procure pelas palavras-chave ("conta profissional", "tipo de conta") no menu
> de configurações.

---

## Dados do projeto que você vai usar o tempo todo

| Item | Valor |
|---|---|
| Nome do Worker | `noxe-insta-automation` |
| URL pública | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev` — **exemplo**; use a que saiu do seu `npm run deploy` |
| Banco D1 | `noxe-insta-automation` — criado por você no passo 4 do `SETUP_CLOUDFLARE.md` |
| Arquivo de configuração | `wrangler.jsonc` (**não** existe `wrangler.toml` neste projeto) |
| Versão da Graph API | `v25.0` (variável `META_API_VERSION` no `wrangler.jsonc`) |

> Toda vez que este guia mostrar `SEU-WORKER.SEU-SUBDOMINIO.workers.dev`, troque
> pelo seu endereço real. Ele é um exemplo e não funciona se você colar do jeito
> que está.

### Rotas que o Worker já expõe

| Método | Rota | Para que serve | Proteção |
|---|---|---|---|
| GET | `/health` | Checar se o Worker está no ar | pública |
| GET | `/privacy-policy` | Política de privacidade (a Meta exige uma URL) | pública |
| GET | `/data-deletion` | Instruções de exclusão de dados (a Meta exige) | pública |
| GET | `/webhooks/instagram` | Handshake do webhook (`hub.mode`, `hub.verify_token`, `hub.challenge`) | validada pelo Verify Token |
| POST | `/webhooks/instagram` | Recebe os eventos; valida `X-Hub-Signature-256`, responde 200 rápido e processa em `waitUntil` | assinatura HMAC |
| GET | `/setup/authorize` | Devolve a URL de consentimento para você abrir no navegador | `Authorization: Bearer SETUP_ADMIN_TOKEN` |
| GET | `/oauth/callback` | Recebe o `code`, troca por token, salva cifrado e já assina a conta | `state` assinado |
| POST | `/setup/subscribe` | Refaz a inscrição da conta (nível conta) manualmente | `Authorization: Bearer SETUP_ADMIN_TOKEN` |

### Hosts da Meta (leia com atenção — cada etapa usa um host diferente)

Esta é uma das maiores fontes de confusão. São **três** hosts distintos:

| Etapa | Host |
|---|---|
| Tela de consentimento (onde a pessoa clica "Permitir") | `https://www.instagram.com/oauth/authorize` |
| Troca do `code` por token curto | `POST https://api.instagram.com/oauth/access_token` — **único** uso desse host |
| Todo o resto (token longo, refresh, comentários, Direct, inscrição) | `https://graph.instagram.com` |

> **`graph.facebook.com` NÃO é usado neste projeto.** Esse host pertence ao
> outro fluxo (o de Facebook Login para Instagram). Se você seguir um tutorial
> da internet que manda usar `graph.facebook.com`, é outro fluxo — ignore.

---

## 1. Criar conta no Meta for Developers

1. Abra <https://developers.facebook.com>.
2. Clique em **Começar** (canto superior direito).
3. Faça login com uma conta do **Facebook**. Sim, precisa de uma conta do
   Facebook mesmo o projeto sendo do Instagram — é a conta do Facebook que vira
   sua conta de desenvolvedor.
4. A Meta vai pedir para:
   - **confirmar seu e-mail**;
   - **verificar seu número de telefone** por SMS;
   - responder "em que você é bom?" (pode escolher *Desenvolvedor*);
   - aceitar os termos de plataforma.
5. Ao final você cai no painel em <https://developers.facebook.com/apps>.

Pré-requisito paralelo, do lado do Instagram: a conta que vai ser automatizada
precisa ser **profissional** (Comercial ou Criador de conteúdo). Se você pulou o
bloco "Onde você está" lá em cima, volte nele agora — a conversão está explicada
lá e é obrigatória. Conta pessoal não consegue autorizar este app.

---

## 2. Criar o app correto (qual tipo escolher)

1. No painel, clique em **Meus apps → Criar app**.
2. A Meta hoje pergunta primeiro **"O que você quer que seu app faça?"** —
   é uma lista de **casos de uso**. Escolha a opção relacionada ao
   **Instagram** (normalmente aparece como *Outro* → depois tipo **Empresa**,
   ou diretamente um caso de uso de Instagram, dependendo da versão do painel
   que a Meta te mostrar).
3. Se ele pedir o **tipo de app**, escolha **Empresa** (*Business*). É o tipo
   que dá acesso ao produto do Instagram com API.
4. Dê um nome ao app (ex.: `noxe-insta-automation`) e informe um e-mail de
   contato.
5. Se a sua conta já tiver um Portfólio Empresarial (Business Manager),
   ele pode ser vinculado aqui. Não é obrigatório neste momento para usar a
   sua própria conta.

> **Não escolha** os tipos *Consumidor*, *Jogos* ou *Workplace* — eles não
> oferecem o caso de uso do Instagram que precisamos.

> Se a tela que a Meta te mostrar for diferente do descrito (o painel muda com
> frequência), a regra que vale é: você precisa terminar com um app que tenha o
> caso de uso **Instagram** com **Instagram Login (Business Login)** disponível.
> Se não conseguir localizar essa opção, confira a documentação oficial do
> produto Instagram Platform antes de improvisar.

---

## 3. Adicionar o produto / caso de uso do Instagram

1. Já dentro do app, no menu lateral, procure **Casos de uso**
   (ou, em painéis mais antigos, **Adicionar produto** → **Instagram**).
2. Adicione o caso de uso de **Instagram** e clique em **Personalizar**.
3. Você vai cair numa tela com abas/seções do tipo:
   - **Permissões** (os scopes)
   - **Configurações** (Instagram Login, URIs de redirecionamento, credenciais)
   - **Webhooks**

Guarde o caminho **Casos de uso → Personalizar** — vamos voltar nele nas etapas
6, 7, 9, 10 e 11.

---

## 4. Configurar o Instagram Login (Business Login)

O fluxo deste projeto é o **Instagram Login** (também chamado de *Business
Login for Instagram*): a pessoa se autentica direto no `instagram.com`, sem
passar por Página do Facebook.

Dentro de **Casos de uso → Instagram → Personalizar → Configurações**:

1. Localize a área de **Configurar o login do Instagram para empresas**.
2. Em **URI de redirecionamento OAuth válidos**, adicione **exatamente** (com a
   sua URL no lugar do exemplo):

   ```
   https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/oauth/callback
   ```

   Regras que a Meta aplica sem perdão:
   - tem que ser **HTTPS**;
   - o valor precisa bater **caractere por caractere** com o `redirect_uri`
     enviado no consentimento (sem barra sobrando no final, sem `www` a mais);
   - se você mudar o domínio do Worker depois, tem que atualizar aqui.

3. Se a tela pedir também **URL de cancelamento de autorização** e
   **URL de solicitação de exclusão de dados**, use:

   | Campo | Valor |
   |---|---|
   | URL da política de privacidade | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/privacy-policy` |
   | Exclusão de dados | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/data-deletion` |

4. Salve.

> **Pendência do projeto:** as rotas `/privacy-policy` e `/data-deletion` estão
> implementadas em `src/routes/legal.ts`, mas ainda contêm os placeholders
> `CONTATO_EMAIL` e `NOME_RESPONSAVEL`. Preencha antes de colar essas URLs no
> painel — a Meta (e qualquer revisor) abre essas páginas.

---

## 5. Adicionar a conta como autorizada / de teste

Enquanto o app está em modo de desenvolvimento, **só contas explicitamente
vinculadas ao app conseguem autorizar**. É por isso que muita gente toma
"erro de permissão" logo no primeiro login: a conta simplesmente não estava na
lista.

Na mesma tela de **Casos de uso → Instagram → Personalizar**, procure a seção
de **testadores do Instagram** (nomes que aparecem: *Testadores*, *Contas de
teste do Instagram*, *Funções → Testadores do Instagram*):

1. Clique em **Adicionar pessoas / Adicionar conta de teste do Instagram**.
2. Digite o **@usuário** da conta profissional do Instagram que será
   automatizada.
3. Envie o convite.
4. **Aceite o convite no app do Instagram**, com a conta convidada:
   **Configurações → Site (ou "Aplicativos e sites") → Convites de testador →
   Aceitar**. O convite fica pendente até esse aceite — e sem o aceite o
   consentimento do passo 8 falha.

Se a conta que você vai automatizar é a mesma do administrador do app, ainda
assim faça esse convite e o aceite. Não confie em "é minha conta, deve
funcionar".

---

## 6. Onde achar App ID e App Secret — ⚠️ ALERTA DOS DOIS PARES

Este é **o ponto onde mais gente trava**. Existem **dois pares de credenciais
diferentes** dentro do mesmo app, com nomes parecidos, em telas diferentes:

| Onde | Como aparece | Serve para |
|---|---|---|
| **Configurações → Básico** | *Identificação do app* e *Chave secreta do app* | Credenciais do **app do Facebook**. Usadas no fluxo com Facebook Login (`graph.facebook.com`). |
| **Casos de uso → Instagram → Personalizar** (área de configuração do Instagram Login) | *ID do app do Instagram* e *Chave secreta do app do Instagram* | Credenciais do **Instagram Login** — o fluxo deste projeto. |

### Qual vale para nós

👉 **Para o fluxo Instagram Login (o deste projeto), valem as credenciais da
tela do caso de uso do Instagram**: o **ID do app do Instagram** e a **Chave
secreta do app do Instagram**.

Se você usar por engano o par de **Configurações → Básico**, o sintoma típico
é o consentimento até abrir, mas a troca do `code` em
`POST https://api.instagram.com/oauth/access_token` falhar com erro de
client inválido — ou a validação da assinatura do webhook nunca bater.

### Onde esses valores entram no projeto

| Valor | Onde vive |
|---|---|
| App ID do Instagram | `META_APP_ID` — variável **não secreta**, no `wrangler.jsonc` |
| App Secret do Instagram | `META_APP_SECRET` — **secret**, via `wrangler secret put` |

### O que fazer agora, na prática

1. Abra o `wrangler.jsonc`, procure o bloco `vars` e substitua o texto
   `COLE_AQUI_O_ID_DO_SEU_APP_META` pelo **ID do app do Instagram**. Salve.
2. Cadastre a chave secreta:

   ```bash
   npx wrangler secret put META_APP_SECRET
   ```

   O comando pergunta o valor; cole e dê Enter. O terminal não mostra o que foi
   colado, e isso é proposital.
3. Publique de novo, para o Worker passar a enxergar os dois valores:

   ```bash
   npm run deploy
   ```

Os 4 segredos do projeto, para referência:

```bash
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SETUP_ADMIN_TOKEN
```

Se você seguiu o `SETUP_CLOUDFLARE.md`, os três últimos **já estão cadastrados**
— foram gerados lá com `npm run gerar:segredos`. Só o `META_APP_SECRET` é novo
aqui. Confira com `npx wrangler secret list`, que mostra os nomes cadastrados
(nunca os valores).

> **Atalho:** `npm run configurar` conduz essa parte também, sem você precisar
> copiar e colar segredo na mão nem editar o `wrangler.jsonc` no editor.

| Secret | O que é |
|---|---|
| `META_APP_SECRET` | Chave secreta do app do Instagram. Usada no OAuth **e** na validação HMAC-SHA256 do webhook. |
| `META_WEBHOOK_VERIFY_TOKEN` | String inventada por você; tem que ser idêntica à digitada no painel (etapa 10). |
| `TOKEN_ENCRYPTION_KEY` | Chave da cifra AES-GCM 256 que protege o token dentro do D1. |
| `SETUP_ADMIN_TOKEN` | Senha das rotas `/setup/*`. Só você usa. |

> **Confira antes de seguir:** os valores que você acabou de colocar em
> `META_APP_ID` / `META_APP_SECRET` precisam ser o *ID do app do Instagram* e a
> *Chave secreta do app do Instagram* (tela de Casos de uso → Personalizar), e
> **não** os de Configurações → Básico. No fluxo Instagram Login, só os do caso
> de uso funcionam. Se você já tinha configurado antes, volte e confirme: é o
> erro que mais custa tempo neste projeto.

---

## 7. Configurar as permissões (os 3 scopes)

Ainda em **Casos de uso → Instagram → Personalizar → Permissões**, garanta que
as três permissões abaixo estejam adicionadas ao caso de uso:

| Scope | Para que o projeto precisa |
|---|---|
| `instagram_business_basic` | Ler os dados básicos da conta (`/me?fields=user_id,username`) |
| `instagram_business_manage_comments` | Ler o comentário recebido e publicar a resposta pública |
| `instagram_business_manage_messages` | Enviar a mensagem no Direct (private reply) |

Regras importantes:

- Os nomes **sem** o prefixo `instagram_` (do estilo antigo) foram
  **descontinuados em 27/01/2025**. Use exatamente os três nomes acima.
- **NÃO** peça `instagram_business_content_publish`. Este projeto não publica
  mídia; pedir permissão a mais só atrapalha (e vira pergunta chata em App
  Review no futuro).
- Enquanto você opera **a sua própria conta**, essas três permissões funcionam
  em **Standard Access** — sem App Review. Veja a etapa 15.

---

## 8. Fazer o primeiro login (OAuth)

Agora o app está configurado. O login é feito em três movimentos.

### 8.1 Republicar o Worker com o App ID e o App Secret

O Worker já está no ar desde o `SETUP_CLOUDFLARE.md`, mas ele ainda não conhecia
o `META_APP_ID` nem o `META_APP_SECRET`. Depois de preencher os dois (etapa 6),
publique de novo para que passem a valer:

```bash
npm run check
npm run deploy
```

O `npm run check` roda lint, checagem de tipos e os **822 testes** antes de
publicar.

> **Vai aparecer aviso sobre segredo faltando durante os testes — é esperado.**
> Os testes não usam os seus segredos de verdade: o `vitest.config.ts` injeta
> valores fictícios. O que vale é a linha final dizendo que os testes passaram.
> Aviso não é erro.

Confira que está no ar:

**Windows (PowerShell)**

```powershell
Invoke-RestMethod https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/health
```

**Mac, Linux ou Git Bash**

```bash
curl https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/health
```

Dentro do bloco `configurado` da resposta, o campo `appId` agora deve estar
`true`. Se continuar `false`, o `META_APP_ID` não foi salvo ou o deploy não foi
refeito.

### 8.2 Pedir a URL de consentimento

A rota `/setup/authorize` é protegida: ela exige o cabeçalho
`Authorization: Bearer` com o valor do seu `SETUP_ADMIN_TOKEN`.

> ⏱️ **A partir daqui você tem 10 minutos.** A URL devolvida carrega um `state`
> assinado que **expira em 10 minutos**. Se você demorar mais do que isso entre
> rodar o comando e clicar em "Permitir" na tela do Instagram, o Worker recusa
> com "State inválido ou expirado" e será preciso pedir uma URL nova. Então:
> só rode o comando quando estiver com o navegador aberto, logado na conta certa
> e pronto para autorizar.
>
> **`npm run configurar` resolve isso para você:** ele pede a URL e já abre o
> navegador direto, sem você ter que caçar e copiar um endereço gigante de dentro
> de um JSON dentro do terminal.

**Windows (PowerShell)**

```powershell
$resposta = Invoke-RestMethod `
  -Uri "https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/authorize" `
  -Headers @{ Authorization = "Bearer SEU_TOKEN_ADMIN" }
$resposta.authorizationUrl
Start-Process $resposta.authorizationUrl
```

A penúltima linha imprime a URL; a última já abre ela no seu navegador padrão.
Se preferir abrir à mão, apague a última linha.

**Mac, Linux ou Git Bash**

```bash
curl -i \
  -H "Authorization: Bearer SEU_TOKEN_ADMIN" \
  "https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/authorize"
```

> **Por que dois comandos diferentes?** No PowerShell do Windows, `curl` é apenas
> um apelido para o `Invoke-WebRequest`, que **não aceita** as opções `-H` e `-i`.
> Colar ali o comando de Mac/Linux devolve um erro confuso sobre parâmetro
> desconhecido — não é problema do seu token nem do Worker. Use sempre o bloco do
> seu sistema.

> ⚠️ **Cuidado com o histórico do terminal.** Colar o `SETUP_ADMIN_TOKEN` direto
> na linha de comando grava ele **em texto puro** no histórico: no PowerShell, no
> arquivo cujo caminho aparece em `(Get-PSReadlineOption).HistorySavePath`; no
> Git Bash, no `~/.bash_history`. Quem tiver acesso à máquina consegue ler
> depois. O `npm run configurar` faz a mesma chamada **sem** deixar o token no
> histórico. Se optar pelo comando manual, apague a linha do histórico ao
> terminar.

A resposta traz a URL de consentimento no campo `authorizationUrl`. Ela aponta
para o host `https://www.instagram.com/oauth/authorize` e já vem com o `state`
assinado (HMAC, validade de 10 minutos) e com os três scopes.

### 8.3 Abrir a URL e autorizar

1. **Abra a URL devolvida no navegador** (o `Start-Process` acima já faz isso).
2. Dica prática: use uma **janela anônima** e faça login com a conta
   profissional correta. Se o navegador estiver logado em outra conta do
   Instagram, você autoriza a conta errada e depois não entende por que nada
   chega.
3. Revise a tela de permissões e clique em **Permitir**. Lembre do cronômetro de
   10 minutos: se aparecer "State inválido ou expirado", não tem mistério —
   repita a etapa 8.2 e seja mais rápido.
4. O Instagram redireciona para `/oauth/callback` no seu Worker. A partir daí,
   sem você fazer mais nada, o Worker:
   - remove o sufixo `#_` que a Meta anexa ao `code`;
   - troca o `code` por um **token curto** em
     `POST https://api.instagram.com/oauth/access_token`;
   - troca o curto por um **token longo** em
     `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`;
   - salva o token **cifrado com AES-GCM 256** no D1;
   - chama
     `POST https://graph.instagram.com/v25.0/me/subscribed_apps?subscribed_fields=comments`
     (a inscrição de **nível conta**, etapa 11b).

Detalhes do `code` que explicam erros comuns:

| Característica do `code` | Consequência prática |
|---|---|
| Vale **1 hora** | Se você demorar, refaça o `/setup/authorize` |
| **Uso único** | Recarregar a página do callback dá erro — é esperado |
| Vem com `#_` no final | O Worker já remove; se você testar na mão, remova |

Para conferir qual conta ficou autorizada (isso exige um token do Instagram em
mãos; o Worker guarda o dele cifrado e não devolve para ninguém, então este
comando só serve se você tiver obtido um token manualmente):

**Windows (PowerShell)**

```powershell
Invoke-RestMethod "https://graph.instagram.com/v25.0/me?fields=user_id,username&access_token=SEU_TOKEN"
```

**Mac, Linux ou Git Bash**

```bash
curl -s "https://graph.instagram.com/v25.0/me?fields=user_id,username&access_token=SEU_TOKEN"
```

> Repare: o campo é **`user_id`**, e **não** `id`. Pedir `id` neste fluxo é
> outro erro clássico.

---

## 9. Configurar a URL do webhook (nível APP, manual no painel)

O webhook precisa ser cadastrado **à mão no painel**. Não existe API para essa
parte.

1. Vá em **Casos de uso → Instagram → Personalizar → Webhooks**.
2. Clique em **Editar** / **Adicionar callback URL**.
3. Preencha:

   | Campo | Valor |
   |---|---|
   | Callback URL | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/webhooks/instagram` |
   | Verify token | o mesmo valor que está em `META_WEBHOOK_VERIFY_TOKEN` |

4. Clique em **Verificar e salvar**.

O que acontece nesse clique: a Meta faz um `GET` na sua Callback URL com
`hub.mode`, `hub.verify_token` e `hub.challenge`. O Worker compara o token em
**tempo constante** e, se bater, devolve o `hub.challenge`. Se não bater, a
Meta mostra "não foi possível validar a URL de callback".

Checklist quando a verificação falhar:

- O Worker está deployado com a versão atual? (`npm run deploy`)
- O secret `META_WEBHOOK_VERIFY_TOKEN` foi realmente gravado **em produção**
  (e não só no `.dev.vars` local)?
- Tem espaço em branco sobrando no início/fim do token colado?
- A URL está com `/webhooks/instagram` (plural em "webhooks")?

Para observar em tempo real enquanto clica em "Verificar e salvar":

```bash
npm run tail
```

---

## 10. Preencher o Verify Token

O Verify Token é uma **string inventada por você**. Não é fornecida pela Meta.
A única regra é: o valor no painel e o valor em `META_WEBHOOK_VERIFY_TOKEN`
precisam ser **idênticos**.

**Se você seguiu o `SETUP_CLOUDFLARE.md`, esse valor já existe** — foi gerado no
passo 6 de lá e guardado no seu gerenciador de senhas. Use aquele mesmo. Não
gere um novo agora: o Worker já está com o antigo cadastrado, e dois valores
diferentes fazem a verificação falhar.

Se precisar gerar um valor novo (ou se perdeu o anterior), use o gerador do
próprio projeto — ele funciona igual no Windows, no Mac e no Linux:

```bash
npm run gerar:segredos
```

Ele imprime os três segredos que você mesmo gera; aproveite só o
`META_WEBHOOK_VERIFY_TOKEN` e ignore os outros dois se eles já estiverem
cadastrados.

**Alternativa**, se preferir gerar por fora, no Mac, Linux ou Git Bash:

```bash
openssl rand -base64 32
```

No PowerShell do Windows o `openssl` normalmente não existe — mais um motivo
para usar o `npm run gerar:segredos`.

Grave no Worker:

```bash
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN
# cole o valor quando pedir
npm run deploy
```

E só então cole o **mesmo** valor no painel (etapa 9). Ordem importa: grave o
secret e faça o deploy **antes** de clicar em "Verificar e salvar".

---

## 11. Assinar o evento "comments" — os DOIS níveis

Aqui mora o erro mais frustrante do projeto: assinar **um** nível só e ficar
esperando eventos que nunca chegam. **São dois, e os dois são obrigatórios.**

| Nível | Onde | Como se faz | Significado |
|---|---|---|---|
| **(a) APP** | Painel da Meta: Casos de uso → Personalizar → Webhooks | **Manual.** Não existe API. | "Este app quer receber o campo `comments`." |
| **(b) CONTA** | `POST /me/subscribed_apps` | Automático no `/oauth/callback`; manual via `/setup/subscribe` | "Esta conta específica autoriza este app a receber os eventos dela." |

### (a) Nível APP — manual

Na aba **Webhooks** do caso de uso do Instagram, na lista de campos
disponíveis, encontre **`comments`** e clique em **Assinar**. Confirme que ele
fica marcado como assinado. Sem isso, a Meta nem tenta entregar nada.

### (b) Nível CONTA — via API

Normalmente já foi feito sozinho no passo 8. Se você precisar refazer (por
exemplo, depois de reautorizar), use a rota administrativa:

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
  "https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/subscribe"
```

> Vale o mesmo aviso da etapa 8.2: o token colado na linha de comando fica
> gravado no histórico do terminal em texto puro. O `npm run configurar` faz essa
> chamada sem expor o token.

Por baixo, isso chama:

```
POST https://graph.instagram.com/v25.0/me/subscribed_apps?subscribed_fields=comments
```

Sintoma clássico de cada falta:

| Sintoma | Provável causa |
|---|---|
| Nenhum evento chega, e o painel não mostra nenhuma tentativa de entrega | Falta o nível **(a) APP** |
| O painel mostra entregas OK em testes, mas comentários reais na sua conta não disparam nada | Falta o nível **(b) CONTA** |
| Entregas aparecem com erro de assinatura | `META_APP_SECRET` errado (veja o alerta da etapa 6) |

---

## 12. Testar com um Reel real SEM atingir seguidores comuns

Você precisa de um comentário **real** para testar o fluxo completo, mas não
quer que a automação responda gente que não pediu nada. A técnica abaixo usa só
recursos nativos do Instagram.

### Trave a automação em UM único post (o jeito seguro de testar)

De fábrica a automação vale para **todos** os Reels da conta
(`allowedMediaIds: ['*']`). Para testar, troque o `*` pelo ID do Reel de teste:
assim, mesmo que alguém comente a palavra-gatilho em outro post antigo, **nada
acontece**.

Em `src/config.ts`:

```ts
// de fábrica: qualquer Reel dispara
allowedMediaIds: ['*'],

// durante o teste: SÓ este Reel dispara
allowedMediaIds: ['17912345678901234'],
```

Depois do teste, volte para `['*']` (ou deixe travado, se você só quer automatizar
posts escolhidos a dedo). **Toda mudança em `src/config.ts` só vale depois de
`npm run deploy`** — o arquivo é lido pelo Worker publicado, não pela sua máquina.

#### Como descobrir o ID do Reel

O ID da mídia **não** é o código que aparece na URL do post
(`instagram.com/reel/ABC123...`). É um número longo, e há três formas de obtê-lo:

**1. Pelo painel da Meta (não precisa de token — mais fácil)**

Comente a palavra-gatilho no Reel e vá em **Casos de uso → Instagram →
Personalizar → Webhooks → Entregas recentes**. Abra a última entrega e procure no
corpo JSON:

```json
{ "field": "comments", "value": { "media": { "id": "17912345678901234" } } }
```

Esse `media.id` é o que você cola em `allowedMediaIds`.

**2. Pelo banco D1 (depois que algum comentário já foi processado)**

```bash
npx wrangler d1 execute noxe-insta-automation --remote \
  --command "SELECT media_id, created_at FROM processed_comments ORDER BY created_at DESC LIMIT 5"
```

**3. Pela Graph API (exige um token do Instagram em mãos)**

O Worker guarda o token dele **cifrado** e não devolve para ninguém, então isto só
serve se você tiver obtido um token manualmente:

```bash
curl -s "https://graph.instagram.com/v25.0/me/media?fields=id,media_type,permalink&access_token=SEU_TOKEN"
```

#### Mensagem diferente por post

Se você quer **vários** posts ativos, cada um entregando um link diferente, não
use `allowedMediaIds` — use `mediaAutomations`, no mesmo `src/config.ts`. Cada
entrada sobrepõe a configuração global só para os IDs listados:

```ts
export const mediaAutomations: MediaAutomation[] = [
  {
    mediaIds: ['17912345678901234'],
    triggerKeywords: ['cardápio'],
    privateReplyText: 'Segue o cardápio como prometido😊 {link}',
    destinationUrl: 'https://seusite.com.br/cardapio',
  },
]
```

O que você não citar na entrada continua vindo da configuração global.

### Receita concreta

1. **Publique um Reel novo, exclusivo para teste.**
   - Conteúdo neutro (uma tela preta, um clipe de 3 segundos, qualquer coisa).
   - Antes de publicar, em **Configurações avançadas**, **desligue** a
     recomendação em outras contas e, se disponível, **desative** a exibição
     na aba Reels/Explorar.

2. **Restrinja quem vê.** Publique com o alcance mais fechado que a sua conta
   permitir (por exemplo, usando a lista de **Melhores amigos** para o Stories
   que divulgaria o Reel, e simplesmente **não divulgando** o Reel em lugar
   nenhum). Se a sua conta tiver muitos seguidores ativos, considere
   temporariamente publicar em horário de baixo movimento.

3. **Feche os comentários para o público** enquanto configura: no Reel, use
   **Configurações de comentário** para limitar quem pode comentar (por
   exemplo, apenas pessoas que você segue). Assim, só a sua conta secundária
   comenta.

4. **Comente de uma conta secundária SUA.**
   - Crie/uso uma segunda conta do Instagram que seja sua.
   - Ela precisa **seguir** a conta principal e ter as DMs abertas, senão o
     Direct do teste não chega.
   - Comente exatamente a palavra-chave configurada em `src/config.ts`.

5. **Observe os logs enquanto comenta:**

   ```bash
   npm run tail
   ```

6. **Confirme o resultado esperado**, nesta ordem (a ordem é crítica no
   código): claim atômico no D1 → **Direct** → **resposta pública**.
   Se o Direct falhar, a resposta pública **não** é publicada. Então:
   - se você recebeu o Direct **e** viu a resposta pública → fluxo OK;
   - se não recebeu Direct e também não apareceu resposta pública → o erro está
     no Direct, não na resposta.

7. **Depois do teste, arquive o Reel** (menu `...` do post → **Arquivar**). Ele
   some do perfil e continua existindo para você. Não apague: se precisar
   investigar o comentário depois, ele ainda estará lá.

### Limites que valem no teste

| Limite | Valor |
|---|---|
| Private reply por comentário | **Apenas 1** — repetir no mesmo comentário não funciona |
| Janela do private reply | **7 dias** a partir da criação do comentário |
| Rate limit de private replies | **750 chamadas/hora** por conta profissional |

Ou seja: para testar de novo, **faça um comentário novo**. Reaproveitar o mesmo
comentário sempre vai falhar por design.

### Endpoints envolvidos (para conferir manualmente, se quiser)

Você **não precisa** destes comandos para o fluxo normal — o Worker faz tudo
sozinho. Eles servem para depurar na mão, e exigem um token do Instagram válido.

**Resposta pública em um comentário**

Windows (PowerShell):

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://graph.instagram.com/v25.0/{comment-id}/replies" `
  -Headers @{ Authorization = "Bearer SEU_TOKEN" } `
  -ContentType "application/json" `
  -Body '{"message":"texto da resposta"}'
```

Mac, Linux ou Git Bash:

```bash
curl -X POST "https://graph.instagram.com/v25.0/{comment-id}/replies" \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"texto da resposta"}'
```

**Direct (private reply) a partir de um comentário**

Windows (PowerShell):

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://graph.instagram.com/v25.0/{ig-user-id}/messages" `
  -Headers @{ Authorization = "Bearer SEU_TOKEN" } `
  -ContentType "application/json" `
  -Body '{"recipient":{"comment_id":"COMMENT_ID"},"message":{"text":"texto do direct"}}'
```

Mac, Linux ou Git Bash:

```bash
curl -X POST "https://graph.instagram.com/v25.0/{ig-user-id}/messages" \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"recipient":{"comment_id":"COMMENT_ID"},"message":{"text":"texto do direct"}}'
```

> **Confira antes do teste:** o campo `destinationUrl` em `src/config.ts` precisa
> ser o **seu** link. Se ele ainda estiver com um marcador entre colchetes, a
> automação recusa o acionamento com o motivo `link_nao_configurado` e ninguém
> recebe nada. E se o repositório veio com o link de outra pessoa, troque —
> senão o Direct entrega o link errado.

---

## 13. Renovar o token

| Token | Duração |
|---|---|
| Token curto (saído do `code`) | **1 hora** |
| Token longo | **60 dias** (5.184.000 s) |

O projeto renova sozinho: o handler `scheduled` (o cron, em `src/index.ts`)
chama o refresh periodicamente através do `src/services/token-manager.ts`.

Endpoint usado no refresh (repare: **sem versão no path**):

```
GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
```

E o de troca curto → longo, também **sem versão no path**:

```
GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token
```

Regras do refresh que você precisa saber:

| Condição | Resultado |
|---|---|
| Token com **menos de 24h** de idade | A Meta **recusa** o refresh. É preciso esperar. |
| Token válido e com mais de 24h | Renova, voltando para 60 dias |
| Token **já expirado** | **Não há refresh possível** |

### E se passar dos 60 dias sem renovar?

Não existe recuperação por API. O único caminho é **refazer o OAuth do zero** —
e vale de novo o limite de 10 minutos entre pedir a URL e clicar em "Permitir".
O caminho mais fácil continua sendo `npm run configurar`, que abre o navegador
direto. Na mão:

**Windows (PowerShell)**

```powershell
$resposta = Invoke-RestMethod `
  -Uri "https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/authorize" `
  -Headers @{ Authorization = "Bearer SEU_TOKEN_ADMIN" }
Start-Process $resposta.authorizationUrl
```

**Mac, Linux ou Git Bash**

```bash
curl -i \
  -H "Authorization: Bearer SEU_TOKEN_ADMIN" \
  "https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/setup/authorize"
```

Autorize de novo (etapa 8) e pronto — o `/oauth/callback` grava o token novo e
refaz a inscrição de nível conta. Depois disso, confirme a inscrição com
`POST /setup/subscribe` (etapa 11b) se quiser ter certeza.

Prevenção barata: coloque um lembrete no calendário a cada ~30 dias para rodar
`npm run tail` e conferir que o cron está renovando sem erro.

---

## 14. Onde ver erros no painel da Meta

Quando "não chega nada", o painel da Meta responde metade das perguntas.

| Onde olhar | O que você vê |
|---|---|
| **Casos de uso → Instagram → Personalizar → Webhooks → Entregas recentes** | Cada tentativa de entrega, o corpo enviado e o código HTTP que o seu Worker devolveu. É aqui que você descobre se a Meta tentou e você respondeu errado, ou se ela nem tentou. |
| **Painel do app → Alertas** | Avisos do app: permissão descontinuada, versão da API sendo aposentada, problemas de conformidade. |
| **Configurações → Básico** | Estado do app (desenvolvimento/produção), URLs obrigatórias faltando. |
| **Ferramentas → Explorador da API de Gráficos** | Útil para testar chamadas manualmente — lembrando que este projeto usa `graph.instagram.com`, então nem tudo do explorador se aplica. |

E do lado do Cloudflare:

```bash
npm run tail        # logs ao vivo do Worker
```

Interpretação rápida das entregas recentes:

| Código devolvido pelo Worker | Significado provável |
|---|---|
| `200` | Recebido e aceito (o processamento acontece depois, em `waitUntil`) |
| `401` / `403` | Assinatura `X-Hub-Signature-256` não bateu → `META_APP_SECRET` errado |
| `413` (ou rejeição por tamanho) | Corpo acima do limite de **512 KB** que o Worker impõe |
| `5xx` | Erro no Worker → veja `npm run tail` |

> Lembre: o Worker **não** registra texto de comentário nem username, e guarda o
> IGSID do autor apenas como SHA-256. Então não espere achar o conteúdo do
> comentário nos seus próprios logs — por design, ele não está lá. Para ver o
> conteúdo entregue, use as **entregas recentes** no painel da Meta.

---

## 15. App Review, Acesso Avançado e o ícone do app

### 15.1 Antes de tudo: você precisa mesmo de App Review?

| Cenário | O que basta |
|---|---|
| Automatizar **a sua própria** conta profissional | **Standard Access** — **não exige App Review** |
| Atender contas de **terceiros / clientes** | **Advanced Access**, que exige **App Review** + **Verificação Comercial** (Business Verification) |

Enquanto o projeto só mexe na **sua** conta (com ela adicionada como testadora,
etapa 5), você **não precisa** submeter nada para revisão. Isso só muda no dia em
que outra empresa ou pessoa for conectar a conta dela ao seu app.

> **Por que o painel insiste em pedir, então?** O assistente do Instagram no
> painel da Meta mostra "Complete app review" como um dos passos numerados da
> lista. Ele é uma **sugestão do assistente**, não um bloqueio: com Standard
> Access e a sua conta como testadora, a automação funciona sem revisão nenhuma.
> Você pode submeter mesmo assim — só saiba que é opcional no seu caso, e que a
> análise leva semanas.

Se você **vai** submeter (ou vai atender clientes), o resto desta etapa é o
roteiro completo.

---

### 15.2 Os 4 campos obrigatórios antes de conseguir submeter

A Meta **não deixa** você abrir a submissão enquanto estes quatro itens não
estiverem preenchidos. Todos ficam em **Configurações → Básico** (menu lateral do
app), exceto onde indicado:

| Campo | O que é | Valor para este projeto |
|---|---|---|
| **Ícone do app** | Imagem quadrada de **1024 × 1024** px | Sua logo. Veja a 15.3 — é o item que mais gente esquece. |
| **URL da Política de Privacidade** | Página pública que explica o tratamento dos dados | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/privacy-policy` |
| **Categoria do app** | A categoria que melhor descreve o que o app faz | *Empresa e páginas* / *Utilitários* costumam servir. Escolha a mais honesta. |
| **E-mail comercial** | Fica em **Configurações do desenvolvedor**, não em Básico | É para onde a Meta manda o **resultado da revisão** e os alertas. Use um e-mail que você lê de verdade. |

Preencha também, se a tela pedir:

| Campo | Valor |
|---|---|
| Instruções de exclusão de dados do usuário | `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/data-deletion` |
| URL dos Termos de Serviço | Opcional para o Instagram Platform. Só preencha se você tiver uma página real. |

> **Não confunda com a etapa 4.** O campo de **URI de redirecionamento** (aquele
> único campo de "redirect URL" do *Set up Instagram business login*) recebe
> **só** `.../oauth/callback`. As URLs de privacidade e de exclusão de dados são
> outra tela — esta aqui, **Configurações → Básico**.

---

### 15.3 O ícone do app (a "foto") — obrigatório

Este é um requisito real e fácil de esquecer, porque ele não aparece na lista de
passos do assistente do Instagram: ele mora em **Configurações → Básico**.

**Especificação:**

| Item | Regra |
|---|---|
| Dimensões | **1024 × 1024 px** — quadrado exato |
| Formato | PNG (JPG também é aceito) |
| Fundo | Use fundo **sólido**. Transparência costuma virar preto ou branco dependendo de onde a imagem é exibida. |
| Cantos | Envie **quadrado**, sem cantos arredondados desenhados. A Meta arredonda sozinha na exibição. |
| Peso | Mantenha abaixo de ~5 MB. Uma logo em PNG raramente passa disso. |

**Onde subir:** menu lateral → **Configurações → Básico** → campo **Ícone do
app** → *Carregar/Editar*. Salve no rodapé da página.

**Onde ele aparece:** não é decoração. Esse ícone é o que a pessoa vê na **tela
de consentimento do Instagram**, na hora de clicar em "Permitir" (etapa 8.3), e é
o que o revisor da Meta vê. Um ícone genérico ou vazio piora a taxa de aprovação.

**Regras de conteúdo que reprovam o app:**

- ❌ **Não** use o logo do Instagram, da Meta, do Facebook, a câmera colorida, nem
  nada derivado das marcas deles. É violação de marca e é motivo de reprovação.
- ❌ **Não** sugira que a Meta patrocina, aprova ou faz parte do seu app.
- ❌ **Não** use a palavra "Instagram" (nem "insta", "gram") como elemento
  principal do ícone.
- ✅ Use a **sua** logo, ou uma marca própria simples: uma letra, um símbolo, uma
  forma. Precisa ficar legível reduzido a ~40 px.

> **Não tem logo?** Serve qualquer imagem quadrada própria e legível — inclusive
> uma feita num editor gratuito (Canva, Figma, GIMP). O que não pode é ficar
> vazio nem usar marca alheia.

---

### 15.4 As páginas legais precisam estar de verdade preenchidas

As rotas `/privacy-policy` e `/data-deletion` já existem e já estão no ar. Mas
elas nascem com **placeholders**: enquanto `CONTATO_EMAIL` e `NOME_RESPONSAVEL`
não forem preenchidos em `src/routes/legal.ts`, as páginas exibem um aviso
dizendo que os dados de contato ainda não foram informados.

O revisor **abre essas páginas**. Uma página dizendo "dados de contato ainda não
preenchidos" é reprovação na primeira olhada.

1. Abra `src/routes/legal.ts`.
2. Troque `[SEU_EMAIL_DE_CONTATO]` por um e-mail real que você lê.
3. Troque `[NOME_DO_RESPONSAVEL]` pelo seu nome ou o da sua empresa.
4. Publique:

   ```bash
   npm run check
   npm run deploy
   ```

5. Abra as duas URLs no navegador e confira que o aviso sumiu, **antes** de colar
   as URLs no painel.

---

### 15.5 O screencast (vídeo da demonstração)

A Meta exige um vídeo mostrando o **fluxo completo, de ponta a ponta**, para cada
permissão pedida. É a parte que mais reprova gente por preguiça.

Regras da própria Meta:

- Use o **inglês** como idioma da interface quando possível. Se a sua interface
  estiver em português, **coloque legendas** explicando o que está acontecendo.
- **Explique o que cada botão faz** se não for óbvio na tela.
- Mostre a experiência **completa** — não pedaços soltos.

**Roteiro sugerido para este projeto** (grave a tela do computador + a tela do
celular, ou use o celular filmado):

1. Mostre a tela de consentimento abrindo (a URL do `/setup/authorize`), com o
   nome e o **ícone** do seu app visíveis, e clique em **Permitir**.
   → cobre `instagram_business_basic`
2. Mostre o Reel publicado na conta.
3. De uma **segunda** conta, comente a palavra-gatilho no Reel.
4. Mostre a **resposta pública** aparecendo embaixo do comentário.
   → cobre `instagram_business_manage_comments`
5. Mostre o **Direct chegando** na segunda conta, com o link.
   → cobre `instagram_business_manage_messages`
6. Feche mostrando que só quem comentou a palavra-gatilho recebeu algo.

Grave em uma tomada só, sem cortes, se conseguir. Corte dá impressão de
encenação e gera pedido de novo vídeo.

---

### 15.6 Justificativa de cada permissão

A Meta pede um texto explicando **por que** o app precisa de cada permissão.
Escreva em inglês. Modelos para copiar e adaptar:

| Permissão | Justificativa (adapte ao seu caso) |
|---|---|
| `instagram_business_basic` | *"Required to identify the connected professional account (user_id and username) after login, so the app knows which account it is automating. No media is published and no other profile data is read."* |
| `instagram_business_manage_comments` | *"The app reads incoming comments on the account's own Reels to detect a keyword the account owner configured, and posts a single public reply telling the commenter that a direct message was sent. It only reads and replies on media owned by the connected account."* |
| `instagram_business_manage_messages` | *"When a comment matches the configured keyword, the app sends one private reply (direct message) to that commenter containing the link the account owner configured. It is a one-time reply per comment, triggered only by an explicit user action (the comment)."* |

> **NÃO peça `instagram_business_content_publish`.** Este projeto não publica
> mídia nenhuma. Pedir permissão que você não usa é a pergunta mais chata que a
> revisão faz — e você não vai ter o que responder.

---

### 15.7 Verificação Comercial (Business Verification)

Se o seu app for atender **terceiros**, além da revisão das permissões a Meta
exige a **verificação do negócio** dentro do Portfólio Empresarial (Business
Manager): documento da empresa, comprovante de endereço, telefone ou site do
domínio. É um processo separado e mais demorado que a revisão das permissões.

Para automatizar **só a sua conta**, isso não é exigido.

---

### 15.8 Checklist antes de clicar em "Enviar para análise"

- [ ] **Ícone 1024 × 1024** carregado em Configurações → Básico (15.3)
- [ ] URL da **Política de Privacidade** preenchida e a página abrindo sem o aviso de placeholder
- [ ] URL de **exclusão de dados** preenchida e abrindo
- [ ] `CONTATO_EMAIL` e `NOME_RESPONSAVEL` preenchidos em `src/routes/legal.ts` e **deploy feito** (15.4)
- [ ] **Categoria** do app escolhida
- [ ] **E-mail comercial** configurado nas Configurações do desenvolvedor
- [ ] Screencast gravado cobrindo as **3** permissões, com legendas se não estiver em inglês (15.5)
- [ ] Justificativa escrita para **cada** permissão (15.6)
- [ ] `instagram_business_content_publish` **não** está na lista de permissões pedidas
- [ ] A automação está **funcionando de verdade** — o revisor vai tentar reproduzir

> Os requisitos exatos de App Review mudam com frequência. Os quatro campos
> obrigatórios, a especificação do ícone e as regras do screencast desta seção
> vieram da documentação oficial da Meta ([Instagram Platform → App
> Review](https://developers.facebook.com/docs/instagram-platform/app-review)).
> Confirme a lista vigente lá antes de submeter.

---

## Apêndice A — Checklist final

- [ ] `SETUP_CLOUDFLARE.md` concluído: Worker publicado e URL anotada
- [ ] Conta de desenvolvedor criada e verificada (etapa 1)
- [ ] Conta do Instagram convertida para **profissional** e vinculada ao Facebook
- [ ] App criado com o caso de uso **Instagram** (etapas 2 e 3)
- [ ] **URI de redirecionamento** = `.../oauth/callback` salvo (etapa 4)
- [ ] Conta adicionada como testadora **e convite aceito no app** (etapa 5)
- [ ] `META_APP_ID` / `META_APP_SECRET` são os do **caso de uso do Instagram** (etapa 6)
- [ ] Os 3 scopes configurados; `content_publish` **não** pedido (etapa 7)
- [ ] Os 4 secrets gravados e `npm run deploy` feito
- [ ] `/setup/authorize` chamado e consentimento concluído (etapa 8)
- [ ] Callback URL + Verify Token validados no painel (etapas 9 e 10)
- [ ] Campo `comments` assinado no **nível APP** (etapa 11a)
- [ ] `/me/subscribed_apps` confirmado no **nível CONTA** (etapa 11b)
- [ ] Teste com Reel restrito + conta secundária feito e Reel arquivado (etapa 12)
- [ ] `destinationUrl` em `src/config.ts` preenchido
- [ ] `CONTATO_EMAIL` e `NOME_RESPONSAVEL` em `src/routes/legal.ts` preenchidos
- [ ] **Ícone 1024 × 1024 do app** carregado em Configurações → Básico (etapa 15.3)
- [ ] URLs de `/privacy-policy` e `/data-deletion` coladas em Configurações → Básico (etapa 15.2)
- [ ] Só faça App Review se for atender **terceiros** — para a sua própria conta não é exigido (etapa 15.1)

## Apêndice B — Comandos do projeto

| Comando | O que faz |
|---|---|
| `npm run configurar` | Assistente que conduz a configuração inteira, sem expor segredo no histórico |
| `npm run gerar:segredos` | Gera os 3 segredos que não vêm da Meta |
| `npm run dev` | Roda o Worker localmente |
| `npm run deploy` | Publica o Worker |
| `npm run typecheck` | Checagem de tipos |
| `npm run lint` / `npm run lint:fix` | Lint |
| `npm run format` | Formatação |
| `npm run test` / `npm run test:watch` | Testes (**822 testes**, em 25 arquivos) |
| `npm run test:webhook` | Simula um webhook contra o servidor local |
| `npm run db:migrate:local` | Aplica migrações no D1 local |
| `npm run db:migrate:remote` | Aplica migrações no D1 de produção |
| `npm run tail` | Logs ao vivo do Worker |
| `npm run check` | Verificação agregada (lint + tipos + testes) |

> Rodar `npm test` num projeto recém-baixado imprime alguns avisos sobre
> segredos ainda não definidos. **É esperado e não é erro:** os testes usam
> valores fictícios injetados pelo `vitest.config.ts`, não os seus segredos
> reais. Olhe a linha final: se disser que passou, passou.

## Apêndice C — Mapa do código (para saber onde mexer)

| Caminho | Responsabilidade |
|---|---|
| `src/config.ts` | `automationConfig` + `mediaAutomations` (configuração **não** secreta) |
| `src/index.ts` | Roteador + handler `scheduled` do cron |
| `src/routes/webhook.ts` | Handshake e recepção dos eventos |
| `src/routes/oauth.ts` | `/setup/authorize` e `/oauth/callback` |
| `src/routes/health.ts` | `/health` |
| `src/routes/legal.ts` | `/privacy-policy` e `/data-deletion` |
| `src/services/meta-api.ts` | Chamadas à Graph API |
| `src/services/automation.ts` | Regra do fluxo: claim → Direct → resposta pública |
| `src/services/token-manager.ts` | Troca e refresh de token |
| `src/repositories/comments-repository.ts` | Claim atômico dos comentários no D1 |
| `src/repositories/tokens-repository.ts` | Persistência cifrada do token |
| `src/security/webhook-signature.ts` | HMAC-SHA256 via `crypto.subtle.verify` |
| `src/security/encryption.ts` | AES-GCM 256, IV aleatório por operação |
| `src/security/oauth-state.ts` | `state` assinado com HMAC, expira em 10 min |
| `src/security/constant-time.ts` | Comparação de tokens em tempo constante |
| `src/types/env.ts`, `src/types/meta.ts` | Tipagem |
| `src/utils/normalize.ts`, `templates.ts`, `hash.ts` | Normalização de texto, templates, SHA-256 |
| `migrations/0001_initial.sql` | Esquema do D1 |
| `scripts/` | `gerar-segredos.mjs` e `simular-webhook.mjs` |
| `tests/` | Suíte de testes: **822 testes** em 25 arquivos |

---

**Regra de ouro deste guia:** tudo que está aqui foi verificado contra o
projeto e a documentação oficial. Se você esbarrar em algo que não está
descrito — um campo novo na tela, um erro com código desconhecido, um limite
diferente — **confirme na documentação oficial da Meta** em vez de chutar. Um
palpite errado no OAuth ou no webhook custa horas de depuração.
