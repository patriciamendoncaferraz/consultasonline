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
  title: 'Como Atuam os Medicamentos Injetáveis para o Tratamento da Obesidade? | ConsultasOnline',
  description: 'Saiba como atuam os medicamentos injetáveis para o tratamento da obesidade, quais os efeitos, indicações e cuidados necessários.',
  keywords: 'medicamentos injetaveis obesidade portugal, glp-1 obesidade, agonistas glp-1, tratamento obesidade injetavel, semaglutido tirzepatido portugal',
    content: `<div class="cta-top"><p>💉 Quer saber se é candidato a este tratamento? Consulta médica de obesidade por videoconsulta. <a href="/">Marcar consulta — 55€ →</a></p></div>

    <p>A obesidade é uma doença crónica, complexa e multifatorial, reconhecida pela Organização Mundial de Saúde como uma das maiores emergências de saúde pública do século XXI. Em Portugal, dados do Inquérito Nacional de Saúde de 2019 indicam que cerca de 16,9% dos adultos apresentam obesidade e 36,6% têm excesso de peso, colocando o país entre os mais afetados da Europa Ocidental (<a href="https://www.ine.pt/xportal/xmain?xpid=INE&xpgid=ine_destaques&DESTAQUESdest_boui=414434213&DESTAQUEStema=00&DESTAQUESmodo=2" target="_blank" style="color:#0d7377">Instituto Nacional de Saúde Doutor Ricardo Jorge, 2020</a>). Este facto faz com que haja elevado interesse nos novos medicamentos injetáveis para o tratamento da obesidade.</p>

    <h2>Uma nova era no tratamento farmacológico da obesidade</h2>
    <p>Durante décadas, o arsenal farmacológico disponível para o tratamento da obesidade foi limitado, com eficácia modesta e perfis de segurança frequentemente problemáticos. A aprovação de uma nova classe de medicamentos injetáveis, os agonistas do recetor do péptido-1 semelhante ao glucagon (GLP-1) e os agonistas duplos GLP-1/GIP, representa a maior revolução no tratamento farmacológico da obesidade em mais de vinte anos.</p>
    <p>Estes medicamentos não são uma solução definitiva nem uma alternativa ao estilo de vida saudável. São ferramentas clínicas com indicações precisas, contraindicações relevantes e um perfil de efeitos adversos que exige acompanhamento médico estruturado.</p>

    <h2>O que é a obesidade?</h2>
    <p>A obesidade é definida clinicamente como uma acumulação excessiva ou anormal de gordura corporal que representa um risco para a saúde. O índice de massa corporal (IMC) é o instrumento de triagem mais utilizado na prática clínica.</p>
    <h3>Classificação do IMC (<a href="https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html" target="_blank" style="color:#0d7377">CDC</a>)</h3>
    <ul>
      <li><strong>IMC 18,5 a 24,9 kg/m²</strong> — peso normal, considerado saudável</li>
      <li><strong>IMC 25,0 a 29,9 kg/m²</strong> — excesso de peso (pré-obesidade)</li>
      <li><strong>IMC 30,0 a 34,9 kg/m²</strong> — obesidade grau I</li>
      <li><strong>IMC 35,0 a 39,9 kg/m²</strong> — obesidade grau II</li>
      <li><strong>IMC igual ou superior a 40,0 kg/m²</strong> — obesidade grau III (obesidade grave)</li>
    </ul>
    <p>O IMC tem limitações: não distingue massa gorda de massa muscular e não avalia a distribuição da gordura corporal. A avaliação clínica completa inclui a medição do perímetro abdominal (risco aumentado a partir de ≥94 cm nos homens e ≥80 cm nas mulheres), análises laboratoriais e avaliação de comorbilidades.</p>
    <p>As comorbilidades mais frequentemente associadas à obesidade incluem: diabetes mellitus tipo 2, hipertensão arterial, dislipidemia, doença cardiovascular, síndrome de apneia obstrutiva do sono, doença hepática esteatótica (MASLD), osteoartrite, determinados tipos de cancro e perturbações de saúde mental.</p>

    <h2>Fisiologia da saciedade e regulação do peso corporal</h2>
    <p>O trato gastrointestinal é o maior órgão endócrino do corpo humano, produzindo mais de 20 hormonas que comunicam com o cérebro para regular o comportamento alimentar. As principais hormonas envolvidas incluem:</p>
    <ul>
      <li><strong>Grelina:</strong> produzida pelo estômago, estimula o apetite antes das refeições.</li>
      <li><strong>Leptina:</strong> produzida pelo tecido adiposo, sinaliza ao hipotálamo a energia armazenada. Em indivíduos obesos desenvolve-se frequentemente resistência à leptina.</li>
      <li><strong>GLP-1:</strong> produzido pelas células L do intestino delgado, promove a saciedade, retarda o esvaziamento gástrico e estimula a secreção de insulina de forma dependente da glicose.</li>
      <li><strong>GIP:</strong> produzido pelas células K do intestino delgado, estimula a secreção de insulina e tem efeitos sobre o metabolismo lipídico.</li>
    </ul>
    <p>O hipotálamo é o principal centro de regulação do balanço energético. Em indivíduos com obesidade, este sistema encontra-se frequentemente comprometido, com resistência a múltiplos sinais de saciedade e tendência para defender um peso corporal elevado mesmo perante restrição calórica.</p>

    <h2>Como atuam os agonistas do recetor GLP-1</h2>
    <p>Os agonistas do recetor GLP-1 (arGLP-1) são moléculas sintéticas que mimetizam a ação do GLP-1 endógeno, com semivida muito mais longa, permitindo administração semanal.</p>
    <ul>
      <li>Estimulação da secreção de insulina dependente da glicose — risco de hipoglicemia geralmente baixo quando usados isoladamente.</li>
      <li>Supressão da secreção de glucagon, diminuindo a produção hepática de glicose.</li>
      <li>Supressão central do apetite através dos recetores GLP-1 no hipotálamo e área postrema.</li>
      <li>Atraso do esvaziamento gástrico, prolongando a saciedade após as refeições.</li>
    </ul>
    <p>Os arGLP-1 demonstraram efeitos cardioprotetores significativos. O ensaio LEADER demonstrou uma redução de 13% nos eventos cardiovasculares major com o liraglutido <a href="https://www.nejm.org/doi/full/10.1056/NEJMoa1603827" target="_blank" style="color:#0d7377">(Marso et al., 2016)</a>. No ensaio SELECT, o semaglutido demonstrou uma redução de 20% nos eventos cardiovasculares major em indivíduos obesos sem diabetes <a href="https://www.nejm.org/doi/full/10.1056/NEJMoa2307563" target="_blank" style="color:#0d7377">(Lincoff et al., 2023)</a>.</p>

    <h2>Agonistas duplos GLP-1/GIP: a evolução terapêutica</h2>
    <p>A segunda geração de medicamentos injetáveis inclui moléculas que agonizam simultaneamente o recetor GLP-1 e o recetor GIP, conferindo eficácia superior na redução do peso corporal.</p>
    <p>No ensaio <a href="https://www.nejm.org/doi/full/10.1056/NEJMoa2206038" target="_blank" style="color:#0d7377">SURMOUNT-1</a> (<a href="https://www.nejm.org/doi/full/10.1056/NEJMoa2206038" target="_blank" style="color:#0d7377">Jastreboff et al., 2022</a>), com 2.539 participantes sem diabetes, o tirzepatido atingiu reduções médias de 20,9% (15 mg) e 19,5% (10 mg) às 72 semanas, vs. 3,1% no placebo. Cerca de 57% dos participantes atingiram uma redução superior a 20%.</p>

    <h2>O que dizem os estudos</h2>
    <h3>Programa STEP</h3>
    <ul>
      <li><strong>STEP 1</strong> (<a href="https://pubmed.ncbi.nlm.nih.gov/33567185/" target="_blank" style="color:#0d7377">Wilding et al., 2021</a>): redução média de 14,9% com semaglutido vs. 2,4% com placebo às 68 semanas.</li>
      <li><strong>STEP 2</strong> (<a href="https://pubmed.ncbi.nlm.nih.gov/33667417/" target="_blank" style="color:#0d7377">Davies et al., 2021</a>): redução média de 9,6% em adultos com diabetes tipo 2 e obesidade.</li>
      <li><strong>STEP 3</strong> (<a href="https://jamanetwork.com/journals/jama/fullarticle/2777025" target="_blank" style="color:#0d7377">Wadden et al., 2021</a>): combinação com intervenção comportamental — redução média de 16%.</li>
      <li><strong>STEP 4</strong> (<a href="https://pubmed.ncbi.nlm.nih.gov/33755728/" target="_blank" style="color:#0d7377">Rubino et al., 2021</a>): interrupção do tratamento resulta na recuperação de dois terços do peso perdido.</li>
      <li><strong>STEP 5</strong> (<a href="https://pubmed.ncbi.nlm.nih.gov/36216945/" target="_blank" style="color:#0d7377">Garvey et al., 2022</a>): a 104 semanas, manutenção da perda de peso de 15,2%.</li>
    </ul>
    <h3>Comparação da eficácia entre classes</h3>
    <p>Uma metaanálise publicada na <a href="https://pubmed.ncbi.nlm.nih.gov/38582569/" target="_blank" style="color:#0d7377">The Lancet</a> (<a href="https://pubmed.ncbi.nlm.nih.gov/38582569/" target="_blank" style="color:#0d7377">Shi et al., 2022</a>), com 143 ensaios e mais de 49.000 participantes:</p>
    <ul>
      <li><strong>Agonistas duplos GLP-1/GIP:</strong> reduções de peso entre 15% e 21%.</li>
      <li><strong>Agonistas GLP-1 (semaglutido 2,4 mg):</strong> reduções de 10% a 15%.</li>
      <li><strong>Medicamentos mais antigos:</strong> eficácia de 3% a 8%.</li>
    </ul>

    <h2>Quem pode utilizar os medicamentos injetáveis para perder peso?</h2>
    <ul>
      <li>IMC igual ou superior a 30 kg/m² (obesidade), independentemente da presença de comorbilidades.</li>
      <li>IMC igual ou superior a 27 kg/m² com pelo menos uma comorbilidade relacionada com o peso (diabetes tipo 2, hipertensão, dislipidemia, apneia do sono, doença cardiovascular ou esteatose hepática).</li>
      <li>Tentativa prévia de perda de peso por modificações do estilo de vida sem sucesso adequado.</li>
      <li>Ausência de contraindicações conhecidas ao tratamento.</li>
    </ul>

    <h2>Contraindicações e precauções</h2>
    <h3>Contraindicações absolutas</h3>
    <ul>
      <li>História pessoal ou familiar de carcinoma medular da tiróide.</li>
      <li>Síndrome de neoplasia endócrina múltipla tipo 2 (NEM2).</li>
      <li>Hipersensibilidade ao princípio ativo ou a qualquer excipiente.</li>
      <li>Gravidez (interromper pelo menos dois meses antes de gravidez planeada) e aleitamento materno.</li>
    </ul>
    <h3>Precauções</h3>
    <ul>
      <li>História de pancreatite aguda ou crónica.</li>
      <li>Doenças gastrointestinais graves (gastroparesia, doença inflamatória intestinal ativa).</li>
      <li>Doença renal crónica avançada.</li>
      <li>Uso concomitante de sulfonilureias e insulina (ajuste de dose).</li>
      <li>Retinopatia diabética (avaliação oftalmológica prévia).</li>
    </ul>

    <h2>Efeitos adversos</h2>
    <h3>Efeitos gastrointestinais</h3>
    <ul>
      <li>Náuseas: 40% a 50% dos doentes, especialmente no início.</li>
      <li>Vómitos: 15% a 25% dos doentes.</li>
      <li>Diarreia: 20% a 30% dos doentes.</li>
      <li>Obstipação: particularmente com o tirzepatido.</li>
      <li>Dor abdominal e dispepsia: frequentes no início do tratamento.</li>
    </ul>
    <p>Estes efeitos são transitórios na maioria dos doentes e diminuem progressivamente. O aumento gradual da dose é a principal estratégia para minimizá-los.</p>
    <h3>Outros efeitos adversos</h3>
    <ul>
      <li>Perda de massa muscular — treino de resistência e ingestão proteica adequada são fundamentais.</li>
      <li>Litíase biliar — a perda de peso rápida aumenta o risco de cálculos biliares.</li>
      <li>Taquicardia — pequenos aumentos na frequência cardíaca (2 a 4 bpm).</li>
      <li>Reações no local de injeção — dor, eritema e prurido, geralmente ligeiros.</li>
    </ul>

    <h2>Monitorização e acompanhamento médico</h2>
    <p>Antes do início: avaliação clínica completa, IMC e perímetro abdominal, análises laboratoriais (hemograma, glicemia, HbA1c, perfil lipídico, função renal, hepática e tiroideia) e avaliação cardiovascular.</p>
    <p>Durante o tratamento: monitorização do peso, pressão arterial e frequência cardíaca; análises de 3 em 3 a 6 meses; suporte nutricional e de atividade física.</p>

    <h2>Contexto em Portugal</h2>
    <p>Os medicamentos injetáveis para a obesidade aprovados pela EMA estão disponíveis em Portugal. Para a indicação de diabetes tipo 2, alguns têm comparticipação do SNS sujeita a critérios específicos. Para obesidade sem diabetes, não existe comparticipação pelo SNS. O custo mensal varia tipicamente entre 150 e 300 euros. A prescrição exige avaliação médica prévia, que pode ser realizada por videoconsulta.</p>

    <h2>O futuro: próximas gerações</h2>
    <ul>
      <li>Agonistas triplos GLP-1/GIP/glucagon (retratutido): dados preliminares com reduções superiores a 24%.</li>
      <li>Agonistas GLP-1/amilina: combinação sobre a saciedade central e o controlo glicémico periférico.</li>
      <li>Formulações orais de arGLP-1: para doentes com relutância à autoadministração de injeções.</li>
    </ul>

    <h2>Perguntas frequentes</h2>
    <div class="faq"><h4>Como atuam os medicamentos injetáveis para a obesidade?</h4><p>Atuam sobre mecanismos envolvidos na regulação do apetite, da saciedade e do metabolismo. Os agonistas GLP-1 reproduzem efeitos desta hormona intestinal, aumentando a saciedade, reduzindo o apetite e atrasando o esvaziamento gástrico. Existem também medicamentos que atuam simultaneamente nos recetores GLP-1 e GIP.</p></div>
    <div class="faq"><h4>Quem pode fazer tratamento com medicamentos injetáveis para a obesidade?</h4><p>A indicação deve ser avaliada individualmente por um médico. Podem ser considerados em adultos com IMC igual ou superior a 30 kg/m² ou com IMC igual ou superior a 27 kg/m² quando existe pelo menos uma condição relacionada com o excesso de peso.</p></div>
    <div class="faq"><h4>Quais são os efeitos adversos mais frequentes?</h4><p>Os efeitos adversos mais frequentes são gastrointestinais: náuseas, vómitos, diarreia, obstipação e dor abdominal. Surgem sobretudo no início do tratamento e tendem a diminuir progressivamente.</p></div>
    <div class="faq"><h4>Estes medicamentos causam dependência?</h4><p>Não. Não há evidência de dependência física ou psicológica. Ao interromper o tratamento, os mecanismos de regulação do apetite voltam a ser ativos, levando à recuperação do peso.</p></div>
    <div class="faq"><h4>É necessário acompanhamento médico durante o tratamento?</h4><p>Sim. O acompanhamento médico é essencial antes e durante o tratamento, com avaliação clínica, análises laboratoriais, monitorização cardiovascular e suporte nutricional.</p></div>

    <div class="refs"><h3>Referências Bibliográficas</h3><ol>
      <li>Aronne, L. J., et al. (2024). SURMOUNT-4. JAMA, 331(1), 38-48. https://doi.org/10.1001/jama.2023.24945</li>
      <li>Davies, M., et al. (2021). STEP 2. The Lancet, 397(10278), 971-984. https://doi.org/10.1016/S0140-6736(21)00213-0</li>
      <li>Garvey, W. T., et al. (2022). STEP 5. Nature Medicine, 28(10), 2083-2091. https://doi.org/10.1038/s41591-022-02026-4</li>
      <li>Instituto Nacional de Saúde Doutor Ricardo Jorge. (2020). Inquérito Nacional de Saúde 2019. INSA.</li>
      <li>Jastreboff, A. M., et al. (2022). SURMOUNT-1. NEJM, 387(3), 205-216. https://doi.org/10.1056/NEJMoa2206038</li>
      <li>Lincoff, A. M., et al. (2023). SELECT. NEJM, 389(24), 2221-2232. https://doi.org/10.1056/NEJMoa2307563</li>
      <li>Marso, S. P., et al. (2016). LEADER. NEJM, 375(4), 311-322. https://doi.org/10.1056/NEJMoa1603827</li>
      <li>Rubino, D., et al. (2021). STEP 4. JAMA, 325(14), 1414-1425. https://doi.org/10.1001/jama.2021.3224</li>
      <li>Shi, Q., et al. (2022). The Lancet, 399(10321), 259-269. https://doi.org/10.1016/S0140-6736(21)01640-8</li>
      <li>Wadden, T. A., et al. (2021). STEP 3. JAMA, 325(14), 1403-1413. https://doi.org/10.1001/jama.2021.1831</li>
      <li>Wilding, J. P. H., et al. (2021). STEP 1. NEJM, 384(11), 989-1002. https://doi.org/10.1056/NEJMoa2032183</li>
      <li>World Health Organization. (2024). Obesity and overweight. https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight</li>
    </ol></div>`
  },
