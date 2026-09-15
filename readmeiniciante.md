# Guia do iniciante: instalação do zero absoluto

**Este guia é para quem nunca programou.** Ele parte do princípio de que você nunca abriu um terminal, nunca instalou o Node.js e não sabe o que é um repositório. Nada aqui é dado como sabido.

Se você é programador, não perca tempo: vá direto para o [README.md](README.md).

---

## Quatro verdades antes de começar

1. **Você não precisa saber programar.** Você precisa saber copiar, colar e seguir a ordem. Só isso.
2. **Não vai custar nada.** Todos os serviços usados têm plano gratuito suficiente. Nenhum passo deste guia pede cartão de crédito.
3. **Leva cerca de 1h30 na primeira vez.** Metade é esperar download e preencher formulário.
4. **Você pode parar no meio.** Nada quebra se você fechar tudo e voltar amanhã. Cada etapa diz como retomar.

> **Um aviso honesto:** se em algum momento a tela que você vê não for igual à descrita, **não improvise e não chute**. Painéis mudam. Pare, leia a seção "Quando algo der errado" no fim deste guia, e pergunte no repositório. Chutar aqui costuma custar mais tempo do que perguntar.

---

## O que você vai ter no final

Uma automação sua, rodando sozinha, que faz isto:

> Você publica um Reel e escreve na legenda: *"comenta **eu quero** que eu te mando o link"*.
> Alguém comenta `eu quero`.
> Em segundos, essa pessoa recebe o seu link **no Direct dela**.
> Logo depois, aparece a sua resposta pública no comentário: *"Enviei as informações no seu Direct."*

Funciona 24 horas por dia, sem o seu computador ligado. Depois de instalado, seu computador só é necessário quando você quiser mudar alguma coisa.

---

## O mapa do caminho

São 10 etapas. Faça na ordem: cada uma depende da anterior.

