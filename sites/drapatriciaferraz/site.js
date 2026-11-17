// ─────────────────────────────────────────────────────────────────
// SITE drapatriciaferraz.pt
// O mesmo servidor responde aos dois domínios. Quando o pedido chega
// a drapatriciaferraz.pt, só são servidas as páginas deste site e os
// endereços necessários à marcação e ao pagamento. Nenhuma página do
// consultas-online.pt (artigos, páginas de serviço, etc.) fica acessível
// neste domínio.
// ─────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const HOST = 'www.drapatriciaferraz.pt';
const HOSTS = ['drapatriciaferraz.pt', 'www.drapatriciaferraz.pt'];
const ORIGIN = 'https://' + HOST;
const DIR = __dirname;
const PUBLIC = path.join(__dirname, '..', '..', 'public');

// Endereços da API partilhados com o consultas-online.pt
const API_POST = new Set(['/create-checkout-session', '/upload-anexos', '/contact']);
const API_GET_PREFIX = ['/booked-slots/'];

// Ficheiros estáticos permitidos (nome publicado -> ficheiro)
const FILES = {
  '/robots.txt':        path.join(DIR, 'robots.txt'),
  '/sitemap.xml':       path.join(DIR, 'sitemap.xml'),
  '/foto-patricia.webp': path.join(PUBLIC, 'foto-patricia.webp'),
  '/logo-lre.png':      path.join(PUBLIC, 'logo-lre.png'),
};

function isDrPF(req) {
  return HOSTS.includes(String(req.hostname || '').toLowerCase());
}

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Secção "Sobre mim" da página inicial do consultas-online.pt (fonte única da biografia)
function bioFromIndex() {
  const html = read(path.join(PUBLIC, 'index.html'));
  const a = html.indexOf('<!-- SECÇÃO BIOGRAFIA -->');
  const b = html.indexOf('<!-- FIM SECÇÃO BIOGRAFIA -->');
  if (a < 0 || b < 0) return '';
  return html.slice(a + '<!-- SECÇÃO BIOGRAFIA -->'.length, b)
    .replace('<section ', '<section id="sobre" ')
    .replace(/onclick="openServiceSelector\(\)"/g, 'onclick="openBooking()"');
}

// Página legal do consultas-online.pt adaptada a este domínio
function legalFromIndex(pageId) {
  const html = read(path.join(PUBLIC, 'index.html'));
  const a = html.indexOf('id="' + pageId + '"');
  if (a < 0) return null;
  const start = html.indexOf('<div class="inner-page">', a);
  const end = html.indexOf('<div class="page"', a + 10);
  let seg = html.slice(start, end > 0 ? end : undefined);
  seg = seg.slice(0, seg.lastIndexOf('</div>'));         // fecha a .page
  seg = seg
    .replace(/<li onclick="document\.getElementById\('([^']+)'\)\.scrollIntoView\([^"]*\)">([\s\S]*?)<\/li>/g, '<li><a href="#$1">$2</a></li>')
    .replace(/<a href="\/cdn-cgi\/l\/email-protection"[^>]*>[\s\S]*?<\/a>/g, '<a href="mailto:geral@consultas-online.pt">geral@consultas-online.pt</a>')
    .replace(/https?:\/\/(www\.)?consultas-online\.pt/g, ORIGIN)
    .replace(/(^|[^@\w.-])(www\.)?consultas-online\.pt/g, '$1' + HOST)
    .replace(/\s+onclick="[^"]*"/g, '');
  if (pageId === 'page-termos') {
    // Serviços prestados neste site
    seg = seg.replace(/(<h2 id="term3">[\s\S]*?<\/p>\s*)<ul>[\s\S]*?<\/ul>/,
      '$1<ul>\n      <li>Consulta de clínica geral por videoconsulta</li>\n      <li>Consulta com emissão de baixa médica (CIT)</li>\n' +
      '      <li>Emissão de atestados médicos (amamentação, falta escolar, carta de condução)</li>\n    </ul>');
  }
  return seg;
}

