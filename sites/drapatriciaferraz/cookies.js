// Aviso de cookies do drapatriciaferraz.pt (Google Consent Mode v2).
// O estado por omissão (tudo recusado) é definido no <head> de cada página,
// antes do Google Tag Manager. Este ficheiro mostra o aviso, guarda a escolha
// e atualiza o consentimento. A escolha fica em localStorage ('drpf_cookies').
(function () {
  var KEY = 'drpf_cookies';
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {} }
  function apply(c) {
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    gtag('consent', 'update', {
      analytics_storage: c.analytics ? 'granted' : 'denied',
      ad_storage: c.ads ? 'granted' : 'denied',
      ad_user_data: c.ads ? 'granted' : 'denied',
      ad_personalization: c.ads ? 'granted' : 'denied'
    });
    window.dataLayer.push({ event: 'cookie_consent_update', cookies_analise: !!c.analytics, cookies_publicidade: !!c.ads });
  }

  var css = '' +
    '#ck{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;max-width:760px;margin:0 auto;background:#fff;color:#2d3748;' +
    'border:1px solid #dde6f0;border-radius:16px;box-shadow:0 12px 40px rgba(11,29,53,.25);padding:20px 22px;font:14px/1.55 Inter,Arial,sans-serif}' +
    '#ck h2{font:700 17px/1.3 Inter,Arial,sans-serif;color:#0b1d35;margin:0 0 6px}' +
    '#ck p{margin:0 0 12px}#ck a{color:#0d7377}' +
    '#ck .ck-row{display:flex;gap:10px;flex-wrap:wrap}' +
    '#ck button{flex:1 1 150px;border-radius:10px;padding:11px 14px;font:600 14px Inter,Arial,sans-serif;cursor:pointer;border:1.5px solid #0d7377}' +
    '#ck .ck-yes,#ck .ck-no{background:#0d7377;color:#fff}' +
    '#ck .ck-set{background:#fff;color:#0d7377}' +
    '#ck .ck-opts{display:none;margin:4px 0 14px;border-top:1px solid #dde6f0;padding-top:12px}' +
    '#ck.open .ck-opts{display:block}' +
    '#ck label{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;cursor:pointer}' +
    '#ck label input{margin-top:3px;width:18px;height:18px;accent-color:#0d7377;flex:0 0 auto}' +
    '#ck label small{display:block;color:#64748b}' +
    '@media(max-width:520px){#ck{left:10px;right:10px;bottom:10px;padding:16px}#ck button{flex:1 1 100%}}';

  function show() {
    if (document.getElementById('ck')) return;
    var c = read() || { analytics: false, ads: false };
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var d = document.createElement('div');
    d.id = 'ck'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Preferências de cookies');
    d.innerHTML =
      '<h2>Cookies</h2>' +
      '<p>Usamos cookies essenciais para o site funcionar. Com a sua autorização, usamos também cookies de análise e de publicidade da Google, para medir as visitas e a eficácia dos anúncios. Pode mudar a sua escolha a qualquer momento em «Definições de cookies», no rodapé. <a href="/privacidade#priv11b">Saber mais</a></p>' +
      '<div class="ck-opts">' +
        '<label><input type="checkbox" checked disabled/> <span><b>Essenciais</b><small>Necessários para o site e a marcação funcionarem. Sempre ativos.</small></span></label>' +
        '<label><input type="checkbox" id="ck-an"' + (c.analytics ? ' checked' : '') + '/> <span><b>Análise</b><small>Google Analytics: contar visitas e perceber como o site é usado.</small></span></label>' +
        '<label><input type="checkbox" id="ck-ad"' + (c.ads ? ' checked' : '') + '/> <span><b>Publicidade</b><small>Google Ads: medir os resultados dos anúncios.</small></span></label>' +
      '</div>' +
      '<div class="ck-row">' +
        '<button type="button" class="ck-no">Rejeitar</button>' +
        '<button type="button" class="ck-set">Definições</button>' +
        '<button type="button" class="ck-yes">Aceitar todos</button>' +
      '</div>';
    document.body.appendChild(d);
    function done(choice) { choice.ts = new Date().toISOString(); save(choice); apply(choice); d.remove(); }
    d.querySelector('.ck-yes').onclick = function () { done({ analytics: true, ads: true }); };
    d.querySelector('.ck-no').onclick = function () { done({ analytics: false, ads: false }); };
    d.querySelector('.ck-set').onclick = function () {
      if (!d.classList.contains('open')) { d.classList.add('open'); this.textContent = 'Guardar escolha'; return; }
      done({ analytics: d.querySelector('#ck-an').checked, ads: d.querySelector('#ck-ad').checked });
    };
  }

  window.openCookieSettings = function () {
    show();
    var d = document.getElementById('ck');
    if (d && !d.classList.contains('open')) d.querySelector('.ck-set').click();
  };
  function init() { if (!read()) show(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