| # | Etapa | Onde acontece | Tempo |
|---|---|---|---|
| 0 | [Vocabulário mínimo](#etapa-0-vocabulário-mínimo) | Aqui mesmo, lendo | 5 min |
| 1 | [Criar as quatro contas](#etapa-1-criar-as-quatro-contas) | No navegador | 20 min |
| 2 | [Instalar os dois programas](#etapa-2-instalar-os-dois-programas) | No seu computador | 15 min |
| 3 | [Aprender o terminal](#etapa-3-o-terminal-sem-medo) | No seu computador | 10 min |
| 4 | [Baixar o projeto](#etapa-4-baixar-o-projeto) | No terminal | 5 min |
| 5 | [Aprender a editar os arquivos](#etapa-5-como-editar-os-arquivos-do-projeto) | No seu computador | 5 min |
| 6 | [Rodar o assistente](#etapa-6-o-assistente-faz-a-parte-chata) | No terminal | 5 min |
| 7 | [Configurar a Cloudflare](#etapa-7-cloudflare-onde-o-código-vai-morar) | Terminal + navegador | 20 min |
| 8 | [Configurar a Meta](#etapa-8-meta-onde-fica-a-permissão-do-instagram) | Navegador | 30 min |
| 9 | [Personalizar e testar](#etapa-9-personalizar-o-que-é-seu) | Terminal + Instagram | 10 min |

**Você está sempre em uma dessas 10.** Se se perder, volte a esta tabela e pergunte: "em qual linha eu estou?".

---

## Etapa 0: Vocabulário mínimo

Você vai ver estas palavras o tempo todo. Não precisa decorar, só saber que elas não são bicho de sete cabeças.

| Palavra | O que é, em português claro |
|---|---|
| **Terminal** | Uma janela onde você digita comandos em vez de clicar em botões. É preto ou azul e assusta no começo. Depois de três comandos, passa. |
| **Comando** | Uma linha de texto que você digita no terminal e aperta Enter. É o equivalente a clicar em um botão. |
| **Rodar** | Executar. "Rode o comando" = digite ou cole a linha e aperte Enter. |
| **Node.js** | O programa que faz o código deste projeto funcionar no seu computador. Sem ele, nada roda. |
| **npm** | Vem junto com o Node. Serve para baixar as peças que o projeto usa e para rodar os atalhos do projeto (`npm run alguma-coisa`). |
| **git** | O programa que baixa o projeto da internet e controla as suas alterações. |
| **Repositório** | A pasta do projeto na internet (no GitHub). É de lá que você baixa o código. |
| **Cloudflare** | A empresa onde o seu código vai ficar rodando de graça, 24h por dia. |
| **Worker** | O nome que a Cloudflare dá ao seu programinha publicado. Depois de publicado, ele tem um endereço na internet, só seu. |
| **Deploy / publicar** | Mandar a versão atual do código para a Cloudflare. Toda mudança que você fizer só vale depois de um novo deploy. |
| **D1** | O banco de dados gratuito da Cloudflare. Guarda quais comentários já foram respondidos, para ninguém receber o Direct duas vezes. |
| **API** | O jeito oficial de um programa conversar com outro. Este projeto conversa com o Instagram pela API oficial da Meta, nada de truque nem robô fingindo ser você. |
| **Meta** | A empresa dona do Instagram, do Facebook e do WhatsApp. |
| **Webhook** | Um aviso automático. Quando alguém comenta, a Meta "bate na porta" do seu Worker avisando. |
| **Token** | Uma senha comprida gerada por um sistema, no lugar de uma senha digitada por você. |
| **Segredo** | Um valor que **nunca** pode ser mostrado para ninguém nem ir para a internet. Este projeto tem 4. |
| **OAuth** | Aquela tela de "Fulano quer acessar sua conta, Permitir?". É como você autoriza a automação sem entregar sua senha. |

Pronto. Esse era o vocabulário. Nada mais complicado que isso aparece.

---

## Etapa 1: Criar as quatro contas

Faça tudo no navegador, na ordem abaixo. **Nenhuma pede cartão de crédito.**

### 1.1: Deixar sua conta do Instagram profissional

**Obrigatório.** Conta pessoal não funciona, de jeito nenhum: o Instagram não dá acesso à API para conta pessoal. A conversão é grátis, leva 1 minuto e você pode voltar atrás quando quiser.

No aplicativo do Instagram, no celular:

1. Abra o seu perfil.
2. Toque nas três linhas no canto superior direito.
3. Toque em **Configurações e privacidade**.
4. Desça até **Tipo de conta e ferramentas**.
5. Toque em **Mudar para conta profissional**.
6. Escolha uma categoria (qualquer uma que combine com você) e selecione **Criador de conteúdo** ou **Comercial**, os dois servem.
7. Se ele oferecer conectar a uma Página do Facebook, pode **pular**. Este projeto não precisa disso.

**Como saber se deu certo:** volte em *Configurações → Tipo de conta e ferramentas*. Se agora aparecer a opção "Mudar para conta pessoal", é porque você já está em uma conta profissional. ✅

### 1.2: Ter uma conta no Facebook

A Meta exige uma conta do Facebook para você entrar no painel de desenvolvedores. **Ela não precisa publicar nada e ninguém vai ver.** Se você já tem uma, use a que você já tem, não crie outra.

Não tem nenhuma? Crie em <https://www.facebook.com>.

### 1.3: Criar a conta no Meta for Developers

1. Abra <https://developers.facebook.com>.
2. Clique em **Começar**, no canto superior direito.
3. Faça login com a conta do Facebook do item anterior.
4. A Meta vai pedir: confirmar o e-mail, **verificar o telefone por SMS**, responder "em que você é bom?" (escolha *Desenvolvedor*) e aceitar os termos.
5. Você termina no painel <https://developers.facebook.com/apps>.

> Deixe essa aba aberta. Você volta nela na Etapa 8.

### 1.4: Criar a conta na Cloudflare

1. Abra <https://dash.cloudflare.com/sign-up>.
2. Cadastre e-mail e senha.
3. **Confirme o e-mail** antes de continuar (procure na caixa de entrada; às vezes cai no spam).
4. Escolha o plano **Free**. **Não cadastre cartão de crédito.**

> **Por que não cadastrar cartão?** Sem cartão, o serviço simplesmente para quando o limite gratuito acaba, em vez de gerar cobrança. Para este projeto, o limite gratuito é enorme, você pararia muito antes de chegar perto dele. Detalhes na seção 11 do [README.md](README.md#11-garantia-de-funcionamento-gratuito).

### Confira antes de seguir

- [ ] Conta do Instagram é **profissional** (Comercial ou Criador).
- [ ] Consigo entrar no Facebook.
- [ ] Consigo abrir <https://developers.facebook.com/apps> logado.
- [ ] Consigo abrir <https://dash.cloudflare.com> logado, no plano Free.

---

## Etapa 2: Instalar os dois programas

São só dois: **Node.js** e **git**. Os dois são gratuitos, oficiais e seguros.

### 2.1: Node.js

O Node é o motor que executa o projeto. **Precisa ser a versão 20 ou mais nova.**

**No Windows:**

1. Abra <https://nodejs.org>.
2. Clique no botão grande que diz **LTS** (é o recomendado; a outra opção, "Current", é a versão de testes, não pegue essa).
3. Vai baixar um arquivo `.msi`. Abra ele.
4. Clique **Next** em todas as telas, aceite os termos, e **Install**.
5. Se o Windows perguntar "deseja permitir que este aplicativo faça alterações?", clique **Sim**.
6. Se aparecer uma tela oferecendo instalar "Tools for Native Modules" (com Chocolatey), pode **desmarcar**, este projeto não precisa.
7. **Finish**.

**No Mac:**

1. Abra <https://nodejs.org> e clique no botão **LTS**.
2. Vai baixar um `.pkg`. Abra ele.
3. **Continuar → Continuar → Concordo → Instalar**. Digite a senha do seu Mac quando pedir.
4. **Fechar**.

### 2.2: git

O git é o programa que baixa o projeto.

**No Windows:**

1. Abra <https://git-scm.com/downloads> e clique em **Windows**. O download começa sozinho.
2. Abra o arquivo baixado.
3. São muitas telas de opções. **Clique Next em todas, sem mudar nada.** As opções padrão estão certas para o nosso caso.
4. **Install** e depois **Finish**.

> Isso também instala o **Git Bash**, um terminal alternativo. Você vai ver esse nome citado nos guias. Guarde: no Windows você tem dois terminais possíveis, PowerShell e Git Bash, e alguns comandos mudam entre eles.

**No Mac:**

Na maioria dos Macs o git já vem instalado. Você descobre no próximo passo. Se não vier, o próprio Mac abre uma janelinha oferecendo instalar as "Ferramentas de linha de comando" na primeira vez que você digitar `git`, aceite e espere terminar.

### 2.3: Conferir se deu certo

**Feche todos os terminais que estiverem abertos e abra um novo.** Isso é importante: um terminal aberto *antes* da instalação não enxerga o programa que você acabou de instalar. Se você ainda não sabe abrir um terminal, vá para a Etapa 3 e volte aqui.

No terminal novo, rode um de cada vez:

```bash
node --version
```

```bash
npm --version
```

```bash
git --version
```

Você espera três respostas parecidas com estas:

```
v22.11.0
10.9.0
git version 2.47.0
```

Os números não precisam ser exatamente esses. O que importa:

- O `node` tem que responder **v20** ou maior (v20, v22, v24...). Se responder v18 ou menos, baixe de novo a versão LTS.
- Os outros dois só precisam responder alguma coisa.

**Respondeu "não é reconhecido como um comando" ou "command not found"?** Vá para a seção [Quando algo der errado](#quando-algo-der-errado), no fim. Não siga adiante sem resolver isso, nada vai funcionar.

---

## Etapa 3: O terminal sem medo

O terminal é uma janela onde você digita e aperta Enter. Ele não vai quebrar seu computador. Nenhum comando deste projeto apaga arquivos seus.

### 3.1: Como abrir

**Windows:** aperte a tecla `Windows`, digite `powershell` e aperte Enter. Vai abrir uma janela azul ou preta.

**Mac:** aperte `Command + Espaço`, digite `terminal` e aperte Enter.

### 3.2: Como colar um comando

Você vai copiar comandos deste guia e colar lá. Copiar é o `Ctrl+C` (ou `Cmd+C`) de sempre. Colar muda:

| Terminal | Como colar |
|---|---|
| PowerShell (Windows) | `Ctrl+V`, ou clique com o **botão direito** do mouse |
| Git Bash (Windows) | Botão direito → **Paste**, ou `Shift+Insert` |
| Terminal (Mac) | `Cmd+V` |

> **Cole uma linha de cada vez** e aperte Enter. Espere terminar antes de colar a próxima. Colar tudo de uma vez costuma dar confusão.

### 3.3: O que é "rodar um comando"

Quando este guia mostra um bloco assim:

```bash
node --version
```

significa: **cole `node --version` no terminal e aperte Enter.**

Não copie as crases nem a palavra `bash`: são só a decoração do texto. Copie o comando de dentro.

### 3.4: Saber onde você está

O terminal está sempre "dentro" de alguma pasta. Isso importa muito: os comandos do projeto **só funcionam dentro da pasta do projeto**.

Para ver onde você está: funciona no PowerShell, no Mac e no Git Bash:

```bash
pwd
```

Para entrar em uma pasta, use `cd` (de *change directory*):

```bash
cd Documents
```

Para voltar uma pasta:

```bash
cd ..
```

**Atalho que salva:** no Windows, abra a pasta no Explorador de Arquivos, clique com o botão direito num espaço vazio e escolha **"Abrir no Terminal"**. O terminal já abre dentro dela. No Mac, arraste a pasta para cima do ícone do Terminal.

### 3.5: O que é normal aparecer

- **Muito texto rolando na tela:** normal. O terminal narra o que está fazendo.
- **A palavra `warning` (aviso):** normal, pode ignorar. Aviso não é erro.
- **A palavra `error` (erro), geralmente em vermelho:** aí sim pare e leia. Vá para [Quando algo der errado](#quando-algo-der-errado).
- **Nada acontecer por 1 ou 2 minutos:** normal no `npm install`. Está baixando. Espere.

### 3.6: Fechar e voltar depois

Pode fechar o terminal a qualquer momento, nada se perde. Mas ao voltar, você cai na pasta inicial de novo. **Antes de rodar qualquer comando do projeto, entre na pasta dele:**

```bash
cd caminho/para/noxe-insta-automation
```

Se um comando reclamar que não achou o `package.json`, é isso: você está na pasta errada.

---

## Etapa 4: Baixar o projeto

### 4.1: Escolha onde o projeto vai morar

Qualquer pasta serve. A pasta **Documentos** é uma boa escolha. Abra o terminal e vá até ela.

**Windows (PowerShell):**

```powershell
cd $HOME\Documents
```

**Mac:**

```bash
cd ~/Documents
```

### 4.2: Baixe

Rode os três comandos abaixo, **um de cada vez**, esperando cada um terminar.

O endereço abaixo é o do projeto oficial: pode copiar como está. Só troque se você estiver baixando de um *fork* (uma cópia que outra pessoa fez): nesse caso, o endereço certo aparece no botão verde **Code** da página daquele projeto.

```bash
git clone https://github.com/VitorSaviolli/Noxe_InstaAutomation.git
```

```bash
cd Noxe_InstaAutomation
```

```bash
npm install
```

O que cada um fez:

1. `git clone` baixou o projeto e criou a pasta `Noxe_InstaAutomation`.
2. `cd` entrou nessa pasta. **Daqui em diante, todo comando é rodado de dentro dela.**
3. `npm install` baixou as peças que o projeto usa. Demora 1 a 3 minutos na primeira vez e imprime muito texto. Avisos amarelos são normais.

> ### ⚠️ Não baixe como ZIP
>
> O GitHub oferece um botão "Download ZIP". **Não use.** Sem o git você perde a proteção que impede os seus segredos de irem parar na internet no dia em que você publicar a sua própria versão. Use `git clone`, como acima.

### 4.3: Confira

```bash
npm test
```

Isso roda os testes automáticos do projeto. Espere terminar e procure a palavra **passed** (passou) no fim. Se todos passarem, o seu ambiente está correto, Node, npm e projeto estão conversando.

---

## Etapa 5: Como editar os arquivos do projeto

Em três momentos você vai precisar abrir um arquivo do projeto e trocar uma palavra. É simples, mas tem uma armadilha.

### Com o que abrir

| Sistema | Use | **Não use** |
|---|---|---|
| Windows | **Bloco de Notas** (clique direito no arquivo → Abrir com → Bloco de Notas) | Word |
| Mac | **TextEdit**, mas veja o aviso abaixo | Pages |
| Qualquer um | **VS Code**: gratuito, em <https://code.visualstudio.com>. É o mais confortável, mas totalmente opcional. |, |

> **Armadilha do Mac:** o TextEdit abre em "texto formatado", e salvar assim **corrompe o arquivo**. Antes de salvar, vá em **Formatar → Converter para texto simples**. Se você não quiser lidar com isso, instale o VS Code.
>
> **Armadilha geral:** nunca use Word, Pages ou Google Docs para editar arquivos do projeto. Eles trocam as aspas retas por aspas curvas e o código para de funcionar, com um erro difícil de descobrir.

### Os três arquivos que você vai editar

| Arquivo | O que você troca lá | Quando |
|---|---|---|
| `wrangler.jsonc` | O ID do seu banco e o ID do seu app da Meta | Etapas 7 e 8 |
| `src/config.ts` | Seu link, a palavra-gatilho e os textos | Etapa 9 |
| `src/routes/legal.ts` | Seu e-mail de contato e seu nome, na política de privacidade | Etapa 9 |

Nesses arquivos, os lugares que você precisa trocar estão marcados com um texto berrante, do tipo `COLE_AQUI_O_ID_DO_SEU_BANCO_D1` ou `[COLOQUE_O_SEU_LINK_AQUI]`. **Substitua o marcador inteiro**, incluindo os colchetes quando houver, e mantenha as aspas que já estavam ali.

Exemplo: antes:

```ts
destinationUrl: '[COLOQUE_O_SEU_LINK_AQUI]',
```

Depois:

```ts
destinationUrl: 'https://meusite.com.br/oferta',
```

Repare: as aspas simples continuam lá, e a vírgula no fim também. Só o miolo mudou.

**Salve sempre com `Ctrl+S` (Windows) ou `Cmd+S` (Mac).** Alterar um arquivo e esquecer de salvar é o erro mais comum que existe.

---

## Etapa 6: O assistente faz a parte chata

O projeto vem com um assistente que conduz você pelo terminal, em português, fazendo as perguntas na ordem certa.

```bash
npm run configurar
```

Ele abre um menu com cinco etapas:

| Etapa do assistente | O que ela faz por você |
|---|---|
| 1: Segredos | Gera sozinho os valores aleatórios dos segredos e mostra o comando exato para cadastrar cada um |
| 2: Conferir o Worker | Verifica se o seu Worker já está no ar e o que ainda falta |
| 3: Conectar o Instagram | Monta a URL de autorização e **abre o navegador para você** |
| 4: Configurar a automação | Pergunta a palavra-gatilho, o link e os textos, e grava tudo no arquivo certo |
| 5: Verificar | Confere se não sobrou nenhum dado pessoal antes de você publicar |

**Ele não substitui os dois guias detalhados** ([SETUP_CLOUDFLARE.md](SETUP_CLOUDFLARE.md) e [SETUP_META.md](SETUP_META.md)), ele caminha ao lado deles. Use os dois juntos: o guia mostra as telas, o assistente cuida do que é chato de digitar.

> **Então eu vou ter que usar o terminal para sempre?** Não. O assistente cuida do que **só** a sua máquina pode fazer: gerar os segredos, cadastrá-los na Cloudflare e fazer o primeiro login do Instagram. Depois disso, o dia a dia é no **painel**, pelo celular: palavra-gatilho, textos, link, quais Reels respondem, e o histórico do que aconteceu.
>
> **E um painel na internet não é perigoso?** Seria, se fosse um painel comum. Um painel capaz de mudar o texto do seu Direct viraria, se alguém invadisse, uma máquina de golpe falando em nome da sua conta, com a sua resposta pública dando credibilidade ao golpe. É por isso que este tem quatro travas: **(1)** só entra com passkey, digital, rosto ou chave física, então não existe senha para vazar ou adivinhar; **(2)** mudar o texto do Direct ou o link exige um **segundo** gesto de biometria, preso àquela mudança específica, de modo que aprovar uma coisa não aprova outra; **(3)** o link só pode apontar para os domínios que você autorizou no arquivo de configuração, e mudar essa lista exige o repositório mais a chave de publicação, as duas coisas que um painel invadido não tem; **(4)** o código de parada desliga tudo de qualquer aparelho, sem senha e sem precisar entrar no painel.
>
> Os segredos continuam vivendo **só no seu computador**: o painel nunca os lê nem os mostra.

Você pode fechar e voltar quando quiser. Para ir direto a uma etapa:

```bash
npm run configurar 3
```

---

## Etapa 7: Cloudflare, onde o código vai morar

Nesta etapa você cria o banco de dados, cadastra os segredos e publica o Worker. No fim dela, **o seu endereço na internet passa a existir**, e ele é obrigatório para a Etapa 8.

**Abra o [SETUP_CLOUDFLARE.md](SETUP_CLOUDFLARE.md) e siga a partir da seção 3.** As seções 1 e 2 você já fez aqui (instalar os programas e baixar o projeto).

Aqui está o resumo do caminho, para você saber onde está pisando:

| Comando | O que ele faz |
|---|---|
| `npx wrangler login` | Abre o navegador para você clicar em **Allow** e autorizar o seu computador na Cloudflare |
| `npx wrangler d1 create noxe-insta-automation` | Cria o banco de dados. **Ele imprime um `database_id` na tela, copie e cole no `wrangler.jsonc`** |
| `npm run db:migrate:local` | Monta as tabelas no banco de testes da sua máquina |
| `npm run db:migrate:remote` | Monta as tabelas no banco de verdade, na Cloudflare |
| `npx wrangler secret put NOME` | Guarda um segredo no cofre da Cloudflare. Você repete isso **5 vezes**, uma por segredo |
| `npm run deploy` | Publica. **Ele imprime a sua URL, anote!** |

### Três coisas que costumam confundir aqui

**1. O `database_id` vem em um formato e vai para outro.** O comando devolve um bloco assim:

```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Mas o arquivo `wrangler.jsonc` usa `:` no lugar do `=`. **Copie só o texto longo entre aspas**, não o bloco inteiro, e cole por cima de `COLE_AQUI_O_ID_DO_SEU_BANCO_D1`.

**2. Ao cadastrar um segredo, a tela não mostra o que você digita.** Isso é de propósito, para ninguém ler por cima do seu ombro. Cole o valor e aperte Enter mesmo com a tela parecendo vazia. Não é travamento.

**3. Você só consegue cadastrar 4 dos 5 segredos agora.** O quinto (`META_APP_SECRET`) vem do painel da Meta, que é a próxima etapa. Não fique travado esperando por ele.

> Um dos quatro é o `PANEL_SESSION_KEY`. Se você esquecer dele, tudo publica e
> funciona: menos o painel, que responde 503 como se não existisse. É o esquecimento
> mais comum, e o mais confuso de diagnosticar depois.

### Sua URL

No fim do `npm run deploy` aparece algo assim:

```
https://noxe-insta-automation.SEU-SUBDOMINIO.workers.dev
```

**Anote em algum lugar.** É o endereço do seu Worker na internet, e a Meta vai pedir ele três vezes na próxima etapa. Se você perder, ele reaparece a cada `npm run deploy`.

Para testar se está no ar, abra essa URL no navegador com `/health` no fim:

```
https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/health
```

Deve aparecer um texto com `"status": "ok"`. Se aparecer, ✅ o seu Worker está vivo na internet.

Nesse mesmo texto você vai ver `appId: false` e `contaAutorizada: false`. **Isso é o esperado agora**, os dois viram `true` no fim da próxima etapa.

---

## Etapa 8: Meta, onde fica a permissão do Instagram

Esta é a etapa mais longa e a que mais tem tela para clicar. Reserve 30 minutos sem pressa.

**Abra o [SETUP_META.md](SETUP_META.md) e siga do começo ao fim.** Ele tem o passo a passo com os nomes exatos dos botões.

O que vai acontecer, em ordem:

1. **Criar um app** no Meta for Developers (tipo **Empresa**).
2. **Adicionar o caso de uso do Instagram** e clicar em *Personalizar*.
3. **Configurar o Instagram Login** e colar a sua URL como endereço de retorno.
4. **Pegar o App ID e o App Secret.** O App ID vai para o `wrangler.jsonc`; o App Secret vira o quarto segredo.
5. **Marcar as 3 permissões** que o projeto pede.
6. **Cadastrar o webhook** (o endereço que a Meta vai avisar quando alguém comentar) e o Verify Token.
7. **Assinar o evento de comentários**: em **dois lugares diferentes**, e os dois são obrigatórios.
8. **Fazer o login** (aquela tela de "Permitir?") para conectar a sua conta.

### A foto do app: quase todo mundo esquece

O painel da Meta pede uma **foto do app** (o "ícone"), e ela **não** aparece na lista de passos do assistente: fica escondida em **Configurações → Básico**.

- Tamanho: **1024 × 1024 pixels**, quadrada, PNG.
- Use a **sua** marca ou uma imagem sua. **Não pode** usar o logo do Instagram, da Meta ou do Facebook, isso reprova o app.
- Não tem logo? Serve qualquer imagem quadrada própria, feita no Canva ou em qualquer editor gratuito.

Isso importa mesmo: essa foto é o que aparece na tela de "Permitir?" que você (e depois qualquer pessoa) vê ao conectar a conta. Um app sem foto passa impressão de coisa quebrada.

### O alerta que mais derruba gente aqui

**A Meta te mostra DOIS pares de "App ID + App Secret":** um do app do Facebook e outro do Instagram. **Eles são diferentes, e o errado não funciona.** O `SETUP_META.md` tem uma seção inteira só sobre isso, com o alerta em destaque, leia com calma quando chegar lá. Se a automação depois não responder, este é o primeiro lugar para conferir.

### Como saber que a Etapa 8 acabou

Abra de novo a sua URL com `/health` no fim. Agora `appId` e `contaAutorizada` precisam estar **`true`**. Se os dois estiverem, ✅ está conectado.

---

## Etapa 9: Personalizar o que é seu

Agora você define o que a automação faz. O jeito mais fácil é pelo assistente:

```bash
npm run configurar 4
```

Ele pergunta, uma coisa de cada vez:

- **A palavra-gatilho**: o que a pessoa precisa comentar. Ex.: `eu quero`.
- **O link**: o que ela vai receber no Direct.
- **O texto do Direct**: a mensagem privada.
- **O texto da resposta pública**: o que aparece no comentário.

E grava tudo em `src/config.ts`, guardando uma cópia do arquivo antigo por segurança.

Prefere editar na mão? Abra `src/config.ts` e troque os valores. A explicação de cada opção está na [seção 8 do README.md](README.md#8-como-configurar-o-gatilho).

### Dois cuidados na escolha da palavra-gatilho

- **Nada curto demais.** Uma palavra como `oi` ou `eu` dispararia sozinha o tempo todo. Use pelo menos 3 caracteres e algo que ninguém escreve por acaso.
- **Nada genérico demais.** `link` é ruim, porque muita gente comenta "manda o link" sem contexto. `eu quero` funciona bem porque você pediu exatamente isso na legenda.

### Não esqueça da política de privacidade

Abra `src/routes/legal.ts` e troque `[SEU_EMAIL_DE_CONTATO]` e `[NOME_DO_RESPONSAVEL]` pelos seus dados reais. **A Meta exige** que essas páginas existam e funcionem, se ficarem com os marcadores, o seu app fica irregular.

### Publique a mudança

**Nada que você editar vale antes disto:**

```bash
npm run deploy
```

Grave essa regra: **editou → deploy.** Toda vez. Ela responde 90% dos "mudei e não mudou nada".

### O teste de verdade

O único teste que vale é o real. Comente a sua palavra-gatilho em um Reel seu e veja o Direct chegar.

**Dica para não incomodar ninguém:** dá para travar a automação em **um único post** enquanto você testa. No `src/config.ts`, troque:

```ts
allowedMediaIds: ['*'],            // todos os Reels
allowedMediaIds: ['1791234...'],   // só este
```

Assim, se alguém comentar a palavra-gatilho num post antigo, não acontece nada. Como descobrir esse número está na etapa 12 do [SETUP_META.md](SETUP_META.md). Terminado o teste, volte para `['*']`, e lembre: **editou → deploy**.

Para acompanhar ao vivo o que está acontecendo por dentro, deixe isto rodando em outro terminal enquanto comenta:

```bash
npm run tail
```

Ele mostra em tempo real cada aviso que a Meta manda. Para sair, `Ctrl+C`.

> **Não teste em um Reel que está bombando.** Escolha um post antigo e parado, ou publique um Reel de teste com pouco alcance. Assim, se algo estiver errado, ninguém recebe a mensagem torta.

---

## Quando algo der errado

### Erros no terminal

| O que aparece | O que significa | O que fazer |
|---|---|---|
| `'node' não é reconhecido...` / `command not found: node` | O terminal não achou o Node | Feche **todos** os terminais, abra um novo e teste de novo. Se persistir, reinstale o Node (Etapa 2.1) e reinicie o computador. |
| `'git' não é reconhecido...` | Mesma coisa, com o git | Idem, reinstalando o git (Etapa 2.2). |
| `Could not read package.json` | Você está na pasta errada | Rode `cd caminho/para/noxe-insta-automation` e tente de novo. |
| `npm ERR! code EACCES` (Mac) | Falta de permissão na pasta | Você provavelmente está numa pasta do sistema. Mova o projeto para dentro de `~/Documents`. |
| `EADDRINUSE` | Aquela "porta" já está ocupada | Feche o outro terminal que está rodando o projeto. |
| `Authentication error` na Cloudflare | O seu login expirou | Rode `npx wrangler login` de novo. |
| Um monte de `warning` amarelo | Avisos, não erros | **Ignore.** Se não apareceu a palavra `error`, deu certo. |

### Problemas no comportamento

| Sintoma | Causa mais provável |
|---|---|
| Editei e nada mudou | Faltou `npm run deploy`. Ou faltou salvar o arquivo. |
| O Direct não chega | Comece pelo `/health`: `appId` e `contaAutorizada` estão `true`? Se não, volte à Etapa 8. |
| O Direct não chega, mas o `/health` está ok | Provavelmente o par App ID + App Secret é o do Facebook, não o do Instagram. Veja o alerta na Etapa 8. |
| Chega para mim, mas não para outras pessoas | É um Direct por comentário, uma única vez. E existe um tempo de espera (*cooldown*) de 24 h por pessoa, de propósito. |
| Parou de funcionar depois de uns dois meses | O token do Instagram vence em 60 dias. Veja a seção 13 do [SETUP_META.md](SETUP_META.md). |
| Funciona em post, mas não em Reel (ou o contrário) | Por padrão o projeto só age em **Reels**. Isso se muda em `src/config.ts`. |

### Antes de pedir ajuda, junte isto

Quem for te ajudar vai precisar de:

1. **O comando exato** que você rodou.
2. **A mensagem de erro inteira**, copiada como texto (não como print, se der).
3. **Em qual das 10 etapas** deste guia você estava.
4. O resultado de `node --version` e o seu sistema (Windows 11, macOS...).

> ### 🚨 NUNCA cole isto em lugar nenhum
>
> Ao pedir ajuda, **jamais** cole o conteúdo do arquivo `.env`, nem o `META_APP_SECRET`, nem qualquer valor de segredo, nem um token. Quem tiver esses valores consegue mandar mensagem em nome da sua conta.
>
> Se você colou por engano em algum lugar público: **troque os 5 segredos imediatamente**. O passo a passo está no [SECURITY.md](SECURITY.md).

---

## Perguntas que todo mundo faz

**Vou ser cobrado?**
Não, se você seguiu a Etapa 1.4 e não cadastrou cartão. Sem cartão não existe cobrança possível. Os limites gratuitos são muito maiores do que este projeto consome.

**Meu computador precisa ficar ligado?**
Não. Depois do `npm run deploy`, o código roda nos servidores da Cloudflare. Você pode desligar tudo. Seu computador só é necessário para mudar alguma coisa.

**Isso pode derrubar minha conta do Instagram?**
Este projeto usa a **API oficial** da Meta: nada de robô fingindo ser você. O que derruba conta é o uso: disparo em massa, mensagem enganosa, prometer conteúdo e não entregar, ou automatizar conta de terceiros sem autorização. Use na sua conta e entregue o que prometeu na legenda. Leia o "Aviso legal e uso responsável" no [README.md](README.md).

**Preciso de site próprio ou domínio?**
Não. A Cloudflare te dá um endereço de graça.

**E se eu quiser mudar a palavra depois?**
`npm run configurar 4`, muda, e `npm run deploy`. Leva menos de um minuto.

**Dá para usar em duas contas do Instagram?**
Uma instalação atende uma conta. Para a segunda, você repete o processo com um Worker e um app da Meta separados.

**Estraguei um arquivo, e agora?**
Se o projeto veio de `git clone`, dá para desfazer tudo o que você editou em um arquivo:

```bash
git checkout -- src/config.ts
```

(troque pelo arquivo que você quer restaurar). Ele volta ao original. Este é um dos motivos para não baixar como ZIP.

**Não entendi um termo do guia.**
Está na [Etapa 0](#etapa-0-vocabulário-mínimo). Se não estiver lá, pergunte no repositório, provavelmente falta explicar mesmo, e isso é falha do guia, não sua.

---

## Onde pedir ajuda

- **Dúvida de instalação ou configuração:** abra uma *issue* na aba **Issues** do repositório no GitHub, usando o modelo *Dúvida de configuração*.
- **Encontrou uma falha de segurança:** **não** abra issue pública. Use a aba **Security** → **Report a vulnerability**. O procedimento está no [SECURITY.md](SECURITY.md).

---

## Próximos passos, quando isso já estiver funcionando

| Quero... | Onde está |
|---|---|
| Entender como funciona por dentro | [README.md, seção 6](README.md#6-como-funciona-passo-a-passo) |
| Usar palavras diferentes em Reels diferentes | [README.md, seção 9](README.md#9-automações-por-reel-mediaautomations) |
| Saber o que é guardado sobre quem comenta | [README.md, seção 13](README.md#13-segurança-e-privacidade) |
| Conferir que estou dentro do plano gratuito | [README.md, seção 11](README.md#11-garantia-de-funcionamento-gratuito) |
| Publicar a minha própria versão no GitHub | [README.md, seção 5](README.md#5-segredos-e-git-o-que-nunca-pode-ir-para-o-github), **leia inteira antes**, é onde mora o risco de vazar segredo |

Chegou até aqui e funcionou? Então você acabou de publicar e operar uma aplicação de verdade na internet, sem escrever uma linha de código. 🎉

---

## Créditos e apoio

**Software sem fins lucrativos.** Este projeto não rouba e não coleta informações de ninguém. Tudo o que ele guarda fica no **seu** banco de dados, dentro da **sua** conta da Cloudflare. Nada é enviado ao autor do código nem a terceiros, não existe servidor nosso no meio.

Desenvolvido por **Vitor S. Gonsalez**: **Noxelora**.

### ⭐ Deu certo para você?

Não esqueça de dar uma força com a sua **estrela no GitHub**. É totalmente de graça e ajuda outras pessoas a encontrarem o projeto:

**<https://github.com/VitorSaviolli/Noxe_InstaAutomation>**

> **Onde fica a estrela?** No canto superior direito da página do projeto no GitHub tem um botão escrito **Star**, com o desenho de uma estrela. É só clicar. Não custa nada e não pede cadastro além da sua conta do GitHub.

### 💚 Quer apoiar?

**PIX: `saviolligonsalez@gmail.com`**

Doações ajudam a manter projetos como este 100% gratuitos.

> Confira a chave sempre na página oficial acima. Como o código é aberto, qualquer pessoa pode publicar uma cópia com outra chave no lugar desta.
