require('dotenv').config();
const express  = require('express');
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

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  next();
});
const SERVICES = {
  'atestado-amamentacao':       { name: 'Atestado de Amamentação',          price: 3500 },
  'atestado-escola':            { name: 'Atestado para Falta Escolar',       price: 3500 },
  'atestado-conducao':          { name: 'Atestado para Carta de Condução',   price: 4500 },
  'baixa-medica':               { name: 'Emissão de Baixa Médica',           price: 5500 },
  'renovacao-medicamentos':     { name: 'Renovação de Medicamentos',         price: 4000 },
  'renovacao-piula':            { name: 'Renovação de Pílula Anticoncecional', price: 4000 },
  'consulta-infecao-urinaria':  { name: 'Consulta de Infeção Urinária',      price: 4000 },
  'consulta-cessacao-tabagica': { name: 'Consulta de Cessação Tabágica',     price: 4000 },
  'consulta-amigdalite':        { name: 'Consulta de Amigdalite',            price: 4000 },
  'consulta-dst':               { name: 'Consulta DST / IST',                price: 4000 },
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
    description: 'Como funciona o CIT em Portugal, prazos e como renovar a baixa médica online sem sair de casa. Consulta a partir de 55€.',
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
    title: 'Atestado Médico para Carta de Condução Online | ConsultasOnline',
    description: 'Atestado de aptidão médica para carta de condução por videoconsulta. Válido no IMT. Emitido no próprio dia. 45€.',
    category: 'Carta de Condução',
    keywords: 'atestado carta de condução online, exame médico carta de condução online portugal, atestado IMT online',
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
  'renovar-pilula-anticoncecional-online': {
    id: 'piula-online',
    title: 'Renovar a Pílula Anticoncecional Online em Portugal | ConsultasOnline',
    description: 'Saiba como renovar a receita da pílula por videoconsulta em Portugal. Legal, seguro, sem médico de família. Receita Sem Papel no próprio dia. 40€.',
    category: 'Saúde da Mulher',
    keywords: 'renovar pílula anticoncecional online, receita pílula online portugal, pílula sem médico de família, videoconsulta pílula portugal',
  },
  'sem-medico-de-familia-portugal': {
    id: 'sem-medico-familia',
    title: 'Não Tem Médico de Família? O Que Fazer em Portugal | ConsultasOnline',
    description: 'Mais de 1,5 milhões de portugueses sem médico de família. Conheça as alternativas legais para aceder a cuidados de saúde sem esperar anos.',
    category: 'SNS & Direitos',
    keywords: 'sem médico de família portugal, alternativas médico de família, lista espera médico família, médico online sem médico família',
  },
  'cistite-mulher-sintomas-tratamento': {
    id: 'cistite-mulher',
    title: 'Cistite na Mulher: Sintomas, Tratamento e Como Tratar Online | ConsultasOnline',
    description: 'Tudo sobre cistite na mulher: sintomas, antibiótico adequado e quando pode tratar por videoconsulta. Consulta online disponível hoje. 40€.',
    category: 'Saúde da Mulher',
    keywords: 'cistite mulher sintomas tratamento, cistite online portugal, infeção urinária mulher antibiótico, cistite videoconsulta',
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
      locale: 'pt',
      billing_address_collection: 'auto',
      payment_intent_data: {
        description: service.name + ' - ' + date + ' as ' + time,
        receipt_email: customerEmail,
      },
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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
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

// ─────────────────────────────────────────────
// ROTA: Ebook Lead
// POST /lead-ebook
// ─────────────────────────────────────────────
app.post('/lead-ebook', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ ok: false, error: 'Nome e email obrigatórios.' });

  const ebookUrl = (process.env.CLIENT_URL || 'https://www.consultas-online.pt') + '/ebook_saude_em_dia.pdf';

  // 1. Guardar lead no MongoDB
  if (MONGO_URI) {
    try {
      await Lead.findOneAndUpdate(
        { email },
        { nome: name, email, fonte: 'ebook-saude-em-dia', criadoEm: new Date() },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.warn('Erro ao guardar lead:', err.message);
    }
  }

  // 2. Enviar ebook à lead
  try {
    await sgMail.send({
      to: email,
      from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
      subject: '🌿 O teu guia gratuito: A Tua Saúde em Dia',
      html: `
        <html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
          <div style="background:#0b1d35;padding:20px 28px">
            <span style="font-size:20px;font-weight:700;color:#fff">Consultas<span style="color:#17c4a8">Online</span></span>
          </div>
          <div style="padding:28px">
            <h2 style="color:#0b1d35;margin:0 0 8px">Olá, ${name}! 🌿</h2>
            <p style="color:#4a5568;margin:0 0 20px;line-height:1.6">O teu guia <strong>A Tua Saúde em Dia</strong> está pronto. Clica no botão abaixo para descarregar.</p>
            <a href="${ebookUrl}" style="display:inline-block;background:linear-gradient(135deg,#0d7377,#17c4a8);color:#fff;text-decoration:none;border-radius:10px;padding:14px 28px;font-weight:700;font-size:15px;margin-bottom:24px">
              📥 Descarregar o Guia Gratuito
            </a>
            <div style="background:#f4f7fb;border-radius:10px;padding:16px;margin-bottom:20px">
              <p style="margin:0 0 8px;font-size:13px;color:#0b1d35;font-weight:600">O que encontras no guia:</p>
              <ul style="margin:0;padding-left:18px;font-size:13px;color:#4a5568;line-height:1.8">
                <li>Checklist de exames para todas as idades</li>
                <li>Rastreios por faixa etária (20-30, 30-40, 40-50, 50+)</li>
                <li>Sinais de alerta que não deves ignorar</li>
                <li>Calendário de vacinação do adulto</li>
                <li>20 referências bibliográficas (DGS, WHO, SPG)</li>
              </ul>
            </div>
            <p style="font-size:13px;color:#4a5568;line-height:1.6">Precisas de uma consulta médica online? Estamos disponíveis de segunda a domingo, das 9h às 21h.</p>
            <a href="${process.env.CLIENT_URL || 'https://www.consultas-online.pt'}" style="display:inline-block;border:1.5px solid #0d7377;color:#0d7377;text-decoration:none;border-radius:10px;padding:10px 20px;font-weight:600;font-size:13px">
              Ver Serviços →
            </a>
            <p style="font-size:11px;color:#8a9bb0;margin-top:24px">Dúvidas? geral@consultas-online.pt</p>
          </div>
        </div>
        </body></html>
      `,
      text: `Olá ${name},\n\nO teu guia está disponível em: ${ebookUrl}\n\nConsultasOnline — consultas-online.pt`,
    });
    console.log('Ebook enviado para:', email);
  } catch (err) {
    console.error('Erro ao enviar ebook:', err.message);
    return res.status(500).json({ ok: false, error: 'Erro ao enviar email.' });
  }

  // 3. Notificação interna
  try {
    await sgMail.send({
      to: process.env.CONTACT_EMAIL || 'geral@consultas-online.pt',
      from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
      subject: '🔔 Nova lead — Ebook Saúde em Dia',
      html: `
        <html><body style="font-family:Arial,sans-serif;padding:20px">
        <h3 style="color:#0b1d35">Nova lead gerada</h3>
        <p><strong>Nome:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Fonte:</strong> Ebook — A Tua Saúde em Dia</p>
        <p><strong>Data:</strong> ${new Date().toLocaleString('pt-PT')}</p>
        </body></html>
      `,
      text: `Nova lead\nNome: ${name}\nEmail: ${email}\nFonte: Ebook\nData: ${new Date().toLocaleString('pt-PT')}`,
    });
  } catch (err) {
    console.warn('Erro notificação interna:', err.message);
  }

  res.json({ ok: true });
});
// ─────────────────────────────────────────────
// ROTAS: Gestão de Slots (Admin)
// ─────────────────────────────────────────────

