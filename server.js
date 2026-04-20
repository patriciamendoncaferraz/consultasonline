require('dotenv').config();
const express  = require('express');
const compression = require('compression');
const cors     = require('cors');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail   = require('@sendgrid/mail');
const axios    = require('axios');
const path     = require('path');
const mongoose = require('mongoose');
// Google Meet — link fixo de videoconsulta
const MEET_LINK = process.env.MEET_LINK || 'https://meet.google.com/ukw-vjni-vyn';

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app  = express();
app.use(compression());
const PORT = process.env.PORT || 8080;

// ─────────────────────────────────────────────
// MONGODB — Registos Clínicos
// ─────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB conectado'))
    .catch(err => console.error('MongoDB erro:', err.message));
} else {
  console.warn('MONGO_URI não definido — registos clínicos desativados');
}

// Schema do Utente
const consultaSchema = new mongoose.Schema({
  data:         { type: Date, default: Date.now },
  dataConsulta: String,
  hora:         String,
  servico:      String,
  observacoes:  String,
  stripeSession:String,
  valor:        Number,
  notaClinica:  String,
  temAnexos:    Boolean,
  numAnexos:    Number,
}, { _id: true });

const utenteSchema = new mongoose.Schema({
  nomeCompleto:   { type: String, required: true },
  email:          { type: String, required: true },
  telefone:       String,
  numeroUtente:   String,
  dataNascimento: String,
  nif:            String,
  morada:         String,
  notas:          String, // notas clínicas do admin
  consultas:      [consultaSchema],
  criado:         { type: Date, default: Date.now },
  atualizado:     { type: Date, default: Date.now },
}, { collection: 'utentes' });

// Índice único por email
utenteSchema.index({ email: 1 }, { unique: true });
utenteSchema.index({ numeroUtente: 1 });

const Utente = mongoose.models.Utente || mongoose.model('Utente', utenteSchema);