function shell(title, desc, canonicalPath, body, opts) {
  opts = opts || {};
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title}</title>
<meta name="description" content="${desc}"/>
<meta name="robots" content="${opts.noindex ? 'noindex' : 'index, follow'}"/>
${canonicalPath ? `<link rel="canonical" href="${ORIGIN}${canonicalPath}"/>` : ''}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230d7377'/%3E%3Ctext x='32' y='42' font-family='Georgia,serif' font-size='28' font-weight='700' fill='white' text-anchor='middle'%3EPF%3C/text%3E%3C/svg%3E"/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
:root{--navy:#0b1d35;--teal:#0d7377;--teal3:#17c4a8;--slate:#4a5568;--muted:#8a9bb0;--border:#dde6f0;--surface:#f4f7fb}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',Arial,sans-serif;color:var(--slate);background:#fff;line-height:1.7}
a{color:var(--teal)}
nav{background:var(--navy);padding:0 20px}
nav div{max-width:900px;margin:0 auto;height:64px;display:flex;align-items:center;justify-content:space-between}
nav .brand{color:#fff;text-decoration:none;font-family:'Cormorant Garamond',Georgia,serif;font-size:23px;font-weight:700}
nav .brand span{color:var(--teal3)}
nav .btn{background:var(--teal);color:#fff;text-decoration:none;padding:9px 18px;border-radius:9px;font-size:13.5px;font-weight:600}
.inner-hero{background:linear-gradient(135deg,#0b1d35,#1a3a5c);color:#fff;padding:48px 20px}
.inner-hero-inner{max-width:900px;margin:0 auto}
.inner-hero h1{color:#fff;font-family:'Cormorant Garamond',Georgia,serif;font-size:40px;line-height:1.15;margin:6px 0 8px}
.inner-hero p{color:rgba(255,255,255,.7)}
.sec-label{font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase}
.inner-body,.box{max-width:900px;margin:0 auto;padding:40px 20px 64px}
.inner-body h2{color:var(--navy);font-size:21px;margin:30px 0 10px}
.inner-body h3{color:var(--navy);font-size:17px;margin:18px 0 8px}
.inner-body p,.inner-body li{font-size:14.5px;margin-bottom:10px}
.inner-body ul,.inner-body ol{margin:0 0 14px 22px}
.legal-updated{color:var(--muted);font-size:13px}
.legal-toc{background:var(--surface);border-radius:12px;padding:18px 22px;margin:18px 0 8px}
.legal-toc h4{color:var(--navy);margin-bottom:8px}
.box h1{font-family:'Cormorant Garamond',Georgia,serif;color:var(--navy);font-size:40px;line-height:1.15;margin-bottom:14px}
.box p{margin-bottom:12px}
.box .cta{display:inline-block;background:var(--teal);color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;margin-top:8px}
footer{background:var(--navy);color:rgba(255,255,255,.55);padding:28px 20px;text-align:center;font-size:13px}
footer a{color:rgba(255,255,255,.75);text-decoration:none;margin:0 9px}
footer .lre{display:inline-block;margin:4px 0 6px}
footer .lre img{height:48px;width:auto;display:block;opacity:.9}
</style>
${opts.head || ''}
</head>
<body>
<nav><div><a class="brand" href="/">Dra. Patrícia <span>Ferraz</span></a><a class="btn" href="/#servicos">Marcar consulta</a></div></nav>
${body}
<footer>
  <div style="margin-bottom:10px"><a href="/">Início</a><a href="/termos">Termos de Serviço</a><a href="/privacidade">Política de Privacidade</a><a href="https://www.livroreclamacoes.pt/INICIO/" target="_blank" rel="noopener">Livro de Reclamações</a></div>
  <a class="lre" href="https://www.livroreclamacoes.pt/INICIO/" target="_blank" rel="noopener"><img src="/logo-lre.png" alt="Livro de Reclamações Eletrónico" width="120" height="48"/></a>
  <br/>© 2026 Dra. Patrícia Ferraz · Médica · Cédula n.º 57713
</footer>
</body>
</html>`;
}


// Painel de administração: o mesmo do consultas-online.pt (fonte única em
// public/index.html: estilos, <div id="page-admin"> e o JavaScript das secções
// ADMIN PANEL e ATESTADOS). Usa a mesma API e a mesma base de dados, por isso
// mostra as marcações e os utentes dos dois sites.
function adminFromIndex() {
  const html = read(path.join(PUBLIC, 'index.html'));
  const head = html.slice(0, html.indexOf('</head>'));
  const styles = (head.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
  const fonts = (head.match(/<link[^>]+fonts\.googleapis\.com\/css2[^>]*>/) || [''])[0];
  const a = html.lastIndexOf('<div', html.indexOf('id="page-admin"'));
  let b = html.indexOf('<div class="overlay" id="serviceModal">');
  b = html.lastIndexOf('<!--', b);
  const panel = html.slice(a, b).replace('<div class="page" id="page-admin">', '<div class="page active" id="page-admin" style="display:block">');
  const api = (/var API_URL\s*=\s*'[^']*';/.exec(html) || ["var API_URL = '';"])[0];
  const cut = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  const js = cut('// ADMIN PANEL', '// FILE UPLOAD') + '\n' + cut('// ATESTADOS', '// EBOOK LEAD');
  if (a < 0 || b < 0 || !js.trim()) throw new Error('painel de administração não encontrado em index.html');
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Administração | Dra. Patrícia Ferraz</title>
<meta name="robots" content="noindex, nofollow"/>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230d7377'/%3E%3Ctext x='32' y='42' font-family='Georgia,serif' font-size='28' font-weight='700' fill='white' text-anchor='middle'%3EPF%3C/text%3E%3C/svg%3E"/>
${fonts}
${styles}
<style>
.adm-nav{position:fixed;top:0;left:0;right:0;z-index:100;height:66px;background:#0b1d35;display:flex;align-items:center;justify-content:space-between;padding:0 24px}
.adm-nav a{color:#fff;text-decoration:none;font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:700}
.adm-nav a span{color:#17c4a8}
.adm-nav small{color:rgba(255,255,255,.6);font-size:13px}
</style>
</head>
<body>
<div class="adm-nav"><a href="/">Dra. Patrícia <span>Ferraz</span></a><small>Administração</small></div>
${panel}
<script>
${api}
window.showPage = function(){ window.location.href = '/'; };
${js}
if (sessionStorage.getItem('adminLoggedIn') === 'true') window.showAdminLogin();
</script>
</body>
</html>`;
}

const PAGES = {
  '/': () => read(path.join(DIR, 'index.html'))
    .replace(/<!--BIO:[^>]*-->/, bioFromIndex()),
  '/privacidade': () => shell('Política de Privacidade | Dra. Patrícia Ferraz',
    'Como recolhemos, utilizamos e protegemos os seus dados pessoais.', '/privacidade', legalFromIndex('page-privacidade') || ''),
  '/termos': () => shell('Termos de Serviço | Dra. Patrícia Ferraz',
    'Condições de utilização e de contratação das consultas online da Dra. Patrícia Ferraz.', '/termos', legalFromIndex('page-termos') || ''),
  '/admin': adminFromIndex,
  '/obrigado': () => shell('Marcação confirmada | Dra. Patrícia Ferraz', 'Marcação confirmada.', null,
    `<div class="box">
  <h1>Obrigada! A sua marcação está confirmada.</h1>
  <p>O pagamento foi recebido. Vai receber dentro de minutos um email com a confirmação da marcação, o link para a videoconsulta e a fatura.</p>
  <p>Se não encontrar o email, veja também a pasta de spam ou promoções.</p>
  <a class="cta" href="/">Voltar ao início</a>
</div>
<!-- Etiqueta de conversão do Google Ads: cole aqui o evento de conversão, se usar. -->`, { noindex: true }),
};

let CACHE = {};
function page(p) {
  if (!(p in CACHE)) CACHE[p] = PAGES[p]();
  return CACHE[p];
}

function notFound(res) {
  res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(shell('Página não encontrada | Dra. Patrícia Ferraz', 'Página não encontrada.', null,
    '<div class="box"><h1>Página não encontrada</h1><p>A página que procura não existe.</p><a class="cta" href="/">Ir para o início</a></div>',
    { noindex: true }));
}

module.exports = function drPatriciaFerraz(app) {
  app.use((req, res, next) => {
    if (!isDrPF(req)) return next();

    // Domínio sem "www" -> com "www"
    if (String(req.hostname).toLowerCase() !== HOST) {
      return res.redirect(301, ORIGIN + req.originalUrl);
    }

    // API partilhada (marcação, pagamento, contacto)
    if (req.method === 'POST' && API_POST.has(req.path)) return next();
    if (req.method === 'OPTIONS' && API_POST.has(req.path)) return next();
    if (req.method === 'GET' && API_GET_PREFIX.some(p => req.path.startsWith(p))) return next();

    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

    if (FILES[req.path]) {
      res.removeHeader('Content-Type');
      return res.sendFile(FILES[req.path]);
    }
    if (PAGES[req.path]) {
      if (req.path === '/admin') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(page(req.path));
      } catch (err) {
        console.error('drapatriciaferraz.pt: erro ao gerar ' + req.path + ':', err.message);
        return res.status(500).send('Erro');
      }
    }
    return notFound(res);
  });
};

module.exports.isDrPF = isDrPF;
module.exports.ORIGIN = ORIGIN;
