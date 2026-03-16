require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail   = require('@sendgrid/mail');
const axios    = require('axios');
const path     = require('path');
const mongoose = require('mongoose');
const { google } = require('googleapis');

// Google Calendar OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

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

// Guardar/atualizar utente e adicionar consulta
async function upsertUtente({ nomeCompleto, email, telefone, numeroUtente, nif, morada, observacoes, dataConsulta, hora, servico, stripeSession, valor }) {
  if (!MONGO_URI || !email) return null;
  try {
    const novaConsulta = { data: new Date(), dataConsulta, hora, servico, observacoes, stripeSession, valor };
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
app.use(express.json());
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const SERVICES = {
  'atestado-amamentacao':       { name: 'Atestado de Amamentação',          price: 3500 },
  'atestado-escola':            { name: 'Atestado para Falta Escolar',       price: 3500 },
  'atestado-conducao':          { name: 'Atestado para Carta de Condução',   price: 3500 },
  'baixa-medica':               { name: 'Emissão de Baixa Médica',           price: 4000 },
  'renovacao-medicamentos':     { name: 'Renovação de Medicamentos',         price: 4000 },
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

// Página de sucesso após pagamento
app.get('/obrigado', (req, res) => {
  const sessionId = req.query.session_id || '';
  res.send(`<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Consulta Confirmada — ConsultasOnline</title>
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
</head>
<body>
<div class="card">
  <div class="logo">Consultas<span>Online</span></div>
  <div class="icon">✓</div>
  <h1>Pagamento Confirmado!</h1>
  <p>A sua consulta foi agendada com sucesso.</p>
  <p>Vai receber um email de confirmação com todos os detalhes e a fatura em breve.</p>
  <div class="highlight">
    <p>📧 <strong>Verifique o seu email</strong></p>
    <p style="font-size:13px;color:#64748b">A confirmação e fatura são enviadas automaticamente. Verifique também a pasta de spam.</p>
  </div>
  <a href="/" class="btn">Voltar ao Website →</a>
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

app.post('/create-checkout-session', async (req, res) => {
  const { serviceId, customerEmail, customerName, date, time, nif, telefone, numeroUtente, observacoes } = req.body;

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

      // 5. Enviar email (só se tiver email)
      if (customerEmail) {
        await sendConfirmationEmail({ to: customerEmail, name: customerName || 'Utente', serviceName, date, time, amountEur, meetLink, invoiceUrl: invoiceData && invoiceData.url, invoiceNum: invoiceData && invoiceData.invoiceNumber });
      } else {
        console.warn('Email ignorado: endereco em falta');
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
// GOOGLE CALENDAR — Criar evento com Meet
// ─────────────────────────────────────────────
async function createMeetLink({ customerName, customerEmail, serviceName, date, time }) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn('Google Calendar nao configurado.');
    return null;
  }
  try {
    // Parse date DD/MM/YYYY and time HH:MM
    const dateParts = date.split('/');
    const timeParts = time.split(':');
    if (dateParts.length !== 3 || timeParts.length !== 2) {
      console.warn('Data ou hora invalida para Google Calendar:', date, time);
      return null;
    }
    const year  = parseInt(dateParts[2]);
    const month = parseInt(dateParts[1]) - 1;
    const day   = parseInt(dateParts[0]);
    const hour  = parseInt(timeParts[0]);
    const min   = parseInt(timeParts[1]);

    const startTime = new Date(year, month, day, hour, min, 0);
    const endTime   = new Date(year, month, day, hour + 1, min, 0); // 1 hora de duração

    const event = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      requestBody: {
        summary: serviceName + ' — ' + customerName,
        description: 'Consulta online agendada via ConsultasOnline. Utente: ' + customerName + ' Email: ' + customerEmail,
        start: {
          dateTime: startTime.toISOString(),
          timeZone: 'Europe/Lisbon',
        },
        end: {
          dateTime: endTime.toISOString(),
          timeZone: 'Europe/Lisbon',
        },
        attendees: [
          { email: customerEmail },
        ],
        conferenceData: {
          createRequest: {
            requestId: 'consulta-' + Date.now(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 60 },
            { method: 'popup', minutes: 15 },
          ],
        },
      },
    });

    const meetLink = event.data.conferenceData &&
      event.data.conferenceData.entryPoints &&
      event.data.conferenceData.entryPoints.find(e => e.entryPointType === 'video');

    const link = meetLink ? meetLink.uri : event.data.hangoutLink;
    console.log('Google Meet link criado:', link);
    return link;
  } catch (err) {
    console.error('Google Calendar erro:', err.message);
    return null;
  }
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
        items: [{
          name: serviceName,
          description: 'Prestacao de servicos de saude online',
          unit_price: String(amount.toFixed(2)),
          quantity: '1',
          unit: 'service',
          tax: { name: process.env.INVOICEXPRESS_TAX_NAME || 'Isento artigo 9º do CIVA' }
        }],
        observations: 'IVA isento ao abrigo do artigo 9 do CIVA'
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
    + '<p style="margin:6px 0;font-size:14px;color:#0b1d35">Hora: <strong>' + time + '</strong></p>'
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

// Middleware de autenticação admin
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (!key || key !== process.env.ADMIN_SECRET) {
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
