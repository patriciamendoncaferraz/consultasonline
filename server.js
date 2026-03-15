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
 
app.post('/create-payment-intent', async (req, res) => {
  const { serviceId, paymentMethod, phone, customerEmail, customerName, date, time, nif } = req.body;
 
  const service = SERVICES[serviceId];
  if (!service) return res.status(400).json({ error: 'Servico invalido.' });
 
  const clientUrl = process.env.CLIENT_URL || 'https://consultas-online.pt';
 
  try {
    if (paymentMethod === 'mbway') {
      const formattedPhone = formatPhone(phone);
      if (!formattedPhone) return res.status(400).json({ error: 'Telemovel obrigatorio para MBWay.' });
 
      const pi = await stripe.paymentIntents.create({
        amount: service.price,
        currency: 'eur',
        payment_method_types: ['mb_way'],
        payment_method_data: { type: 'mb_way', mb_way: { phone: formattedPhone } },
        confirm: true,
        return_url: clientUrl + '/obrigado',
        metadata: { serviceId, serviceName: service.name, date, time, customerEmail, customerName, nif: nif || '' },
        description: service.name + ' - ' + date + ' as ' + time,
        receipt_email: customerEmail,
      });
 
      return res.json({ paymentIntentId: pi.id, status: pi.status, mbwayPending: true });
    }
 
    if (paymentMethod === 'mb_reference') {
      const pi = await stripe.paymentIntents.create({
        amount: service.price,
        currency: 'eur',
        payment_method_types: ['multibanco'],
        payment_method_data: { type: 'multibanco' },
        confirm: true,
        return_url: clientUrl + '/obrigado',
        metadata: { serviceId, serviceName: service.name, date, time, customerEmail, customerName, nif: nif || '' },
        description: service.name + ' - ' + date + ' as ' + time,
        receipt_email: customerEmail,
      });
 
      const mb = pi.next_action && pi.next_action.multibanco_display_details;
      return res.json({
        paymentIntentId: pi.id,
        status: pi.status,
        multibanco: mb ? { entity: mb.entity, reference: mb.reference, amount: (service.price / 100).toFixed(2).replace('.', ',') + ' EUR' } : null,
      });
    }
 
    if (paymentMethod === 'card') {
      const pi = await stripe.paymentIntents.create({
        amount: service.price,
        currency: 'eur',
        payment_method_types: ['card'],
        metadata: { serviceId, serviceName: service.name, date, time, customerEmail, customerName, nif: nif || '' },
        description: service.name + ' - ' + date + ' as ' + time,
        receipt_email: customerEmail,
      });
 
      return res.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id, status: pi.status });
    }
 
    return res.status(400).json({ error: 'Metodo de pagamento invalido.' });
 
  } catch (err) {
    console.error('Stripe error:', err.message);
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
    + '<p style="font-size:12px;color:#8a9bb0">Duvidas? apoio@consultas-online.pt</p>'
    + '</div></div></body></html>';
 
  await sgMail.send({
    to,
    from: { email: process.env.FROM_EMAIL || 'apoio@consultas-online.pt', name: 'ConsultasOnline' },
    subject: 'Consulta confirmada - ' + serviceName + ' | ' + date + ' as ' + time,
    html,
    text: 'Ola ' + name + ',\n\nConsulta confirmada!\nServico: ' + serviceName + '\nData: ' + date + '\nHora: ' + time + '\nValor: ' + amountEur,
  });
}
 
app.listen(PORT, () => {
  console.log('ConsultasOnline - Server Running - porta ' + PORT);
});