// Schema para slots ocupados
const bookedSlotSchema = new mongoose.Schema({
  dateKey: { type: String, required: true }, // YYYY-MM-DD
  time:    { type: String, required: true }, // HH:MM
  serviceId:   String,
  serviceName: String,
  customerEmail: String,
  stripeSession: String,
  createdAt: { type: Date, default: Date.now },
  blocked: { type: Boolean, default: false },
  blockedReason: { type: String, default: '' },
});
bookedSlotSchema.index({ dateKey: 1, time: 1 }, { unique: true });
const BookedSlot = mongoose.models.BookedSlot || mongoose.model('BookedSlot', bookedSlotSchema);
const leadSchema = new mongoose.Schema({
  nome:      { type: String, required: true },
  email:     { type: String, required: true },
  fonte:     { type: String, default: 'ebook-saude-em-dia' },
  criadoEm: { type: Date, default: Date.now },
});
leadSchema.index({ email: 1 }, { unique: true });
const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema);
// Guardar/atualizar utente e adicionar consulta
async function upsertUtente({ nomeCompleto, email, telefone, numeroUtente, nif, morada, observacoes, dataConsulta, hora, servico, stripeSession, valor, temAnexos, numAnexos }) {
  if (!MONGO_URI || !email) return null;
  try {
    const novaConsulta = { data: new Date(), dataConsulta, hora, servico, observacoes, stripeSession, valor, temAnexos: !!temAnexos, numAnexos: numAnexos || 0 };
    const utente = await Utente.findOneAndUpdate(
      { email },
      {
        $set: {
          nomeCompleto, telefone,
          ...(numeroUtente && { numeroUtente }),
          ...(nif && { nif }),
          ...(morada && { morada }),
          atualizado: new Date(),
        },
        $push: { consultas: novaConsulta },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log('Utente guardado:', email);
    return utente;
  } catch (err) {
    console.error('Erro ao guardar utente:', err.message);
    return null;
  }
}

// Redirecionar sem www para com www
app.use((req, res, next) => {
  if (req.headers.host === 'consultas-online.pt') {
    return res.redirect(301, 'https://www.consultas-online.pt' + req.url);
  }
  next();
});

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const SERVICES = {
  'atestado-amamentacao':       { name: 'Atestado de Amamentação',          price: 3500 },
  'atestado-escola':            { name: 'Atestado para Falta Escolar',       price: 3500 },
  'atestado-conducao':          { name: 'Atestado para Carta de Condução',   price: 4500 },
  'baixa-medica':               { name: 'Emissão de Baixa Médica',           price: 5500 },
  'renovacao-medicamentos':     { name: 'Renovação de Medicamentos',         price: 4000 },
  'consulta-infecao-urinaria':  { name: 'Consulta de Infeção Urinária',      price: 4000 },
  'consulta-cessacao-tabagica': { name: 'Consulta de Cessação Tabágica',     price: 4000 },
  'consulta-amigdalite':        { name: 'Consulta de Amigdalite',            price: 4000 },
  'consulta-dst':               { name: 'Consulta DST / IST',                price: 4000 },
  'renovacao-piula': { name: 'Renovação de Pílula Anticoncecional', price: 4000 },
};

function formatPhone(phone) {
  if (!phone) return null;
  const clean = phone.replace(/[\s\-]/g, '');
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('00351')) return '+' + clean.slice(2);
  if (clean.startsWith('351')) return '+' + clean;
  return '+351' + clean;
}


// ─────────────────────────────────────────────────────────────────
// ROTAS SEO — Cada artigo tem URL próprio indexável pelo Google
// ─────────────────────────────────────────────────────────────────
const ARTICLES = {
  'infecao-urinaria': {
    id: 'itu',
    title: 'Infeção Urinária: Causas, Sintomas e Tratamento | ConsultasOnline',
    description: 'Saiba como identificar e tratar a infeção urinária. Consulta online com diagnóstico e receita de antibiótico em 30 minutos. A partir de 40€.',
    category: 'Infeções',
    keywords: 'infeção urinária sintomas tratamento, consulta infeção urinária online, antibiótico infeção urinária portugal',
  },
  'baixa-medica': {
    id: 'renovacao-baixa',
    title: 'Baixa Médica Online em Portugal: Como Funciona | ConsultasOnline',
    description: 'Como funciona o CIT em Portugal, prazos e como renovar a baixa médica online sem sair de casa.',
    category: 'Baixas',
    keywords: 'baixa médica online portugal, renovar baixa médica online, CIT online, consulta baixa médica',
  },
  'renovacao-medicamentos': {
    id: 'renovacao-medicamentos',
    title: 'Renovação de Medicamentos Online em Portugal | ConsultasOnline',
    description: 'Renove a sua receita médica por videoconsulta. Receita electrónica enviada por SMS e email no próprio dia. A partir de 40€.',
    category: 'Medicação',
    keywords: 'renovar receita médica online, renovação medicamentos online portugal, receita médica online',
  },
  'atestado-amamentacao': {
    id: 'amamentacao',
    title: 'Atestado de Amamentação Online em Portugal | ConsultasOnline',
    description: 'Obtenha o atestado de amamentação por videoconsulta. Direitos laborais, renovação após 12 meses. Emitido no próprio dia. 35€.',
    category: 'Amamentação',
    keywords: 'atestado amamentação online, atestado amamentação portugal, renovar atestado amamentação',
  },
  'atestado-carta-conducao': {
    id: 'conducao',
    title: 'Atestado para Carta de Condução Online | Enviado ao IMT | ConsultasOnline',
    description: 'Atestado médico para carta de condução online em Portugal. Enviado directamente ao IMT. Válido para primeira carta, renovação e troca. Emitido no próprio dia. 45€.',
    category: 'Carta de Condução',
    keywords: 'atestado carta de condução online, atestado médico carta de condução portugal, renovar carta de condução atestado, atestado IMT online, exame médico carta de condução online',
  },
  'faltas-trabalho': {
    id: 'faltas-trabalho',
    title: 'Faltas ao Trabalho por Doença: Como Justificar | ConsultasOnline',
    description: 'Tudo sobre declarações médicas, baixas e os seus direitos como trabalhador. Declaração médica emitida online no próprio dia.',
    category: 'Trabalho',
    keywords: 'faltas trabalho doença justificar, declaração médica trabalho online, baixa médica trabalho portugal',
  },
  'faltas-escola': {
    id: 'faltas-escola',
    title: 'Faltas à Escola por Doença: Como Justificar | ConsultasOnline',
    description: 'O que diz a lei, documentos necessários e como obter declaração médica online para justificar faltas escolares. 35€.',
    category: 'Escola',
    keywords: 'faltas escola doença justificar, atestado falta escolar online, declaração médica escola portugal',
  },
  'dor-de-garganta-amigdalite': {
    id: 'garganta',
    title: 'Dor de Garganta e Amigdalite: Quando Tomar Antibiótico | ConsultasOnline',
    description: 'Amigdalite viral ou bacteriana? Quando precisa de antibiótico. Consulta online de amigdalite com avaliação e receita. 40€.',
    category: 'Infeções',
    keywords: 'consulta amigdalite online, antibiótico amigdalite online, dor garganta consulta online portugal',
  },
  'ozempic-glp1': {
    id: 'ozempic',
    title: 'Ozempic, Mounjaro e Wegovy: Guia Completo GLP-1 | ConsultasOnline',
    description: 'Semaglutido, tirzepatido — eficácia, segurança e quem pode tomar. O guia médico completo sobre os medicamentos GLP-1.',
    category: 'Obesidade',
    keywords: 'ozempic portugal, wegovy portugal, mounjaro portugal, semaglutido tirzepatido guia',
  },
  'doencas-sexualmente-transmissiveis': {
    id: 'dst',
    title: 'Doenças Sexualmente Transmissíveis: Rastreio Online | ConsultasOnline',
    description: 'Rastreio de DST/IST de forma discreta e confidencial. VIH, sífilis, gonorreia, clamídia — pedido de análises online. 40€.',
    category: 'Saúde Sexual',
    keywords: 'rastreio DST online portugal, teste IST online discreto, consulta DST IST online confidencial',
  },
  'cessacao-tabagica': {
    id: 'cessacao',
    title: 'Como Parar de Fumar: Guia Médico Completo | ConsultasOnline',
    description: 'Vareniclina, bupropiona, TSN — os tratamentos com maior evidência para parar de fumar. Consulta com prescrição médica. 40€.',
    category: 'Cessação Tabágica',
    keywords: 'cessação tabágica online portugal, consulta parar fumar online, vareniclina prescrição online',
  },
  'consulta-online': {
    id: 'consulta-online',
    title: 'Consulta Online em Portugal: O Guia Completo | ConsultasOnline',
    description: 'O que é, como funciona, quanto custa e o que pode tratar numa consulta médica online em Portugal. Tudo o que precisa saber.',
    category: 'Consulta Online',
    keywords: 'consulta online portugal, como funciona consulta online, consulta médica online portugal guia',
  },
  'medico-online': {
    id: 'medico-online',
    title: 'Médico Online em Portugal: Como Funciona | ConsultasOnline',
    description: 'Vantagens do médico online, o que pode pedir, segurança e sigilo médico. Como escolher uma plataforma de confiança.',
    category: 'Médico Online',
    keywords: 'médico online portugal, médico online videoconsulta, médico online mbway portugal',
  },
  'telemedicina': {
    id: 'telemedicina',
    title: 'Telemedicina em Portugal: O que É e Direitos do Utente | ConsultasOnline',
    description: 'Como funciona a telemedicina em Portugal, diferenças entre SNS e privado e os seus direitos como utente.',
    category: 'Telemedicina',
    keywords: 'telemedicina portugal, telemedicina como funciona, teleconsulta portugal direitos utente',
  },
  'atestado-rastreio-saude': {
    id: 'rastreio',
    title: 'Rastreio de Saúde em Portugal: O Guia Completo | ConsultasOnline',
    description: 'Rastreios recomendados pela DGS por idade e sexo, vacinação do adulto e como fazer rastreio de IST de forma discreta.',
    category: 'Saúde Preventiva',
    keywords: 'rastreio saúde portugal, exames preventivos portugal, rastreio oncológico portugal',
  },
  'dia-mundial-saude-2026': {
    id: 'dia-saude-2026',
    title: 'Dia Mundial da Saúde 2026: Juntos pela Ciência | ConsultasOnline',
    description: 'O que é o Dia Mundial da Saúde 2026, qual o tema da OMS e o que pode fazer hoje pela sua saúde em Portugal. Telemedicina e ciência ao seu serviço.',
    category: 'Saúde Global',
    keywords: 'dia mundial saúde 2026, OMS 2026 tema, saúde portugal 2026, telemedicina portugal, consulta online portugal',
  },
  'renovar-pilula-anticoncecional-online': {
  id: 'piula-online',
  title: 'Renovar a Pílula Anticoncecional Online em Portugal | ConsultasOnline',
  description: 'Saiba como renovar a receita da pílula por videoconsulta em Portugal. Legal, seguro, sem médico de família. Receita Sem Papel no próprio dia. 40€.',
  category: 'Saúde da Mulher',
  keywords: 'renovar pílula anticoncecional online, receita pílula online portugal, pílula sem médico de família, videoconsulta pílula portugal',
},
};

// Gera HTML completo para cada artigo com meta tags SEO próprias
function buildArticlePage(slug, article) {
  var canonicalUrl = 'https://www.consultas-online.pt/artigos/' + slug;
  var html = '<!DOCTYPE html>\n';
  html += '<html lang="pt">\n<head>\n';
  html += '<meta charset="UTF-8"/>\n';
  html += '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>\n';
  html += '<title>' + article.title + '</title>\n';
  html += '<meta name="description" content="' + article.description + '"/>\n';
  html += '<meta name="keywords" content="' + article.keywords + '"/>\n';
  html += '<meta name="robots" content="index, follow"/>\n';
  html += '<link rel="canonical" href="' + canonicalUrl + '"/>\n';
  html += '<meta property="og:type" content="article"/>\n';
  html += '<meta property="og:url" content="' + canonicalUrl + '"/>\n';
  html += '<meta property="og:title" content="' + article.title + '"/>\n';
  html += '<meta property="og:description" content="' + article.description + '"/>\n';
  html += '<meta property="og:locale" content="pt_PT"/>\n';
  html += '<meta property="og:site_name" content="ConsultasOnline"/>\n';
  html += '<script type=\"application/ld+json\">\n{\n';
  html += '  "@context": "https://schema.org",\n';
  html += '  "@type": "MedicalWebPage",\n';
  html += '  "name": "' + article.title + '",\n';
  html += '  "description": "' + article.description + '",\n';
  html += '  "url": "' + canonicalUrl + '",\n';
  html += '  "inLanguage": "pt-PT",\n';
  html += '  "isPartOf": {"@type":"MedicalBusiness","name":"ConsultasOnline","url":"https://www.consultas-online.pt"}\n';
  html += '}\n<\/script>\n';
  html += '<style>body{font-family:Arial,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#334155}a{color:#0d7377}h1{color:#0b1d35;margin-top:24px;font-size:32px}p{font-size:16px;line-height:1.7;margin-top:12px}.btn{display:inline-block;margin-top:24px;background:#0d7377;color:#fff;padding:13px 28px;border-radius:9px;text-decoration:none;font-weight:600;font-size:15px}</style>\n';
  html += '</head>\n<body>\n';
  html += '<nav style="margin-bottom:8px"><a href="/">← ConsultasOnline</a></nav>\n';
  html += '<p style="font-size:12px;color:#8a9bb0">' + article.category + '</p>\n';
  html += '<h1>' + article.title.split('|')[0].trim() + '</h1>\n';
  html += '<p>' + article.description + '</p>\n';
  html += '<a href="/" class="btn">Marcar Consulta Online →</a>\n';
  html += '<p style="margin-top:32px;font-size:13px;color:#8a9bb0">A carregar artigo completo...</p>\n';
  html += '<script>\n';
  html += '(function(){\n';
  html += '  sessionStorage.setItem(\'openArticle\', \'' + article.id + '\');\n';
  html += '  window.location.replace(\'/\');\n';
  html += '})();\n';
  html += '<\/script>\n';
  html += '</body>\n</html>';
  return html;
}

// Rota para listagem de artigos
app.get('/artigos', (req, res) => {
  var links = Object.entries(ARTICLES).map(function(entry) {
    var slug = entry[0]; var art = entry[1];
    return '<li><a href="/artigos/' + slug + '" style="color:#0d7377">' + art.title.split('|')[0].trim() + '</a></li>';
  }).join('');
  var html = '<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>';
  html += '<title>Artigos de Saúde | ConsultasOnline</title>';
  html += '<meta name="description" content="Artigos médicos sobre consulta online, baixa médica, atestados e muito mais."/>';
  html += '<meta name="robots" content="index, follow"/>';
  html += '<link rel="canonical" href="https://www.consultas-online.pt/artigos"/>';
  html += '</head><body style="font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 20px">';
  html += '<a href="/" style="color:#0d7377;font-weight:700;text-decoration:none">← ConsultasOnline</a>';
  html += '<h1 style="color:#0b1d35;margin:24px 0">Artigos de Saúde</h1>';
  html += '<ul style="line-height:2.2">' + links + '</ul>';
  html += '</body></html>';
  res.send(html);
});


// Rotas individuais para cada artigo
app.get('/artigos/:slug', (req, res) => {
  var slug = req.params.slug;
  var article = ARTICLES[slug];
  if (!article) {
    return res.redirect(301, '/');
  }
  // Serve the main index.html with SEO meta tags injected
  // Read index.html and inject meta tags in the <head>
  var fs = require('fs');
  var path = require('path');
  var indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', function(err, html) {
    if (err) return res.redirect(301, '/');
    var canonicalUrl = 'https://www.consultas-online.pt/artigos/' + slug;
    var metaTags = '<meta name="description" content="' + article.description + '"/>\n'
      + '<meta name="keywords" content="' + article.keywords + '"/>\n'
      + '<link rel="canonical" href="' + canonicalUrl + '"/>\n'
      + '<meta property="og:url" content="' + canonicalUrl + '"/>\n'
      + '<meta property="og:title" content="' + article.title + '"/>\n'
      + '<meta property="og:description" content="' + article.description + '"/>\n'
      + '<title>' + article.title + '</title>\n'
      + '<script>window.__OPEN_ARTICLE__ = "' + article.id + '";<\/script>\n';
    // Replace the existing title and inject meta
    html = html.replace(/<title>[^<]*<\/title>/, '');
    html = html.replace('<meta charset="UTF-8"/>', '<meta charset="UTF-8"/>\n' + metaTags);
    res.send(html);
  });
});

