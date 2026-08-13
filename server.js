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
  marketing: { type: Boolean, default: false },
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
  'renovacao-medicamentos':     { name: 'Consulta',         price: 4000 },
  'renovacao-piula':            { name: 'Renovação de Pílula Anticoncecional', price: 4000 },
  'consulta-infecao-urinaria':  { name: 'Consulta de Infeção Urinária',      price: 4000 },
  'consulta-cessacao-tabagica': { name: 'Consulta de Cessação Tabágica',     price: 4000 },
  'consulta-amigdalite':        { name: 'Consulta de Amigdalite',            price: 4000 },
  'consulta-dst':               { name: 'Consulta DST / IST',                price: 4000 },
  'consulta-obesidade':         { name: 'Consulta de Obesidade', price: 5500 },
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
// ═══════════════════════════════════════════════════════
// SUBSTITUI TODA A SECÇÃO DE ARTIGOS NO server.js
// Substitui desde "const ARTICLES = {" até ao fim da
// rota app.get('/artigos/:slug', ...)
// ═══════════════════════════════════════════════════════

const ARTICLES = {
  'infecao-urinaria':                    { id: 'itu',                      category: 'Infeções' },
  'baixa-medica':                        { id: 'renovacao-baixa',           category: 'Baixas' },
  'renovacao-medicamentos':              { id: 'renovacao-medicamentos',    category: 'Medicação' },
  'atestado-amamentacao':                { id: 'amamentacao',               category: 'Amamentação' },
  'atestado-carta-conducao':             { id: 'conducao',                  category: 'Carta de Condução' },
  'faltas-trabalho':                     { id: 'faltas-trabalho',           category: 'Trabalho' },
  'faltas-escola':                       { id: 'faltas-escola',             category: 'Escola' },
  'dor-de-garganta-amigdalite':          { id: 'garganta',                  category: 'Infeções' },
  'ozempic-glp1':                        { id: 'ozempic',                   category: 'Obesidade' },
  'doencas-sexualmente-transmissiveis':  { id: 'dst',                       category: 'Saúde Sexual' },
  'cessacao-tabagica':                   { id: 'cessacao',                  category: 'Cessação Tabágica' },
  'consulta-online':                     { id: 'consulta-online',           category: 'Consulta Online' },
  'medico-online':                       { id: 'medico-online',             category: 'Médico Online' },
  'telemedicina':                        { id: 'telemedicina',              category: 'Telemedicina' },
  'atestado-rastreio-saude':             { id: 'rastreio',                  category: 'Saúde Preventiva' },
  'renovar-pilula-anticoncecional-online': { id: 'piula-online',            category: 'Saúde da Mulher' },
  'baixa-medica-freelancer':             { id: 'baixa-medica-freelancer',   category: 'Freelancers' },
  'sem-medico-familia-freelancer':       { id: 'sem-medico-familia-freelancer', category: 'Freelancers' },
  'dia-saude-2026':                      { id: 'dia-saude-2026',            category: 'Saúde Global' },
};

