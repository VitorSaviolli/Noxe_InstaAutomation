/*
 * O `painel.js`. Sem framework, sem roteador, sem modelo de estado, sem cache
 * proprio e **sem `innerHTML`**, a CSP tem `require-trusted-types-for
 * 'script'`, entao um `innerHTML` aqui seria erro de RUNTIME, e nao de revisao.
 *
 * §12.8 lista cinco trabalhos para este arquivo. Nesta etapa existem os tres
 * que as telas de hoje precisam:
 *
 *   1. WebAuthn: `navigator.credentials.get()` e `.create()`, SEMPRE dentro de
 *      um clique (o Safari exige gesto do usuario; chamar no `onload` quebra em
 *      iOS) e sempre com `userVerification: "required"`.
 *   2. Levar a AUTORIZACAO do cadastro ate `/painel/api/registrar/opcoes`, nas
 *      tres formas de §10.4: o token do convite lido do FRAGMENTO
 *      (`location.hash`, limpando a barra com `history.replaceState`), o codigo
 *      de recuperacao que o servidor devolveu num campo escondido, e, na tela
 *      de Aparelhos, a digital do step-up de `adicionar_passkey`. Sao tres
 *      origens do mesmo trabalho, e nao tres trabalhos: o que muda e de onde a
 *      autorizacao vem, e nunca o que este arquivo faz com ela.
 *   3. O passo 3 de §10.10: pedir as options do step-up, ler a digital e por a
 *      assertion serializada num campo escondido **do mesmo formulario**, que e
 *      entao submetido para a rota de escrita normal.
 *
 * Os outros dois, miniatura que falhou e marcar em lote, chegam com as telas
 * que os usam. Codigo sem tela e codigo sem teste.
 *
 * A UNICA navegacao que este arquivo faz e a do `para` que o servidor devolve,
 * e ela e comparada contra uma lista fixa: um destino escolhido pela resposta
 * seria um redirecionador aberto de graca.
 */
