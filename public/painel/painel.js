/*
 * O `painel.js`. Sem framework, sem roteador, sem modelo de estado, sem cache
 * proprio e **sem `innerHTML`** — a CSP tem `require-trusted-types-for
 * 'script'`, entao um `innerHTML` aqui seria erro de RUNTIME, e nao de revisao.
 *
 * §12.8 lista cinco trabalhos para este arquivo. Nesta etapa existem os dois
 * que as telas de hoje precisam:
 *
 *   1. WebAuthn: `navigator.credentials.get()` e `.create()`, SEMPRE dentro de
 *      um clique (o Safari exige gesto do usuario; chamar no `onload` quebra em
 *      iOS) e sempre com `userVerification: "required"`.
 *   2. Ler o token do convite do FRAGMENTO (`location.hash`), limpar a barra de
 *      enderecos com `history.replaceState` e mandar o token no CORPO do POST.
 *
 * Os outros tres — miniatura que falhou, marcar em lote, inserir `{username}` /
 * `{link}` — chegam com as telas que os usam. Codigo sem tela e codigo sem
 * teste.
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

  // -------------------------------------------------------------------------
  // Trabalho 1: entrar com a digital
  // -------------------------------------------------------------------------

  function entrar() {
    return pedir('/painel/api/entrar/opcoes', {}).then(function (inicio) {
      if (!inicio.ok) {
        avisar(frase(inicio.dados))
        return
      }

      var opcoes = inicio.dados
      return navigator.credentials
        .get({
          publicKey: {
            challenge: paraBytes(opcoes.challenge),
            rpId: opcoes.rpId,
            allowCredentials: [],
            userVerification: 'required',
            timeout: opcoes.timeout,
          },
        })
        .then(function (credencial) {
          return pedir('/painel/api/entrar/verificar', {
            credencial: {
              id: credencial.id,
              type: credencial.type,
              clientDataJSON: paraTexto(credencial.response.clientDataJSON),
              authenticatorData: paraTexto(credencial.response.authenticatorData),
              signature: paraTexto(credencial.response.signature),
              userHandle:
                credencial.response.userHandle === null
                  ? null
                  : paraTexto(credencial.response.userHandle),
            },
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
   * `Referer` — e por isso que o token de uso unico viaja ali e nunca na query
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

  function cadastrar(convite, apelido) {
    return pedir('/painel/api/registrar/opcoes', {
      tipo: 'convite',
      convite: convite,
      apelido: apelido,
    }).then(function (inicio) {
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

  var deRegistrar = document.getElementById('registrar')
  if (deRegistrar !== null) {
    var convite = tokenDoConvite()
    ligar(deRegistrar, function () {
      if (convite === null) {
        avisar('Este link de convite não está completo. Peça um link novo.')
        return
      }
      var campo = document.getElementById('apelido')
      return cadastrar(convite, campo === null ? '' : campo.value)
    })
  }
})()