// Conteúdo SSR completo de cada artigo
const ARTICLES_CONTENT = {

'infecao-urinaria': {
  title: 'Infeção Urinária: Causas, Sintomas e Tratamento | ConsultasOnline',
  description: 'Saiba como identificar e tratar a infeção urinária. Consulta online com diagnóstico e receita de antibiótico em 30 minutos. A partir de 40€.',
  keywords: 'infeção urinária sintomas tratamento, consulta infeção urinária online, antibiótico infeção urinária portugal, cistite online',
  content: `<div class="cta-top"><p>💧 Tem sintomas de infeção urinária? Consulta online com diagnóstico e tratamento no próprio dia. <a href="/">Marcar consulta — 40€ →</a></p></div>
    <h2>O que é uma Infeção do Trato Urinário?</h2>
    <p>A infeção do trato urinário (ITU) é uma das infeções bacterianas mais comuns em ambulatório. A cistite aguda não complicada é a forma mais prevalente em mulheres adultas saudáveis. A <em>Escherichia coli</em> é responsável por 80–85% das ITU não complicadas.</p>
    <h2>Sintomas</h2>
    <ul><li><strong>Disúria</strong> — ardor ou dor ao urinar</li><li><strong>Polaquiúria</strong> — urinar frequentemente em pequenas quantidades</li><li><strong>Hematúria</strong> — urina com sangue (~30% dos casos)</li><li><strong>Dor suprapúbica</strong> — zona inferior do abdómen</li></ul>
    <div class="warn"><strong>⚠️ Quando ir às urgências</strong><p>Febre superior a 38,5°C, dores lombares intensas ou vómitos requerem avaliação urgente presencial.</p></div>
    <h2>Diagnóstico</h2>
    <p>O diagnóstico de cistite não complicada é essencialmente clínico. A presença de disúria e polaquiúria sem corrimento vaginal tem um valor preditivo positivo de 90% para ITU.</p>
    <h2>Tratamento</h2>
    <p>As guidelines DGS e EAU recomendam antibioterapia de curta duração para cistite não complicada. Os antibióticos de primeira linha em Portugal incluem nitrofurantoína, fosfomicina e pivmecilinam.</p>
    <h2>Prevenção</h2>
    <ul><li>Ingestão adequada de líquidos (1,5–2L por dia)</li><li>Micção pós-coital</li><li>Evitar produtos de higiene íntima agressivos</li></ul>
    <div class="refs"><h3>Referências</h3><ol><li>EAU Guidelines on Urological Infections. 2023.</li><li>DGS. Infeções do Trato Urinário — Norma de Orientação Clínica. 2021.</li></ol></div>`
},

'baixa-medica': {
  title: 'Baixa Médica Online em Portugal: Como Funciona | ConsultasOnline',
  description: 'Como funciona o CIT em Portugal, prazos e como renovar a baixa médica online sem sair de casa. Consulta a partir de 55€.',
  keywords: 'baixa médica online portugal, renovar baixa médica online, CIT online, consulta baixa médica, certificado incapacidade temporária',
  content: `<div class="cta-top"><p>📋 Precisa de baixa médica? CIT emitido por videoconsulta e submetido à Segurança Social no próprio dia. <a href="/">Marcar consulta — 55€ →</a></p></div>
    <h2>O Sistema CIT em Portugal</h2>
    <p>A baixa médica é formalizada pelo <strong>Certificado de Incapacidade Temporária (CIT)</strong>, enviado eletronicamente pelo médico directamente para a Segurança Social.</p>
    <h2>Posso fazer baixa médica online em Portugal?</h2>
    <p>Sim. A Portaria n.º 115/2021 permite a emissão do CIT após videoconsulta. O processo tem exactamente a mesma validade legal que uma consulta presencial.</p>
    <div class="info"><strong>✅ Validade legal total</strong><p>O CIT emitido por videoconsulta tem o mesmo valor legal que o emitido presencialmente.</p></div>
    <h2>Quem pode pedir baixa médica online?</h2>
    <ul><li>Trabalhadores por conta de outrem com número de utente SNS válido</li><li>Trabalhadores independentes inscritos na Segurança Social</li><li>Trabalhadores com ou sem médico de família atribuído</li></ul>
    <h2>Subsídio de Doença</h2>
    <ul><li>Até 30 dias: <strong>55%</strong> da remuneração de referência</li><li>31–90 dias: <strong>60%</strong></li><li>91–365 dias: <strong>70%</strong></li><li>Mais de 365 dias: <strong>75%</strong></li></ul>
    <div class="warn"><strong>⚠️ Prazo legal</strong><p>O CIT deve ser submetido à Segurança Social em até <strong>5 dias úteis</strong> após o início da incapacidade.</p></div>
    <h2>Perguntas Frequentes</h2>
    <div class="faq"><h4>Posso fazer baixa médica sem médico de família?</h4><p>Sim. Qualquer médico registado na Ordem dos Médicos pode emitir o CIT.</p></div>
    <div class="faq"><h4>Posso renovar a baixa por videoconsulta?</h4><p>Sim. A renovação do CIT pode ser feita por videoconsulta nas mesmas condições.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>Decreto-Lei n.º 28/2004. Proteção na eventualidade de doença.</li><li>Portaria n.º 115/2021. Certificado de Incapacidade Temporária por teleconsulta.</li></ol></div>`
},

'renovacao-medicamentos': {
  title: 'Renovação de Medicamentos Online em Portugal | ConsultasOnline',
  description: 'Renove a sua receita médica por videoconsulta. Receita electrónica enviada por SMS e email no próprio dia. A partir de 40€.',
  keywords: 'renovar receita médica online, renovação medicamentos online portugal, receita médica online, consulta acompanhamento crónico',
  content: `<div class="cta-top"><p>💊 Precisa de renovar medicação crónica? Consulta de acompanhamento por videoconsulta. <a href="/">Marcar consulta — 40€ →</a></p></div>
    <h2>Para que serve esta consulta?</h2>
    <p>A consulta de acompanhamento crónico online destina-se a doentes com doenças crónicas controladas que precisam de renovar a medicação habitual sem necessidade de consulta presencial.</p>
    <h2>Doenças crónicas abrangidas</h2>
    <ul><li>Hipertensão arterial controlada</li><li>Diabetes tipo 2 controlada</li><li>Dislipidemia (colesterol)</li><li>Hipotiroidismo controlado</li><li>Outras doenças crónicas estáveis</li></ul>
    <div class="info"><strong>💡 O que preparar para a consulta</strong><p>Tenha consigo a lista de medicação actual, as últimas análises disponíveis e os valores de tensão arterial recentes.</p></div>
    <h2>A receita tem comparticipação do SNS?</h2>
    <p>Sim. A Receita Sem Papel emitida por videoconsulta tem o mesmo valor legal que uma receita presencial. A comparticipação é aplicada automaticamente na farmácia.</p>
    <div class="refs"><h3>Referências</h3><ol><li>INFARMED. Normas de Prescrição Eletrónica de Medicamentos. 2023.</li><li>Ordem dos Médicos. Regulamento de Telemedicina. 2020.</li></ol></div>`
},

'atestado-amamentacao': {
  title: 'Atestado de Amamentação Online em Portugal | ConsultasOnline',
  description: 'Obtenha o atestado de amamentação por videoconsulta. Direitos laborais, renovação. Emitido no próprio dia. 35€.',
  keywords: 'atestado amamentação online, atestado amamentação portugal, renovar atestado amamentação, direitos laborais amamentação',
  content: `<div class="cta-top"><p>🤱 Precisa do atestado de amamentação? Emitido por videoconsulta e enviado por email no próprio dia. <a href="/">Marcar consulta — 35€ →</a></p></div>
    <h2>O que é o atestado de amamentação?</h2>
    <p>O atestado de amamentação certifica que uma mãe está a amamentar o seu filho. É fundamental para exercer os direitos laborais de dispensa de trabalho para aleitamento previstos no Código do Trabalho (artigo 47.º).</p>
    <h2>Direitos Laborais</h2>
    <ul><li><strong>Até o filho completar 1 ano:</strong> dois períodos de 30 minutos ou 1 hora por dia</li><li><strong>Do 1.º ao 2.º ano:</strong> um período de 30 minutos por dia</li><li>Dispensa de trabalho nocturno e horas extraordinárias</li></ul>
    <div class="warn"><strong>⚠️ Renovação obrigatória</strong><p>O atestado tem validade de 3 a 6 meses. A renovação pode ser feita por videoconsulta.</p></div>
    <h2>Perguntas Frequentes</h2>
    <div class="faq"><h4>O atestado online tem validade legal?</h4><p>Sim. O documento emitido por videoconsulta tem plena validade legal junto do empregador.</p></div>
    <div class="faq"><h4>Com que frequência preciso de renovar?</h4><p>O atestado tem validade de 3 a 6 meses consoante o que o médico indicar.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>Lei n.º 7/2009. Código do Trabalho Português. Artigos 47.º e 58.º</li><li>ACT. Guia sobre Parentalidade e Trabalho. 2023.</li></ol></div>`
},

'atestado-carta-conducao': {
  title: 'Atestado Médico para Carta de Condução Online | ConsultasOnline',
  description: 'Atestado de aptidão médica para carta de condução por videoconsulta. Válido no IMT. Emitido no próprio dia. 45€.',
  keywords: 'atestado carta de condução online, exame médico carta de condução online portugal, atestado IMT online, renovação carta condução médico',
  content: `<div class="cta-top"><p>🚗 Precisa do atestado para a carta de condução? Emitido por videoconsulta e enviado ao IMT no próprio dia. <a href="/">Marcar consulta — 45€ →</a></p></div>
    <h2>Quando é obrigatório renovar?</h2>
    <ul><li><strong>Categoria B</strong> — cada 10 anos até aos 70 anos; depois dos 70, cada 2 anos</li><li><strong>Categorias C e D</strong> — cada 5 anos</li><li><strong>Primeira carta</strong> — obrigatório em todas as categorias</li><li><strong>Troca de carta estrangeira</strong> — obrigatório</li></ul>
    <div class="warn"><strong>⚠️ Exame de visão obrigatório</strong><p>É obrigatório ter um exame de visão actualizado, realizado numa óptica ou oftalmologista, antes da videoconsulta.</p></div>
    <h2>O que é avaliado?</h2>
    <ul><li><strong>Visão</strong> — acuidade binocular mínima de 0,5; campo visual de 120°</li><li><strong>Cardiovascular</strong> — condições controladas geralmente compatíveis</li><li><strong>Neurológico</strong> — epilepsia controlada sem crises há mais de 1 ano geralmente aceite</li><li><strong>Diabetes</strong> — controlada é compatível com a condução</li></ul>
    <h2>Perguntas Frequentes</h2>
    <div class="faq"><h4>O atestado é enviado directamente ao IMT?</h4><p>Sim. O médico envia o atestado electrónico directamente ao IMT no final da consulta.</p></div>
    <div class="faq"><h4>Serve para primeira carta e troca de carta estrangeira?</h4><p>Sim. O mesmo atestado serve para qualquer situação.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>Decreto-Lei n.º 40/2020. Regulamento de Habilitação Legal para Conduzir.</li><li>IMT. Guia de Renovação de Carta de Condução. 2023.</li></ol></div>`
},

'faltas-trabalho': {
  title: 'Faltas ao Trabalho por Doença: Como Justificar | ConsultasOnline',
  description: 'Tudo sobre declarações médicas, baixas e os seus direitos como trabalhador. Declaração médica emitida online no próprio dia.',
  keywords: 'faltas trabalho doença justificar, declaração médica trabalho online, baixa médica trabalho portugal, direitos trabalhador doença',
  content: `<div class="cta-top"><p>💼 Precisa de declaração médica para o trabalho? Emitida por videoconsulta no próprio dia. <a href="/">Marcar consulta — 40€ →</a></p></div>
    <h2>Enquadramento Legal</h2>
    <p>As faltas ao trabalho por doença são reguladas pelo <strong>Código do Trabalho (Lei n.º 7/2009)</strong>. O trabalhador tem direito a faltar por doença sem perda de emprego, desde que cumpra as obrigações de justificação.</p>
    <h2>Documentos para Justificar Faltas</h2>
    <ul><li><strong>Declaração médica</strong> — para faltas de 1 a 3 dias</li><li><strong>CIT (baixa médica)</strong> — obrigatório a partir do 4.º dia consecutivo</li></ul>
    <div class="info"><strong>📋 Prazo legal</strong><p>O CIT deve ser submetido à Segurança Social em até <strong>5 dias úteis</strong> após o início da incapacidade.</p></div>
    <h2>Subsídio de Doença</h2>
    <ul><li>Até 30 dias: <strong>55%</strong></li><li>31–90 dias: <strong>60%</strong></li><li>91–365 dias: <strong>70%</strong></li><li>Mais de 365 dias: <strong>75%</strong></li></ul>
    <div class="warn"><strong>⚠️ Protecção laboral</strong><p>Faltas justificadas por doença não podem constituir justa causa de despedimento (art. 351.º CT).</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>Lei n.º 7/2009. Código do Trabalho Português.</li><li>ISS. Guia Prático — Subsídio de Doença. 2023.</li></ol></div>`
},

'faltas-escola': {
  title: 'Faltas à Escola por Doença: Como Justificar | ConsultasOnline',
  description: 'O que diz a lei, documentos necessários e como obter declaração médica online para justificar faltas escolares. 35€.',
  keywords: 'faltas escola doença justificar, atestado falta escolar online, declaração médica escola portugal, justificar falta escolar',
  content: `<div class="cta-top"><p>🎓 Precisa de atestado para justificar falta escolar? Emitido por videoconsulta no próprio dia. <a href="/">Marcar consulta — 35€ →</a></p></div>
    <h2>O que diz a Lei</h2>
    <p>As faltas escolares por doença são reguladas pelo <strong>Estatuto do Aluno e Ética Escolar (Lei n.º 51/2012)</strong>. A justificação requer declaração médica que indique o período de incapacidade sem revelar o diagnóstico.</p>
    <h2>Documentos Aceites</h2>
    <ul><li><strong>Declaração médica</strong> — válida para qualquer número de dias</li><li><strong>Declaração dos encarregados de educação</strong> — válida até 3 dias por período letivo (ensino básico)</li></ul>
    <div class="info"><strong>📋 Prazo</strong><p>A justificação deve ser entregue ao Diretor de Turma nos <strong>3 dias úteis</strong> seguintes ao regresso.</p></div>
    <h2>Limites de Faltas</h2>
    <ul><li><strong>Ensino básico</strong> — faltas justificadas não têm consequências directas</li><li><strong>Ensino secundário</strong> — limite de 10% da carga horária de cada disciplina</li></ul>
    <h2>Perguntas Frequentes</h2>
    <div class="faq"><h4>A declaração médica online é aceite pelas escolas?</h4><p>Sim. Tem plena validade legal junto de escolas públicas e privadas em Portugal.</p></div>
    <div class="faq"><h4>Posso obter a declaração para o meu filho sem o levar ao médico?</h4><p>Sim. O encarregado de educação pode fazer a videoconsulta em nome do filho menor.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>Lei n.º 51/2012. Estatuto do Aluno e Ética Escolar.</li><li>DGE. Orientações sobre faltismo escolar. 2023.</li></ol></div>`
},

'dor-de-garganta-amigdalite': {
  title: 'Dor de Garganta e Amigdalite: Quando Tomar Antibiótico | ConsultasOnline',
  description: 'Amigdalite viral ou bacteriana? Quando precisa de antibiótico. Consulta online de amigdalite com avaliação e receita. 40€.',
  keywords: 'consulta amigdalite online, antibiótico amigdalite online, dor garganta consulta online portugal, amigdalite bacteriana viral',
  content: `<div class="cta-top"><p>🤒 Com dor de garganta intensa? Avaliação e tratamento por videoconsulta em 30 minutos. <a href="/">Marcar consulta — 40€ →</a></p></div>
    <h2>Vírica ou Bacteriana?</h2>
    <p>Até <strong>80% das faringoamigdalites são de origem viral</strong> e não beneficiam de antibiótico. Distinguir a causa é fundamental para evitar o uso desnecessário de antibióticos.</p>
    <h2>Critérios de Centor</h2>
    <ul><li>Exsudado amigdalino — <strong>+1 ponto</strong></li><li>Adenopatias cervicais dolorosas — <strong>+1 ponto</strong></li><li>Ausência de tosse — <strong>+1 ponto</strong></li><li>Febre ≥38°C — <strong>+1 ponto</strong></li></ul>
    <p>Score ≥3: considerar antibiótico. Score ≤1: causa viral provável — antibiótico não indicado.</p>
    <div class="warn"><strong>🚨 Abcesso Periamigdalino — Urgência</strong><p>Trismo, voz "engrolada" e desvio da úvula são sinais de emergência cirúrgica urgente. Dirija-se imediatamente às urgências.</p></div>
    <h2>Tratamento da Amigdalite Bacteriana</h2>
    <p>Amoxicilina 500mg 3×/dia, 10 dias — primeira linha (DGS). Em caso de alergia à penicilina, azitromicina é a alternativa.</p>
    <h2>Perguntas Frequentes</h2>
    <div class="faq"><h4>Posso obter antibiótico por videoconsulta?</h4><p>Sim, se o diagnóstico clínico indicar origem bacteriana.</p></div>
    <div class="faq"><h4>Este serviço é apenas para adultos?</h4><p>Sim. Para crianças, recomendamos consulta presencial de pediatria.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>DGS. Norma 007/2012: Faringoamigdalite. (atualizada 2022).</li></ol></div>`
},

'ozempic-glp1': {
  title: 'Ozempic, Mounjaro e Wegovy: Guia Completo GLP-1 | ConsultasOnline',
  description: 'Semaglutido, tirzepatido — eficácia, segurança e quem pode tomar. O guia médico completo sobre os medicamentos GLP-1.',
  keywords: 'ozempic portugal, wegovy portugal, mounjaro portugal, semaglutido tirzepatido guia, glp-1 obesidade portugal',
  content: `<div class="cta-top"><p>💉 Quer saber se é candidato a Mounjaro ou Ozempic? Consulta médica de obesidade por videoconsulta. <a href="/">Marcar consulta — 55€ →</a></p></div>
    <h2>A Revolução dos Agonistas GLP-1</h2>
    <p>O semaglutido (Ozempic/Wegovy) e o tirzepatido (Mounjaro) representam a maior evolução no tratamento farmacológico da obesidade em décadas.</p>
    <h2>Ozempic vs Wegovy</h2>
    <ul><li><strong>Ozempic</strong> — aprovado para diabetes tipo 2; usado off-label para perda de peso</li><li><strong>Wegovy</strong> — aprovado especificamente para obesidade (IMC ≥30)</li></ul>
    <div class="info"><strong>📊 Estudo STEP 1 (NEJM, 2021)</strong><p>O semaglutido 2,4mg causou redução média de 14,9% do peso corporal vs. 2,4% no placebo.</p></div>
    <h2>Mounjaro — Dupla Acção GLP-1/GIP</h2>
    <p>No estudo SURMOUNT-1, o tirzepatido 15mg atingiu reduções de até 22,5% do peso corporal em 72 semanas.</p>
    <div class="warn"><strong>⚠️ Contraindicações</strong><p>Gravidez, aleitamento, história de carcinoma medular da tiróide. Exige sempre prescrição médica.</p></div>
    <h2>Perguntas Frequentes</h2>
    <div class="faq"><h4>Posso obter Mounjaro por videoconsulta?</h4><p>Sim. A médica avalia o seu caso e, se indicado, emite a receita por email.</p></div>
    <div class="faq"><h4>Quanto custa o Mounjaro em Portugal?</h4><p>Sem comparticipação do SNS para obesidade. O preço varia entre 180€ e 280€ por mês.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>Wilding JPH, et al. Once-Weekly Semaglutide in Obesity. N Engl J Med. 2021.</li><li>Jastreboff AM, et al. Tirzepatide for Obesity. N Engl J Med. 2022.</li></ol></div>`
},

'doencas-sexualmente-transmissiveis': {
  title: 'Doenças Sexualmente Transmissíveis: Rastreio Online | ConsultasOnline',
  description: 'Rastreio de DST/IST de forma discreta e confidencial. VIH, sífilis, gonorreia, clamídia — pedido de análises online. 40€.',
  keywords: 'rastreio DST online portugal, teste IST online discreto, consulta DST IST online confidencial, VIH rastreio online',
  content: `<div class="cta-top"><p>🔬 Quer fazer rastreio de IST de forma discreta? Consulta confidencial por videoconsulta. <a href="/">Marcar consulta — 40€ →</a></p></div>
    <h2>As IST Mais Frequentes</h2>
    <h3>VIH</h3><p>A PrEP reduz o risco de transmissão em mais de 99%. Rastreio recomendado a todos os adultos sexualmente activos.</p>
    <h3>Gonorreia</h3><p>Frequentemente assintomática na mulher. Tratamento: ceftriaxona 500mg IM dose única.</p>
    <h3>Sífilis</h3><p>Tratamento: penicilina G benzatínica — altamente eficaz.</p>
    <h3>Clamídia</h3><p>IST bacteriana mais prevalente. Tratamento: azitromicina 1g dose única.</p>
    <div class="info"><strong>🔒 Total confidencialidade</strong><p>A consulta decorre em sala virtual privada, protegida pelo sigilo médico e pelo RGPD.</p></div>
    <h2>Quem deve fazer rastreio?</h2>
    <ul><li>Adultos sexualmente activos com múltiplos parceiros — rastreio anual</li><li>Após relação sexual desprotegida</li><li>Com sintomas como corrimento, ardor ou úlceras genitais</li></ul>
    <div class="refs"><h3>Referências</h3><ol><li>ECDC. STI in Europe, 2022. 2023.</li><li>IUSTI. European Guidelines on Common STIs. 2023.</li></ol></div>`
},

'cessacao-tabagica': {
  title: 'Como Parar de Fumar: Guia Médico Completo | ConsultasOnline',
  description: 'Vareniclina, bupropiona, TSN — os tratamentos com maior evidência para parar de fumar. Consulta com prescrição médica. 40€.',
  keywords: 'cessação tabágica online portugal, consulta parar fumar online, vareniclina prescrição online, champix online portugal',
  content: `<div class="cta-top"><p>🚭 Pronto para deixar de fumar? Consulta com prescrição médica por videoconsulta. <a href="/">Marcar consulta — 40€ →</a></p></div>
    <h2>Porque é tão difícil parar de fumar?</h2>
    <p>A dependência do tabaco é uma doença crónica. Sem apoio médico, apenas 3 a 5% dos fumadores conseguem parar de forma sustentada ao fim de um ano.</p>
    <h2>Tratamentos com Maior Evidência</h2>
    <h3>1. Vareniclina (Champix)</h3><p>Primeira linha com maior taxa de sucesso. Em meta-análise Cochrane, duplica a probabilidade de cessação vs. placebo. Duração: 12 semanas.</p>
    <h3>2. Bupropiona</h3><p>Alternativa eficaz, especialmente com depressão associada. Contraindicado em epilepsia.</p>
    <h3>3. Terapêutica de Substituição Nicotínica</h3><p>Adesivos, pastilhas e inalador. A combinação de adesivo com pastilha de resgate é mais eficaz.</p>
    <h2>Benefícios de Parar de Fumar</h2>
    <ul><li><strong>1 ano</strong> — risco cardíaco reduzido a metade</li><li><strong>5 anos</strong> — risco de AVC igual ao de não fumador</li><li><strong>10 anos</strong> — risco de cancro do pulmão reduzido a metade</li></ul>
    <div class="refs"><h3>Referências</h3><ol><li>Cahill K, et al. Pharmacological interventions for smoking cessation. Cochrane. 2013.</li><li>DGS. Programa Nacional para a Prevenção e Controlo do Tabagismo. 2022.</li></ol></div>`
},

'consulta-online': {
  title: 'Consulta Online em Portugal: O Guia Completo | ConsultasOnline',
  description: 'O que é, como funciona, quanto custa e o que pode tratar numa consulta médica online em Portugal.',
  keywords: 'consulta online portugal, como funciona consulta online, consulta médica online portugal guia, teleconsulta portugal',
  content: `<div class="cta-top"><p>🩺 Precisa de consulta online hoje? Disponível de segunda a domingo, das 9h às 21h. <a href="/">Marcar consulta →</a></p></div>
    <h2>O que é uma consulta online?</h2>
    <p>Uma consulta online é uma consulta médica realizada por videochamada. O médico avalia os sintomas, faz o diagnóstico e emite tratamento, atestados ou certificados de baixa médica — tudo digitalmente, no próprio dia.</p>
    <h2>O que se pode tratar?</h2>
    <ul><li><strong>Baixa médica</strong> — emissão e renovação do CIT</li><li><strong>Acompanhamento crónico</strong> — renovação de tratamento</li><li><strong>Atestados</strong> — amamentação, falta escolar, carta de condução</li><li><strong>Infeção urinária</strong> — diagnóstico e tratamento</li><li><strong>Amigdalite</strong> — avaliação e tratamento</li><li><strong>Cessação tabágica</strong> — avaliação e prescrição</li><li><strong>Rastreio de DST</strong> — pedido de análises confidencial</li><li><strong>Obesidade</strong> — prescrição de Mounjaro se indicado</li></ul>
    <h2>Quanto custa?</h2>
    <ul><li><strong>Atestados</strong> — 35€ a 45€</li><li><strong>Consultas online</strong> — 40€ a 55€</li></ul>
    <p>Todos os preços incluem fatura AT, isenta de IVA (art. 9.º CIVA).</p>
    <div class="refs"><h3>Referências</h3><ol><li>Portaria n.º 115/2021. CIT por teleconsulta.</li><li>Ordem dos Médicos. Regulamento de Telemedicina. 2020.</li></ol></div>`
},

'medico-online': {
  title: 'Médico Online em Portugal: Como Funciona | ConsultasOnline',
  description: 'Vantagens do médico online, o que pode pedir, segurança e sigilo médico. Como escolher uma plataforma de confiança.',
  keywords: 'médico online portugal, médico online videoconsulta, médico online mbway portugal, teleconsulta médico portugal',
  content: `<div class="cta-top"><p>👨‍⚕️ Precisa de médico online? Disponível de segunda a domingo, das 9h às 21h. <a href="/">Marcar consulta →</a></p></div>
    <h2>O que é um médico online?</h2>
    <p>Um médico online é um profissional de saúde devidamente habilitado e registado na Ordem dos Médicos que realiza consultas por videochamada, com as mesmas obrigações deontológicas que os médicos presenciais.</p>
    <h2>Vantagens</h2>
    <ul><li><strong>Sem filas</strong> — marcação imediata, consulta no mesmo dia</li><li><strong>Sem deslocação</strong> — consulta a partir de casa</li><li><strong>Documentos digitais</strong> — baixas e atestados por email</li><li><strong>Fatura automática</strong> — válida para reembolso em seguros de saúde</li></ul>
    <div class="info"><strong>💡 Seguros de saúde</strong><p>A maioria dos seguros privados em Portugal (Médis, AdvanceCare, Multicare, Fidelidade) aceita faturas de teleconsulta para reembolso.</p></div>
    <h2>Segurança e sigilo médico</h2>
    <p>As consultas decorrem em salas virtuais privadas, não são gravadas. Toda a informação clínica está protegida pelo sigilo médico e pelo RGPD.</p>
    <div class="refs"><h3>Referências</h3><ol><li>Ordem dos Médicos. Regulamento de Telemedicina. 2020.</li><li>Lei n.º 58/2019. RGPD — Proteção de dados pessoais.</li></ol></div>`
},

'telemedicina': {
  title: 'Telemedicina em Portugal: O que É e Direitos do Utente | ConsultasOnline',
  description: 'Como funciona a telemedicina em Portugal, diferenças entre SNS e privado e os seus direitos como utente.',
  keywords: 'telemedicina portugal, telemedicina como funciona, teleconsulta portugal direitos utente, telemedicina SNS privado',
  content: `<div class="cta-top"><p>💻 Quer experimentar uma teleconsulta? Videoconsulta no browser, sem instalar nada. <a href="/">Marcar consulta →</a></p></div>
    <h2>O que é a telemedicina?</h2>
    <p>A telemedicina é a prestação de cuidados de saúde à distância com recurso a tecnologias de comunicação. Em Portugal está regulamentada pela Ordem dos Médicos e pelo Ministério da Saúde.</p>
    <h2>O que mudou com a telemedicina em Portugal</h2>
    <ul><li><strong>Baixa médica por teleconsulta</strong> — Portaria n.º 115/2021</li><li><strong>Receita electrónica</strong> — emitida após teleconsulta, enviada por email</li><li><strong>Atestados digitais</strong> — validade legal total</li></ul>
    <h2>SNS vs privada</h2>
    <p><strong>SNS:</strong> teleconsultas gratuitas mas com tempos de espera elevados e dependência de médico de família.</p>
    <p><strong>Privada:</strong> marcação imediata, horários alargados, emissão de documentos no próprio dia. Custo entre 35€ e 55€, parcialmente reembolsável por seguros de saúde.</p>
    <h2>Direitos do utente</h2>
    <ul><li>Sigilo médico total</li><li>Consentimento informado</li><li>Protecção de dados (RGPD)</li><li>Direito à fatura</li></ul>
    <div class="warn"><strong>⚠️ Limitações</strong><p>A telemedicina não substitui a consulta presencial em situações de urgência. Em caso de dúvida, ligue 112 ou SNS 24 (808 24 24 24).</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>Ordem dos Médicos. Regulamento de Telemedicina. 2020.</li><li>Portaria n.º 115/2021. Ministério da Saúde.</li></ol></div>`
},

'atestado-rastreio-saude': {
  title: 'Rastreio de Saúde em Portugal: O Guia Completo | ConsultasOnline',
  description: 'Rastreios recomendados pela DGS por idade e sexo, vacinação do adulto e como fazer rastreio de IST de forma discreta.',
  keywords: 'rastreio saúde portugal, exames preventivos portugal, rastreio oncológico portugal, check-up médico online portugal',
  content: `<div class="cta-top"><p>🩺 Quer fazer um rastreio de saúde? Consulta online com pedido de análises personalizado. <a href="/">Marcar consulta — 40€ →</a></p></div>
    <h2>O que é o rastreio de saúde?</h2>
    <p>O rastreio é a pesquisa de doenças em pessoas sem sintomas, com o objectivo de detectar precocemente condições que têm melhor prognóstico quando tratadas a tempo.</p>
    <h2>Rastreios Recomendados</h2>
    <h3>Para todos os adultos</h3>
    <ul><li><strong>Tensão arterial</strong> — medição anual a partir dos 18 anos</li><li><strong>Glicemia</strong> — cada 3 anos a partir dos 45 anos</li><li><strong>Colesterol</strong> — cada 5 anos a partir dos 20 anos</li></ul>
    <h3>Para mulheres</h3>
    <ul><li><strong>Mamografia</strong> — dos 50 aos 69 anos, de 2 em 2 anos</li><li><strong>Citologia cervical</strong> — dos 25 aos 60 anos, de 3 em 3 anos</li></ul>
    <h3>A partir dos 50 anos</h3>
    <ul><li><strong>Cancro do cólon</strong> — pesquisa de sangue oculto nas fezes de 2 em 2 anos</li></ul>
    <div class="info"><strong>💡 Rastreios oncológicos gratuitos</strong><p>Os rastreios oncológicos são gratuitos para a população-alvo. Responda sempre às convocatórias do SNS.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>DGS. Programa Nacional para as Doenças Oncológicas. 2022.</li><li>DGS. Programa Nacional de Vacinação 2024.</li></ol></div>`
},

'renovar-pilula-anticoncecional-online': {
  title: 'Renovar a Pílula Anticoncecional Online em Portugal | ConsultasOnline',
  description: 'Saiba como renovar a receita da pílula por videoconsulta em Portugal. Legal, seguro, sem médico de família. Receita Sem Papel no próprio dia. 40€.',
  keywords: 'renovar pílula anticoncecional online, receita pílula online portugal, pílula sem médico de família, videoconsulta pílula portugal',
  content: `<div class="cta-top"><p>💊 Precisa de renovar a pílula? Receita no email no próprio dia, sem médico de família. <a href="/">Marcar consulta — 40€ →</a></p></div>
    <h2>É legal renovar a pílula por videoconsulta?</h2>
    <p>Sim. A prescrição por telemedicina está regulamentada em Portugal desde 2020. A médica emite a Receita Sem Papel directamente no sistema do SNS — válida em qualquer farmácia com a comparticipação do SNS.</p>
    <h2>Quem pode renovar online?</h2>
    <ul><li>Mulheres adultas que já tomam a mesma pílula há 6 meses ou mais</li><li>Tensão arterial normal</li><li>Sem sintomas novos nem alterações de saúde relevantes</li><li>Não fumadoras com mais de 35 anos</li></ul>
    <h2>O que preparar</h2>
    <ul><li>Nome comercial da pílula actual</li><li>Há quanto tempo toma esta pílula</li><li>Data da última menstruação</li><li>Lista de outros medicamentos</li></ul>
    <h2>Perguntas Frequentes</h2>
    <div class="faq"><h4>Posso renovar sem médico de família?</h4><p>Sim. A consulta online funciona completamente independente do SNS.</p></div>
    <div class="faq"><h4>Posso pedir receita para 6 meses?</h4><p>Sim. A médica pode emitir receita para até 6 embalagens numa só consulta.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>INFARMED. Normas de Prescrição Eletrónica. 2023.</li><li>DGS. Orientação n.º 004/2021 — Contraceção Hormonal Combinada.</li><li>FSRH Guideline: Combined Hormonal Contraception. 2023.</li></ol></div>`
},

'baixa-medica-freelancer': {
  title: 'Baixa Médica para Trabalhadores Independentes: Guia Completo | ConsultasOnline',
  description: 'Tens direito a baixa médica sendo freelancer? Como funciona o CIT, o subsídio de doença e como resolver tudo por videoconsulta.',
  keywords: 'baixa médica freelancer portugal, baixa médica trabalhador independente, CIT recibos verdes, subsídio doença freelancer',
  content: `<div class="cta-top"><p>💼 Trabalhas por conta própria e precisas de baixa médica? CIT emitido por videoconsulta em 20 minutos. <a href="/">Marcar consulta — 55€ →</a></p></div>
    <h2>Tens direito a baixa médica sendo freelancer?</h2>
    <p>Sim. Qualquer trabalhador independente inscrito na Segurança Social tem direito ao subsídio de doença, desde que cumpra os requisitos legais.</p>
    <h2>Requisitos</h2>
    <ul><li>Inscrito na Segurança Social como trabalhador independente</li><li>Pelo menos 6 meses de contribuições</li><li>CIT emitido por um médico</li><li>Não em regime de isenção de contribuições</li></ul>
    <div class="warn"><strong>⚠️ Atenção</strong><p>Se estás isento de contribuições não tens direito ao subsídio. Ainda assim podes emitir o CIT para justificar a ausência junto de clientes.</p></div>
    <h2>Quanto vale o subsídio?</h2>
    <p><strong>55%</strong> da remuneração de referência (média dos últimos 6 meses). Nos primeiros 3 dias de doença não há subsídio.</p>
    <h2>Perguntas Frequentes</h2>
    <div class="faq"><h4>Posso fazer baixa sem médico de família?</h4><p>Sim. Qualquer médico registado na Ordem dos Médicos pode emitir o CIT.</p></div>
    <div class="faq"><h4>Posso deduzir a consulta no IRS?</h4><p>Sim. É uma despesa de saúde dedutível no IRS.</p></div>
    <div class="refs"><h3>Referências</h3><ol><li>Segurança Social. Subsídio de Doença — Trabalhadores Independentes.</li><li>Portaria n.º 115/2021. CIT por teleconsulta.</li></ol></div>`
},

'sem-medico-familia-freelancer': {
  title: 'Sem Médico de Família: Guia Completo para Freelancers em Portugal | ConsultasOnline',
  description: 'O que podes e não podes fazer sem médico de família em Portugal. Soluções práticas para freelancers e trabalhadores remotos.',
  keywords: 'sem médico de família portugal, alternativas médico de família, lista espera médico família, médico online sem médico família freelancer',
  content: `<div class="cta-top"><p>🏠 Não tens médico de família? A consulta online funciona independentemente do SNS. <a href="/">Marcar consulta →</a></p></div>
    <h2>Porque os freelancers ficam sem médico de família</h2>
    <p>Em Portugal, mais de 1 milhão de pessoas não têm médico de família atribuído. Entre freelancers, a percentagem é ainda mais elevada — mudanças de morada frequentes e listas de espera intermináveis.</p>
    <h2>O que podes fazer sem médico de família</h2>
    <ul><li><strong>Baixa médica (CIT)</strong> — por videoconsulta com qualquer médico da Ordem</li><li><strong>Renovação de medicação crónica</strong> — receita enviada por email</li><li><strong>Atestados médicos</strong> — amamentação, carta de condução, falta escolar</li><li><strong>Rastreio de saúde</strong> — pedido de análises por videoconsulta</li></ul>
    <h2>O que NÃO podes fazer sem médico de família</h2>
    <ul><li>Rastreios oncológicos gratuitos do SNS</li><li>Referenciação para especialidade pelo SNS</li><li>Prescrição de medicamentos de dispensa hospitalar</li></ul>
    <h2>Custos e reembolsos</h2>
    <p>Videoconsulta entre 35€ e 55€. Fatura AT dedutível no IRS e aceite pela maioria dos seguros de saúde privados.</p>
    <div class="refs"><h3>Referências</h3><ol><li>SNS. Inscrição no Centro de Saúde. sns24.gov.pt.</li><li>Segurança Social. Trabalhadores Independentes — Prestações.</li></ol></div>`
},

'dia-saude-2026': {
  title: 'Dia Mundial da Saúde 2026: Juntos pela Ciência | ConsultasOnline',
  description: '7 de Abril — o que significa este dia, qual o tema da OMS em 2026 e o que pode fazer hoje pela sua saúde em Portugal.',
  keywords: 'dia mundial saúde 2026, OMS saúde 2026, saúde portugal 2026, telemedicina ciência portugal',
  content: `<div class="cta-top"><p>🌍 Cuide da sua saúde hoje. Consultas médicas online disponíveis de segunda a domingo. <a href="/">Marcar consulta →</a></p></div>
    <h2>7 de Abril — Dia Mundial da Saúde</h2>
    <p>Celebrado anualmente desde 1948, o Dia Mundial da Saúde assinala a fundação da OMS. Em 2026, o tema é <strong>"Juntos pela Ciência"</strong> — um apelo global à confiança na evidência científica.</p>
    <h2>Os maiores desafios de saúde em Portugal em 2026</h2>
    <h3>Doenças crónicas</h3>
    <p>Doenças cardiovasculares, diabetes, cancro e doenças respiratórias são as principais causas de morte em Portugal — a maioria prevenível com rastreio precoce.</p>
    <h3>Resistência antimicrobiana</h3>
    <p>O uso excessivo de antibióticos cria bactérias resistentes. As guidelines da DGS recomendam uso criterioso — por isso o médico avalia sempre se o antibiótico é realmente necessário.</p>
    <h3>Acesso aos cuidados</h3>
    <p>Mais de um milhão de portugueses não tem médico de família. A telemedicina é uma resposta validada para melhorar o acesso.</p>
    <h2>O que pode fazer hoje</h2>
    <ul><li>Rastreio preventivo — tensão arterial, glicemia, colesterol</li><li>Vacinação actualizada</li><li>Não interromper medicação crónica sem consultar médico</li></ul>
    <div class="refs"><h3>Referências</h3><ol><li>OMS. World Health Day 2026. who.int.</li><li>DGS. Programa Nacional de Saúde 2030.</li></ol></div>`
}

};

