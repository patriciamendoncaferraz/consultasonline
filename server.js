/**
 * ConsultasOnline — Backend Server
 * ─────────────────────────────────
 * Stack: Node.js + Express
 * Stripe: Payment Intents (MBWay, cartão, Referência MB)
 * Faturação: InvoiceXpress API (certificada AT)
 * Email: SendGrid (confirmações + faturas)
 *
 * Instalar dependências:
 *   npm install express stripe @sendgrid/mail axios dotenv cors
 *
 * Variáveis de ambiente (.env):
 *   STRIPE_SECRET_KEY=sk_live_...
 *   STRIPE_WEBHOOK_SECRET=whsec_...
 *   SENDGRID_API_KEY=SG....
 *   INVOICEXPRESS_API_KEY=...
 *   INVOICEXPRESS_ACCOUNT=consultasonline
 *   FROM_EMAIL=noreply@consultasonline.com
 *   CLIENT_URL=https://consultasonline.com
 *   PORT=3000
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail     = require('@sendgrid/mail');
const axios      = require('axios');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Raw body necessário para validar webhooks do Stripe ──
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.static('public')); // serve o index.html

// ─────────────────────────────────────────────────────────
// TABELA DE SERVIÇOS E PREÇOS
// ─────────────────────────────────────────────────────────
const SERVICES = {
  'atestado-amamentacao':        { name: 'Atestado de Amamentação',            price: 3500, type: 'Atestado' },
  'atestado-escola':             { name: 'Atestado para Falta Escolar',         price: 3500, type: 'Atestado' },
  'atestado-conducao':           { name: 'Atestado para Carta de Condução',     price: 3500, type: 'Atestado' },
  'baixa-medica':                { name: 'Emissão de Baixa Médica',             price: 4000, type: 'Consulta' },
  'renovacao-medicamentos':      { name: 'Renovação de Medicamentos',           price: 4000, type: 'Consulta' },
  'consulta-infecao-urinaria':   { name: 'Consulta de Infeção Urinária',        price: 4000, type: 'Consulta' },
  'consulta-cessacao-tabagica':  { name: 'Consulta de Cessação Tabágica',       price: 4000, type: 'Consulta' },
  'consulta-amigdalite':         { name: 'Consulta de Amigdalite',              price: 4000, type: 'Consulta' },
  'consulta-dst':                { name: 'Consulta DST / IST',                  price: 4000, type: 'Consulta' },
};

// ─────────────────────────────────────────────────────────
// ROTA: Criar Payment Intent (MBWay, cartão, MB)
// POST /create-payment-intent
// Body: { serviceId, paymentMethod, phone?, customerEmail, customerName, date, time, nif? }
// ─────────────────────────────────────────────────────────
app.post('/create-payment-intent', async (req, res) => {
  const {
    serviceId,
    paymentMethod, // 'mbway' | 'card' | 'mb_reference'
    phone,         // obrigatório para MBWay
    customerEmail,
    customerName,
    date,
    time,
    nif,
    address,
  } = req.body;

  const service = SERVICES[serviceId];
  if (!service) {
    return res.status(400).json({ error: 'Serviço inválido.' });
  }

  try {
    // ── Criar ou reutilizar Customer no Stripe ──
    const customers = await stripe.customers.list({ email: customerEmail, limit: 1 });
    let customer;
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({
        email: customerEmail,
        name:  customerName,
        phone: phone || undefined,
        metadata: { nif: nif || '', address: address || '' },
      });
    }

    // ── Configurar método de pagamento Stripe ──
    let paymentMethodTypes;
    let confirmParams = {};

    if (paymentMethod === 'mbway') {
      if (!phone) return res.status(400).json({ error: 'Telemóvel obrigatório para MBWay.' });
      paymentMethodTypes = ['mb_way'];
      confirmParams = {
        payment_method: {
          type: 'mb_way',
          mb_way: { phone.startsWith('+') ? phone : '+351' + phone.replace(/\s/g,''), },
        },
        confirm: true,
        return_url: `${process.env.CLIENT_URL}/success`,
      };
    } else if (paymentMethod === 'card') {
      paymentMethodTypes = ['card'];
      // O cartão é confirmado pelo Stripe.js no frontend — não confirmamos aqui
    } else if (paymentMethod === 'mb_reference') {
      paymentMethodTypes = ['multibanco'];
      confirmParams = {
        payment_method: { type: 'multibanco' },
        confirm: true,
        return_url: `${process.env.CLIENT_URL}/success`,
      };
    } else {
      return res.status(400).json({ error: 'Método de pagamento inválido.' });
    }

    // ── Criar Payment Intent ──
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   service.price,       // em cêntimos (3500 = 35,00€)
      currency: 'eur',
      customer: customer.id,
      payment_method_types: paymentMethodTypes,
      metadata: {
        serviceId,
        serviceName: service.name,
        date,
        time,
        customerEmail,
        customerName,
        nif:  nif     || '',
        phone: phone  || '',
      },
      description: `${service.name} — ${date} às ${time}`,
      receipt_email: customerEmail,
      ...confirmParams,
    });

    // ── Resposta para o frontend ──
    const response = {
      clientSecret:    paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      status:          paymentIntent.status,
    };

    // Para Multibanco, devolver a referência gerada pelo Stripe
    if (paymentMethod === 'mb_reference' && paymentIntent.next_action?.multibanco_display_details) {
      const mb = paymentIntent.next_action.multibanco_display_details;
      response.multibanco = {
        entity:    mb.entity,
        reference: mb.reference,
        amount:    (service.price / 100).toFixed(2) + ' €',
        expiresAt: mb.expires_at,
      };
    }

    // Para MBWay: o utilizador recebe notificação no telemóvel e o status muda via webhook
    if (paymentMethod === 'mbway') {
      response.mbwayPending = true;
    }

    res.json(response);

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// ROTA: Verificar status do Payment Intent
// GET /payment-status/:id
// ─────────────────────────────────────────────────────────
app.get('/payment-status/:id', async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.id);
    res.json({ status: pi.status });
  } catch (err) {
    res.status(404).json({ error: 'Payment Intent não encontrado.' });
  }
});

// ─────────────────────────────────────────────────────────
// WEBHOOK: Stripe → eventos de pagamento
// POST /webhook
// ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature invalid:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    console.log(`✅ Pagamento confirmado: ${pi.id}`);

    const {
      serviceId,
      serviceName,
      date,
      time,
      customerEmail,
      customerName,
      nif,
      phone,
    } = pi.metadata;

    const amountEur = (pi.amount / 100).toFixed(2).replace('.', ',') + ' €';

    try {
      // 1. Emitir fatura no InvoiceXpress
      const invoiceData = await createInvoice({
        customerName,
        customerEmail,
        nif,
        serviceName,
        amount: pi.amount / 100,
        date: new Date().toISOString().split('T')[0],
      });

      // 2. Enviar email de confirmação + fatura
      await sendConfirmationEmail({
        to:          customerEmail,
        name:        customerName,
        serviceName,
        date,
        time,
        amountEur,
        invoiceUrl:  invoiceData?.url || null,
        invoiceNum:  invoiceData?.invoiceNumber || null,
      });

      console.log(`📧 Email enviado para ${customerEmail}`);
    } catch (emailErr) {
      console.error('Erro ao enviar email/fatura:', emailErr.message);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    console.log(`❌ Pagamento falhou: ${event.data.object.id}`);
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────
// INVOICEXPRESS — Criar fatura certificada AT
// ─────────────────────────────────────────────────────────
async function createInvoice({ customerName, customerEmail, nif, serviceName, amount, date }) {
  const apiKey   = process.env.INVOICEXPRESS_API_KEY;
  const account  = process.env.INVOICEXPRESS_ACCOUNT;

  if (!apiKey || !account) {
    console.warn('InvoiceXpress não configurado — fatura não emitida.');
    return null;
  }

  try {
    // 1. Criar / localizar cliente no InvoiceXpress
    const clientPayload = {
      client: {
        name:  customerName,
        email: customerEmail,
        ...(nif ? { fiscal_id: nif } : {}),
        country: 'Portugal',
      }
    };

    const clientRes = await axios.post(
      `https://${account}.app.invoicexpress.com/clients.json?api_key=${apiKey}`,
      clientPayload
    );
    const clientId = clientRes.data.client.id;

    // 2. Criar fatura simplificada (isenta de IVA — art. 9.º CIVA)
    const invoicePayload = {
      invoice: {
        date,
        due_date: date,
        client: { id: clientId },
        items: [
          {
            name:        serviceName,
            description: 'Prestação de serviços de saúde online',
            unit_price:  amount.toFixed(2),
            quantity:    '1',
            tax:         { name: 'IVA Isento' },  // configurar no InvoiceXpress
          }
        ],
        observations: 'IVA isento nos termos do artigo 9.º do CIVA',
        sequence_id:  process.env.INVOICEXPRESS_SEQUENCE_ID || undefined,
      }
    };

    const invoiceRes = await axios.post(
      `https://${account}.app.invoicexpress.com/invoices.json?api_key=${apiKey}`,
      invoicePayload
    );

    const invoice = invoiceRes.data.invoice;

    // 3. Finalizar fatura (mudar estado para "finalized" — comunica com AT)
    await axios.put(
      `https://${account}.app.invoicexpress.com/invoices/${invoice.id}/change-state.json?api_key=${apiKey}`,
      { invoice: { state: 'finalized' } }
    );

    // 4. Obter PDF da fatura
    const pdfRes = await axios.get(
      `https://${account}.app.invoicexpress.com/api/pdf/${invoice.id}.json?api_key=${apiKey}`
    );

    return {
      invoiceNumber: invoice.sequence_number,
      url:           pdfRes.data?.output?.pdfUrl || null,
      id:            invoice.id,
    };

  } catch (err) {
    console.error('InvoiceXpress error:', err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// SENDGRID — Enviar email de confirmação + fatura
// ─────────────────────────────────────────────────────────
async function sendConfirmationEmail({ to, name, serviceName, date, time, amountEur, invoiceUrl, invoiceNum }) {
  const invoiceLine = invoiceNum
    ? `<p style="margin:8px 0;font-size:14px;color:#4a5568">🧾 <strong>Fatura:</strong> ${invoiceNum}${invoiceUrl ? ` — <a href="${invoiceUrl}" style="color:#0d7377">Descarregar PDF</a>` : ''}</p>`
    : '';

  const html = `
<!DOCTYPE html>
<html lang="pt">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:'Inter',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:40px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(11,29,53,.1)">

        <!-- Header -->
        <tr><td style="background:#0b1d35;padding:28px 36px">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><span style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff">Consultas<span style="color:#17c4a8">Online</span></span></td>
            <td align="right"><span style="background:#17c4a8;color:#0b1d35;font-size:11px;font-weight:700;padding:5px 12px;border-radius:20px;letter-spacing:.5px">CONFIRMADO ✓</span></td>
          </tr></table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 36px">
          <h1 style="font-family:Georgia,serif;font-size:28px;color:#0b1d35;margin:0 0 8px">Consulta Confirmada!</h1>
          <p style="font-size:15px;color:#4a5568;line-height:1.6;margin:0 0 24px">Olá <strong>${name}</strong>, o seu agendamento foi confirmado com sucesso.</p>

          <!-- Booking details -->
          <div style="background:#f4f7fb;border-radius:12px;padding:20px 24px;margin-bottom:24px">
            <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#8a9bb0;letter-spacing:.6px;text-transform:uppercase">Detalhes do Agendamento</p>
            <p style="margin:8px 0;font-size:14px;color:#0b1d35">🩺 <strong>Serviço:</strong> ${serviceName}</p>
            <p style="margin:8px 0;font-size:14px;color:#0b1d35">📅 <strong>Data:</strong> ${date}</p>
            <p style="margin:8px 0;font-size:14px;color:#0b1d35">🕐 <strong>Hora:</strong> ${time}</p>
            <p style="margin:8px 0;font-size:14px;color:#0b1d35">💶 <strong>Valor pago:</strong> ${amountEur}</p>
            ${invoiceLine}
          </div>

          <!-- Video call instructions -->
          <div style="background:linear-gradient(135deg,#0b1d35,#1a3a5c);border-radius:12px;padding:20px 24px;margin-bottom:24px">
            <p style="margin:0 0 10px;font-size:14px;font-weight:700;color:#17c4a8">Como entrar na consulta</p>
            <p style="margin:0;font-size:13px;color:rgba(255,255,255,.7);line-height:1.6">No dia e hora marcados, aceda a <a href="https://consultasonline.com/sala" style="color:#17c4a8">consultasonline.com/sala</a> e clique em "Entrar na Consulta". Não é necessário instalar nenhuma aplicação.</p>
          </div>

          <p style="font-size:13px;color:#8a9bb0;line-height:1.6;margin:0">
            Se precisar de remarcar ou cancelar, contacte-nos com pelo menos 2 horas de antecedência para <a href="mailto:apoio@consultasonline.com" style="color:#0d7377">apoio@consultasonline.com</a>.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f4f7fb;padding:20px 36px;border-top:1px solid #dde6f0">
          <p style="margin:0;font-size:11.5px;color:#8a9bb0;text-align:center">
            © 2024 ConsultasOnline, Lda · NIF: 510 000 000<br/>
            <a href="https://consultasonline.com/privacidade" style="color:#8a9bb0">Política de Privacidade</a> · 
            <a href="https://consultasonline.com/termos" style="color:#8a9bb0">Termos de Serviço</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const msg = {
    to,
    from:    { email: process.env.FROM_EMAIL || 'noreply@consultasonline.com', name: 'ConsultasOnline' },
    subject: `✅ Consulta confirmada — ${serviceName} | ${date} às ${time}`,
    html,
    text: `Olá ${name},\n\nA sua consulta foi confirmada.\n\nServiço: ${serviceName}\nData: ${date}\nHora: ${time}\nValor: ${amountEur}\n${invoiceNum ? `Fatura: ${invoiceNum}\n` : ''}\nConsultasOnline`,
  };

  await sgMail.send(msg);
}

// ─────────────────────────────────────────────────────────
// ROTA: Listar serviços disponíveis (para o frontend)
// GET /services
// ─────────────────────────────────────────────────────────
app.get('/services', (req, res) => {
  const list = Object.entries(SERVICES).map(([id, s]) => ({
    id,
    name:  s.name,
    price: s.price / 100,
    type:  s.type,
  }));
  res.json(list);
});

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   ConsultasOnline — Server Running   ║
║   http://localhost:${PORT}               ║
╚══════════════════════════════════════╝
  `);
});