'doencas-sexualmente-transmissiveis': {
  title: 'Infeções Sexualmente Transmissíveis (IST): rastreio, prevenção e tratamento | ConsultasOnline',
  description: 'Saiba tudo sobre as infeções sexualmente transmissíveis (IST): sintomas, transmissão, testes, prevenção e tratamento. Leia agora!',
  keywords:'infeções sexualmente transmissíveis, IST, clamídia, gonorreia, sífilis, VIH, HPV, herpes genital, hepatite B, hepatite C, rastreio IST Portugal',
  content: `<div class="cta-top"><p>🔬 Quer fazer rastreio de IST de forma discreta? Consulta confidencial por videoconsulta. <a href="/">Marcar consulta — 40€ →</a></p></div>
   <!-- IST -->
<div class="article-view" id="article-doencas-sexualmente-transmissiveis">
<div class="art-hero"><div class="art-hero-inner">
  <button class="art-back" onclick="closeArticle()">← Voltar aos artigos</button>
  <div class="art-cat">🧬 Saúde Sexual</div>
  <h1 class="art-title">Infeções Sexualmente Transmissíveis (IST): rastreio, prevenção e tratamento</h1>
  <div class="art-meta"><div class="art-meta-item">⏱ <span>25 min</span></div><div class="art-meta-item">🔬 <span>Atualizado 2026</span></div></div>
</div></div>
<div class="art-body-wrap"><div class="art-body">

  <p>As infeções sexualmente transmissíveis (IST) são infeções transmitidas sobretudo através do contacto sexual vaginal, anal ou oral. Algumas também podem ser transmitidas através do sangue ou da mãe para o bebé durante a gravidez, o parto ou, em determinadas infeções, o aleitamento.</p>
  <p>Muitas IST não provocam sintomas. Uma pessoa pode, por isso, ter uma infeção e transmiti-la sem saber.</p>
  <p>Entre as IST mais conhecidas encontram-se a clamidíase, gonorreia, sífilis, <a href="#gl-hiv" style="color:var(--teal)">VIH</a>, herpes genital, <a href="#gl-hpv" style="color:var(--teal)">HPV</a>, hepatite B, hepatite C e tricomoníase.</p>
  <p>O diagnóstico depende da infeção e pode exigir análises ao sangue, urina ou colheitas por <a href="#gl-zaragatoa" style="color:var(--teal)">zaragatoa</a>. O rastreio permite identificar infeções <a href="#gl-assintomatico" style="color:var(--teal)">assintomáticas</a> e iniciar a orientação adequada mais cedo.</p>
  <p>Neste artigo encontra informação sobre os principais sintomas, formas de transmissão, prevenção, rastreio, diagnóstico e tratamento das infeções sexualmente transmissíveis.</p>

  <h2>O que são as infeções sexualmente transmissíveis?</h2>
  <p>As infeções sexualmente transmissíveis são causadas por bactérias, vírus ou parasitas que podem ser transmitidos durante o contacto sexual.</p>
  <p><a href="https://www.ecdc.europa.eu/en/news-events/sti-cases-rise-across-europe" target="_blank" style="color:var(--teal)">De acordo com o ECDC, as IST bacterianas continuam a aumentar na Europa. Os dados referentes a 2024 mostram níveis particularmente elevados de gonorreia e sífilis, enquanto a clamidíase continua a ser a IST mais frequentemente notificada.</a></p>
  <p>Um dos principais desafios é a ausência de sintomas. Ter uma IST não significa necessariamente apresentar corrimento, dor, feridas ou outras alterações visíveis.</p>
  <p>Por esse motivo, o risco individual e a história sexual são importantes para decidir quando deve ser feito um rastreio.</p>

  <h3>Quais são as principais infeções sexualmente transmissíveis?</h3>
  <p>As IST podem ser classificadas de acordo com o agente etiológico:</p>
  <ul>
    <li>IST <a href="#gl-bacteriana" style="color:var(--teal)">bacterianas</a>: clamidíase, gonorreia, sífilis, cancro mole (<em>Haemophilus ducreyi</em>), <a href="#gl-lgv" style="color:var(--teal)">linfogranuloma venéreo (LGV)</a>, granuloma inguinal (donovanose)</li>
    <li>IST <a href="#gl-viral" style="color:var(--teal)">virais</a>: <a href="#gl-hiv" style="color:var(--teal)">VIH</a>/<a href="#gl-sida" style="color:var(--teal)">SIDA</a>, herpes genital (<a href="#gl-hsv" style="color:var(--teal)">HSV-1 e HSV-2</a>), verrugas genitais e cancro do colo do útero associados ao <a href="#gl-hpv" style="color:var(--teal)">HPV</a>, hepatite B, hepatite C, molluscum contagiosum</li>
    <li>IST parasitárias: tricomonas (<em>Trichomonas vaginalis</em>), piolho púbico (<em>Phthirus pubis</em>), sarna (<em>Sarcoptes scabiei</em>)</li>
    <li>IST fúngicas: candidose (<em>Candida albicans</em>), embora esta não seja classificada classicamente como IST, pode ser facilitada pelo contacto sexual</li>
  </ul>

  <h2>Como se transmitem as IST?</h2>
  <p>A maioria das infeções sexualmente transmissíveis transmite-se por contacto sexual direto, incluindo:</p>
  <ul>
    <li>Contacto génito-genital: via mais comum para a maioria das IST</li>
    <li>Contacto oral-genital: relevante para herpes, gonorreia, sífilis e <a href="#gl-hpv" style="color:var(--teal)">HPV</a></li>
    <li>Contacto anal: associado a maior risco de transmissão de <a href="#gl-hiv" style="color:var(--teal)">VIH</a>, gonorreia, sífilis, <a href="#gl-lgv" style="color:var(--teal)">LGV</a> e hepatites virais</li>
    <li><a href="#gl-vertical" style="color:var(--teal)">Transmissão vertical</a> (mãe para filho): durante a gravidez, o parto ou o aleitamento, relevante para VIH, sífilis, herpes e hepatite B</li>
    <li><a href="#gl-parenteral" style="color:var(--teal)">Via sanguínea</a>: VIH e hepatite C em utilizadores de drogas injetadas, transfusões e acidentes com materiais cortantes</li>
  </ul>

  <h3>Grupos com maior risco de transmissão de infeções sexualmente transmissíveis</h3>
  <p>Embora qualquer pessoa sexualmente ativa possa contrair uma IST, determinados grupos apresentam risco epidemiológico superior:</p>
  <ul>
    <li>Pessoas com múltiplos parceiros sexuais e sem uso consistente de preservativo</li>
    <li>Utilizadores de drogas injetadas</li>
    <li>Pessoas com IST prévia, que são fator de risco independente para nova IST</li>
    <li>Pessoas em regiões com alta prevalência, incluindo determinadas áreas urbanas e países com sistemas de saúde mais debilitados</li>
  </ul>

  <h2>Como prevenir as infeções sexualmente transmissíveis?</h2>
  <p>A prevenção das IST assenta em múltiplas estratégias complementares:</p>

  <h3>Preservativo masculino e feminino</h3>
  <p>O uso correto e consistente do preservativo masculino reduz significativamente o risco de transmissão da maioria das IST. A eficácia é particularmente elevada para <a href="#gl-hiv" style="color:var(--teal)">VIH</a>, gonorreia e clamidíase. Para as infeções sexualmente transmissíveis que se transmitem por contacto com lesões cutâneas (herpes, sífilis, <a href="#gl-hpv" style="color:var(--teal)">HPV</a>), o preservativo confere proteção parcial, dependendo da localização das lesões.</p>

  <h3>Vacinação</h3>
  <p>Existem vacinas eficazes para duas IST de origem viral: a hepatite B (vacina altamente eficaz, incluída no <a href="https://www.sns24.gov.pt/pt/tema/vacinas/programa-nacional-de-vacinacao" target="_blank" style="color:var(--teal)">Programa Nacional de Vacinação em Portugal</a>) e o <a href="#gl-hpv" style="color:var(--teal)">HPV</a> (vacinas bivalente, tetravalente e nonavalente, disponíveis e recomendadas a rapazes e raparigas no <a href="https://www.sns24.gov.pt/pt/tema/vacinas/programa-nacional-de-vacinacao" target="_blank" style="color:var(--teal)">Programa Nacional de Vacinação</a>).</p>

  <h3>Profilaxia Pré-Exposição ao VIH (PrEP)</h3>
  <p><a href="https://www.nejm.org/doi/full/10.1056/NEJMoa1011205" target="_blank" style="color:var(--teal)">A <a href="#gl-prep" style="color:var(--teal)">PrEP</a> com tenofovir/emtricitabina é um medicamento antirretroviral tomado por pessoas VIH-negativas com risco elevado de infeção, com eficácia superior a 99% na prevenção da transmissão do VIH por via sexual, quando tomado corretamente (Grant et al., 2010).</a> Está disponível no SNS português para pessoas com indicação clínica.</p>

  <h3>Profilaxia Pós-Exposição ao VIH (PEP)</h3>
  <p>A <a href="#gl-pep" style="color:var(--teal)">PEP</a> consiste na toma de antirretrovirais nas primeiras 72 horas após uma exposição de risco ao <a href="#gl-hiv" style="color:var(--teal)">VIH</a> (sexo desprotegido, acidente com agulha, violência sexual). A eficácia diminui com o tempo decorrido e é nula após 72 horas.</p>

  <h3>Rastreio regular e tratamento de parceiros</h3>
  <p>O rastreio regular permite detetar IST <a href="#gl-assintomatico" style="color:var(--teal)">assintomáticas</a> e tratar atempadamente, interrompendo a cadeia de transmissão. A <a href="#gl-notificacao" style="color:var(--teal)">notificação</a> e tratamento dos parceiros sexuais é fundamental para evitar a reinfeção.</p>

  <h2>Quando deve fazer um rastreio de IST?</h2>
  <p>As diretrizes internacionais (<a href="https://iusti.org/treatment-guidelines/" target="_blank" style="color:var(--teal)">IUSTI</a>, <a href="https://www.cdc.gov/sti/testing/index.html" target="_blank" style="color:var(--teal)">CDC</a>, <a href="https://www.ecdc.europa.eu/en/sexually-transmitted-infections" target="_blank" style="color:var(--teal)">ECDC</a>) recomendam rastreio regular nas seguintes situações:</p>
  <ul>
    <li>Adultos sexualmente ativos com novos ou múltiplos parceiros: rastreio anual de clamidíase, gonorreia, sífilis e <a href="#gl-hiv" style="color:var(--teal)">VIH</a></li>
    <li>Após relação sexual desprotegida com parceiro desconhecido</li>
    <li>Após noção de contacto com pessoa infetada</li>
    <li>No início de uma nova relação, antes de abandonar o uso do preservativo</li>
    <li>Em mulheres grávidas: rastreio de sífilis, VIH, hepatite B e clamidíase na primeira consulta pré-natal</li>
    <li>Em pessoas com sintomas sugestivos: corrimento genital, ardor urinário, úlceras ou lesões genitais, dor pélvica, <a href="#gl-linfadenopatia" style="color:var(--teal)">linfadenopatia</a> inguinal</li>
  </ul>

  <h2>Como é feito o diagnóstico de uma IST?</h2>
  <p>O diagnóstico das infeções sexualmente transmissíveis recorre a diferentes métodos conforme a infeção suspeita:</p>
  <ul>
    <li>Análises ao sangue: sífilis (VDRL, TPHA, FTA-ABS), <a href="#gl-hiv" style="color:var(--teal)">VIH</a> (Ag/Ac 4ª geração), hepatite B (HBsAg, anti-HBs, anti-HBc), hepatite C (anti-VHC, <a href="#gl-carga-viral" style="color:var(--teal)">carga viral</a>)</li>
    <li><a href="#gl-zaragatoa" style="color:var(--teal)">Zaragatoas</a> uretrais, vaginais, endocervicais, anais ou faríngeas: <a href="#gl-pcr" style="color:var(--teal)">PCR</a> ou cultura para clamidíase, gonorreia, herpes e <a href="#gl-lgv" style="color:var(--teal)">LGV</a></li>
    <li>Exame de urina (<a href="#gl-pcr" style="color:var(--teal)">PCR em urina</a>): alternativa não invasiva para deteção de clamidíase e gonorreia uretral</li>
    <li>Exame microscópico e cultura de corrimento: tricomonas, candidose</li>
    <li>Biópsia ou colheita de lesões: herpes, sífilis primária, <a href="#gl-hpv" style="color:var(--teal)">HPV</a></li>
  </ul>
  <p>A consulta de rastreio por <a onclick="openArticle('consulta-online')" style="color:var(--teal);cursor:pointer;font-weight:600">videoconsulta</a> permite ao médico avaliar o risco, prescrever as análises adequadas e interpretar os resultados, tudo sem deslocação física.</p>

  <h2>Clamidíase: transmissão, sintomas, diagnóstico e tratamento</h2>

  <h3>O que é a clamidíase?</h3>
  <p>A clamidíase é causada pela bactéria <em>Chlamydia trachomatis</em>, um parasita <a href="#gl-intracelular" style="color:var(--teal)">intracelular obrigatório</a>. É a infeção sexualmente transmissível bacteriana mais prevalente na Europa e em Portugal. <a href="https://www.ecdc.europa.eu/en/news-events/bacterial-stis-reach-record-highs-europe-congenital-syphilis-cases-nearly-double" target="_blank" style="color:var(--teal)">O ECDC reportou mais de 213.443 casos notificados na Europa em 2024, sendo a maioria em jovens adultos, especialmente mulheres entre os 20 e os 24 anos (ECDC, 2024).</a> A <a href="#gl-subnotificacao" style="color:var(--teal)">subnotificação</a> é significativa dado o elevado número de casos <a href="#gl-assintomatico" style="color:var(--teal)">assintomáticos</a>.</p>

  <h3>Como se transmite a clamidíase?</h3>
  <ul>
    <li>Contacto sexual vaginal, anal e oral desprotegido</li>
    <li><a href="#gl-vertical" style="color:var(--teal)">Transmissão vertical</a> da mãe para o recém-nascido durante o parto, podendo causar conjuntivite e pneumonia neonatal</li>
  </ul>
  <p>Não se transmite por contacto casual, piscinas, toalhas ou superfícies.</p>

  <h3>Quais são os sintomas da infeção por clamídia?</h3>
  <p>A clamidíase é <a href="#gl-assintomatico" style="color:var(--teal)">assintomática</a> em 50% a 75% dos casos, o que é simultaneamente a maior dificuldade e o principal argumento para o rastreio periódico. Quando presentes, os sintomas surgem tipicamente 1 a 3 semanas após a exposição.</p>
  <h4>Clamídia na mulher:</h4>
  <ul>
    <li>Corrimento vaginal alterado (aumento, odor ou cor diferentes do habitual)</li>
    <li>Ardor ou dor ao urinar (<a href="#gl-disuria" style="color:var(--teal)">disúria</a>)</li>
    <li>Dor pélvica, especialmente durante ou após as relações sexuais</li>
    <li>Hemorragia intermenstrual ou após as relações sexuais</li>
    <li><a href="#gl-cervicite" style="color:var(--teal)">Cervicite</a></li>
  </ul>
  <h4>Clamídia no homem:</h4>
  <ul>
    <li>Corrimento uretral transparente ou esbranquiçado</li>
    <li>Ardor ao urinar</li>
    <li>Dor ou inchaço testicular (<a href="#gl-epididimite" style="color:var(--teal)">epididimite</a>, menos frequente)</li>
  </ul>
  <h4>Clamídia em ambos os sexos (infeção retal e faríngea):</h4>
  <ul>
    <li>Infeção anal: <a href="#gl-proctite" style="color:var(--teal)">proctite</a>, corrimento retal, dor retal (frequentemente <a href="#gl-assintomatico" style="color:var(--teal)">assintomática</a>)</li>
    <li>Infeção faríngea: habitualmente assintomática, ocasionalmente faringite ligeira</li>
  </ul>

  <h3>Que complicações pode causar a clamidíase?</h3>
  <ul>
    <li><a href="#gl-dip" style="color:var(--teal)">Doença inflamatória pélvica (DIP)</a> na mulher: infeção ascendente que envolve útero, trompas e ovários</li>
    <li>Infertilidade: por lesão tubária irreversível</li>
    <li>Gravidez ectópica: por obstrução tubária</li>
    <li><a href="#gl-epididimite" style="color:var(--teal)">Epididimite</a> e, raramente, infertilidade masculina</li>
    <li>Artrite reativa (síndrome de Reiter): artrite, conjuntivite e uretrite, mais comum no sexo masculino</li>
    <li><a href="#gl-lgv" style="color:var(--teal)">Linfogranuloma venéreo (LGV)</a>: causado por serotipos L1, L2 e L3 de <em>C. trachomatis</em>, manifesta-se por úlceras genitais e linfonodos inguinais volumosos</li>
  </ul>

  <h3>Como é diagnosticada a clamidíase?</h3>
  <p>O método de referência é a técnica de amplificação de ácidos nucleicos (<a href="#gl-pcr" style="color:var(--teal)">TAAN/PCR</a>):</p>
  <ul>
    <li>Mulheres: <a href="#gl-zaragatoa" style="color:var(--teal)">zaragatoa</a> endocervical, vaginal (autocolheita aceite) ou amostra de urina</li>
    <li>Homens: amostra de urina (primeiro jato) ou zaragatoa uretral</li>
    <li>Rastreio anal e faríngeo: zaragatoa anal e faríngea</li>
  </ul>

  <h3>Como é tratada a clamidíase?</h3>
  <ul>
    <li>Dose única: azitromicina 1g por via oral</li>
    <li>Alternativa: doxiciclina 100 mg duas vezes por dia durante 7 dias (preferida pelas guidelines europeias, especialmente para infeção retal)</li>
    <li>Grávidas: azitromicina 1g (dose única) ou amoxicilina 500 mg três vezes por dia durante 7 dias</li>
  </ul>
  <p>Os parceiros sexuais dos últimos 60 dias devem ser notificados e tratados, mesmo sem sintomas.</p>

  <h2>Gonorreia: transmissão, sintomas, diagnóstico e tratamento</h2>

  <h3>O que é a gonorreia?</h3>
  <p>A gonorreia é causada por <em>Neisseria gonorrhoeae</em>, uma bactéria <a href="#gl-gram" style="color:var(--teal)">gram-negativa</a> <a href="#gl-diplococo" style="color:var(--teal)">diplococácea</a>. <a href="https://www.ecdc.europa.eu/en/news-events/bacterial-stis-reach-record-highs-europe-congenital-syphilis-cases-nearly-double" target="_blank" style="color:var(--teal)">É a segunda infeção sexualmente transmissível bacteriana mais notificada na Europa. O ECDC registou mais de 106.331 casos confirmados na Europa em 2024 (ECDC, 2024).</a> A resistência aos antibióticos é uma preocupação crescente, com o <a href="https://www.ecdc.europa.eu/en/news-events/drug-resistant-gonorrhoea-rise-europe-ecdc-warns" target="_blank" style="color:var(--teal)">ECDC a alertar para gonorreia resistente a antibióticos na Europa</a>.</p>

  <h3>Como se transmite a gonorreia?</h3>
  <ul>
    <li>Contacto sexual vaginal, anal e oral desprotegido</li>
    <li><a href="#gl-vertical" style="color:var(--teal)">Transmissão vertical</a> durante o parto, podendo causar oftalmia neonatal grave</li>
  </ul>

  <h3>Quais são os sintomas da gonorreia?</h3>
  <p>O período de incubação é de 1 a 14 dias.</p>
  <h4>Gonorreia no homem (sintomática em 90% dos casos):</h4>
  <ul>
    <li>Corrimento uretral amarelo-esverdeado, abundante e purulento</li>
    <li><a href="#gl-disuria" style="color:var(--teal)">Disúria</a> intensa</li>
    <li><a href="#gl-polaquiuria" style="color:var(--teal)">Polaquiúria</a></li>
  </ul>
  <h4>Gonorreia na mulher (assintomática em 50% dos casos):</h4>
  <ul>
    <li>Corrimento vaginal aumentado ou de aspeto anormal</li>
    <li><a href="#gl-disuria" style="color:var(--teal)">Disúria</a></li>
    <li>Dor pélvica (sugere <a href="#gl-dip" style="color:var(--teal)">DIP</a>)</li>
    <li>Hemorragia intermenstrual ou pós-coital</li>
  </ul>
  <h4>Gonorreia faríngea:</h4>
  <ul>
    <li>Habitualmente <a href="#gl-assintomatico" style="color:var(--teal)">assintomática</a></li>
    <li>Pode causar faringite, exsudado amigdalino e <a href="#gl-linfadenopatia" style="color:var(--teal)">linfadenopatia</a> cervical</li>
  </ul>
  <h4>Gonorreia retal:</h4>
  <ul>
    <li>Frequentemente <a href="#gl-assintomatico" style="color:var(--teal)">assintomática</a></li>
    <li><a href="#gl-proctite" style="color:var(--teal)">Proctite</a>: corrimento retal, dor, tenesmo e hemorragia</li>
  </ul>

  <h3>Que complicações pode causar a gonorreia?</h3>
  <ul>
    <li><a href="#gl-dip" style="color:var(--teal)">Doença inflamatória pélvica (DIP)</a> na mulher, com risco de infertilidade e gravidez ectópica</li>
    <li><a href="#gl-epididimite" style="color:var(--teal)">Epididimite</a> e orquite no homem</li>
    <li>Gonorreia disseminada: artrite séptica, dermatite, endocardite, meningite (raro, mas grave)</li>
    <li>Estenose uretral por infeção repetida</li>
  </ul>

  <h3>Como é diagnosticada a gonorreia?</h3>
  <ul>
    <li><a href="#gl-pcr" style="color:var(--teal)">PCR/TAAN</a>: método de referência, de elevada sensibilidade e especificidade</li>
    <li>Cultura: essencial para testes de sensibilidade aos antibióticos e vigilância da resistência</li>
    <li>Microscopia de esfregaço corado pelo <a href="#gl-gram" style="color:var(--teal)">Gram</a>: útil no corrimento uretral masculino</li>
  </ul>

  <h3>Como é tratada a gonorreia?</h3>
  <p>O tratamento de primeira linha de acordo com as guidelines europeias (<a href="https://iusti.org/wp-content/uploads/2020/10/IUSTI-Gonorrhoea-2020.pdf" target="_blank" style="color:var(--teal)">IUSTI</a>/ECDC) é:</p>
  <ul>
    <li>Ceftriaxona 500 mg intramuscular em dose única</li>
    <li>Em alergia à penicilina: espectinomicina 2g IM ou gentamicina 240 mg IM + azitromicina 2g oral</li>
  </ul>

  <h2>Sífilis: sintomas, fases, diagnóstico e tratamento</h2>

  <h3>O que é a sífilis?</h3>
  <p>A sífilis é causada pela <a href="#gl-espiroqueta" style="color:var(--teal)">espiroqueta</a> <em>Treponema pallidum</em>. <a href="https://www.ecdc.europa.eu/en/news-events/bacterial-stis-reach-record-highs-europe-congenital-syphilis-cases-nearly-double" target="_blank" style="color:var(--teal)">O ECDC reportou mais de 45.577 casos em 2024 (ECDC, 2024).</a> A sífilis <a href="#gl-congenita" style="color:var(--teal)">congénita</a>, reflexo da sífilis não tratada na grávida, apresenta igualmente uma tendência crescente preocupante na Europa.</p>

  <h3>Como se transmite a sífilis?</h3>
  <ul>
    <li>Contacto sexual direto com lesões infeciosas (cancro, condilomas planos)</li>
    <li><a href="#gl-vertical" style="color:var(--teal)">Transmissão vertical</a>: sífilis <a href="#gl-congenita" style="color:var(--teal)">congénita</a>, com consequências graves para o feto (aborto, natimorto, malformações)</li>
    <li><a href="#gl-parenteral" style="color:var(--teal)">Via sanguínea</a>: transfusões ou partilha de material de injeção (raro)</li>
  </ul>

  <h3>Quais são as fases e sintomas da sífilis?</h3>
  <h4>Sífilis primária (2 a 12 semanas após exposição):</h4>
  <ul>
    <li>Cancro sifilítico: úlcera única, indolor, de bordos bem definidos e base indurada, no local de entrada do <em><a href="#gl-treponema" style="color:var(--teal)">Treponema</a></em> (genitais, ânus, boca)</li>
    <li><a href="#gl-linfadenopatia" style="color:var(--teal)">Linfadenopatia</a> regional indolor ipsilateral</li>
    <li>O cancro cura espontaneamente em 3 a 6 semanas, mesmo sem tratamento</li>
  </ul>
  <h4>Sífilis secundária (6 semanas a 6 meses após o cancro):</h4>
  <ul>
    <li><a href="#gl-exantema" style="color:var(--teal)">Exantema</a> maculopapular generalizado, classicamente nas palmas das mãos e plantas dos pés</li>
    <li>Condilomas planos (placas mucosas nas áreas genitais e perianais, muito infeciosas)</li>
    <li><a href="#gl-linfadenopatia" style="color:var(--teal)">Linfadenopatia</a> generalizada</li>
    <li>Sintomas constitucionais: febre, cefaleias, mialgia, perda de peso</li>
    <li>Alopécia em "traça"</li>
  </ul>
  <h4>Sífilis latente:</h4>
  <p>Período <a href="#gl-assintomatico" style="color:var(--teal)">assintomático</a> após sífilis secundária. Divide-se em latente recente (menos de 1 ano de evolução) e latente tardia (mais de 1 ano).</p>
  <h4>Sífilis terciária (anos a décadas sem tratamento):</h4>
  <ul>
    <li>Goma sifilítica: lesões granulomatosas destrutivas na pele, osso ou órgãos</li>
    <li>Neurosífilis: meningite crónica, demência, <em>tabes dorsalis</em>, paralisia geral progressiva</li>
    <li>Sífilis cardiovascular: aortite, aneurisma aórtico</li>
  </ul>

  <h3>Como é diagnosticada a sífilis?</h3>
  <p>O diagnóstico <a href="#gl-serologia" style="color:var(--teal)">serológico</a> recorre a dois tipos de testes:</p>
  <ul>
    <li>Testes treponémicos (TPHA, FTA-ABS, CLIA): detetam anticorpos específicos anti-<a href="#gl-treponema" style="color:var(--teal)">Treponema</a></li>
    <li>Testes não treponémicos (VDRL, RPR): titulados quantitativamente, permitem monitorizar a resposta ao tratamento</li>
    <li><a href="#gl-pcr" style="color:var(--teal)">PCR</a> em lesões: útil no diagnóstico de sífilis primária quando a serologia pode ainda ser negativa</li>
  </ul>

  <h3>Como é tratada a sífilis?</h3>
  <ul>
    <li>Sífilis primária, secundária e latente recente: penicilina G benzatina 2,4 milhões de UI intramuscular, dose única</li>
    <li>Sífilis latente tardia: penicilina G benzatina 2,4 milhões de UI IM, 3 doses semanais</li>
    <li>Em alergia à penicilina (não grávidas): doxiciclina 100 mg 2x/dia durante 14 a 28 dias</li>
    <li>Grávidas com alergia à penicilina: dessensibilização e tratamento com penicilina</li>
  </ul>

  <h2>VIH e SIDA: sintomas, transmissão, teste e tratamento</h2>

  <h3>O que é o VIH e qual é a diferença entre VIH e SIDA?</h3>
  <p>O <a href="#gl-hiv" style="color:var(--teal)">VIH</a> é o vírus responsável pela infeção. A <a href="#gl-sida" style="color:var(--teal)">SIDA</a> corresponde à fase avançada da infeção por VIH, associada a uma deterioração importante do sistema imunitário e/ou ao aparecimento de determinadas <a href="#gl-oportunista" style="color:var(--teal)">infeções oportunistas</a> ou outras doenças.</p>
  <p>Com o diagnóstico e tratamento atuais, muitas pessoas com VIH mantêm a infeção controlada e não chegam a desenvolver SIDA.</p>
  <p><a href="https://www.insa.min-saude.pt/relatorio-infecao-por-vih-em-portugal-2024/" target="_blank" style="color:var(--teal)">Em Portugal, o relatório do INSA de 2024 estima cerca de 49.700 pessoas a viver com VIH e registou 924 novos diagnósticos em 2023.</a></p>

  <h3>Como se transmite o VIH?</h3>
  <ul>
    <li>Via sexual: sexo anal recetivo (maior risco), sexo anal, sexo vaginal, sexo oral (risco muito baixo)</li>
    <li><a href="#gl-parenteral" style="color:var(--teal)">Via parenteral</a>: partilha de seringas e agulhas, transfusões de sangue, acidentes com agulhas</li>
    <li><a href="#gl-vertical" style="color:var(--teal)">Transmissão vertical</a>: durante a gravidez, o parto ou o aleitamento materno. Com terapia antirretroviral adequada, o risco de transmissão vertical é inferior a 1%.</li>
  </ul>

  <h3>Quais são os sintomas do VIH e como evolui a infeção?</h3>
  <h4>Infeção VIH aguda (2 a 4 semanas após exposição):</h4>
  <p>Síndrome retroviral aguda: febre, <a href="#gl-linfadenopatia" style="color:var(--teal)">linfadenopatia</a>, faringite, <a href="#gl-exantema" style="color:var(--teal)">exantema</a>, mialgia, cefaleias. Estes sintomas são autolimitados e frequentemente confundidos com uma gripe ou <a href="#gl-mononucleose" style="color:var(--teal)">mononucleose</a>.</p>
  <h4>Fase crónica assintomática (anos a décadas):</h4>
  <p>A replicação viral continua, com destruição progressiva dos <a href="#gl-cd4" style="color:var(--teal)">linfócitos CD4</a>. Sem tratamento, a mediana de progressão para SIDA é de cerca de 10 anos.</p>
  <h4>SIDA:</h4>
  <p>É a fase avançada da infeção por <a href="#gl-hiv" style="color:var(--teal)">VIH</a> e pode estar associada a <a href="#gl-oportunista" style="color:var(--teal)">infeções oportunistas</a>, determinadas neoplasias e outras complicações resultantes da fragilização do sistema imunitário.</p>

  <h3>Como é feito o teste e o diagnóstico do VIH?</h3>
  <ul>
    <li>Teste combinado Ag/Ac de 4ª geração: deteta simultaneamente o antigénio p24 e anticorpos anti-VIH, com janela diagnóstica de 18 a 45 dias após a exposição</li>
    <li>Western blot ou <a href="#gl-pcr" style="color:var(--teal)">PCR</a>: para confirmação de resultados positivos</li>
    <li><a href="#gl-carga-viral" style="color:var(--teal)">Carga viral</a> (PCR-VIH): quantifica o número de cópias virais no sangue</li>
    <li>Contagem de <a href="#gl-cd4" style="color:var(--teal)">CD4</a>: avalia o estado imunitário</li>
    <li>Teste rápido em sangue capilar: resultado em 15 a 20 minutos, disponível em checkpoints e centros de rastreio comunitário</li>
  </ul>

  <h3>O VIH tem tratamento? O que significa Indetetável = Intransmissível?</h3>
  <p>O tratamento da infeção por VIH é feito com terapia antirretroviral combinada (cART). Os objetivos são a supressão da <a href="#gl-carga-viral" style="color:var(--teal)">carga viral</a> para níveis indetetáveis (inferior a 50 cópias/mL), a preservação do sistema imunitário e a prevenção da transmissão.</p>
  <p><a href="https://pubmed.ncbi.nlm.nih.gov/31056293/" target="_blank" style="color:var(--teal)">O princípio Indetetável = Intransmissível (I=I)</a>, validado pelo <a href="https://pubmed.ncbi.nlm.nih.gov/21091279/" target="_blank" style="color:var(--teal)">estudo PARTNER 2 (Rodger et al., 2019)</a> e outros, demonstra que uma pessoa em tratamento com carga viral indetetável não transmite o VIH por via sexual.</p>
  <p>Com tratamento adequado, a esperança de vida de uma pessoa diagnosticada precocemente com VIH aproxima-se da população geral.</p>

  <h3>Como prevenir o VIH? Preservativo, PrEP e PEP</h3>
  <ul>
    <li>Preservativo: eficácia elevada quando usado corretamente e consistentemente</li>
    <li><a href="#gl-prep" style="color:var(--teal)">PrEP</a> (profilaxia pré-exposição): tenofovir/emtricitabina 1 comprimido/dia, eficácia superior a 99%, <a href="https://www.sns24.gov.pt/pt/tema/prevencao-e-cuidados-de-saude/prevencao-da-infecao-por-vih/" target="_blank" style="color:var(--teal)">disponível gratuitamente no SNS português</a></li>
    <li><a href="#gl-pep" style="color:var(--teal)">PEP</a> (profilaxia pós-exposição): iniciar o mais rapidamente possível e sempre antes das 72 horas após exposição de risco</li>
    <li>I=I: tratar as pessoas seropositivas é em si uma medida de prevenção coletiva</li>
  </ul>

  <h2>Herpes genital: sintomas, transmissão e tratamento</h2>

  <h3>O que é o herpes genital?</h3>
  <p>O herpes genital é causado pelo vírus herpes <em>simplex</em> tipo 2 (<a href="#gl-hsv" style="color:var(--teal)">HSV-2</a>), responsável pela maioria dos casos de herpes genital recorrente, e pelo HSV-1. <a href="https://www.who.int/news-room/fact-sheets/detail/herpes-simplex-virus" target="_blank" style="color:var(--teal)">A OMS estima que cerca de 520 milhões de pessoas no mundo tenham infeção por HSV-2 (WHO, 2025).</a></p>

  <h3>Como se transmite o herpes genital?</h3>
  <ul>
    <li>Contacto sexual (vaginal, anal, oral) com lesões ativas ou por excreção viral <a href="#gl-assintomatico" style="color:var(--teal)">assintomática</a> (<a href="#gl-shedding" style="color:var(--teal)">shedding</a>)</li>
    <li>Transmissão assintomática: responsável pela maioria das novas infeções</li>
    <li><a href="#gl-vertical" style="color:var(--teal)">Transmissão vertical</a>: herpes neonatal, potencialmente grave, por contacto com secreções genitais infetadas durante o parto</li>
  </ul>

  <h3>Quais são os sintomas do herpes genital?</h3>
  <h4>Episódio primário (habitualmente o mais grave):</h4>
  <ul>
    <li>Aparecimento de vesículas dolorosas nos genitais, períneo, nádegas ou ânus, que evoluem para úlceras superficiais</li>
    <li>Dor, comichão e ardor locais</li>
    <li>Sintomas constitucionais: febre, mialgia, cefaleias, <a href="#gl-linfadenopatia" style="color:var(--teal)">linfadenopatia</a> inguinal</li>
    <li><a href="#gl-disuria" style="color:var(--teal)">Disúria</a> intensa, por vezes requerendo algaliação temporária</li>
  </ul>
  <h4>Reativações (recorrências):</h4>
  <p>O <a href="#gl-hsv" style="color:var(--teal)">HSV</a> permanece latente nos gânglios sensitivos e pode reativar periodicamente. As recorrências são geralmente mais ligeiras, frequentemente precedidas de <a href="#gl-prodromo" style="color:var(--teal)">pródromos</a> (formigueiro, ardor, dor local).</p>

  <h3>Como é diagnosticada a infeção por vírus herpes simplex?</h3>
  <ul>
    <li><a href="#gl-pcr" style="color:var(--teal)">PCR</a> em lesões: método de referência, diferencia HSV-1 de HSV-2</li>
    <li>Cultura viral: menos sensível, útil para testes de sensibilidade antiviral</li>
    <li><a href="#gl-serologia" style="color:var(--teal)">Serologia</a> (anticorpos anti-HSV tipo-específicos): pode confirmar infeção prévia mesmo na ausência de lesões</li>
  </ul>

  <h3>Como é tratado o herpes genital?</h3>
  <ul>
    <li>Episódio primário: aciclovir 400 mg 3x/dia durante 5 a 10 dias; alternativa valaciclovir 1g 2x/dia durante 10 dias</li>
    <li>Recorrências: tratamento episódico iniciado no <a href="#gl-prodromo" style="color:var(--teal)">pródromo</a> ou terapia supressiva diária para pessoas com mais de 6 recorrências por ano</li>
    <li>Terapia supressiva reduz o <a href="#gl-shedding" style="color:var(--teal)">shedding</a> viral assintomático em mais de 90%</li>
  </ul>

  <h2>HPV e verrugas genitais: transmissão, prevenção e vacinação</h2>

  <h3>O que é o HPV?</h3>
  <p>O <a href="#gl-hpv" style="color:var(--teal)">papilomavírus humano (HPV)</a> é o vírus de transmissão sexual mais prevalente. Existem mais de 200 <a href="#gl-genotipagem" style="color:var(--teal)">genótipos</a> de HPV, classificados em:</p>
  <ul>
    <li>Tipos de baixo risco oncogénico (HPV 6, 11): causam verrugas genitais (condilomas acuminados)</li>
    <li>Tipos de alto risco oncogénico (HPV 16, 18, 31, 33, 45, entre outros): associados ao cancro do colo do útero, ânus, vulva, vagina, pénis, orofaringe</li>
  </ul>

  <h3>Como se transmite o HPV?</h3>
  <ul>
    <li>Contacto sexual direto, génito-genital, oral-genital ou anal</li>
    <li>Transmissão possível mesmo sem penetração, por contacto cutâneo com regiões infetadas</li>
    <li>O preservativo confere proteção parcial, não total</li>
  </ul>

  <h3>Quais são os sintomas de infeção por papilomavírus?</h3>
  <p>A maioria das infeções por <a href="#gl-hpv" style="color:var(--teal)">HPV</a> é transitória e resolve espontaneamente em 1 a 2 anos. Nas situações em que a infeção persiste:</p>
  <ul>
    <li>Verrugas genitais (condilomas acuminados): lesões únicas ou múltiplas, nos genitais, períneo e ânus</li>
    <li>Lesões intraepiteliais: alterações celulares que podem evoluir para cancro, detetadas pelo rastreio citológico</li>
  </ul>

  <h3>Como é feito o diagnóstico de HPV?</h3>
  <ul>
    <li>Diagnóstico clínico das verrugas genitais: habitualmente feito por inspeção visual</li>
    <li><a href="#gl-genotipagem" style="color:var(--teal)">Genotipagem</a> de HPV: identifica os genótipos presentes</li>
    <li><a href="#gl-colposcopia" style="color:var(--teal)">Colposcopia</a>: exame do colo do útero com ampliação ótica, recomendado após citologia alterada</li>
    <li>Rastreio do cancro do colo do útero: citologia (Papanicolau) e/ou teste de HPV, recomendado em mulheres a partir dos 25 anos em Portugal</li>
  </ul>

  <h3>Como funciona a vacinação contra o HPV?</h3>
  <p><a href="https://pubmed.ncbi.nlm.nih.gov/28886907/" target="_blank" style="color:var(--teal)">Vacina nonavalente (Gardasil 9): protege contra os genótipos 6, 11, 16, 18, 31, 33, 45, 52 e 58, com eficácia superior a 97% na prevenção de lesões intraepiteliais de alto grau (Huh et al., 2017).</a></p>
  <ul>
    <li>Em Portugal, incluída no <a href="https://www.sns24.gov.pt/pt/tema/vacinas/programa-nacional-de-vacinacao" target="_blank" style="color:var(--teal)">Programa Nacional de Vacinação</a> para raparigas e rapazes no 2º ano de escolaridade</li>
    <li>A vacinação é recomendada até aos 26 anos; pode ser considerada entre os 27 e os 45 anos após discussão clínica</li>
    <li>Mais eficaz antes do início da atividade sexual, mas confere proteção também em pessoas já sexualmente ativas</li>
  </ul>

  <h2>Hepatite B: transmissão, sintomas e prevenção</h2>

  <h3>O que é a hepatite B?</h3>
  <p>A hepatite B é causada pelo vírus da hepatite B (<a href="#gl-vhb" style="color:var(--teal)">VHB</a>), um <a href="#gl-hepadnavirus" style="color:var(--teal)">hepadnavírus</a> de transmissão sexual e parenteral. <a href="https://www.who.int/news-room/fact-sheets/detail/hepatitis-b" target="_blank" style="color:var(--teal)">A OMS estima que 240 milhões de pessoas viviam com infeção crónica por VHB no mundo em 2024 (WHO, 2026).</a></p>

  <h3>Como se transmite a hepatite B?</h3>
  <ul>
    <li>Via sexual: o VHB é 100 vezes mais transmissível por via sexual do que o VIH</li>
    <li><a href="#gl-parenteral" style="color:var(--teal)">Via parenteral</a>: partilha de agulhas, seringas ou outros materiais de injeção</li>
    <li><a href="#gl-vertical" style="color:var(--teal)">Transmissão vertical</a>: da mãe para o filho durante o parto</li>
    <li>Contacto com sangue ou outros fluidos corporais infetados</li>
  </ul>

  <h3>Quais são os sintomas da hepatite B?</h3>
  <p>A hepatite B aguda é <a href="#gl-assintomatico" style="color:var(--teal)">assintomática</a> em mais de 50% dos casos. Quando sintomática, pode causar icterícia, fadiga, náuseas, dor abdominal direita e colestase. A infeção crónica pode progredir para cirrose e <a href="#gl-hepatocelular" style="color:var(--teal)">carcinoma hepatocelular</a>.</p>

  <h3>Como é feito o diagnóstico da hepatite B?</h3>
  <ul>
    <li>HBsAg (antigénio de superfície do VHB): marcador de infeção ativa</li>
    <li>Anti-HBs: anticorpos protetores após vacinação ou infeção resolvida</li>
    <li>Anti-HBc total: marcador de contacto prévio com o vírus</li>
    <li><a href="#gl-carga-viral" style="color:var(--teal)">Carga viral</a> (ADN-VHB): quantifica a replicação viral</li>
  </ul>

  <h3>Qual é o tratamento e a forma de prevenção da hepatite B?</h3>
  <ul>
    <li>Vacinação: 3 doses, altamente eficaz (mais de 95%), incluída no <a href="https://www.sns24.gov.pt/pt/tema/vacinas/programa-nacional-de-vacinacao" target="_blank" style="color:var(--teal)">Programa Nacional de Vacinação</a> em Portugal</li>
    <li>Profilaxia pós-exposição: imunoglobulina anti-hepatite B (HBIG) e início de vacinação nas primeiras 24 a 48 horas</li>
    <li>Tratamento da hepatite B crónica: análogos dos nucleotídeos (tenofovir, entecavir), que suprimem a replicação viral</li>
  </ul>

  <h2>Hepatite C: transmissão, diagnóstico e tratamento</h2>

  <h3>O que é a hepatite C?</h3>
  <p>A hepatite C é causada pelo vírus da hepatite C (<a href="#gl-vhc" style="color:var(--teal)">VHC</a>), um flavivírus com elevada variabilidade genética. <a href="https://www.who.int/news-room/fact-sheets/detail/hepatitis-c" target="_blank" style="color:var(--teal)">A OMS estima 47 milhões de pessoas com infeção crónica (WHO, 2026).</a></p>

  <h3>Como se transmite a hepatite C?</h3>
  <ul>
    <li><a href="#gl-parenteral" style="color:var(--teal)">Via parenteral</a>: principal via de transmissão (partilha de agulhas e seringas, tatuagens e piercings em ambientes não esterilizados)</li>
    <li>Via sexual: especialmente com práticas associadas a traumatismo mucoso e <a href="#gl-coinfeção" style="color:var(--teal)">coinfeção</a> por VIH</li>
    <li><a href="#gl-vertical" style="color:var(--teal)">Transmissão vertical</a>: risco de 5% a 8%</li>
  </ul>

  <h3>Quais são os sintomas da hepatite C?</h3>
  <p>A hepatite C aguda é <a href="#gl-assintomatico" style="color:var(--teal)">assintomática</a> em 80% dos casos. Os restantes 55% a 85% desenvolvem infeção crónica, com risco de progressão para cirrose (15% a 30% ao fim de 20 anos) e <a href="#gl-hepatocelular" style="color:var(--teal)">carcinoma hepatocelular</a>.</p>

  <h3>Como é feito o diagnóstico da hepatite C?</h3>
  <ul>
    <li>Anti-VHC: anticorpos que positivam 8 a 11 semanas após a infeção</li>
    <li>ARN-VHC (<a href="#gl-carga-viral" style="color:var(--teal)">carga viral</a>): confirma infeção ativa e monitoriza o tratamento</li>
    <li><a href="#gl-genotipagem" style="color:var(--teal)">Genotipagem</a>: orienta a escolha do tratamento</li>
  </ul>

  <h3>Como é tratada a hepatite C?</h3>
  <p>A hepatite C é atualmente curável em mais de 95% dos casos com antivirais de ação direta (AAD) de segunda geração, tomados durante 8 a 12 semanas. A cura virológica (<a href="#gl-rvs" style="color:var(--teal)">RVS</a>) é definida como RNA-VHC indetetável 12 semanas após o fim do tratamento. A cura não confere imunidade a reinfeções.</p>

  <h2>Tricomoníase: sintomas, diagnóstico e tratamento</h2>

  <h3>O que é a tricomoníase?</h3>
  <p>A tricomoníase é causada por <em>Trichomonas vaginalis</em>, um <a href="#gl-protozoario" style="color:var(--teal)">protozoário</a> <a href="#gl-flagelado" style="color:var(--teal)">flagelado</a>. <a href="https://www.who.int/news-room/fact-sheets/detail/trichomoniasis" target="_blank" style="color:var(--teal)">É a infeção sexualmente transmissível não viral mais prevalente no mundo, com a OMS a estimar 156 milhões de novos casos por ano (WHO, 2025).</a></p>

  <h3>Como se transmite a tricomoníase?</h3>
  <ul>
    <li>Contacto sexual génito-genital, principalmente vaginal</li>
    <li>Raramente por partilha de toalhas ou material de higiene íntima</li>
  </ul>

  <h3>Quais são os sintomas da tricomoníase?</h3>
  <p><a href="#gl-assintomatico" style="color:var(--teal)">Assintomática</a> em 70% das mulheres e em mais de 80% dos homens.</p>
  <h4>Tricomonas na mulher (quando sintomática):</h4>
  <ul>
    <li>Corrimento vaginal abundante, amarelo-esverdeado, espumoso e malcheiroso</li>
    <li>Prurido, ardor e edema vulvovaginal</li>
    <li><a href="#gl-disuria" style="color:var(--teal)">Disúria</a> e <a href="#gl-polaquiuria" style="color:var(--teal)">polaquiúria</a></li>
    <li>Colo do útero com aspeto "em morango" (eritema pontilhado) à <a href="#gl-colposcopia" style="color:var(--teal)">colposcopia</a></li>
  </ul>
  <h4>Tricomonas no homem (quando sintomático):</h4>
  <ul>
    <li>Corrimento uretral ligeiro</li>
    <li><a href="#gl-disuria" style="color:var(--teal)">Disúria</a></li>
    <li>Inflamação da glande (balanite)</li>
  </ul>

  <h3>Como é feito o diagnóstico da tricomoníase?</h3>
  <ul>
    <li><a href="#gl-pcr" style="color:var(--teal)">PCR/TAAN</a>: método mais sensível</li>
    <li>Exame a fresco do corrimento: visualização direta do <a href="#gl-protozoario" style="color:var(--teal)">protozoário</a> em movimento</li>
    <li>Cultura: elevada especificidade</li>
  </ul>

  <h3>Como é tratada a tricomoníase?</h3>
  <ul>
    <li>Metronidazol 2g por via oral em dose única (preferida pela OMS)</li>
    <li>Alternativa: metronidazol 400-500 mg 2x/dia durante 5 a 7 dias</li>
    <li>Os parceiros sexuais devem ser tratados simultaneamente, mesmo sem sintomas</li>
    <li>Evitar álcool durante e até 48 horas após o tratamento com metronidazol</li>
  </ul>

  <h2>Rastreio de IST por videoconsulta: como funciona?</h2>
  <p>O rastreio de IST por <a onclick="openArticle('consulta-online')" style="color:var(--teal);cursor:pointer;font-weight:600">videoconsulta</a> permite obter, na mesma consulta, a avaliação do risco individual, a prescrição das análises adequadas ao perfil de risco, a interpretação dos resultados e o tratamento quando indicado, tudo sem necessidade de deslocação física.</p>
  <p>Na ConsultasOnline, o rastreio de infeções sexualmente transmissíveis está disponível de segunda a domingo, das 9h às 21h, com fatura AT automática. O médico avalia o perfil de risco, prescreve o painel de análises adequado e acompanha na interpretação dos resultados.</p>
  <p>Em conclusão, as infeções sexualmente transmissíveis nem sempre provocam sintomas. Prevenção, vacinação quando disponível, utilização de preservativo e rastreio adequado ao risco continuam a ser ferramentas essenciais para proteger a saúde sexual.</p>

  <div class="art-cta"><h3>Teve uma exposição de risco ou quer fazer rastreio de IST?</h3><p>Avaliação médica por videoconsulta, sem deslocação. Prescrição de análises e interpretação de resultados.</p><button class="art-cta-btn" onclick="openServiceSelector()">Marcar Rastreio de IST →</button></div>

  <h2>Perguntas frequentes sobre infeções sexualmente transmissíveis</h2>

  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Posso ter uma IST mesmo sem sintomas? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Sim. Várias infeções sexualmente transmissíveis podem permanecer assintomáticas. Por isso, a ausência de sintomas não exclui uma infeção.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Quanto tempo depois de uma relação devo fazer testes de IST? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Depende da infeção e do teste utilizado. Algumas infeções podem ser identificadas mais cedo do que outras. Um profissional de saúde pode indicar o momento adequado em função da exposição.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Um teste de sangue deteta todas as IST? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Não. Algumas infeções sexualmente transmissíveis são pesquisadas através do sangue, enquanto outras podem exigir urina, zaragatoas ou colheita de lesões.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">O preservativo protege contra todas as infeções sexualmente transmissíveis? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Reduz significativamente o risco de muitas IST, mas não oferece proteção total contra infeções transmitidas por contacto com pele ou lesões fora da zona coberta.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">É possível ter mais do que uma IST ao mesmo tempo? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Sim. A presença de uma infeção sexualmente transmissível não impede a existência simultânea de outra. Em determinadas situações, o médico pode recomendar o rastreio de várias infeções.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Uma pessoa com VIH e carga viral indetetável transmite o vírus sexualmente? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Uma pessoa que mantém carga viral indetetável através de tratamento eficaz não transmite o VIH por via sexual. Este princípio é conhecido como Indetetável = Intransmissível (I=I).</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">O HPV pode desaparecer sem tratamento? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Muitas infeções por HPV tornam-se indetetáveis espontaneamente. Algumas infeções persistem e podem estar associadas a verrugas ou alterações celulares que exigem acompanhamento.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">A hepatite C tem cura? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Atualmente existem tratamentos antivirais capazes de curar a grande maioria das infeções por hepatite C.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Quando devo procurar avaliação médica com urgência? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Procure avaliação adequada perante sintomas intensos, agravamento rápido, febre associada a dor pélvica ou testicular, gravidez com suspeita de IST, exposição recente ao VIH que possa justificar PEP ou outras situações que suscitem preocupação clínica.</div>
  </div>

  <!-- GLOSSÁRIO -->
  <div id="glossario-ist" style="background:rgba(13,115,119,.06);border:1px solid rgba(13,115,119,.2);border-radius:12px;padding:18px 20px;margin:32px 0 24px">
    <h3 style="font-size:15px;font-weight:700;color:var(--teal);margin-bottom:12px">📖 Glossário — termos médicos explicados</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;font-size:13px">
      <div id="gl-assintomatico"><strong>Assintomático:</strong> sem sintomas visíveis ou percetíveis.</div>
      <div id="gl-bacteriana"><strong>Bactéria / bacteriana:</strong> microorganismo unicelular que pode causar infeções tratáveis com antibióticos.</div>
      <div id="gl-carga-viral"><strong>Carga viral:</strong> quantidade de vírus presente no sangue, medida em análise laboratorial.</div>
      <div id="gl-cd4"><strong>CD4 (linfócitos CD4):</strong> células do sistema imunitário que o VIH destrói progressivamente.</div>
      <div id="gl-cervicite"><strong>Cervicite:</strong> inflamação do colo do útero.</div>
      <div id="gl-coinfeção"><strong>Coinfeção:</strong> presença simultânea de duas ou mais infeções.</div>
      <div id="gl-colposcopia"><strong>Colposcopia:</strong> exame que examina o colo do útero com lupa de ampliação.</div>
      <div id="gl-congenita"><strong>Congénita:</strong> presente desde o nascimento, transmitida da mãe para o bebé.</div>
      <div id="gl-dip"><strong>DIP (Doença Inflamatória Pélvica):</strong> infeção que sobe ao útero, trompas e ovários; pode causar infertilidade.</div>
      <div id="gl-diplococo"><strong>Diplococácea:</strong> bactéria que aparece em pares ao microscópio.</div>
      <div id="gl-disuria"><strong>Disúria:</strong> dor ou ardor ao urinar.</div>
      <div id="gl-ecdc"><strong>ECDC:</strong> Centro Europeu de Prevenção e Controlo das Doenças.</div>
      <div id="gl-epididimite"><strong>Epididimite:</strong> inflamação do epidídimo, estrutura atrás do testículo; causa dor testicular.</div>
      <div id="gl-espiroqueta"><strong>Espiroqueta:</strong> bactéria em forma de espiral, como o Treponema pallidum (sífilis).</div>
      <div id="gl-exantema"><strong>Exantema:</strong> erupção cutânea generalizada na pele.</div>
      <div id="gl-flagelado"><strong>Flagelado:</strong> organismo com flagelo (filamento) que usa para se mover.</div>
      <div id="gl-genotipagem"><strong>Genotipagem:</strong> teste que identifica o tipo específico de vírus presente.</div>
      <div id="gl-gram"><strong>Gram-negativa:</strong> classificação bacteriana baseada numa técnica de coloração laboratorial.</div>
      <div id="gl-hepadnavirus"><strong>Hepadnavírus:</strong> família de vírus que infeta principalmente o fígado; inclui o vírus da hepatite B.</div>
      <div id="gl-hepatocelular"><strong>Carcinoma hepatocelular:</strong> cancro do fígado.</div>
      <div id="gl-hiv"><strong>VIH:</strong> vírus da imunodeficiência humana, que ataca o sistema imunitário.</div>
      <div id="gl-hpv"><strong>HPV:</strong> papilomavírus humano, vírus de transmissão sexual muito comum; alguns tipos causam cancro.</div>
      <div id="gl-hsv"><strong>HSV (vírus herpes simplex):</strong> vírus que causa herpes labial (HSV-1) e herpes genital (HSV-2).</div>
      <div id="gl-imunocompetente"><strong>Imunocompetente:</strong> pessoa com sistema imunitário a funcionar normalmente.</div>
      <div id="gl-intracelular"><strong>Intracelular obrigatório:</strong> microorganismo que só consegue sobreviver e reproduzir-se dentro de células.</div>
      <div id="gl-lgv"><strong>LGV (linfogranuloma venéreo):</strong> IST bacteriana que causa úlceras e gânglios inflamados na virilha.</div>
      <div id="gl-linfadenopatia"><strong>Linfadenopatia:</strong> gânglios linfáticos aumentados de tamanho ("nódulos" palpáveis).</div>
      <div id="gl-mononucleose"><strong>Mononucleose:</strong> doença viral conhecida por "doença do beijo", com febre, dor de garganta e gânglios.</div>
      <div id="gl-notificacao"><strong>Notificação (de caso):</strong> comunicação obrigatória de certos diagnósticos às autoridades de saúde pública.</div>
      <div id="gl-oportunista"><strong>Infeção oportunista:</strong> infeção que aproveita um sistema imunitário debilitado para se instalar.</div>
      <div id="gl-parenteral"><strong>Via parenteral:</strong> transmissão através do sangue (agulhas, transfusões).</div>
      <div id="gl-pcr"><strong>PCR / TAAN:</strong> técnica laboratorial muito sensível que deteta o material genético de um microorganismo.</div>
      <div id="gl-pep"><strong>PEP:</strong> profilaxia pós-exposição ao VIH; medicamento tomado até 72h após exposição de risco.</div>
      <div id="gl-polaquiuria"><strong>Polaquiúria:</strong> necessidade frequente de urinar.</div>
      <div id="gl-prep"><strong>PrEP:</strong> profilaxia pré-exposição ao VIH; medicamento preventivo para pessoas em risco.</div>
      <div id="gl-proctite"><strong>Proctite:</strong> inflamação do reto, causando dor e corrimento retal.</div>
      <div id="gl-prodromo"><strong>Pródromo:</strong> sintomas que antecedem uma doença ou recorrência (ex: formigueiro antes de herpes).</div>
      <div id="gl-protozoario"><strong>Protozoário:</strong> organismo unicelular mais complexo que uma bactéria; alguns causam infeções.</div>
      <div id="gl-rvs"><strong>RVS (resposta virológica sustentada):</strong> ausência de vírus detetável 12 semanas após tratamento; equivale a cura na hepatite C.</div>
      <div id="gl-serologia"><strong>Serologia:</strong> análise ao sangue que pesquisa anticorpos contra uma infeção.</div>
      <div id="gl-shedding"><strong>Shedding viral:</strong> excreção de vírus mesmo sem lesões visíveis, podendo transmitir a infeção.</div>
      <div id="gl-sida"><strong>SIDA:</strong> fase avançada da infeção por VIH, com sistema imunitário muito debilitado.</div>
      <div id="gl-subnotificacao"><strong>Subnotificação:</strong> quando o número real de casos é maior do que o registado oficialmente.</div>
      <div id="gl-treponema"><strong>Treponema pallidum:</strong> bactéria que causa a sífilis.</div>
      <div id="gl-vertical"><strong>Transmissão vertical:</strong> transmissão da mãe para o bebé durante a gravidez, parto ou amamentação.</div>
      <div id="gl-vhb"><strong>VHB:</strong> vírus da hepatite B.</div>
      <div id="gl-vhc"><strong>VHC:</strong> vírus da hepatite C.</div>
      <div id="gl-viral"><strong>Viral:</strong> causado por um vírus (não tratável com antibióticos).</div>
      <div id="gl-zaragatoa"><strong>Zaragatoa:</strong> cotonete esterilizado usado para colher amostras (uretra, vagina, ânus, garganta).</div>
    </div>
  </div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Centers for Disease Control and Prevention. (2021). Sexually transmitted infections treatment guidelines, 2021. <em>MMWR Recommendations and Reports, 70</em>(4), 1-187. https://doi.org/10.15585/mmwr.rr7004a1</li>
    <li>European Centre for Disease Prevention and Control. (2024). Bacterial STIs reach record highs in Europe. ECDC. https://www.ecdc.europa.eu/en/news-events/bacterial-stis-reach-record-highs-europe-congenital-syphilis-cases-nearly-double</li>
    <li>Grant, R. M., et al. (2010). Preexposure chemoprophylaxis for HIV prevention in men who have sex with men. <em>The New England Journal of Medicine, 363</em>(27), 2587-2599. https://doi.org/10.1056/NEJMoa1011205</li>
    <li>Huh, W. K., et al. (2017). Final efficacy, immunogenicity, and safety analyses of a nine-valent human papillomavirus vaccine in women aged 16-26 years. <em>Lancet, 390</em>(10108), 2143-2159. https://doi.org/10.1016/S0140-6736(17)31821-4</li>
    <li>International Union against Sexually Transmitted Infections (IUSTI). (2022). European guideline for the management of gonorrhoea in adults. IUSTI. https://iusti.org/treatment-guidelines/</li>
    <li>Rodger, A. J., et al. (2019). Risk of HIV transmission through condomless sex in serodifferent gay couples (PARTNER). <em>Lancet, 393</em>(10189), 2428-2438. https://doi.org/10.1016/S0140-6736(19)30418-0</li>
    <li>World Health Organization. (2025). Herpes simplex virus. <em>WHO Fact Sheet.</em> https://www.who.int/news-room/fact-sheets/detail/herpes-simplex-virus</li>
    <li>World Health Organization. (2025). Trichomoniasis. <em>WHO Fact Sheet.</em> https://www.who.int/news-room/fact-sheets/detail/trichomoniasis</li>
    <li>World Health Organization. (2026). Hepatitis B. <em>WHO Fact Sheet.</em> https://www.who.int/news-room/fact-sheets/detail/hepatitis-b</li>
    <li>World Health Organization. (2026). Hepatitis C. <em>WHO Fact Sheet.</em> https://www.who.int/news-room/fact-sheets/detail/hepatitis-c</li>
  </ol></div>

</div></div>
</div>
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
app.get('/obrigado', async (req, res) => {
  const sessionId = req.query.session_id || '';
  // Ir buscar o valor real pago ao Stripe, para enviar à Meta
  let purchaseValue = null;
  if (sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      purchaseValue = (session.amount_total / 100).toFixed(2);
    } catch (err) {
      console.error('Erro ao obter sessão Stripe para o Pixel:', err.message);
    }
  }
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
<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '2595831900877757');
fbq('track', 'PageView');
fbq('track', 'Purchase', {value: '${purchaseValue !== null ? purchaseValue : '0.00'}', currency: 'EUR'});
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=2595831900877757&ev=PageView&noscript=1"/></noscript>
<!-- End Meta Pixel Code -->
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
            'https://' + account + '.app.invoicexpress.com/clients.json?api_key=' + apiKey + '&client_name=' + encodeURIComponent(safeName)
          );
          const clients = searchRes.data && searchRes.data.clients;
          const matchedClient = clients && clients.find(c => c.name && c.name.toLowerCase() === safeName.toLowerCase());
          if (matchedClient) {
            clientId = matchedClient.id;
            console.log('InvoiceXpress cliente existente encontrado por nome:', clientId);
          } else {
            console.log('InvoiceXpress: nome nao encontrado, a criar cliente com codigo unico...');
            try {
              const retryRes = await axios.post(
                'https://' + account + '.app.invoicexpress.com/clients.json?api_key=' + apiKey,
                { client: {
                    name: safeName,
                    email: safeEmail,
                    code: safeEmail.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50),
                    country: 'Portugal',
                    ...(safeNif ? { fiscal_id: safeNif } : {})
                }}
              );
              clientId = retryRes.data.client.id;
              console.log('InvoiceXpress cliente criado com codigo unico:', clientId);
            } catch (retryErr) {
              console.error('InvoiceXpress erro na segunda tentativa:', JSON.stringify(retryErr.response && retryErr.response.data));
              return null;
            }
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