// Função que gera a página HTML completa de cada artigo para SSR
function buildArticleSSR(slug, data) {
  const canonical = 'https://www.consultas-online.pt/artigos/' + slug;
  const related = Object.entries(ARTICLES)
    .filter(([s]) => s !== slug)
    .slice(0, 4)
    .map(([s, a]) => {
      const c = ARTICLES_CONTENT[s];
      return c ? '<li><a href="/artigos/' + s + '">' + c.title.split('|')[0].trim() + '</a></li>' : '';
    }).join('');

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${data.title}</title>
<meta name="description" content="${data.description}"/>
<meta name="keywords" content="${data.keywords}"/>
<meta name="robots" content="index, follow"/>
<link rel="canonical" href="${canonical}"/>
<meta property="og:type" content="article"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:title" content="${data.title}"/>
<meta property="og:description" content="${data.description}"/>
<meta property="og:locale" content="pt_PT"/>
<meta property="og:site_name" content="ConsultasOnline"/>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MedicalWebPage",
  "name": "${data.title.split('|')[0].trim()}",
  "description": "${data.description}",
  "url": "${canonical}",
  "inLanguage": "pt-PT",
  "isPartOf": {"@type":"MedicalBusiness","name":"ConsultasOnline","url":"https://www.consultas-online.pt"}
}
<\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;color:#334155;background:#fff;line-height:1.7}
nav{background:#0b1d35;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
nav .logo{color:#fff;text-decoration:none;font-size:18px;font-weight:700}
nav .logo span{color:#17c4a8}
nav .nav-btn{background:#0d7377;color:#fff;text-decoration:none;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600}
.wrap{max-width:780px;margin:0 auto;padding:40px 24px 80px}
.breadcrumb{font-size:13px;color:#8a9bb0;margin-bottom:20px}
.breadcrumb a{color:#0d7377;text-decoration:none}
.cat{display:inline-block;background:rgba(13,115,119,.08);color:#0d7377;font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px;letter-spacing:.4px;text-transform:uppercase;margin-bottom:12px}
h1{font-size:clamp(26px,4vw,40px);color:#0b1d35;line-height:1.2;margin-bottom:20px}
h2{font-size:24px;color:#0b1d35;margin:32px 0 12px}
h3{font-size:18px;color:#0b1d35;margin:20px 0 8px}
p{margin-bottom:14px;font-size:15px}
ul,ol{margin:10px 0 16px 22px}
li{margin-bottom:7px;font-size:15px}
a{color:#0d7377}
.cta-top{background:linear-gradient(135deg,rgba(13,115,119,.08),rgba(23,196,168,.08));border:1px solid rgba(13,115,119,.2);border-radius:10px;padding:14px 18px;margin-bottom:28px;font-size:14px}
.cta-top a{font-weight:700;color:#0d7377}
.info{background:#f4f7fb;border-left:4px solid #0d7377;border-radius:0 10px 10px 0;padding:14px 18px;margin:18px 0}
.info p{margin:4px 0 0;font-size:14px}
.warn{background:rgba(214,158,46,.07);border-left:4px solid #d97706;border-radius:0 10px 10px 0;padding:14px 18px;margin:18px 0}
.warn p{margin:4px 0 0;font-size:14px}
.faq{border:1px solid #dde6f0;border-radius:10px;padding:14px 18px;margin-bottom:10px}
.faq h4{font-size:14px;font-weight:600;color:#0b1d35;margin-bottom:6px}
.faq p{margin:0;font-size:13.5px;color:#4a5568}
.refs{background:#f4f7fb;border-radius:10px;padding:20px 24px;margin-top:40px}
.refs h3{font-size:18px;color:#0b1d35;margin-bottom:12px}
.refs ol{margin-left:18px}
.refs li{font-size:13px;color:#64748b;margin-bottom:6px}
.cta-bottom{background:linear-gradient(135deg,#0b1d35,#1a3a5c);border-radius:14px;padding:32px;text-align:center;margin:40px 0}
.cta-bottom h3{font-size:24px;color:#fff;margin-bottom:8px}
.cta-bottom p{font-size:14px;color:rgba(255,255,255,.6);margin-bottom:18px}
.cta-bottom a{display:inline-block;background:linear-gradient(135deg,#0d7377,#17c4a8);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:700}
.related{margin-top:48px;padding-top:32px;border-top:1px solid #e2e8f0}
.related h3{font-size:18px;color:#0b1d35;margin-bottom:14px}
.related ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.related ul li a{color:#0d7377;font-size:14px;text-decoration:none;font-weight:500}
.related ul li a:hover{text-decoration:underline}
footer{background:#0b1d35;padding:28px 24px;text-align:center;font-size:13px;color:rgba(255,255,255,.45)}
footer a{color:rgba(255,255,255,.6);text-decoration:none;margin:0 8px}
</style>
</head>
<body>
<nav>
  <a href="/" class="logo">Consultas<span>Online</span></a>
  <a href="/" class="nav-btn">Marcar Consulta</a>
</nav>
<div class="wrap">
  <div class="breadcrumb"><a href="/">Início</a> › <a href="/artigos">Artigos de Saúde</a> › ${data.title.split('|')[0].trim()}</div>
  <div class="cat">${ARTICLES[slug] ? ARTICLES[slug].category : 'Saúde'}</div>
  <h1>${data.title.split('|')[0].trim()}</h1>
  ${data.content}
  <div class="cta-bottom">
    <h3>Precisa de consulta médica online?</h3>
    <p>Disponível de segunda a domingo, das 9h às 21h. Fatura AT automática incluída.</p>
    <a href="/">Marcar Consulta Agora →</a>
  </div>
  <div class="related">
    <h3>Artigos Relacionados</h3>
    <ul>${related}</ul>
  </div>
</div>
<footer>
  <a href="/">ConsultasOnline</a>
  <a href="/artigos">Artigos de Saúde</a>
  <a href="/artigos/consulta-online">Consulta Online</a>
  <a href="/artigos/baixa-medica">Baixa Médica</a>
  <br/><br/>© 2026 ConsultasOnline · geral@consultas-online.pt
</footer>
<script>
// Guarda o artigo para a SPA mas não redireciona — a página SSR é a versão principal
if (typeof sessionStorage !== 'undefined') {
  sessionStorage.setItem('openArticle', '${ARTICLES[slug] ? ARTICLES[slug].id : slug}');
}
</script>
</body>
</html>`;
}

// Rota de listagem
app.get('/artigos', (req, res) => {
  const links = Object.entries(ARTICLES_CONTENT).map(([slug, art]) =>
    '<li><a href="/artigos/' + slug + '" style="color:#0d7377;font-size:15px">' + art.title.split('|')[0].trim() + '</a></li>'
  ).join('');
  res.send(`<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Artigos de Saúde | ConsultasOnline</title>
<meta name="description" content="Artigos médicos sobre consulta online, baixa médica, atestados e muito mais. Informação baseada em evidência científica."/>
<meta name="robots" content="index, follow"/>
<link rel="canonical" href="https://www.consultas-online.pt/artigos"/>
<style>body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:40px 20px;color:#334155}a{color:#0d7377}h1{color:#0b1d35;margin-bottom:24px}ul{line-height:2.4;padding-left:18px}</style>
</head><body>
<p><a href="/">← ConsultasOnline</a></p>
<h1>Artigos de Saúde</h1>
<ul>${links}</ul>
</body></html>`);
});

// Rota individual — SSR completo
app.get('/artigos/:slug', (req, res) => {
  const slug = req.params.slug;
  const data = ARTICLES_CONTENT[slug];
  if (!data) return res.redirect(301, '/');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildArticleSSR(slug, data));
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
      payment_method_types: ['card', 'mb_way'],
      allow_promotion_codes: true,
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
      console.log('WEBHOOK passo 4 - customerName:', customerName, 'customerEmail:', customerEmail);
      
      let invoiceData = null;
      if (customerName && customerEmail) {
        invoiceData = await createInvoice({ customerName, customerEmail, nif, serviceName, amount: session.amount_total / 100, date: new Date().toISOString().split('T')[0] });
      } else {
        console.warn('Fatura ignorada: nome ou email em falta', { customerName, customerEmail });
      }

     // 5. Enviar email ao utente
      if (customerEmail) {
        try {
          console.log('SendGrid a enviar email para:', customerEmail);
          console.log('SendGrid FROM_EMAIL:', process.env.FROM_EMAIL);
          console.log('SendGrid API KEY (primeiros 10):', process.env.SENDGRID_API_KEY ? process.env.SENDGRID_API_KEY.substring(0,10) : 'NAO DEFINIDA');
          await sendConfirmationEmail({ to: customerEmail, name: customerName || 'Utente', serviceName, date, time, amountEur, meetLink, invoiceUrl: invoiceData && invoiceData.url, invoiceNum: invoiceData && invoiceData.invoiceNumber });
          console.log('SendGrid email confirmacao enviado com sucesso para:', customerEmail);
        } catch (sgErr) {
          console.error('SendGrid ERRO ao enviar confirmacao:', sgErr.message);
          console.error('SendGrid ERRO detalhe:', JSON.stringify(sgErr.response && sgErr.response.body));
        }
      } else {
        console.warn('Email ignorado: endereco em falta');
      }

      // 6. Notificacao para a medica
      const notifyEmail = process.env.NOTIFY_EMAIL;
      if (notifyEmail) {
        try {
          console.log('SendGrid a enviar notificacao para:', notifyEmail);
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
          console.log('Notificacao enviada com sucesso para:', notifyEmail);
        } catch(ne) {
          console.error('Erro notificacao medica:', ne.message);
          console.error('Erro notificacao detalhe:', JSON.stringify(ne.response && ne.response.body));
        }
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
            'https://' + account + '.app.invoicexpress.com/clients.json?api_key=' + apiKey + '&client_email=' + encodeURIComponent(safeEmail)
          );
          const clients = searchRes.data && searchRes.data.clients;
          console.log('InvoiceXpress pesquisa por email resultado:', JSON.stringify(searchRes.data).substring(0, 1000));
          const matchedClient = clients && clients.find(c => c.email && c.email.toLowerCase() === safeEmail.toLowerCase());
          console.log('InvoiceXpress matchedClient:', matchedClient ? JSON.stringify(matchedClient) : 'nenhum');

          if (matchedClient) {
            clientId = matchedClient.id;
            console.log('InvoiceXpress cliente existente encontrado:', clientId);
            try {
              await axios.put(
                'https://' + account + '.app.invoicexpress.com/clients/' + clientId + '.json?api_key=' + apiKey,
                { client: { name: safeName, email: safeEmail } }
              );
              console.log('InvoiceXpress nome do cliente actualizado:', safeName);
            } catch (updateErr) {
              console.warn('InvoiceXpress aviso: nao foi possivel actualizar o nome:', updateErr.message);
            }
          } else {
            console.error('InvoiceXpress: cliente nao encontrado na pesquisa por email');
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

      writeJ('Eu, Dra. Patricia Mendonca Ferraz, médica inscrita na Ordem dos Médicos com a cédula profissional n. 57713, atesto que:', { after: 10 });

      if (tipo === 'amamentacao') {
        writeJ('A utente', { after: 4 });
        writeName(dados.nome_utente);
        writeJ('nascida em ' + (dados.data_nasc_utente||'') + ', portadora do Cartão de Cidadão n. ' + (dados.cc_utente||'') + ', encontra-se atualmente em período de amamentação do(a) seu(sua) filho(a)', { after: 4 });
        writeName(dados.nome_filho);
        writeJ('nascido(a) em ' + (dados.data_nasc_filho||'') + '.', { after: 16 });
        writeJ('Este atestado é passado a pedido da interessada para os devidos efeitos legais.', { after: 4 });
      } else {
        writeJ('O(a) utente', { after: 4 });
        writeName(dados.nome_utente);
        writeJ('nascido(a) em ' + (dados.data_nasc_utente||'') + ', portador(a) do Cartão de Cidadão n. ' + (dados.cc_utente||'') + ', necessita de afastamento das atividades escolares no período compreendido entre ' + (dados.data_inicio||'') + ' e ' + (dados.data_fim||'') + ' por motivos de doença.', { after: 16 });
        writeJ('Este atestado é passado a pedido do(a) interessado(a) para os devidos efeitos legais.', { after: 4 });
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
        { nome: name, email, fonte: 'ebook-saude-em-dia', marketing: req.body.marketing || false, criadoEm: new Date() },
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
        <p><strong>Marketing:</strong> ${req.body.marketing ? '✅ Aceitou receber promoções e novidades' : '❌ Não aceitou receber promoções'}</p>
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
        { nome: name, email, fonte: 'ebook-saude-em-dia', marketing: req.body.marketing || false, criadoEm: new Date() },
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
      html: `<html><body style="font-family:Arial,sans-serif;padding:20px">
        <p><strong>Nome:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Fonte:</strong> Guia Primeiros Socorros</p>
        <p><strong>Marketing:</strong> ${req.body.marketing ? '✅ Aceitou receber promoções e novidades' : '❌ Não aceitou receber promoções'}</p>
        <p><strong>Data:</strong> ${new Date().toLocaleString('pt-PT')}</p>
        </body></html>`,
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
        { nome: name, email, fonte: 'ebook-saude-em-dia', marketing: req.body.marketing || false, criadoEm: new Date() },
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
        <p><strong>Marketing:</strong> ${req.body.marketing ? '✅ Aceitou receber promoções e novidades' : '❌ Não aceitou receber promoções'}</p>
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
  <h1>Atestado de Amament&aacute;&ccedil;&atilde;o<br/>Online</h1>
  <p>Documento com validade legal emitido por videoconsulta e enviado por email no pr&oacute;prio dia. Sem desloca&ccedil;&atilde;o.</p>
  <div class="price">35&euro;</div>
  <a class="btn" href="/#marcar">Obter Atestado Agora &rarr;</a>
</div>
<div class="body">
  <h2>Para que serve o atestado de amament&aacute;&ccedil;&atilde;o?</h2>
  <p>O atestado de amament&aacute;&ccedil;&atilde;o certifica que est&aacute; a amamentar o seu filho, sendo indispens&aacute;vel para exercer os direitos laborais de dispensa de trabalho para aleitamento previstos no C&oacute;digo do Trabalho (artigo 47.&ordm;).</p>

  <h2>Direitos laborais com o atestado</h2>
  <ul>
    <li><strong>At&eacute; o filho completar 1 ano:</strong> dois per&iacute;odos de 30 minutos ou 1 hora por dia</li>
    <li><strong>Do 1.&ordm; ao 2.&ordm; ano:</strong> um per&iacute;odo de 30 minutos por dia</li>
    <li>Dispensa de trabalho nocturno e horas extraordin&aacute;rias</li>
  </ul>

  <div class="box"><p>&Icirc;cone &#9888; <strong>Renova&ccedil;&atilde;o:</strong> O atestado tem validade de 3 a 6 meses. A renova&ccedil;&atilde;o pode ser feita por videoconsulta, sem desloca&ccedil;&atilde;o.</p></div>

  <h2>Como obter o atestado online</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cart&atilde;o</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta r&aacute;pida &mdash; cerca de 15 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Atestado emitido em PDF com validade legal</p></div>
    <div class="step"><div class="num">04</div><p>Documento enviado por email no pr&oacute;prio dia</p></div>
  </div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>O atestado de amament&aacute;&ccedil;&atilde;o online tem validade legal?</h4>
      <p>Sim. O documento emitido por videoconsulta tem plena validade legal junto do empregador, tal como um atestado presencial.</p>
    </div>
    <div class="faq-item">
      <h4>Preciso de m&eacute;dico de fam&iacute;lia para obter o atestado?</h4>
      <p>N&atilde;o. Qualquer m&eacute;dico registado na Ordem dos M&eacute;dicos pode emitir o atestado. A consulta online funciona independentemente do SNS.</p>
    </div>
    <div class="faq-item">
      <h4>Com que frequ&ecirc;ncia preciso de renovar?</h4>
      <p>O atestado tem validade de 3 a 6 meses consoante o que o m&eacute;dico indicar. A renova&ccedil;&atilde;o pode ser feita por videoconsulta.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Precisa do atestado de amament&aacute;&ccedil;&atilde;o hoje?</h3>
    <p>Emitido por videoconsulta e enviado por email no pr&oacute;prio dia.</p>
    <a class="btn" href="/#marcar">Marcar Consulta &mdash; 35&euro; &rarr;</a>
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
  <p>Declara&ccedil;&atilde;o m&eacute;dica para justificar aus&ecirc;ncias escolares, emitida por videoconsulta e enviada por email no pr&oacute;prio dia.</p>
  <div class="price">35&euro;</div>
  <a class="btn" href="/#marcar">Obter Atestado Agora &rarr;</a>
</div>
<div class="body">
  <h2>O que diz a lei</h2>
  <p>As faltas escolares por doen&ccedil;a s&atilde;o reguladas pelo Estatuto do Aluno e &Eacute;tica Escolar (Lei n.&ordm; 51/2012). A declara&ccedil;&atilde;o m&eacute;dica deve indicar o per&iacute;odo de incapacidade sem revelar o diagn&oacute;stico.</p>

  <h2>Prazos importantes</h2>
  <ul>
    <li>A justifica&ccedil;&atilde;o deve ser entregue ao Diretor de Turma nos <strong>3 dias &uacute;teis</strong> seguintes ao regresso</li>
    <li>No ensino secund&aacute;rio o limite de faltas &eacute; <strong>10% da carga hor&aacute;ria</strong> de cada disciplina</li>
  </ul>

  <div class="box"><p>&#10003; O atestado m&eacute;dico online tem plena validade legal junto das escolas e col&eacute;gios em Portugal.</p></div>

  <h2>Como funciona</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Marca a consulta e paga por MBWay ou cart&atilde;o</p></div>
    <div class="step"><div class="num">02</div><p>Videoconsulta r&aacute;pida &mdash; cerca de 15 minutos</p></div>
    <div class="step"><div class="num">03</div><p>Atestado emitido em PDF com validade legal</p></div>
    <div class="step"><div class="num">04</div><p>Documento enviado por email no pr&oacute;prio dia</p></div>
  </div>

  <div class="cta-box">
    <h3>Precisa do atestado para a escola hoje?</h3>
    <p>Emitido por videoconsulta e enviado por email no pr&oacute;prio dia.</p>
    <a class="btn" href="/#marcar">Marcar Consulta &mdash; 35&euro; &rarr;</a>
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
// Consulta Obesidade — Mounjaro
app.get('/consulta-obesidade-emagrecimento-online', (req, res) => {
  res.send(servicePageHTML({
    path: '/consulta-obesidade-emagrecimento-online',
    serviceId: 'consulta-obesidade',
    title: 'Consulta de Obesidade Online — Prescrição de Mounjaro em Portugal | ConsultasOnline',
    desc: 'Consulta médica de obesidade por videoconsulta. Prescrição de Mounjaro (tirzepatido) se clinicamente indicado. Avaliação IMC e comorbidades. 55€. Sem deslocação.',
    h1: 'Consulta de Obesidade e Emagrecimento Médico Online',
    price: '55',
    body: `
<div class="hero" style="padding-top:100px">
  <h1>Consulta de Obesidade<br/>e Emagrecimento M&eacute;dico Online</h1>
  <p>Avalia&ccedil;&atilde;o cl&iacute;nica para prescri&ccedil;&atilde;o de Mounjaro (tirzepatido) por videoconsulta. Sem filas, sem desloca&ccedil;&atilde;o.</p>
  <div class="price">55&euro;</div>
  <a class="btn" href="/#marcar">Marcar Consulta Agora &rarr;</a>
</div>

<div style="background:#fff3cd;border-top:4px solid #d97706;border-bottom:4px solid #d97706;padding:24px 20px;text-align:center">
  <div style="max-width:700px;margin:0 auto">
    <p style="font-size:14px;font-weight:900;color:#92400e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">&#9888;&#65039; Crit&eacute;rios de Elegibilidade — Leia antes de marcar</p>
    <p style="font-size:14px;font-weight:700;color:#92400e;margin-bottom:10px">Indicado apenas para adultos com &Iacute;ndice de Massa Corp&oacute;rea (IMC):</p>
    <ul style="list-style:none;font-size:14px;color:#92400e;line-height:2;margin-bottom:12px">
      <li>&#10003; <strong>Maior ou igual a 30 kg/m&sup2;</strong> (obesidade)</li>
      <li>&#10003; <strong>Maior ou igual a 27 kg/m&sup2;</strong> (sobrepeso) com pelo menos uma comorbidade &mdash; hipertens&atilde;o, dislipidemia, apneia do sono, doen&ccedil;a cardiovascular, pr&eacute;-diabetes ou diabetes tipo 2</li>
    </ul>
    <p style="font-size:14px;font-weight:900;color:#7f1d1d;text-transform:uppercase">&#128683; Se n&atilde;o se encontra nestas condi&ccedil;&otilde;es, N&Atilde;O ser&aacute; prescrito Mounjaro.</p>
  </div>
</div>

<div class="body">
  <h2>O que &eacute; o Mounjaro?</h2>
  <p>O Mounjaro (tirzepatido) &eacute; um medicamento injet&aacute;vel aprovado para o tratamento da obesidade e excesso de peso em adultos com comorbidades associadas. Actua em dois receptores em simult&acirc;neo (GLP-1 e GIP), tornando-o actualmente o f&aacute;rmaco com maior efic&aacute;cia demonstrada na redu&ccedil;&atilde;o de peso.</p>
  <div class="box"><p>&#128202; <strong>Estudo SURMOUNT-1 (NEJM, 2022):</strong> O tirzepatido 15mg atingiu redu&ccedil;&otilde;es m&eacute;dias de peso de at&eacute; 22,5% em 72 semanas &mdash; o resultado mais expressivo alguma vez registado num ensaio cl&iacute;nico de obesidade.</p></div>

  <h2>Mounjaro vs Ozempic &mdash; qual a diferen&ccedil;a?</h2>
  <ul>
    <li><strong>Mounjaro (tirzepatido)</strong> &mdash; actua nos receptores GLP-1 e GIP. Maior efic&aacute;cia m&eacute;dia na perda de peso. Aprovado para obesidade e diabetes tipo 2.</li>
    <li><strong>Ozempic/Wegovy (semaglutido)</strong> &mdash; actua apenas no receptor GLP-1. Muito eficaz, com vasta evid&ecirc;ncia cl&iacute;nica acumulada.</li>
  </ul>
  <p>A m&eacute;dica avalia o seu caso cl&iacute;nico e indica o medicamento mais adequado ao seu perfil.</p>

  <h2>Quem pode fazer esta consulta?</h2>
  <ul>
    <li>Adultos com IMC &ge; 30 kg/m&sup2; (obesidade)</li>
    <li>Adultos com IMC &ge; 27 kg/m&sup2; com hipertens&atilde;o, dislipidemia, apneia do sono, doen&ccedil;a cardiovascular, pr&eacute;-diabetes ou diabetes tipo 2</li>
    <li>Sem gravidez ou aleitamento</li>
    <li>Sem hist&oacute;rico de carcinoma medular da tiro&iacute;de ou NEM tipo 2</li>
  </ul>
  <div class="box" style="border-color:#e53e3e;background:rgba(229,62,62,.05)"><p>&#128683; <strong>Contraindica&ccedil;&otilde;es absolutas:</strong> Gravidez, aleitamento, hist&oacute;rico pessoal ou familiar de carcinoma medular da tiro&iacute;de, neoplasia endocrina m&uacute;ltipla tipo 2, pancreatite cr&oacute;nica activa.</p></div>

  <h2>Como funciona o tratamento</h2>
  <div class="steps">
    <div class="step"><div class="num">01</div><p>Consulta m&eacute;dica online de avalia&ccedil;&atilde;o cl&iacute;nica (55&euro;)</p></div>
    <div class="step"><div class="num">02</div><p>Prescri&ccedil;&atilde;o de Mounjaro se clinicamente indicado</p></div>
    <div class="step"><div class="num">03</div><p>Receita enviada por email &mdash; v&aacute;lida em qualquer farm&aacute;cia</p></div>
    <div class="step"><div class="num">04</div><p>Acompanhamento e ajuste de dose em consultas subsequentes</p></div>
  </div>

  <h2>Quanto custa o Mounjaro em Portugal?</h2>
  <p>O Mounjaro n&atilde;o tem comparticipa&ccedil;&atilde;o do SNS para a indica&ccedil;&atilde;o de obesidade em Portugal. O pre&ccedil;o varia consoante a dose e a farm&aacute;cia, entre aproximadamente 180&euro; e 280&euro; por m&ecirc;s. A consulta m&eacute;dica para prescri&ccedil;&atilde;o custa <strong>55&euro;</strong> e inclui avalia&ccedil;&atilde;o cl&iacute;nica completa e emiss&atilde;o da receita.</p>

  <h2>O que esperar dos resultados</h2>
  <ul>
    <li><strong>Semanas 1&ndash;4:</strong> in&iacute;cio com dose m&iacute;nima (2,5mg), adapta&ccedil;&atilde;o gastrointestinal</li>
    <li><strong>M&ecirc;s 2&ndash;3:</strong> redu&ccedil;&atilde;o not&oacute;ria do apetite e primeiros resultados de peso</li>
    <li><strong>M&ecirc;s 6:</strong> perda m&eacute;dia de 10&ndash;15% do peso corporal inicial</li>
    <li><strong>M&ecirc;s 12&ndash;18:</strong> perda m&eacute;dia de 15&ndash;22% com a dose m&aacute;xima</li>
  </ul>
  <div class="box"><p>&#128161; Os resultados variam consoante o perfil cl&iacute;nico, ades&atilde;o ao tratamento e altera&ccedil;&otilde;es do estilo de vida. O Mounjaro &eacute; um aux&iacute;lio m&eacute;dico &mdash; n&atilde;o substitui uma alimenta&ccedil;&atilde;o equilibrada e actividade f&iacute;sica regular.</p></div>

  <div class="faq">
    <h2>Perguntas Frequentes</h2>
    <div class="faq-item">
      <h4>Posso obter Mounjaro sem ir ao m&eacute;dico presencialmente?</h4>
      <p>Sim. A prescri&ccedil;&atilde;o por videoconsulta &eacute; legal em Portugal desde 2020. A m&eacute;dica avalia o seu caso e, se indicado, emite a receita por email.</p>
    </div>
    <div class="faq-item">
      <h4>Preciso de an&aacute;lises antes da consulta?</h4>
      <p>N&atilde;o &eacute; obrigat&oacute;rio mas &eacute; recomend&aacute;vel ter an&aacute;lises recentes (glicemia, fun&ccedil;&atilde;o tiro&iacute;deia, perfil lip&iacute;dico). A m&eacute;dica pode pedir an&aacute;lises na pr&oacute;pria consulta se necess&aacute;rio.</p>
    </div>
    <div class="faq-item">
      <h4>Onde compro o Mounjaro em Portugal?</h4>
      <p>O Mounjaro est&aacute; dispon&iacute;vel em farm&aacute;cias portuguesas mediante receita m&eacute;dica. Pode haver ruturas de stock &mdash; recomendamos confirmar disponibilidade antes da consulta.</p>
    </div>
    <div class="faq-item">
      <h4>O Mounjaro tem efeitos secund&aacute;rios?</h4>
      <p>Os mais comuns s&atilde;o n&aacute;useas, v&oacute;mitos, diarreia e obstipa&ccedil;&atilde;o &mdash; geralmente ligeiros e transit&oacute;rios, especialmente nas primeiras semanas. A titula&ccedil;&atilde;o lenta da dose minimiza estes efeitos.</p>
    </div>
    <div class="faq-item">
      <h4>Preciso de consultas de seguimento?</h4>
      <p>Sim. O tratamento com Mounjaro requer acompanhamento m&eacute;dico regular para ajuste de dose e monitoriza&ccedil;&atilde;o cl&iacute;nica. As consultas de seguimento tamb&eacute;m podem ser feitas por videoconsulta.</p>
    </div>
    <div class="faq-item">
      <h4>A consulta &eacute; d&eacute;dut&iacute;vel no IRS?</h4>
      <p>Sim. A fatura AT emitida automaticamente ap&oacute;s a consulta &eacute; v&aacute;lida como despesa de sa&uacute;de dedut&iacute;vel no IRS.</p>
    </div>
  </div>

  <div class="cta-box">
    <h3>Pronto para come&ccedil;ar o tratamento?</h3>
    <p>Avalia&ccedil;&atilde;o cl&iacute;nica por videoconsulta. Prescri&ccedil;&atilde;o de Mounjaro se indicado. Dispon&iacute;vel de segunda a domingo, das 9h &agrave;s 21h.</p>
    <a class="btn" href="/#marcar">Marcar Consulta &mdash; 55&euro; &rarr;</a>
  </div>
</div>`
  }));
});
app.listen(PORT, () => {
  console.log('ConsultasOnline - Server Running - porta ' + PORT);
});
