require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail   = require('@sendgrid/mail');
const axios    = require('axios');
const path     = require('path');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app  = express();
const PORT = process.env.PORT || 8080;

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

app.get('/services', (req, res) => {
  res.json(Object.entries(SERVICES).map(([id, s]) => ({ id, name: s.name, price: s.price / 100 })));
});

app.post('/create-checkout-session', async (req, res) => {
  const { serviceId, customerEmail, customerName, date, time, nif } = req.body;

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
        nif: nif || '',
      },
      success_url: clientUrl + '/obrigado?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: clientUrl + '/?cancelado=1',
      locale: 'pt',
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
    const pi = event.data.object;
    // Get metadata from session
    const { serviceName, date, time, customerEmail, customerName, nif } = session.metadata || {};
    const amountEur = session.amount_total ? (session.amount_total / 100).toFixed(2).replace('.', ',') + ' EUR' : '—';
    console.log('Checkout completo:', session.id, serviceName);
    try {
      const invoiceData = await createInvoice({ customerName, customerEmail, nif, serviceName, amount: session.amount_total / 100, date: new Date().toISOString().split('T')[0] });
      await sendConfirmationEmail({ to: customerEmail, name: customerName, serviceName, date, time, amountEur, invoiceUrl: invoiceData && invoiceData.url, invoiceNum: invoiceData && invoiceData.invoiceNumber });
    } catch(e) { console.error('Erro email/fatura:', e.message); }
    return res.json({ received: true });
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const { serviceName, date, time, customerEmail, customerName, nif } = pi.metadata;
    const amountEur = (pi.amount / 100).toFixed(2).replace('.', ',') + ' EUR';
    console.log('Pagamento confirmado:', pi.id, serviceName);

    try {
      const invoiceData = await createInvoice({ customerName, customerEmail, nif, serviceName, amount: pi.amount / 100, date: new Date().toISOString().split('T')[0] });
      await sendConfirmationEmail({ to: customerEmail, name: customerName, serviceName, date, time, amountEur, invoiceUrl: invoiceData && invoiceData.url, invoiceNum: invoiceData && invoiceData.invoiceNumber });
    } catch (e) {
      console.error('Erro email/fatura:', e.message);
    }
  }

  res.json({ received: true });
});

async function createInvoice({ customerName, customerEmail, nif, serviceName, amount, date }) {
  const apiKey = process.env.INVOICEXPRESS_API_KEY;
  const account = process.env.INVOICEXPRESS_ACCOUNT;
  if (!apiKey || !account) { console.warn('InvoiceXpress nao configurado.'); return null; }

  try {
    const clientRes = await axios.post(
      'https://' + account + '.app.invoicexpress.com/clients.json?api_key=' + apiKey,
      { client: { name: customerName, email: customerEmail, country: 'Portugal', ...(nif ? { fiscal_id: nif } : {}) } }
    );
    const clientId = clientRes.data.client.id;

    const invoiceRes = await axios.post(
      'https://' + account + '.app.invoicexpress.com/invoices.json?api_key=' + apiKey,
      { invoice: { date, due_date: date, client: { id: clientId }, items: [{ name: serviceName, description: 'Prestacao de servicos de saude online', unit_price: amount.toFixed(2), quantity: '1', tax: { name: 'IVA Isento' } }], observations: 'IVA isento nos termos do artigo 9. do CIVA' } }
    );

    const invoice = invoiceRes.data.invoice;
    await axios.put('https://' + account + '.app.invoicexpress.com/invoices/' + invoice.id + '/change-state.json?api_key=' + apiKey, { invoice: { state: 'finalized' } });
    const pdfRes = await axios.get('https://' + account + '.app.invoicexpress.com/api/pdf/' + invoice.id + '.json?api_key=' + apiKey);

    return { invoiceNumber: invoice.sequence_number, url: pdfRes.data && pdfRes.data.output && pdfRes.data.output.pdfUrl };
  } catch (err) {
    console.error('InvoiceXpress error:', err.response && err.response.data || err.message);
    return null;
  }
}

async function sendConfirmationEmail({ to, name, serviceName, date, time, amountEur, invoiceUrl, invoiceNum }) {
  const invoiceLine = invoiceNum ? '<p>Fatura: ' + invoiceNum + (invoiceUrl ? ' - <a href="' + invoiceUrl + '">Descarregar PDF</a>' : '') + '</p>' : '';

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

app.listen(PORT, () => {
  console.log('ConsultasOnline - Server Running - porta ' + PORT);
});