// Página de sucesso após pagamento
app.get('/obrigado', (req, res) => {
  const sessionId = req.query.session_id || '';
  res.send(`<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Consulta Confirmada — ConsultasOnline</title>
<meta name="description" content="A sua consulta médica online foi confirmada com sucesso. Receberá o email de confirmação e fatura em breve."/>
<meta name="robots" content="noindex, nofollow"/>
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-1803618151"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','AW-1803618151');gtag('event','conversion',{'send_to':'AW-1803618151/qawCCN7xyJccEI-UqZhD','value':47.0,'currency':'EUR'});</script>
<link rel="canonical" href="https://www.consultas-online.pt/"/>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f4f7fb;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:20px;padding:48px 40px;max-width:520px;width:100%;text-align:center;box-shadow:0 8px 48px rgba(11,29,53,.12)}
.icon{width:72px;height:72px;background:linear-gradient(135deg,#38a169,#48bb78);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:32px}
h1{font-family:'Cormorant Garamond',serif;font-size:36px;color:#0b1d35;margin-bottom:10px}
p{font-size:15px;color:#64748b;line-height:1.7;margin-bottom:8px}
.highlight{background:#f4f7fb;border-radius:10px;padding:16px 20px;margin:20px 0;text-align:left}
.highlight p{font-size:14px;color:#0b1d35;margin-bottom:4px}
.highlight p:last-child{margin:0}
.btn{display:inline-block;margin-top:24px;background:linear-gradient(135deg,#0d7377,#0f8c82);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:600;font-family:'Inter',sans-serif}
.btn:hover{opacity:.9}
.logo{font-family:'Cormorant Garamond',serif;font-size:20px;color:#0b1d35;margin-bottom:32px}
.logo span{color:#17c4a8}
</style>
<!-- Schema: Confirmação de serviço médico -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ConfirmAction",
  "name": "Consulta Médica Online Confirmada",
  "provider": {
    "@type": "MedicalBusiness",
    "name": "ConsultasOnline",
    "url": "https://www.consultas-online.pt"
  }
}
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-1803618151"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','AW-1803618151');gtag('event','conversion',{'send_to':'AW-1803618151/qawCCN7xyJccEI-UqZhD','value':47.0,'currency':'EUR'});
</head>
<body>
<div class="card">
  <div class="logo">Consultas<span>Online</span></div>
  <div class="icon" role="img" aria-label="Pagamento confirmado">✓</div>
  <h1>Pagamento Confirmado!</h1>
  <p>A sua consulta médica online foi agendada com sucesso.</p>
  <p>Vai receber um email de confirmação com todos os detalhes e a fatura em breve.</p>
  <div class="highlight">
    <p>📧 <strong>Verifique o seu email</strong></p>
    <p style="font-size:13px;color:#64748b">A confirmação e fatura são enviadas automaticamente. Verifique também a pasta de spam.</p>
    <p style="font-size:13px;color:#64748b;margin-top:8px">🎥 O link da videoconsulta está no email.</p>
  </div>
  <a href="/" class="btn" aria-label="Voltar à página principal da ConsultasOnline">Voltar ao Website →</a>
</div>
</body>
</html>`);
});

// Get booked slots for a specific date
app.get('/booked-slots/:dateKey', async (req, res) => {
  if (!MONGO_URI) return res.json([]);
  try {
    const slots = await BookedSlot.find({ dateKey: req.params.dateKey }, 'time -_id');
    res.json(slots.map(s => s.time));
  } catch (err) {
    res.json([]);
  }
});

app.get('/services', (req, res) => {
  res.json(Object.entries(SERVICES).map(([id, s]) => ({ id, name: s.name, price: s.price / 100 })));
});