'use strict'
;(function () {
  /** Os unicos destinos que este arquivo aceita navegar. */
  var DESTINOS = ['/painel', '/painel/entrar']

  /** A ficha anti-CSRF viaja neste cabecalho nas rotas `/painel/api/*`. */
  var CABECALHO_DA_FICHA = 'X-Painel-CSRF'

  // -------------------------------------------------------------------------
  // base64url <-> ArrayBuffer. O WebAuthn fala bytes; o JSON fala texto.
  // -------------------------------------------------------------------------

  function paraBytes(texto) {
    var normal = texto.replace(/-/g, '+').replace(/_/g, '/')
    while (normal.length % 4 !== 0) normal += '='
    var cru = atob(normal)
    var bytes = new Uint8Array(cru.length)
    for (var i = 0; i < cru.length; i++) bytes[i] = cru.charCodeAt(i)
    return bytes
  }

  function paraTexto(buffer) {
    var bytes = new Uint8Array(buffer)
    var cru = ''
    for (var i = 0; i < bytes.length; i++) cru += String.fromCharCode(bytes[i])
    return btoa(cru).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  // -------------------------------------------------------------------------
  // Tela: mensagens sem `innerHTML`
  // -------------------------------------------------------------------------

  function avisar(texto) {
    var alvo = document.getElementById('aviso')
    if (alvo === null) {
      alvo = document.createElement('p')
      alvo.id = 'aviso'
      alvo.className = 'faixa faixa-erro'
      alvo.setAttribute('role', 'status')
      alvo.setAttribute('aria-live', 'polite')
      document.body.insertBefore(alvo, document.body.firstChild)
    }
    // `textContent`, nunca `innerHTML`: e a regra e tambem a unica coisa que a
    // CSP deixa funcionar.
    alvo.textContent = texto
  }

  function irPara(destino) {
    if (DESTINOS.indexOf(destino) === -1) {
      avisar('Não foi possível continuar. Tente de novo.')
      return
    }
    window.location.assign(destino)
  }

  // -------------------------------------------------------------------------
  // A conversa com o Worker
  // -------------------------------------------------------------------------

  function pedir(caminho, corpo, ficha) {
    var cabecalhos = { 'content-type': 'application/json' }
    if (ficha) cabecalhos[CABECALHO_DA_FICHA] = ficha

    return fetch(caminho, {
      method: 'POST',
      headers: cabecalhos,
      // `same-origin` e o padrao, e esta escrito para nao virar `include` por
      // engano num refactor: o painel nunca manda cookie para fora.
      credentials: 'same-origin',
      body: JSON.stringify(corpo),
    }).then(function (resposta) {
      return resposta.json().then(function (dados) {
        return { ok: resposta.ok, dados: dados }
      })
    })
  }

  function frase(dados) {
    return dados && typeof dados.mensagem === 'string'
      ? dados.mensagem
      : 'Não foi possível confirmar. Tente de novo.'
  }

  /**
   * A assertion do jeito que o Worker a le, nos DOIS lugares que a produzem:
   * o login e o step-up.
   *
   * Duas copias divergiriam no dia em que uma delas ganhasse um campo, e o
   * defeito apareceria como `credencial_invalida` sem explicacao, que e
   * exatamente a resposta que a fronteira da assertion da para tudo (§10.3).
   */
  function assertionSerializada(credencial) {
    return {
      id: credencial.id,
      type: credencial.type,
      clientDataJSON: paraTexto(credencial.response.clientDataJSON),
      authenticatorData: paraTexto(credencial.response.authenticatorData),
      signature: paraTexto(credencial.response.signature),
      userHandle:
        credencial.response.userHandle === null
          ? null
          : paraTexto(credencial.response.userHandle),
    }
  }

  /** A leitura da digital em si, com `userVerification: "required"` sempre. */
  function lerDigital(opcoes) {
    return navigator.credentials.get({
      publicKey: {
        challenge: paraBytes(opcoes.challenge),
        rpId: opcoes.rpId,
        allowCredentials: [],
        userVerification: 'required',
        timeout: opcoes.timeout,
      },
    })
  }

  /**
   * O passo 2 e o 3 de §10.10: pede o envelope daquela mudanca e le a digital.
   *
   * Devolve a assertion SERIALIZADA, ou `null` quando o Worker recusou, nesse
   * caso a frase ja foi mostrada e quem chamou nao tem mais nada a fazer.
   *
   * A mudanca canonica e insumo, e vem sempre do SERVIDOR (do `data-mudanca`
   * que a tela de conferencia escreveu) ou de uma constante deste arquivo.
   * Monta-la a partir dos campos do formulario seria uma segunda grafia dos
   * leitores do funil.
   */
  function colherDigital(mudanca, ficha) {
    return pedir(
      '/painel/api/stepup/opcoes',
      { operacao: mudanca.acao, mudanca: mudanca },
      ficha,
    ).then(function (inicio) {
      if (!inicio.ok) {
        avisar(frase(inicio.dados))
        return null
      }
      return lerDigital(inicio.dados).then(function (credencial) {
        return JSON.stringify({ credencial: assertionSerializada(credencial) })
      })
    })
  }

  // -------------------------------------------------------------------------
  // Trabalho 1: entrar com a digital
  // -------------------------------------------------------------------------

  function entrar() {
    return pedir('/painel/api/entrar/opcoes', {}).then(function (inicio) {
      if (!inicio.ok) {
        avisar(frase(inicio.dados))
        return
      }

      return lerDigital(inicio.dados)
        .then(function (credencial) {
          return pedir('/painel/api/entrar/verificar', {
            credencial: assertionSerializada(credencial),
          })
        })
        .then(function (fim) {
          if (!fim.ok) {
            avisar(frase(fim.dados))
            return
          }
          irPara(fim.dados.para)
        })
    })
  }

  // -------------------------------------------------------------------------
  // Trabalho 2: o token do convite mora no FRAGMENTO
  // -------------------------------------------------------------------------

  /**
   * Le `#c=<convite>` e LIMPA a barra de enderecos.
   *
   * O fragmento nao e enviado ao servidor, nao entra em log de proxy nem em
   * `Referer`, e por isso que o token de uso unico viaja ali e nunca na query
   * string. `history.replaceState` tira o token da barra para que ele nao
   * sobreviva num print de tela nem no historico do navegador.
   */
  function tokenDoConvite() {
    var hash = window.location.hash || ''
    var achado = /(?:^#|&)c=([^&]+)/.exec(hash)
    if (achado === null) return null

    history.replaceState(null, '', window.location.pathname + window.location.search)
    return decodeURIComponent(achado[1])
  }

  /**
   * A cerimonia de cadastro (§10.4, §10.5).
   *
   * `pedido` e a AUTORIZACAO, `{tipo:'convite', convite}`,
   * `{tipo:'recuperacao', codigo}` ou `{tipo:'sessao', digital}`, e ela e a
   * unica coisa que muda entre as tres telas que cadastram aparelho. `ficha` so
   * viaja no modo `sessao`, que e o unico com sessao viva de onde deriva-la
   * (§10.9, camada 3).
   */
  function cadastrar(pedido, apelido, ficha) {
    var corpo = { apelido: apelido }
    for (var chave in pedido) {
      if (Object.prototype.hasOwnProperty.call(pedido, chave)) corpo[chave] = pedido[chave]
    }

    return pedir('/painel/api/registrar/opcoes', corpo, ficha).then(function (inicio) {
      if (!inicio.ok) {
        avisar(frase(inicio.dados))
        return
      }

      var opcoes = inicio.dados
      return navigator.credentials
        .create({
          publicKey: {
            rp: opcoes.rp,
            user: {
              id: paraBytes(opcoes.user.id),
              name: opcoes.user.name,
              displayName: opcoes.user.displayName,
            },
            challenge: paraBytes(opcoes.challenge),
            pubKeyCredParams: opcoes.pubKeyCredParams,
            authenticatorSelection: opcoes.authenticatorSelection,
            attestation: opcoes.attestation,
            excludeCredentials: opcoes.excludeCredentials.map(function (item) {
              return { type: item.type, id: paraBytes(item.id) }
            }),
            timeout: opcoes.timeout,
          },
        })
        .then(function (credencial) {
          return pedir('/painel/api/registrar/verificar', {
            apelido: apelido,
            credencial: {
              id: credencial.id,
              type: credencial.type,
              clientDataJSON: paraTexto(credencial.response.clientDataJSON),
              attestationObject: paraTexto(credencial.response.attestationObject),
            },
            transportes:
              typeof credencial.response.getTransports === 'function'
                ? credencial.response.getTransports()
                : [],
          })
        })
        .then(function (fim) {
          if (!fim.ok) {
            avisar(frase(fim.dados))
            return
          }
          irPara(fim.dados.para)
        })
    })
  }

  /**
   * Cadastrar outro aparelho a partir de uma sessao viva (§10.13).
   *
   * **Sao dois gestos de biometria, e a tela avisa antes**: o primeiro autoriza
   * (`{acao:'adicionar_passkey'}`, preso ao `op_hash` daquela operacao), o
   * segundo cria a chave nova. Sem o primeiro, cadastrar um aparelho seria a
   * unica operacao do painel que um painel invadido faria sozinho, e ela e
   * justamente a que da acesso permanente.
   */
  var MUDANCA_DE_ADICIONAR = { acao: 'adicionar_passkey' }

  function adicionarAparelho(formulario, apelido) {
    var ficha = formulario.getAttribute('data-ficha') || ''
    return colherDigital(MUDANCA_DE_ADICIONAR, ficha).then(function (digital) {
      if (digital === null) return
      return cadastrar({ tipo: 'sessao', digital: digital }, apelido, ficha)
    })
  }

  // -------------------------------------------------------------------------
  // Trabalho 3: confirmar uma mudanca protegida (§10.10, passo 3)
  // -------------------------------------------------------------------------

  /**
   * A cerimonia de step-up, e ela nao navega para lugar nenhum.
   *
   * O passo 3 de §10.10 e literal: a assertion serializada vai num campo
   * escondido **do mesmo formulario**, e o formulario e submetido para a rota de
   * escrita normal. Nao existe `/painel/api/stepup/verificar`, a verificacao
   * acontece dentro da gravacao, e por isso nao ha uma segunda resposta a ler
   * nem um destino a escolher aqui.
   *
   * A mudanca canonica vem do atributo `data-mudanca`, que o SERVIDOR escreveu:
   * ela e insumo desta funcao, e nao do POST. Montar o objeto aqui, a partir dos
   * campos do formulario, seria uma segunda grafia dos leitores do funil, e a
   * primeira vez que as duas divergissem o dono apertaria a digital e receberia
   * uma recusa sem entender por que.
   *
   * `formulario.submit()` e nao `requestSubmit()`: o envio tem de pular o
   * ouvinte de `submit` que chamou esta funcao, ou a cerimonia recomecaria em
   * laco.
   */
  function confirmar(formulario) {
    var mudanca = JSON.parse(formulario.getAttribute('data-mudanca') || 'null')
    if (mudanca === null) {
      avisar('Não foi possível confirmar. Tente de novo.')
      return
    }

    var ficha = formulario.querySelector('input[name="csrf"]')
    var alvo = formulario.querySelector('input[name="digital"]')
    if (ficha === null || alvo === null) {
      avisar('Não foi possível confirmar. Tente de novo.')
      return
    }

    return colherDigital(mudanca, ficha.value).then(function (digital) {
      if (digital === null) return
      alvo.value = digital
      formulario.submit()
    })
  }

  // -------------------------------------------------------------------------
  // Ligacao com a tela. SEMPRE dentro de um clique (§10.7, §12.8).
  // -------------------------------------------------------------------------

  function ligar(formulario, acao) {
    formulario.addEventListener('submit', function (evento) {
      evento.preventDefault()
      var botao = formulario.querySelector('button')
      if (botao !== null) botao.disabled = true

      Promise.resolve()
        .then(acao)
        .catch(function () {
          // A mensagem do navegador nao vai para a tela: ela varia por sistema
          // e vaza detalhe de autenticador. Uma frase so, sempre a mesma.
          avisar('Não foi possível confirmar. Tente de novo.')
        })
        .then(function () {
          if (botao !== null) botao.disabled = false
        })
    })
  }

  var deEntrar = document.getElementById('entrar')
  if (deEntrar !== null) {
    ligar(deEntrar, entrar)
  }

  var deConfirmar = document.getElementById('confirmar')
  if (deConfirmar !== null) {
    ligar(deConfirmar, function () {
      return confirmar(deConfirmar)
    })
  }

  var deRegistrar = document.getElementById('registrar')
  if (deRegistrar !== null) {
    // O token do convite e lido AGORA, e nao dentro do clique: `tokenDoConvite`
    // limpa a barra de enderecos, e limpa-la so no primeiro clique deixaria o
    // token vivo num print de tela ate la.
    var convite = tokenDoConvite()
    var tipo = deRegistrar.getAttribute('data-tipo') || 'convite'

    ligar(deRegistrar, function () {
      var campo = document.getElementById('apelido')
      var apelido = campo === null ? '' : campo.value

      if (tipo === 'sessao') return adicionarAparelho(deRegistrar, apelido)

      if (tipo === 'recuperacao') {
        var doCodigo = deRegistrar.querySelector('input[name="codigo"]')
        if (doCodigo === null) {
          avisar('Não foi possível continuar. Digite o código de novo.')
          return
        }
        return cadastrar({ tipo: 'recuperacao', codigo: doCodigo.value }, apelido)
      }

      if (convite === null) {
        avisar('Este link de convite não está completo. Peça um link novo.')
        return
      }
      return cadastrar({ tipo: 'convite', convite: convite }, apelido)
    })
  }
})()