app.get('/slots', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Data em falta' });
  if (!MONGO_URI) return res.json({ booked: [] });
  try {
    const booked = await BookedSlot.find({ dateKey: date });
    res.json({ booked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/block-slot', async (req, res) => {
  const { secret, dateKey, time, reason } = req.body;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Não autorizado.' });
  }
  if (!MONGO_URI) return res.status(500).json({ error: 'MongoDB não configurado.' });
  try {
    const existing = await BookedSlot.findOne({ dateKey, time });
    if (existing) {
      if (existing.blocked) return res.json({ ok: true, already: true });
      return res.status(400).json({ error: 'Slot já ocupado por consulta.' });
    }
    await BookedSlot.create({
      dateKey, time,
      blocked: true,
      blockedReason: reason || 'Bloqueado pela clínica',
      serviceId: 'blocked',
      serviceName: 'Bloqueado',
      customerEmail: '',
      stripeSession: '',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/unblock-slot', async (req, res) => {
  const { secret, dateKey, time } = req.body;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Não autorizado.' });
  }
  if (!MONGO_URI) return res.status(500).json({ error: 'MongoDB não configurado.' });
  try {
    const result = await BookedSlot.deleteOne({ dateKey, time, blocked: true });
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─────────────────────────────────────────────
// ROTA: Lead Primeiros Socorros
// ─────────────────────────────────────────────
app.post('/lead-magnet', async (req, res) => {
  const { name, email } = req.body;
  if (!email) return res.status(400).json({ ok: false });

  const guiaUrl = (process.env.CLIENT_URL || 'https://www.consultas-online.pt') + '/guia-primeiros-socorros.pdf';

  if (MONGO_URI) {
    try {
      await Lead.findOneAndUpdate(
        { email },
        { nome: name, email, fonte: 'ebook-primeiros-socorros', criadoEm: new Date() },
        { upsert: true, new: true }
      );
    } catch (err) { console.warn('Erro lead magnet:', err.message); }
  }

  try {
    await sgMail.send({
      to: email,
      from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
      subject: '🚑 O teu Guia de Primeiros Socorros',
      html: `<html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
          <div style="background:#0b1d35;padding:20px 28px">
            <span style="font-size:20px;font-weight:700;color:#fff">Consultas<span style="color:#17c4a8">Online</span></span>
          </div>
          <div style="padding:28px">
            <h2 style="color:#0b1d35;margin:0 0 8px">Olá, ${name}! 🚑</h2>
            <p style="color:#4a5568;margin:0 0 20px;line-height:1.6">O teu <strong>Guia de Primeiros Socorros</strong> está pronto.</p>
            <a href="${guiaUrl}" style="display:inline-block;background:linear-gradient(135deg,#0d7377,#17c4a8);color:#fff;text-decoration:none;border-radius:10px;padding:14px 28px;font-weight:700;font-size:15px;margin-bottom:24px">
              📥 Descarregar o Guia Gratuito
            </a>
            <p style="font-size:11px;color:#8a9bb0;margin-top:24px">Dúvidas? geral@consultas-online.pt</p>
          </div>
        </div>
        </body></html>`,
      text: `Olá ${name},\n\nO teu guia está em: ${guiaUrl}\n\nConsultasOnline`,
    });
  } catch (err) {
    console.error('Erro email lead magnet:', err.message);
    return res.status(500).json({ ok: false });
  }

  try {
    await sgMail.send({
      to: process.env.CONTACT_EMAIL || 'geral@consultas-online.pt',
      from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
      subject: '🔔 Nova lead — Guia Primeiros Socorros',
      html: `<p><strong>Nome:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Fonte:</strong> Guia Primeiros Socorros</p><p><strong>Data:</strong> ${new Date().toLocaleString('pt-PT')}`,
      text: `Nova lead\nNome: ${name}\nEmail: ${email}\nFonte: Primeiros Socorros\nData: ${new Date().toLocaleString('pt-PT')}`,
    });
  } catch (err) { console.warn('Erro notificação lead magnet:', err.message); }

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// ROTA: Lead 7 Sintomas
// ─────────────────────────────────────────────
app.post('/lead-sintomas', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ ok: false });

  const ebookUrl = (process.env.CLIENT_URL || 'https://www.consultas-online.pt') + '/guia_7_sintomas.pdf';

  if (MONGO_URI) {
    try {
      await Lead.findOneAndUpdate(
        { email },
        { nome: name, email, fonte: 'ebook-7-sintomas', criadoEm: new Date() },
        { upsert: true, new: true }
      );
    } catch (err) { console.warn('Erro lead sintomas:', err.message); }
  }

  try {
    await sgMail.send({
      to: email,
      from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
      subject: '🌸 O teu guia: 7 Sintomas Femininos que Não Deves Ignorar',
      html: `<html><body style="font-family:Arial,sans-serif;background:#f4f7fb;padding:20px">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
          <div style="background:#0b1d35;padding:20px 28px">
            <span style="font-size:20px;font-weight:700;color:#fff">Consultas<span style="color:#17c4a8">Online</span></span>
          </div>
          <div style="padding:28px">
            <h2 style="color:#0b1d35;margin:0 0 8px">Olá, ${name}! 🌸</h2>
            <p style="color:#4a5568;margin:0 0 20px;line-height:1.6">O teu guia <strong>7 Sintomas Femininos que Não Deves Ignorar</strong> está pronto.</p>
            <a href="${ebookUrl}" style="display:inline-block;background:linear-gradient(135deg,#c4907a,#d4a08a);color:#fff;text-decoration:none;border-radius:10px;padding:14px 28px;font-weight:700;font-size:15px;margin-bottom:24px">
              📥 Descarregar o Guia Gratuito
            </a>
            <div style="background:#f4f7fb;border-radius:10px;padding:16px;margin-bottom:20px">
              <p style="margin:0 0 8px;font-size:13px;color:#0b1d35;font-weight:600">O que encontras no guia:</p>
              <ul style="margin:0;padding-left:18px;font-size:13px;color:#4a5568;line-height:1.8">
                <li>7 sintomas explicados com causas possíveis</li>
                <li>Quando agir — urgência, urgente ou importante</li>
                <li>Sinais de alerta que nunca deves ignorar</li>
                <li>18 referências bibliográficas</li>
              </ul>
            </div>
            <p style="font-size:11px;color:#8a9bb0;margin-top:24px">Dúvidas? geral@consultas-online.pt</p>
          </div>
        </div>
        </body></html>`,
      text: `Olá ${name},\n\nO teu guia está em: ${ebookUrl}\n\nConsultasOnline`,
    });
  } catch (err) {
    console.error('Erro email sintomas:', err.message);
    return res.status(500).json({ ok: false });
  }

  try {
    await sgMail.send({
      to: process.env.CONTACT_EMAIL || 'geral@consultas-online.pt',
      from: { email: process.env.FROM_EMAIL || 'geral@consultas-online.pt', name: 'ConsultasOnline' },
      subject: '🔔 Nova lead — 7 Sintomas Femininos',
      html: `<html><body style="font-family:Arial,sans-serif;padding:20px">
        <h3 style="color:#0b1d35">Nova lead gerada</h3>
        <p><strong>Nome:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Fonte:</strong> Ebook 7 Sintomas Femininos</p>
        <p><strong>Data:</strong> ${new Date().toLocaleString('pt-PT')}</p>
        </body></html>`,
      text: `Nova lead\nNome: ${name}\nEmail: ${email}\nFonte: 7 Sintomas\nData: ${new Date().toLocaleString('pt-PT')}`,
    });
  } catch (err) { console.warn('Erro notificação sintomas:', err.message); }

  res.json({ ok: true });
});
// ─────────────────────────────────────────────
// PÁGINAS DE SERVIÇO — SSR com meta tags próprias
// ─────────────────────────────────────────────

function servicePageHTML(opts) {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${opts.title}</title>
<meta name="description" content="${opts.desc}"/>
<meta name="robots" content="index, follow"/>
<link rel="canonical" href="https://www.consultas-online.pt${opts.path}"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${opts.title}"/>
<meta property="og:description" content="${opts.desc}"/>
<meta property="og:url" content="https://www.consultas-online.pt${opts.path}"/>
<meta property="og:locale" content="pt_PT"/>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MedicalWebPage",
  "name": "${opts.h1}",
  "description": "${opts.desc}",
  "url": "https://www.consultas-online.pt${opts.path}",
  "provider": {
    "@type": "MedicalBusiness",
    "name": "ConsultasOnline",
    "url": "https://www.consultas-online.pt"
  },
  "offers": {
    "@type": "Offer",
    "price": "${opts.price}",
    "priceCurrency": "EUR"
  }
}
</script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;color:#0b1d35;background:#fff}
  .hero{background:#0b1d35;padding:80px 20px 60px;text-align:center}
  .hero h1{font-size:clamp(28px,4vw,48px);color:#fff;line-height:1.2;margin-bottom:16px;font-family:Georgia,serif}
  .hero p{font-size:17px;color:rgba(255,255,255,.65);max-width:560px;margin:0 auto 28px;line-height:1.7}
  .hero .price{font-size:42px;font-weight:700;color:#17c4a8;margin-bottom:24px;font-family:Georgia,serif}
  .btn{display:inline-block;background:linear-gradient(135deg,#0d7377,#17c4a8);color:#fff;text-decoration:none;padding:16px 36px;border-radius:10px;font-size:16px;font-weight:700;transition:.2s}
  .btn:hover{opacity:.9;transform:translateY(-2px)}
  .body{max-width:800px;margin:0 auto;padding:56px 24px}
  .body h2{font-size:28px;font-family:Georgia,serif;color:#0b1d35;margin:36px 0 14px}
  .body h3{font-size:20px;font-family:Georgia,serif;color:#0b1d35;margin:24px 0 10px}
  .body p{font-size:15px;color:#334155;line-height:1.85;margin-bottom:14px}
  .body ul{margin:12px 0 18px 22px}
  .body li{font-size:15px;color:#334155;line-height:1.7;margin-bottom:8px}
  .box{background:#f4f7fb;border-left:4px solid #0d7377;border-radius:0 10px 10px 0;padding:16px 20px;margin:20px 0}
  .box p{margin:0;font-size:14px;color:#334155}
  .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;margin:28px 0}
  .step{background:#fff;border:1px solid #dde6f0;border-radius:14px;padding:20px;text-align:center}
  .step .num{font-size:28px;font-weight:700;color:#0d7377;font-family:Georgia,serif;margin-bottom:8px}
  .step p{font-size:13px;color:#4a5568;margin:0}
  .cta-box{background:linear-gradient(135deg,#0b1d35,#1a3a5c);border-radius:16px;padding:36px;text-align:center;margin:40px 0}
  .cta-box h3{font-size:26px;font-family:Georgia,serif;color:#fff;margin-bottom:10px}
  .cta-box p{font-size:14px;color:rgba(255,255,255,.6);margin-bottom:20px}
  .faq{margin:36px 0}
  .faq-item{border:1px solid #dde6f0;border-radius:10px;margin-bottom:10px;padding:16px 20px}
  .faq-item h4{font-size:15px;font-weight:600;color:#0b1d35;margin-bottom:8px}
  .faq-item p{font-size:14px;color:#4a5568;line-height:1.65;margin:0}
  nav{background:#0b1d35;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:100}
  nav a{color:#fff;text-decoration:none;font-size:18px;font-weight:700}
  nav a span{color:#17c4a8}
  nav .nav-btn{background:#0d7377;color:#fff;text-decoration:none;padding:9px 20px;border-radius:8px;font-size:14px;font-weight:600}
  @media(max-width:600px){.steps{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<nav>
  <a href="/">Consultas<span>Online</span></a>
  <a class="nav-btn" href="/#marcar">Marcar Agora</a>
</nav>
${opts.body}
<script>
  // Redireciona para a SPA e abre o modal do serviço correcto
  document.querySelectorAll('a[href="/#marcar"]').forEach(function(el){
    el.addEventListener('click', function(e){
      e.preventDefault();
      window.location.href = '/?servico=${opts.serviceId}';
    });
  });
</script>
</body>
</html>`;
}

// Baixa Médica
app.get('/baixa-medica-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/baixa-medica-online',
    serviceId: 'baixa-medica',
    title: 'Baixa Médica Online em Portugal — CIT por Videoconsulta | ConsultasOnline',
    desc: 'Emita a sua baixa médica online por videoconsulta em Portugal. CIT submetido à Segurança Social no próprio dia. Sem filas, sem deslocação. A partir de 55€. MBWay aceite.',
    h1: 'Baixa Médica Online em Portugal',
    price: '55',
    body: `
<div class="hero">
  <h1>Baixa Médica Online<br/>em Portugal</h1>
  <p>CIT emitido por videoconsulta e submetido à Segurança Social no próprio dia. Sem filas, sem deslocação.</p>
  <div class="price">55€</div>
  <a class="btn" href="/#marcar">Marcar Consulta Agora →</a>
</div>
<div class="body">
  <h2>O que é a baixa médica online?</h2>
  <p>A baixa médica online, ou Certificado de Incapacidade Temporária (CIT), pode ser emitida por videoconsulta em Portugal ao abrigo da Portaria n.º 115/2021. O médico submete o CIT electronicamente à Segurança Social durante ou após a consulta — exactamente como numa consulta presencial.</p>
  <div class="box"><p>✅ <strong>Validade legal total.</strong> O CIT emitido por videoconsulta tem o mesmo valor legal que o emitido presencialmente.</p></div>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga online por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta no browser — sem instalar nada</p></div>
    <div class="step"><div class="num">03</div><p>CIT submetido à Segurança Social no próprio dia</p></div>
    <div class="step"><div class="num">04</div><p>Recebe o documento e fatura por email</p></div>
  </div>

  <h2>Quem pode pedir baixa médica online?</h2>
  <ul>
    <li>Trabalhadores por conta de outrem com número de utente SNS válido</li>
    <li>Trabalhadores independentes (freelancers) inscritos na Segurança Social</li>
    <li>Trabalhadores com ou sem médico de família atribuído</li>
  </ul>

  <h2>Quanto custa e o que está incluído</h2>
  <p>A consulta custa <strong>55€</strong> e inclui a videoconsulta, a emissão e submissão do CIT à Segurança Social e a fatura AT automática enviada por email. IVA isento ao abrigo do artigo 9.º do CIVA.</p>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>Posso fazer baixa médica online sem médico de família?</h4>
      <p>Sim. Qualquer médico registado na Ordem dos Médicos pode emitir o CIT — não é necessário ter médico de família atribuído.</p>
    </div>
    <div class="faq-item">
      <h4>A baixa médica online é enviada à Segurança Social automaticamente?</h4>
      <p>Sim. O médico submete o CIT electronicamente à Segurança Social durante a consulta. Não precisa de fazer nada adicionalmente.</p>
    </div>
    <div class="faq-item">
      <h4>Posso renovar a baixa médica por videoconsulta?</h4>
      <p>Sim. A renovação do CIT também pode ser feita por videoconsulta, nas mesmas condições da emissão inicial.</p>
    </div>
    <div class="faq-item">
      <h4>Quanto tempo demora a consulta?</h4>
      <p>A videoconsulta demora entre 15 a 30 minutos. O CIT é submetido à Segurança Social imediatamente após.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Precisa de baixa médica hoje?</h3>
    <p>Videoconsulta disponível de segunda a domingo, das 9h às 21h.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 55€ →</a>
  </div>
</div>`
  }));
});

// Atestado de Amamentação
app.get('/atestado-amamentacao-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/atestado-amamentacao-online',
    serviceId: 'atestado-amamentacao',
    title: 'Atestado de Amamentação Online — Emitido no Próprio Dia | ConsultasOnline',
    desc: 'Obtenha o atestado de amamentação por videoconsulta em Portugal. Documento com validade legal emitido e enviado por email no próprio dia. 35€. MBWay aceite.',
    h1: 'Atestado de Amamentação Online',
    price: '35',
    body: `
<div class="hero">
  <h1>Atestado de Amamentação<br/>Online</h1>
  <p>Documento com validade legal emitido por videoconsulta e enviado por email no próprio dia. Sem deslocação.</p>
  <div class="price">35€</div>
  <a class="btn" href="/#marcar">Obter Atestado Agora →</a>
</div>
<div class="body">
  <h2>Para que serve o atestado de amamentação?</h2>
  <p>O atestado de amamentação certifica que está a amamentar o seu filho, sendo indispensável para exercer os direitos laborais de dispensa de trabalho para aleitamento previstos no Código do Trabalho (artigo 47.º).</p>

  <h2>Direitos laborais com o atestado</h2>
  <ul>
    <li><strong>Até o filho completar 1 ano:</strong> dois períodos de 30 minutos ou 1 hora por dia</li>
    <li><strong>Do 1.º ao 2.º ano:</strong> um período de 30 minutos por dia</li>
    <li>Dispensa de trabalho nocturno e horas extraordinárias</li>
  </ul>

  <div class="box"><p>⚠️ <strong>Renovação:</strong> O atestado tem validade de 3 a 6 meses. A renovação pode ser feita por videoconsulta, sem deslocação.</p></div>

  <h2>Como obter o atestado online</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta rápida — cerca de 15 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Atestado emitido em PDF com validade legal</p></div>
    <div class="step"><div class="num">04</div><p>Documento enviado por email no próprio dia</p></div>
  </div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>O atestado de amamentação online tem validade legal?</h4>
      <p>Sim. O documento emitido por videoconsulta tem plena validade legal junto do empregador, tal como um atestado presencial.</p>
    </div>
    <div class="faq-item">
      <h4>Preciso de médico de família para obter o atestado?</h4>
      <p>Não. Qualquer médico registado na Ordem dos Médicos pode emitir o atestado. A consulta online funciona independentemente do SNS.</p>
    </div>
    <div class="faq-item">
      <h4>Com que frequência preciso de renovar?</h4>
      <p>O atestado tem validade de 3 a 6 meses consoante o que o médico indicar. A renovação pode ser feita por videoconsulta.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Precisa do atestado de amamentação hoje?</h3>
    <p>Emitido por videoconsulta e enviado por email no próprio dia.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 35€ →</a>
  </div>
</div>`
  }));
});

// Renovar Pílula Online
app.get('/renovar-pilula-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/renovar-pilula-online',
    serviceId: 'renovacao-piula',
    title: 'Renovar Pílula Anticoncecional Online em Portugal — Receita no Email | ConsultasOnline',
    desc: 'Renova a receita da pílula anticoncecional por videoconsulta em Portugal. Sem médico de família. Receita Sem Papel enviada por email no próprio dia. 40€. Legal e seguro.',
    h1: 'Renovar Pílula Anticoncecional Online',
    price: '40',
    body: `
<div class="hero">
  <h1>Renovar a Pílula<br/>Anticoncecional Online</h1>
  <p>Sem médico de família, sem filas. Receita Sem Papel enviada por email no próprio dia — válida em qualquer farmácia com comparticipação SNS.</p>
  <div class="price">40€</div>
  <a class="btn" href="/#marcar">Renovar a Pílula Agora →</a>
</div>
<div class="body">
  <h2>É legal renovar a pílula por videoconsulta em Portugal?</h2>
  <p>Sim. A prescrição por telemedicina está regulamentada em Portugal desde 2020. A médica emite a Receita Sem Papel directamente no sistema do SNS — válida em qualquer farmácia, com a comparticipação habitual do SNS aplicada automaticamente.</p>
  <div class="box"><p>✅ A receita tem o mesmo valor legal que uma receita de consulta presencial. A comparticipação do SNS é aplicada na farmácia normalmente.</p></div>

  <h2>Quem pode renovar a pílula online?</h2>
  <ul>
    <li>Mulheres adultas que já tomam a mesma pílula há 6 meses ou mais</li>
    <li>Sem médico de família atribuído</li>
    <li>Com médico de família mas sem disponibilidade para consulta presencial</li>
    <li>Tensão arterial normal, sem contraindicações conhecidas</li>
  </ul>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta de 10 a 15 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Receita Sem Papel emitida no sistema SNS</p></div>
    <div class="step"><div class="num">04</div><p>Receita enviada por email — válida em qualquer farmácia</p></div>
  </div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>Posso renovar a pílula sem médico de família?</h4>
      <p>Sim. A consulta online funciona de forma completamente independente do SNS. Não precisa de médico de família atribuído.</p>
    </div>
    <div class="faq-item">
      <h4>A receita tem comparticipação do SNS?</h4>
      <p>Sim. A Receita Sem Papel emitida por videoconsulta tem o mesmo valor legal que uma receita presencial. A comparticipação é aplicada automaticamente na farmácia.</p>
    </div>
    <div class="faq-item">
      <h4>Posso pedir receita para 6 meses de uma vez?</h4>
      <p>Sim. A médica pode emitir receita para até 6 embalagens numa só consulta.</p>
    </div>
    <div class="faq-item">
      <h4>É a primeira vez que vou tomar a pílula. Posso fazer online?</h4>
      <p>A primeira prescrição requer uma avaliação mais completa. Recomendamos consulta presencial para a primeira prescrição.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Renovar a pílula hoje, sem sair de casa</h3>
    <p>Receita no email no próprio dia. Disponível de segunda a domingo, das 9h às 21h.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 40€ →</a>
  </div>
</div>`
  }));
});

// Atestado Carta de Condução
app.get('/atestado-carta-conducao-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/atestado-carta-conducao-online',
    serviceId: 'atestado-conducao',
    title: 'Atestado Médico para Carta de Condução Online — Enviado ao IMT | ConsultasOnline',
    desc: 'Obtenha o atestado médico para carta de condução por videoconsulta. Documento enviado ao IMT no próprio dia. Válido para primeira carta, renovação e troca. 45€.',
    h1: 'Atestado para Carta de Condução Online',
    price: '45',
    body: `
<div class="hero">
  <h1>Atestado para Carta<br/>de Condução Online</h1>
  <p>Emitido por videoconsulta e enviado ao IMT no próprio dia. Válido para primeira carta, renovação e troca de carta estrangeira.</p>
  <div class="price">45€</div>
  <a class="btn" href="/#marcar">Obter Atestado Agora →</a>
</div>
<div class="body">
  <h2>O que é o atestado médico para carta de condução?</h2>
  <p>O atestado de aptidão médica para condução é obrigatório em Portugal para obtenção e renovação da licença de condução. Pode ser emitido por videoconsulta para a maioria dos condutores de categoria B sem patologias relevantes.</p>

  <h2>Quando é obrigatório renovar?</h2>
  <ul>
    <li><strong>Categoria B (uso pessoal):</strong> aos 60, 70 anos e depois de 2 em 2 anos</li>
    <li><strong>Categorias C e D (pesados):</strong> de 5 em 5 anos</li>
    <li><strong>Primeira carta:</strong> obrigatório em todas as categorias</li>
    <li><strong>Troca de carta estrangeira:</strong> obrigatório</li>
  </ul>

  <div class="box"><p>⚠️ <strong>Importante:</strong> Precisa de ter um exame de visão actualizado, realizado numa óptica ou oftalmologista, antes da videoconsulta.</p></div>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Faz exame de visão numa óptica antes da consulta</p></div>
    <div class="step"><div class="num">02</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">03</div><p>Videoconsulta de cerca de 20 minutos</p></div>
    <div class="step"><div class="num">04</div><p>Atestado enviado ao IMT e ao seu email no próprio dia</p></div>
  </div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>O atestado é enviado directamente ao IMT?</h4>
      <p>Sim. O médico envia o atestado electrónico directamente ao IMT no final da consulta. Recebe também uma cópia em PDF por email.</p>
    </div>
    <div class="faq-item">
      <h4>Serve para primeira carta, renovação e troca de carta estrangeira?</h4>
      <p>Sim. O mesmo atestado serve para qualquer situação: primeira carta, renovação, averbamento ou troca de carta estrangeira por portuguesa.</p>
    </div>
    <div class="faq-item">
      <h4>Tenho diabetes/epilepsia controlada. Posso fazer online?</h4>
      <p>Depende do caso. Algumas patologias requerem relatório do médico especialista assistente. A médica informa durante a consulta se é necessário.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Precisa do atestado para a carta de condução?</h3>
    <p>Emitido por videoconsulta e enviado ao IMT no próprio dia.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 45€ →</a>
  </div>
</div>`
  }));
});

// Consulta Infeção Urinária
app.get('/consulta-infecao-urinaria-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/consulta-infecao-urinaria-online',
    serviceId: 'consulta-infecao-urinaria',
    title: 'Consulta de Infeção Urinária Online em Portugal — Diagnóstico e Tratamento | ConsultasOnline',
    desc: 'Consulta de infeção urinária online por videoconsulta. Diagnóstico e antibiótico prescritos no próprio dia. Sem filas, sem deslocação. 40€. Exclusivo para mulheres adultas.',
    h1: 'Consulta de Infeção Urinária Online',
    price: '40',
    body: `
<div class="hero">
  <h1>Consulta de Infeção<br/>Urinária Online</h1>
  <p>Diagnóstico e tratamento por videoconsulta no próprio dia. Sem filas, sem urgências. Exclusivo para mulheres adultas.</p>
  <div class="price">40€</div>
  <a class="btn" href="/#marcar">Marcar Consulta Agora →</a>
</div>
<div class="body">
  <h2>Sintomas de infeção urinária</h2>
  <ul>
    <li>Ardor ou dor ao urinar</li>
    <li>Necessidade de urinar com frequência</li>
    <li>Urina turva ou com sangue</li>
    <li>Dor na zona inferior do abdómen</li>
  </ul>
  <div class="box"><p>⚠️ <strong>Quando ir às urgências:</strong> Febre superior a 38,5°C, dores lombares intensas ou vómitos requerem avaliação urgente presencial.</p></div>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta de 20 a 30 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Diagnóstico e prescrição de antibiótico se indicado</p></div>
    <div class="step"><div class="num">04</div><p>Receita enviada por email no próprio dia</p></div>
  </div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>Posso obter antibiótico por videoconsulta?</h4>
      <p>Sim. Se o diagnóstico de cistite não complicada for confirmado, a médica prescreve o antibiótico adequado. A Receita Sem Papel é enviada por email.</p>
    </div>
    <div class="faq-item">
      <h4>Este serviço é apenas para mulheres?</h4>
      <p>Sim. A consulta de infeção urinária online está disponível exclusivamente para mulheres adultas com cistite não complicada.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Com sintomas de infeção urinária?</h3>
    <p>Diagnóstico e tratamento em 30 minutos, sem sair de casa.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 40€ →</a>
  </div>
</div>`
  }));
});

// Consulta Acompanhamento Crónico
app.get('/consulta-acompanhamento-cronico-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/consulta-acompanhamento-cronico-online',
    serviceId: 'renovacao-medicamentos',
    title: 'Consulta de Acompanhamento Crónico Online — Renovação de Medicação | ConsultasOnline',
    desc: 'Consulta de acompanhamento crónico por videoconsulta. Renovação de medicação para hipertensão, diabetes, colesterol e outras doenças crónicas. 40€. Sem deslocação.',
    h1: 'Consulta de Acompanhamento Crónico Online',
    price: '40',
    body: `
<div class="hero">
  <h1>Consulta de Acompanhamento<br/>Crónico Online</h1>
  <p>Renovação de medicação para doenças crónicas por videoconsulta. Sem deslocação, sem filas, sem esperas.</p>
  <div class="price">40€</div>
  <a class="btn" href="/#marcar">Marcar Consulta Agora →</a>
</div>
<div class="body">
  <h2>Para que serve esta consulta?</h2>
  <p>A consulta de acompanhamento crónico online destina-se a doentes com doenças crónicas controladas que precisam de renovar a medicação habitual sem necessidade de consulta presencial.</p>

  <h2>Doenças crónicas abrangidas</h2>
  <ul>
    <li>Hipertensão arterial</li>
    <li>Diabetes tipo 2 controlada</li>
    <li>Dislipidemia (colesterol)</li>
    <li>Hipotiroidismo controlado</li>
    <li>Outras doenças crónicas estáveis</li>
  </ul>

  <div class="box"><p>💡 <strong>O que preparar:</strong> Tenha consigo a lista de medicação actual, últimas análises e valores de tensão arterial recentes.</p></div>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta de 20 a 30 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Avaliação clínica e renovação da medicação</p></div>
    <div class="step"><div class="num">04</div><p>Receitas enviadas por email no próprio dia</p></div>
  </div>

  <div class="cta-box">
    <h3>Precisa de renovar a medicação crónica?</h3>
    <p>Videoconsulta disponível de segunda a domingo, das 9h às 21h.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 40€ →</a>
  </div>
</div>`
  }));
});

// Atestado Falta Escolar
app.get('/atestado-falta-escolar-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/atestado-falta-escolar-online',
    serviceId: 'atestado-escola',
    title: 'Atestado para Falta Escolar Online — Emitido no Próprio Dia | ConsultasOnline',
    desc: 'Obtenha o atestado médico para justificar falta escolar por videoconsulta. Documento com validade legal enviado por email no próprio dia. 35€. Sem deslocação.',
    h1: 'Atestado para Falta Escolar Online',
    price: '35',
    body: `
<div class="hero">
  <h1>Atestado para Falta<br/>Escolar Online</h1>
  <p>Declaração médica para justificar ausências escolares, emitida por videoconsulta e enviada por email no próprio dia.</p>
  <div class="price">35€</div>
  <a class="btn" href="/#marcar">Obter Atestado Agora →</a>
</div>
<div class="body">
  <h2>O que diz a lei</h2>
  <p>As faltas escolares por doença são reguladas pelo Estatuto do Aluno e Ética Escolar (Lei n.º 51/2012). A declaração médica deve indicar o período de incapacidade sem revelar o diagnóstico.</p>

  <h2>Prazos importantes</h2>
  <ul>
    <li>A justificação deve ser entregue ao Diretor de Turma nos <strong>3 dias úteis</strong> seguintes ao regresso</li>
    <li>No ensino secundário o limite de faltas é <strong>10% da carga horária</strong> de cada disciplina</li>
  </ul>

  <div class="box"><p>✅ O atestado médico online tem plena validade legal junto das escolas e colégios em Portugal.</p></div>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta rápida — cerca de 15 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Atestado emitido em PDF com validade legal</p></div>
    <div class="step"><div class="num">04</div><p>Documento enviado por email no próprio dia</p></div>
  </div>

  <div class="cta-box">
    <h3>Precisa do atestado para a escola hoje?</h3>
    <p>Emitido por videoconsulta e enviado por email no próprio dia.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 35€ →</a>
  </div>
</div>`
  }));
});
// Consulta Amigdalite
app.get('/consulta-amigdalite-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/consulta-amigdalite-online',
    serviceId: 'consulta-amigdalite',
    title: 'Consulta de Amigdalite Online em Portugal — Diagnóstico e Tratamento | ConsultasOnline',
    desc: 'Consulta de amigdalite e dor de garganta online por videoconsulta. Diagnóstico e tratamento no próprio dia. Apenas para adultos. 40€. Sem filas, sem deslocação.',
    h1: 'Consulta de Amigdalite Online',
    price: '40',
    body: `
<div class="hero">
  <h1>Consulta de Amigdalite<br/>Online</h1>
  <p>Diagnóstico e tratamento de dor de garganta por videoconsulta. Apenas para adultos. Sem filas, sem urgências.</p>
  <div class="price">40€</div>
  <a class="btn" href="/#marcar">Marcar Consulta Agora →</a>
</div>
<div class="body">
  <h2>Sintomas de amigdalite</h2>
  <ul>
    <li>Dor de garganta intensa, especialmente ao engolir</li>
    <li>Febre acima de 38°C</li>
    <li>Gânglios inchados no pescoço</li>
    <li>Ausência de tosse (sinal de infeção bacteriana)</li>
    <li>Placas brancas nas amígdalas</li>
  </ul>
  <div class="box"><p>✅ <strong>Sabia que?</strong> Até 80% das amigdalites são virais e não precisam de antibiótico. A médica avalia clinicamente se o antibiótico é necessário.</p></div>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta de 20 a 30 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Diagnóstico e prescrição se indicado</p></div>
    <div class="step"><div class="num">04</div><p>Receita enviada por email no próprio dia</p></div>
  </div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>Posso obter antibiótico por videoconsulta para amigdalite?</h4>
      <p>Sim, se o diagnóstico clínico indicar infeção bacteriana. A médica utiliza critérios validados para decidir se o antibiótico é necessário.</p>
    </div>
    <div class="faq-item">
      <h4>Este serviço é apenas para adultos?</h4>
      <p>Sim. A consulta de amigdalite online está disponível exclusivamente para adultos. Para crianças, recomendamos consulta presencial de pediatria.</p>
    </div>
    <div class="faq-item">
      <h4>Quando devo ir às urgências em vez de fazer consulta online?</h4>
      <p>Se tiver dificuldade em respirar, engolir a própria saliva, voz muito alterada ou febre muito alta com mal-estar geral, dirija-se às urgências.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Com dor de garganta intensa?</h3>
    <p>Diagnóstico e tratamento em 30 minutos, sem sair de casa.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 40€ →</a>
  </div>
</div>`
  }));
});

// Cessação Tabágica
app.get('/consulta-cessacao-tabagica-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/consulta-cessacao-tabagica-online',
    serviceId: 'consulta-cessacao-tabagica',
    title: 'Consulta de Cessação Tabágica Online — Deixar de Fumar com Apoio Médico | ConsultasOnline',
    desc: 'Consulta de cessação tabágica por videoconsulta. Avaliação, aconselhamento e prescrição de vareniclina, bupropiona ou adesivos de nicotina. 40€. Sem deslocação.',
    h1: 'Consulta de Cessação Tabágica Online',
    price: '40',
    body: `
<div class="hero">
  <h1>Consulta de Cessação<br/>Tabágica Online</h1>
  <p>Deixe de fumar com apoio médico. Avaliação, aconselhamento e prescrição do tratamento mais eficaz para si.</p>
  <div class="price">40€</div>
  <a class="btn" href="/#marcar">Marcar Consulta Agora →</a>
</div>
<div class="body">
  <h2>Porque é difícil parar de fumar sozinho?</h2>
  <p>A dependência do tabaco é uma doença crónica. Sem apoio médico, apenas 3 a 5% dos fumadores conseguem parar de forma sustentada ao fim de um ano. Com tratamento farmacológico adequado, as probabilidades aumentam significativamente.</p>

  <h2>Tratamentos disponíveis</h2>
  <ul>
    <li><strong>Vareniclina (Champix)</strong> — primeira linha com maior taxa de sucesso</li>
    <li><strong>Bupropiona</strong> — alternativa eficaz, especialmente com depressão associada</li>
    <li><strong>Terapêutica de Substituição Nicotínica</strong> — adesivos, pastilhas e inalador</li>
  </ul>
  <div class="box"><p>📊 A vareniclina duplica a probabilidade de cessação tabágica vs. placebo, segundo meta-análise Cochrane.</p></div>

  <h2>Benefícios de parar de fumar</h2>
  <ul>
    <li><strong>1 ano</strong> — risco cardíaco reduzido a metade</li>
    <li><strong>5 anos</strong> — risco de AVC igual ao de não fumador</li>
    <li><strong>10 anos</strong> — risco de cancro do pulmão reduzido a metade</li>
  </ul>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta de 20 a 30 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Avaliação do grau de dependência e plano personalizado</p></div>
    <div class="step"><div class="num">04</div><p>Receita enviada por email no próprio dia</p></div>
  </div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>Posso obter Champix (vareniclina) por videoconsulta?</h4>
      <p>Sim. A médica avalia o seu caso e, se indicado, prescreve vareniclina ou outro tratamento adequado. A receita é enviada por email.</p>
    </div>
    <div class="faq-item">
      <h4>Quanto tempo dura o tratamento?</h4>
      <p>O tratamento com vareniclina dura normalmente 12 semanas. A médica define o plano personalizado na consulta.</p>
    </div>
    <div class="faq-item">
      <h4>Posso fazer esta consulta se fumar há muitos anos?</h4>
      <p>Sim. A consulta de cessação tabágica é indicada para qualquer fumador independentemente do número de anos ou quantidade de cigarros.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Pronto para deixar de fumar?</h3>
    <p>Consulta com prescrição médica no próprio dia. Disponível de segunda a domingo, das 9h às 21h.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 40€ →</a>
  </div>
</div>`
  }));
});

// Rastreio DST/IST
app.get('/consulta-rastreio-dst-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/consulta-rastreio-dst-online',
    serviceId: 'consulta-dst',
    title: 'Rastreio de DST/IST Online em Portugal — Consulta Confidencial | ConsultasOnline',
    desc: 'Rastreio de doenças sexualmente transmissíveis por videoconsulta. Pedido de análises confidencial enviado por email. VIH, sífilis, gonorreia, clamídia. 40€.',
    h1: 'Rastreio de DST Online em Portugal',
    price: '40',
    body: `
<div class="hero">
  <h1>Rastreio de DST/IST<br/>Online em Portugal</h1>
  <p>Consulta confidencial com avaliação de risco e pedido de análises de rastreio enviado por email. Total privacidade.</p>
  <div class="price">40€</div>
  <a class="btn" href="/#marcar">Marcar Consulta Agora →</a>
</div>
<div class="body">
  <h2>O que é o rastreio de DST online?</h2>
  <p>A consulta de rastreio de doenças sexualmente transmissíveis (DST/IST) online permite fazer uma avaliação confidencial do risco, esclarecer dúvidas e obter um pedido de análises personalizado — sem necessidade de se deslocar a um centro de saúde ou clínica.</p>

  <h2>IST abrangidas no rastreio</h2>
  <ul>
    <li><strong>VIH</strong> — incluindo PrEP e PEP quando indicado</li>
    <li><strong>Sífilis</strong></li>
    <li><strong>Gonorreia</strong></li>
    <li><strong>Clamídia</strong> — a IST bacteriana mais prevalente</li>
    <li><strong>Hepatite B e C</strong></li>
    <li><strong>HPV</strong> — orientação e vacinação</li>
  </ul>

  <div class="box"><p>🔒 <strong>Total confidencialidade.</strong> A consulta decorre em sala virtual privada. Toda a informação está sujeita ao sigilo médico e ao RGPD.</p></div>

  <h2>Quem deve fazer rastreio de IST?</h2>
  <ul>
    <li>Adultos sexualmente activos com múltiplos parceiros</li>
    <li>Após relação sexual desprotegida</li>
    <li>Com sintomas como corrimento, ardor, úlceras ou erupções genitais</li>
    <li>Antes de iniciar nova relação</li>
  </ul>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cartão</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta confidencial de 20 a 30 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Avaliação de risco e orientação clínica</p></div>
    <div class="step"><div class="num">04</div><p>Pedido de análises enviado por email</p></div>
  </div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>A consulta é mesmo confidencial?</h4>
      <p>Sim. A videoconsulta decorre em sala virtual privada, não é gravada e toda a informação está protegida pelo sigilo médico e pelo RGPD.</p>
    </div>
    <div class="faq-item">
      <h4>Onde faço as análises após a consulta?</h4>
      <p>O pedido de análises é válido em qualquer laboratório privado em Portugal. A médica indica os exames mais adequados ao seu perfil de risco.</p>
    </div>
    <div class="faq-item">
      <h4>Posso obter PrEP por videoconsulta?</h4>
      <p>A médica avalia a indicação para PrEP e orienta o processo. A prescrição e seguimento podem requerer acompanhamento adicional.</p>
    </div>
    <div class="faq-item">
      <h4>Tenho sintomas agora. Posso fazer a consulta online?</h4>
      <p>Sim. Se tiver sintomas activos, a médica avalia e pode prescrever tratamento imediato enquanto aguarda os resultados das análises.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Rastreio de IST confidencial, hoje</h3>
    <p>Consulta disponível de segunda a domingo, das 9h às 21h. Total privacidade garantida.</p>
    <a class="btn" href="/#marcar">Marcar Consulta — 40€ →</a>
  </div>
</div>`
  }));
});
app.listen(PORT, () => {
  console.log('ConsultasOnline - Server Running - porta ' + PORT);
});