// ─────────────────────────────────────────────
// UPLOAD ANEXOS — receber ficheiros e enviar por email
// ─────────────────────────────────────────────
app.post('/upload-anexos', async (req, res) => {
  const { customerName, customerEmail, serviceId, serviceName, date, time, ficheiros } = req.body;
  if (!ficheiros || !ficheiros.length) return res.json({ ok: true, skipped: true });

  try {
    const nomeServico = serviceName || serviceId || 'Servico desconhecido';
    const attachments = ficheiros.map(f => ({
      content: f.data,
      filename: f.name,
      type: f.type || 'application/octet-stream',
      disposition: 'attachment',
    }));

    const toEmail = 'patricia.mendonca.ferraz@gmail.com';
    const fromEmail = process.env.FROM_EMAIL || 'geral@consultas-online.pt';
    console.log('A enviar anexos para:', toEmail, 'de:', fromEmail);
    await sgMail.send({
      to: toEmail,
      from: { email: fromEmail, name: 'ConsultasOnline — Anexos' },
      subject: '[ANEXOS] ' + nomeServico + ' — ' + (customerName || customerEmail),
      html: '<html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">'
        + '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'
        + '<div style="background:#0b1d35;padding:18px 24px"><span style="font-size:18px;font-weight:700;color:#fff">Consultas<span style="color:#17c4a8">Online</span></span>'
        + '&nbsp;&nbsp;<span style="background:rgba(214,158,46,.2);color:#f6ad55;font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px">📎 ANEXOS</span></div>'
        + '<div style="padding:22px 24px">'
        + '<h3 style="color:#0b1d35;margin:0 0 14px">Documentos submetidos pelo utente</h3>'
        + '<table style="width:100%;font-size:13px;border-collapse:collapse">'
        + '<tr><td style="color:#8a9bb0;font-weight:600;padding:6px 0;width:120px">Utente</td><td style="color:#0b1d35">' + (customerName || '—') + '</td></tr>'
        + '<tr><td style="color:#8a9bb0;font-weight:600;padding:6px 0">Email</td><td style="color:#0b1d35">' + (customerEmail || '—') + '</td></tr>'
        + '<tr><td style="color:#8a9bb0;font-weight:600;padding:6px 0">Serviço</td><td style="color:#0b1d35">' + nomeServico + '</td></tr>'
        + '<tr><td style="color:#8a9bb0;font-weight:600;padding:6px 0">Data/Hora</td><td style="color:#0b1d35">' + (date || '—') + ' às ' + (time || '—') + '</td></tr>'
        + '<tr><td style="color:#8a9bb0;font-weight:600;padding:6px 0">Ficheiros</td><td style="color:#0b1d35">' + ficheiros.length + ' documento(s) em anexo</td></tr>'
        + '</table>'
        + '</div></div></body></html>',
      text: 'Anexos de ' + (customerName || customerEmail) + ' — ' + nomeServico + ' — ' + date + ' ' + time,
      attachments,
    });

    console.log('Anexos enviados com sucesso:', ficheiros.length, 'ficheiros de', customerEmail);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar anexos:', err.response ? JSON.stringify(err.response.body) : err.message);
    // Don't fail the request - just log the error
    res.json({ ok: false, error: err.message });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  const { serviceId, customerEmail, customerName, date, time, nif, telefone, numeroUtente, observacoes, temAnexos, numAnexos } = req.body;

const service = SERVICES[serviceId];
  if (!service) return res.status(400).json({ error: 'Servico invalido.' });
  const clientUrl = process.env.CLIENT_URL || 'https://consultas-online.pt';
  try {
    // Verificar se o slot está disponível
    const dateKey = date ? date.split('/').reverse().join('-') : '';
    const existingSlot = await BookedSlot.findOne({ dateKey, time });
    if (existingSlot) {
      return res.status(400).json({ error: 'Este horario ja nao esta disponivel. Por favor escolha outro.' });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'mb_way', 'multibanco'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: service.name,
            description: 'Consulta online em ' + date + ' às ' + time,
          },
          unit_amount: service.price,
        },
        quantity: 1,
      }],
      customer_email: customerEmail,
      metadata: {
        serviceId,
        serviceName: service.name,
        date,
        time,
        customerEmail,
        customerName,
        nif:          nif          || '',
        telefone:     telefone     || '',
        numeroUtente: numeroUtente || '',
        observacoes:  observacoes  || '',
        temAnexos:    temAnexos ? 'sim' : '',
        numAnexos:    numAnexos ? String(numAnexos) : '',
      },
      success_url: clientUrl + '/obrigado?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: clientUrl + '/?cancelado=1',
      payment_method_configuration: undefined,
      locale: 'pt',
      billing_address_collection: 'auto',
      phone_number_collection: {
        enabled: false,
      },
      payment_intent_data: {
        description: service.name + ' - ' + date + ' as ' + time,
        receipt_email: customerEmail,
      },
      allow_promotion_codes: true,
      custom_text: {
        submit: { message: 'O seu pagamento é processado de forma segura pelo Stripe.' },
      },
    });

    return res.json({ url: session.url, sessionId: session.id });

  } catch (err) {
    console.error('Stripe Checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});


app.get('/payment-status/:id', async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.id);
    res.json({ status: pi.status });
  } catch (err) {
    res.status(404).json({ error: 'Nao encontrado.' });
  }
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') {
      console.log('Pagamento ainda nao confirmado, ignorando:', session.payment_status);
      return res.json({ received: true });
    }
    // Só processar se o pagamento estiver confirmado
    if (session.payment_status !== 'paid') {
      console.log('Sessão ainda não paga, aguardando payment_intent.succeeded');
      return res.json({ received: true });
    }
    // Read ALL metadata fields safely
    const meta = session.metadata || {};
    const serviceId    = meta.serviceId    || '';
    const serviceName  = meta.serviceName  || '';
    const date         = meta.date         || '';
    const time         = meta.time         || '';
    const customerEmail = meta.customerEmail 
      || (session.customer_details && session.customer_details.email) 
      || session.customer_email 
      || '';
    const customerName = meta.customerName 
      || (session.customer_details && session.customer_details.name) 
      || '';
    const nif          = meta.nif          || '';
    const telefone     = meta.telefone     || '';
    const numeroUtente = meta.numeroUtente || '';
    const observacoes  = meta.observacoes  || '';
    const amountEur    = session.amount_total ? (session.amount_total / 100).toFixed(2).replace('.', ',') + ' EUR' : '—';
    console.log('Checkout completo:', session.id);
    console.log('  -> Email:', customerEmail);
    console.log('  -> Nome:', customerName);
    console.log('  -> Servico:', serviceName);
    console.log('  -> Data/Hora:', date, time);
    if (!customerEmail) {
      console.error('ERRO: customerEmail em falta no webhook!');
      return res.json({ received: true });
    }
    try {
      // 1. Guardar slot como ocupado
      if (MONGO_URI && date && time) {
        try {
          // Convert date DD/MM/YYYY to YYYY-MM-DD
          const parts = (date || '').split('/');
          const dateKey = parts.length === 3 ? parts[2] + '-' + parts[1] + '-' + parts[0] : date;
          await BookedSlot.findOneAndUpdate(
            { dateKey, time },
            { dateKey, time, serviceId, serviceName, customerEmail, stripeSession: session.id },
            { upsert: true, new: true }
          );
          console.log('Slot ocupado:', dateKey, time);
        } catch(slotErr) {
          console.warn('Erro ao guardar slot:', slotErr.message);
        }
      }

      // 2. Guardar registo clínico do utente
      const temAnexosMeta = meta.temAnexos === 'sim';
      const numAnexosMeta = parseInt(meta.numAnexos || '0') || 0;
      await upsertUtente({
        nomeCompleto: customerName,
        email: customerEmail,
        telefone,
        numeroUtente,
        nif,
        observacoes,
        dataConsulta: date,
        hora: time,
        servico: serviceName,
        stripeSession: session.id,
        valor: session.amount_total / 100,
        temAnexos: temAnexosMeta,
        numAnexos: numAnexosMeta,
      });

      // 3. Criar link Google Meet
      const meetLink = await createMeetLink({ customerName, customerEmail, serviceName, date, time });

      // 4. Emitir fatura (só se tiver nome)
      let invoiceData = null;
      if (customerName && customerEmail) {
        invoiceData = await createInvoice({ customerName, customerEmail, nif, serviceName, amount: session.amount_total / 100, date: new Date().toISOString().split('T')[0] });
      } else {
        console.warn('Fatura ignorada: nome ou email em falta', { customerName, customerEmail });
      }

      // 5. Enviar email ao utente
      if (customerEmail) {
        await sendConfirmationEmail({ to: customerEmail, name: customerName || 'Utente', serviceName, date, time, amountEur, meetLink, invoiceUrl: invoiceData && invoiceData.url, invoiceNum: invoiceData && invoiceData.invoiceNumber });
      } else {
        console.warn('Email ignorado: endereco em falta');
      }

      // 6. Notificacao para a medica
      const notifyEmail = process.env.NOTIFY_EMAIL;
      if (notifyEmail) {
        try {
          await sgMail.send({
            to: notifyEmail,
            from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
            subject: 'Nova consulta marcada - ' + serviceName + ' | ' + date + ' as ' + time,
            html: '<html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">'
              + '<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'
              + '<div style="background:#0b1d35;padding:18px 24px"><span style="font-size:18px;font-weight:700;color:#fff">ConsultasOnline</span>'
              + '&nbsp;&nbsp;<span style="background:rgba(23,196,168,.15);color:#17c4a8;font-size:11px;padding:3px 10px;border-radius:12px;font-weight:700">NOVA MARCACAO</span></div>'
              + '<div style="padding:22px 24px">'
              + '<h2 style="color:#0b1d35;font-size:20px;margin:0 0 16px">Nova consulta confirmada</h2>'
              + '<div style="background:#f4f7fb;border-radius:10px;padding:16px;margin-bottom:16px">'
              + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Servico: <strong>' + serviceName + '</strong></p>'
              + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Data: <strong>' + date + '</strong></p>'
              + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Hora: <strong>' + time + '</strong> (PT Continente)</p>'
              + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Utente: <strong>' + (customerName || '-') + '</strong></p>'
              + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Email: <strong>' + (customerEmail || '-') + '</strong></p>'
              + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Valor: <strong>' + amountEur + '</strong></p>'
              + '</div>'
              + '<p style="font-size:12px;color:#8a9bb0">Notificacao automatica ConsultasOnline</p>'
              + '</div></div></body></html>',
            text: 'Nova consulta!\nServico: ' + serviceName + '\nData: ' + date + '\nHora: ' + time + '\nUtente: ' + (customerName||'-') + '\nEmail: ' + (customerEmail||'-') + '\nValor: ' + amountEur,
          });
          console.log('Notificacao enviada para:', notifyEmail);
        } catch(ne) { console.warn('Erro notificacao medica:', ne.message); }
      }
    } catch(e) { console.error('Erro email/fatura:', e.message); }
    return res.json({ received: true });
  }

  if (event.type === 'payment_intent.succeeded') {
    // Ignorado — usamos checkout.session.completed que tem todos os metadados
    console.log('Pagamento confirmado:', event.data.object.id, '(tratado via checkout.session.completed)');
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────
// GOOGLE MEET — Link fixo de videoconsulta
// ─────────────────────────────────────────────
function createMeetLink({ customerName, customerEmail, serviceName, date, time }) {
  console.log('Meet link gerado para:', customerName, date, time);
  return Promise.resolve(MEET_LINK);
}


async function createInvoice({ customerName, customerEmail, nif, serviceName, amount, date }) {
  const apiKey = process.env.INVOICEXPRESS_API_KEY;
  const account = process.env.INVOICEXPRESS_ACCOUNT;
  if (!apiKey || !account) { console.warn('InvoiceXpress nao configurado.'); return null; }

  // Validar campos obrigatórios
  const safeName = (customerName || '').trim();
  const safeEmail = (customerEmail || '').trim();
  if (!safeName || !safeEmail) {
    console.warn('InvoiceXpress ignorado: nome ou email em falta', { safeName, safeEmail });
    return null;
  }

  // Usar um NIF genérico se não fornecido ou se for igual ao NIF da conta
  // (InvoiceXpress não permite faturar para o próprio NIF da conta)
  const safeNif = nif && nif.trim() && nif.trim() !== process.env.INVOICEXPRESS_OWN_NIF
    ? nif.trim()
    : null;

  console.log('InvoiceXpress a processar:', { safeName, safeEmail, safeNif, serviceName, amount, date });

  try {
    // 1. Criar ou encontrar cliente
    let clientId;
    try {
      const clientRes = await axios.post(
        'https://' + account + '.app.invoicexpress.com/clients.json?api_key=' + apiKey,
        { client: {
          name: safeName,
          email: safeEmail,
          country: 'Portugal',
          ...(safeNif ? { fiscal_id: safeNif } : {})
        }}
      );
      clientId = clientRes.data.client.id;
      console.log('InvoiceXpress cliente criado:', clientId);
    } catch (clientErr) {
      const status = clientErr.response && clientErr.response.status;
      const errData = clientErr.response && clientErr.response.data;
      console.log('InvoiceXpress cliente erro status:', status, JSON.stringify(errData));

      // Cliente já existe (422) — pesquisar pelo nome usando a API correcta
      if (status === 422) {
        try {
          const searchRes = await axios.get(
            'https://' + account + '.app.invoicexpress.com/clients.json?api_key=' + apiKey + '&client_name=' + encodeURIComponent(safeName)
          );
          const clients = searchRes.data && searchRes.data.clients;
          if (clients && clients.length > 0) {
            clientId = clients[0].id;
            console.log('InvoiceXpress cliente existente encontrado:', clientId);
          } else {
            console.error('InvoiceXpress: cliente nao encontrado na pesquisa');
            return null;
          }
        } catch (searchErr) {
          console.error('InvoiceXpress pesquisa erro:', searchErr.response && JSON.stringify(searchErr.response.data) || searchErr.message);
          return null;
        }
      } else {
        throw clientErr;
      }
    }

    // 2. Criar fatura
    console.log('InvoiceXpress a criar fatura para cliente:', clientId);
    const invoiceRes = await axios.post(
      'https://' + account + '.app.invoicexpress.com/invoices.json?api_key=' + apiKey,
      { invoice: {
        date,
        due_date: date,
        client: { id: String(clientId), name: safeName },
        tax_exemption: 'M09',
        items: [{
          name: serviceName,
          description: 'Prestacao de servicos de saude online',
          unit_price: String(amount.toFixed(2)),
          quantity: '1',
          unit: 'service',
          tax: {
            name: process.env.INVOICEXPRESS_TAX_NAME || 'Isento artigo 9º do CIVA'
          }
        }],
        observations: 'IVA isento nos termos do artigo 9.º do CIVA'
      }}
    );

    if (!invoiceRes.data || !invoiceRes.data.invoice) {
      console.error('InvoiceXpress: resposta inesperada ao criar fatura:', JSON.stringify(invoiceRes.data));
      return null;
    }
    const invoice = invoiceRes.data.invoice;
    console.log('InvoiceXpress fatura criada:', invoice.id, invoice.sequence_number);

    // 3. Finalizar fatura
    console.log('InvoiceXpress a finalizar fatura:', invoice.id);
    try {
      const finalizeRes = await axios.put(
        'https://' + account + '.app.invoicexpress.com/invoices/' + invoice.id + '/change-state.json?api_key=' + apiKey,
        { invoice: { state: 'finalized' } }
      );
      console.log('InvoiceXpress fatura finalizada:', finalizeRes.data && finalizeRes.data.invoice && finalizeRes.data.invoice.status);
    } catch (finalErr) {
      console.error('InvoiceXpress erro ao finalizar:', finalErr.response && JSON.stringify(finalErr.response.data) || finalErr.message);
    }

    // 4. Obter PDF (aguardar para o PDF ser gerado)
    console.log('InvoiceXpress a aguardar PDF...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    let pdfUrl = null;
    try {
      const pdfRes = await axios.get(
        'https://' + account + '.app.invoicexpress.com/api/pdf/' + invoice.id + '.json?api_key=' + apiKey
      );
      pdfUrl = pdfRes.data && pdfRes.data.output && pdfRes.data.output.pdfUrl;
      console.log('InvoiceXpress PDF:', pdfUrl ? 'gerado com sucesso' : 'pendente');
    } catch (pdfErr) {
      console.error('InvoiceXpress erro PDF:', pdfErr.message);
    }

    // Buscar numero de fatura actualizado (após finalização)
    let invoiceNumber = invoice.sequence_number;
    try {
      const updatedRes = await axios.get(
        'https://' + account + '.app.invoicexpress.com/invoices/' + invoice.id + '.json?api_key=' + apiKey
      );
      const updated = updatedRes.data && updatedRes.data.invoice;
      if (updated) {
        invoiceNumber = updated.sequence_number || updated.id;
        console.log('InvoiceXpress numero fatura:', invoiceNumber, 'estado:', updated.status);
      }
    } catch(e) { console.warn('InvoiceXpress nao conseguiu obter numero final'); }

    return { invoiceNumber, url: pdfUrl };

  } catch (err) {
    const errDetail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('InvoiceXpress error detalhe:', errDetail);
    console.error('InvoiceXpress stack:', err.stack ? err.stack.split('\n')[0] : 'n/a');
    return null;
  }
}

async function sendConfirmationEmail({ to, name, serviceName, date, time, amountEur, meetLink, invoiceUrl, invoiceNum }) {
  const invoiceLine = invoiceUrl
    ? '<p style="margin:8px 0;font-size:14px">🧾 <strong>Fatura:</strong>' + (invoiceNum && invoiceNum !== 'rascunho' ? ' ' + invoiceNum + ' —' : '') + ' <a href="' + invoiceUrl + '" style="color:#0d7377;font-weight:600">Descarregar PDF</a></p>'
    : '';
  const meetLine = meetLink
    ? '<div style="background:linear-gradient(135deg,#0b1d35,#0d3b4f);border-radius:10px;padding:16px 20px;margin:16px 0">'
      + '<p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#17c4a8;letter-spacing:.3px">🎥 LINK DA VIDEOCONSULTA</p>'
      + '<p style="margin:0 0 12px;font-size:12.5px;color:rgba(255,255,255,.6)">Clique no botão abaixo no dia e hora marcados para entrar na consulta:</p>'
      + '<a href="' + meetLink + '" style="display:inline-block;background:#17c4a8;color:#0b1d35;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:700">Entrar na Videoconsulta →</a>'
      + '<p style="margin:10px 0 0;font-size:11px;color:rgba(255,255,255,.35)">Ou copie o link: ' + meetLink + '</p>'
      + '</div>'
    : '';

  const html = '<html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">'
    + '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">'
    + '<div style="background:#0b1d35;padding:20px 28px"><span style="font-size:20px;font-weight:700;color:#fff">Consultas<span style="color:#17c4a8">Online</span></span></div>'
    + '<div style="padding:24px 28px">'
    + '<h2 style="color:#0b1d35;margin:0 0 12px">Consulta Confirmada! ✅</h2>'
    + '<p style="color:#4a5568;margin:0 0 16px">Ola <strong>' + name + '</strong>, o seu agendamento foi confirmado.</p>'
    + '<div style="background:#f4f7fb;border-radius:10px;padding:16px;margin-bottom:16px">'
    + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Servico: <strong>' + serviceName + '</strong></p>'
    + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Data: <strong>' + date + '</strong></p>'
    + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Hora: <strong>' + time + '</strong> <span style="font-size:12px;color:#d97706;font-weight:600">⚠️ fuso horário PT Continente</span></p>'
    + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Valor pago: <strong>' + amountEur + '</strong></p>'
    + invoiceLine
    + '</div>'
    + meetLine
    + '<div style="background:#f4f7fb;border-radius:10px;padding:16px;margin-bottom:16px">'
    + '</div>'
    + '<p style="font-size:12px;color:#8a9bb0">Duvidas? geral@consultas-online.pt</p>'
    + '</div></div></body></html>';

  await sgMail.send({
    to,
    from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
    subject: 'Consulta confirmada - ' + serviceName + ' | ' + date + ' as ' + time,
    html,
    text: 'Ola ' + name + ',\n\nConsulta confirmada!\nServico: ' + serviceName + '\nData: ' + date + '\nHora: ' + time + '\nValor: ' + amountEur,
  });
}

// ─────────────────────────────────────────────
// ROTA: Formulário de Contacto
// POST /contact
// ─────────────────────────────────────────────
app.post('/lead-magnet', async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email em falta' });
  try {
    await sgMail.send({
      to: email,
      from: process.env.FROM_EMAIL,
      subject: 'O seu Guia de Primeiros Socorros — ConsultasOnline',
      html: '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">'
          + '<div style="background:#0b1d35;padding:32px;text-align:center;border-radius:12px 12px 0 0">'
          + '<h1 style="color:#fff;font-size:22px;margin:0">🚑 O seu guia chegou!</h1>'
          + '<p style="color:rgba(255,255,255,.6);margin:8px 0 0">Guia de Primeiros Socorros — ConsultasOnline</p>'
          + '</div>'
          + '<div style="background:#f4f7fb;padding:32px;border-radius:0 0 12px 12px">'
          + '<p style="font-size:15px;line-height:1.7">Ola ' + (name || '') + ',</p>'
          + '<p style="font-size:15px;line-height:1.7;margin-top:8px">Obrigado pelo seu interesse! O seu guia gratuito esta disponivel no link abaixo.</p>'
          + '<div style="text-align:center;margin:24px 0">'
          + '<a href="https://www.consultas-online.pt/guia-primeiros-socorros.pdf" style="background:#0d7377;color:#fff;padding:14px 32px;border-radius:9px;text-decoration:none;font-weight:600;font-size:15px">Descarregar Guia PDF →</a>'
          + '</div>'
          + '<p style="font-size:13px;color:#8a9bb0;line-height:1.7">Se precisar de consulta medica online — baixa medica, atestados ou renovacao de receitas — estamos disponiveis em <a href="https://www.consultas-online.pt" style="color:#0d7377">consultas-online.pt</a>.</p>'
          + '</div></div>'
    });
    await sgMail.send({
      to: process.env.NOTIFY_EMAIL,
      from: process.env.FROM_EMAIL,
      subject: 'Novo lead — Guia Primeiros Socorros',
      text: 'Nome: ' + (name || 'N/A') + '\nEmail: ' + email
    });
    res.json({ ok: true });
  } catch(err) {
    console.error('Lead magnet error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/contact', async (req, res) => {
  const { name, email, subject, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Por favor preencha todos os campos obrigatorios.' });
  }

  try {
    // Email para a equipa ConsultasOnline
    await sgMail.send({
      to: process.env.CONTACT_EMAIL || 'geral@consultas-online.pt',
      from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline — Formulario' },
      replyTo: { email, name },
      subject: '[Contacto] ' + (subject || 'Nova mensagem') + ' — ' + name,
      html: '<html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">'
        + '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'
        + '<div style="background:#0b1d35;padding:18px 24px"><span style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#fff">Consultas<span style="color:#17c4a8">Online</span></span>'
        + '&nbsp;&nbsp;<span style="background:rgba(255,255,255,.1);color:rgba(255,255,255,.8);font-size:11px;padding:3px 10px;border-radius:12px">Nova Mensagem</span></div>'
        + '<div style="padding:22px 24px">'
        + '<table style="width:100%;border-collapse:collapse;font-size:14px">'
        + '<tr><td style="padding:8px 0;color:#8a9bb0;font-weight:600;width:100px">Nome</td><td style="padding:8px 0;color:#0b1d35">' + name + '</td></tr>'
        + '<tr><td style="padding:8px 0;color:#8a9bb0;font-weight:600">Email</td><td style="padding:8px 0"><a href="mailto:' + email + '" style="color:#0d7377">' + email + '</a></td></tr>'
        + '<tr><td style="padding:8px 0;color:#8a9bb0;font-weight:600">Assunto</td><td style="padding:8px 0;color:#0b1d35">' + (subject || '—') + '</td></tr>'
        + '</table>'
        + '<div style="background:#f4f7fb;border-radius:10px;padding:16px;margin-top:16px">'
        + '<p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#8a9bb0;letter-spacing:.5px;text-transform:uppercase">Mensagem</p>'
        + '<p style="margin:0;font-size:14px;color:#334155;line-height:1.7">' + message.replace(/\n/g, '<br/>') + '</p>'
        + '</div>'
        + '<p style="margin-top:16px;font-size:12px;color:#8a9bb0">Respondido diretamente para: ' + email + '</p>'
        + '</div></div></body></html>',
      text: 'Nova mensagem de contacto\n\nNome: ' + name + '\nEmail: ' + email + '\nAssunto: ' + (subject || '—') + '\n\nMensagem:\n' + message,
    });

    // Email de confirmação para o utilizador
    await sgMail.send({
      to: email,
      from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
      subject: 'Recebemos a sua mensagem — ConsultasOnline',
      html: '<html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">'
        + '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'
        + '<div style="background:#0b1d35;padding:18px 24px"><span style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#fff">Consultas<span style="color:#17c4a8">Online</span></span></div>'
        + '<div style="padding:22px 24px">'
        + '<h2 style="color:#0b1d35;margin:0 0 12px;font-family:Georgia,serif">Mensagem recebida! ✅</h2>'
        + '<p style="color:#4a5568;font-size:14px;line-height:1.7">Ola <strong>' + name + '</strong>,<br/><br/>Recebemos a sua mensagem e responderemos em ate 24 horas uteis para <strong>' + email + '</strong>.</p>'
        + '<div style="background:#f4f7fb;border-radius:10px;padding:14px;margin:16px 0;font-size:13px;color:#64748b"><strong>Assunto:</strong> ' + (subject || '—') + '</div>'
        + '<p style="font-size:12px;color:#8a9bb0;margin-top:16px">Se tiver urgencia, envie email diretamente para <a href="mailto:geral@consultas-online.pt" style="color:#0d7377">geral@consultas-online.pt</a></p>'
        + '</div></div></body></html>',
      text: 'Ola ' + name + ',\n\nRecebemos a sua mensagem. Responderemos em ate 24 horas uteis.\n\nConsultasOnline\ngeral@consultas-online.pt',
    });

    console.log('Formulario de contacto recebido de:', email);
    res.json({ success: true });

  } catch (err) {
    console.error('Erro ao enviar email de contacto:', err.message);
    res.status(500).json({ error: 'Erro ao enviar mensagem. Tente novamente ou contacte-nos diretamente.' });
  }
});

// ─────────────────────────────────────────────
// ROTAS DE REGISTOS CLÍNICOS (protegidas)
// ─────────────────────────────────────────────

// Rota de login admin — valida password no servidor
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  const correct = process.env.ADMIN_SECRET;
  if (!password || !correct || password !== correct) {
    return res.status(401).json({ ok: false, error: 'Password incorreta.' });
  }
  // Devolve um token simples (hash da password + salt fixo)
  const token = Buffer.from(correct + ':consultas-admin-salt').toString('base64');
  res.json({ ok: true, token });
});
// Rota para obter slots disponíveis e bloqueados
app.get('/slots', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Data em falta' });
  try {
    const booked = await BookedSlot.find({ dateKey: date });
    res.json({ booked });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
// Bloquear slot
app.post('/admin/block-slot', async (req, res) => {
  const { secret, dateKey, time, reason } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const existing = await BookedSlot.findOne({ dateKey, time });
    if (existing) return res.status(400).json({ error: 'Slot ja ocupado' });
    await BookedSlot.create({
      dateKey,
      time,
      blocked: true,
      blockedReason: reason || 'Bloqueado',
      serviceId: 'blocked',
      serviceName: 'Bloqueado',
      customerEmail: '',
      stripeSession: '',
    });
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Desbloquear slot
app.post('/admin/unblock-slot', async (req, res) => {
  const { secret, dateKey, time } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    await BookedSlot.deleteOne({ dateKey, time, blocked: true });
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Middleware de autenticação admin
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  const correct = process.env.ADMIN_SECRET;
  // Aceita password directa OU token
  const token = correct ? Buffer.from(correct + ':consultas-admin-salt').toString('base64') : null;
  if (!key || (key !== correct && key !== token)) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  next();
}

// Listar todos os utentes
app.get('/admin/utentes', adminAuth, async (req, res) => {
  if (!MONGO_URI) return res.json([]);
  try {
    const utentes = await Utente.find({}, '-__v').sort({ atualizado: -1 });
    res.json(utentes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter utente específico
app.get('/admin/utentes/:id', adminAuth, async (req, res) => {
  if (!MONGO_URI) return res.json(null);
  try {
    const utente = await Utente.findById(req.params.id);
    if (!utente) return res.status(404).json({ error: 'Não encontrado.' });
    res.json(utente);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar notas clínicas do utente
app.put('/admin/utentes/:id', adminAuth, async (req, res) => {
  if (!MONGO_URI) return res.json({ ok: false });
  try {
    const { notas, dataNascimento, morada, telefone, numeroUtente } = req.body;
    const utente = await Utente.findByIdAndUpdate(
      req.params.id,
      { $set: { notas, dataNascimento, morada, telefone, numeroUtente, atualizado: new Date() } },
      { new: true }
    );
    res.json(utente);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pesquisar utentes
app.get('/admin/utentes-search', adminAuth, async (req, res) => {
  if (!MONGO_URI) return res.json([]);
  try {
    const q = req.query.q || '';
    const utentes = await Utente.find({
      $or: [
        { nomeCompleto: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
        { numeroUtente: { $regex: q, $options: 'i' } },
      ]
    }, '-__v').limit(20);
    res.json(utentes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});




// ─────────────────────────────────────────────
// ATESTADOS — Gerar PDF com PDFKit e Enviar
// ─────────────────────────────────────────────
const fs = require('fs');
const pathMod = require('path');

// Load signature once at startup
let sigBuffer = null;
try {
  const sigPath = pathMod.join(__dirname, 'assinatura_b64.txt');
  if (fs.existsSync(sigPath)) {
    const b64 = fs.readFileSync(sigPath, 'utf8').trim();
    sigBuffer = Buffer.from(b64, 'base64');
    console.log('Assinatura carregada:', sigBuffer.length, 'bytes');
  } else {
    console.warn('assinatura_b64.txt nao encontrado');
  }
} catch(e) { console.error('Erro ao carregar assinatura:', e.message); }

function meses(n) {
  const m = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const i = parseInt(n) - 1;
  return (i >= 0 && i < 12) ? m[i] : n;
}

function dataPT(d) {
  try {
    const p = d.split('/');
    return parseInt(p[0]) + ' de ' + meses(p[1]) + ' de ' + p[2];
  } catch(e) { return d; }
}

function gerarPDF(tipo, dados) {
  return new Promise((resolve, reject) => {
    try {
      let PDFDocument;
      try { PDFDocument = require('pdfkit'); }
      catch(e) { return reject(new Error('pdfkit nao instalado. Verifique package.json e redeploy.')); }
      const doc = new PDFDocument({ size: 'A4', margin: 70 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const w = doc.page.width;
      const margin = 70;
      const textW = w - margin * 2;

      // Top border
      doc.moveTo(margin, 60).lineTo(w - margin, 60).lineWidth(3).strokeColor('#0b1d35').stroke();

      // Title
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#0b1d35')
         .text('ATESTADO MEDICO', margin, 75, { align: 'center', width: textW });

      // Teal line under title
      doc.moveTo(margin + 80, 102).lineTo(w - margin - 80, 102).lineWidth(1).strokeColor('#0d7377').stroke();

      // Body
      doc.fontSize(11).font('Helvetica').fillColor('#000000');
      let y = 118;

      const writeJ = (text, opts = {}) => {
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
           .fontSize(11).fillColor('#000000')
           .text(text, margin, y, { width: textW, align: 'justify', lineGap: 2 });
        y = doc.y + (opts.after || 4);
      };

      const writeName = (name) => {
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b1d35')
           .text(name || '', margin, y, { width: textW });
        y = doc.y + 2;
        doc.moveTo(margin, y).lineTo(w - margin, y).lineWidth(0.5).strokeColor('#94a3b8').stroke();
        y += 8;
      };

      writeJ('Eu, Dra. Patricia Mendonca Ferraz, medica inscrita na Ordem dos Medicos com a cedula profissional n. 57713, atesto que:', { after: 10 });

      if (tipo === 'amamentacao') {
        writeJ('A utente', { after: 4 });
        writeName(dados.nome_utente);
        writeJ('nascida em ' + (dados.data_nasc_utente||'') + ', portadora do Cartao de Cidadao n. ' + (dados.cc_utente||'') + ', encontra-se atualmente em periodo de amamentacao do(a) seu(sua) filho(a)', { after: 4 });
        writeName(dados.nome_filho);
        writeJ('nascido(a) em ' + (dados.data_nasc_filho||'') + '.', { after: 16 });
        writeJ('Este atestado e passado a pedido da interessada para os devidos efeitos legais.', { after: 4 });
      } else {
        writeJ('O(a) utente', { after: 4 });
        writeName(dados.nome_utente);
        writeJ('nascido(a) em ' + (dados.data_nasc_utente||'') + ', portador(a) do Cartao de Cidadao n. ' + (dados.cc_utente||'') + ', necessita de afastamento das atividades escolares no periodo compreendido entre ' + (dados.data_inicio||'') + ' e ' + (dados.data_fim||'') + ' por motivos de doenca.', { after: 16 });
        writeJ('Este atestado e passado a pedido do(a) interessado(a) para os devidos efeitos legais.', { after: 4 });
      }

      // Date
      y += 16;
      const dataFmt = dados.data_consulta ? dataPT(dados.data_consulta) : '';
      doc.font('Helvetica').fontSize(11).fillColor('#000000').text('Viseu, ' + dataFmt, margin, y);
      y = doc.y + 28;

      // Signature line
      doc.moveTo(margin, y).lineTo(margin + 255, y).lineWidth(0.8).strokeColor('#0b1d35').stroke();

      // Signature image above line
      if (sigBuffer) {
        try {
          const sigH = 45;
          const sigW = sigH * (2033/530);
          doc.image(sigBuffer, margin, y - sigH, { width: sigW, height: sigH });
        } catch(imgErr) { console.warn('Sig image error:', imgErr.message); }
      }

      y += 12;
      doc.font('Helvetica').fontSize(9).fillColor('#64748b')
         .text('Dra. Patricia Mendonca Ferraz  |  Cedula n. 57713', margin, y);

      // Footer
      const pageH = doc.page.height;
      doc.moveTo(margin, pageH - 52).lineTo(w - margin, pageH - 52).lineWidth(1.5).strokeColor('#0b1d35').stroke();
      doc.fontSize(8).fillColor('#94a3b8')
         .text('ConsultasOnline  |  www.consultas-online.pt  |  geral@consultas-online.pt', margin, pageH - 38, { align: 'center', width: textW });

      doc.end();
    } catch(err) { reject(err); }
  });
}

app.post('/admin/gerar-atestado', adminAuth, async (req, res) => {
  const { tipo, dados, enviarEmail } = req.body;
  if (!tipo || !dados) return res.status(400).json({ error: 'Tipo e dados obrigatorios.' });

  try {
    const pdfBuffer = await gerarPDF(tipo, dados);
    const pdfB64 = pdfBuffer.toString('base64');

    if (enviarEmail && dados.email) {
      const nomeDoc = tipo === 'amamentacao' ? 'Atestado de Amamentacao' : 'Atestado de Doenca';
      await sgMail.send({
        to: dados.email,
        from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
        subject: nomeDoc + ' — ConsultasOnline',
        html: '<html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">'
          + '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'
          + '<div style="background:#0b1d35;padding:18px 24px"><span style="font-size:18px;font-weight:700;color:#fff">Consultas<span style="color:#17c4a8">Online</span></span></div>'
          + '<div style="padding:22px 24px">'
          + '<h2 style="color:#0b1d35;margin:0 0 12px">Documento em anexo</h2>'
          + '<p style="color:#4a5568;font-size:14px;line-height:1.7">Ola <strong>' + (dados.nome_utente||'') + '</strong>,</p>'
          + '<p style="color:#4a5568;font-size:14px;line-height:1.7">Segue em anexo o seu ' + nomeDoc.toLowerCase() + ' emitido pela Dra. Patricia Mendonca Ferraz.</p>'
          + '<p style="color:#4a5568;font-size:14px;line-height:1.7">O documento tem validade legal e pode ser utilizado para os devidos efeitos.</p>'
          + '<p style="font-size:12px;color:#8a9bb0;margin-top:16px">Duvidas? <a href="mailto:geral@consultas-online.pt" style="color:#0d7377">geral@consultas-online.pt</a></p>'
          + '</div></div></body></html>',
        text: 'Ola ' + (dados.nome_utente||'') + ',\n\nSegue em anexo o seu ' + nomeDoc + '.\n\nConsultasOnline',
        attachments: [{
          content: pdfB64,
          filename: nomeDoc.replace(/ /g,'_') + '.pdf',
          type: 'application/pdf',
          disposition: 'attachment',
        }],
      });
      console.log('Atestado enviado para:', dados.email);
    }

    res.json({ pdf: pdfB64, sent: !!(enviarEmail && dados.email) });
  } catch(err) {
    console.error('Erro ao gerar atestado:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Guardar nota clínica de uma consulta específica
app.put('/admin/utentes/:id/consulta/:idx', adminAuth, async (req, res) => {
  if (!MONGO_URI) return res.json({ ok: false });
  try {
    const { notaClinica } = req.body;
    const idx = parseInt(req.params.idx);
    const utente = await Utente.findById(req.params.id);
    if (!utente) return res.status(404).json({ error: 'Utente nao encontrado.' });
    if (utente.consultas[idx] === undefined) return res.status(404).json({ error: 'Consulta nao encontrada.' });
    utente.consultas[idx].notaClinica = notaClinica;
    utente.markModified('consultas');
    await utente.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('ConsultasOnline - Server Running - porta ' + PORT);
});
