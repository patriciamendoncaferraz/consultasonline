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
  'clamidia':                            { id: 'clamidia',                  category: 'Saúde Sexual' },
};

// Conteúdo SSR completo de cada artigo

const ARTICLES_CONTENT = {

'infecao-urinaria': {
  title: 'Infeção Urinária: Causas, Sintomas, Diagnóstico e Tratamento | ConsultasOnline',
  description: 'Guia médico completo sobre infeção urinária: sintomas, antibióticos recomendados em Portugal, prevenção e quando ir às urgências.',
  keywords: 'infeção urinária sintomas tratamento, antibiótico infeção urinária Portugal, cistite tratamento, infeção urinária recorrente',
  h1: 'Infeção Urinária: Causas, Sintomas, Diagnóstico e Tratamento',
  content: `<div class='cta-top'><p>💧 Tem sintomas de infeção urinária? Consulta online com diagnóstico e tratamento no próprio dia. <a href='/'>Marcar consulta — 40€ →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p>A infeção do trato urinário é uma das doenças infeciosas mais frequentes em Portugal e no mundo. Afeta sobretudo mulheres, e muitas delas conhecem bem a sensação: aquela urgência de ir à casa de banho de cinco em cinco minutos, o ardor ao urinar, o desconforto que não passa. Apesar de ser uma infeção muito comum, há aspetos do diagnóstico, do tratamento e sobretudo da prevenção que valem a pena conhecer bem, sobretudo para quem tem infeções repetidas.</p>
  <p>Este artigo explica o que é a infeção urinária, porque acontece, como se diagnostica, quais os antibióticos recomendados em Portugal e o que fazer para evitar que volte.</p>

  <h2>O que é a infeção do trato urinário?</h2>
  <p>A infeção do trato urinário (ITU) é uma infeção causada por bactérias que colonizam e se multiplicam no aparelho urinário, que inclui os rins, os ureteres, a bexiga e a uretra. Consoante a localização da infeção, fala-se em cistite (infeção da bexiga, a mais comum), pielonefrite (infeção dos rins, mais grave) e uretrite (infeção da uretra).</p>
  <p>Em Portugal, <a href="https://revista.spmi.pt/index.php/rpmi/article/download/1016/667/2654" target="_blank" style="color:var(--teal)">a infeção urinária é a segunda doença infeciosa mais frequente na comunidade</a>, a seguir às infeções respiratórias (Rocha et al., 2014). Num estudo realizado em Lisboa com 8.869 culturas de urina, foi encontrada uma prevalência de ITU de 18% na população estudada (Guerreiro, 2010).</p>
  <p>A bactéria responsável pela grande maioria dos casos é a <em>Escherichia coli</em>, que habita naturalmente o intestino e que, por razões anatómicas, chega com facilidade à uretra feminina. Num estudo de ambulatório no distrito de Coimbra com mais de 7.000 uroculturas positivas, <a href="https://actamedicaportuguesa.com/revista/index.php/amp/article/download/10862/5752/47754" target="_blank" style="color:var(--teal)"><em>E. coli</em> foi o microrganismo mais frequente</a>, correspondendo à maioria dos casos de ITU na comunidade (Curto et al., 2019).</p>

  <h2>Porque é que a infeção urinária é muito mais frequente nas mulheres?</h2>
  <p>A anatomia feminina é o principal fator. A uretra das mulheres tem apenas 3 a 4 cm de comprimento, ao contrário dos 15 a 20 cm da uretra masculina, e está muito próxima do ânus e da vagina, o que facilita a entrada de bactérias na bexiga. Esta diferença anatómica explica porque cerca de 40% das mulheres terão pelo menos uma infeção urinária ao longo da vida, e porque 20 a 30% das mulheres têm infeções recorrentes (três ou mais episódios por ano, ou dois ou mais em seis meses), segundo as guidelines da Associação Europeia de Urologia (Bonkat et al., 2024).</p>
  <p>Outros fatores que aumentam o risco incluem:</p>
  <ul>
    <li>Actividade sexual: o risco de ITU após relação sexual é cerca de 30 vezes superior ao de outros momentos; a chamada "cistite da lua de mel" é bem conhecida clinicamente</li>
    <li>Menopausa: a queda de estrogénio altera a flora vaginal e o pH urinário, tornando o trato urinário mais vulnerável</li>
    <li>Gravidez: as alterações hormonais e anatómicas aumentam o risco, e uma ITU na gravidez tem de ser sempre tratada mesmo sem sintomas</li>
    <li>Diabetes: o excesso de glicose na urina cria um ambiente favorável ao crescimento bacteriano</li>
    <li>Anomalias estruturais do trato urinário: refluxo vesicoureteral, cálculos renais ou obstrução urinária</li>
    <li>Uso de cateter urinário</li>
    <li>Histórico de ITU prévia: ser o fator de risco independente mais forte para episódios futuros</li>
  </ul>

  <h2>Quais são os sintomas da infeção urinária?</h2>
  <p>Os sintomas da cistite aguda não complicada são geralmente muito característicos e permitem o diagnóstico clínico com elevada probabilidade. De acordo com as guidelines da EAU, a presença simultânea de disúria e polaquiúria sem corrimento vaginal tem um valor preditivo positivo superior a 90% para ITU (Bonkat et al., 2024).</p>

  <h3>Sintomas de cistite (infeção da bexiga)</h3>
  <ul>
    <li>Disúria: dor, ardor ou picada ao urinar, o sintoma mais típico</li>
    <li>Polaquiúria: necessidade frequente de urinar em pequenas quantidades</li>
    <li>Urgência miccional: sensação de necessidade imperiosa de urinar que não dá tempo de esperar</li>
    <li>Hematúria: urina com sangue, visível ou microscópica, presente em cerca de 30% dos casos</li>
    <li>Dor ou pressão na zona suprapúbica (região inferior do abdómen)</li>
    <li>Urina turva ou com cheiro diferente do habitual</li>
  </ul>
  <p>A cistite não complicada não costuma causar febre. A presença de febre, especialmente acima de 38ºC, sugere que a infeção subiu até aos rins.</p>

  <h3>Sintomas de pielonefrite (infeção dos rins)</h3>
  <p>A pielonefrite é uma forma mais grave de ITU que exige avaliação médica urgente. Os sintomas incluem:</p>
  <ul>
    <li>Febre alta (frequentemente acima de 38,5ºC), com calafrios</li>
    <li>Dor lombar intensa, geralmente unilateral (dor nas costas, na zona dos rins)</li>
    <li>Náuseas e vómitos</li>
    <li>Mal-estar geral e prostração</li>
    <li>Sintomas de cistite que podem ou não estar presentes</li>
  </ul>
  <div class="ibox warn"><div class="ibox-title">⚠️ Quando ir às urgências</div><p>Se tiver febre acima de 38,5ºC, dores lombares intensas, vómitos ou se for grávida, a avaliação deve ser presencial e urgente. A pielonefrite pode evoluir para sépsis se não for tratada atempadamente. Uma videoconsulta é adequada para a cistite não complicada, mas não substitui a urgência nestes casos.</p></div>

  <h2>Como se diagnostica a infeção urinária?</h2>
  <p>Na mulher com sintomas típicos de cistite não complicada, o diagnóstico é essencialmente clínico. Não é necessário fazer urocultura de rotina antes de iniciar o tratamento numa mulher jovem, saudável, não grávida, com os sintomas clássicos (Bonkat et al., 2024).</p>

  <h3>Tira de urina (uroanálise)</h3>
  <p>A tira de urina é um teste rápido que pode ser feito em casa ou na farmácia e que pesquisa a presença de nitritos (produzidos pelas bactérias) e leucócitos (glóbulos brancos, indicadores de inflamação). Um resultado positivo para nitritos tem alta especificidade para ITU bacteriana. Um resultado negativo, contudo, não exclui completamente a infeção, especialmente em infeções por bactérias que não produzem nitritos.</p>

  <h3>Urocultura</h3>
  <p>A urocultura é o exame que identifica exatamente qual a bactéria responsável pela infeção e quais os antibióticos a que é sensível (antibiograma). É obrigatória nas seguintes situações:</p>
  <ul>
    <li>Grávidas (qualquer suspeita de ITU na gravidez deve ser confirmada e tratada com base em urocultura)</li>
    <li>Pielonefrite</li>
    <li>ITU em homens (sempre considerada complicada)</li>
    <li>Infeções recorrentes (para identificar padrões de resistência)</li>
    <li>Falência do tratamento após 48 a 72 horas</li>
    <li>Pessoas imunodeprimidas, diabéticas ou com anomalias estruturais do trato urinário</li>
  </ul>
  <p>A urocultura deve ser feita com amostra de urina do jato médio, recolhida após higiene cuidadosa dos genitais, preferencialmente a primeira urina da manhã ou após pelo menos 4 horas sem urinar.</p>

  <h3>Diagnóstico por videoconsulta</h3>
  <p>Na cistite não complicada numa mulher jovem e saudável, o diagnóstico pode ser feito por <a href="/artigos/consulta-online">videoconsulta</a> com base na história clínica e nos sintomas. O médico avalia os sintomas, exclui situações de maior gravidade e, quando clinicamente adequado, prescreve o antibiótico recomendado pelas guidelines nacionais. Se for necessário fazer urocultura, o médico prescreve a análise para o laboratório à escolha da pessoa.</p>

  <h2>Tratamento da infeção urinária: quais os antibióticos recomendados em Portugal</h2>
  <p>O tratamento da cistite aguda não complicada em Portugal segue as orientações da Direção-Geral da Saúde e as guidelines da EAU, adaptadas ao padrão local de resistências bacterianas. A resistência crescente de <em>E. coli</em> a vários antibióticos, incluindo as fluoroquinolonas (como a ciprofloxacina) e a amoxicilina com ácido clavulânico, torna fundamental que a escolha do antibiótico seja feita por um médico com base no quadro clínico e nos dados de resistência locais (Curto et al., 2019).</p>

  <h3>Antibióticos de primeira linha para cistite não complicada</h3>
  <p>De acordo com as guidelines da EAU de 2024 e as orientações da DGS, os antibióticos de primeira linha preferidos em Portugal são (Bonkat et al., 2024):</p>
  <ul>
    <li><strong>Nitrofurantoína 100 mg (libertação modificada) duas vezes por dia durante 5 dias:</strong> excelente atividade contra <em>E. coli</em> com baixas taxas de resistência em Portugal. Não deve ser usada em pielonefrite nem em insuficiência renal moderada a grave.</li>
    <li><strong>Fosfomicina trometamol 3g em dose única:</strong> muito conveniente pela toma única, boa atividade, incluindo contra estirpes produtoras de ESBL. Uma das melhores opções para situações em que a aderência pode ser um problema.</li>
    <li><strong>Pivmecilinam 400 mg três vezes por dia durante 3 a 7 dias:</strong> recomendado pelas guidelines europeias, com menor impacto na flora intestinal. Disponível em Portugal.</li>
  </ul>

  <h3>Antibióticos a evitar em primeira linha</h3>
  <ul>
    <li><strong>Fluoroquinolonas (ciprofloxacina, norfloxacina, levofloxacina):</strong> apesar de eficazes, as guidelines da EAU e a DGS recomendam reservá-las para situações em que outros antibióticos não podem ser usados, devido ao aumento de resistências e aos efeitos adversos graves associados (nomeadamente tendinopatia e neuropatia)</li>
    <li><strong>Amoxicilina com ácido clavulânico:</strong> as taxas de resistência de <em>E. coli</em> a este antibiótico em Portugal são elevadas, tornando-o inadequado como opção empírica de primeira linha</li>
    <li><strong>Trimetoprim/sulfametoxazol:</strong> as taxas de resistência locais superiores a 20% desaconselham o seu uso empírico sem urocultura prévia</li>
  </ul>

  <h3>Tratamento da pielonefrite</h3>
  <p>A pielonefrite exige antibioticoterapia durante 7 a 14 dias, com escolha do antibiótico idealmente baseada em urocultura. Os casos moderados a graves, com vómitos que impedem a toma de medicação oral ou sinais de sépsis, requerem internamento e antibioticoterapia endovenosa.</p>

  <h3>ITU na gravidez</h3>
  <p>Qualquer ITU na gravidez, incluindo a bacteriúria assintomática (bactérias na urina sem sintomas), deve ser tratada com antibiótico. As opções mais seguras durante a gravidez são a nitrofurantoína (evitar no 3.º trimestre), a cefalexina e a amoxicilina com ácido clavulânico quando a sensibilidade estiver confirmada. O tratamento deve ser baseado no resultado da urocultura.</p>

  <h3>ITU no homem</h3>
  <p>A ITU no homem é sempre considerada complicada pelas guidelines da EAU, porque pode envolver a próstata. Requer urocultura obrigatória, investigação de causa subjacente e antibioticoterapia mais prolongada (habitualmente 7 a 14 dias com fluoroquinolona ou trimetoprim, dependendo da sensibilidade).</p>

  <h2>Infeção urinária recorrente: o que fazer</h2>
  <p>A ITU recorrente, definida como três ou mais episódios por ano ou dois ou mais em seis meses, afeta uma percentagem significativa das mulheres e representa um problema real no dia a dia. Existem várias estratégias de prevenção com evidência científica.</p>

  <h3>Medidas não farmacológicas</h3>
  <ul>
    <li><strong>Ingestão adequada de líquidos:</strong> beber 1,5 a 2 litros de água por dia dilui a urina e favorece o "flush" bacteriano. A EAU recomenda aumentar a ingestão de água como medida preventiva (Bonkat et al., 2024)</li>
    <li><strong>Micção pós-coital:</strong> urinar após as relações sexuais reduz significativamente o risco de cistite pós-coito, eliminando as bactérias que possam ter entrado na uretra durante a relação</li>
    <li><strong>Higiene correta:</strong> limpar da frente para trás após usar a casa de banho, para evitar a transferência de bactérias do ânus para a uretra</li>
    <li><strong>Evitar produtos de higiene íntima agressivos:</strong> sabonetes, géis e desodorizantes íntimos podem alterar o pH vaginal e a flora local, facilitando as infeções. A água morna é suficiente para a higiene íntima diária</li>
    <li><strong>Arando (Vaccinium macrocarpon):</strong> os estudos mostram uma redução modesta mas consistente do risco de ITU recorrente com o consumo regular de arando, provavelmente por inibir a adesão de <em>E. coli</em> às células uroteliais. As guidelines da EAU reconhecem este benefício como modesto mas real (Bonkat et al., 2024)</li>
    <li><strong>Probióticos com Lactobacillus:</strong> a administração intravaginal de lactobacilos pode ajudar a restaurar a flora vaginal protetora, especialmente em mulheres pós-menopáusicas</li>
  </ul>

  <h3>Medidas farmacológicas preventivas</h3>
  <ul>
    <li><strong>Profilaxia antibiótica contínua de baixa dose:</strong> em mulheres com ITU muito frequentes, o médico pode prescrever um antibiótico em dose baixa diária (habitualmente nitrofurantoína ou trimetoprim) durante 3 a 6 meses. A eficácia é elevada, mas aumenta o risco de resistências</li>
    <li><strong>Profilaxia pós-coital:</strong> uma dose única de antibiótico após a relação sexual, preferida quando as infeções estão claramente relacionadas com a atividade sexual</li>
    <li><strong>Terapia auto-iniciada:</strong> em mulheres com história bem documentada e capacidade de reconhecer os sintomas, o médico pode prescrever um antibiótico para ser iniciado pela própria quando surgem sintomas. Requer acompanhamento médico próximo</li>
    <li><strong>Estrogénio tópico vaginal:</strong> nas mulheres pós-menopáusicas, a aplicação local de estrogénio restaura o pH vaginal e a flora de Lactobacillus, reduzindo significativamente a frequência de ITU</li>
    <li><strong>Imunoestimulação com Uro-Vaxom:</strong> vacina bacteriana oral com lisado de <em>E. coli</em>, com evidência de redução da frequência de ITU recorrente. Reconhecida pelas guidelines da EAU como opção válida</li>
  </ul>

  <div class="art-cta"><h3>Tem sintomas de infeção urinária?</h3><p>Diagnóstico e prescrição de antibiótico por videoconsulta no próprio dia. Disponível de segunda a domingo, das 9h às 21h.</p><a href="/">Marcar Consulta — 40€ →</a></div>

  <h2>Perguntas frequentes sobre infeção urinária</h2>

  <div class="faq"><h4>Posso tratar a infeção urinária sem ir ao médico?</h4><p>Os antibióticos são necessários para tratar a infeção urinária e exigem prescrição médica. Tomar antibióticos sem prescrição ou partilhar os de um episódio anterior contribui para o aumento de resistências e pode não resolver a infeção se a bactéria causadora for resistente ao antibiótico em questão. Numa cistite não complicada, a consulta por videoconsulta é uma solução rápida e sem necessidade de sair de casa.</p></div>
  <div class="faq"><h4>A infeção urinária pode passar sozinha sem antibiótico?</h4><p>Alguns estudos mostram que uma minoria dos casos de cistite ligeira pode resolver espontaneamente, mas o risco de progressão para pielonefrite justifica o tratamento antibiótico. As guidelines da EAU recomendam tratamento em todos os casos sintomáticos. Aguardar sem tratar não é aconselhável.</p></div>
  <div class="faq"><h4>Quanto tempo demora a infeção urinária a melhorar com antibiótico?</h4><p>Na cistite tratada com o antibiótico adequado, a melhoria dos sintomas ocorre habitualmente em 24 a 48 horas. Se não houver melhoria ao fim de 48 a 72 horas, é necessário reavaliação médica, urocultura e eventual mudança de antibiótico.</p></div>
  <div class="faq"><h4>Preciso de fazer urocultura antes de tomar o antibiótico?</h4><p>Na cistite não complicada numa mulher jovem e saudável com sintomas típicos, não é necessário fazer urocultura antes de iniciar o tratamento. A urocultura é obrigatória nas grávidas, em caso de pielonefrite, ITU no homem, infeções recorrentes ou falência do tratamento.</p></div>
  <div class="faq"><h4>O arando realmente ajuda a prevenir a infeção urinária?</h4><p>Há evidência de um benefício modesto mas real na prevenção de ITU recorrente, especialmente quando se toma regularmente e em quantidade suficiente. As guidelines da EAU reconhecem esta evidência. O sumo de arando tem menos evidência do que os extratos concentrados em cápsulas.</p></div>
  <div class="faq"><h4>A infeção urinária é contagiosa?</h4><p>A infeção urinária em si não é contagiosa. A bactéria que a causa, geralmente <em>E. coli</em>, faz parte da flora intestinal normal e não se transmite de pessoa para pessoa por contacto casual. Durante a relação sexual, pode haver migração de bactérias para a uretra, mas não é considerada uma infeção sexualmente transmissível.</p></div>
  <div class="faq"><h4>Posso fazer a consulta de infeção urinária por videoconsulta?</h4><p>Sim, na cistite não complicada. O médico avalia os sintomas por videoconsulta, exclui sinais de alarme e, quando adequado, prescreve o antibiótico de primeira linha. Se forem necessárias análises, prescreve a urocultura para fazer num laboratório próximo. Em caso de febre alta, dores lombares intensas ou vómitos, a avaliação deve ser presencial e urgente.</p></div>
  <div class="faq"><h4>Tenho infeções urinárias repetidas. O que posso fazer?</h4><p>Existem várias estratégias preventivas com evidência científica: beber mais água, urinar após as relações sexuais, arando em extrato concentrado, probióticos com Lactobacillus, estrogénio vaginal tópico nas mulheres pós-menopáusicas, profilaxia antibiótica de baixa dose ou pós-coital, e imunoestimulação com Uro-Vaxom. A escolha da estratégia depende do perfil individual e deve ser decidida com o médico.</p></div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Bonkat, G., Bartoletti, R., Bruyère, F., Cai, T., Geerlings, S. E., Köves, B., Kranz, J., Schubert, S., Pilatz, A., Veeratterapillay, R., & Wagenlehner, F. (2024). EAU Guidelines on Urological Infections. <em>European Association of Urology.</em> https://uroweb.org/guidelines/urological-infections</li>
    <li>Curto, C., Rosendo, I., & Santiago, L. M. (2019). Perfil de sensibilidade aos antibióticos na infeção urinária em ambulatório no distrito de Coimbra: um estudo transversal. <em>Acta Médica Portuguesa, 32</em>(9), 568-575. https://doi.org/10.20344/amp.10862</li>
    <li>Guerreiro, A. (2010). <em>Prevalência e resistências da infeção do trato urinário na comunidade.</em> Dissertação de mestrado. Faculdade de Farmácia, Universidade de Lisboa.</li>
    <li>Kranz, J., et al. (2025). European Association of Urology Guidelines on Urological Infections: Summary of the 2024 Guidelines. <em>European Urology, 86</em>(1), 27-41. https://doi.org/10.1016/j.eururo.2024.03.035</li>
    <li>Rocha, C., Marques, L., Simões, A., Rodrigues, A., Neno, M., Mulji, R., & Sargento, D. (2014). Infecções urinárias: a realidade de um serviço de Medicina Interna. <em>Medicina Interna — Revista da Sociedade Portuguesa de Medicina Interna.</em></li>
    <li>Direção-Geral da Saúde. (2021). <em>Norma de Orientação Clínica: Infeções do Trato Urinário.</em> DGS. https://www.dgs.pt</li>
  </ol></div>
  `
},
  
'baixa-medica': {
  title: 'Baixa Médica Online em Portugal: Como Funciona | ConsultasOnline',
  description: 'Como funciona o CIT em Portugal, prazos e como renovar a baixa médica online sem sair de casa. Consulta a partir de 55€.',
  keywords: 'baixa médica online portugal, renovar baixa médica online, CIT online, consulta baixa médica, certificado incapacidade temporária',
  h1: 'Renovação de Baixa Médica: Tudo o que Precisa de Saber',
  content: `<div class="cta-top"><p>📋 Precisa de baixa médica? CIT emitido por videoconsulta e submetido à Segurança Social no próprio dia. <a href="/">Marcar consulta — 55€ →</a></p></div>

<h2>O Sistema CIT em Portugal</h2>
  <p>A baixa médica é formalizada pelo <strong>Certificado de Incapacidade Temporária (CIT)</strong>, enviado eletronicamente pelo médico directamente para a Segurança Social.</p>
  <div class="ibox"><div class="ibox-title">📱 Renovação por Videoconsulta</div><p>Os CIT podem ser emitidos após videoconsulta. É possível renovar a baixa médica sem sair de casa.</p></div>
  <h2>Posso fazer baixa médica online em Portugal?</h2>
  <p>Sim, o Decreto-Lei n.º 2/2024, de 5 de janeiro permite a emissão do CIT após videoconsulta. O custo é <strong>55€</strong>.</p>
  <div class="ibox"><div class="ibox-title">✅ Validade legal total</div><p>O CIT emitido por videoconsulta tem o mesmo valor legal que o emitido presencialmente.</p></div>
  <h2>Quem pode pedir baixa médica online?</h2>
  <ul>
    <li>Trabalhadores por conta de outrem com número de utente SNS válido</li>
    <li>Trabalhadores independentes inscritos na Segurança Social</li>
    <li>Trabalhadores com ou sem médico de família atribuído</li>
  </ul>
  <h2>Subsídio de Doença</h2>
  <ul>
    <li>Até 30 dias: <strong>55%</strong> da remuneração de referência</li>
    <li>31–90 dias: <strong>60%</strong></li>
    <li>91–365 dias: <strong>70%</strong></li>
    <li>Mais de 365 dias: <strong>75%</strong></li>
  </ul>
  <div class="ibox warn"><div class="ibox-title">⚠️ Prazo legal</div><p>O CIT deve ser submetido à Segurança Social em até <strong>5 dias úteis</strong> após o início da incapacidade.</p></div>
  <div class="ibox warn"><div class="ibox-title">⚠️ Verificações da Segurança Social</div><p>A SS pode verificar a incapacidade presencialmente. O trabalhador deve estar em condições compatíveis com o diagnóstico.</p></div>
  <div class="art-cta"><h3>Precisa de renovar a baixa?</h3><p>CIT emitido eletronicamente no próprio dia.</p><a href="/">Renovar Baixa — 55€</a></div>
  <h2>Perguntas Frequentes</h2>
  <div class="faq"><h4>Posso fazer baixa médica sem médico de família?</h4><p>Sim. Qualquer médico registado na Ordem dos Médicos pode emitir o CIT.</p></div>
  <div class="faq"><h4>Posso renovar a baixa por videoconsulta?</h4><p>Sim. A renovação do CIT pode ser feita por videoconsulta nas mesmas condições.</p></div>
  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>Decreto-Lei n.º 28/2004. <em>Proteção na eventualidade de doença.</em></li>
    <li>Decreto-Lei n.º 2/2024, de 5 de janeiro. <em>Certificado de Incapacidade Temporária.</em></li>
  </ol></div>
  `
},

'renovacao-medicamentos': {
  title: 'Renovação de Medicamentos Online em Portugal | ConsultasOnline',
  description: 'Renove a sua receita médica por videoconsulta. Receita electrónica enviada por SMS e email no próprio dia. A partir de 40€.',
  keywords: 'renovar receita médica online, renovação medicamentos online portugal, receita médica online, consulta acompanhamento crónico',
  h1: 'Renovação de Medicamentos Online em Portugal',
  content: `<div class="cta-top"><p>💊 Precisa de renovar medicação crónica? Consulta de acompanhamento por videoconsulta. <a href="/">Marcar consulta — 40€ →</a></p></div>

<h2>Para que serve esta consulta?</h2>
  <p>A consulta de acompanhamento crónico online destina-se a doentes com doenças crónicas controladas que precisam de renovar a medicação habitual sem necessidade de consulta presencial.</p>
  <h2>Doenças crónicas abrangidas</h2>
  <ul>
    <li>Hipertensão arterial controlada</li>
    <li>Diabetes tipo 2 controlada</li>
    <li>Dislipidemia (colesterol)</li>
    <li>Hipotiroidismo controlado</li>
    <li>Outras doenças crónicas estáveis</li>
  </ul>
  <div class="ibox"><div class="ibox-title">💡 O que preparar para a consulta</div><p>Tenha consigo a lista de medicação actual, as últimas análises disponíveis e os valores de tensão arterial recentes.</p></div>
  <h2>A receita tem comparticipação do SNS?</h2>
  <p>Sim. A Receita Sem Papel emitida por videoconsulta tem o mesmo valor legal que uma receita presencial. A comparticipação é aplicada automaticamente na farmácia.</p>
  <div class="art-cta"><h3>Precisa de renovar a sua medicação?</h3><p>Consulta de acompanhamento por videoconsulta, receita enviada no próprio dia.</p><a href="/">Marcar Consulta — 40€ →</a></div>
  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>INFARMED. <em>Normas de Prescrição Eletrónica de Medicamentos.</em> 2023.</li>
    <li>Ordem dos Médicos. <em>Regulamento de Telemedicina.</em> 2020.</li>
  </ol></div>
  `
},

  'clamidia': {
  title: 'Clamídia: Sintomas, Transmissão, Diagnóstico e Tratamento | ConsultasOnline',
  description: 'Saiba tudo sobre a clamídia: sintomas, como se transmite, como é diagnosticada e como se trata. Guia médico completo atualizado 2026.',
  keywords: 'clamídia, Chlamydia trachomatis, sintomas clamídia, tratamento clamídia, rastreio clamídia Portugal, IST bacteriana',
  h1: 'Clamídia: Sintomas, Transmissão, Diagnóstico e Tratamento',
  content: `<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p>A <a href="/artigos/doencas-sexualmente-transmissiveis">clamídia</a> é a <a href="/artigos/doencas-sexualmente-transmissiveis">infeção sexualmente transmissível</a> (IST) bacteriana mais frequente na Europa e em Portugal. Uma das suas características mais traiçoeiras é exatamente esta: a maioria das pessoas infetadas não sabe que tem a doença porque não sente nada. Sem sintomas, sem diagnóstico, a infeção progride em silêncio e pode causar complicações sérias, como infertilidade, que só se tornam evidentes anos mais tarde.</p>
  <p>Este artigo explica o que é a <a href="/artigos/doencas-sexualmente-transmissiveis">clamídia</a>, como se transmite, quais os sintomas quando existem, como é feito o diagnóstico, qual o tratamento e, acima de tudo, porque é que o rastreio regular é tão importante para quem tem vida sexual ativa.</p>

  <h2>O que é a clamídia?</h2>
  <p>A clamídia é causada pela bactéria <em>Chlamydia trachomatis</em>, um microorganismo intracelular obrigatório, o que significa que só consegue sobreviver e reproduzir-se dentro das células do organismo humano. Infeta preferencialmente as células epiteliais das mucosas, nomeadamente a uretra, o colo do útero, o reto e a faringe.</p>
  <p>Em Portugal, <a href="https://www.deco.proteste.pt/saude/saude-feminina/dicas/clamidia-quais-sintomas-como-prevenir" target="_blank" style="color:var(--teal)">entre 2022 e 2023 os casos notificados de clamídia diminuíram de 1.598 para 1.404</a>, mas estes números refletem apenas uma fração da realidade, dado que a maioria dos casos não é diagnosticada por ausência de sintomas. Na Europa, de acordo com o ECDC, as mulheres entre os 20 e os 24 anos são o grupo etário com maior número de notificações (ECDC, 2024).</p>
  <p>Em 2024, a Acta Médica Portuguesa publicou as primeiras guidelines portuguesas especificamente dedicadas ao diagnóstico e tratamento da infeção por <em>Chlamydia trachomatis</em>, elaboradas pelo Grupo de Estudo de <a href="/artigos/doencas-sexualmente-transmissiveis">Infeções Sexualmente Transmissíveis</a> da Sociedade Portuguesa de Dermatologia e Venereologia (Andrade et al., 2024).</p>

  <h2>Como se transmite a clamídia?</h2>
  <p>A transmissão dá-se principalmente por contacto sexual desprotegido:</p>
  <ul>
    <li>Sexo vaginal desprotegido: a via de transmissão mais comum</li>
    <li>Sexo anal desprotegido: transmissão frequente, muitas vezes assintomática no reto</li>
    <li>Sexo oral desprotegido: pode causar infeção faríngea, geralmente sem sintomas</li>
    <li>Transmissão vertical: da mãe infetada para o recém-nascido durante o parto vaginal, podendo causar conjuntivite neonatal e pneumonia no bebé</li>
  </ul>
  <p>A clamídia não se transmite por contacto casual, beijos, partilha de toalhas, piscinas ou superfícies. É necessário contacto direto com as mucosas.</p>
  <div class="ibox"><div class="ibox-title">💡 Importante saber</div><p>Uma pessoa infetada com clamídia pode transmiti-la ao parceiro mesmo sem ter qualquer sintoma. Por isso, ter um resultado positivo não significa necessariamente que houve infidelidade: a infeção pode ter ocorrido meses ou anos antes, sem que nenhum dos dois soubesse.</p></div>

  <h2>Quais são os sintomas da clamídia?</h2>
  <p>A clamídia é assintomática em pelo menos 70% das mulheres e em cerca de 50% dos homens no momento do diagnóstico (Andrade et al., 2024). Esta é precisamente a razão pela qual é tão difícil de controlar: quem não sente nada não procura ajuda e continua a transmitir a infeção sem saber.</p>

  <h3>Sintomas nas mulheres</h3>
  <p>Quando existem, os sintomas na mulher surgem tipicamente 1 a 3 semanas após o contacto infetante e incluem:</p>
  <ul>
    <li>Corrimento vaginal de aspeto, cor ou odor diferentes do habitual</li>
    <li>Dor ou ardor ao urinar (disúria)</li>
    <li>Dor pélvica, especialmente durante as relações sexuais ou depois delas</li>
    <li>Sangramento entre os períodos menstruais ou após as relações sexuais</li>
    <li>Cervicite: inflamação do colo do útero, que pode ser detetada pelo médico mesmo sem sintomas evidentes</li>
  </ul>

  <h3>Sintomas nos homens</h3>
  <ul>
    <li>Corrimento uretral, geralmente claro ou ligeiramente leitoso</li>
    <li>Ardor ou dor ao urinar</li>
    <li>Dor ou sensação de peso nos testículos, que pode indicar epididimite</li>
  </ul>

  <h3>Infeção retal e faríngea</h3>
  <p>A infeção do reto é na maioria das vezes completamente silenciosa. Quando causa sintomas, pode provocar corrimento retal, desconforto anal ou proctite. A infeção faríngea, contraída por sexo oral, é quase sempre assintomática e raramente causa dor de garganta.</p>
  <p>Se o rastreio incluir apenas a uretra ou o colo do útero, as infeções anais e faríngeas ficam por diagnosticar, mesmo com análise pedida. Por isso, é importante informar o médico sobre todos os tipos de contacto sexual.</p>

  <h2>Que complicações pode causar a clamídia não tratada?</h2>
  <p>A maior preocupação com a clamídia não é a infeção em si, que é facilmente tratável, mas sim as complicações que surgem quando fica sem diagnóstico e sem tratamento durante meses ou anos.</p>

  <h3>Nas mulheres</h3>
  <ul>
    <li><strong>Doença Inflamatória Pélvica (DIP):</strong> a bactéria ascende do colo do útero para o útero, as trompas de Falópio e os ovários. A DIP pode ser silenciosa ou apresentar-se com dor pélvica intensa, febre e mal-estar geral. É uma das principais causas de infertilidade por fator tubário em Portugal.</li>
    <li><strong>Gravidez ectópica:</strong> a inflamação repetida das trompas pode obstruí-las parcialmente, aumentando o risco de a gravidez se implantar fora do útero, o que constitui uma emergência médica.</li>
    <li><strong>Dor pélvica crónica:</strong> sequela frequentemente subvalorizada da DIP, com impacto significativo na qualidade de vida.</li>
    <li><strong>Infertilidade tubária:</strong> em casos mais graves, a lesão das trompas é irreversível, tornando a gravidez natural impossível.</li>
  </ul>

  <h3>Nos homens</h3>
  <ul>
    <li><strong>Epididimite:</strong> inflamação do epidídimo, que se manifesta com dor e inchaço testicular e pode, em casos extremos, afetar a fertilidade masculina.</li>
    <li><strong>Artrite reativa (síndrome de Reiter):</strong> resposta imune atípica à infeção, que causa artrite, conjuntivite e uretrite, mais frequente em pessoas com predisposição genética.</li>
  </ul>

  <h3>Linfogranuloma venéreo (LGV)</h3>
  <p>Os serotipos L1, L2 e L3 da <em>Chlamydia trachomatis</em> causam uma forma mais invasiva da doença. Manifesta-se com úlceras genitais e gânglios inguinais volumosos e dolorosos. Em Portugal, tem sido reportado sobretudo em homens que têm sexo com homens, frequentemente sob a forma de proctite grave.</p>

  <h2>Como é feito o diagnóstico da clamídia?</h2>
  <p>O diagnóstico não se faz por sintomas, precisamente porque a maioria dos infetados não os tem. Faz-se por análise laboratorial, e o método de referência atual é a técnica de amplificação de ácidos nucleicos, habitualmente designada por PCR ou TAAN (Andrade et al., 2024).</p>
  <p>As amostras aceites variam consoante o local de possível infeção:</p>
  <ul>
    <li>Mulheres: zaragatoa vaginal (pode ser feita pela própria pessoa) ou endocervical, ou amostra de urina do primeiro jato</li>
    <li>Homens: amostra de urina do primeiro jato ou zaragatoa uretral</li>
    <li>Infeção anal: zaragatoa anal, especialmente recomendada em homens que têm sexo com homens e em mulheres que praticam sexo anal</li>
    <li>Infeção faríngea: zaragatoa faríngea, habitualmente incluída nos painéis de rastreio alargado</li>
  </ul>
  <div class="ibox warn"><div class="ibox-title">⚠️ Atenção ao painel de análises</div><p>Um painel básico de rastreio de <a href="/artigos/doencas-sexualmente-transmissiveis">IST</a> pode não incluir a pesquisa de clamídia anal e faríngea. Se tiver tido relações anais ou orais, informe o médico para que o painel seja alargado a essas localizações.</p></div>
  <p>A consulta de rastreio pode ser feita por <a href="/artigos/consulta-online">videoconsulta</a>: o médico avalia o risco, prescreve as análises adequadas ao perfil de exposição e interpreta os resultados quando estiverem disponíveis.</p>

  <h2>Qual o tratamento da clamídia?</h2>
  <p>A clamídia é tratável com antibióticos e, na grande maioria dos casos, cura completamente sem sequelas se for tratada a tempo. De acordo com as guidelines portuguesas de 2024, os regimes recomendados são (Andrade et al., 2024):</p>
  <ul>
    <li><strong>Doxiciclina 100 mg duas vezes por dia durante 7 dias:</strong> tratamento de primeira linha preferido pelas guidelines europeias e portuguesas pela maior eficácia clínica, especialmente para infeção retal. Não deve ser tomada durante a gravidez.</li>
    <li><strong>Azitromicina 1g em dose única:</strong> alternativa quando a adesão ao tratamento de 7 dias pode ser problemática. Ligeiramente menos eficaz para infeção retal.</li>
    <li><strong>Grávidas:</strong> azitromicina 1g em dose única ou amoxicilina 500 mg três vezes por dia durante 7 dias.</li>
  </ul>
  <p>Durante o tratamento e nos 7 dias seguintes ao fim dos antibióticos, deve evitar-se qualquer contacto sexual para garantir que não há transmissão enquanto o tratamento ainda está a atuar.</p>
  <p>Os parceiros sexuais dos últimos 60 dias devem ser notificados e tratados, independentemente de terem ou não sintomas. Sem tratar o parceiro, a reinfecção é praticamente certa.</p>
  <p>Não é necessário repetir as análises após o tratamento para confirmar a cura, exceto nas grávidas, em casos de má adesão ou de suspeita de reinfecção (Andrade et al., 2024).</p>

  <h2>Quando fazer rastreio de clamídia?</h2>
  <p>As guidelines internacionais recomendam rastreio regular nas seguintes situações:</p>
  <ul>
    <li>Mulheres com menos de 25 anos sexualmente ativas: rastreio anual, independentemente do número de parceiros</li>
    <li>Mulheres com 25 anos ou mais com novos parceiros ou múltiplos parceiros: rastreio anual</li>
    <li>Homens que têm sexo com homens: rastreio a cada 3 a 6 meses, incluindo localizações anal e faríngea</li>
    <li>Mulheres grávidas: rastreio na primeira consulta pré-natal</li>
    <li>Após relação sexual desprotegida com parceiro de estado de saúde desconhecido</li>
    <li>Após notificação de contacto com pessoa infetada</li>
    <li>No início de uma nova relação, antes de abandonar o uso do preservativo</li>
  </ul>

  <h2>Como prevenir a clamídia?</h2>
  <ul>
    <li><strong>Preservativo:</strong> usado de forma correta e consistente, reduz significativamente o risco de transmissão de <a href="/artigos/doencas-sexualmente-transmissiveis">IST</a>, incluindo a clamídia.</li>
    <li><strong>Rastreio regular:</strong> detetar a infeção cedo, antes de causar complicações, é a segunda linha de defesa mais importante.</li>
    <li><strong>Notificação e tratamento de parceiros:</strong> fundamental para interromper a cadeia de transmissão.</li>
    <li><strong>Discussão aberta com o médico:</strong> informar o médico sobre os comportamentos sexuais permite-lhe prescrever o painel de rastreio mais adequado para cada situação.</li>
  </ul>
  <p>Não existe vacina contra a clamídia. Para outras <a href="/artigos/doencas-sexualmente-transmissiveis">infeções sexualmente transmissíveis</a> como a hepatite B e o HPV, existem vacinas eficazes disponíveis em Portugal.</p>

  <div class="art-cta"><h3>Quer fazer rastreio de clamídia?</h3><p>Consulta por videoconsulta. O médico avalia o risco e prescreve as análises adequadas. Disponível de segunda a domingo.</p><a href="/">Marcar Rastreio de IST →</a></div>

  <h2>Perguntas frequentes sobre clamídia</h2>

  <div class="faq"><h4>Posso ter clamídia sem ter sintomas?</h4><p>Sim, e é o cenário mais comum. A maioria das pessoas infetadas com clamídia não tem qualquer sintoma. Por isso o rastreio regular é a única forma fiável de saber se tem ou não a infeção.</p></div>
  <div class="faq"><h4>Quanto tempo depois de uma relação de risco devo fazer o teste?</h4><p>O PCR para clamídia pode ser realizado a partir de 2 semanas após a exposição. Antes desse período, o resultado pode ser falsamente negativo mesmo que tenha ocorrido infeção.</p></div>
  <div class="faq"><h4>A clamídia cura-se completamente?</h4><p>Sim. Com o antibiótico correto e tomado até ao fim, a clamídia cura completamente. O problema são as complicações que surgem quando a infeção não é tratada durante muito tempo, como a doença inflamatória pélvica ou a infertilidade tubária, essas sim podem ser irreversíveis.</p></div>
  <div class="faq"><h4>Tenho de dizer ao meu parceiro que tenho clamídia?</h4><p>É fundamental que sim. O parceiro precisa de ser testado e tratado, mesmo que não tenha sintomas, para evitar que seja reinfetado e para interromper a cadeia de transmissão.</p></div>
  <div class="faq"><h4>Posso ficar infértil por causa da clamídia?</h4><p>Se a infeção não for tratada e causar doença inflamatória pélvica repetida, pode haver lesão permanente das trompas de Falópio, o que pode dificultar ou impedir a gravidez natural. O risco é real mas evitável: diagnosticar e tratar cedo previne completamente estas complicações.</p></div>
  <div class="faq"><h4>A clamídia transmite-se por sexo oral?</h4><p>Sim, embora seja menos frequente do que por sexo vaginal ou anal. A infeção faríngea por clamídia é quase sempre sem sintomas, mas pode ser transmitida a um parceiro durante o sexo oral.</p></div>
  <div class="faq"><h4>Posso fazer o rastreio de clamídia por videoconsulta?</h4><p>Sim. Por videoconsulta, o médico avalia o risco, prescreve as análises adequadas ao tipo de exposição e, quando os resultados estiverem disponíveis, interpreta-os e prescreve o tratamento se necessário.</p></div>
  <div class="faq"><h4>O preservativo protege contra a clamídia?</h4><p>Sim, quando usado de forma correta e consistente, reduz significativamente o risco de transmissão. Não oferece proteção total, mas é a medida preventiva mais eficaz disponível.</p></div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Andrade, P., Azevedo, J., Lisboa, C., Fernandes, C., Borrego, M. J., Borges-Costa, J., Reis, J., Santiago, F., Santos, A., & Alves, J., em representação do GEIDST/SPDV. (2024). Guidelines for the Diagnosis and Treatment of Uncomplicated (Non-Lymphogranuloma Venereum) <em>Chlamydia trachomatis</em> Infection in Portugal. <em>Acta Médica Portuguesa.</em> https://www.actamedicaportuguesa.com/revista/index.php/amp/article/view/21442</li>
    <li>European Centre for Disease Prevention and Control. (2024). Bacterial STIs reach record highs in Europe. ECDC. https://www.ecdc.europa.eu/en/news-events/bacterial-stis-reach-record-highs-europe-congenital-syphilis-cases-nearly-double</li>
    <li>Lanjouw, E., Ouburg, S., de Vries, H. J., Stary, A., Radcliffe, K., & Unemo, M. (2016). 2015 European guideline on the management of <em>Chlamydia trachomatis</em> infections. <em>International Journal of STD & AIDS, 27</em>(5), 333-348. https://doi.org/10.1177/0956462415617523</li>
    <li>Unemo, M., et al. (2017). Sexually transmitted infections: challenges ahead. <em>The Lancet Infectious Diseases, 17</em>(8), e235-e279. https://doi.org/10.1016/S1473-3099(17)30310-9</li>
    <li>World Health Organization. (2023). Sexually transmitted infections (STIs). <em>WHO Fact Sheet.</em> https://www.who.int/news-room/fact-sheets/detail/sexually-transmitted-infections-(stis)</li>
  </ol></div>
  `
},

'atestado-amamentacao': {
  title: 'Atestado de Amamentação Online em Portugal | ConsultasOnline',
  description: 'Obtenha o atestado de amamentação por videoconsulta. Direitos laborais, renovação. Emitido no próprio dia. 35€.',
  keywords: 'atestado amamentação online, atestado amamentação portugal, renovar atestado amamentação, direitos laborais amamentação',
  h1: 'Atestado de Amamentação: Para que Serve e Como Obter',
  content: `<div class="cta-top"><p>🤱 Precisa do atestado de amamentação? Emitido por videoconsulta e enviado por email no próprio dia. <a href="/">Marcar consulta — 35€ →</a></p></div>

<h2>O que é o atestado de amamentação?</h2>
  <p>O <strong>atestado de amamentação</strong> certifica que uma mãe está a amamentar o seu filho. É fundamental para exercer os direitos laborais de dispensa de trabalho para aleitamento previstos no Código do Trabalho (artigo 47.º).</p>
  <h2>Direitos Laborais (Código do Trabalho, art. 47.º)</h2>
  <ul>
    <li><strong>Até o filho completar 1 ano:</strong> dois períodos de 30 minutos ou 1 hora por dia</li>
    <li><strong>Do 1.º ao 2.º ano:</strong> um período de 30 minutos por dia</li>
    <li>Dispensa de trabalho nocturno e horas extraordinárias</li>
  </ul>
  <div class="ibox warn"><div class="ibox-title">⚠️ Renovação</div><p>O atestado tem validade de 3 a 6 meses. Quando expirar deve ser renovado. A consulta online permite renovar sem deslocação.</p></div>
  <h2>Posso obter o atestado online?</h2>
  <p>Sim. A videoconsulta é suficiente. O médico emite o documento em PDF com validade legal, enviado por email no próprio dia.</p>
  <div class="art-cta"><h3>Precisa de atestado de amamentação?</h3><p>Emitido por videoconsulta, enviado por email no próprio dia.</p><a href="/">Atestado de Amamentação — 35€</a></div>
  <h2>Perguntas Frequentes</h2>
  <div class="faq"><h4>O atestado online tem validade legal?</h4><p>Sim. O documento emitido por videoconsulta tem plena validade legal junto do empregador.</p></div>
  <div class="faq"><h4>Com que frequência preciso de renovar?</h4><p>O atestado tem validade de 3 a 6 meses consoante o que o médico indicar.</p></div>
  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>Lei n.º 7/2009. <em>Código do Trabalho Português.</em> Artigos 47.º e 58.º</li>
    <li>ACT. <em>Guia sobre Parentalidade e Trabalho.</em> 2023.</li>
  </ol></div>
  `
},

'atestado-carta-conducao': {
  title: 'Atestado Médico para Carta de Condução: Tudo o que Precisa de Saber',
  description: 'Saiba quando é obrigatório, o que é avaliado, os requisitos por categoria, a validade e como obter o atestado médico para carta de condução por videoconsulta.',
  keywords: 'atestado médico carta de condução, renovação carta de condução, aptidão física condução, IMT atestado médico, videoconsulta carta de condução',
  content: `<div class=\"cta-top\"><p>🚗 Precisa de atestado médico para a carta de condução? Emissão por <a href=\"/artigos/consulta-online\">videoconsulta</a>. <a href=\"/\">Marcar consulta — 45€ →</a></p></div>

<div class=\"art-author\">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>

<p><em>Atualizado 2026</em></p>

<p>Em Portugal, qualquer pessoa que queira obter ou renovar a carta de condução tem de apresentar um atestado médico de aptidão física emitido por um médico inscrito na Ordem dos Médicos. Este documento certifica que o candidato ou o condutor reúne as condições de saúde exigidas por lei para conduzir com segurança. O atestado é enviado diretamente pelo médico ao Instituto da Mobilidade e dos Transportes (IMT) através de plataforma eletrónica, sem necessidade de qualquer deslocação adicional por parte do requerente.</p>

<p>Neste artigo explicamos quando é obrigatório, o que é avaliado, quais os requisitos por categoria de carta, qual a validade do atestado, como é possível fazê-lo <a href=\"/artigos/consulta-online\">por videoconsulta</a> e o que levar para a consulta.</p>

<h2>1. Enquadramento legal: quem pode emitir o atestado médico para carta de condução</h2>

<p>O Regulamento da Habilitação Legal para Conduzir, aprovado pelo <a href=\"https://diariodarepublica.pt/dr/detalhe/decreto-lei/138-2012-178550\" target=\"_blank\" rel=\"noopener\">Decreto-Lei n.º 138/2012, de 5 de julho</a>, com as alterações introduzidas pelo <a href=\"https://diariodarepublica.pt/dr/detalhe/decreto-lei/40-2016-75060359\" target=\"_blank\" rel=\"noopener\">Decreto-Lei n.º 40/2016, de 29 de julho</a>, estabelece os requisitos de aptidão física e mental exigidos para a obtenção e renovação da carta de condução em Portugal.</p>

<p>O atestado médico para carta de condução pode ser emitido por qualquer médico no exercício das suas funções, incluindo <a href=\"https://www.imt-ip.pt/condutores/informacoes-gerais/quero-ser-condutor/\" target=\"_blank\" rel=\"noopener\">médicos que exerçam atividade na sociedade médica privada</a>, e não apenas pelos serviços públicos de saúde. O médico tem de ter acesso à plataforma eletrónica do Ministério da Saúde (gerida pela SPMS), que permite o envio direto do atestado ao IMT no final da consulta.</p>

<p>Isto significa que o atestado pode ser feito por videoconsulta, desde que o candidato traga consigo os resultados dos exames exigidos por lei para a sua categoria de carta. O médico faz a avaliação clínica com base na informação fornecida, preenche o atestado na plataforma e envia-o diretamente ao IMT.</p>

<h2>2. Quando é obrigatório fazer o atestado médico para carta de condução</h2>

<p>O atestado médico de aptidão física é obrigatório nas seguintes situações:</p>
<ul>
<li>Obtenção da carta de condução pela primeira vez, em qualquer categoria</li>
<li>Renovação da carta de condução, nos prazos previstos por lei consoante a categoria e a idade do condutor</li>
<li>Troca de carta de condução estrangeira por carta portuguesa, quando proveniente de países fora da União Europeia</li>
<li>Revalidação da carta após suspensão ou cessação, quando exigido pelo tribunal ou pelo IMT</li>
<li>Emissão de nova carta por alteração de categoria, quando a nova categoria exija atestado específico</li>
</ul>

<h2>3. Tipos de atestado: tipo 1 e tipo 2</h2>

<h3>Atestado tipo 1 (categorias AM, A1, A2, A, B1, B e BE)</h3>
<p>Destina-se aos condutores de veículos ligeiros, motociclos e ciclomotores. É o atestado mais comum, pode ser emitido por qualquer médico inscrito na Ordem dos Médicos com acesso à plataforma eletrónica, e é o que pode ser obtido <a href=\"/artigos/consulta-online\">por videoconsulta</a> quando o candidato apresenta os resultados do exame de visão atualizado.</p>

<h3>Atestado tipo 2 (categorias C1, C1E, C, CE, D1, D1E, D e DE)</h3>
<p>Destina-se a condutores de veículos pesados de mercadorias e de passageiros. Exige uma avaliação mais exigente e critérios de aptidão mais restritivos, dado o maior risco associado à condução profissional. Também pode ser emitido por qualquer médico habilitado, embora em algumas situações seja necessário parecer de especialidade.</p>

<h2>4. Requisitos médicos por categoria de carta de condução</h2>

<h3>4.1 Visão</h3>
<p>A visão é o requisito mais frequentemente avaliado e o principal motivo de reprovação. Convém esclarecer o conceito de visão monocular: considera-se monovisual todo o indivíduo que tenha uma perda funcional de um dos olhos ou que possua uma acuidade visual num dos olhos inferior a 0,2. Após a perda de visão num dos olhos, deve existir um período de adaptação adequado, no mínimo de seis meses, durante o qual é proibida a condução de veículos. Findo este período, só pode ser autorizada a prática da condução após obtenção de parecer favorável de oftalmologista e aprovação em prova prática.</p>

<p>Os <a href=\"https://ordemdosmedicos.pt/files/pdfs/ZtW7-Tabela_comparativa___cartas_conducao.pdf\" target=\"_blank\" rel=\"noopener\">critérios</a> variam consoante a categoria:</p>

<h4>Categorias do grupo 1 (AM, A1, A2, A, B1, B, BE):</h4>
<ul>
<li>Acuidade visual binocular mínima de 0,5 (com ou sem correção ótica). A acuidade visual mínima no \"pior olho\", com correção ótica se necessário, não pode ser inferior a 0,2.</li>
<li>Visão monocular: a acuidade visual com ou sem correção não pode ser inferior a 0,5, devendo obter parecer favorável de oftalmologista certificando que esta situação se verifica há pelo menos seis meses, que o condutor está perfeitamente adaptado, que o campo visual e a visão crepuscular são normais e que a perceção de profundidade é compatível com a condução.</li>
<li>Campo visual horizontal mínimo de 120 graus, com pelo menos 50 graus para cada lado e sem defeitos nos 20 graus centrais.</li>
<li>Diplopia (visão dupla): apenas são permitidas, a título excecional, as formas congénitas ou infantis que não se manifestem nos 20° centrais do campo visual nem causem qualquer outra sintomatologia.</li>
<li>Visão das cores: é aceite qualquer tipo de daltonismo exceto a acromatopsia.</li>
<li>Visão noturna: se houver dificuldades significativas, o condutor pode ser declarado apto apenas para conduzir durante o dia.</li>
<li>Doenças oftalmológicas progressivas: título de condução só pode ser emitido ou revalidado sob reserva de exame periódico anual por oftalmologista.</li>
</ul>

<h4>Categorias do grupo 2 (C1, C1E, C, CE, D1, D1E, D, DE):</h4>
<ul>
<li>Acuidade visual binocular mínima de 0,8 no \"melhor olho\" e de 0,5 no \"pior olho\". Se estes valores forem atingidos com correção ótica, é necessário que a visão não corrigida atinja pelo menos 0,05 em cada um dos olhos. A potência das lentes não pode exceder mais ou menos quatro dioptrias.</li>
<li>Visão monocular: o título de condução não é emitido nem revalidado a candidatos ou condutores do grupo 2 monovisuais.</li>
<li>Campo visual horizontal mínimo de 160 graus, com pelo menos 70 graus para cada lado e sem defeitos nos 30 graus centrais.</li>
<li>Ausência de diplopia.</li>
<li>Visão das cores: além da acromatopsia, também a protanopia (incapacidade de ver o vermelho) é causa de inaptidão.</li>
<li>Visão noturna: qualquer dificuldade significativa em condições de pouca luminosidade é causa de inaptidão.</li>
<li>Doenças oftalmológicas progressivas: são causa de inaptidão.</li>
</ul>

<p>O exame de visão tem de ser realizado numa ótica ou por um oftalmologista antes da consulta médica.</p>

<h3>4.2 Audição</h3>
<p><strong>Grupo 1:</strong> É emitido ou revalidado o título de condução a quem sofra de défice auditivo, devendo atender-se à possibilidade de compensação. A surdez profunda deve ser compensada, sempre que possível, por prótese ou implante coclear, sendo a aptidão condicionada a parecer favorável de médico otorrinolaringologista.</p>
<p><strong>Grupo 2:</strong> Pode ser emitido ou revalidado o título de condução ao candidato que sofra de défice auditivo, condicionado à possibilidade de compensação e a parecer favorável de médico otorrinolaringologista.</p>

<h3>4.3 Sistema cardiovascular</h3>
<p><strong>Grupo 1:</strong></p>
<ul>
<li>Hipertensão arterial controlada com medicação é compatível com a condução.</li>
<li>Enfarte agudo do miocárdio recente: a aptidão depende da avaliação cardiológica.</li>
<li>Arritmias cardíacas: avaliadas caso a caso.</li>
<li>Implantação de pacemaker ou desfibrilhador (CDI): inaptidão temporária durante o período de ajuste; após estabilização, pode ser aceite com condições.</li>
<li>Insuficiência cardíaca: avaliada em função da classe funcional.</li>
</ul>
<p><strong>Grupo 2:</strong> A avaliação deve ser ponderada com base em parecer de cardiologista devidamente fundamentado em exames complementares.</p>

<h3>4.4 Sistema neurológico</h3>
<p>Epilepsia é uma das condições com maior impacto na aptidão para conduzir.</p>
<ul>
<li><strong>Grupo 1:</strong> Inaptidão temporária. Após pelo menos 1 ano sem crises em tratamento, e com avaliação neurológica favorável, pode ser reconhecida aptidão condicionada (renovação anual até cumprirem um período de pelo menos cinco anos sem crises).</li>
<li><strong>Grupo 2:</strong> É emitido ou revalidado título de condução a quem sofra de epilepsia, desde que esteja há pelo menos dez anos livre de crises e sem terapêutica específica, se apoiado em parecer de neurologista que ateste não existir qualquer patologia cerebral relevante e que confirme não existir atividade epilética em exame eletroencefalográfico.</li>
</ul>

<h3>4.5 Diabetes mellitus</h3>
<p><strong>Grupo 1:</strong> Diabetes tratada com insulina ou com antidiabéticos orais com risco de hipoglicemia: aptidão condicionada a controlo metabólico adequado, ausência de episódios de hipoglicemia grave e avaliação periódica.</p>
<p><strong>Grupo 2:</strong> A emissão de atestado é permitida para condutores tratados com insulina, desde que não tenham tido episódios de hipoglicemia grave nos últimos 12 meses e apresentem relatório favorável de endocrinologia.</p>

<h3>4.6 Perturbações do sono</h3>
<p>A síndrome de apneia obstrutiva do sono (SAOS) é uma causa crescentemente reconhecida de inaptidão para conduzir, dado o risco de sonolência diurna e de adormecimento ao volante. É emitido ou revalidado o título de condução a quem sofra de perturbações do sono, mediante a submissão a exame médico da especialidade e com parecer favorável, mas apenas para o grupo 1.</p>

<h3>4.7 Saúde mental</h3>
<p>É inapto para conduzir o candidato ou condutor que sofra de perturbações mentais congénitas ou adquiridas que traduzam redução apreciável das capacidades mentais, incluindo atrasos mentais e perturbações graves do comportamento, da capacidade cognitiva ou da personalidade, suscetíveis de modificar a capacidade de julgamento ou que impliquem diminuição da eficiência ou segurança na condução.</p>

<h3>4.8 Aparelho locomotor</h3>
<p>Amputações, paralisias e outras limitações funcionais dos membros são avaliadas em função da capacidade de manobrar o veículo em segurança. Em muitos casos, a adaptação do veículo permite manter a aptidão.</p>

<h2>5. Validade do atestado médico para carta de condução</h2>

<p>O atestado médico tem uma validade determinada, após a qual o condutor tem de renovar tanto o atestado como a própria carta de condução. Os prazos são os seguintes, de acordo com o Regulamento da Habilitação Legal para Conduzir:</p>

<table class=\"art-table\">
<thead><tr><th>Categoria</th><th>Até aos 60 ou 70 anos</th><th>A partir dos 70 anos</th></tr></thead>
<tbody>
<tr><td>AM, A1, A2, A, B1, B, BE</td><td>15 em 15 anos até aos 60 anos. 5 em 5 anos entre 60 e os 70 anos</td><td>2 em 2 anos</td></tr>
<tr><td>C1, C1E, C, CE</td><td>5 em 5 anos até aos 70 anos</td><td>2 em 2 anos</td></tr>
<tr><td>D1, D1E, D, DE</td><td>5 em 5 anos até aos 67 anos</td><td>Não podem ser revalidadas após os 67 anos</td></tr>
</tbody>
</table>

<p>Em condutores com determinadas condições de saúde (epilepsia controlada, diabetes insulinotratada, SAOS em tratamento, entre outras), o atestado pode ter uma validade inferior, com renovação anual ou bienal, independentemente da categoria ou da idade.</p>

<p>O atestado médico emitido tem um prazo de validade próprio para ser apresentado ao IMT, geralmente de 3 meses a partir da data de emissão. Findo este prazo, é necessário obter novo atestado.</p>

<h2>6. O que levar para a consulta (presencial ou por videoconsulta)</h2>

<p>Para que o médico possa emitir o atestado, é necessário apresentar os seguintes elementos:</p>
<ul>
<li>Exame de visão atualizado, realizado numa ótica ou por um oftalmologista, com indicação da acuidade visual corrigida e não corrigida de cada olho, visão binocular, campo visual e ausência ou presença de diplopia.</li>
<li>Documento de identificação com fotografia (cartão de cidadão ou passaporte).</li>
<li>Lista de medicação atual, incluindo nome dos medicamentos, dosagem e indicação terapêutica.</li>
<li>Relatórios médicos relevantes de especialistas, quando existam condições de saúde que possam afetar a aptidão para conduzir (cardiologia, neurologia, endocrinologia, pneumologia, oftalmologia).</li>
<li>No caso de diabetes: resultados recentes de hemoglobina glicada (HbA1c) e glicemia em jejum.</li>
<li>No caso de epilepsia: relatório neurológico com data e tipo da última crise.</li>
<li>No caso de SAOS: relatório de follow-up de pneumologia com dados de adesão ao CPAP.</li>
<li>No caso de doenças cardiovasculares: último relatório de cardiologia e resultados de ecocardiograma ou prova de esforço recentes.</li>
</ul>

<h2>7. Perguntas frequentes</h2>

<h3>Posso fazer o atestado médico para a carta de condução por videoconsulta?</h3>
<p>Sim. Desde que o candidato apresente o exame de visão atualizado e os relatórios médicos relevantes durante a videoconsulta, o médico pode emitir o atestado e enviá-lo diretamente ao IMT através da plataforma eletrónica do Ministério da Saúde.</p>

<h3>O que preciso de levar para a consulta?</h3>
<p>O mais importante é o exame de visão atualizado, realizado numa ótica ou por um oftalmologista antes da consulta. Para além disso, deve ter o documento de identificação, a lista de medicação atual e, se tiver alguma condição de saúde relevante, os relatórios médicos de acompanhamento de especialidade.</p>

<h3>Posso fazer o atestado se usar óculos ou lentes de contacto?</h3>
<p>Sim. Se com correção ótica atingir os valores mínimos exigidos para a sua categoria, o atestado é emitido com a restrição de uso obrigatório de óculos ou lentes durante a condução.</p>

<h3>Tenho epilepsia controlada. Posso obter a carta de condução?</h3>
<p>Para veículos ligeiros, depois de pelo menos 1 ano sem crises epiléticas em tratamento, e com relatório neurológico favorável, é possível obter aptidão condicionada. A renovação do atestado passa a ser anual até perfazer 5 anos sem crises. Para veículos pesados, as condições são mais restritivas. É fundamental apresentar relatório de neurologia atualizado na consulta.</p>

<h3>Tenho diabetes e faço insulina. Posso ter carta de condução de pesados?</h3>
<p>É permitida a emissão de atestado de aptidão para condutores de veículos pesados tratados com insulina, desde que não tenham tido episódios de hipoglicemia grave nos últimos 12 meses e apresentem relatório favorável de endocrinologia.</p>

<h3>O atestado médico é enviado diretamente ao IMT?</h3>
<p>Sim. O médico preenche o atestado na plataforma eletrónica do Ministério da Saúde e envia-o diretamente ao IMT no final da consulta. Não é necessário levar nenhum papel ao IMT.</p>

<h3>Quanto tempo tenho para usar o atestado no IMT depois de o fazer?</h3>
<p>O atestado emitido tem um prazo de validade para ser apresentado ao IMT, geralmente de 3 meses. Após esse prazo, é necessário obter um novo atestado.</p>

<div class=\"refs\"><h3>Referências</h3><ol>
<li>Governo de Portugal. (2012). <a href=\"https://diariodarepublica.pt/dr/detalhe/decreto-lei/138-2012-178550\" target=\"_blank\" rel=\"noopener\">Decreto-Lei n.º 138/2012, de 5 de julho. Regulamento da Habilitação Legal para Conduzir.</a></li>
<li>Governo de Portugal. (2016). <a href=\"https://diariodarepublica.pt/dr/detalhe/decreto-lei/40-2016-75060359\" target=\"_blank\" rel=\"noopener\">Decreto-Lei n.º 40/2016, de 29 de julho. Alterações ao Regulamento da Habilitação Legal para Conduzir.</a></li>
<li>Direção-Geral da Saúde &amp; Instituto da Mobilidade e dos Transportes. (2017). <a href=\"https://www.dgs.pt/saude-publica1/cartas-de-conducao.aspx\" target=\"_blank\" rel=\"noopener\">Despacho Conjunto de 3 de fevereiro de 2017. Modelos e conteúdos do Atestado Médico para Carta de Condução.</a></li>
<li>Ordem dos Médicos. (2020). Regulamento de Telemedicina. Lisboa: Ordem dos Médicos.</li>
<li>Parlamento Europeu e Conselho da União Europeia. (2006). Diretiva 2006/126/CE relativa à carta de condução. Jornal Oficial da União Europeia.</li>
<li>Comissão Europeia. (2014). Diretiva 2014/85/UE da Comissão, de 1 de julho de 2014. Requisitos médicos de aptidão para condutores profissionais com diabetes. Jornal Oficial da União Europeia.</li>
</ol>
<p><em>Artigo revisto por médico inscrito na Ordem dos Médicos. Para uso informativo. Não substitui consulta médica.</em></p></div>`
},

'faltas-trabalho': {
  title: 'Faltas ao Trabalho por Doença: Como Justificar | ConsultasOnline',
  description: 'Tudo sobre declarações médicas, baixas e os seus direitos como trabalhador. Declaração médica emitida online no próprio dia.',
  keywords: 'faltas trabalho doença justificar, declaração médica trabalho online, baixa médica trabalho portugal, direitos trabalhador doença',
  h1: 'Faltas ao Trabalho por Doença: Como Justificar Corretamente',
  content: `<div class="cta-top"><p>💼 Precisa de declaração médica para o trabalho? Emitida por videoconsulta no próprio dia. <a href="/">Marcar consulta — 40€ →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p><em>Saiba como justificar corretamente uma falta ao trabalho por doença, quando pode utilizar a autodeclaração do SNS 24, quando necessita de um Certificado de Incapacidade Temporária (CIT) e quais os seus direitos perante o empregador.</em></p>

  <p>Adoecer é, para qualquer trabalhador por conta de outrem, uma situação que levanta várias dúvidas práticas: quantos dias posso faltar sem apresentar um documento médico? A partir de quando preciso de baixa médica? O que acontece se não justificar a falta a tempo? Este guia reúne, de forma detalhada, tudo sobre faltas ao trabalho por doença em Portugal, explicando o enquadramento legal no Código do Trabalho, os documentos aceites para justificar a ausência (autodeclaração de doença e CIT), os prazos que tem de cumprir, o valor do subsídio de doença e a proteção que a lei garante contra o despedimento em caso de doença.</p>

  <div class="ibox">
    <div class="ibox-title">📋 Resumo rápido</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr style="border-bottom:1px solid var(--border)"><td style="padding:7px 0;color:var(--slate);font-weight:600">Posso faltar sem baixa médica?</td><td style="padding:7px 0;color:var(--navy)">Sim, até 3 dias com autodeclaração.</td></tr>
      <tr style="border-bottom:1px solid var(--border)"><td style="padding:7px 0;color:var(--slate);font-weight:600">Quando preciso de CIT?</td><td style="padding:7px 0;color:var(--navy)">A partir do 4.º dia.</td></tr>
      <tr style="border-bottom:1px solid var(--border)"><td style="padding:7px 0;color:var(--slate);font-weight:600">Quantas autodeclarações existem?</td><td style="padding:7px 0;color:var(--navy)">2 por ano civil.</td></tr>
      <tr style="border-bottom:1px solid var(--border)"><td style="padding:7px 0;color:var(--slate);font-weight:600">Quem paga o subsídio?</td><td style="padding:7px 0;color:var(--navy)">Segurança Social.</td></tr>
      <tr><td style="padding:7px 0;color:var(--slate);font-weight:600">Posso ser despedido?</td><td style="padding:7px 0;color:var(--navy)">Não, por faltas devidamente justificadas.</td></tr>
    </table>
  </div>

  <h2>Enquadramento legal das faltas por doença</h2>
  <p>As faltas ao trabalho, incluindo as motivadas por doença, estão reguladas na Subsecção XI do Código do Trabalho, aprovado pela Lei n.º 7/2009, de 12 de fevereiro, com as alterações introduzidas ao longo dos anos, nomeadamente pelo <a href="https://diariodarepublica.pt/dr/detalhe/decreto-lei/2-2024-836117864" target="_blank" style="color:var(--teal)">Decreto-Lei n.º 2/2024, de 5 de janeiro</a>, que atualizou o regime da autodeclaração de doença. A doença é qualificada como um facto não imputável ao trabalhador, nos termos da alínea d) do <a href="http://bdjur.almedina.net/citem.php?field=item_id&value=1361832" target="_blank" style="color:var(--teal)">n.º 2 do artigo 249.º do Código do Trabalho</a>, o que significa que o trabalhador tem direito a faltar sem que isso constitua fundamento para despedimento, desde que cumpra as obrigações de comunicação e justificação previstas na lei.</p>
  <p>Este direito de faltar por doença sem perda de emprego é um dos pilares da proteção laboral em Portugal, mas não dispensa o trabalhador de seguir um conjunto de regras e prazos que, se não forem respeitados, podem transformar uma falta justificada numa falta injustificada, com consequências disciplinares e financeiras.</p>

  <h2>Como justificar uma falta ao trabalho por doença?</h2>
  <p>Consoante a duração da ausência, existem três documentos principais que permitem justificar uma falta ao trabalho por motivo de doença, de acordo com o <a href="https://diariodarepublica.pt/dr/legislacao-consolidada/lei/2009-34546475-914159294" target="_blank" style="color:var(--teal)">artigo 254.º do Código do Trabalho</a>:</p>
  <ul>
    <li><strong>Autodeclaração de doença (ADD)</strong> — para ausências até 3 dias consecutivos, emitida pelo próprio trabalhador através da área pessoal do SNS 24, sob compromisso de honra</li>
    <li><strong>Certificado de Incapacidade Temporária para o Trabalho (CIT)</strong>, também chamado baixa médica — obrigatório a partir do 4.º dia consecutivo de ausência, ou sempre que o trabalhador já tenha esgotado o número de autodeclarações permitidas no ano</li>
    <li><strong>Atestado médico</strong></li>
  </ul>
  <p>Além destes documentos, o empregador pode também aceitar uma declaração de presença emitida por um estabelecimento de saúde, comprovando que o trabalhador esteve numa consulta médica em horário coincidente com o período de trabalho, situação enquadrada no mesmo artigo acima referido.</p>

  <h3>Autodeclaração de doença: como funciona?</h3>
  <p>A autodeclaração de doença é um mecanismo que permite justificar faltas ligeiras, até 3 dias consecutivos, sem necessidade de consulta médica. O trabalhador acede à área pessoal do SNS 24 (por aplicação móvel ou pelo portal na internet) e emite a declaração, sob compromisso de honra, no prazo máximo de 5 dias a contar do primeiro dia de ausência.</p>
  <ul>
    <li>Pode ser pedida por qualquer trabalhador com idade igual ou superior a 16 anos</li>
    <li>Cada trabalhador tem direito a 2 autodeclarações de doença por ano civil, cada uma válida para um máximo de 3 dias consecutivos, totalizando até 6 dias de ausência justificada por ano através deste mecanismo</li>
    <li>Após a emissão, o trabalhador recebe um código de acesso por SMS ou email, que deve facultar ao empregador para que este possa validar a autenticidade da declaração na página própria do portal SNS 24</li>
    <li><a href="https://www.sns24.gov.pt/pt/servico/autodeclaracao-de-doenca" target="_blank" style="color:var(--teal)">Desde 29 de julho de 2025, a comunicação à Segurança Social passou a ser feita automaticamente pelo sistema</a>, não sendo necessária qualquer diligência adicional do trabalhador</li>
  </ul>
  <div class="ibox warn"><div class="ibox-title">⚠️ Atenção</div><p>Se esgotar as duas autodeclarações de doença permitidas no ano civil, ou se a ausência ultrapassar 3 dias consecutivos, tem obrigatoriamente de recorrer a uma consulta médica para obter o CIT. Usar a autodeclaração fora destas condições torna a falta injustificada.</p></div>

  <h2>Quando é obrigatória a baixa médica?</h2>
  <p>O Certificado de Incapacidade Temporária para o Trabalho, o documento popularmente conhecido como baixa médica, torna-se obrigatório a partir do 4.º dia consecutivo de doença. É emitido por um médico, do Serviço Nacional de Saúde ou de entidades privadas e sociais autorizadas, quer em consulta presencial, quer por <a href="/artigos/consulta-online">videoconsulta</a>, com o mesmo valor legal.</p>
  <p>O CIT deve ser submetido à Segurança Social no prazo de 5 dias úteis a contar do início da incapacidade. Na generalidade dos casos, esta submissão é feita eletronicamente pelo próprio médico no momento da consulta, o que dispensa o trabalhador de qualquer formalidade adicional junto da Segurança Social. Quando o certificado é emitido em papel, cabe ao trabalhador remeter o original dentro do prazo indicado.</p>

  <h2>Quais os prazos para comunicar e justificar a falta ao empregador?</h2>
  <p>A lei distingue entre <a href="http://bdjur.almedina.net/citem.php?field=item_id&value=1361836" target="_blank" style="color:var(--teal)">faltas previsíveis e faltas imprevisíveis</a>, como é normalmente o caso da doença:</p>
  <ul>
    <li>Se a falta for previsível, deve ser comunicada ao empregador com uma antecedência mínima de 5 dias</li>
    <li>Se não for possível cumprir este prazo, como acontece na generalidade das situações de doença súbita, a comunicação deve ser feita logo que possível, idealmente no próprio dia ou no dia seguinte</li>
    <li>O empregador pode exigir prova da justificação apresentada nos 15 dias seguintes à comunicação da ausência</li>
    <li>Para candidatos a cargos públicos, a antecedência mínima exigida é de 48 horas</li>
  </ul>
  <p>O incumprimento destes prazos, mesmo que o motivo da ausência seja legítimo, pode levar a que a falta seja considerada injustificada, com todas as consequências que isso implica.</p>

  <h2>Quais as consequências de uma falta injustificada?</h2>
  <p>A não apresentação da justificação dentro do prazo transforma a ausência em falta injustificada. As <a href="https://informador.pt/legislacao/lexit/codigos/direito-laboral/codigo-do-trabalho/livro-i-parte-geral-2/titulo-ii-contrato-de-trabalho/capitulo-ii-prestacao-do-trabalho/seccao-ii-duracao-e-organizacao-do-tempo-de-trabalho/subseccao-xi-faltas/artigo-256-o-efeitos-de-falta-injustificada/" target="_blank" style="color:var(--teal)">principais consequências são</a>:</p>
  <ul>
    <li>Perda da retribuição correspondente ao período de ausência</li>
    <li>Os dias de falta injustificada não contam para efeitos de antiguidade do trabalhador</li>
    <li>Se a falta ocorrer imediatamente antes ou depois de um feriado ou de um dia de descanso, é qualificada como infração mais grave</li>
    <li>Faltas injustificadas têm relevância disciplinar e podem fundamentar um processo disciplinar</li>
  </ul>
  <div class="ibox warn"><div class="ibox-title">⚠️ Despedimento por justa causa</div><p>O <a href="https://informador.pt/legislacao/lexit/codigos/direito-laboral/codigo-do-trabalho/livro-i-parte-geral-2/titulo-ii-contrato-de-trabalho/capitulo-vii-cessacao-de-contrato-de-trabalho/seccao-iv-despedimento-por-iniciativa-do-empregador/subseccao-i-modalidades-de-despedimento/divisao-i-despedimento-por-facto-imputavel-ao-trabalhador/artigo-351-o-nocao-de-justa-causa-de-despedimento/" target="_blank" style="color:var(--teal)">artigo 351.º do Código do Trabalho</a> prevê despedimento com justa causa quando as faltas injustificadas, no mesmo ano civil, atingirem determinados limites (designadamente cinco faltas seguidas ou dez interpoladas), pelo que a justificação atempada de qualquer ausência por doença é essencial para proteger o vínculo laboral.</p></div>

  <h2>Posso ser despedido por faltar ao trabalho devido a doença?</h2>
  <p>Faltas devidamente justificadas por doença não podem constituir fundamento de despedimento com justa causa, nos termos do <a href="https://informador.pt/legislacao/lexit/codigos/direito-laboral/codigo-do-trabalho/livro-i-parte-geral-2/titulo-ii-contrato-de-trabalho/capitulo-vii-cessacao-de-contrato-de-trabalho/seccao-iv-despedimento-por-iniciativa-do-empregador/subseccao-i-modalidades-de-despedimento/divisao-i-despedimento-por-facto-imputavel-ao-trabalhador/artigo-351-o-nocao-de-justa-causa-de-despedimento/" target="_blank" style="color:var(--teal)">artigo 351.º do Código do Trabalho</a>. O contrato de trabalho mantém-se em vigor durante o período de baixa, ficando suspenso enquanto durar a incapacidade, mas o trabalhador conserva a antiguidade e todos os direitos associados ao vínculo laboral, incluindo a proteção contra o despedimento motivado pela própria doença.</p>
  <p>Esta proteção aplica-se tanto às ausências justificadas por autodeclaração de doença como às cobertas por CIT, desde que os prazos e formalidades legais tenham sido cumpridos.</p>

  <h2>Posso usar férias para evitar perder salário?</h2>
  <p>Quando a falta por doença é justificada, mas implica perda de retribuição, o <a href="https://informador.pt/legislacao/lexit/codigos/direito-laboral/codigo-do-trabalho/livro-i-parte-geral-2/titulo-ii-contrato-de-trabalho/capitulo-ii-prestacao-do-trabalho/seccao-ii-duracao-e-organizacao-do-tempo-de-trabalho/subseccao-xi-faltas/artigo-257-o-substituicao-da-perda-de-retribuicao-por-motivo-de-falta/" target="_blank" style="color:var(--teal)">Código do Trabalho, no seu artigo 257.º</a>, permite ao trabalhador optar por compensar essa perda salarial através da utilização de dias de férias ou da prestação de trabalho suplementar, desde que comunique essa intenção ao empregador, que não se pode opor. O valor do subsídio de férias não é afetado por esta opção de compensação.</p>

  <h2>Quanto vale o subsídio de doença?</h2>
  <p>Uma vez emitido o CIT e cumpridos os requisitos legais (nomeadamente o prazo de garantia contributivo e a situação contributiva regularizada), o trabalhador por conta de outrem tem direito ao subsídio de doença pago pela Segurança Social a partir do 4.º dia de incapacidade. O valor do subsídio varia de forma progressiva, consoante a duração total da baixa médica e o valor da remuneração de referência:</p>

  <div class="ibox">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr style="border-bottom:1px solid rgba(13,115,119,.2)"><th style="padding:8px 0;text-align:left;color:var(--navy)">Duração da baixa</th><th style="padding:8px 0;text-align:left;color:var(--navy)">Percentagem</th></tr>
      <tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0;color:var(--slate)">Até 30 dias</td><td style="padding:8px 0;color:var(--navy);font-weight:600">55%</td></tr>
      <tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0;color:var(--slate)">31–90 dias</td><td style="padding:8px 0;color:var(--navy);font-weight:600">60%</td></tr>
      <tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0;color:var(--slate)">91–365 dias</td><td style="padding:8px 0;color:var(--navy);font-weight:600">70%</td></tr>
      <tr><td style="padding:8px 0;color:var(--slate)">Mais de 365 dias</td><td style="padding:8px 0;color:var(--navy);font-weight:600">75%</td></tr>
    </table>
  </div>
  <p><em>Nas situações de hospitalização, tuberculose ou doenças especialmente graves, a lei prevê percentagens mais elevadas e a possibilidade de o subsídio ser atribuído desde o primeiro dia, sem o período de espera habitual. Consulte sempre a Segurança Social Direta para confirmar a percentagem aplicável ao seu caso concreto.</em></p>

  <h2>Que outras situações também justificam faltas ao trabalho?</h2>
  <p>Além da doença do próprio trabalhador, o Código do Trabalho prevê outras situações relacionadas com saúde que constituem falta justificada, nomeadamente ao abrigo do <a href="http://bdjur.almedina.net/citem.php?field=item_id&value=1361832" target="_blank" style="color:var(--teal)">artigo 249.º do Código do Trabalho</a>:</p>
  <ul>
    <li>Consultas médicas durante o horário de trabalho, quando não seja possível marcá-las fora desse horário, mediante apresentação de declaração de presença emitida pelo prestador de cuidados de saúde</li>
    <li>Assistência inadiável e imprescindível a filho ou outro membro do agregado familiar em caso de doença</li>
    <li>Consultas pré-natais e preparação para o parto, no caso de trabalhadoras grávidas, preferencialmente fora do horário de trabalho sempre que possível</li>
    <li>Acompanhamento da grávida pelo pai, com direito a três dispensas para o efeito</li>
  </ul>
  <p>É importante notar que motivos como a greve escolar dos filhos não constam da lista de faltas justificadas prevista no artigo 249.º do Código do Trabalho, pelo que dependem sempre de autorização do empregador.</p>

  <h2>Como justificar corretamente uma falta por doença: passo a passo</h2>
  <ol>
    <li><strong>Informe o empregador</strong> — logo que possível, idealmente no próprio dia</li>
    <li><strong>Emita a autodeclaração ou obtenha CIT</strong> — conforme a duração e o número de autodeclarações já utilizadas no ano</li>
    <li><strong>Envie o documento</strong> — ao empregador dentro dos prazos legais</li>
    <li><strong>Guarde comprovativos</strong> — de todas as comunicações e documentos entregues</li>
  </ol>

  <h2>Como pedir uma declaração médica ou baixa por videoconsulta?</h2>
  <p>Para quem precisa de justificar uma falta ao trabalho de forma rápida, a consulta médica online por videoconsulta permite obter, no próprio dia, tanto uma declaração médica para faltas curtas como o CIT quando a ausência se prolonga para além de 3 dias. O processo é simples: marca-se a consulta, o médico avalia a situação clínica e emite o documento adequado, com o mesmo valor legal de uma consulta presencial, evitando deslocações e reduzindo o tempo de espera entre o aparecimento dos sintomas e a obtenção do documento necessário para justificar a ausência junto do empregador.</p>

  <div class="art-cta"><h3>Precisa de declaração médica ou baixa médica hoje?</h3><p>Emissão no próprio dia por videoconsulta, enviada por email com validade legal.</p><a href="/">Marcar Consulta Online →</a></div>

  <h2>Erros mais comuns ao justificar uma falta por doença</h2>
  <p>Existem alguns erros frequentes que podem levar a que uma falta por doença seja considerada injustificada ou atrasem o acesso ao subsídio de doença:</p>
  <ul>
    <li><strong>Adiar a comunicação da ausência ao empregador</strong> — a lei exige que esta seja feita logo que possível nas situações de doença inesperada</li>
    <li><strong>Assumir que a autodeclaração substitui sempre o CIT</strong> — o CIT é obrigatório a partir do 4.º dia consecutivo ou quando o limite anual de autodeclarações já foi utilizado</li>
    <li><strong>Esquecer que a autodeclaração apenas pode ser utilizada duas vezes por ano civil</strong> — nas situações seguintes é obrigatório obter CIT</li>
    <li><strong>Não confirmar que o CIT foi entregue à Segurança Social dentro do prazo legal</strong> — quando emitido em papel, cabe ao trabalhador garantir a entrega atempada</li>
  </ul>

  <h2>Em resumo: falta por doença</h2>
  <ul>
    <li>Até 3 dias → autodeclaração</li>
    <li>A partir do 4.º dia → CIT</li>
    <li>Comunicar ao empregador logo que possível</li>
    <li>Guardar comprovativos</li>
    <li>Cumprir os prazos</li>
  </ul>
  <p>Se necessita de uma declaração médica ou de um Certificado de Incapacidade Temporária, uma consulta por videoconsulta pode permitir a avaliação clínica e a emissão do documento adequado quando existir indicação médica.</p>

  <h2>Perguntas frequentes</h2>

  <div class="faq"><h4>Quantos dias posso faltar ao trabalho por doença sem ir ao médico?</h4><p>Pode faltar até 3 dias consecutivos por doença através da autodeclaração de doença, emitida na área pessoal do SNS 24, sem necessidade de consulta médica presencial ou por videoconsulta.</p></div>
  <div class="faq"><h4>Quantas vezes posso usar a autodeclaração de doença por ano?</h4><p>Cada trabalhador pode usar a autodeclaração de doença duas vezes por ano civil, cada uma válida para um máximo de 3 dias consecutivos, o que totaliza até 6 dias de ausência justificada por este meio.</p></div>
  <div class="faq"><h4>A partir de quando é obrigatório ter CIT (baixa médica)?</h4><p>O CIT torna-se obrigatório a partir do 4.º dia consecutivo de doença, ou sempre que o trabalhador já tenha esgotado as duas autodeclarações de doença permitidas no ano civil.</p></div>
  <div class="faq"><h4>Qual o prazo para submeter o CIT à Segurança Social?</h4><p>O CIT deve ser submetido à Segurança Social no prazo de 5 dias úteis a contar do início da incapacidade, sendo esta submissão normalmente feita eletronicamente pelo próprio médico.</p></div>
  <div class="faq"><h4>Posso ser despedido por faltar muitas vezes por doença?</h4><p>Faltas devidamente justificadas por doença não podem constituir justa causa de despedimento, nos termos do <a href="https://informador.pt/legislacao/lexit/codigos/direito-laboral/codigo-do-trabalho/livro-i-parte-geral-2/titulo-ii-contrato-de-trabalho/capitulo-vii-cessacao-de-contrato-de-trabalho/seccao-iv-despedimento-por-iniciativa-do-empregador/subseccao-i-modalidades-de-despedimento/divisao-i-despedimento-por-facto-imputavel-ao-trabalhador/artigo-351-o-nocao-de-justa-causa-de-despedimento/" target="_blank" style="color:var(--teal)">artigo 351.º do Código do Trabalho</a>. A proteção aplica-se enquanto os prazos e formalidades legais forem cumpridos.</p></div>
  <div class="faq"><h4>O que acontece se eu não justificar a falta a tempo?</h4><p>A falta passa a ser considerada injustificada, o que implica perda de retribuição, ausência de contagem para a antiguidade e possível relevância disciplinar, podendo em casos extremos fundamentar despedimento com justa causa.</p></div>
  <div class="faq"><h4>Quanto vale o subsídio de doença pago pela Segurança Social?</h4><p>O valor varia entre 55% e 75% da remuneração de referência, consoante a duração total da baixa médica, sendo a percentagem mais alta aplicável a partir dos 365 dias de incapacidade.</p></div>
  <div class="faq"><h4>Posso compensar os dias de falta por doença para não perder o salário?</h4><p>Sim. Nos termos do <a href="https://informador.pt/legislacao/lexit/codigos/direito-laboral/codigo-do-trabalho/livro-i-parte-geral-2/titulo-ii-contrato-de-trabalho/capitulo-ii-prestacao-do-trabalho/seccao-ii-duracao-e-organizacao-do-tempo-de-trabalho/subseccao-xi-faltas/artigo-257-o-substituicao-da-perda-de-retribuicao-por-motivo-de-falta/" target="_blank" style="color:var(--teal)">artigo 257.º do Código do Trabalho</a>, pode compensar a perda salarial recorrendo a dias de férias ou à prestação de trabalho suplementar, mediante comunicação ao empregador, que não se pode opor.</p></div>
  <div class="faq"><h4>O empregador pode pedir prova da minha justificação de falta?</h4><p>Sim. O empregador pode exigir prova da justificação apresentada nos 15 dias seguintes à comunicação da ausência, como a autodeclaração de doença, o CIT ou uma declaração de presença emitida pelo estabelecimento de saúde.</p></div>
  <div class="faq"><h4>O empregador pode recusar uma autodeclaração de doença?</h4><p>Não pode recusar uma autodeclaração de doença válida, desde que esta cumpra os requisitos legais e tenha sido emitida dentro dos limites previstos na lei. No entanto, se a autodeclaração for utilizada fora das condições legalmente permitidas, por exemplo após esgotar o número máximo anual ou para uma ausência superior a três dias consecutivos, o empregador pode exigir a apresentação de um CIT.</p></div>
  <div class="faq"><h4>Posso sair de casa durante a baixa médica?</h4><p>Depende das indicações constantes do CIT. Em alguns casos, o médico pode autorizar saídas em determinados horários ou sempre que sejam necessárias para tratamentos ou consultas. Sempre que existam restrições, estas devem ser respeitadas, uma vez que a Segurança Social pode realizar ações de verificação da incapacidade temporária.</p></div>
  <div class="faq"><h4>Posso viajar durante a baixa médica?</h4><p>A baixa médica destina-se à recuperação do trabalhador. Viajar durante esse período pode ser incompatível com a situação clínica, sobretudo se contrariar as indicações médicas ou as restrições previstas no CIT. Antes de realizar qualquer deslocação, especialmente para o estrangeiro, é aconselhável confirmar que a viagem não compromete o tratamento nem o cumprimento das obrigações legais associadas à baixa médica.</p></div>
  <div class="faq"><h4>Posso trabalhar durante a baixa médica?</h4><p>Não. O CIT pressupõe que o trabalhador se encontra incapaz de exercer a sua atividade profissional. Continuar a trabalhar durante o período de baixa pode colocar em causa a finalidade da incapacidade temporária e ter consequências no direito ao subsídio de doença ou no cumprimento das obrigações legais.</p></div>
  <div class="faq"><h4>A baixa médica conta para férias?</h4><p>Sim. A baixa médica não elimina o direito a férias. Se a incapacidade temporária coincidir com um período de férias já marcado, aplicam-se as regras previstas no Código do Trabalho relativas à suspensão ou remarcação das férias, permitindo que o trabalhador possa gozá-las posteriormente, nos termos legalmente previstos.</p></div>

  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>Assembleia da República. (2009). Lei n.º 7/2009, de 12 de fevereiro. <em>Código do Trabalho. Diário da República.</em></li>
    <li>Governo de Portugal. (2024). Decreto-Lei n.º 2/2024, de 5 de janeiro. Alteração ao regime da autodeclaração de doença e ao artigo 254.º do Código do Trabalho. <em>Diário da República.</em></li>
    <li>Segurança Social. (2026). <em>Subsídio de doença. Guia Prático.</em> Instituto da Segurança Social, I.P.</li>
    <li>SNS 24. (2026). Autodeclaração de doença: como pedir. Serviço Nacional de Saúde. Disponível em: sns24.gov.pt</li>
    <li>Segurança Social. (2026). Obter informações sobre o subsídio de doença. Disponível em: gov.pt</li>
  </ol></div>

  <p style="font-size:12px;color:var(--muted);margin-top:24px;font-style:italic">Este artigo tem caráter informativo geral e não substitui aconselhamento médico ou jurídico individualizado. As regras aplicáveis podem variar consoante convenções coletivas de trabalho ou regulamentos internos da empresa. Consulte sempre o Código do Trabalho atualizado ou um profissional qualificado para o seu caso concreto.</p>
  `
},

'faltas-escola': {
  title: 'Faltas à Escola por Doença: Como Justificar | ConsultasOnline',
  description: 'O que diz a lei, documentos necessários e como obter declaração médica online para justificar faltas escolares. 35€.',
  keywords: 'faltas escola doença justificar, atestado falta escolar online, declaração médica escola portugal, justificar falta escolar',
  h1: 'Falta à Escola por Doença: Guia Completo para Pais e Encarregados de Educação',
  content: `<div class="cta-top"><p>🎓 Precisa de atestado para justificar falta escolar? Emitido por videoconsulta no próprio dia. <a href="/">Marcar consulta — 35€ →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p>As faltas à escola por motivo de doença são uma realidade inevitável na vida escolar de qualquer criança ou jovem. No entanto, a forma como são justificadas tem implicações legais, académicas e administrativas que muitos encarregados de educação desconhecem. Este guia completo explica o que diz a lei portuguesa, quais os documentos aceites pelas escolas, quais os limites de faltas por nível de ensino, e como obter uma declaração médica de forma rápida e legal.</p>

  <h2>O que diz a lei sobre faltas escolares por doença em Portugal</h2>
  <p>O regime jurídico das faltas escolares em Portugal está estabelecido no Estatuto do Aluno e Ética Escolar, aprovado pela <a href="https://diariodarepublica.pt/dr/detalhe/lei/51-2012-174840" target="_blank" style="color:var(--teal)">Lei n.º 51/2012, de 5 de setembro</a>. Este diploma legal regula as obrigações de frequência, os direitos dos alunos e as regras aplicadas às faltas, à sua justificação e às respetivas consequências.</p>
  <p>O artigo 16.º do Estatuto do Aluno define como falta justificada, entre outras situações, a doença do aluno, devidamente comprovada por declaração médica quando a ausência for superior a três dias úteis, ou por justificação escrita do encarregado de educação ou pelo aluno quando for maior de idade nos restantes casos. A lei portuguesa estabelece, assim, uma distinção clara entre faltas justificadas e faltas injustificadas, com consequências muito distintas para cada uma destas categorias.</p>

  <h3>Faltas à escola justificadas por doença: fundamento legal</h3>
  <p>São consideradas faltas justificadas por motivo de doença as ausências motivadas por:</p>
  <ul>
    <li>Doença aguda do próprio aluno, devidamente comprovada por declaração médica</li>
    <li>Doença crónica ou condição de saúde permanente que justifique ausência recorrente</li>
    <li>Consulta médica ou exame clínico que não possa ser marcado fora do horário letivo</li>
    <li>Acidente ou intervenção cirúrgica que requeira período de recuperação</li>
    <li>Internamento hospitalar</li>
  </ul>
  <p>A justificação da falta deve ser apresentada previamente, sendo o motivo previsível, ou, nos restantes casos, até ao 3.º dia útil subsequente à verificação da mesma.</p>

  <h3>O que é uma falta escolar injustificada e quais as consequências</h3>
  <p>Uma falta escolar é considerada injustificada quando o encarregado de educação não apresenta qualquer justificação, quando a justificação apresentada não é aceite pela escola, a marcação da falta resulte da aplicação da ordem de saída da sala de aula ou de medida disciplinar sancionatória ou, ainda, quando os prazos de justificação não são cumpridos. As faltas injustificadas têm implicações disciplinares e académicas significativas, podendo levar à retenção do aluno caso ultrapassem os limites legalmente previstos.</p>

  <h2>Documentos a entregar nas escolas para justificar faltas por doença</h2>
  <p>A lei portuguesa prevê dois tipos principais de documentos para justificar faltas escolares por motivo de doença, com regras diferentes consoante a duração da ausência e o nível de ensino frequentado.</p>

  <h3>Declaração escrita do encarregado de educação</h3>
  <p>No ensino básico, o encarregado de educação pode justificar por escrito as faltas do seu educando, sem necessidade de declaração médica, até um máximo de três dias por período letivo.</p>
  <p>No ensino secundário, a justificação escrita do encarregado de educação também é aceite, mas cada escola pode estabelecer nos seus regulamentos internos limitações adicionais ao número de justificações aceites por período sem apoio documental médico.</p>

  <h3>Declaração médica</h3>
  <p>A declaração médica é o documento mais sólido para justificar faltas escolares por doença. Pode ser emitida por qualquer médico inscrito na Ordem dos Médicos, seja do Serviço Nacional de Saúde (SNS) ou de entidades privadas, incluindo através de consulta médica online por <a href="/artigos/consulta-online">videoconsulta</a>.</p>
  <p>A declaração médica deve conter:</p>
  <ul>
    <li>Identificação do aluno (nome e data de nascimento)</li>
    <li>Período de incapacidade para a frequência escolar (data de início e de fim previsto)</li>
    <li>Indicação de que o aluno esteve incapaz de frequentar a escola por motivo de saúde</li>
    <li>Identificação e assinatura do médico (nome e cédula profissional)</li>
    <li>Data de emissão</li>
  </ul>
  <p>Importa notar que a declaração médica para fins escolares não obriga à divulgação do diagnóstico. O médico atesta a incapacidade para frequência escolar sem que a escola tenha direito a conhecer a doença concreta que motivou a ausência, em respeito pelo sigilo médico e pela proteção de dados de saúde ao abrigo do <a href="https://eur-lex.europa.eu/PT/legal-content/summary/general-data-protection-regulation-gdpr.html" target="_blank" style="color:var(--teal)">Regime Geral de Proteção de Dados</a>.</p>

  <h3>Outros documentos aceites</h3>
  <ul>
    <li>Comprovativo de internamento hospitalar</li>
    <li>Declaração de presença em consulta médica (para faltas de um dia por motivo de consulta)</li>
    <li>Certidão do tribunal tutelar de menores (em situações específicas)</li>
  </ul>

  <h2>Limites de faltas por nível de ensino: o que diz a lei</h2>
  <p>O Estatuto do Aluno estabelece limites máximos de faltas que, se ultrapassados, podem ter consequências académicas graves, incluindo a retenção do aluno no mesmo ano letivo. Estes limites aplicam-se sobretudo às faltas injustificadas, mas o excesso de faltas justificadas pode também ter implicações em determinados níveis de ensino.</p>

  <h3>Faltas escolares no Ensino Básico (1.º, 2.º e 3.º ciclo)</h3>
  <p>No ensino básico, as faltas justificadas por doença não têm, em regra, consequências académicas diretas. No entanto, quando o número de faltas justificadas é elevado, o diretor de turma deve informar o encarregado de educação e, em casos de absentismo crónico, pode ser acionado o mecanismo de sinalização à <a href="https://www.cndcj.gov.pt/cpcj" target="_blank" style="color:var(--teal)">Comissão de Proteção de Crianças e Jovens</a>.</p>
  <p>Quanto às faltas injustificadas, os limites previstos no artigo 18.º, n.º 1, da Lei n.º 51/2012 são diferentes consoante o ciclo:</p>
  <p>No <strong>1.º ciclo do ensino básico</strong>, o limite é de <strong>10 dias de faltas injustificadas</strong>, seguidos ou interpolados.</p>
  <p>No <strong>2.º e 3.º ciclo do ensino básico</strong>, o limite é o <strong>dobro do número de tempos letivos semanais por disciplina</strong>. Por exemplo, numa disciplina com 3 tempos semanais, o limite de faltas injustificadas é de 6 tempos. Ultrapassado este limite, o conselho de turma delibera sobre as medidas a adotar, que podem incluir atividades de recuperação ou, em casos extremos, a retenção.</p>

  <h3>Faltas escolares no Ensino Secundário (10.º, 11.º e 12.º ano) e cursos profissionais</h3>
  <p>No ensino secundário aplica-se a mesma regra do 2.º e 3.º ciclo: o limite é o dobro do número de tempos letivos semanais por disciplina (artigo 18.º, n.º 1, al. b), da Lei n.º 51/2012). Numa disciplina com 3 tempos semanais, o limite é de 6 faltas.</p>
  <p>No entanto, para as ofertas formativas profissionalmente qualificantes, como os cursos profissionais, o artigo 18.º, n.º 2, prevê regras próprias que incluem tanto faltas justificadas como injustificadas, nos termos definidos na regulamentação específica de cada oferta ou no regulamento interno da escola.</p>
  <p>Existem mecanismos de proteção previstos na lei para situações de doença prolongada ou crónica, incluindo regimes especiais para alunos com condições de saúde devidamente comprovadas.</p>

  <h3>Cálculo prático do limite de faltas</h3>
  <p>O limite de faltas injustificadas é calculado com base no dobro dos tempos letivos semanais de cada disciplina, e não com base numa percentagem da carga horária anual.</p>
  <p><strong>Exemplos práticos de cálculo do número de faltas:</strong></p>
  <ul>
    <li>Disciplina com 2 tempos semanais: limite de 4 faltas injustificadas</li>
    <li>Disciplina com 3 tempos semanais: limite de 6 faltas injustificadas</li>
    <li>Disciplina com 5 tempos semanais: limite de 10 faltas injustificadas</li>
  </ul>
  <p>Quando as aulas decorrem em tempos consecutivos, são registadas tantas faltas quantos os tempos em que o aluno esteve ausente, nos termos do artigo 14.º, n.º 2, da Lei n.º 51/2012. Quando metade do limite é atingida, o diretor de turma tem obrigação legal de convocar o encarregado de educação, nos termos do artigo 18.º, n.º 3, da Lei n.º 51/2012.</p>

  <h2>Prazo para apresentar a justificação de falta à escola</h2>
  <p>O prazo legal para apresentar a justificação de falta à escola é de três dias úteis a partir da verificação da falta, conforme o artigo 17.º, n.º 3, da Lei n.º 51/2012.</p>
  <p>Na prática, alguns regulamentos internos de escola podem prever procedimentos específicos, como a entrega da justificação diretamente ao diretor de turma, através da caderneta do aluno ou de plataforma digital escolar. É importante verificar o regulamento interno da escola específica.</p>
  <p>A não apresentação da justificação dentro do prazo legal resulta na classificação das faltas como injustificadas, independentemente do motivo real da ausência.</p>

  <h2>Absentismo escolar crónico por doença: regimes especiais</h2>
  <p>A lei portuguesa prevê regimes especiais para alunos com doença crónica ou condições de saúde que impliquem faltas recorrentes. Estes mecanismos são frequentemente desconhecidos, mas podem ser determinantes para o percurso académico de alunos com doença crónica.</p>

  <h3>Regime Educativo Especial de faltas à escola por motivo de saúde</h3>
  <p>O <a href="https://diariodarepublica.pt/dr/detalhe/decreto-lei/54-2018-115652961" target="_blank" style="color:var(--teal)">Decreto-Lei n.º 54/2018</a>, de 6 de julho, que estabelece o regime jurídico da educação inclusiva, prevê a possibilidade de adaptações ao processo de ensino e avaliação para alunos com necessidades de saúde especiais. Estas adaptações podem incluir horário escolar adaptado, dispensa de determinadas atividades físicas, avaliação em datas alternativas e, em casos mais graves, ensino doméstico.</p>

  <h3>Faltas por internamento hospitalar ou doença de longa duração</h3>
  <p>A Lei n.º 51/2012 não prevê um regime especial específico para faltas por doença prolongada. O que existe são mecanismos complementares previstos noutros diplomas:</p>
  <p>Para crianças com doença oncológica, a <a href="https://diariodarepublica.pt/dr/detalhe/lei/71-2009-494015" target="_blank" style="color:var(--teal)">Lei n.º 71/2009, de 6 de agosto</a>, e a <a href="https://diariodarepublica.pt/dr/detalhe/portaria/350-a-2017-114203983" target="_blank" style="color:var(--teal)">Portaria n.º 350-A/2017, de 14 de novembro</a>, preveem medidas educativas especiais, incluindo condições especiais de avaliação e frequência escolar, apoio educativo individual e no domicílio, e adaptação curricular.</p>
  <p>Para situações em que a doença impede definitivamente a frequência escolar, o <a href="https://diariodarepublica.pt/dr/detalhe/decreto-lei/70-2021-168903099" target="_blank" style="color:var(--teal)">Decreto-Lei n.º 70/2021</a> regula o ensino individual, modalidade em que um professor se desloca ao domicílio, permitindo ao aluno manter o percurso escolar sem presença física na escola.</p>

  <h2>Como obter uma declaração médica para falta à escola</h2>
  <p>Para obter uma declaração médica para justificar a falta escolar do filho, o encarregado de educação tem várias opções, com vantagens e desvantagens diferentes em termos de rapidez, custo e conveniência.</p>

  <h3>Centro de Saúde ou médico de família (SNS)</h3>
  <p>A opção gratuita é recorrer ao centro de saúde ou ao médico de família do SNS. No entanto, obter consulta no próprio dia em que a criança adoece pode ser difícil. Os tempos de espera para consulta com médico de família no SNS são frequentemente de vários dias, o que pode inviabilizar a obtenção da declaração dentro do prazo legal de três dias úteis.</p>

  <h3>Urgência hospitalar ou pediátrica</h3>
  <p>Em situações de doença mais grave, a urgência hospitalar pode emitir declaração de presença ou nota de alta que serve de justificação escolar. No entanto, o recurso à urgência hospitalar deve ser reservado para situações que genuinamente o justifiquem.</p>

  <h3>Consulta médica privada presencial</h3>
  <p>Uma clínica privada ou médico privado pode emitir a declaração no próprio dia, mas implica deslocação física e um custo que varia consoante a especialidade e a clínica.</p>

  <h3>Consulta médica online por videoconsulta</h3>
  <p>A <a href="/artigos/consulta-online">videoconsulta</a> é atualmente a opção mais rápida e conveniente para obter uma declaração médica para falta escolar. Permite obter a declaração no próprio dia, sem deslocação, o que é especialmente vantajoso quando a criança está com febre ou indisposta e não tem condições para sair de casa.</p>
  <p>A declaração emitida por videoconsulta tem exatamente o mesmo valor legal que a emitida em consulta presencial, desde que o médico esteja devidamente inscrito na Ordem dos Médicos. A ConsultasOnline disponibiliza este serviço de segunda a domingo, das 9h às 21h, com emissão de fatura AT automática e envio da declaração por email no próprio dia.</p>

  <h2>O que deve conter a declaração médica para falta escolar</h2>
  <p>Para garantir que a declaração médica é aceite pela escola sem problemas, deve incluir os seguintes elementos:</p>
  <ul>
    <li>Nome completo do aluno e data de nascimento</li>
    <li>Período de incapacidade: datas de início e de fim da impossibilidade de frequência escolar</li>
    <li>Indicação explícita de que o aluno estava impossibilitado de frequentar o estabelecimento de ensino por motivo de saúde</li>
    <li>Identificação do médico: nome completo, especialidade, número de cédula profissional e assinatura</li>
    <li>Data de emissão do documento</li>
    <li>Carimbo do médico ou da instituição (quando aplicável)</li>
  </ul>
  <p>O diagnóstico não deve constar da declaração, em respeito pelo sigilo médico. A escola não tem direito a exigir o conhecimento da doença que motivou a ausência.</p>

  <h2>A declaração médica online é aceite pelas escolas?</h2>
  <p>Sim. A declaração médica emitida na sequência de uma <a href="/artigos/consulta-online">videoconsulta</a> tem plena validade legal junto de escolas públicas e privadas em Portugal, desde que cumpra os requisitos legais aplicados a qualquer declaração médica. A lei portuguesa não distingue entre declaração emitida em consulta presencial e declaração emitida em consulta online.</p>

  <h2>Conselhos práticos para encarregados de educação</h2>
  <ul>
    <li>Guarde sempre uma cópia da declaração médica entregue à escola.</li>
    <li>Entregue a justificação dentro do prazo de três dias úteis após a verificação da falta.</li>
    <li>Verifique o regulamento interno da escola quanto aos procedimentos específicos de justificação de faltas.</li>
    <li>Acompanhe o número de faltas acumuladas, especialmente no ensino secundário, para evitar situações de exclusão de avaliação.</li>
    <li>Em caso de dúvida sobre o limite de faltas, contacte o diretor de turma antes de atingir o limite.</li>
    <li>Para doenças de longa duração, informe-se sobre o direito a ensino hospitalar ou doméstico.</li>
  </ul>

  <div class="art-cta"><h3>Precisa de declaração médica para falta escolar hoje?</h3><p>Emissão no próprio dia por videoconsulta, enviada por email com validade legal. Disponível de segunda a domingo, das 9h às 21h.</p><a href="/">Marcar Consulta Online — 35€ →</a></div>

  <h2>Perguntas frequentes</h2>

  <div class="faq"><h4>O que acontece se o meu filho ultrapassar o limite de faltas?</h4><p>No ensino básico, o excesso de faltas justificadas não tem consequências académicas diretas, mas pode ser sinalizado. No ensino secundário, pode implicar a impossibilidade de realizar os testes sumativos e, portanto, de obter classificação final em determinada disciplina. O conselho de turma deve deliberar sobre a situação e informar o encarregado de educação.</p></div>
  <div class="faq"><h4>Quantas faltas justificadas são permitidas no ensino secundário?</h4><p>O limite é o dobro do número de tempos letivos semanais por disciplina (artigo 18.º, n.º 1, al. b), da Lei n.º 51/2012). Numa disciplina com 3 tempos semanais, o limite é de 6 faltas. Para os cursos profissionais, o artigo 18.º, n.º 2, prevê regras próprias que incluem tanto faltas justificadas como injustificadas.</p></div>
  <div class="faq"><h4>No ensino básico, quantas faltas pode o encarregado de educação justificar por escrito?</h4><p>No ensino básico, o encarregado de educação pode justificar até três dias de falta por período letivo por escrito, sem necessidade de declaração médica. Para ausências superiores, a declaração médica é necessária.</p></div>
  <div class="faq"><h4>Qual é o prazo para justificar uma falta escolar por doença?</h4><p>O prazo legal é de três dias úteis após a verificação da falta. A justificação deve ser entregue ao diretor de turma ou ao professor titular de turma dentro deste prazo, sob pena de as faltas serem classificadas como injustificadas.</p></div>
  <div class="faq"><h4>A escola pode exigir saber o diagnóstico da doença?</h4><p>Não. A declaração médica para fins escolares não deve incluir o diagnóstico. A escola apenas tem direito a saber que o aluno esteve impossibilitado de frequentar as aulas por motivo de saúde e o período de incapacidade. O diagnóstico é informação clínica protegida pelo sigilo médico e pelo RGPD.</p></div>
  <div class="faq"><h4>A declaração médica serve para justificar faltas retroativamente?</h4><p>Em regra, a declaração médica deve ser emitida durante ou imediatamente após o período de doença. A emissão retroativa pode ser questionada pela escola. Se o prazo de três dias úteis foi ultrapassado, o encarregado de educação deve contactar o diretor de turma e explicar a situação, apresentando a declaração e solicitando que seja apreciada. A decisão final cabe ao diretor de turma e ao conselho de turma.</p></div>
  <div class="faq"><h4>A declaração médica online é aceite pelas escolas portuguesas?</h4><p>Sim. A declaração médica emitida por um médico inscrito na Ordem dos Médicos, seja em consulta presencial ou online, tem plena validade legal junto de escolas públicas e privadas em Portugal. A lei não faz qualquer distinção entre os dois formatos.</p></div>
  <div class="faq"><h4>Quanto custa obter uma declaração médica online para falta escolar?</h4><p>Na ConsultasOnline, o atestado médico para falta escolar custa 35 euros, com fatura AT automática e envio da declaração por email no próprio dia. O serviço está disponível de segunda a domingo, das 9h às 21h.</p></div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Assembleia da República. (2012). Lei n.º 51/2012, de 5 de setembro. Estatuto do Aluno e Ética Escolar. <em>Diário da República, 1.ª série, n.º 172.</em> https://diariodarepublica.pt/dr/detalhe/lei/51-2012-174840</li>
    <li>Assembleia da República. (2012). Declaração de Retificação n.º 46/2012. Retificação à Lei n.º 51/2012, de 5 de setembro. <em>Diário da República, 1.ª série.</em></li>
    <li>Governo de Portugal. (2018). Decreto-Lei n.º 54/2018, de 6 de julho. Regime jurídico da educação inclusiva. <em>Diário da República, 1.ª série, n.º 129.</em> https://diariodarepublica.pt/dr/detalhe/decreto-lei/54-2018-115652961</li>
    <li>Assembleia da República. (2009). Lei n.º 71/2009, de 6 de agosto. Regime especial de proteção de crianças e jovens com doença oncológica. <em>Diário da República, 1.ª série, n.º 151.</em> https://diariodarepublica.pt/dr/detalhe/lei/71-2009-494015</li>
    <li>Ministério da Educação. (2017). Portaria n.º 350-A/2017, de 14 de novembro. Medidas educativas especiais para crianças e jovens com doença oncológica. <em>Diário da República, 1.ª série, n.º 219.</em> https://diariodarepublica.pt/dr/detalhe/portaria/350-a-2017-114203983</li>
    <li>Governo de Portugal. (2021). Decreto-Lei n.º 70/2021, de 3 de agosto. Regime jurídico do ensino individual e do ensino doméstico. <em>Diário da República, 1.ª série.</em> https://diariodarepublica.pt/dr/detalhe/decreto-lei/70-2021-168903099</li>
  </ol></div>

  <p style="font-size:12px;color:var(--muted);margin-top:16px;font-style:italic">Artigo revisto por médico inscrito na Ordem dos Médicos. Para uso informativo. Não substitui aconselhamento jurídico ou médico individualizado.</p>
  `
},

'dor-de-garganta-amigdalite': {
  title: 'Dor de Garganta e Amigdalite: Quando é Preciso Antibiótico? | ConsultasOnline',
  description: 'Amigdalite viral ou bacteriana? Quando precisa de antibiótico. Consulta online de amigdalite com avaliação e receita. 40€.',
  keywords: 'consulta amigdalite online, antibiótico amigdalite online, dor garganta consulta online portugal, amigdalite bacteriana viral',
  content: `<div class='cta-top'><p>🤒 Com dor de garganta intensa? Avaliação e tratamento por <a href='/artigos/consulta-online'>videoconsulta</a> em 30 minutos. <a href='/'>Marcar consulta — 40€ →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>

  <p>A dor de garganta é um dos motivos de consulta mais frequentes nos cuidados de saúde primários e nas urgências em Portugal. Na maioria das vezes, a causa é viral e resolve sozinha em poucos dias, sem necessidade de antibiótico. Mas há situações em que a infeção é bacteriana, e aí o antibiótico correto, prescrito a tempo, previne complicações que podem ser sérias. O problema é que distinguir uma da outra não é sempre evidente, especialmente sem avaliação médica.</p>
  <p>Este artigo explica o que é a amigdalite, como o médico distingue a causa viral da bacteriana, quando é realmente necessário tomar antibiótico, quais os sinais de alarme que exigem ida urgente ao hospital, e como a avaliação pode ser feita por <a href="/artigos/consulta-online">videoconsulta</a>.</p>

  <h2>O que é a amigdalite e a faringoamigdalite?</h2>
  <p>A amigdalite é a inflamação das amígdalas, duas estruturas de tecido linfático situadas de cada lado da garganta que fazem parte do sistema imunitário. A faringoamigdalite é o termo mais preciso que os médicos usam quando a inflamação envolve simultaneamente as amígdalas e a faringe (a parede posterior da garganta), que é o mais frequente na prática clínica.</p>
  <p>A doença pode ser causada por vírus ou por bactérias, e esta distinção é fundamental para decidir o tratamento. Tomar antibiótico quando a causa é viral não trata a infeção, não encurta a duração dos sintomas e contribui para o aumento de resistências bacterianas, um problema de saúde pública crescente em Portugal e na Europa.</p>

  <h2>Amigdalite viral ou bacteriana: como distinguir?</h2>
  <p>A grande maioria das faringoamigdalites agudas é de origem viral. <a href="https://raco.cat/index.php/FC/article/download/320843/411326" target="_blank" style="color:#0d7377">Em adultos, a etiologia viral representa cerca de 90% dos casos</a>. Os vírus mais frequentemente envolvidos são o rinovírus, o coronavírus (não o SARS-CoV-2), o adenovírus, o vírus influenza e o vírus Epstein-Barr (responsável pela mononucleose infeciosa).</p>
  <p>A causa bacteriana mais importante é o <em>Streptococcus pyogenes</em>, também chamado estreptococo beta-hemolítico do grupo A (EBHGA). É responsável pela faringoamigdalite bacteriana e é a única causa que justifica antibioticoterapia de forma rotineira, porque o seu tratamento previne complicações como a febre reumática.</p>
  <p>Algumas características clínicas apontam mais para uma causa do que para outra:</p>

  <h3>Sinais que sugerem causa viral</h3>
  <ul>
    <li>Rinorreia (corrimento nasal) e congestão nasal</li>
    <li>Tosse presente</li>
    <li>Rouquidão ou disfonia</li>
    <li>Úlceras na mucosa oral</li>
    <li>Conjuntivite associada</li>
    <li>Diarreia ou sintomas gastrointestinais</li>
    <li>Evolução gradual dos sintomas</li>
  </ul>

  <h3>Sinais que sugerem causa bacteriana (estreptocócica)</h3>
  <ul>
    <li>Início súbito de dor de garganta intensa</li>
    <li>Febre elevada, frequentemente acima de 38ºC</li>
    <li>Exsudado purulento nas amígdalas (placas brancas ou amareladas)</li>
    <li>Gânglios cervicais anteriores dolorosos à palpação</li>
    <li>Ausência de tosse</li>
    <li>Ausência de sintomas nasais ou respiratórios</li>
  </ul>
  <p>Estes sinais orientam o médico, mas nenhum deles, isolado, permite confirmar ou excluir com certeza a causa bacteriana. É por isso que existem ferramentas de pontuação clínica para ajudar nesta decisão.</p>

  <h2>Os critérios de Centor e McIsaac: a ferramenta que os médicos usam</h2>
  <p>A escala de Centor, <a href="https://gpnotebook.com/pt/pages/ouvido-nariz-e-garganta/criterios-centor-para-auxiliar-o-diagnostico-do-estreptococo-beta-hemolitico-do-grupo-a" target="_blank" style="color:#0d7377">adaptada à idade pediátrica por McIsaac</a>, é a ferramenta de predição clínica mais utilizada para estimar a probabilidade de faringoamigdalite estreptocócica. Cada critério presente vale um ponto:</p>

  <div class="ibox">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr style="border-bottom:1px solid rgba(13,115,119,.2)"><th style="padding:8px 0;text-align:left;color:#0b1d35">Critério</th><th style="padding:8px 0;text-align:center;color:#0b1d35">Pontos</th></tr>
      <tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px 0;color:#334155">Febre superior a 38ºC</td><td style="padding:8px 0;text-align:center;color:#0b1d35">+1</td></tr>
      <tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px 0;color:#334155">Ausência de tosse</td><td style="padding:8px 0;text-align:center;color:#0b1d35">+1</td></tr>
      <tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px 0;color:#334155">Exsudado amigdalino (placas)</td><td style="padding:8px 0;text-align:center;color:#0b1d35">+1</td></tr>
      <tr style="border-bottom:1px solid #e2e8f0"><td style="padding:8px 0;color:#334155">Gânglios cervicais anteriores dolorosos</td><td style="padding:8px 0;text-align:center;color:#0b1d35">+1</td></tr>
      <tr><td style="padding:8px 0;color:#334155">Idade entre 3 e 14 anos (McIsaac)</td><td style="padding:8px 0;text-align:center;color:#0b1d35">+1</td></tr>
    </table>
  </div>

  <p>A interpretação da pontuação é a seguinte:</p>
  <ul>
    <li><strong>0 a 1 ponto:</strong> causa viral muito provável. Antibiótico não indicado, sem necessidade de teste de diagnóstico rápido.</li>
    <li><strong>2 a 3 pontos:</strong> probabilidade intermédia de causa estreptocócica. O teste de diagnóstico rápido (TDR) pode ajudar a confirmar ou excluir a causa bacteriana.</li>
    <li><strong>4 ou mais pontos:</strong> probabilidade elevada de causa estreptocócica. O médico pode considerar iniciar antibiótico empiricamente ou confirmar com TDR.</li>
  </ul>
  <p>É importante notar que <a href="https://www.saludcastillayleon.es/portalmedicamento/es/noticias-destacados/destacados/faringoamigdalitis-aguda-test-diagnostico-rapido-tdr-detecc" target="_blank" style="color:#0d7377">os critérios de Centor não são perfeitos e devem ser usados como orientação, considerando sempre o contexto clínico global</a>. Um score baixo não exclui completamente a infeção bacteriana, e um score alto não a confirma com certeza.</p>

  <h2>O teste de diagnóstico rápido para estreptococo</h2>
  <p>O teste de diagnóstico rápido (TDR) para deteção do antígeno estreptocócico é feito com uma zaragatoa da garganta e dá resultado em poucos minutos. É muito útil para confirmar ou excluir a causa estreptocócica quando os critérios clínicos são intermédios, evitando quer o tratamento desnecessário com antibióticos quer a falha terapêutica em casos genuinamente bacterianos. Está disponível em centros de saúde, algumas clínicas privadas e farmácias.</p>
  <p>Num contexto de <a href="/artigos/consulta-online">videoconsulta</a>, o médico avalia os critérios clínicos com base nos sintomas descritos e, quando necessário, pode orientar para a realização do TDR numa farmácia ou laboratório próximo antes de decidir o tratamento.</p>

  <h2>Quando é necessário tomar antibiótico para a amigdalite?</h2>
  <p>O antibiótico está indicado na faringoamigdalite quando existe forte suspeita ou confirmação de causa estreptocócica. As situações em que o médico considera iniciar antibiótico são:</p>
  <ul>
    <li>TDR positivo para estreptococo do grupo A</li>
    <li>Pontuação de Centor-McIsaac elevada com quadro clínico muito sugestivo de infeção bacteriana</li>
    <li>Situações de risco aumentado de complicações: história de febre reumática, doença cardíaca valvular, imunodepressão</li>
    <li>Ausência de melhoria após 48 a 72 horas com tratamento sintomático</li>
  </ul>
  <p>Nas faringoamigdalites de causa viral, o tratamento é sintomático: analgésicos e antipiréticos (paracetamol ou ibuprofeno), repouso, ingestão adequada de líquidos e gargarejos com água morna com sal. Os antibióticos não têm qualquer efeito nas infeções virais.</p>

  <h2>Qual o antibiótico recomendado para a amigdalite bacteriana em Portugal?</h2>
  <p>Quando o antibiótico está indicado, o tratamento de primeira linha recomendado pela <a href="https://www.dgs.pt" target="_blank" style="color:#0d7377">Direção-Geral da Saúde</a> e pelas guidelines internacionais é:</p>
  <ul>
    <li><strong>Amoxicilina 500 mg três vezes por dia durante 10 dias</strong> (adultos): é o antibiótico de primeira linha em Portugal pela sua eficácia, segurança e perfil de resistências favorável contra o estreptococo do grupo A. <em>Streptococcus pyogenes</em> não desenvolve resistência às penicilinas.</li>
    <li><strong>Em crianças:</strong> amoxicilina em suspensão oral, na dose ajustada ao peso, durante 10 dias.</li>
    <li><strong>Em caso de alergia às penicilinas:</strong> azitromicina durante 5 dias ou claritromicina durante 10 dias são as alternativas mais usadas. Importa notar que as taxas de resistência do estreptococo aos macrólidos (azitromicina, claritromicina) têm vindo a aumentar.</li>
  </ul>
  <p>A duração de 10 dias é importante para garantir a erradicação bacteriana completa e prevenir a febre reumática. Interromper o antibiótico antes do fim do tratamento, mesmo que os sintomas melhorem, aumenta o risco de recidiva e de complicações.</p>
  <div class="ibox warn"><div class="ibox-title">⚠️ Amoxicilina com ácido clavulânico não é indicada</div><p>A amoxicilina com ácido clavulânico (Augmentin) não é o antibiótico de escolha para a faringoamigdalite estreptocócica. O estreptococo do grupo A é sensível à amoxicilina simples, e o ácido clavulânico é desnecessário, aumenta os efeitos secundários gastrointestinais e contribui para a seleção de bactérias resistentes na flora normal da garganta.</p></div>

  <h2>Complicações da amigdalite: quando ir às urgências</h2>
  <p>A maioria das amigdalites, mesmo as bacterianas, resolve sem complicações com o tratamento adequado. Mas existem situações que podem complicar e que exigem avaliação presencial urgente:</p>

  <h3>Abcesso periamigdalino</h3>
  <p>É a complicação mais frequente da amigdalite bacteriana não tratada ou tratada inadequadamente. O pus acumula-se no espaço entre a amígdala e a parede da faringe. Os sinais que devem alertar são:</p>
  <ul>
    <li>Trismo: dificuldade em abrir a boca</li>
    <li>Voz "engrolada" ou de "batata quente na boca"</li>
    <li>Desvio da úvula para um dos lados</li>
    <li>Assimetria evidente das amígdalas, com uma muito maior do que a outra</li>
    <li>Dificuldade em engolir líquidos</li>
    <li>Dor intensa e unilateral</li>
  </ul>
  <p>O abcesso periamigdalino é uma emergência cirúrgica que requer drenagem hospitalar. Se tiver estes sinais, dirija-se imediatamente às urgências.</p>

  <h3>Febre reumática</h3>
  <p>É uma complicação inflamatória que pode surgir semanas após uma faringoamigdalite estreptocócica não tratada. Pode afetar o coração (cardite reumática), as articulações (artrite), o sistema nervoso (coreia de Sydenham) e a pele. O tratamento atempado com amoxicilina durante 10 dias previne praticamente todos os casos de febre reumática.</p>

  <h3>Glomerulonefrite pós-estreptocócica</h3>
  <p>Uma complicação renal que pode surgir após infeção estreptocócica. Ao contrário da febre reumática, o antibiótico não previne a glomerulonefrite de forma consistente, mas o tratamento correto continua a ser fundamental para evitar a propagação da infeção.</p>

  <h3>Mononucleose infeciosa: um diagnóstico que não deve ser confundido</h3>
  <p>A mononucleose infeciosa, causada pelo vírus Epstein-Barr, pode apresentar-se com amigdalite com exsudado muito exuberante, gânglios cervicais muito volumosos, febre e prostração marcada. Pode ser confundida com amigdalite estreptocócica. O ponto de alerta é que a administração de amoxicilina numa mononucleose provoca frequentemente um exantema cutâneo extenso (erupção cutânea). Se surgir erupção cutânea após iniciar amoxicilina para a garganta, interrompa o antibiótico e recorra ao médico.</p>

  <h2>Amigdalite recorrente: quando se considera a amigdalectomia?</h2>
  <p>Algumas pessoas têm episódios muito frequentes de amigdalite ao longo do ano. A amigdalectomia (remoção cirúrgica das amígdalas) pode ser considerada em adultos com amigdalite recorrente documentada. Os critérios mais utilizados são os critérios de Paradise, que exigem um número mínimo de episódios por ano durante um período definido, documentados clinicamente. A decisão deve ser tomada em conjunto com um otorrinolaringologista.</p>

  <h2>A avaliação por videoconsulta é adequada para a dor de garganta?</h2>
  <p>Sim, para a grande maioria dos casos de faringoamigdalite em adultos. Por <a href="/artigos/consulta-online">videoconsulta</a>, o médico pode:</p>
  <ul>
    <li>Avaliar os sintomas e calcular a pontuação de Centor-McIsaac</li>
    <li>Pedir ao utente que mostre a garganta em câmara para observação visual</li>
    <li>Orientar para realização de TDR numa farmácia próxima, se necessário</li>
    <li>Prescrever analgésicos e antipiréticos para alívio dos sintomas</li>
    <li>Prescrever antibiótico quando clinicamente indicado</li>
  </ul>
  <p>A videoconsulta não é adequada quando existem sinais de alarme que sugerem abcesso periamigdalino (trismo, voz engrolada, assimetria amigdalina marcada), dificuldade em engolir líquidos, prostração intensa, ou suspeita de epiglotite. Nestas situações a avaliação deve ser presencial e urgente.</p>

  <div class="art-cta"><h3>Tem dor de garganta intensa?</h3><p>Avaliação médica por videoconsulta em qualquer hora. O médico avalia os sintomas, decide se há indicação de antibiótico e prescreve o tratamento adequado.</p><a href="/">Marcar Consulta — 40€ →</a></div>

  <h2>Perguntas frequentes sobre dor de garganta e amigdalite</h2>

  <div class="faq"><h4>Como saber se a minha amigdalite é viral ou bacteriana?</h4><p>Não é possível saber com certeza apenas pelos sintomas. A presença de placas brancas nas amígdalas, febre alta, gânglios cervicais dolorosos e ausência de tosse e corrimento nasal sugere causa bacteriana, mas a confirmação requer avaliação médica e, idealmente, o teste de diagnóstico rápido para estreptococo.</p></div>
  <div class="faq"><h4>Posso tomar antibiótico sem ir ao médico?</h4><p>Não. Os antibióticos exigem prescrição médica e a sua utilização sem indicação clínica adequada não trata a infeção (se for viral), expõe a efeitos secundários desnecessários e contribui para o aumento de resistências bacterianas. A consulta por videoconsulta é uma alternativa rápida à consulta presencial.</p></div>
  <div class="faq"><h4>A amigdalite com placas precisa sempre de antibiótico?</h4><p>Não necessariamente. As placas podem ocorrer em infeções virais, incluindo a mononucleose. A decisão sobre o antibiótico depende da avaliação clínica global e, idealmente, do resultado do teste de diagnóstico rápido para estreptococo.</p></div>
  <div class="faq"><h4>Quanto tempo dura a amigdalite?</h4><p>A amigdalite viral resolve habitualmente em 5 a 7 dias com tratamento sintomático. A amigdalite bacteriana tratada com antibiótico adequado melhora geralmente em 24 a 48 horas após o início do antibiótico, embora o tratamento deva ser completado até ao fim dos 10 dias para evitar recidivas e complicações.</p></div>
  <div class="faq"><h4>Posso fazer a consulta de amigdalite por videoconsulta?</h4><p>Sim, na grande maioria dos casos de adultos. O médico avalia os sintomas por videoconsulta, pode observar a garganta em câmara e decide se há indicação de antibiótico. Se necessário, orienta para o teste de diagnóstico rápido numa farmácia próxima. Este serviço está disponível de segunda a domingo, das 9h às 21h.</p></div>
  <div class="faq"><h4>Tenho dificuldade em abrir a boca e a voz estranha. O que devo fazer?</h4><p>Estes são sinais de possível abcesso periamigdalino, uma complicação que requer tratamento hospitalar urgente. Dirija-se imediatamente às urgências. Não aguarde por uma consulta online nesta situação.</p></div>
  <div class="faq"><h4>Tenho alergia à amoxicilina. Qual o antibiótico alternativo?</h4><p>Em caso de alergia às penicilinas, o médico pode prescrever azitromicina durante 5 dias ou claritromicina durante 10 dias. A escolha deve ser feita pelo médico com base no historial clínico de cada pessoa.</p></div>
  <div class="faq"><h4>Apareceu-me uma erupção cutânea depois de tomar amoxicilina para a garganta. O que fazer?</h4><p>Interrompa o antibiótico e contacte o seu médico. Uma erupção cutânea após amoxicilina, especialmente numa amigdalite com gânglios muito volumosos e cansaço intenso, pode ser sinal de mononucleose infeciosa, situação em que a amoxicilina não está indicada.</p></div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Centor, R. M., Witherspoon, J. M., Dalton, H. P., et al. (1981). The diagnosis of strep throat in adults in the emergency room. <em>Medical Decision Making, 1</em>(3), 239-246. https://doi.org/10.1177/0272989X8100100304</li>
    <li>McIsaac, W. J., White, D., Tannenbaum, D., & Low, D. E. (1998). A clinical score to reduce unnecessary antibiotic use in patients with sore throat. <em>CMAJ, 158</em>(1), 75-83.</li>
    <li>Direção-Geral da Saúde. (2012, atualizada 2022). Norma n.º 007/2012: Utilização de antibióticos em infeções do trato respiratório inferior. DGS. https://www.dgs.pt</li>
    <li>Clínica Universidad de Navarra. (2025). <em>Amigdalite: diagnóstico e tratamento.</em> https://www.cun.es/pt/doencas-tratamentos/doencas/amigdalite</li>
    <li>Hospital Albert Einstein. (2022). <em>Guia do episódio de cuidado: Faringoamigdalite em adultos.</em> https://medicalsuite.einstein.br/pratica-medica/Pathways/Faringoamigdalite-em-adultos.pdf</li>
    <li>BMJ Best Practice. (2024). <em>Amigdalite: resumo, diagnóstico e tratamento.</em> https://bestpractice.bmj.com/topics/pt-br/598</li>
    <li>Servicio de Salud de Castilla y León. (2022). <em>Faringoamigdalitis aguda: guía terapéutica.</em> https://www.saludcastillayleon.es/portalmedicamento</li>
  </ol></div>

  `
},

'ozempic-glp1': {
  title: 'Como Atuam os Medicamentos Injetáveis para o Tratamento da Obesidade? | ConsultasOnline',
  description: 'Saiba como atuam os medicamentos injetáveis para o tratamento da obesidade, quais os efeitos, indicações e cuidados necessários.',
  keywords: 'medicamentos injetaveis obesidade portugal, glp-1 obesidade, agonistas glp-1, tratamento obesidade injetavel, semaglutido tirzepatido portugal',
    h1: 'Como Atuam os Medicamentos Injetáveis para o Tratamento da Obesidade?',
  content: `<div class="cta-top"><p>💉 Quer saber se é candidato a este tratamento? Consulta médica de obesidade por videoconsulta. <a href="/">Marcar consulta — 55€ →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p>A obesidade é uma doença crónica, complexa e multifatorial, reconhecida pela Organização Mundial de Saúde como uma das maiores emergências de saúde pública do século XXI. <a href="https://www.ine.pt/xportal/xmain?xpid=INE&xpgid=ine_destaques&DESTAQUESdest_boui=414434213&DESTAQUEStema=00&DESTAQUESmodo=2" target="_blank" style="color:var(--teal)">Em Portugal, dados do Inquérito Nacional de Saúde de 2019 indicam que cerca de 16,9% dos adultos apresentam obesidade e 36,6% têm excesso de peso, colocando o país entre os mais afetados da Europa Ocidental</a> (Instituto Nacional de Saúde Doutor Ricardo Jorge, 2020). Este facto faz com que haja elevado interesse nos novos medicamentos injetáveis para o tratamento da obesidade. Por isso, este guia será certamente útil para si ou para partilhar com quem tem excesso de peso ou é obeso!</p>

  <h2>Uma nova era no tratamento farmacológico da obesidade</h2>
  <p>Durante décadas, o arsenal farmacológico disponível para o tratamento da obesidade foi limitado, com eficácia modesta e perfis de segurança frequentemente problemáticos. A aprovação de uma nova classe de medicamentos injetáveis, os agonistas do recetor do péptido-1 semelhante ao glucagon (GLP-1) e os agonistas duplos GLP-1/GIP, representa a maior revolução no tratamento farmacológico da obesidade em mais de vinte anos.</p>
  <p>Portanto, estes medicamentos injetáveis utilizados no tratamento da obesidade atuam sobre hormonas envolvidas na regulação do apetite, da saciedade e do metabolismo. Alguns imitam a ação do GLP-1 e outros atuam simultaneamente sobre os recetores GLP-1 e GIP.</p>
  <p>Estes medicamentos não são uma solução definitiva nem uma alternativa ao estilo de vida saudável. São ferramentas clínicas com indicações precisas, contraindicações relevantes e um perfil de efeitos adversos que exige acompanhamento médico estruturado. Ou seja, a sua utilização depende sempre de indicação clínica e requer avaliação e acompanhamento por um profissional de saúde.</p>

  <h2>O que é a obesidade?</h2>
  <p>A obesidade é definida clinicamente como uma acumulação excessiva ou anormal de gordura corporal que representa um risco para a saúde. O índice de massa corporal (IMC), calculado dividindo o peso em quilogramas pelo quadrado da altura em metros, é o instrumento de triagem mais utilizado na prática clínica, apesar das limitações que partilhamos de seguida.</p>

    <h3><a href="https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html" target="_blank" style="color:var(--teal)">Classificação do IMC para adultos</a> (Centers for Disease Control and Prevention)</h3>
  <ul>
    <li><strong>IMC 18,5 a 24,9 kg/m²</strong> — peso normal, considerado saudável</li>
    <li><strong>IMC 25,0 a 29,9 kg/m²</strong> — excesso de peso (pré-obesidade)</li>
    <li><strong>IMC 30,0 a 34,9 kg/m²</strong> — obesidade grau I</li>
    <li><strong>IMC 35,0 a 39,9 kg/m²</strong> — obesidade grau II</li>
    <li><strong>IMC igual ou superior a 40,0 kg/m²</strong> — obesidade grau III (obesidade grave)</li>
  </ul>

  <h3>Limitações na avaliação pelo IMC</h3>
  <p>O IMC tem limitações importantes: não distingue massa gorda de massa muscular e não avalia a distribuição da gordura corporal. Além disso, pode subestimar o risco metabólico em indivíduos com obesidade central, mas IMC normal. Por isso, a avaliação clínica completa inclui a medição do perímetro abdominal, análises laboratoriais e avaliação de comorbilidades. Em adultos de origem europeia, valores de perímetro abdominal a partir de determinados limiares, frequentemente ≥94 cm nos homens e ≥80 cm nas mulheres, podem indicar aumento do risco cardiometabólico. Estes valores devem ser interpretados no contexto clínico e considerando a população de referência.</p>

  <h3>Comorbilidades associadas à obesidade</h3>
  <p>As comorbilidades mais frequentemente associadas à obesidade incluem: diabetes <em>mellitus</em> tipo 2, hipertensão arterial, dislipidemia, doença cardiovascular, síndrome de apneia obstrutiva do sono, doença hepática esteatótica associada à disfunção metabólica (MASLD), osteoartrite, determinados tipos de cancro e perturbações de saúde mental.</p>

  <h2>Fisiologia da saciedade e regulação do peso corporal</h2>
  <p>Para compreender como atuam os medicamentos injetáveis para a obesidade, é fundamental compreender os mecanismos fisiológicos que regulam o apetite, a saciedade e o peso corporal. Esta regulação é extraordinariamente complexa e envolve a interação de múltiplos sistemas hormonais, neurais e metabólicos.</p>

  <h3>O eixo intestino-cérebro</h3>
  <p>O trato gastrointestinal é o maior órgão endócrino do corpo humano, produzindo mais de 20 hormonas diferentes que comunicam com o cérebro para regular o comportamento alimentar. As principais hormonas envolvidas na regulação do apetite incluem:</p>
  <ul>
    <li><strong>Grelina:</strong> produzida principalmente pelo estômago, estimula o apetite e aumenta antes das refeições.</li>
    <li><strong>Leptina:</strong> produzida pelo tecido adiposo, sinaliza ao hipotálamo a quantidade de energia armazenada. Em indivíduos obesos, desenvolve-se frequentemente resistência à leptina.</li>
    <li><strong>Insulina:</strong> produzida pelo pâncreas, regula a glicemia e tem efeitos supressores do apetite ao nível do hipotálamo.</li>
    <li><strong>GLP-1 (péptido-1 semelhante ao glucagon):</strong> produzido pelas células L do intestino delgado em resposta à ingestão de alimentos, promove a saciedade, retarda o esvaziamento gástrico e estimula a secreção de insulina de forma dependente da glicose.</li>
    <li><strong>GIP (polipéptido insulinotrópico dependente da glicose):</strong> produzido pelas células K do intestino delgado, estimula a secreção de insulina e tem efeitos sobre o metabolismo lipídico.</li>
  </ul>

  <h3>O papel do hipotálamo</h3>
  <p>O hipotálamo é o principal centro de regulação do balanço energético no sistema nervoso central. Em indivíduos com obesidade, este sistema de regulação encontra-se frequentemente comprometido, com resistência a múltiplos sinais de saciedade e uma tendência para defender um peso corporal elevado mesmo perante restrição calórica. Este fenómeno, conhecido como "set point" do peso, explica em parte por que a perda de peso é difícil de manter a longo prazo apenas com dieta e exercício.</p>

  <h2>Medicamentos Injetáveis para o tratamento da Obesidade: como atuam os Agonistas do recetor GLP-1</h2>
  <p>Os agonistas do recetor GLP-1 (arGLP-1) são moléculas sintéticas que mimetizam a ação do GLP-1 endógeno, mas com uma semivida muito mais longa, permitindo administração semanal em vez da semivida de apenas alguns minutos do GLP-1 natural.</p>

  <h3>Efeitos pancreáticos</h3>
  <ul>
    <li>Como a estimulação da secreção de insulina é dependente da glicose, o risco de hipoglicemia é geralmente baixo quando estes medicamentos são utilizados isoladamente. O risco pode aumentar quando são associados a outros medicamentos que provocam hipoglicemia.</li>
    <li>Supressão da secreção de glucagon: reduz a libertação de glucagon pelo pâncreas, diminuindo a produção hepática de glicose.</li>
  </ul>

  <h3>Efeitos sobre o apetite e o peso</h3>
  <ul>
    <li>Supressão central do apetite: os recetores GLP-1 estão presentes em várias regiões cerebrais envolvidas na regulação do apetite, incluindo o hipotálamo e a área postrema.</li>
    <li>Atraso do esvaziamento gástrico: os arGLP-1 retardam o esvaziamento do estômago, prolongando a sensação de saciedade após as refeições.</li>
  </ul>

  <h3>Efeitos cardiovasculares</h3>
  <p>Os arGLP-1 demonstraram efeitos cardioprotetores significativos em ensaios clínicos de grandes dimensões. O ensaio LEADER, com mais de 9.000 participantes, <a href="https://pubmed.ncbi.nlm.nih.gov/28151519/" target="_blank" style="color:var(--teal)">demonstrou uma redução de 13% nos eventos cardiovasculares major com o liraglutido subcutâneo semanal versus placebo</a> (<a href="https://www.nejm.org/doi/full/10.1056/NEJMoa1603827" target="_blank" style="color:var(--teal)">Marso et al., 2016</a>). No ensaio SELECT, o semaglutido semanal <a href="https://www.nejm.org/doi/full/10.1056/NEJMoa2307563" target="_blank" style="color:var(--teal)">demonstrou uma redução de 20% nos eventos cardiovasculares major em indivíduos obesos sem diabetes</a> (Lincoff et al., 2023).</p>

  <h2>Medicamentos Injetáveis para o tratamento da Obesidade: Agonistas duplos GLP-1/GIP e a evolução terapêutica</h2>
  <p>A segunda geração de medicamentos injetáveis para a obesidade inclui moléculas que agonizam simultaneamente o recetor GLP-1 e o recetor GIP. Esta ação dupla confere uma eficácia superior na redução do peso corporal.</p>

  <h3>O papel do GIP no metabolismo</h3>
  <p>O GIP é produzido pelas células K do duodeno e do jejuno proximal em resposta à ingestão de nutrientes. Os seus efeitos metabólicos incluem estimulação da secreção de insulina, efeitos sobre o metabolismo lipídico e efeitos centrais sobre o apetite quando ativado farmacologicamente. A ação combinada sobre os recetores GLP-1 e GIP resulta numa sinergia que potencia os efeitos sobre a saciedade.</p>

  <h3>Eficácia clínica dos agonistas duplos</h3>
  <p>No ensaio <a href="https://www.nejm.org/doi/full/10.1056/NEJMoa2206038" target="_blank" style="color:var(--teal)">SURMOUNT-1</a> (Jastreboff et al., 2022), com 2.539 participantes sem diabetes, <a href="https://www.nejm.org/doi/full/10.1056/NEJMoa2206038" target="_blank" style="color:var(--teal)">o tirzepatido nas doses mais elevadas atingiu reduções médias do peso corporal de 20,9% (15 mg) e 19,5% (10 mg) às 72 semanas</a>, comparativamente a 3,1% no grupo placebo. Cerca de 57% dos participantes que receberam a dose mais elevada atingiram uma redução de peso superior a 20%, um resultado sem precedentes na história da farmacologia da obesidade.</p>

  <h2>Medicamentos Injetáveis no tratamento da Obesidade: o que dizem os estudos</h2>

  <h3>Programa STEP</h3>
  <ul>
    <li><strong>STEP 1</strong> (Wilding et al., 2021): 1.961 adultos. <a href="https://pubmed.ncbi.nlm.nih.gov/33567185/" target="_blank" style="color:var(--teal)">Redução média do peso de 14,9% com semaglutido vs. 2,4% com placebo às 68 semanas.</a></li>
    <li><strong>STEP 2</strong> (Davies et al., 2021): 1.210 adultos com diabetes tipo 2 e obesidade. <a href="https://pubmed.ncbi.nlm.nih.gov/33667417/" target="_blank" style="color:var(--teal)">Redução média de 9,6% com semaglutido vs. 3,4% com placebo.</a></li>
    <li><strong>STEP 3</strong> (Wadden et al., 2021): combinação com intervenção comportamental. <a href="https://jamanetwork.com/journals/jama/fullarticle/2777025" target="_blank" style="color:var(--teal)">Redução média de 16%.</a></li>
    <li><strong>STEP 4</strong> (Rubino et al., 2021): <a href="https://pubmed.ncbi.nlm.nih.gov/33755728/" target="_blank" style="color:var(--teal)">interrupção do tratamento resulta na recuperação de dois terços do peso perdido.</a></li>
    <li><strong>STEP 5</strong> (<a href="https://pubmed.ncbi.nlm.nih.gov/36216945/" target="_blank" style="color:var(--teal)">Garvey et al., 2022</a>): <a href="https://pubmed.ncbi.nlm.nih.gov/36216945/" target="_blank" style="color:var(--teal)">resultados a 104 semanas confirmam manutenção da perda de peso de 15,2%.</a></li>
  </ul>

  <h3>Comparação da eficácia entre classes</h3>
    <p>Uma metaanálise publicada na The Lancet (Shi et al., 2022), que analisou 143 ensaios clínicos randomizados envolvendo mais de 49.000 participantes, permitiu uma comparação sistemática:</p>
  <ul>
    <li><a href="https://pubmed.ncbi.nlm.nih.gov/38582569/" target="_blank" style="color:var(--teal)"><strong>Agonistas duplos GLP-1/GIP:</strong> maior eficácia disponível, com reduções de peso entre 15% e 21% dependendo da dose.</a></li>
    <li><a href="https://pubmed.ncbi.nlm.nih.gov/38582569/" target="_blank" style="color:var(--teal)"><strong>Agonistas do recetor GLP-1 (semaglutido subcutâneo 2,4 mg):</strong> reduções de 10% a 15%.</a></li>
    <li><a href="https://pubmed.ncbi.nlm.nih.gov/38582569/" target="_blank" style="color:var(--teal)"><strong>Medicamentos mais antigos (orlistato, bupropiona/naltrexona, liraglutido 3 mg):</strong> eficácia de 3% a 8%.</a></li>
  </ul>

  <h2>Tratamento da obesidade com medicamentos injetáveis — quem pode utilizar?</h2>
  <p>A seleção dos candidatos deve ser feita por um médico, com base na avaliação clínica individual. As indicações gerais, conforme estabelecido pelas agências reguladoras europeias e internacionais, são:</p>
  <ul>
    <li>IMC igual ou superior a 30 kg/m² (obesidade), independentemente da presença de comorbilidades.</li>
    <li>IMC igual ou superior a 27 kg/m² (excesso de peso) na presença de pelo menos uma comorbilidade relacionada com o peso, como diabetes tipo 2, hipertensão arterial, dislipidemia, apneia obstrutiva do sono, doença cardiovascular estabelecida ou esteatose hepática.</li>
    <li>Ter tentado previamente perder peso através de modificações do estilo de vida sem sucesso adequado.</li>
    <li>Não ter contraindicações conhecidas ao tratamento.</li>
  </ul>

  <h2>Contraindicações e precauções a ter em conta antes de iniciar o tratamento da obesidade</h2>

  <h3>Contraindicações absolutas à toma de medicamentos injetáveis para tratamento da obesidade</h3>
  <ul>
    <li>História pessoal ou familiar de carcinoma medular da tiróide.</li>
    <li>Síndrome de neoplasia endócrina múltipla tipo 2 (NEM2).</li>
    <li>Hipersensibilidade conhecida ao princípio ativo ou a qualquer excipiente.</li>
    <li>Gravidez: o tratamento deve ser interrompido pelo menos dois meses antes de uma gravidez planeada.</li>
    <li>Aleitamento materno.</li>
  </ul>

  <h3>Precauções com a toma de medicamentos para tratamento da obesidade</h3>
  <ul>
    <li>História de pancreatite aguda ou crónica.</li>
    <li>Doenças gastrointestinais graves, como gastroparesia ou doença inflamatória intestinal ativa.</li>
    <li>Doença renal crónica avançada: requer monitorização da função renal.</li>
    <li>Uso concomitante de sulfonilureias e insulina: pode ser necessário ajuste de dose.</li>
    <li>Retinopatia diabética: requer avaliação oftalmológica prévia.</li>
  </ul>

  <h2>Efeitos adversos: o que esperar dos medicamentos injetáveis para perda de peso</h2>

  <h3>Efeitos gastrointestinais</h3>
  <p>Os efeitos adversos mais frequentes são gastrointestinais e estão diretamente relacionados com o mecanismo de ação dos medicamentos, nomeadamente o atraso do esvaziamento gástrico.</p>
  <ul>
    <li>Náuseas: ocorrem em 40% a 50% dos doentes, especialmente no início do tratamento.</li>
    <li>Vómitos: menos frequentes, ocorrem em 15% a 25% dos doentes.</li>
    <li>Diarreia: reportada em 20% a 30% dos doentes.</li>
    <li>Obstipação: pode ocorrer em alguns doentes, particularmente com o tirzepatido.</li>
    <li>Dor abdominal e dispepsia: frequentes no início do tratamento.</li>
  </ul>
  <p>Na grande maioria dos doentes, estes efeitos são transitórios e vão diminuindo progressivamente. O aumento gradual da dose é a principal estratégia para minimizar estes efeitos.</p>

  <h3>Outros efeitos adversos relevantes</h3>
  <ul>
    <li>Perda de massa muscular: a perda de peso rápida pode incluir uma proporção significativa de massa muscular. O treino de resistência e ingestão proteica adequada são fundamentais.</li>
    <li>Litíase biliar: a perda de peso rápida aumenta o risco de formação de cálculos biliares.</li>
    <li>Taquicardia: foram reportados pequenos aumentos na frequência cardíaca (tipicamente 2 a 4 batimentos por minuto).</li>
    <li>Reações no local de injeção: dor, eritema e prurido locais, geralmente ligeiros e transitórios.</li>
  </ul>

  <h2>Prescrição, monitorização e acompanhamento médico no tratamento da obesidade</h2>
  <p>O tratamento exige acompanhamento médico regular. Avaliações recomendadas antes do início do tratamento:</p>
  <ul>
    <li>Avaliação clínica completa com história médica detalhada.</li>
    <li>Determinação do IMC e medição do perímetro abdominal.</li>
    <li>Análises laboratoriais: hemograma, glicemia em jejum, HbA1c, perfil lipídico, função renal, função hepática, função tiroideia.</li>
    <li>Avaliação cardiovascular e de comorbilidades relevantes.</li>
  </ul>
  <p>Durante o tratamento: monitorização do peso, pressão arterial e frequência cardíaca em cada consulta; análises de 3 em 3 a 6 meses; avaliação da tolerabilidade e ajuste de dose; suporte nutricional e de atividade física estruturado.</p>

  <h2>Contexto em Portugal: acesso e comparticipação</h2>
  <p>Em Portugal, os medicamentos injetáveis para a obesidade aprovados pela Agência Europeia do Medicamento (EMA) estão disponíveis, mas com importantes limitações no acesso através do Serviço Nacional de Saúde.</p>
  <p>Para a indicação de diabetes tipo 2, alguns destes medicamentos têm comparticipação do SNS, sujeita a critérios específicos. Para a indicação de obesidade sem diabetes, não existe atualmente comparticipação pelo SNS em Portugal.</p>
  <p>O custo mensal varia tipicamente entre 150 e 300 euros por mês. A prescrição exige avaliação médica prévia, que pode ser realizada por <a href="/artigos/consulta-online">videoconsulta</a>.</p>

  <h2>O futuro: próximas gerações de medicamentos</h2>
  <p>A investigação farmacológica no campo da obesidade está a avançar a um ritmo sem precedentes. Várias moléculas em fases avançadas de investigação clínica prometem eficácia ainda superior:</p>
  <ul>
    <li>Agonistas triplos GLP-1/GIP/glucagon (retratutido): atua simultaneamente em três recetores. Dados preliminares mostram reduções de peso superiores a 24%.</li>
    <li>Agonistas GLP-1/amilina: combinação que atua sobre a saciedade central e o controlo glicémico periférico.</li>
    <li>Formulações orais de arGLP-1: permitirão tratar doentes com relutância para a autoadministração de injeções.</li>
  </ul>

  <h2>Perguntas frequentes sobre medicamentos injetáveis para a perda de peso</h2>

  <div class="faq"><h4>Como atuam os medicamentos injetáveis para a obesidade?</h4><p>Os medicamentos injetáveis utilizados no tratamento da obesidade atuam sobre mecanismos envolvidos na regulação do apetite, da saciedade e do metabolismo. Os agonistas do recetor GLP-1 reproduzem alguns dos efeitos desta hormona intestinal, aumentando a saciedade, reduzindo o apetite e atrasando o esvaziamento gástrico. Existem também medicamentos que atuam simultaneamente nos recetores GLP-1 e GIP.</p></div>
  <div class="faq"><h4>Qual é a diferença entre GLP-1 e GLP-1/GIP?</h4><p>Os agonistas GLP-1 atuam principalmente sobre o recetor do GLP-1. Os agonistas duplos atuam simultaneamente nos recetores GLP-1 e GIP. Esta combinação interfere em diferentes mecanismos envolvidos na saciedade, secreção de insulina e metabolismo, podendo potenciar os efeitos sobre a redução do peso corporal.</p></div>
  <div class="faq"><h4>Quem pode fazer tratamento com medicamentos injetáveis para a obesidade?</h4><p>A indicação deve ser avaliada individualmente por um médico. De acordo com os critérios gerais, estes tratamentos podem ser considerados em adultos com IMC igual ou superior a 30 kg/m² ou com IMC igual ou superior a 27 kg/m² quando existe pelo menos uma condição relacionada com o excesso de peso, como hipertensão, diabetes tipo 2, dislipidemia ou apneia obstrutiva do sono.</p></div>
  <div class="faq"><h4>Quais são os efeitos adversos mais frequentes dos medicamentos GLP-1?</h4><p>Os efeitos adversos mais frequentes são gastrointestinais. Podem incluir náuseas, vómitos, diarreia, obstipação, dor abdominal e desconforto digestivo. Estes sintomas surgem sobretudo no início do tratamento e tendem a diminuir progressivamente em muitos doentes. O ajuste gradual da dose pode ajudar a melhorar a tolerabilidade.</p></div>
  <div class="faq"><h4>Quanto peso é possível perder com medicamentos GLP-1?</h4><p>A perda de peso varia de acordo com o medicamento, a dose, a duração do tratamento e as características individuais. Os ensaios clínicos mostram reduções médias de peso relevantes com alguns agonistas GLP-1 e agonistas duplos GLP-1/GIP, mas os resultados obtidos em estudos não permitem prever quanto peso uma pessoa específica irá perder.</p></div>
  <div class="faq"><h4>Quanto tempo é necessário tomar estes medicamentos?</h4><p>A duração do tratamento deve ser definida individualmente pelo médico. Como a obesidade é uma doença crónica, o controlo do peso pode exigir uma estratégia prolongada. A resposta ao tratamento, a tolerabilidade, as comorbilidades e a evolução clínica são fatores relevantes para decidir a continuidade ou alteração da terapêutica.</p></div>
  <div class="faq"><h4>Estes medicamentos causam dependência?</h4><p>Não. Não há evidência de dependência física ou psicológica. Ao interromper o tratamento, os mecanismos de regulação do apetite que foram suprimidos voltam a ser ativos, levando à recuperação do peso. Este fenómeno reflete a história natural da obesidade como doença crónica.</p></div>
  <div class="faq"><h4>Posso usar estes medicamentos apenas para perder alguns quilos sem ter obesidade?</h4><p>Não é recomendado. Estes medicamentos têm indicações específicas e um perfil de efeitos adversos que justificam o seu uso apenas quando o benefício clínico supera claramente os riscos.</p></div>
  <div class="faq"><h4>Posso fazer exercício físico durante o tratamento?</h4><p>Sim, e é fortemente recomendado. A atividade física, particularmente o treino de resistência, é fundamental para preservar a massa muscular durante a perda de peso.</p></div>
  <div class="faq"><h4>Estes medicamentos são seguros a longo prazo?</h4><p>Os dados de segurança disponíveis, abrangendo estudos de dois a cinco anos, são tranquilizadores. No entanto, a experiência clínica é ainda relativamente curta.</p></div>
  <div class="faq"><h4>É necessário acompanhamento médico durante o tratamento?</h4><p>Sim. O acompanhamento médico é essencial antes e durante o tratamento. A avaliação pode incluir história clínica, cálculo do IMC, determinação do perímetro abdominal, análises laboratoriais, avaliação cardiovascular e identificação de outras doenças. Durante o tratamento, podem ser monitorizados parâmetros como peso, pressão arterial, frequência cardíaca, tolerabilidade e resposta à terapêutica.</p></div>

  <h2>Medicamentos Injetáveis para o tratamento da Obesidade</h2>
  <p>Em suma, os medicamentos injetáveis para a obesidade representam um avanço terapêutico genuinamente significativo. A evidência acumulada demonstra de forma consistente que estas moléculas são eficazes na redução do peso corporal, na melhoria das comorbilidades metabólicas e na redução do risco cardiovascular.</p>
  <p>Contudo, estes medicamentos não são para todos. Têm indicações precisas, contraindicações relevantes e um custo significativo. O tratamento deve ser sempre iniciado e acompanhado por um médico, no contexto de uma abordagem abrangente que inclua modificações do estilo de vida.</p>

  <div class="art-cta"><h3>Quer saber se é candidato a este tratamento?</h3><p>Avaliação médica por videoconsulta, com análise do perfil de risco e indicações clínicas.</p><a href="/">Marcar Consulta de Obesidade →</a></div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Aronne, L. J., et al. (2024). Continued treatment with tirzepatide for maintenance of weight reduction in adults with obesity: The SURMOUNT-4 randomized clinical trial. <em>JAMA, 331</em>(1), 38-48. https://doi.org/10.1001/jama.2023.24945</li>
    <li>Davies, M., et al. (2021). Semaglutide 2.4 mg once a week in adults with overweight or obesity, and type 2 diabetes (STEP 2). <em>The Lancet, 397</em>(10278), 971-984. https://doi.org/10.1016/S0140-6736(21)00213-0</li>
    <li>Garvey, W. T., et al. (2022). Two-year effects of semaglutide in adults with overweight or obesity: The STEP 5 trial. <em>Nature Medicine, 28</em>(10), 2083-2091. https://doi.org/10.1038/s41591-022-02026-4</li>
    <li>Instituto Nacional de Saúde Doutor Ricardo Jorge. (2020). <em>Inquérito Nacional de Saúde 2019.</em> INSA.</li>
    <li>Jastreboff, A. M., et al. (2022). Tirzepatide once weekly for the treatment of obesity. <em>The New England Journal of Medicine, 387</em>(3), 205-216. https://doi.org/10.1056/NEJMoa2206038</li>
    <li>Lincoff, A. M., et al. (2023). Semaglutide and cardiovascular outcomes in obesity without diabetes. <em>The New England Journal of Medicine, 389</em>(24), 2221-2232. https://doi.org/10.1056/NEJMoa2307563</li>
    <li>Marso, S. P., et al. (2016). Liraglutide and cardiovascular outcomes in type 2 diabetes. <em>The New England Journal of Medicine, 375</em>(4), 311-322. https://doi.org/10.1056/NEJMoa1603827</li>
    <li>Rubino, D., et al. (2021). Effect of continued weekly subcutaneous semaglutide vs placebo on weight loss maintenance (STEP 4). <em>JAMA, 325</em>(14), 1414-1425. https://doi.org/10.1001/jama.2021.3224</li>
    <li>Shi, Q., et al. (2022). Pharmacotherapy for adults with overweight and obesity: A systematic review and network meta-analysis. <em>The Lancet, 399</em>(10321), 259-269. https://doi.org/10.1016/S0140-6736(21)01640-8</li>
    <li>Wadden, T. A., et al. (2021). Effect of subcutaneous semaglutide vs placebo as adjunct to intensive behavioral therapy (STEP 3). <em>JAMA, 325</em>(14), 1403-1413. https://doi.org/10.1001/jama.2021.1831</li>
    <li>Wilding, J. P. H., et al. (2021). Once-weekly semaglutide in adults with overweight or obesity. <em>The New England Journal of Medicine, 384</em>(11), 989-1002. https://doi.org/10.1056/NEJMoa2032183</li>
    <li>World Health Organization. (2024). Obesity and overweight. <em>WHO Fact Sheet.</em> https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight</li>
  </ol></div>

  <p style="font-size:12px;color:var(--muted);margin-top:16px;font-style:italic">Artigo revisto e atualizado por médico inscrito na Ordem dos Médicos. Para uso informativo. Não substitui consulta médica.</p>
  `
  },
'doencas-sexualmente-transmissiveis': {
  title: 'Infeções Sexualmente Transmissíveis (IST): rastreio, prevenção e tratamento | ConsultasOnline',
  description: 'Saiba tudo sobre as infeções sexualmente transmissíveis (IST): sintomas, transmissão, testes, prevenção e tratamento. Leia agora!',
  keywords:'infeções sexualmente transmissíveis, IST, clamídia, gonorreia, sífilis, VIH, HPV, herpes genital, hepatite B, hepatite C, rastreio IST Portugal',
  h1: 'Infeções Sexualmente Transmissíveis (IST): rastreio, prevenção e tratamento',
  content: `<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
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
  <p>A consulta de rastreio por <a href="/artigos/consulta-online">videoconsulta</a> permite ao médico avaliar o risco, prescrever as análises adequadas e interpretar os resultados, tudo sem deslocação física.</p>

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
  <p>O rastreio de IST por <a href="/artigos/consulta-online">videoconsulta</a> permite obter, na mesma consulta, a avaliação do risco individual, a prescrição das análises adequadas ao perfil de risco, a interpretação dos resultados e o tratamento quando indicado, tudo sem necessidade de deslocação física.</p>
  <p>Na ConsultasOnline, o rastreio de infeções sexualmente transmissíveis está disponível de segunda a domingo, das 9h às 21h, com fatura AT automática. O médico avalia o perfil de risco, prescreve o painel de análises adequado e acompanha na interpretação dos resultados.</p>
  <p>Em conclusão, as infeções sexualmente transmissíveis nem sempre provocam sintomas. Prevenção, vacinação quando disponível, utilização de preservativo e rastreio adequado ao risco continuam a ser ferramentas essenciais para proteger a saúde sexual.</p>

  <div class="art-cta"><h3>Teve uma exposição de risco ou quer fazer rastreio de IST?</h3><p>Avaliação médica por videoconsulta, sem deslocação. Prescrição de análises e interpretação de resultados.</p><a href="/">Marcar Rastreio de IST →</a></div>

  <h2>Perguntas frequentes sobre infeções sexualmente transmissíveis</h2>

  <div class="faq"><h4>Posso ter uma IST mesmo sem sintomas?</h4><p>Sim. Várias infeções sexualmente transmissíveis podem permanecer assintomáticas. Por isso, a ausência de sintomas não exclui uma infeção.</p></div>
  <div class="faq"><h4>Quanto tempo depois de uma relação devo fazer testes de IST?</h4><p>Depende da infeção e do teste utilizado. Algumas infeções podem ser identificadas mais cedo do que outras. Um profissional de saúde pode indicar o momento adequado em função da exposição.</p></div>
  <div class="faq"><h4>Um teste de sangue deteta todas as IST?</h4><p>Não. Algumas infeções sexualmente transmissíveis são pesquisadas através do sangue, enquanto outras podem exigir urina, zaragatoas ou colheita de lesões.</p></div>
  <div class="faq"><h4>O preservativo protege contra todas as infeções sexualmente transmissíveis?</h4><p>Reduz significativamente o risco de muitas IST, mas não oferece proteção total contra infeções transmitidas por contacto com pele ou lesões fora da zona coberta.</p></div>
  <div class="faq"><h4>É possível ter mais do que uma IST ao mesmo tempo?</h4><p>Sim. A presença de uma infeção sexualmente transmissível não impede a existência simultânea de outra. Em determinadas situações, o médico pode recomendar o rastreio de várias infeções.</p></div>
  <div class="faq"><h4>Uma pessoa com VIH e carga viral indetetável transmite o vírus sexualmente?</h4><p>Uma pessoa que mantém carga viral indetetável através de tratamento eficaz não transmite o VIH por via sexual. Este princípio é conhecido como Indetetável = Intransmissível (I=I).</p></div>
  <div class="faq"><h4>O HPV pode desaparecer sem tratamento?</h4><p>Muitas infeções por HPV tornam-se indetetáveis espontaneamente. Algumas infeções persistem e podem estar associadas a verrugas ou alterações celulares que exigem acompanhamento.</p></div>
  <div class="faq"><h4>A hepatite C tem cura?</h4><p>Atualmente existem tratamentos antivirais capazes de curar a grande maioria das infeções por hepatite C.</p></div>
  <div class="faq"><h4>Quando devo procurar avaliação médica com urgência?</h4><p>Procure avaliação adequada perante sintomas intensos, agravamento rápido, febre associada a dor pélvica ou testicular, gravidez com suspeita de IST, exposição recente ao VIH que possa justificar PEP ou outras situações que suscitem preocupação clínica.</p></div>

  <!-- GLOSSÁRIO -->
  <div id="glossario-ist" style="background:rgba(13,115,119,.06);border:1px solid rgba(13,115,119,.2);border-radius:12px;padding:18px 20px;margin:32px 0 24px">
    <h3 style="font-size:15px;font-weight:700;color:var(--teal);margin-bottom:12px">📖 Glossário: termos médicos explicados</h3>
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
  `
},

'cessacao-tabagica': {
  title: 'Como Parar de Fumar: Guia Médico Completo | ConsultasOnline',
  description: 'Vareniclina, bupropiona, TSN — os tratamentos com maior evidência para parar de fumar. Consulta com prescrição médica. 40€.',
  keywords: 'cessação tabágica online portugal, consulta parar fumar online, vareniclina prescrição online, champix online portugal',
  h1: 'Como Parar de Fumar: Guia Médico Completo sobre Tratamentos e Estratégias',
  content: `<div class='cta-top'><p>🚭 Pronto para deixar de fumar? Consulta com prescrição médica por <a href='/artigos/consulta-online'>videoconsulta</a>. <a href='/'>Marcar consulta — 40€ →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p>Parar de fumar é a decisão com maior impacto positivo na saúde que um fumador pode tomar, independentemente da idade, dos anos de consumo ou do número de cigarros por dia. Mas saber disso não chega. A dependência do tabaco é uma doença crónica com componentes físicos, psicológicos e comportamentais, e a tentativa de parar sem apoio médico tem taxas de sucesso muito baixas. Com o tratamento adequado, as probabilidades de sucesso aumentam de forma significativa.</p>
  <p>Este artigo explica porque é tão difícil parar de fumar, quais os medicamentos disponíveis em Portugal e a sua eficácia, o que é a síndrome de abstinência, como planear uma tentativa de cessação e como a consulta médica pode ser feita por <a href="https://www.consultas-online.pt/artigos/consulta-online" target="_blank" style="color:var(--teal);font-weight:600">videoconsulta</a>.</p>

  <h2>O tabagismo em Portugal: um problema de saúde pública</h2>
  <p>De acordo com o Inquérito Nacional de Saúde de 2019 e os dados do <a href="https://www.dgs.pt/programa-nacional-para-a-prevencao-e-controlo-do-tabagismo.aspx" target="_blank" style="color:var(--teal)">Programa Nacional para a Prevenção e Controlo do Tabagismo da DGS</a>, cerca de 17% da população portuguesa com 15 ou mais anos era fumadora, correspondendo a mais de 1,5 milhões de pessoas. O relatório do programa estima que, em 2019, <a href="https://www.noticiasaominuto.com/pais/2332174/santos-silva-recorda-promocao-da-saude-publica-em-dia-mundial-sem-tabaco" target="_blank" style="color:var(--teal)">mais de 13.500 pessoas morreram em Portugal por doenças atribuíveis ao tabaco</a>.</p>
  <p>O tabaco é a principal causa de morte evitável em Portugal e na Europa. As doenças diretamente relacionadas incluem o cancro do pulmão, a doença pulmonar obstrutiva crónica (DPOC), o enfarte do miocárdio, o acidente vascular cerebral, o cancro da bexiga, o cancro da laringe, o cancro do esófago e várias outras neoplasias. Não há dose segura de tabaco.</p>

  <h2>Porque é tão difícil parar de fumar?</h2>
  <p>A dificuldade em parar de fumar não é falta de vontade. É o resultado de uma dependência real, com componentes neurobiológicos bem estudados. A nicotina atua nos recetores nicotínicos do sistema nervoso central, estimulando a libertação de dopamina no núcleo accumbens, o centro de recompensa do cérebro. Este mecanismo é idêntico ao de outras substâncias com potencial aditivo elevado.</p>
  <p>Com o consumo regular, o cérebro adapta-se ao aporte contínuo de nicotina, reduzindo a sensibilidade dos seus próprios recetores. Quando o fumador tenta parar, a ausência de nicotina provoca a síndrome de abstinência, que torna a tentativa de cessação muito desconfortável.</p>

  <h3>Síndrome de abstinência nicotínica: o que esperar</h3>
  <p>Os sintomas de abstinência surgem nas primeiras horas após o último cigarro, atingem o pico nas primeiras 24 a 72 horas e diminuem progressivamente ao longo de 2 a 4 semanas. Incluem:</p>
  <ul>
    <li>Desejo intenso de fumar (<em>craving</em>)</li>
    <li>Irritabilidade, ansiedade e nervosismo</li>
    <li>Dificuldade de concentração</li>
    <li>Insónia ou sonos perturbados</li>
    <li>Aumento do apetite e ganho de peso</li>
    <li>Humor depressivo</li>
    <li>Cefaleias e tonturas</li>
    <li>Tosse transitória (mobilização de muco acumulado)</li>
  </ul>
  <p>Estes sintomas são temporários e diminuem progressivamente. Os medicamentos de cessação tabágica atuam precisamente sobre estes mecanismos, tornando os primeiros dias e semanas mais suportáveis.</p>

  <h2>Tratamentos para parar de fumar com evidência científica</h2>
  <p>Existe um conjunto de intervenções com evidência científica robusta para a cessação tabágica. A combinação de tratamento farmacológico com apoio comportamental (consultas de seguimento, aconselhamento, grupos de suporte) é a estratégia com maior taxa de sucesso.</p>

  <h3>1. Vareniclina (Champix)</h3>
  <p>A vareniclina é o medicamento com maior eficácia comprovada para a cessação tabágica. Atua como agonista parcial dos recetores nicotínicos alfa-4-beta-2, com dois efeitos simultâneos: reduz o desejo de fumar e atenua o prazer associado ao cigarro, tornando o tabaco menos satisfatório mesmo que o fumador ceda à tentação.</p>
  <p>A <a href="https://cochranelibrary.com/cdsr/doi/10.1002/14651858.CD006103.pub7/pt" target="_blank" style="color:var(--teal)">revisão Cochrane de 2023</a>, que incluiu 75 ensaios clínicos aleatorizados com mais de 45.000 participantes, concluiu que a vareniclina aumenta em duas a três vezes as probabilidades de cessação tabágica a longo prazo em comparação com tentativas sem medicação. A mesma revisão confirmou que a vareniclina é superior à bupropiona e à terapêutica de substituição nicotínica em monoterapia.</p>
  <p>O esquema terapêutico padrão tem a duração de 12 semanas, com possibilidade de extensão por mais 12 semanas para consolidar a abstinência. O tratamento começa uma semana antes da data escolhida para parar de fumar, com aumento gradual da dose. O principal efeito adverso são as náuseas, que diminuem com a toma após as refeições. Contraindicada na gravidez.</p>

  <h3>2. Terapêutica de Substituição Nicotínica (TSN)</h3>
  <p>A terapêutica de substituição nicotínica fornece nicotina ao organismo de uma forma controlada e sem os outros produtos tóxicos do tabaco, atenuando os sintomas de abstinência enquanto o fumador trabalha na componente comportamental da dependência. Está disponível em várias formas:</p>
  <ul>
    <li><strong>Adesivos transdérmicos:</strong> libertação lenta e contínua de nicotina ao longo de 16 ou 24 horas. Adequados para fumadores com dependência física significativa. Existem em diferentes doses (7, 14 e 21 mg) que devem ser ajustadas ao grau de consumo.</li>
    <li><strong>Pastilhas elásticas e pastilhas sublinguais:</strong> libertação rápida de nicotina para alívio de craving pontual. Devem ser usadas de forma intermitente e não mastigadas continuamente.</li>
    <li><strong>Inalador de nicotina:</strong> mimetiza o gesto de fumar, o que pode ser útil para fumadores com forte componente comportamental.</li>
    <li><strong>Spray nasal:</strong> libertação muito rápida de nicotina, com maior potencial aditivo.</li>
  </ul>
  <p>A <a href="https://www.cochrane.org/pt/node/9632" target="_blank" style="color:var(--teal)">combinação de adesivo com pastilha ou inalador de resgate é mais eficaz do que qualquer forma isolada de TSN</a>, de acordo com a Cochrane. Esta combinação pode ser tão eficaz quanto a vareniclina em alguns estudos.</p>
  <p>A TSN está disponível sem receita médica em farmácias em Portugal, mas a orientação médica sobre a dose adequada e a duração do tratamento melhora os resultados.</p>

  <h3>3. Bupropiona</h3>
  <p>A bupropiona é um antidepressivo que atua sobre os mecanismos dopaminérgicos e noradrenérgicos do sistema nervoso central, reduzindo o desejo de fumar e os sintomas de abstinência. Não contém nicotina. Está disponível em Portugal mediante prescrição médica.</p>
  <p>A sua eficácia é inferior à da vareniclina mas superior ao placebo. Pode ser uma opção particularmente útil em fumadores com depressão associada, dado o seu efeito antidepressivo. As contraindicações incluem epilepsia, história de convulsões, anorexia nervosa ou bulimia, e uso simultâneo de inibidores da MAO. O risco de convulsões é raro mas real.</p>

  <h3>4. Citisina</h3>
  <p>A citisina é um alcaloide natural extraído da planta <em>Cytisus laburnum</em>, que atua de forma semelhante à vareniclina nos recetores nicotínicos. <a href="https://www.cochrane.org/pt/node/9632" target="_blank" style="color:var(--teal)">A revisão Cochrane de 2023 concluiu que a citisina pode ser tão eficaz quanto a vareniclina</a>, com um perfil de segurança favorável. É amplamente usada na Europa Central e de Leste e está a ganhar reconhecimento internacional. Em Portugal, a sua disponibilidade pode ser limitada, pelo que deve ser discutida com o médico.</p>

  <h3>5. Combinação de tratamentos</h3>
  <p>A combinação de vareniclina com TSN, ou de diferentes formas de TSN, pode ser considerada em fumadores com dependência muito elevada ou em quem as tentativas anteriores com monoterapia falharam. A decisão sobre a combinação mais adequada deve ser tomada pelo médico com base no perfil de cada pessoa.</p>

  <h2>O que não funciona para parar de fumar</h2>
  <ul>
    <li><strong>Cigarros eletrónicos (vaping):</strong> não estão aprovados como método de cessação tabágica pelas autoridades regulatórias europeias. A evidência sobre a sua eficácia é inconsistente e a sua segurança a longo prazo não está estabelecida. O risco de dependência da nicotina mantém-se.</li>
    <li><strong>Acupuntura e hipnose:</strong> não há evidência científica robusta que suporte a sua eficácia como métodos de cessação tabágica.</li>
    <li><strong>Redução gradual sem data de paragem definida:</strong> a evidência sugere que parar de forma abrupta, com uma data definida, tende a ser mais eficaz do que a redução progressiva sem plano estruturado.</li>
  </ul>

  <h2>Como planear uma tentativa de cessação tabágica</h2>
  <p>O sucesso numa tentativa de parar de fumar depende em grande parte da preparação. Alguns passos que fazem diferença:</p>
  <ul>
    <li><strong>Escolher uma data para parar:</strong> idealmente dentro de 1 a 2 semanas, com tempo suficiente para iniciar o medicamento (no caso da vareniclina, o tratamento começa 1 semana antes da data de paragem).</li>
    <li><strong>Identificar os gatilhos:</strong> os momentos do dia, situações ou emoções que estão associados ao cigarro (o café da manhã, o stress, o carro, o álcool). Planear alternativas para esses momentos.</li>
    <li><strong>Remover o tabaco de casa e do carro:</strong> eliminar acessórios (isqueiros, cinzeiros) e avisar as pessoas próximas da decisão.</li>
    <li><strong>Ter apoio social:</strong> comunicar a decisão à família e amigos. O apoio do ambiente próximo aumenta as probabilidades de sucesso.</li>
    <li><strong>Planear a gestão do ganho de peso:</strong> é normal ganhar 2 a 4 kg nas primeiras semanas após parar de fumar, por aumento do apetite e melhoria do olfato e paladar. Planear atividade física e escolhas alimentares adequadas ajuda a mitigar este efeito.</li>
    <li><strong>Não desistir após uma recaída:</strong> a maioria dos fumadores necessita de várias tentativas antes de conseguir a abstinência prolongada. Uma recaída não é um fracasso definitivo, mas uma oportunidade de aprender o que correu mal.</li>
  </ul>

  <h2>Benefícios de parar de fumar ao longo do tempo</h2>
  <p>Os benefícios para a saúde começam muito mais cedo do que a maioria dos fumadores imagina:</p>
  <ul>
    <li><strong>20 minutos:</strong> a pressão arterial e a frequência cardíaca normalizam</li>
    <li><strong>8 horas:</strong> os níveis de monóxido de carbono no sangue normalizam e a oxigenação dos tecidos melhora</li>
    <li><strong>24 horas:</strong> o risco de enfarte do miocárdio começa a diminuir</li>
    <li><strong>48 horas:</strong> o olfato e o paladar começam a recuperar</li>
    <li><strong>2 semanas a 3 meses:</strong> a função pulmonar melhora e a circulação sanguínea recupera</li>
    <li><strong>1 a 9 meses:</strong> a tosse e a dispneia diminuem; os cílios brônquicos recuperam a sua função de limpeza</li>
    <li><strong>1 ano:</strong> o risco de doença coronária é reduzido para metade comparativamente a um fumador ativo</li>
    <li><strong>5 anos:</strong> o risco de acidente vascular cerebral aproxima-se ao de uma pessoa que nunca fumou</li>
    <li><strong>10 anos:</strong> o risco de cancro do pulmão é reduzido para cerca de metade do de um fumador</li>
    <li><strong>15 anos:</strong> o risco cardiovascular é semelhante ao de uma pessoa que nunca fumou</li>
  </ul>

  <h2>A consulta de cessação tabágica por videoconsulta</h2>
  <p>A consulta de cessação tabágica pode ser feita por <a href="https://www.consultas-online.pt/artigos/consulta-online" target="_blank" style="color:var(--teal);font-weight:600">videoconsulta</a>. Na consulta, o médico avalia o grau de dependência nicotínica (habitualmente com a escala de Fagerström), discute o historial de tentativas anteriores e os medicamentos eventualmente já usados, avalia contraindicações para cada um dos tratamentos disponíveis, e prescreve o medicamento mais adequado ao perfil de cada pessoa.</p>
  <p>Nas consultas de seguimento, também possíveis por <a href="https://www.consultas-online.pt/artigos/consulta-online" target="_blank" style="color:var(--teal);font-weight:600">videoconsulta</a>, são monitorizadas a adesão ao tratamento, as dificuldades encontradas e a necessidade de ajuste de dose ou mudança de estratégia.</p>

  <div class="art-cta"><h3>Pronto para parar de fumar?</h3><p>Consulta médica com avaliação do grau de dependência e prescrição do tratamento mais adequado. Disponível de segunda a domingo, das 9h às 21h.</p><a href="/">Marcar Consulta — 40€ →</a></div>

  <h2>Perguntas frequentes sobre cessação tabágica</h2>

  <div class="faq"><h4>Qual o medicamento mais eficaz para parar de fumar?</h4><p>De acordo com a revisão Cochrane de 2023, a vareniclina é o medicamento com maior eficácia individual para a cessação tabágica, aumentando em duas a três vezes as probabilidades de sucesso comparativamente a tentativas sem medicação. A combinação de diferentes formas de terapêutica de substituição nicotínica pode atingir eficácia semelhante.</p></div>
  <div class="faq"><h4>Posso obter receita para a vareniclina por videoconsulta?</h4><p>Sim. O médico avalia a história clínica, as tentativas anteriores e as contraindicações, e prescreve a vareniclina quando clinicamente adequado. A receita é enviada por email e pode ser aviada em qualquer farmácia.</p></div>
  <div class="faq"><h4>Quantas tentativas são necessárias para parar de fumar?</h4><p>A maioria das pessoas necessita de várias tentativas antes de conseguir a abstinência prolongada. Cada tentativa, mesmo que termine em recaída, fornece informação valiosa sobre os gatilhos e as dificuldades de cada pessoa. Uma recaída não é um fracasso definitivo.</p></div>
  <div class="faq"><h4>É normal ganhar peso ao parar de fumar?</h4><p>Sim, é frequente um aumento de peso de 2 a 4 kg nas primeiras semanas, por aumento do apetite e recuperação do paladar e olfato. Este aumento é significativamente inferior ao risco que o tabaco representa para a saúde. A prática de atividade física e escolhas alimentares equilibradas ajudam a controlar este efeito.</p></div>
  <div class="faq"><h4>Os cigarros eletrónicos ajudam a parar de fumar?</h4><p>Os cigarros eletrónicos não estão aprovados como método de cessação tabágica pelas autoridades regulatórias europeias. A evidência sobre a sua eficácia é inconsistente e a sua segurança a longo prazo não está estabelecida. Os medicamentos aprovados têm evidência científica muito mais robusta.</p></div>
  <div class="faq"><h4>A terapêutica de substituição nicotínica está disponível sem receita?</h4><p>Sim, os adesivos, pastilhas e inalador de nicotina estão disponíveis sem receita médica nas farmácias portuguesas. A orientação médica sobre a dose adequada e a duração do tratamento pode, contudo, melhorar os resultados.</p></div>
  <div class="faq"><h4>A vareniclina tem efeitos secundários graves?</h4><p>O efeito secundário mais frequente são as náuseas, que diminuem com a toma após as refeições. Podem também ocorrer sonhos vívidos e perturbações do sono. A revisão Cochrane de 2023 identificou um pequeno aumento de eventos adversos graves, mas estes continuam a ser raros e o benefício do tratamento supera claramente os riscos para a grande maioria das pessoas.</p></div>
  <div class="faq"><h4>Posso parar de fumar de repente ou devo reduzir gradualmente?</h4><p>A evidência disponível sugere que parar de forma abrupta numa data definida, com apoio farmacológico, tende a ser mais eficaz do que a redução progressiva sem plano estruturado. A chave é ter uma data clara e o tratamento adequado já iniciado.</p></div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Cahill, K., Lindson-Hawley, N., Thomas, K. H., Fanshawe, T. R., & Lancaster, T. (2016). Nicotine receptor partial agonists for smoking cessation. <em>Cochrane Database of Systematic Reviews.</em> https://doi.org/10.1002/14651858.CD006103.pub7</li>
    <li>Cochrane Library. (2023). Agonistas parciais do receptor de nicotina para cessação do tabagismo. Cochrane. https://www.cochrane.org/pt/node/9632</li>
    <li>Direção-Geral da Saúde. (2022). <em>Programa Nacional para a Prevenção e Controlo do Tabagismo.</em> DGS. https://www.dgs.pt/programa-nacional-para-a-prevencao-e-controlo-do-tabagismo.aspx</li>
    <li>Instituto Nacional de Saúde Doutor Ricardo Jorge. (2020). <em>Inquérito Nacional de Saúde 2019.</em> INSA. https://www.insa.min-saude.pt</li>
    <li>Notícias ao Minuto. (2023). Santos Silva recorda promoção da saúde pública em Dia Mundial sem Tabaco. https://www.noticiasaominuto.com/pais/2332174/santos-silva-recorda-promocao-da-saude-publica-em-dia-mundial-sem-tabaco</li>
    <li>Thomas, K. H., et al. Comparative clinical effectiveness and safety of tobacco cessation pharmacotherapies and electronic cigarettes: a systematic review and network meta-analysis. <em>University of Bath Research Portal.</em> https://researchportal.bath.ac.uk/en/publications/comparative-clinical-effectiveness-and-safety-of-tobacco-cessatio</li>
  </ol></div>
  `
},

'consulta-online': {
  title: 'Consulta Online em Portugal: O Guia Completo | ConsultasOnline',
  description: 'O que é, como funciona, quanto custa e o que pode tratar numa consulta médica online em Portugal.',
  keywords: 'consulta online portugal, como funciona consulta online, consulta médica online portugal guia, teleconsulta portugal',
  h1: 'Consulta Online em Portugal: Médico por Videochamada',
  content: `<div class="cta-top"><p>🩺 Precisa de consulta online hoje? Disponível de segunda a domingo, das 9h às 21h. <a href="/">Marcar consulta →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p>Fale com um médico por videochamada, sem sair de casa. Receba diagnóstico, receita eletrónica, baixa médica, atestados ou pedidos de exames, sempre que clinicamente indicado. Disponível de segunda a domingo, das 9h às 21h.</p>

  <h2>O que é uma consulta online?</h2>
  <p>A consulta online, também conhecida como teleconsulta ou consulta médica por videochamada, permite falar com um médico através da internet, com recurso a câmara, microfone e ligação segura.</p>
  <p>Em Portugal, a consulta online é uma modalidade legal e regulada. Pode ser usada para muitas situações de saúde do dia a dia, desde sintomas agudos a renovação de medicação crónica, sempre que o médico considere que o caso pode ser avaliado à distância.</p>
  <p>Desde a pandemia de COVID-19, a adesão à consulta médica online cresceu de forma significativa. Em Portugal, este modelo consolidou-se com base num enquadramento regulatório próprio, incluindo regras para a telemedicina, prescrição eletrónica e emissão de baixa médica por teleconsulta. O Decreto-Lei n.º 2/2024, de 5 de janeiro legalizou a emissão de baixa médica por teleconsulta, e o Regulamento de Telemedicina da Ordem dos Médicos (2020) definiu as regras éticas e técnicas aplicáveis a todos os médicos que exercem à distância.</p>
  <p>O resultado prático é simples: marcar uma consulta online hoje significa ter acesso a um médico licenciado, receber diagnóstico fundamentado, prescrição eletrónica válida em qualquer farmácia nacional e, se necessário, baixa médica enviada diretamente para a Segurança Social, tudo no mesmo dia.</p>

  <h2>Consulta online, teleconsulta e telemedicina: qual é a diferença?</h2>
  <p>Estes três termos aparecem muitas vezes juntos, mas não significam exatamente a mesma coisa.</p>
  <p><strong>Telemedicina</strong> é o conceito mais amplo. Inclui diagnóstico remoto, teledermatologia, acompanhamento de doentes crónicos, monitorização à distância e outras formas de prestação de cuidados médicos com apoio digital.</p>
  <p><strong>Teleconsulta</strong> é o ato clínico realizado entre médico e doente por meios digitais, como videochamada, chamada de voz ou mensagem segura. É o coração da telemedicina para o utilizador comum.</p>
  <p><strong>Consulta online</strong> é a designação mais usada pelos utilizadores em Portugal para se referirem à teleconsulta direta ao consumidor, através de plataformas como a Consultas-Online.pt.</p>

  <h2>Como funciona uma consulta médica online em Portugal?</h2>
  <p>Uma consulta médica online é simples, rápida e pensada para evitar deslocações desnecessárias. O processo pode ser feito em poucos passos.</p>

  <h3>1. Marcação online</h3>
  <p>Aceda à Consultas-Online.pt, escolha o tipo de consulta e selecione o horário mais conveniente. A marcação é feita online e pode ser concluída em poucos minutos. Na maioria dos casos irá marcar em menos de 2 minutos!</p>

  <h3>2. Preparação para a consulta</h3>
  <p>Antes da videochamada, é útil reunir a informação clínica mais importante:</p>
  <ul>
    <li>Medicamentos que toma habitualmente, incluindo nome, dosagem e frequência</li>
    <li>Alergias conhecidas a medicamentos ou substâncias</li>
    <li>Resultados recentes de análises ou exames relacionados com o motivo da consulta</li>
    <li>Histórico relevante, como cirurgias, internamentos ou doenças crónicas previamente diagnosticadas</li>
  </ul>
  <p>Esta preparação ajuda o médico a compreender melhor o caso e a tomar decisões clínicas mais seguras. E, obviamente, o tempo de consulta com o médico é totalmente focado na sua situação clínica que precisa de atenção naquele momento.</p>

  <h3>3. Videochamada com o médico</h3>
  <p>No horário marcado, recebe um link seguro por email. A consulta decorre por videochamada, com confidencialidade. O médico recolhe a história clínica, avalia os sintomas, faz perguntas relevantes e pode pedir-lhe que mostre determinada zona do corpo, quando isso for clinicamente útil. A duração média é de 15 a 30 minutos, dependendo da complexidade do caso.</p>

  <h3>4. Diagnóstico, receita e documentação</h3>
  <p>No final da consulta, o médico pode emitir a documentação necessária por via eletrónica, sempre que exista indicação clínica. Pode incluir:</p>
  <ul>
    <li>Receita eletrónica válida em farmácias portuguesas</li>
    <li>Baixa médica, também conhecida como Certificado de Incapacidade Temporária (enviada à Segurança Social no próprio dia)</li>
    <li>Pedido de análises ou exames complementares</li>
    <li>Atestado médico (amamentação, falta escolar, carta de condução, etc.)</li>
    <li>Declaração de doença para entidades externas</li>
  </ul>

  <h3>5. Receção por email</h3>
  <p>A documentação emitida é enviada por email. A fatura AT também é disponibilizada de forma automática. Não precisa de se deslocar a uma clínica, centro de saúde ou qualquer lugar, evitando perda de tempo e desconforto.</p>

  <h2>Experiência real: o que dizem os doentes</h2>
  <p>Uma das formas mais simples de perceber o valor da consulta médica online é ouvir quem já utilizou este serviço.</p>
  <div class="ibox"><div class="ibox-title">💬 Testemunho de um utente</div><p>"A consulta foi realizada através de uma videochamada. Eu estava com dores no corpo, febre e sem energia para me levantar ou deslocar-me. Fiquei surpreendido com o acompanhamento, por ser à distância, que foi muito atencioso e bem conduzido. A documentação foi corretamente processada e enviada."</p></div>
  <p>Este relato resume uma situação frequente: sintomas de gripe, febre, dores no corpo e falta de energia para sair de casa. Nestas situações, a consulta online pode ser uma solução prática, porque permite receber orientação médica, eventual prescrição e documentação sem deslocação física. Também reduz a exposição de outros utentes a possíveis infeções respiratórias.</p>
  <p>A distância física não elimina a dimensão humana do ato médico. Uma teleconsulta bem conduzida mantém a anamnese estruturada, a avaliação clínica fundamentada e a explicação clara do diagnóstico e do plano terapêutico.</p>

  <h2>O que se pode tratar numa consulta online?</h2>
  <p>A consulta online pode ser adequada para muitas situações clínicas de baixa ou média complexidade, desde que não existam sinais de alarme e o médico considere que a avaliação à distância é suficiente.</p>

  <h3>Doenças agudas do dia a dia</h3>
  <p>A teleconsulta pode ser útil em situações como:</p>
  <ul>
    <li>Gripe, constipação, faringite e amigdalite</li>
    <li>Infeção urinária</li>
    <li>Conjuntivite aguda</li>
    <li>Otite externa</li>
    <li>Gastroenterite aguda sem sinais de alarme</li>
    <li>Rinite alérgica, urticária e alergias sazonais</li>
    <li>Lesões cutâneas visíveis por câmara, como erupções, picadas de inseto ou dermatite de contacto</li>
  </ul>

  <h3>Doenças crónicas e renovação de medicação</h3>
  <p>A consulta online também pode ser usada para acompanhamento e renovação de medicação em doenças crónicas estáveis, como:</p>
  <ul>
    <li>Hipertensão arterial</li>
    <li>Dislipidemia</li>
    <li>Diabetes tipo 2</li>
    <li>Hipotiroidismo (ajuste de terapêutica após análises)</li>
    <li>Asma ou DPOC em fase estável</li>
    <li>Doenças psiquiátricas estabilizadas</li>
  </ul>
  <p>Nestes casos, o médico pode avaliar sintomas, rever análises, ajustar terapêutica e renovar medicação, quando clinicamente apropriado.</p>

  <h3>Saúde mental online</h3>
  <p>A teleconsulta pode ser particularmente útil em saúde mental, sobretudo quando o facto de o doente estar no seu ambiente familiar é facilitador de uma comunicação mais aberta. Pode incluir:</p>
  <ul>
    <li>Avaliação inicial de ansiedade, depressão ou burnout</li>
    <li>Acompanhamento psiquiátrico ou psicológico regular</li>
    <li>Terapia cognitivo-comportamental por videochamada</li>
    <li>Monitorização de sintomas e adesão terapêutica</li>
  </ul>

  <h3>Outros serviços disponíveis por consulta online</h3>
  <ul>
    <li><strong>Emissão ou renovação de baixa médica</strong> — com envio direto para a Segurança Social</li>
    <li><strong>Cessação tabágica</strong> — avaliação e prescrição de medicação ou terapêutica de substituição da nicotina</li>
    <li><strong>Rastreio de DST</strong> — pedido de análises confidencial, sem constrangimentos</li>
    <li><strong>Obesidade</strong> — avaliação, análises metabólicas e prescrição médica quando indicado</li>
    <li><strong>Saúde do viajante</strong> — profilaxia antipalúdica e conselhos pré-viagem</li>
    <li><strong>Atestados médicos</strong> — amamentação, falta escolar, carta de condução</li>
    <li><strong>Segundas opiniões e orientação clínica</strong></li>
  </ul>

  <h2>Quando a consulta online não é indicada?</h2>
  <p>A consulta online tem limites. Um serviço médico responsável deve reconhecê-los e encaminhar o doente para avaliação presencial sempre que necessário. A teleconsulta não é indicada em caso de:</p>
  <div class="ibox warn"><div class="ibox-title">⚠️ Situações que requerem avaliação presencial ou urgente</div>
  <ul>
    <li>Emergência médica — nestas situações, ligue 112. A teleconsulta não substitui o INEM</li>
    <li>Falta de ar intensa, dor no peito ou perda de consciência</li>
    <li>Sintomas neurológicos súbitos, como perda de força, alteração da fala ou assimetria facial</li>
    <li>Situações que exigem exame físico aprofundado: auscultação cardíaca, palpação abdominal, avaliação neurológica</li>
    <li>Procedimentos clínicos, como suturas, biópsias, infiltrações ou vacinação</li>
    <li>Crises psiquiátricas agudas com risco de autoagressão</li>
    <li>Patologias complexas que exijam imagiologia urgente ou eletrocardiograma</li>
  </ul></div>
  <p>A consulta online é uma solução complementar. Não substitui o INEM, as urgências hospitalares ou a observação presencial quando estas são necessárias. A consulta online tem limites que um bom médico sempre respeita.</p>

  <h2>A consulta online é comparticipada pelo SNS?</h2>
  <p>Na maioria das plataformas privadas, a consulta online não é comparticipada pelo SNS. No entanto, o valor pago é elegível para dedução de 15% no IRS como despesa de saúde, à semelhança de uma consulta médica privada presencial. É também recomendável verificar as condições da sua apólice de seguro de saúde, uma vez que alguns seguros já incluem cobertura para teleconsultas.</p>

  <h2>O que significa receber fatura AT?</h2>
  <p>A emissão de fatura AT é um sinal de transparência e conformidade fiscal. A fatura identifica a prestação do serviço e pode ser comunicada ao Portal das Finanças. Deve ser enviada por email juntamente com a documentação clínica aplicável. Ao escolher uma plataforma de consulta online, confirme se existe emissão de fatura e se os preços são apresentados de forma clara antes da marcação.</p>

  <h2>A consulta online em Portugal é legal e segura?</h2>
  <p>Sim. A consulta médica online em Portugal é legal, desde que seja realizada por médicos habilitados e em conformidade com as regras clínicas, deontológicas, legais e de proteção de dados. A segurança depende de vários fatores: identificação correta do médico e do doente, consentimento informado, registo clínico, confidencialidade, proteção dos dados pessoais e uso de plataformas adequadas.</p>

  <h3>Baixa médica por teleconsulta</h3>
  <p>Em Portugal, o Certificado de Incapacidade Temporária pode ser emitido após teleconsulta, quando o médico considera que existe justificação clínica. O Decreto-Lei n.º 2/2024, de 5 de janeiro é o diploma legal que estabelece que o CIT pode ser emitido após teleconsulta médica — foi o passo decisivo que equiparou, para efeitos legais e laborais, a consulta online à consulta presencial em Portugal. A baixa médica é enviada eletronicamente para a Segurança Social, evitando deslocações adicionais.</p>

  <h3>Regras da telemedicina</h3>
  <p>A prática da telemedicina exige os mesmos princípios éticos da consulta presencial. A Ordem dos Médicos, no Regulamento de Telemedicina (2020), definiu as obrigações éticas e técnicas de qualquer médico que pratique teleconsulta em Portugal. Entre os pontos essenciais estão:</p>
  <ul>
    <li>Identificação do médico e do doente antes de qualquer ato clínico</li>
    <li>Consentimento informado do doente para a realização da teleconsulta</li>
    <li>Registo clínico completo em processo individual do doente</li>
    <li>Relação médico-doente como pilar central, independentemente do meio digital utilizado</li>
    <li>Confidencialidade e proteção de dados clínicos garantidas</li>
    <li>Responsabilidade deontológica idêntica à da consulta presencial</li>
  </ul>

  <h3>RGPD e proteção dos dados de saúde</h3>
  <p>As plataformas de teleconsulta tratam dados de saúde, uma das categorias mais sensíveis de dados pessoais. Por isso, devem garantir proteção e encriptação dos dados armazenados em servidores preferencialmente na UE, acesso restrito a profissionais autorizados, cumprimento do RGPD com Encarregado de Proteção de Dados e política de privacidade clara, e direitos do titular dos dados incluindo acesso, correção e eliminação quando aplicável.</p>

  <h3>Quem fiscaliza?</h3>
  <p>A fiscalização pode envolver várias entidades, incluindo a Ordem dos Médicos, a Entidade Reguladora da Saúde e a Comissão Nacional de Proteção de Dados. Em caso de má prática, aplicam-se responsabilidades semelhantes às da consulta presencial.</p>

  <h2>Vantagens da consulta médica online</h2>
  <ul>
    <li><strong>Sem filas nem sala de espera</strong> — o tempo médio entre marcar e ser atendido é de poucas horas, por vezes minutos</li>
    <li><strong>Disponível todos os dias</strong> — de segunda a domingo, das 9h às 21h, incluindo fins de semana e feriados</li>
    <li><strong>Ideal quando está doente e sem forças</strong> — em casos de febre, dores no corpo ou mal-estar, a consulta chega até si</li>
    <li><strong>Menor risco de contágio</strong> — evita deslocações e contacto com outros doentes</li>
    <li><strong>Mais privacidade</strong> — útil para temas sensíveis como saúde mental, infeções sexualmente transmissíveis ou problemas urológicos e ginecológicos</li>
    <li><strong>Documentação enviada por email</strong> — receita, baixa médica, atestado ou pedido de exames quando clinicamente indicados</li>
    <li><strong>Poupança de tempo e custos indiretos</strong> — evita transporte, estacionamento, ausências prolongadas ao trabalho e deslocações desnecessárias</li>
  </ul>

  <h2>O que diz a ciência sobre a eficácia da teleconsulta?</h2>
  <p>A teleconsulta tem sido estudada em vários contextos clínicos. A evidência disponível mostra bons resultados em situações adequadas para avaliação à distância, sobretudo quando existe triagem correta.</p>

  <h3>Satisfação do doente</h3>
  <p>Vários estudos internacionais indicam que muitos doentes valorizam a conveniência, a redução do tempo de espera e a facilidade de comunicação com o médico. A satisfação tende a ser elevada quando o problema é adequado à avaliação remota e quando a consulta é bem conduzida.</p>

  <h3>Segurança clínica</h3>
  <p>Uma revisão sistemática publicada no British Medical Journal (2020) concluiu que, para condições de baixo risco avaliáveis à distância, a teleconsulta apresenta uma taxa de diagnóstico concordante com a consulta presencial superior a 85%, com taxas de eventos adversos comparáveis. A chave está na correta triagem dos casos, garantindo que apenas as situações passíveis de avaliação remota são geridas por teleconsulta.</p>

  <h3>Saúde mental: eficácia equivalente à terapia presencial</h3>
  <p>Uma metanálise publicada no Journal of Medical Internet Research (2021), analisando 32 ensaios clínicos controlados, concluiu que as intervenções psicoterapêuticas por videoconferência são equivalentes à terapia presencial para depressão major, ansiedade generalizada e stress pós-traumático.</p>

  <h3>Impacto económico: redução de custos sem perda de qualidade</h3>
  <p>Estudos realizados no NHS britânico e em sistemas de saúde escandinavos demonstraram que a integração da teleconsulta como alternativa complementar reduz os custos operacionais dos sistemas de saúde sem prejuízo da qualidade dos cuidados. A maior eficiência do tempo médico e a eliminação das deslocações dos doentes são os principais fatores de poupança.</p>

  <h2>Como escolher uma plataforma de consulta online segura em Portugal?</h2>
  <p>Nem todas as plataformas de teleconsulta oferecem o mesmo nível de segurança, transparência e qualidade clínica. Antes de marcar, verifique se a plataforma apresenta:</p>
  <ul>
    <li>Conformidade com o Regulamento de Telemedicina da Ordem dos Médicos</li>
    <li>Preços apresentados de forma transparente antes da marcação</li>
    <li>Emissão de fatura AT — sinal inequívoco de operação legal e transparente</li>
    <li>Política de privacidade acessível e cumprimento do RGPD</li>
    <li>Disponibilidade de documentação clínica</li>
    <li>Avaliações reais de utilizadores</li>
    <li>Encaminhamento para cuidados presenciais quando necessário</li>
    <li>Disponibilidade alargada, incluindo fins de semana</li>
  </ul>

  <h2>O futuro da consulta online em Portugal</h2>
  <p>A medicina digital está em expansão e a consulta online deverá continuar a crescer nos próximos anos.</p>

  <h3>Inteligência artificial como apoio ao diagnóstico</h3>
  <p>Ferramentas de inteligência artificial já começam a apoiar a triagem inicial, a recolha estruturada de sintomas e a análise de informação clínica. Em contextos experimentais, já é efetuado diagnóstico dermatológico e oftalmológico a partir de fotografias enviadas pelo doente. Estas ferramentas não substituirão o médico, mas podem tornar a consulta mais eficiente quando usadas com supervisão profissional.</p>

  <h3>Dispositivos de monitorização remota</h3>
  <p>Oxímetros conectados, tensiómetros digitais, glucómetros inteligentes e smartwatches com ECG estão a ampliar o âmbito clínico da teleconsulta. Em breve, o médico poderá aceder a dados biométricos objetivos em tempo real, sem que o doente saia de casa.</p>

  <h3>Integração com processos clínicos do SNS</h3>
  <p>A integração plena das plataformas de teleconsulta com o Processo Clínico Único do SNS é uma prioridade estratégica da saúde digital em Portugal. Quando bem implementada, esta ligação reduzirá a fragmentação, repetições e perda de informação clínica relevante.</p>

  <h2>Perguntas frequentes sobre consulta online em Portugal</h2>

  <div class="faq"><h4>A consulta online é legal em Portugal?</h4><p>Sim. A consulta online é legal em Portugal quando realizada por médicos habilitados e em conformidade com as regras clínicas, legais e de proteção de dados aplicáveis. Está enquadrada pelo Decreto-Lei n.º 2/2024, de 5 de janeiro e pelo Regulamento de Telemedicina da Ordem dos Médicos (2020).</p></div>
  <div class="faq"><h4>Posso obter baixa médica por teleconsulta?</h4><p>Sim. O médico pode emitir Certificado de Incapacidade Temporária após teleconsulta, quando existe indicação clínica. Desde a entrada em vigor do Decreto-Lei n.º 2/2024, de 5 de janeiro, a baixa é enviada diretamente para a Segurança Social no próprio dia da consulta.</p></div>
  <div class="faq"><h4>A receita médica online é válida nas farmácias?</h4><p>Sim. A receita eletrónica emitida por um médico inscrito na Ordem dos Médicos é válida em qualquer farmácia portuguesa.</p></div>
  <div class="faq"><h4>Quanto tempo demora uma consulta online?</h4><p>Em média, uma consulta online demora entre 15 e 30 minutos. Casos mais complexos podem exigir mais tempo.</p></div>
  <div class="faq"><h4>Preciso de câmara para fazer uma consulta online?</h4><p>A videochamada é a modalidade preferencial, porque permite uma avaliação mais completa. Algumas situações podem ser geridas por chamada de voz ou mensagem segura, a critério médico.</p></div>
  <div class="faq"><h4>A consulta online é comparticipada pelo SNS?</h4><p>Em plataformas privadas, geralmente não. No entanto, o valor é dedutível em IRS como despesa de saúde. Alguns seguros privados também já comparticipam teleconsultas.</p></div>
  <div class="faq"><h4>Os meus dados clínicos estão seguros?</h4><p>Sim, desde que escolha uma plataforma em conformidade com o RGPD. Os dados de saúde são a categoria mais protegida pela legislação europeia. A plataforma deve encriptar os dados, restringir o acesso e disponibilizar uma política de privacidade clara.</p></div>
  <div class="faq"><h4>Posso fazer consulta online ao fim de semana?</h4><p>Sim. A Consultas-Online.pt está disponível de segunda a domingo, das 9h às 21h, incluindo fins de semana e feriados.</p></div>
  <div class="faq"><h4>A consulta online substitui completamente a consulta presencial?</h4><p>Não. A consulta online é uma solução complementar e eficaz para muitas situações do dia a dia, mas há casos que exigem exame físico, exames presenciais, procedimentos ou urgência hospitalar. Um bom médico de teleconsulta sabe sempre quando encaminhar.</p></div>

  <div class="art-cta"><h3>Precisa de falar com um médico hoje?</h3><p>Marque a sua consulta online e receba apoio médico sem sair de casa. Disponível de segunda a domingo, das 9h às 21h, com fatura AT automática e médicos inscritos na Ordem dos Médicos.</p><a href="/">Marcar Consulta Online →</a></div>

  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>Decreto-Lei n.º 2/2024, de 5 de janeiro. <em>Diário da República, 1.ª série.</em> Disponível em: dre.pt</li>
    <li>Ordem dos Médicos. <em>Regulamento de Telemedicina.</em> Lisboa, 2020. Disponível em: ordemdosmedicos.pt</li>
    <li>Regulamento (UE) 2016/679 do Parlamento Europeu e do Conselho, de 27 de abril de 2016 (RGPD). <em>Jornal Oficial da União Europeia,</em> L 119, pp. 1–88.</li>
    <li>Greenhalgh, T., et al. (2020). Video consultations for covid-19. <em>BMJ,</em> 368, m998.</li>
    <li>Revisão sistemática sobre teleconsulta em cuidados primários. <em>British Medical Journal,</em> 2020, vol. 371.</li>
    <li>Lieneck, C., et al. (2020). Rapid Telehealth Implementation during the COVID-19 Global Pandemic. <em>Healthcare,</em> 8(4), 517.</li>
    <li>Bashshur, R. L., et al. (2016). The Empirical Foundations of Telemedicine Interventions in Primary Care. <em>Telemedicine and e-Health,</em> 22(5), 342–375.</li>
    <li>Carlbring, P., et al. (2018). Internet-based vs. face-to-face cognitive behavior therapy. <em>Cognitive Behaviour Therapy,</em> 47(1), 1–18.</li>
    <li>WHO. (2019). <em>Recommendations on Digital Interventions for Health System Strengthening.</em> Geneva.</li>
    <li>Koonin, L. M., et al. (2020). Trends in the Use of Telehealth — United States. <em>MMWR,</em> 69(43), 1595–1599.</li>
    <li>CNPD. (2021). <em>Guia sobre a proteção de dados pessoais de saúde.</em> Lisboa. Disponível em: cnpd.pt</li>
    <li>ERS. (2019). <em>Estudo sobre o acesso aos cuidados de saúde primários do SNS.</em> Lisboa.</li>
    <li>Pordata. (2023). <em>Médicos por 1000 habitantes em Portugal.</em> Fundação Francisco Manuel dos Santos. Disponível em: pordata.pt</li>
  </ol></div>
  `
},

'medico-online': {
  title: 'Médico Online em Portugal: Como Funciona | ConsultasOnline',
  description: 'Vantagens do médico online, o que pode pedir, segurança e sigilo médico. Como escolher uma plataforma de confiança.',
  keywords: 'médico online portugal, médico online videoconsulta, médico online mbway portugal, teleconsulta médico portugal',
  h1: 'Médico Online em Portugal: Fale com um Médico Hoje, Sem Sair de Casa',
  content: `<div class="cta-top"><p>👨‍⚕️ Precisa de médico online? Disponível de segunda a domingo, das 9h às 21h. <a href="/">Marcar consulta →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p>Um <strong>médico online</strong> é um médico inscrito na Ordem dos Médicos que realiza consultas à distância, normalmente por videochamada. A consulta pode permitir avaliação clínica, orientação médica, prescrição eletrónica, emissão de baixa médica ou atestado, sempre que o médico tenha informação clínica suficiente e a situação seja adequada a teleconsulta.</p>

  <h2>Médico online ou médico no centro de saúde ou clínica?</h2>
  <p>Um médico online é um profissional licenciado e inscrito na Ordem dos Médicos que presta cuidados de saúde através de meios digitais seguros, como videochamada.</p>
  <p>A principal diferença face à consulta presencial é o formato. Em vez de se deslocar a uma clínica ou centro de saúde, fala com o médico através do computador, telemóvel ou tablet.</p>
  <p>Durante a <a href="/artigos/consulta-online">consulta</a>, o médico avalia os sintomas, recolhe a história clínica, analisa informação enviada pelo doente e decide se existem condições para emitir uma recomendação, prescrição ou documento clínico.</p>
  <p>Quando a informação disponível não é suficiente, o médico pode pedir dados adicionais ou recomendar uma consulta presencial. A Ordem dos Médicos sublinha que, em telemedicina, o médico só deve tomar decisões se a informação recebida for suficiente e relevante.</p>

  <h2>Os médicos online são realmente médicos?</h2>
  <p>Esta é uma preocupação legítima e a resposta é inequívoca: <strong>sim, todos os médicos que praticam teleconsulta em Portugal através de plataformas legítimas são médicos licenciados, inscritos e em situação regular na Ordem dos Médicos.</strong></p>

  <h2>O que exige a lei para as consultas online?</h2>
  <p>O Regulamento de Telemedicina da <a href="https://www.ordemdosmedicos.pt" target="_blank" style="color:var(--teal)">Ordem dos Médicos</a> (2020) estabelece que qualquer profissional que realize teleconsultas em Portugal deve:</p>
  <ul>
    <li>Estar inscrito na Ordem dos Médicos e ter a cédula profissional ativa</li>
    <li>Identificar-se ao doente no início de cada consulta</li>
    <li>Respeitar integralmente o Código Deontológico médico, independentemente do meio utilizado</li>
    <li>Garantir a existência de processo clínico individual para cada doente</li>
    <li>Ter capacidade técnica para reconhecer quando a situação clínica requer encaminhamento presencial</li>
  </ul>

  <h2>Como verificar se um médico online é legítimo?</h2>
  <p>Antes de consultar qualquer plataforma de médico online, o utilizador pode verificar:</p>
  <ul>
    <li>Consultar o Registo Médico da <a href="https://www.ordemdosmedicos.pt" target="_blank" style="color:var(--teal)">Ordem dos Médicos</a>, onde é possível confirmar o nome, especialidade e situação profissional de qualquer médico</li>
    <li>Confirmar que a plataforma emite fatura AT: sinal de operação legal e tributariamente transparente</li>
    <li>Verificar se a plataforma apresenta política de privacidade em conformidade com o <a href="https://eur-lex.europa.eu/PT/legal-content/summary/general-data-protection-regulation-gdpr.html" target="_blank" style="color:var(--teal)">RGPD</a> e os dados de contacto do Encarregado de Proteção de Dados</li>
    <li>Pesquisar avaliações de outros utilizadores em fontes independentes (Google, Trustpilot, redes sociais)</li>
  </ul>

  <h2>Quais as especialidades disponíveis online?</h2>
  <p>Em Portugal, as especialidades mais frequentemente disponíveis em plataformas de médico online incluem:</p>
  <ul>
    <li><strong>Medicina Geral e Familiar</strong> — a especialidade de base para a maioria das queixas do dia a dia</li>
    <li><strong>Psiquiatria</strong> — acompanhamento e prescrição em doenças mentais estabilizadas</li>
    <li><strong>Dermatologia</strong> — avaliação de lesões cutâneas por fotografia ou vídeo</li>
    <li><strong>Endocrinologia</strong> — controlo de diabetes, tiróide e obesidade</li>
    <li><strong>Medicina Interna</strong> — gestão de doenças crónicas complexas</li>
    <li><strong>Ginecologia</strong> — acompanhamento de dúvidas, resultados e prescrições não invasivas</li>
    <li><strong>Urologia</strong> — avaliação de sintomas e orientação clínica</li>
    <li><strong>Saúde Ocupacional</strong> — atestados e certificados laborais</li>
  </ul>

  <h2>Quando faz sentido consultar um médico online?</h2>
  <p>A <a href="/artigos/consulta-online">consulta médica online</a> pode ser útil para situações que não exigem observação presencial imediata. Pode ser uma opção para:</p>
  <ul>
    <li>Sintomas ligeiros ou moderados</li>
    <li>Renovação de medicação, quando clinicamente adequada</li>
    <li>Avaliação inicial de queixas recentes</li>
    <li>Pedido de receita médica</li>
    <li>Pedido de baixa médica, quando justificado</li>
    <li>Atestados médicos, quando aplicável</li>
    <li>Esclarecimento de dúvidas clínicas</li>
    <li>Acompanhamento de situações já conhecidas</li>
    <li>Orientação sobre necessidade de consulta presencial</li>
  </ul>
  <p>A teleconsulta não substitui todas as consultas presenciais. Deve ser usada quando o médico consegue avaliar o caso com segurança à distância.</p>

  <h2>O médico online pode passar receita?</h2>
  <p>Sim. Um médico inscrito na Ordem dos Médicos pode emitir prescrição eletrónica quando, após avaliação clínica, considera que existe indicação médica. A receita pode depois ser utilizada numa farmácia em Portugal, de acordo com as regras aplicáveis à prescrição eletrónica.</p>

  <h2>O médico online pode passar baixa médica?</h2>
  <p>Sim, pode existir emissão de Certificado de Incapacidade Temporária por consulta não presencial, desde que o médico tenha condições clínicas para avaliar o caso. Um parecer jurídico da Ordem dos Médicos, de 29 de novembro de 2024, refere que não há impedimento legal à emissão de CIT por consulta não presencial, mas reforça a responsabilidade do médico na avaliação concreta do doente.</p>
  <p>Isto significa que a baixa médica não é automática. Depende sempre da avaliação clínica.</p>

  <div class="ibox"><div class="ibox-title">💬 As perguntas mais frequentes</div><p>"A minha consulta é confidencial?" <em>"Os meus dados de saúde estão seguros?"</em> São as duas perguntas mais frequentes de quem usa o médico online pela primeira vez. A resposta a ambas é sim!</p></div>

  <h2>A consulta com médico online é confidencial?</h2>
  <p>Sim. O sigilo médico aplica-se à consulta online tal como à consulta presencial.</p>
  <p>O sigilo médico é um dos pilares do exercício da medicina em Portugal, consagrado no Código Deontológico da Ordem dos Médicos. Este dever aplica-se integralmente à teleconsulta: o médico online está legal e eticamente proibido de partilhar qualquer informação clínica do doente com terceiros sem o seu consentimento expresso, com as exceções legalmente previstas (obrigação de denúncia de certas doenças, situações de risco de vida imediato, entre outras).</p>
  <p>As consultas por videochamada decorrem em salas virtuais privadas, não são gravadas e não ficam acessíveis a terceiros. O médico é o único com acesso ao registo clínico da consulta.</p>

  <h2>Os meus dados ficam protegidos numa consulta online?</h2>
  <p>Os dados de saúde são dados sensíveis e devem ser tratados com medidas reforçadas de proteção. A plataforma deve explicar como recolhe, utiliza, conserva e protege a informação clínica.</p>
  <p>Por isso, antes da consulta, confirme se a plataforma apresenta política de privacidade, contactos da entidade responsável e condições claras de utilização.</p>

  <h2>Proteção de dados: o quadro legal aplicável</h2>
  <p>Os dados de saúde são classificados pelo Regulamento Geral sobre a Proteção de Dados (<a href="https://eur-lex.europa.eu/PT/legal-content/summary/general-data-protection-regulation-gdpr.html" target="_blank" style="color:var(--teal)">RGPD</a> — Regulamento UE 2016/679) como <strong>"dados de categorias especiais"</strong> — a categoria mais protegida da legislação europeia. Qualquer plataforma que trate dados de saúde de cidadãos portugueses está obrigada a cumprir requisitos rigorosos:</p>
  <ul>
    <li>Armazenamento em servidores, preferencialmente localizados na União Europeia</li>
    <li>Acesso restrito a profissionais de saúde com necessidade legítima de acesso</li>
    <li>Conservação dos dados pelo período mínimo legalmente obrigatório e eliminação segura após esse prazo</li>
    <li>Nomeação de um Encarregado de Proteção de Dados (EPD) e disponibilização de política de privacidade clara</li>
    <li>Registo das atividades de tratamento de dados na CNPD (Comissão Nacional de Proteção de Dados)</li>
    <li>Direito do doente a aceder, retificar e solicitar a eliminação dos seus dados pessoais</li>
  </ul>

  <h2>Quais as vantagens de falar com um médico online?</h2>
  <p>A consulta online pode ser útil quando precisa de orientação médica rápida e não quer ou não pode deslocar-se. As principais vantagens são:</p>

  <h3>1. Consulta sem deslocações</h3>
  <p>Pode falar com um médico a partir de casa, do trabalho ou de outro local privado.</p>

  <h3>2. Disponibilidade no próprio dia</h3>
  <p>Permite obter orientação médica mais rapidamente, quando há vaga disponível.</p>

  <h3>3. Horário alargado</h3>
  <p>Na Consultas-Online.pt, o serviço está disponível de segunda a domingo, das 9h às 21h.</p>

  <h3>4. Documentos por via digital</h3>
  <p>Receitas, baixas médicas e atestados podem ser enviados por via digital, quando clinicamente indicados.</p>

  <h3>5. Mais privacidade</h3>
  <p>Alguns temas de saúde são mais fáceis de abordar num ambiente familiar e reservado.</p>

  <h2>Porque cada vez mais o médico online é uma solução procurada?</h2>
  <p>O crescimento da procura por médico online em Portugal não é uma moda: é uma resposta racional a constrangimentos reais do sistema de saúde. Eis as razões mais apontadas pelos utilizadores:</p>

  <h3>Ausência de médico de família atribuído</h3>
  <p>Portugal enfrenta uma crise significativa na disponibilidade de médicos de família no SNS. <strong>Segundo dados da PORDATA (2023), mais de <a href="https://www.pordata.pt/portugal/medicos+e+outro+pessoal+de+saude+por+100+mil+habitantes-639" target="_blank" style="color:var(--teal)">1,5 milhões de portugueses não têm médico de família atribuído</a>.</strong> Para este grupo, o médico online é frequentemente a única forma de aceder a cuidados médicos sem recorrer às urgências hospitalares.</p>

  <h3>Tempos de espera incompatíveis com a urgência da situação</h3>
  <p>Mesmo quem tem médico de família pode aguardar dias ou semanas por uma consulta para uma situação que necessita de avaliação no próprio dia. O médico online resolve esta lacuna: consulta no mesmo dia, ao horário escolhido, sem filas de espera.</p>

  <h3>Mobilidade reduzida e dificuldades de deslocação</h3>
  <p>Idosos, doentes com mobilidade reduzida, pessoas a cuidar de dependentes, residentes em zonas rurais com fraca cobertura de transportes públicos: todos estes grupos beneficiam de forma especialmente significativa da disponibilidade de um médico online que dispensa a deslocação.</p>

  <h3>Privacidade para assuntos sensíveis</h3>
  <p>Determinadas questões de saúde (saúde mental, saúde sexual, dependências, problemas urológicos ou ginecológicos) são mais facilmente abordadas num ambiente privado e familiar do que num consultório. A teleconsulta elimina o constrangimento da sala de espera e facilita uma comunicação mais aberta entre médico e doente.</p>

  <h3>Continuidade de cuidados em mobilidade</h3>
  <p>Viajantes, emigrantes portugueses no estrangeiro (que podem necessitar de documentação clínica portuguesa) e trabalhadores deslocados encontram no médico online uma forma de manter a continuidade dos seus cuidados de saúde sem dependência geográfica.</p>

  <h3>Rapidez e eficiência administrativa</h3>
  <p>Receita, baixa médica, atestado entregues por email no próprio dia da consulta. Sem filas no centro de saúde, sem formulários em papel, sem necessidade de se ausentar do trabalho para tratar de burocracia médica.</p>

  <h2>Quando não deve usar um médico online?</h2>
  <p>Não deve recorrer a uma consulta online em situações de emergência.</p>
  <div class="ibox danger"><div class="ibox-title">🚨 Ligue 112 ou dirija-se a uma urgência se tiver</div>
  <ul>
    <li>Dor no peito</li>
    <li>Falta de ar intensa</li>
    <li>Sinais de AVC</li>
    <li>Perda de consciência</li>
    <li>Hemorragia grave</li>
    <li>Reação alérgica grave</li>
    <li>Acidente ou traumatismo importante</li>
    <li>Dor súbita e intensa</li>
    <li>Agravamento rápido do estado geral</li>
  </ul></div>
  <p>A consulta médica online é indicada para situações compatíveis com avaliação remota. Não é adequada quando é necessário exame físico imediato ou intervenção urgente.</p>

  <h2>Como escolher o melhor médico online em Portugal?</h2>
  <p>Antes de realizar consulta, verifique estes critérios:</p>
  <ul>
    <li><strong>Médicos inscritos na Ordem dos Médicos</strong> — confirme que os profissionais têm habilitação adequada visitando o site da Ordem dos Médicos se não tem informação suficiente sobre o profissional de saúde com quem vai realizar a consulta</li>
    <li><strong>Informação clara sobre preços</strong> — o valor da consulta deve ser apresentado antes da marcação</li>
    <li><strong>Política de privacidade visível</strong> — a plataforma deve explicar como protege os seus dados</li>
    <li><strong>Disponibilidade alargada</strong> — idealmente 7 dias por semana, com horários que incluam fins de semana e feriados</li>
    <li><strong>Emissão de fatura</strong> — a emissão de fatura reforça transparência e conformidade</li>
    <li><strong>Explicação das limitações clínicas</strong> — o serviço deve indicar quando a teleconsulta não é adequada</li>
    <li><strong>Encaminhamento quando necessário</strong> — o médico deve poder recomendar consulta presencial ou urgência</li>
    <li><strong>Plataforma estável e apoio técnico</strong> — plataforma técnica estável, com videochamada e suporte em caso de falha de conectividade</li>
    <li><strong>Avaliações reais de utentes</strong> — as opiniões externas ajudam a avaliar a experiência do serviço, em fontes independentes e verificáveis</li>
  </ul>

  <h2>Perguntas frequentes sobre médico online em Portugal</h2>

  <h3>1. Credenciais, segurança e legitimidade</h3>

  <div class="faq"><h4>Os médicos online são médicos reais?</h4><p>Sim. Numa plataforma legítima, os médicos devem estar inscritos e em situação regular na Ordem dos Médicos. Antes de marcar uma consulta médica online, confirme: se a plataforma identifica a entidade prestadora; se os médicos estão inscritos na Ordem dos Médicos; se existe política de privacidade clara; se há informação transparente sobre preços; se existe emissão de fatura; se o serviço explica as limitações da teleconsulta; se há encaminhamento presencial quando necessário.<br/><br/>A ERS indica que a publicidade em saúde deve identificar devidamente a entidade ou profissional, bem como fornecer informação essencial ao utente, incluindo elementos como cédula profissional, atos abrangidos, preço total e eventuais restrições.</p></div>
  <div class="faq"><h4>Como funciona o sigilo médico numa consulta online?</h4><p>O sigilo médico aplica-se integralmente à teleconsulta, exatamente como na consulta presencial. A videochamada decorre em sala virtual privada, não é gravada e o conteúdo clínico está protegido pelo Código Deontológico da Ordem dos Médicos e pelo RGPD. O médico está legalmente proibido de partilhar qualquer informação clínica sem consentimento expresso do doente, salvo exceções legalmente previstas.</p></div>
  <div class="faq"><h4>A consulta online é gravada?</h4><p>A consulta não deve ser gravada sem informação e consentimento adequados. A plataforma deve explicar claramente as suas regras de privacidade e tratamento de dados.</p></div>

  <h3>2. Baixa médica, receitas e atestados</h3>

  <div class="faq"><h4>O médico online pode passar baixa médica?</h4><p>Sim. O Certificado de Incapacidade Temporária, conhecido como baixa médica, pode ser emitido após consulta por videochamada com médico inscrito na Ordem dos Médicos, quando clinicamente justificado. A baixa médica é válida para os efeitos legais aplicáveis e pode ser comunicada à Segurança Social. No entanto, a emissão não é automática — depende sempre da avaliação clínica e da existência de informação suficiente para o médico avaliar a incapacidade temporária.</p></div>
  <div class="faq"><h4>A receita passada pelo médico online é válida na farmácia?</h4><p>Sim. A prescrição eletrónica emitida por um médico inscrito na Ordem dos Médicos tem validade em farmácias em Portugal, nos termos aplicáveis à prescrição eletrónica. Não existe diferença legal entre uma receita emitida numa consulta presencial e uma receita emitida numa consulta online, desde que seja passada por um médico habilitado.</p></div>
  <div class="faq"><h4>Posso pedir um atestado online?</h4><p>Pode pedir, mas a emissão depende da avaliação clínica e da finalidade do atestado. O médico pode recusar emitir o documento se não tiver elementos suficientes para o fazer com segurança e responsabilidade clínica.</p></div>

  <h3>3. Disponibilidade e funcionamento da consulta</h3>

  <div class="faq"><h4>Posso falar com um médico online ao fim de semana?</h4><p>Sim. Na Consultas-Online.pt, as consultas estão disponíveis de segunda a domingo, das 9h às 21h.</p></div>
  <div class="faq"><h4>O médico online pode ver doentes de urgência ao fim de semana?</h4><p>Sim, desde que não se trate de uma emergência médica. A Consultas-Online.pt está disponível de segunda a domingo, das 9h às 21h, incluindo feriados. Para situações que não constituam emergência médica, o médico online pode ser uma opção válida e disponível ao fim de semana. Em caso de emergência médica, deve ligar 112 ou recorrer a uma urgência hospitalar.</p></div>
  <div class="faq"><h4>Quanto tempo demora a consulta com médico online?</h4><p>Uma consulta com médico online pode durar entre 15 e 30 minutos em situações agudas simples. Consultas de seguimento de doenças crónicas ou consultas que impliquem revisão de documentação clínica podem ser mais longas. Não existem limites de tempo fixos — a consulta deve durar o tempo necessário para uma avaliação adequada.</p></div>

  <h3>4. Historial clínico, SNS e médico de família</h3>

  <div class="faq"><h4>O médico online tem acesso ao meu historial clínico do SNS?</h4><p>Não automaticamente. As plataformas privadas de teleconsulta não têm acesso direto ao Processo Clínico Único do SNS. Por isso, deve preparar antes da consulta os documentos clínicos relevantes, como análises recentes, relatórios médicos, exames complementares, lista de medicação atual, relatórios de especialidade e informação sobre doenças anteriores. O médico online baseia a sua avaliação nas informações fornecidas pelo doente e nos documentos partilhados durante a consulta.</p></div>
  <div class="faq"><h4>O médico online substitui o médico de família?</h4><p>Não substitui totalmente. O médico online habitualmente é procurado para ajudar em situações pontuais, sintomas agudos, renovação de medicação, documentação clínica e orientação médica. No entanto, não substitui o acompanhamento continuado que um médico de Medicina Geral e Familiar proporciona ao longo dos anos. Sempre que possível, recomenda-se manter acompanhamento regular com um médico de família que conheça a história clínica completa do doente, presencialmente ou mesmo online.</p></div>

  <h3>5. Seguros, localização e condições especiais</h3>

  <div class="faq"><h4>Posso ser reembolsado pelo seguro de saúde?</h4><p>Na maioria dos casos, pode ser possível. Alguns seguros de saúde privados em Portugal aceitam faturas de teleconsulta para efeitos de reembolso. No entanto, as condições variam consoante a apólice, a seguradora e o tipo de cobertura contratada. Verifique sempre as condições específicas junto da sua seguradora antes de marcar a consulta.</p></div>
  <div class="faq"><h4>Posso consultar um médico online estando no estrangeiro?</h4><p>Depende da situação. Para obtenção de documentação com validade legal em Portugal, como baixa médica, receita ou atestados, podem existir condições específicas relacionadas com a localização do doente no momento da consulta. Para pedidos de orientação clínica ou segunda opinião, a localização pode não ser determinante. Consulte sempre os termos específicos da plataforma antes de marcar.</p></div>

  <h3>6. Urgência e limites da teleconsulta</h3>

  <div class="faq"><h4>Posso usar médico online em vez de ir à urgência?</h4><p>Não em situações de emergência. Em caso de risco grave, sintomas intensos ou agravamento rápido do estado de saúde, deve ligar 112 ou recorrer a uma urgência hospitalar. A consulta online pode ser útil para situações não emergentes, orientação clínica, sintomas ligeiros ou moderados e avaliação inicial.</p></div>

  <h2>Médico online: cuidados médicos à distância</h2>
  <p>O médico online é uma forma prática de aceder a cuidados médicos à distância em Portugal. Pode ser útil para avaliação inicial, orientação clínica, receitas, baixas médicas e atestados, quando a situação é adequada a teleconsulta.</p>
  <p>A segurança do serviço depende de três fatores: médicos devidamente habilitados, plataforma segura e decisão clínica responsável.</p>
  <p>Na Consultas-Online.pt, pode falar com um médico por videochamada, de segunda a domingo, das 9h às 21h, com emissão de fatura e envio digital da documentação clínica quando aplicável.</p>

  <div class="art-cta"><h3>Marque a sua consulta online e fale com um médico hoje, sem sair de casa.</h3><p>Disponível de segunda a domingo, das 9h às 21h. Fatura AT automática. Médicos inscritos na Ordem dos Médicos.</p><a href="/">Consultar Médico Online →</a></div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Decreto-Lei n.º 2/2024, de 5 de janeiro. <em>Diário da República, 1.ª série.</em> Ministério do Trabalho, Solidariedade e Segurança Social e da Saúde. Disponível em: dre.pt</li>
    <li>Ordem dos Médicos. (2020). <em>Regulamento de Telemedicina.</em> Lisboa: Ordem dos Médicos. Disponível em: ordemdosmedicos.pt</li>
    <li>Lei n.º 58/2019, de 8 de agosto. Execução na ordem jurídica portuguesa do Regulamento Geral sobre a Proteção de Dados. <em>Diário da República, 1.ª série.</em></li>
    <li>Regulamento (UE) 2016/679 do Parlamento Europeu e do Conselho, de 27 de abril de 2016 (RGPD). <em>Jornal Oficial da União Europeia,</em> L 119, pp. 1–88.</li>
    <li>Greenhalgh, T., Wherton, J., Shaw, S., & Morrison, C. (2020). Video consultations for covid-19. <em>BMJ,</em> 368, m998.</li>
    <li>Lieneck, C., Garvey, J., Conrad, C., et al. (2020). Rapid Telehealth Implementation during the COVID-19 Global Pandemic: A Rapid Review. <em>Healthcare,</em> 8(4), 517.</li>
    <li>Bashshur, R. L., Howell, J. D., Krupinski, E. A., et al. (2016). The Empirical Foundations of Telemedicine Interventions in Primary Care. <em>Telemedicine and e-Health,</em> 22(5), 342–375.</li>
    <li>Carlbring, P., Andersson, G., Cuijpers, P., et al. (2018). Internet-based vs. face-to-face cognitive behavior therapy for psychiatric and somatic disorders: updated systematic review and meta-analysis. <em>Cognitive Behaviour Therapy,</em> 47(1), 1–18.</li>
    <li>Pordata. (2023). Médicos por 1000 habitantes e utentes sem médico de família atribuído em Portugal. Fundação Francisco Manuel dos Santos. Disponível em: pordata.pt</li>
    <li>Entidade Reguladora da Saúde (ERS). (2019). <em>Estudo sobre o acesso aos cuidados de saúde primários do SNS.</em> Lisboa: ERS.</li>
    <li>WHO — World Health Organization. (2019). <em>Recommendations on Digital Interventions for Health System Strengthening.</em> Geneva: WHO. ISBN 978-92-4-155040-4.</li>
    <li>CNPD — Comissão Nacional de Proteção de Dados. (2021). <em>Guia sobre a proteção de dados pessoais de saúde.</em> Lisboa: CNPD. Disponível em: cnpd.pt</li>
    <li>Código Deontológico da Ordem dos Médicos. (2016). Regulamento n.º 707/2016. <em>Diário da República,</em> 2.ª série, n.º 139.</li>
    <li>Artigo 9.º do Código do Imposto sobre o Valor Acrescentado (CIVA). Isenções nas operações internas — prestações de serviços médicos e de saúde.</li>
    <li>Andrews, G., Basu, A., Cuijpers, P., et al. (2018). Computer therapy for anxiety and depression disorders: updated meta-analysis. <em>Journal of Anxiety Disorders,</em> 55, 70–78.</li>
  </ol></div>
  `
},

'telemedicina': {
  title: 'Telemedicina em Portugal: O que É e Direitos do Utente | ConsultasOnline',
  description: 'Como funciona a telemedicina em Portugal, diferenças entre SNS e privado e os seus direitos como utente.',
  keywords: 'telemedicina portugal, telemedicina como funciona, teleconsulta portugal direitos utente, telemedicina SNS privado',
  h1: 'Telemedicina em Portugal: O Que É, Como Funciona e Quais os Seus Direitos',
  content: `<div class="cta-top"><p>💻 Quer experimentar uma teleconsulta? Videoconsulta no browser, sem instalar nada. <a href="/">Marcar consulta →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p><em>O guia mais completo sobre telemedicina em Portugal: quadro legal, diferenças SNS vs. privada, modalidades, evidência científica e todos os seus direitos como utente.</em></p>

  <h2>O que é a telemedicina?</h2>
  <p>A telemedicina <strong>é a prestação de cuidados de saúde à distância com recurso a tecnologias de informação e comunicação.</strong> O conceito abrange um espectro alargado de práticas clínicas e de saúde, desde a simples videoconsulta entre médico e doente até ao diagnóstico remoto por imagem, à monitorização contínua de doentes crónicos com dispositivos conectados e à telecirurgia assistida por robótica.</p>
  <p>Em termos etimológicos, o prefixo grego «tele» significa «à distância», pelo que telemedicina é, literalmente, a prática da medicina à distância. A <a href="https://www.who.int/pt/about" target="_blank" style="color:var(--teal)">Organização Mundial de Saúde</a> (OMS) define-a, desde 1997, como «a prestação de serviços de saúde em que a distância é um fator crítico, por todos os profissionais de saúde, utilizando tecnologias de informação e comunicação para o intercâmbio de informação válida para o diagnóstico, tratamento e prevenção de doenças e lesões, pesquisa e avaliação, e para a educação continuada dos prestadores de cuidados de saúde, tudo no interesse da promoção da saúde dos indivíduos e das suas comunidades».</p>
  <p>Em Portugal, a telemedicina está regulamentada pela <a href="https://www.ordemdosmedicos.pt/" target="_blank" style="color:var(--teal)">Ordem dos Médicos</a>, através do Regulamento de Telemedicina (2020), e pelo Ministério da Saúde, através do <a href="https://diariodarepublica.pt/dr/detalhe/despacho/3571-2013-1759945" target="_blank" style="color:var(--teal)">Despacho n.º 3571/2013, de 6 de março</a>. <strong>Estas normas equiparam juridicamente o ato médico realizado à distância ao ato médico presencial, conferindo-lhe a mesma validade legal, deontológica e clínica.</strong></p>

  <h2>Breve história da telemedicina</h2>
  <p>Contrariamente ao que se possa pensar, a telemedicina não nasceu com a internet. As suas origens remontam ao século XIX:</p>
  <ul>
    <li><strong>1906:</strong> Willem Einthoven, inventor do eletrocardiograma, transmite o primeiro ECG por linha telefónica entre o Hospital da Universidade de Leiden e o seu laboratório, a 1,5 km de distância. É considerado o primeiro ato de telemedicina da história.</li>
    <li><strong>Anos 1950–60:</strong> Nos EUA, os primeiros programas de telerradiologia e telepsiquiatria surgem em contextos militares e de investigação. A NASA desenvolve sistemas de monitorização remota de astronautas.</li>
    <li><strong>Anos 1990:</strong> A expansão da internet de banda larga torna a videoconsulta tecnicamente viável. Surgem os primeiros programas estruturados de telemedicina em hospitais europeus e norte-americanos.</li>
    <li><strong>2010–2019:</strong> A proliferação dos smartphones e das ligações móveis de alta velocidade democratiza o acesso à telemedicina. Surgem as primeiras plataformas comerciais de teleconsulta direta ao consumidor.</li>
    <li><strong>2020–presente:</strong> A pandemia de COVID-19 funciona como catalisador de adoção massiva. Em Portugal, o número de teleconsultas realizadas no SNS cresceu mais de 400% entre 2019 e 2021, segundo dados da ACSS.</li>
  </ul>

  <h2>Quais as modalidades de telemedicina?</h2>
  <p>A telemedicina não se resume à videochamada com um médico. Abrange um conjunto diversificado de modalidades clínicas, cada uma com aplicações, tecnologias e contextos próprios:</p>

  <h3>Teleconsulta (Store-and-Forward vs. Tempo Real)</h3>
  <p>A teleconsulta é a modalidade mais familiar ao cidadão comum e divide-se em duas variantes:</p>
  <ul>
    <li><strong>Teleconsulta em tempo real</strong> (synchronous): Videochamada ao vivo entre médico e doente. Permite interação direta, avaliação visual e recolha de história clínica em tempo real. É a modalidade predominante nas plataformas de <a href="/artigos/consulta-online">teleconsulta privada em Portugal</a>, como a Consultas-Online.pt.</li>
    <li><strong>Teleconsulta assíncrona</strong> (store-and-forward): O doente envia informação clínica (fotografias, vídeos, questionários, resultados analíticos) que o médico analisa posteriormente, sem interação simultânea. Muito utilizada em teledermatologia, teleoftalmologia e teledermatoscopia.</li>
  </ul>

  <h3>Telemonitorização</h3>
  <p>A telemonitorização consiste na recolha e transmissão remota de dados fisiológicos do doente para análise por profissionais de saúde. É especialmente relevante na gestão de doenças crónicas:</p>
  <ul>
    <li><strong>Telemonitorização cardíaca:</strong> Transmissão de ECG, frequência cardíaca e ritmo cardíaco. Holter de 24h com transmissão remota. Pacemakers e desfibrilhadores implantáveis com telemetria.</li>
    <li><strong>Telemonitorização da diabetes:</strong> Glucómetros conectados que enviam valores de glicemia ao médico ou à plataforma de saúde. Sensores de glicose intersticial contínuos (CGM) com alertas automáticos.</li>
    <li><strong>Telemonitorização da pressão arterial:</strong> Tensiómetros domésticos com transmissão de dados para o processo clínico eletrónico.</li>
    <li><strong>Telemonitorização respiratória:</strong> Oxímetros de pulso conectados para monitorização de saturação de oxigénio em doentes com DPOC, asma ou insuficiência respiratória crónica.</li>
    <li><strong>Telemonitorização pós-cirúrgica:</strong> Acompanhamento remoto de doentes após intervenção cirúrgica, reduzindo internamentos e reinternamentos.</li>
  </ul>

  <h3>Especialidades com aplicações específicas de telemedicina</h3>
  <ul>
    <li><strong>Teledermatologia:</strong> Avaliação de lesões cutâneas por fotografia de alta resolução ou dermatoscopia digital remota. <a href="https://www.hsrd.research.va.gov/publications/esp/telederm-2010.pdf" target="_blank" style="color:var(--teal)">Tanto o método SAF como a teledermatologia LI apresentam níveis aceitáveis de precisão diagnóstica e de concordância quando comparados com a dermatologia presencial em consulta</a> (Warshaw et al., 2009).</li>
    <li><strong>Telerradiologia:</strong> Leitura e interpretação remota de exames de imagem (radiografias, TACs, RMNs). Permite acesso a radiologistas especializados em hospitais com menor volume ou em horário noturno.</li>
    <li><strong>Telepsiquiatria:</strong> Avaliação, diagnóstico e terapêutica psiquiátrica por videochamada. Demonstrou <a href="https://pubmed.ncbi.nlm.nih.gov/29215315/" target="_blank" style="color:var(--teal)">eficácia equivalente à consulta presencial para depressão, ansiedade e PTSD</a> (Carlbring et al., 2018).</li>
    <li><strong>Teleoftalmologia:</strong> Rastreio de retinopatia diabética e glaucoma através de fotografia de fundo ocular com análise remota. Programas de rastreio populacionais no SNS.</li>
    <li><strong>Teleneurologia:</strong> Segunda opinião em AVC agudo (telestroke) com apoio a unidades hospitalares periféricas. Teleconsulta de epilepsia, esclerose múltipla e Parkinson.</li>
    <li><strong>Telecardiopatia:</strong> Interpretação remota de ECG, ecocardiogramas e Holter. Apoio a centros de saúde primários sem cardiologista residente.</li>
    <li><strong>Teleoncologia:</strong> Acompanhamento de doentes em tratamento oncológico, gestão de efeitos secundários e suporte psicológico por videochamada.</li>
    <li><strong>Teleurgência:</strong> Triagem remota em situações de urgência não imediata, apoio a populações isoladas e serviços de saúde em zonas remotas.</li>
  </ul>

  <h3>Teleconsulta entre profissionais (Peer-to-Peer)</h3>
  <p>A telemedicina não se limita à relação médico-doente. A teleconsulta entre profissionais de saúde (médico de família e especialista hospitalar, enfermeiro e médico, farmacêutico e médico) é uma modalidade crescente que melhora a eficiência do sistema de saúde e reduz referenciações desnecessárias para especialidade.</p>

  <h2>Quadro legal da telemedicina em Portugal: legislação completa</h2>
  <p>Portugal possui um quadro regulatório estruturado para a prática da telemedicina, distribuído por múltiplos diplomas legais e regulamentos profissionais. Compreendê-lo é essencial tanto para os profissionais de saúde como para os utentes.</p>

  <h3><a href="https://diariodarepublica.pt/dr/detalhe/decreto-lei/2-2024-836117864" target="_blank" style="color:var(--teal)">Decreto-Lei n.º 2/2024, de 5 de janeiro</a> — A Lei da Baixa Médica Online</h3>
  <p>Os seus pontos principais:</p>
  <ul>
    <li>Estabelece que o Certificado de Incapacidade Temporária (CIT - «baixa médica») pode ser emitido na sequência de uma teleconsulta médica, sem necessidade de consulta presencial</li>
    <li>Equipara, para todos os efeitos legais e laborais, o CIT emitido por teleconsulta ao CIT emitido em consulta presencial</li>
    <li>Aplica-se a todos os médicos inscritos na Ordem dos Médicos que pratiquem teleconsulta em território nacional, independentemente do setor (SNS ou privado)</li>
  </ul>

  <h3>Regulamento de Telemedicina da Ordem dos Médicos (2020)</h3>
  <p>O Regulamento de Telemedicina, aprovado pelo Conselho Nacional da Ordem dos Médicos em 2020, constitui o principal instrumento deontológico que rege a prática da teleconsulta em Portugal. Estabelece:</p>
  <ul>
    <li><strong>Definição e âmbito</strong> — clarifica o que constitui telemedicina para efeitos deontológicos e quais as modalidades abrangidas</li>
    <li><strong>Condições de exercício</strong> — o médico deve garantir que possui as competências técnicas necessárias e que a plataforma utilizada reúne os requisitos de segurança adequados</li>
    <li><strong>Relação médico-doente</strong> — o caráter personalizado e individualizado da relação médico-doente deve ser preservado na teleconsulta, com especial atenção à comunicação não-verbal limitada pelo meio digital</li>
    <li><strong>Identificação e consentimento</strong> — obrigatoriedade de identificação mútua no início de cada ato e de obtenção de consentimento informado específico para a modalidade de teleconsulta</li>
    <li><strong>Registo clínico</strong> — toda a teleconsulta deve ser registada em processo clínico individual, com os mesmos requisitos de completude que a consulta presencial</li>
    <li><strong>Limites da teleconsulta</strong> — o médico é responsável por reconhecer quando a situação clínica excede o que pode ser gerido à distância e por encaminhar o doente para avaliação presencial</li>
    <li><strong>Confidencialidade e proteção de dados</strong> — obrigação de utilizar plataformas que garantam a segurança das comunicações e a proteção dos dados clínicos</li>
  </ul>

  <h3>Regulamento Geral sobre a Proteção de Dados (RGPD) e Lei n.º 58/2019</h3>
  <p>O <a href="https://eur-lex.europa.eu/PT/legal-content/summary/general-data-protection-regulation-gdpr.html" target="_blank" style="color:var(--teal)">RGPD (Regulamento UE 2016/679)</a> classifica os dados de saúde como «dados de categorias especiais», sujeitos a um regime de proteção reforçado. A Lei n.º 58/2019 executa o RGPD na ordem jurídica portuguesa. As implicações para a telemedicina são:</p>
  <ul>
    <li><strong>Consentimento explícito</strong> — o tratamento de dados de saúde requer consentimento específico, informado e inequívoco do titular</li>
    <li><strong>Minimização de dados</strong> — apenas os dados estritamente necessários para a prestação do cuidado de saúde devem ser recolhidos e tratados</li>
    <li><strong>Limitação de conservação</strong> — os dados devem ser conservados apenas pelo período necessário ao cumprimento da finalidade para que foram recolhidos, com os mínimos legais aplicáveis</li>
    <li><strong>Segurança técnica e organizativa</strong> — as plataformas de telemedicina são obrigadas a implementar medidas de segurança adequadas ao risco, incluindo encriptação, controlo de acesso e auditoria</li>
    <li><strong>Notificação de violações</strong> — qualquer violação de segurança que afete dados de saúde deve ser notificada à CNPD no prazo de 72 horas</li>
    <li><strong>Direitos do titular</strong> — acesso, retificação, apagamento («direito a ser esquecido»), portabilidade e oposição ao tratamento</li>
  </ul>

  <h3><a href="https://diariodarepublica.pt/dr/detalhe/lei/95-2019-124417108" target="_blank" style="color:var(--teal)">Lei de Bases da Saúde, aprovada em 2019</a> (Lei n.º 95/2019)</h3>
  <p>A Lei de Bases da Saúde, aprovada em 2019, consagra expressamente o direito dos utentes ao acesso a cuidados de saúde através de meios digitais e reconhece a telemedicina como um instrumento de promoção da equidade no acesso, nomeadamente para populações em zonas geográficas com menor densidade de serviços de saúde.</p>

  <h3>Estratégia Nacional para o Desenvolvimento da Telemedicina</h3>
  <p>O Ministério da Saúde tem desenvolvido, através da <a href="https://www.spms.min-saude.pt/" target="_blank" style="color:var(--teal)">SPMS (Serviços Partilhados do Ministério da Saúde)</a> e da ACSS (Administração Central do Sistema de Saúde), uma estratégia de expansão da telemedicina no SNS, que inclui:</p>
  <ul>
    <li><strong>Plataforma nacional de teleconsulta do SNS</strong> — integrada com o Registo de Saúde Eletrónico (RSE) e o Processo Clínico Único</li>
    <li><strong>Programas de teleconsulta em especialidades com listas de espera elevadas</strong> — psiquiatria, dermatologia, oftalmologia</li>
    <li><strong>Projetos-piloto de telemonitorização de doentes crónicos</strong> — diabetes, hipertensão, insuficiência cardíaca</li>
    <li><strong>Formação de profissionais de saúde</strong> em competências de teleconsulta e comunicação digital</li>
  </ul>

  <h2>Quando optar pela telemedicina privada</h2>
  <p>A teleconsulta privada é a opção indicada quando:</p>
  <ul>
    <li>O doente não tem médico de família atribuído (mais de 1,5 milhões de portugueses nesta situação)</li>
    <li>A situação é aguda e não tolera espera: gripe, infeção urinária, amigdalite, necessidade urgente de baixa médica</li>
    <li>A consulta é necessária fora do horário do SNS: fins de semana, feriados, período noturno</li>
    <li>O doente prefere privacidade total sem consulta do processo clínico do SNS</li>
    <li>O seguro de saúde reembolsa parcialmente o custo, tornando o diferencial financeiro residual</li>
  </ul>

  <h2>Direitos do utente na telemedicina: guia completo</h2>
  <p>Conhecer os seus direitos como utente de telemedicina é tão importante como saber como funciona. <strong>Os seus direitos numa teleconsulta são idênticos aos de qualquer consulta médica presencial e em alguns aspetos são reforçados pela legislação digital.</strong></p>

  <h3>Direito ao sigilo médico</h3>
  <p>O sigilo médico é um dos alicerces da relação médico-doente, consagrado no artigo 85.º do <a href="https://ordemdosmedicos.pt/etica" target="_blank" style="color:var(--teal)">Código Deontológico da Ordem dos Médicos</a>. Aplica-se integralmente à teleconsulta:</p>
  <ul>
    <li>O médico está proibido de revelar qualquer informação sobre o estado de saúde, diagnóstico ou tratamento do doente a terceiros, sem o seu consentimento expresso</li>
    <li>A videochamada decorre em sala virtual privada. Não é gravada pelo médico nem pela plataforma, salvo com consentimento explícito do doente</li>
    <li>O conteúdo da consulta não é partilhado com seguradoras, entidades patronais, familiares ou qualquer outra entidade terceira</li>
    <li>As exceções ao sigilo médico são as mesmas que na consulta presencial: obrigação de declaração de certas doenças infecto-contagiosas, situações de risco de vida imediato e determinações judiciais</li>
  </ul>

  <h3>Direito ao consentimento informado</h3>
  <p>O consentimento informado é um direito fundamental do doente, consagrado na Lei de Bases da Saúde e no Código Deontológico da OM. Na teleconsulta, este direito implica:</p>
  <ul>
    <li>O doente deve ser informado, antes do início da consulta, de que esta se realiza por meios digitais e das implicações que isso comporta</li>
    <li>O doente tem o direito de recusar a teleconsulta e solicitar atendimento presencial, sem que tal recusa prejudique o seu acesso a cuidados de saúde</li>
    <li>O médico deve obter consentimento específico para qualquer gravação da consulta, partilha de informação com outros profissionais ou utilização dos dados para fins de investigação</li>
    <li>O consentimento informado para teleconsulta deve ser prestado de forma livre, esclarecida e documentada</li>
  </ul>

  <h3>Direito à proteção de dados pessoais de saúde</h3>
  <p>Ao abrigo do RGPD e da Lei n.º 58/2019, o utente de telemedicina tem os seguintes direitos relativamente aos seus dados de saúde:</p>
  <ul>
    <li><strong>Direito de acesso</strong> — pode solicitar à plataforma uma cópia de todos os dados pessoais que detém sobre si, incluindo registos clínicos</li>
    <li><strong>Direito de retificação</strong> — pode corrigir dados inexatos ou incompletos</li>
    <li><strong>Direito ao apagamento</strong> («direito a ser esquecido») — pode solicitar a eliminação dos seus dados, salvo quando a sua conservação seja obrigatória por lei (ex.: registos clínicos com prazo mínimo de conservação legal)</li>
    <li><strong>Direito à portabilidade</strong> — pode solicitar a transmissão dos seus dados a outro prestador de saúde, em formato estruturado e interoperável</li>
    <li><strong>Direito de oposição</strong> — pode opor-se ao tratamento dos seus dados para fins de marketing, investigação ou outros fins não diretamente relacionados com a prestação do cuidado de saúde</li>
    <li><strong>Direito de apresentar queixa</strong> — pode apresentar queixa à CNPD (www.cnpd.pt) se considerar que os seus direitos foram violados</li>
  </ul>

  <h3>Direito à fatura e à transparência de preços</h3>
  <p>Qualquer prestação de serviços médicos em Portugal, incluindo teleconsultas, obriga à emissão de fatura AT nos termos do Código do IVA e do Código do IRC/IRS. O utente tem direito a:</p>
  <ul>
    <li>Receber fatura AT automaticamente após cada consulta, sem necessidade de a solicitar</li>
    <li>Obter fatura com discriminação clara do serviço prestado, valor cobrado e identificação do prestador</li>
    <li>Utilizar a fatura para dedução fiscal (15% em IRS como despesa de saúde) e para reembolso junto do seguro de saúde</li>
    <li>Ser informado do preço total da consulta antes da sua realização, sem surpresas ou custos ocultos</li>
  </ul>

  <h3>Direito à qualidade clínica e à segunda opinião</h3>
  <p>O utente de telemedicina tem direito a:</p>
  <ul>
    <li>Cuidados de saúde de qualidade equivalente à consulta presencial, prestados por médico devidamente credenciado</li>
    <li>Ser encaminhado para avaliação presencial sempre que a situação clínica o exija</li>
    <li>Solicitar segunda opinião a outro médico, sem que o médico inicial tenha qualquer objeção legítima</li>
    <li>Apresentar reclamação junto da Ordem dos Médicos em caso de má prática ou comportamento não deontológico</li>
    <li>Obter cópia do registo clínico da consulta, incluindo o diagnóstico formulado e o plano terapêutico prescrito</li>
  </ul>

  <h2>Quais as vantagens e limitações da telemedicina?</h2>
  <p>A telemedicina tem vantagens inegáveis, mas também limitações reais que qualquer análise séria deve reconhecer.</p>

  <h3>Vantagens demonstradas</h3>
  <ul>
    <li><strong>Equidade no acesso</strong> — redução das desigualdades geográficas no acesso a cuidados de saúde especializados. Populações rurais e insulares acedem a especialistas sem deslocação</li>
    <li><strong>Redução dos tempos de espera</strong> — em especialidades com listas de espera prolongadas, a teleconsulta permite um primeiro contacto clínico mais rápido</li>
    <li><strong>Conveniência para o doente</strong> — eliminação da necessidade de deslocação, estacionamento, ausência ao trabalho e exposição a outros doentes em sala de espera</li>
    <li><strong>Segurança em contexto de doença infecciosa</strong> — redução do risco de transmissão cruzada de agentes infecciosos, demonstrado de forma inequívoca durante a pandemia de COVID-19</li>
    <li><strong>Adesão terapêutica</strong> — estudos demonstram que doentes crónicos acompanhados por telemedicina têm taxas de adesão superiores, pela maior facilidade de contacto com o médico</li>
    <li><strong>Eficiência do sistema de saúde</strong> — redução de consultas presenciais desnecessárias, libertando recursos para casos de maior complexidade</li>
    <li><strong>Saúde mental</strong> — redução do estigma e das barreiras de acesso a cuidados de saúde mental, com eficácia terapêutica demonstradamente equivalente à consulta presencial</li>
  </ul>

  <h3>Limitações da telemedicina na atualidade</h3>
  <ul>
    <li><strong>Impossibilidade de exame físico</strong> — a ausência de contacto físico impede a auscultação, palpação, percussão e observação direta de certas características clínicas, limitando o diagnóstico em situações que exigem estes dados semiológicos</li>
    <li><strong>Exclusão digital</strong> — cidadãos sem competências digitais, acesso a dispositivos ou ligação à internet de qualidade suficiente ficam excluídos da telemedicina. Em Portugal, este grupo inclui desproporcionalmente idosos e populações de menor escolaridade</li>
    <li><strong>Risco de sobrediagnóstico ou subdiagnóstico</strong> — a limitação de informação clínica disponível à distância pode conduzir a diagnósticos menos precisos em situações de maior complexidade ou ambiguidade clínica</li>
    <li><strong>Ausência de continuidade garantida</strong> — em algumas plataformas de teleconsulta privada, o doente pode ser atendido por médicos diferentes em consultas sucessivas, comprometendo a longitudinalidade dos cuidados. Isso não acontece na Consultas-Online.pt</li>
    <li><strong>Questões de privacidade no ambiente doméstico</strong> — a realização da consulta em casa pode não garantir a privacidade necessária se existirem outras pessoas presentes no espaço</li>
    <li><strong>Limitações técnicas</strong> — falhas de conectividade, qualidade de imagem/áudio insuficiente e inexperiência tecnológica do doente ou do médico podem comprometer a qualidade da teleconsulta</li>
  </ul>

  <h2>Qual a evidência científica existente sobre a telemedicina?</h2>
  <p>A investigação científica sobre telemedicina acumulou, nas últimas duas décadas, um corpo de evidência robusto que sustenta a sua eficácia e segurança em múltiplos contextos clínicos.</p>

  <h3>Revisões sistemáticas e metanálises</h3>
  <p>Uma <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC6473731/" target="_blank" style="color:var(--teal)">revisão Cochrane publicada em 2020 (Flodgren et al.)</a> analisou 93 ensaios clínicos randomizados sobre intervenções de telemedicina e concluiu que, para a gestão de doenças crónicas como diabetes, insuficiência cardíaca e DPOC, a telemedicina melhora outcomes clínicos de forma estatisticamente significativa, com efeitos moderados a grandes na adesão terapêutica, no controlo metabólico e na qualidade de vida relacionada com a saúde.</p>
  <p>Uma <a href="https://pubmed.ncbi.nlm.nih.gov/29215315/" target="_blank" style="color:var(--teal)">metanálise de Carlbring et al. (2018)</a>, publicada na Cognitive Behaviour Therapy, analisou 52 estudos sobre psicoterapia por videoconferência versus presencial e encontrou equivalência terapêutica para depressão, ansiedade generalizada, pânico, fobia social e PTSD, com tamanhos de efeito comparáveis.</p>

  <h3>Segurança clínica</h3>
  <p>O estudo mais abrangente sobre segurança da <a href="https://www.bmj.com/content/368/bmj.m998.long" target="_blank" style="color:var(--teal)">teleconsulta em cuidados de saúde primários</a> (Wherton et al., BMJ, 2020), envolvendo mais de 50.000 teleconsultas no NHS britânico, concluiu que a taxa de eventos adversos associados a diagnósticos por teleconsulta é comparável à da consulta presencial quando existe triagem adequada dos casos, ou seja, quando apenas as situações passíveis de avaliação remota são geridas por teleconsulta.</p>

  <h3>Impacto na equidade em saúde</h3>
  <p>Estudos realizados em Portugal e noutros países europeus com características demográficas similares (baixa densidade populacional em zonas interiores, envelhecimento da população) demonstram que a telemedicina tem impacto positivo na redução das desigualdades de acesso a especialidades médicas, permitindo que doentes em zonas rurais acedam a cuidados de saúde diferenciados sem as barreiras tradicionais de custo e distância.</p>

  <h3>Satisfação dos profissionais de saúde</h3>
  <p>Um inquérito realizado pela Ordem dos Médicos de Portugal em 2021, após o período de maior adoção forçada de teleconsulta durante a pandemia, revelou que 67% dos médicos de família consideravam a teleconsulta «adequada ou muito adequada» para um subconjunto das suas consultas habituais, e que 58% pretendiam manter uma proporção de teleconsultas no seu exercício clínico pós-pandémico.</p>

  <h2>Perguntas frequentes sobre telemedicina em Portugal</h2>

  <div class="faq"><h4>O que é a telemedicina em termos simples?</h4><p>A telemedicina é ir ao médico sem sair de casa, através de videochamada, telefone ou outros meios digitais. Inclui desde a consulta simples com o médico até ao diagnóstico especializado por análise remota de imagens médicas ou monitorização contínua de doenças crónicas com dispositivos conectados.</p></div>
  <div class="faq"><h4>A telemedicina é legal em Portugal?</h4><p>Sim. A telemedicina em Portugal está regulamentada pelo Regulamento de Telemedicina da Ordem dos Médicos (2020), pelo Decreto-Lei n.º 2/2024, de 5 de janeiro (que legaliza a emissão de baixa médica por teleconsulta) e pela Lei de Bases da Saúde (Lei n.º 95/2019). O ato médico realizado por telemedicina tem a mesma validade legal que o realizado presencialmente.</p></div>
  <div class="faq"><h4>Qual a diferença entre telemedicina e teleconsulta?</h4><p>A teleconsulta é uma das modalidades da telemedicina, a mais comum para o cidadão. A telemedicina é o conceito mais amplo, que inclui também telerradiologia, telemonitorização, teledermatologia, telepsiquiatria e teleconsulta entre profissionais de saúde.</p></div>
  <div class="faq"><h4>O meu sigilo médico está protegido numa teleconsulta?</h4><p>Sim. O sigilo médico aplica-se integralmente à teleconsulta, tal como à consulta presencial. O médico está proibido por lei e pelo Código Deontológico de partilhar qualquer informação clínica sem o seu consentimento expresso. As plataformas legítimas não gravam as consultas e protegem os dados de saúde ao abrigo do RGPD.</p></div>
  <div class="faq"><h4>Quais são os meus direitos numa teleconsulta?</h4><p>Os seus direitos incluem: sigilo médico total, consentimento informado específico para teleconsulta, proteção de dados ao abrigo do RGPD (acesso, retificação, apagamento, portabilidade), fatura AT automática, transparência de preços, qualidade clínica equivalente à consulta presencial e direito de reclamação junto da Ordem dos Médicos, ERS ou CNPD.</p></div>
  <div class="faq"><h4>A telemedicina é adequada para urgências?</h4><p>Não. A telemedicina não substitui os serviços de urgência em situações com risco imediato para a vida. Em caso de emergência médica, ligue sempre 112 (INEM). Para situações urgentes, mas não emergentes, como gripe, febre alta, infeção urinária ou necessidade de baixa médica urgente, a teleconsulta é uma opção adequada e disponível no mesmo dia.</p></div>
  <div class="faq"><h4>Posso ser reembolsado pelo seguro de saúde por uma teleconsulta privada?</h4><p>Na maioria dos casos, sim. Os principais seguros de saúde privados em Portugal (Médis, AdvanceCare, Multicare, Fidelidade) aceitam faturas AT de teleconsultas para reembolso. As condições variam consoante o plano contratado — verifique junto da sua seguradora. A fatura AT é emitida automaticamente pelas plataformas legítimas de telemedicina privada.</p></div>
  <div class="faq"><h4>A telemedicina é eficaz para saúde mental?</h4><p>Sim. A evidência científica é robusta: metanálises publicadas em revistas de referência demonstram equivalência terapêutica entre a psicoterapia por videoconferência e a presencial para as principais perturbações de saúde mental (depressão, ansiedade, PTSD). O ambiente doméstico pode, adicionalmente, reduzir o estigma e facilitar a adesão ao tratamento.</p></div>

  <h2>Telemedicina em Portugal — presente consolidado, futuro promissor</h2>
  <p>A telemedicina em Portugal deixou de ser um conceito experimental para se tornar uma realidade clínica consolidada, legalmente enquadrada e com evidência científica robusta que sustenta a sua eficácia e segurança.</p>
  <p>O quadro regulatório existente (Decreto-Lei n.º 2/2024, de 5 de janeiro, Regulamento de Telemedicina da OM, RGPD e Lei de Bases da Saúde) confere ao utente e ao profissional de saúde a segurança jurídica necessária para adotar a teleconsulta com confiança. Os direitos do utente são os mesmos da consulta presencial, reforçados pela legislação específica de proteção de dados digitais.</p>
  <p>As diferenças entre a telemedicina disponível no SNS e na esfera privada são reais e condicionam a experiência: o setor privado oferece imediatismo, disponibilidade alargada e autonomia de marcação; o SNS oferece gratuitidade e integração clínica. Para muitos portugueses, especialmente os mais de 1,5 milhões sem médico de família atribuído, a telemedicina privada é hoje a solução mais acessível e rápida para necessidades de saúde agudas.</p>
  <p><strong>A Consultas-Online.pt</strong> representa este modelo: médicos inscritos na Ordem dos Médicos, plataforma em conformidade com o RGPD, fatura AT automática, disponibilidade de segunda a domingo entre as 9h e as 21h. Uma resposta concreta às necessidades reais dos utentes portugueses, alinhada com o melhor da telemedicina europeia.</p>

  <div class="art-cta"><h3>Quer experimentar uma teleconsulta?</h3><p>Videoconsulta no browser, sem instalar nada. Documentos com validade legal enviados por email.</p><a href="/">Marcar Teleconsulta →</a></div>

  <div class="refs"><h3>Referências Bibliográficas</h3><ol class="ref-list">
    <li>Decreto-Lei n.º 2/2024, de 5 de janeiro. <em>Diário da República, 1.ª série.</em> Ministério do Trabalho, Solidariedade e Segurança Social e da Saúde. Disponível em: dre.pt</li>
    <li>Ordem dos Médicos. (20f20). <em>Regulamento de Telemedicina.</em> Lisboa: Ordem dos Médicos. Disponível em: ordemdosmedicos.pt</li>
    <li>Código Deontológico da Ordem dos Médicos. (2016). Regulamento n.º 707/2016. <em>Diário da República,</em> 2.ª série, n.º 139.</li>
    <li>Lei n.º 95/2019, de 4 de setembro. Lei de Bases da Saúde. <em>Diário da República,</em> 1.ª série, n.º 169.</li>
    <li>Lei n.º 58/2019, de 8 de agosto. Execução do RGPD na ordem jurídica portuguesa. <em>Diário da República, 1.ª série.</em></li>
    <li>Regulamento (UE) 2016/679 do Parlamento Europeu e do Conselho, de 27 de abril de 2016 (RGPD). <em>Jornal Oficial da União Europeia,</em> L 119, pp. 1–88.</li>
    <li>WHO — World Health Organization. (1997). A Health Telematics Policy in Support of WHO's Health-For-All Strategy for Global Health Development. Geneva: WHO.</li>
    <li>WHO — World Health Organization. (2019). <em>Recommendations on Digital Interventions for Health System Strengthening.</em> Geneva: WHO. ISBN 978-92-4-155040-4.</li>
    <li>Flodgren, G., Rachas, A., Farmer, A. J., et al. (2020). Interactive telemedicine: effects on professional practice and health care outcomes. <em>Cochrane Database of Systematic Reviews,</em> 9, CD002098.</li>
    <li>Greenhalgh, T., Wherton, J., Shaw, S., & Morrison, C. (2020). Video consultations for covid-19. <em>BMJ,</em> 368, m998.</li>
    <li>Carlbring, P., Andersson, G., Cuijpers, P., et al. (2018). Internet-based vs. face-to-face cognitive behavior therapy for psychiatric and somatic disorders: updated systematic review and meta-analysis. <em>Cognitive Behaviour Therapy,</em> 47(1), 1–18.</li>
    <li>Warshaw, E. M., Hillman, Y. J., Greer, N. L., et al. (2009). Teledermatology for diagnosis and management of skin conditions: a systematic review. <em>Journal of the American Academy of Dermatology,</em> 60(4), 668–676.</li>
    <li>Bashshur, R. L., Howell, J. D., Krupinski, E. A., et al. (2016). The Empirical Foundations of Telemedicine Interventions in Primary Care. <em>Telemedicine and e-Health,</em> 22(5), 342–375.</li>
    <li>ACSS — Administração Central do Sistema de Saúde. (2022). Relatório de acompanhamento das teleconsultas no SNS 2020–2021. Lisboa: ACSS/Ministério da Saúde.</li>
    <li>Comissão Europeia. (2022). Proposta de Regulamento relativo ao Espaço Europeu de Dados de Saúde (EHDS). COM(2022) 197 final.</li>
    <li>ERS — Entidade Reguladora da Saúde. (2019). <em>Estudo sobre o acesso aos cuidados de saúde primários do SNS.</em> Lisboa: ERS.</li>
    <li>CNPD — Comissão Nacional de Proteção de Dados. (2021). <em>Guia sobre a proteção de dados pessoais de saúde.</em> Lisboa: CNPD. Disponível em: cnpd.pt</li>
    <li>Pordata. (2023). Utentes sem médico de família atribuído em Portugal. Fundação Francisco Manuel dos Santos. Disponível em: pordata.pt</li>
    <li>Einthoven, W. (1906). Le télécardiogramme. <em>Archives Internationales de Physiologie,</em> 4, 132–164. (Primeira transmissão de ECG à distância — marco histórico da telemedicina.)</li>
    <li>Regulamento (UE) 2017/745 do Parlamento Europeu e do Conselho, de 5 de abril de 2017, relativo aos dispositivos médicos (MDR). <em>Jornal Oficial da União Europeia,</em> L 117.</li>
  </ol></div>
  `
},

'atestado-rastreio-saude': {
  title: 'Rastreio de Saúde em Portugal: O Guia Completo | ConsultasOnline',
  description: 'Rastreios recomendados pela DGS por idade e sexo, vacinação do adulto e como fazer rastreio de IST de forma discreta.',
  keywords: 'rastreio saúde portugal, exames preventivos portugal, rastreio oncológico portugal, check-up médico online portugal',
  h1: 'Rastreio de Saúde em Portugal: O Guia Completo',
  content: `<div class="cta-top"><p>🩺 Quer fazer um rastreio de saúde? Consulta online com pedido de análises personalizado. <a href="/">Marcar consulta — 40€ →</a></p></div>

<h2>O que é o rastreio de saúde?</h2>
  <p>O rastreio é a pesquisa de doenças em pessoas sem sintomas. O objectivo é detectar precocemente condições que, tratadas a tempo, têm melhor prognóstico.</p>
  <h2>Rastreios Recomendados por Idade e Sexo</h2>
  <h3>Para todos os adultos</h3>
  <ul>
    <li><strong>Tensão arterial</strong> — medição anual a partir dos 18 anos</li>
    <li><strong>Glicemia</strong> — cada 3 anos a partir dos 45 anos</li>
    <li><strong>Colesterol</strong> — cada 5 anos a partir dos 20 anos</li>
  </ul>
  <h3>Para mulheres</h3>
  <ul>
    <li><strong>Mamografia</strong> — dos 50 aos 69 anos, de 2 em 2 anos</li>
    <li><strong>Citologia cervical</strong> — dos 25 aos 60 anos, de 3 em 3 anos</li>
  </ul>
  <h3>A partir dos 50 anos</h3>
  <ul>
    <li><strong>Cancro do cólon</strong> — pesquisa de sangue oculto nas fezes de 2 em 2 anos</li>
  </ul>
  <div class="ibox"><div class="ibox-title">💡 Programa Nacional de Rastreio Oncológico</div><p>Os rastreios oncológicos são gratuitos para a população-alvo. Responda sempre às convocatórias do SNS.</p></div>
  <h2>Rastreio de IST</h2>
  <p>Para adultos sexualmente activos com múltiplos parceiros: VIH, sífilis, gonorreia e clamídia anualmente. A consulta online permite fazer o pedido de análises de forma discreta.</p>
  <div class="art-cta"><h3>Quer fazer um rastreio de saúde?</h3><p>Consulta online com avaliação de risco e pedido de análises personalizado.</p><a href="/">Marcar Consulta — 40€</a></div>
  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>DGS. <em>Programa Nacional para as Doenças Oncológicas.</em> 2022.</li>
    <li>DGS. <em>Programa Nacional de Vacinação 2024.</em></li>
  </ol></div>
  `
},

'renovar-pilula-anticoncecional-online': {
  title: 'Renovar a Pílula Anticoncecional Online em Portugal | ConsultasOnline',
  description: 'Saiba como renovar a receita da pílula por videoconsulta em Portugal. Legal, seguro, sem médico de família. Receita Sem Papel no próprio dia. 40€.',
  keywords: 'renovar pílula anticoncecional online, receita pílula online portugal, pílula sem médico de família, videoconsulta pílula portugal',
  h1: 'Renovar a Pílula Anticoncecional Online: É Possível em Portugal?',
  content: `<div class="cta-top"><p>💊 Precisa de renovar a pílula? Receita no email no próprio dia, sem médico de família. <a href="/">Marcar consulta — 40€ →</a></p></div>

<p>Está a ficar sem pílula e não consegue marcar consulta com o médico de família? Não tem médico de família atribuído? O trabalho não deixa ir ao centro de saúde durante o horário de funcionamento? Se reconhece alguma destas situações, saiba que <strong>renovar a receita da pílula anticoncecional através de uma videoconsulta online é legal, seguro e possível em Portugal</strong> — e pode ser feito hoje.</p>

    <h2>É mesmo legal renovar a pílula por videoconsulta?</h2>
    <p>Sim. A telemedicina está regulamentada em Portugal desde 2020, com enquadramento legal pelo Decreto-Lei n.º 10-A/2020 e pelas normas da Ordem dos Médicos. Uma médica devidamente inscrita na Ordem pode prescrever medicamentos — incluindo contracetivos hormonais — após avaliação clínica por videochamada, desde que sejam cumpridos os critérios de segurança.</p>
    <p>A receita emitida é uma <strong>Receita Sem Papel (RSP)</strong>, eletrónica, válida em qualquer farmácia em Portugal e com as comparticipações do SNS aplicáveis.</p>

    <div class="ibox"><div class="ibox-title">⚖️ Enquadramento Legal</div><p>A prescrição por telemedicina está prevista no Regulamento n.º 707/2016 da Ordem dos Médicos e nas orientações do INFARMED sobre prescrição eletrónica. A receita tem o mesmo valor legal que uma receita emitida em consulta presencial.</p></div>

    <h2>Quem pode renovar a pílula online?</h2>
    <p>A renovação da pílula por videoconsulta é adequada e segura para a maioria das mulheres. Em termos gerais, pode fazer online se:</p>
    <ul>
      <li>Já toma a mesma pílula há 6 meses ou mais, sem problemas</li>
      <li>Não tem sintomas novos nem alterações de saúde relevantes desde a última consulta</li>
      <li>A sua tensão arterial é normal (ou foi medida recentemente sem alterações)</li>
      <li>Não fuma com mais de 35 anos (contraindicação para pílulas com estrogénio)</li>
      <li>Não tem historial de trombose venosa, enxaqueca com aura, doença cardíaca ou hepática grave</li>
    </ul>

    <h3>Quando não é recomendado fazer online</h3>
    <p>Existem situações em que a avaliação presencial é preferível ou obrigatória:</p>
    <ul>
      <li>É a primeira vez que vai tomar a pílula — a primeira prescrição requer avaliação mais completa</li>
      <li>Quer mudar de marca ou tipo de pílula por sintomas como náuseas, alterações de humor ou spotting</li>
      <li>Tem tensão arterial alta ou não controlada</li>
      <li>Tem mais de 40 anos com fatores de risco cardiovascular</li>
      <li>Está a amamentar e quer iniciar contraceção hormonal combinada</li>
    </ul>

    <div class="ibox"><div class="ibox-title">💡 Não tem a certeza?</div><p>Na dúvida, marque a consulta na mesma. A médica avalia o seu caso e informa-a se a renovação pode ser feita online ou se é necessária uma avaliação adicional.</p></div>

    <h2>Que pílulas podem ser renovadas online?</h2>

    <h3>Pílulas combinadas (estrogénio + progestativo)</h3>
    <p>São as mais prescritas. Contêm etinilestradiol em combinação com um progestativo. Exemplos comuns: Microgynon, Yasmin, Yasminelle, Ginera, Mercilon, Minesse, Diane 35.</p>

    <h3>Minipílula (só progestativo)</h3>
    <p>Contém apenas um progestativo, sem estrogénio. Indicada para mulheres que não toleram estrogénio, fumadoras com mais de 35 anos ou durante a amamentação. Exemplos: Cerazette, Slinda, Noriday.</p>

    <h3>Pílula de emergência</h3>
    <p>A pílula do dia seguinte (levonorgestrel ou ulipristal) <strong>não precisa de receita médica</strong> em Portugal — pode ser comprada diretamente na farmácia.</p>

    <h2>Como funciona o processo passo a passo</h2>

    <h3>1. Marcar a consulta</h3>
    <p>Escolha o serviço "Renovação de Medicamentos", selecione o dia e hora no calendário e pague online por MBWay, Multibanco ou cartão. Receberá uma confirmação imediata por email com o link para a videochamada.</p>

    <h3>2. A videoconsulta (≈10–15 minutos)</h3>
    <p>A médica pergunta o nome da pílula atual, há quanto tempo a toma, se tem sintomas, antecedentes relevantes e medicação habitual. Se tiver um tensiómetro em casa, meça a tensão arterial antes da consulta.</p>

    <h3>3. A receita</h3>
    <p>Se não houver contraindicações, a médica emite a Receita Sem Papel diretamente no sistema informático. Receberá a receita no seu email em formato PDF com o código para apresentar na farmácia. Válida em todo o território nacional.</p>

    <h3>4. Na farmácia</h3>
    <p>Apresente o código da receita (ou o PDF no telemóvel) em qualquer farmácia. A comparticipação do SNS é aplicada automaticamente. A maioria das pílulas combinadas tem comparticipação entre 37% e 69%.</p>

    <div class="ibox"><div class="ibox-title">📋 O que preparar antes da consulta</div>
    <ul style="margin:8px 0 0">
      <li>Nome comercial da pílula atual (ou a embalagem)</li>
      <li>Há quanto tempo toma esta pílula</li>
      <li>Data da última menstruação</li>
      <li>Tensão arterial recente (se souber)</li>
      <li>Lista de outros medicamentos que toma</li>
      <li>Doenças crónicas diagnosticadas</li>
    </ul>
    </div>

    <h2>A receita tem comparticipação do SNS?</h2>
    <p>Sim. A receita eletrónica emitida numa consulta online tem exatamente o mesmo valor legal que uma receita de consulta presencial. A comparticipação do SNS aplicada na farmácia é a mesma — entre 37% e 95% dependendo do medicamento e do escalão de rendimento.</p>

    <h2>Não tenho médico de família. Posso fazer na mesma?</h2>
    <p>Sim, sem qualquer problema. A consulta online funciona de forma completamente independente do SNS — não precisa de médico de família atribuído, de número de utente ou de qualquer outra condição prévia. Em Portugal, mais de 1,5 milhões de mulheres não têm médico de família atribuído. Para muitas delas, a consulta online é a única forma de aceder a cuidados de saúde sem recorrer a uma urgência.</p>

    <h2>Quanto custa e o que está incluído?</h2>
    <p>A consulta de renovação de medicamentos custa <strong>40€</strong> e inclui:</p>
    <ul>
      <li>Videoconsulta com médica inscrita na Ordem dos Médicos</li>
      <li>Avaliação clínica completa</li>
      <li>Emissão da Receita Sem Papel (se indicado)</li>
      <li>Fatura eletrónica certificada pela AT, enviada por email</li>
      <li>Disponibilidade de segunda a domingo, das 9h às 21h</li>
    </ul>

    <h2>Dúvidas frequentes</h2>

    <h3>Posso pedir receita para 3 ou 6 meses de uma vez?</h3>
    <p>Sim. A médica pode emitir uma receita com até 6 embalagens, o que equivale a 6 meses de contraceção. Informe na consulta que prefere uma prescrição de maior duração.</p>

    <h3>Posso mudar de pílula na consulta online?</h3>
    <p>Depende do motivo. Se os sintomas que quer resolver são ligeiros (spotting, náuseas, alterações de humor), a médica pode sugerir uma alternativa por videoconsulta. Se os sintomas forem mais complexos, pode ser necessária avaliação adicional.</p>

    <h3>E se a médica não puder prescrever?</h3>
    <p>Se por alguma razão clínica a renovação não puder ser feita online, a médica informa-a dos próximos passos recomendados. Nesse caso, a consulta não é cobrada.</p>

    <h3>A consulta é confidencial?</h3>
    <p>Sim. Toda a informação está sujeita ao sigilo médico e ao RGPD. Os seus dados não são partilhados com terceiros.</p>

    <h3>Posso fazer a consulta pelo telemóvel?</h3>
    <p>Sim. A videoconsulta funciona em qualquer dispositivo com câmara e microfone — telemóvel, tablet ou computador. Não é necessário instalar nenhuma aplicação.</p>

    <div class="art-cta">
      <h3>Renovar a pílula hoje, sem sair de casa</h3>
      <p>Videoconsulta com médica. Receita no email no próprio dia. Disponível de segunda a domingo das 9h às 21h.</p>
      <a href="/">Marcar Consulta — 40€</a>
    </div>

    <div class="refs"><h3>Referências</h3><ol class="ref-list">
      <li>INFARMED. <em>Normas de Prescrição Eletrónica de Medicamentos.</em> 2023.</li>
      <li>DGS. <em>Orientação n.º 004/2021 — Contraceção Hormonal Combinada.</em> 2021.</li>
      <li>Ordem dos Médicos. <em>Regulamento de Telemedicina.</em> 2020.</li>
      <li>Faculty of Sexual &amp; Reproductive Healthcare. <em>FSRH Guideline: Combined Hormonal Contraception.</em> 2023.</li>
      <li>WHO. <em>Medical Eligibility Criteria for Contraceptive Use, 5th edition.</em> 2015 (updated 2024).</li>
      <li>Decreto-Lei n.º 10-A/2020 de 13 de março — Enquadramento da Telemedicina em Portugal.</li>
    </ol></div>
  `
},

'baixa-medica-freelancer': {
  title: 'Baixa Médica para Trabalhadores Independentes: Guia Completo | ConsultasOnline',
  description: 'Tens direito a baixa médica sendo freelancer? Como funciona o CIT, o subsídio de doença e como resolver tudo por videoconsulta.',
  keywords: 'baixa médica freelancer portugal, baixa médica trabalhador independente, CIT recibos verdes, subsídio doença freelancer',
  h1: 'Baixa Médica para Recibos Verdes e Freelancers: Guia Completo 2026',
  content: `<div class="cta-top"><p>💼 Trabalhas por conta própria e precisas de baixa médica? CIT emitido por videoconsulta em 20 minutos. <a href="/">Marcar consulta — 55€ →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<p>Sim. Um trabalhador independente pode pedir baixa médica e receber subsídio de doença, desde que cumpra determinados requisitos da Segurança Social. Neste artigo explicamos quem tem direito, quanto recebe, quando começa a receber e como pedir a baixa online.</p>

  <div class="ibox"><div class="ibox-title">📋 Neste guia vai descobrir</div>
  <ul>
    <li>✔ Quem tem direito</li>
    <li>✔ Quanto recebe</li>
    <li>✔ Quando começa o pagamento</li>
    <li>✔ Como pedir online</li>
    <li>✔ O que fazer se estiver isento</li>
  </ul></div>

  <h2>Quem tem direito a baixa médica sendo trabalhador independente?</h2>
  <p>Trabalhar por conta própria em Portugal, seja como freelancer, prestador de serviços a recibos verdes ou empresário em nome individual, traz uma pergunta que mais cedo ou mais tarde surge: e se eu ficar doente? Ao contrário de um trabalhador por conta de outrem, o trabalhador independente não tem um empregador que assegura o vencimento durante a ausência, nem um departamento de recursos humanos que trata da baixa médica junto da Segurança Social. Neste guia encontra respostas claras às dúvidas mais frequentes dos trabalhadores independentes sobre a baixa médica.</p>

  <h2>O que é a baixa médica e o Certificado de Incapacidade Temporária?</h2>
  <p>A expressão baixa médica é o termo popular para o Certificado de Incapacidade Temporária para o Trabalho, conhecido pela sigla CIT. Trata-se de um documento clínico emitido por um médico, que atesta que uma pessoa está temporariamente incapaz de exercer a sua atividade profissional por motivo de doença. O CIT é o documento que, uma vez enviado à Segurança Social, desencadeia o direito ao subsídio de doença, quando os restantes requisitos legais estão cumpridos.</p>
  <p>É importante não confundir os dois conceitos: ter um CIT não significa automaticamente receber o subsídio de doença. O CIT comprova a incapacidade para o trabalho perante clientes, entidades contratantes ou tribunais, enquanto o subsídio de doença é a prestação pecuniária paga pela Segurança Social a quem, além de ter CIT, cumpre o prazo de garantia contributivo e demais condições legais.</p>

  <h2>Os trabalhadores independentes têm direito a baixa médica?</h2>
  <p>Sim. Qualquer trabalhador independente inscrito na Segurança Social, seja a título de atividade empresarial ou profissional (o chamado regime de recibos verdes), tem, em princípio, direito ao subsídio de doença. Obviamente, desde que cumpra os requisitos legais aplicáveis a este regime contributivo. A proteção na doença dos trabalhadores independentes está prevista no Código dos Regimes Contributivos do Sistema Previdencial de Segurança Social, aprovado pela <a href="https://diariodarepublica.pt/dr/detalhe/lei/110-2009-490249" target="_blank" style="color:var(--teal)">Lei n.º 110/2009, de 16 de setembro</a>, e nos diplomas regulamentares que se lhe seguiram.</p>

  <h3>Diferenças entre trabalhador independente e trabalhador por conta de outrem</h3>
  <p>A proteção social do trabalhador independente não é exatamente igual à do trabalhador por conta de outrem. Existem diferenças relevantes ao nível do número de dias de espera até começar a receber o subsídio, da duração máxima da baixa e das obrigações declarativas trimestrais que condicionam o valor da remuneração de referência. Vamos detalhar cada um destes pontos neste artigo.</p>

  <h2>Quais os requisitos para ter direito ao subsídio de doença sendo freelancer?</h2>
  <p>Para que um trabalhador independente possa receber o subsídio de doença, tem de reunir cumulativamente as seguintes condições:</p>
  <ul>
    <li>Estar inscrito na Segurança Social como trabalhador independente (atividade empresarial ou profissional), com a atividade devidamente aberta nas Finanças e comunicada à Segurança Social</li>
    <li>Ter um Certificado de Incapacidade Temporária (CIT) válido, emitido por um médico, atestando a incapacidade para o trabalho</li>
    <li>Cumprir o prazo de garantia: ter, no mínimo, seis meses de contribuições para a Segurança Social, seguidos ou interpolados, antes do início da baixa</li>
    <li>Ter a situação contributiva regularizada, ou seja, não ter dívidas às Finanças nem à Segurança Social</li>
    <li>Não estar em regime de isenção de contribuições no momento da baixa</li>
  </ul>
  <div class="ibox warn"><div class="ibox-title">⚠️ Se está isento de contribuições</div><p>Se está isento de contribuições para a Segurança Social (por exemplo, por acumular atividade independente com trabalho por conta de outrem, ou por não atingir o limiar mínimo de faturação), não tem direito ao subsídio de doença enquanto durar a isenção. Ainda assim, pode e deve pedir a emissão do CIT para justificar a ausência de trabalho junto de clientes e entidades contratantes, mesmo sem receber qualquer prestação da Segurança Social.</p></div>

  <h3>O prazo de garantia de seis meses</h3>
  <p>O prazo de garantia corresponde ao período mínimo de contribuições que o trabalhador independente tem de ter acumulado antes do início da incapacidade para poder aceder ao subsídio de doença. A regra é simples: são necessários seis meses, seguidos ou interpolados, com registo de remunerações ou de rendimento relevante declarado à Segurança Social. Para efeitos de contagem, pode inclusive ser considerado o próprio mês em que a baixa se inicia, desde que tenha havido pelo menos um dia de atividade e contribuição nesse mês.</p>
  <p>Além do prazo de garantia, exige-se ainda que as contribuições estejam pagas até ao final do terceiro mês anterior ao início da incapacidade. Quem tem contribuições em atraso, mesmo que cumpra os seis meses de descontos, vê o pedido de subsídio recusado até regularizar a situação.</p>

  <h3>Situação contributiva regularizada e obrigações trimestrais</h3>
  <p>Os trabalhadores independentes a recibos verdes têm de entregar uma declaração trimestral de rendimentos à Segurança Social, indicando os montantes faturados nos três meses anteriores. É com base nesta declaração que a Segurança Social apura o rendimento relevante, que serve de base à contribuição mensal seguinte e, mais tarde, ao cálculo da remuneração de referência em caso de baixa médica.</p>
  <div class="ibox"><div class="ibox-title">💡 IAS 2026</div><p>O valor do IAS para 2026 é de 537,13 euros, fixado pela <a href="https://diariodarepublica.pt/dr/detalhe/portaria/480-a-2025-993056222" target="_blank" style="color:var(--teal)">Portaria n.º 480-A/2025/1, de 30 de dezembro</a>. Este indexante é usado, entre outros efeitos, para calcular o limite máximo da base de incidência contributiva dos trabalhadores independentes e para determinar diversos apoios sociais.</p></div>

  <h2>Quais as diferenças entre trabalhador independente e trabalhador por conta de outrem relativamente ao subsídio de doença?</h2>
  <p>Embora as regras gerais do subsídio de doença sejam comuns aos vários regimes, existem diferenças concretas entre um trabalhador por conta de outrem e um trabalhador independente:</p>
  <ul>
    <li><strong>Dias de espera:</strong> o trabalhador por conta de outrem começa a receber o subsídio a partir do 4.º dia de baixa; o trabalhador independente só começa a receber a partir do <a href="https://www.seg-social.pt/ptss/pssd/documento/cmdde8gsx000qi12yzi40plc6?dswid=5276" target="_blank" style="color:var(--teal)">11.º dia</a>, ou seja, tem um período de espera de dez dias sem qualquer apoio da Segurança Social</li>
    <li><strong>Duração máxima:</strong> o trabalhador por conta de outrem pode receber o subsídio de doença até 1.095 dias (três anos); o trabalhador independente e o bolseiro estão limitados a 365 dias (um ano). Há uma exceção que é o caso de baixa médica por tuberculose, que não tem limite temporal</li>
    <li><strong>Cálculo da remuneração de referência:</strong> no caso do trabalhador independente, este cálculo tem por base o rendimento relevante declarado trimestralmente, e não o salário bruto mensal como acontece no regime geral</li>
    <li><strong>Ausência de entidade empregadora:</strong> o trabalhador independente não tem de comunicar a baixa a um empregador, mas deve informar os seus clientes. Na maioria dos casos vai ser necessário suspender a faturação de serviços durante o período de incapacidade, com as implicações económicas associadas</li>
  </ul>
  <p>Estas diferenças traduzem, no essencial, uma proteção social mais limitada para quem trabalha por conta própria, o que reforça a importância de planear financeiramente eventuais períodos de baixa e de garantir a regularidade das contribuições para a Segurança Social.</p>

  <h2>Como é emitido o CIT: baixa médica online por videoconsulta?</h2>
  <p>Uma das perguntas mais frequentes de quem necessita de baixa médica sendo trabalhador independente é se é possível obter o CIT sem se deslocar a uma unidade de saúde. A resposta é sim. Desde a regulamentação da teleconsulta para efeitos de emissão de CIT, qualquer médico registado na Ordem dos Médicos pode emitir o certificado através de uma consulta médica online, por <a href="/artigos/consulta-online">videoconsulta</a>, com o mesmo valor legal de uma consulta presencial.</p>
  <p>Para um freelancer, esta possibilidade é particularmente útil: evita deslocações, permite marcar consulta fora do horário convencional (muitas plataformas disponibilizam atendimento todos os dias da semana, incluindo fins de semana) e reduz o tempo de espera entre o aparecimento dos sintomas e a emissão do documento que formaliza a incapacidade para o trabalho.</p>

  <h3>O trabalhador independente tem de se dirigir à Segurança Social para entrega do CIT?</h3>
  <p>Na maioria dos casos, o CIT é atualmente enviado de forma eletrónica pelo médico diretamente à Segurança Social, o que dispensa o trabalhador de qualquer diligência adicional. Quando o CIT é emitido em suporte de papel, o original deve ser remetido pelo próprio trabalhador, no prazo de cinco dias úteis a contar da data de emissão, aos serviços da Segurança Social da área de residência.</p>

  <h2>Quanto tempo demora a receber o subsídio de doença sendo trabalhador independente?</h2>
  <p>O trabalhador independente só tem direito ao subsídio de doença a partir do <a href="https://www.seg-social.pt/ptss/pssd/documento/cmdde8gsx000qi12yzi40plc6?dswid=5276" target="_blank" style="color:var(--teal)">11.º dia de incapacidade</a>. Isto significa que, nos primeiros dez dias de baixa, não existe qualquer pagamento por parte da Segurança Social, ainda que o CIT já esteja emitido e válido desde o primeiro dia. Este período de espera é significativamente mais longo do que o aplicável ao trabalhador por conta de outrem, pelo que muitos freelancers optam por manter uma reserva financeira de segurança para cobrir estes dias iniciais.</p>
  <p>Depois de reconhecido o direito, o pagamento do subsídio é feito diretamente para o IBAN associado ao trabalhador junto da Segurança Social Direta, sem necessidade de requerimento manual, uma vez que a informação do CIT é transmitida diretamente pelos serviços de saúde.</p>

  <h2>Quanto vale o subsídio de doença para trabalhador independente?</h2>
  <p>O valor do subsídio de doença corresponde a uma percentagem da remuneração de referência do trabalhador independente, calculada com base na média do rendimento relevante declarado nos meses anteriores ao início da baixa. Para a generalidade das situações de doença natural, a percentagem aplicável é de <a href="https://www.seg-social.pt/ptss/pssd/documento/cmdde8gsx000qi12yzi40plc6?dswid=5276" target="_blank" style="color:var(--teal)">55% da remuneração de referência</a>.</p>
  <p>Este valor pode variar, subindo progressivamente consoante a duração da baixa em algumas modalidades de doença ou em situações especiais previstas na lei, como hospitalização, tuberculose ou doenças graves, casos em que o subsídio pode ser atribuído desde o primeiro dia e a percentagem aplicável pode ser superior.</p>
  <div class="ibox"><div class="ibox-title">💡 Importante</div><p>Quanto maior for o rendimento relevante declarado à Segurança Social ao longo do tempo, maior será a remuneração de referência e, consequentemente, maior o valor do subsídio de doença em caso de baixa. Reduzir a base de incidência contributiva para pagar menos por mês tem como contrapartida um subsídio de doença mais baixo caso venha a ser necessário.</p></div>

  <h2>Duração máxima da baixa e Sistema de Verificação de Incapacidades</h2>
  <p>Os trabalhadores independentes podem beneficiar do subsídio de doença durante um período máximo de 365 dias, salvo no caso de tuberculose, doença sem limite temporal de atribuição. Atingido este limite, o trabalhador é encaminhado para avaliação de eventual pensão provisória de invalidez, caso a incapacidade persista.</p>
  <p>Em baixas mais prolongadas, tipicamente a partir dos 30 dias, a Segurança Social pode convocar o beneficiário para o <strong>Sistema de Verificação de Incapacidades (SVI)</strong>, popularmente conhecido como junta médica. A convocatória é feita por SMS ou email e a comparência é obrigatória, sob pena de cessação imediata do subsídio. É aconselhável levar a esta avaliação todos os exames médicos atualizados, relatórios de especialidade e histórico clínico relevante.</p>

  <h2>Como pedir baixa médica sendo freelancer: passo a passo</h2>
  <ol>
    <li>Marcar uma consulta médica, presencial ou por videoconsulta, assim que surgirem sintomas que impeçam o exercício normal da atividade profissional</li>
    <li>O médico avalia a situação clínica e, se justificado, emite o Certificado de Incapacidade Temporária (CIT), indicando o período de incapacidade previsto</li>
    <li>O CIT é normalmente transmitido de forma eletrónica à Segurança Social pelo próprio médico; se for emitido em papel, o trabalhador deve enviá-lo no prazo de cinco dias úteis</li>
    <li>A Segurança Social verifica automaticamente o cumprimento dos requisitos (prazo de garantia, situação contributiva regularizada, ausência de isenção)</li>
    <li>Não sendo necessário qualquer requerimento adicional na maioria dos casos, o subsídio de doença, quando devido, é pago diretamente no IBAN do trabalhador a partir do 11.º dia de incapacidade</li>
    <li>O trabalhador deve informar os seus clientes e, se necessário, suspender temporariamente a faturação de novos serviços durante o período abrangido pelo CIT</li>
  </ol>

  <div class="ibox"><div class="ibox-title">📋 Resumo: o que deve recordar sobre a baixa médica</div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">
    <tr style="border-bottom:1px solid rgba(13,115,119,.2)"><th style="padding:8px 0;text-align:left;color:var(--navy)">Tema</th><th style="padding:8px 0;text-align:left;color:var(--navy)">Freelancer</th></tr>
    <tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0;color:var(--slate)">Dias de espera</td><td style="padding:8px 0;color:var(--navy);font-weight:600">10 dias</td></tr>
    <tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0;color:var(--slate)">Início do pagamento</td><td style="padding:8px 0;color:var(--navy);font-weight:600">11.º dia</td></tr>
    <tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0;color:var(--slate)">Prazo de garantia</td><td style="padding:8px 0;color:var(--navy);font-weight:600">6 meses</td></tr>
    <tr style="border-bottom:1px solid var(--border)"><td style="padding:8px 0;color:var(--slate)">Duração máxima</td><td style="padding:8px 0;color:var(--navy);font-weight:600">365 dias</td></tr>
    <tr><td style="padding:8px 0;color:var(--slate)">CIT online</td><td style="padding:8px 0;color:var(--navy);font-weight:600">Sim</td></tr>
  </table></div>

  <h2>Por que motivo a consulta online é vantajosa para freelancers?</h2>
  <p>Para quem trabalha por conta própria, o tempo é, em regra, diretamente convertido em rendimento, o que torna especialmente relevante minimizar o tempo perdido em deslocações e esperas. A consulta médica online permite obter o CIT de forma célere, muitas vezes em poucos minutos, com disponibilidade alargada, incluindo ao fim de semana, e com fatura emitida automaticamente para efeitos de dedução em sede de IRS. Esta rapidez é particularmente útil em situações de doença súbita, quando o freelancer precisa de justificar de imediato a incapacidade perante clientes e assegurar, em simultâneo, o cumprimento dos prazos legais de comunicação do CIT à Segurança Social.</p>

  <h3>A consulta médica online para obtenção da baixa médica pode ser deduzida no IRS?</h3>
  <p>Sim. Tratando-se de uma despesa de saúde, o valor pago numa consulta médica online, incluindo aquela que dá origem à emissão do CIT, é uma despesa dedutível no IRS, desde que a fatura seja emitida com o número de contribuinte do trabalhador e comunicada automaticamente à Autoridade Tributária, tal como acontece com qualquer outra despesa de saúde. Para freelancers, este benefício fiscal reduz o custo efetivo de recorrer a este tipo de serviço sempre que necessário.</p>
  <p>A baixa médica protege o rendimento dos trabalhadores independentes quando a doença impede o exercício da atividade profissional. Conhecer os requisitos legais, manter a situação contributiva regularizada e pedir o CIT atempadamente permite evitar atrasos no acesso ao subsídio de doença.</p>
  <p><em>Este artigo foi revisto por médico inscrito na Ordem dos Médicos e atualizado segundo a legislação em vigor em 2026.</em></p>

  <div class="art-cta"><h3>Precisas de baixa médica hoje?</h3><p>Videoconsulta em 20 minutos. CIT submetido à Segurança Social no próprio dia. Sem perder tempo de trabalho.</p><a href="/">Marcar Consulta Online →</a></div>

  <h2>Perguntas frequentes</h2>

  <div class="faq"><h4>Um trabalhador independente tem direito a baixa médica?</h4><p>Sim. Os trabalhadores independentes inscritos na Segurança Social podem beneficiar do subsídio de doença, desde que cumpram os requisitos legais, como possuir um Certificado de Incapacidade Temporária (CIT), cumprir o prazo de garantia e ter a situação contributiva regularizada.</p></div>
  <div class="faq"><h4>Quantos meses de descontos são necessários para receber o subsídio de doença?</h4><p>É necessário ter, pelo menos, seis meses de contribuições para a Segurança Social, seguidos ou interpolados, antes do início da incapacidade temporária para o trabalho. Além disso, as contribuições devem estar regularizadas até ao final do terceiro mês anterior ao início da baixa.</p></div>
  <div class="faq"><h4>Quanto tempo tenho de esperar para receber o subsídio de doença sendo trabalhador independente?</h4><p>O subsídio de doença só é pago a partir do 11.º dia de incapacidade, o que corresponde a um período de espera de dez dias sem qualquer apoio da Segurança Social, salvo situações especiais como tuberculose ou hospitalização.</p></div>
  <div class="faq"><h4>O que acontece se eu estiver isento de contribuições para a Segurança Social?</h4><p>Se estiver isento de contribuições, não tem direito ao subsídio de doença enquanto durar a isenção. Ainda assim, pode pedir a emissão do CIT para justificar a ausência de atividade perante clientes.</p></div>
  <div class="faq"><h4>Quanto vale o subsídio de doença para um freelancer em 2026?</h4><p>Na generalidade das situações de doença natural, o subsídio corresponde a 55% da remuneração de referência, calculada com base no rendimento relevante declarado trimestralmente à Segurança Social.</p></div>
  <div class="faq"><h4>Preciso de entregar algum requerimento para pedir o subsídio de doença?</h4><p>Não, na maioria dos casos. O CIT é enviado eletronicamente pelo médico à Segurança Social, que verifica automaticamente os requisitos e efetua o pagamento diretamente no IBAN do trabalhador, sem necessidade de requerimento manual.</p></div>
  <div class="faq"><h4>Durante quanto tempo posso receber o subsídio de doença sendo trabalhador independente?</h4><p>O limite máximo é de 365 dias, exceto em caso de tuberculose, situação em que não existe limite temporal de atribuição do subsídio.</p></div>
  <div class="faq"><h4>O que acontece se a baixa se prolongar por muito tempo?</h4><p>Em baixas prolongadas, geralmente a partir dos 30 dias, a Segurança Social pode convocar o trabalhador para uma avaliação no Sistema de Verificação de Incapacidades (junta médica), para confirmar a persistência da incapacidade.</p></div>
  <div class="faq"><h4>Durante a baixa médica posso continuar a trabalhar ou emitir recibos verdes?</h4><p>O Certificado de Incapacidade Temporária pressupõe que existe incapacidade para exercer a atividade profissional. Continuar a trabalhar ou prestar serviços durante esse período pode ser incompatível com a finalidade da baixa médica e ter implicações legais e no direito ao subsídio.</p></div>
  <div class="faq"><h4>Posso ter baixa médica sem ter médico de família?</h4><p>Sim. Qualquer médico registado na Ordem dos Médicos, incluindo através de consulta por videoconsulta, pode emitir o Certificado de Incapacidade Temporária (CIT), independentemente de o trabalhador ter ou não médico de família atribuído.</p></div>
  <div class="faq"><h4>Posso pedir baixa médica através de uma consulta online?</h4><p>Sim. Em determinadas situações, o Certificado de Incapacidade Temporária (CIT) pode ser emitido durante uma videoconsulta, desde que o médico considere existirem condições clínicas para o fazer e sejam cumpridas as regras aplicáveis.</p></div>
  <div class="faq"><h4>Posso deduzir a consulta médica online no IRS?</h4><p>Sim. É considerada uma despesa de saúde dedutível no IRS, desde que a fatura seja emitida com o número de contribuinte e comunicada automaticamente à Autoridade Tributária.</p></div>
  <div class="faq"><h4>O que é a Segurança Social Direta e para que serve neste processo?</h4><p>É o portal online da Segurança Social onde o trabalhador independente pode consultar o estado do pedido de subsídio de doença, confirmar o IBAN de pagamento e submeter documentação adicional, quando aplicável.</p></div>

  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>Assembleia da República. (2009). Lei n.º 110/2009, de 16 de setembro. <em>Código dos Regimes Contributivos do Sistema Previdencial de Segurança Social. Diário da República.</em></li>
    <li>Governo de Portugal. (2025). Portaria n.º 480-A/2025/1, de 30 de dezembro. Atualização do valor do Indexante dos Apoios Sociais (IAS) para 2026. <em>Diário da República.</em></li>
    <li>Segurança Social. (2026). <em>Subsídio de doença. Guia Prático.</em> Instituto da Segurança Social, I.P.</li>
    <li>Segurança Social. (2026). Obter informações sobre o subsídio de doença. gov.pt. Disponível em: gov.pt/servicos/obter-informacoes-sobre-o-subsidio-de-doenca</li>
    <li>Segurança Social. (2026). <em>Novo Regime dos Trabalhadores independentes.</em> Instituto da Segurança Social, I.P.</li>
  </ol></div>

  <p style="font-size:12px;color:var(--muted);margin-top:24px;font-style:italic">Este artigo tem caráter informativo geral e não substitui aconselhamento médico ou jurídico individualizado. As condições de acesso a prestações sociais podem variar consoante a situação contributiva concreta de cada trabalhador independente. Consulte sempre a Segurança Social Direta para confirmar a sua elegibilidade específica.</p>
  `
},

'sem-medico-familia-freelancer': {
  title: 'Sem Médico de Família: Guia Completo para Freelancers em Portugal | ConsultasOnline',
  description: 'O que podes e não podes fazer sem médico de família em Portugal. Soluções práticas para freelancers e trabalhadores remotos.',
  keywords: 'sem médico de família portugal, alternativas médico de família, lista espera médico família, médico online sem médico família freelancer',
  h1: 'Sem Médico de Família: Guia Completo para Freelancers em Portugal',
  content: `<div class="cta-top"><p>🏠 Não tens médico de família? A consulta online funciona independentemente do SNS. <a href="/">Marcar consulta →</a></p></div>

<div class="art-author">✍️ <span>Escrito por <strong>Patrícia Ferraz</strong> · Médica · Cédula n.º 57713</span></div>
<div class="ibox"><div class="ibox-title">📊 Sabia que?</div><p>Em Portugal, mais de <strong>1 milhão de pessoas</strong> não têm médico de família atribuído. Entre freelancers e trabalhadores remotos, a percentagem é ainda mais elevada — mudanças de morada frequentes, inscrições em centros de saúde diferentes e listas de espera intermináveis.</p></div>

  <h2>Porque os freelancers ficam sem médico de família</h2>
  <p>Ao contrário do trabalhador por conta de outrem que mantém a mesma morada e o mesmo centro de saúde durante anos, os freelancers têm uma vida mais móvel — mudam de cidade, trabalham de casa, viajam. Este estilo de vida, embora vantajoso em muitos aspectos, complica o acesso ao SNS.</p>
  <ul>
    <li><strong>Mudança de morada</strong> — necessita de nova inscrição no centro de saúde local</li>
    <li><strong>Listas de espera</strong> — mesmo inscrito, a atribuição de médico pode demorar meses</li>
    <li><strong>Horários incompatíveis</strong> — os centros de saúde funcionam em horário comercial</li>
    <li><strong>Nómadas digitais</strong> — sem morada fixa, a inscrição no SNS é praticamente impossível</li>
  </ul>

  <h2>O que podes fazer sem médico de família</h2>
  <p>Não ter médico de família não significa ficar sem acesso a cuidados de saúde. Há várias alternativas — e a telemedicina é a mais eficiente para quem trabalha por conta própria.</p>

  <h3>1. Baixa médica (CIT)</h3>
  <p>Podes obter o Certificado de Incapacidade Temporária por videoconsulta com qualquer médico registado na Ordem dos Médicos. O CIT é submetido electronicamente à Segurança Social — exactamente como faria o médico de família.</p>

  <h3>2. Renovação de medicação crónica</h3>
  <p>Se tens tensão arterial, diabetes, colesterol ou outra doença crónica controlada, podes renovar a medicação por videoconsulta. A Receita Sem Papel é enviada por SMS e email — válida em todas as farmácias.</p>

  <h3>3. Atestados médicos</h3>
  <p>Atestado de amamentação, atestado para carta de condução, declaração de falta escolar — todos podem ser emitidos por videoconsulta, com validade legal total.</p>

  <h3>4. Rastreio de saúde</h3>
  <p>Pedido de análises de rotina — colesterol, glicemia, função tiroideia, PSA, IST — sem precisar de médico de família. O pedido de análises é enviado por email.</p>

  <h3>5. Consulta de infeção urinária</h3>
  <p>Diagnóstico e prescrição de antibiótico para cistite não complicada em mulheres adultas — sem urgências, sem filas, em 20 minutos.</p>

  <h2>O que NÃO podes fazer sem médico de família</h2>
  <ul>
    <li>Consultas de vigilância de saúde infantil</li>
    <li>Rastreios oncológicos do SNS (cancro da mama, colo do útero, cólon)</li>
    <li>Referenciação para especialidade pelo SNS</li>
    <li>Prescrição de medicamentos de dispensa hospitalar</li>
  </ul>

  <div class="ibox warn"><div class="ibox-title">⚠️ Como inscrever-te no SNS</div><p>Para ter médico de família, inscreve-te no centro de saúde da tua área de residência com o cartão de cidadão e comprovativo de morada. Podes também fazê-lo online em <strong>sns24.gov.pt</strong>. A atribuição de médico pode demorar meses — por isso a videoconsulta é a solução imediata.</p></div>

  <h2>Telemedicina para freelancers — porquê faz sentido</h2>
  <p>Para quem trabalha por conta própria, o tempo é o recurso mais valioso. Uma consulta presencial num centro de saúde ou clínica privada implica deslocação, espera e consulta — facilmente 2 a 3 horas. Uma videoconsulta resolve o problema em 20 minutos, no browser, sem sair de casa.</p>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0">
    <div style="background:var(--surface);border-radius:10px;padding:14px;border-left:3px solid var(--red)">
      <div style="font-weight:700;font-size:13px;color:var(--navy);margin-bottom:6px">❌ Consulta presencial</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6">Deslocação + espera + consulta = 2 a 3 horas perdidas</div>
    </div>
    <div style="background:var(--surface);border-radius:10px;padding:14px;border-left:3px solid var(--teal)">
      <div style="font-weight:700;font-size:13px;color:var(--navy);margin-bottom:6px">✅ Videoconsulta</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6">20 minutos no browser. Documentos por email. Volta ao trabalho.</div>
    </div>
  </div>

  <h2>Custos e reembolsos</h2>
  <p>Uma videoconsulta na ConsultasOnline custa entre <strong>35€ e 55€</strong> consoante o serviço. A fatura AT é emitida automaticamente e é:</p>
  <ul>
    <li><strong>Dedutível no IRS</strong> como despesa de saúde</li>
    <li><strong>Aceite por seguros de saúde</strong> — Médis, AdvanceCare, Multicare, Fidelidade</li>
    <li><strong>Dedutível como despesa profissional</strong> se a consulta estiver relacionada com a actividade</li>
  </ul>

  <h2>Perguntas frequentes</h2>

  <h3>Posso usar a ConsultasOnline se estiver noutro país?</h3>
  <p>Sim, desde que sejas residente fiscal em Portugal. A videoconsulta funciona em qualquer país — precisas apenas de ligação à internet. Os documentos têm validade legal em Portugal.</p>

  <h3>E se precisar de uma especialidade médica?</h3>
  <p>Para consultas de especialidade precisas de consulta privada presencial ou teleconsulta especializada. A ConsultasOnline é focada em medicina geral — os problemas mais comuns do dia a dia.</p>

  <h3>Como funciona a fatura para efeitos fiscais?</h3>
  <p>A fatura é emitida com NIF, certificada pela AT e enviada por email em menos de 30 segundos após o pagamento. Válida para dedução no IRS e como despesa profissional.</p>

  <div class="art-cta"><h3>O médico online para freelancers</h3><p>Baixa médica, atestados e renovação de receitas em 20 minutos. Sem perder tempo de trabalho. Fatura AT incluída.</p><a href="/">Marcar Consulta Online →</a></div>

  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>SNS. <em>Inscrição no Centro de Saúde.</em> sns24.gov.pt.</li>
    <li>Segurança Social. <em>Trabalhadores Independentes — Prestações.</em> seg-social.pt.</li>
    <li>Decreto-Lei n.º 2/2024, de 5 de janeiro. <em>CIT por teleconsulta.</em> Ministério da Saúde.</li>
    <li>AT. <em>Despesas de Saúde — IRS 2024.</em> portaldasfinancas.gov.pt.</li>
  </ol></div>
  `
},

'dia-saude-2026': {
  title: 'Dia Mundial da Saúde 2026: Juntos pela Ciência | ConsultasOnline',
  description: '7 de Abril — o que significa este dia, qual o tema da OMS em 2026 e o que pode fazer hoje pela sua saúde em Portugal.',
  keywords: 'dia mundial saúde 2026, OMS saúde 2026, saúde portugal 2026, telemedicina ciência portugal',
  h1: 'Dia Mundial da Saúde 2026: Juntos pela Ciência',
  content: `<div class="cta-top"><p>🌍 Cuide da sua saúde hoje. Consultas médicas online disponíveis de segunda a domingo. <a href="/">Marcar consulta →</a></p></div>

<div class="ibox"><div class="ibox-title">📅 7 de Abril — Dia Mundial da Saúde</div><p>Celebrado anualmente a 7 de Abril, o Dia Mundial da Saúde assinala a fundação da Organização Mundial da Saúde (OMS) em 1948. Em 2026, o tema é <strong>"Juntos pela Ciência"</strong> — um apelo global à confiança na evidência científica como pilar fundamental para proteger a saúde de todos.</p></div>

  <h2>O tema de 2026: Juntos pela Ciência</h2>
  <p>A OMS escolheu para 2026 um tema que reflecte um momento crítico para a saúde global: <strong>"Juntos pela Ciência"</strong>. Num período em que a desinformação e o ceticismo científico ameaçam conquistas históricas da medicina, a campanha apela à confiança nos dados, nas vacinas e nas decisões baseadas em evidência.</p>
  <p>A mensagem é clara: sem ciência, não há vacinas, não há antibióticos, não há tratamentos para doenças crónicas. A colaboração científica internacional foi o que tornou possível responder à pandemia de Covid-19 e continua a ser a única forma de enfrentar os desafios de saúde do futuro.</p>

  <h2>Porque a ciência importa para a sua saúde no dia a dia</h2>
  <p>Muitas das decisões médicas que tomamos todos os dias — que antibiótico tomar para uma amigdalite, quando renovar a carta de condução, como tratar uma infeção urinária — baseiam-se em décadas de investigação científica. As guidelines clínicas que os médicos seguem são o resultado de milhares de estudos e ensaios clínicos.</p>
  <p>Na ConsultasOnline, todos os serviços seguem as orientações da <strong>Direcção-Geral de Saúde (DGS)</strong> e das principais sociedades médicas europeias. Cada consulta, cada tratamento e cada atestado é emitido com base em evidência científica actualizada.</p>

  <h2>Os maiores desafios de saúde em Portugal em 2026</h2>
  <h3>Doenças crónicas não transmissíveis</h3>
  <p>As doenças cardiovasculares, diabetes, cancro e doenças respiratórias crónicas são as principais causas de morte em Portugal. A maioria é prevenível ou controlável com rastreio precoce, medicação adequada e mudança de hábitos — tudo suportado por evidência científica.</p>
  <h3>Resistência antimicrobiana</h3>
  <p>O uso excessivo e inadequado de antibióticos está a criar bactérias resistentes. Em Portugal, as guidelines da DGS recomendam o uso criterioso de antibióticos — por isso, numa consulta de amigdalite ou infeção urinária, o médico avalia cuidadosamente se o antibiótico é realmente necessário.</p>
  <h3>Acesso aos cuidados de saúde</h3>
  <p>Mais de um milhão de portugueses não tem médico de família atribuído. A telemedicina e as consultas online são uma resposta cientificamente validada para melhorar o acesso a cuidados de saúde primários — sem comprometer a qualidade ou a segurança.</p>

  <h2>O que pode fazer hoje pela sua saúde</h2>
  <ul>
    <li><strong>Rastreio preventivo</strong> — tensão arterial, glicemia, colesterol e rastreios oncológicos recomendados pela DGS</li>
    <li><strong>Vacinação</strong> — mantenha o Plano Nacional de Vacinação actualizado</li>
    <li><strong>Medicação crónica</strong> — não interrompa tratamentos sem consultar o médico</li>
    <li><strong>Consulta regular</strong> — mesmo sem sintomas, a avaliação periódica é fundamental</li>
    <li><strong>Informação fiável</strong> — recorra a fontes como a DGS, a OMS e profissionais de saúde</li>
  </ul>

  <div class="ibox warn"><div class="ibox-title">⚠️ Desinformação em saúde</div><p>Em caso de dúvida sobre qualquer informação de saúde que leia nas redes sociais, consulte um profissional de saúde ou verifique em fontes oficiais como <strong>dgs.pt</strong> ou <strong>who.int</strong>. A saúde é demasiado importante para depender de informação não verificada.</p></div>

  <h2>Telemedicina e ciência — uma combinação ao serviço da sua saúde</h2>
  <p>A telemedicina é um dos avanços científicos mais importantes da última década na área da saúde primária. Em Portugal, o Decreto-Lei n.º 2/2024, de 5 de janeiro reconhece legalmente a videoconsulta como forma válida de prestação de cuidados médicos — incluindo a emissão de baixas médicas, atestados e tratamentos.</p>
  <p>Na ConsultasOnline, utilizamos tecnologia segura para levar cuidados médicos a quem não tem acesso fácil a um médico presencial — seguindo exactamente os mesmos protocolos clínicos de uma consulta presencial.</p>

  <div class="art-cta"><h3>Cuide da sua saúde hoje</h3><p>Baixa médica, atestados, consulta de acompanhamento crónico e rastreio de DST — por videoconsulta, sem filas, no próprio dia.</p><a href="/">Marcar Consulta Online →</a></div>

  <div class="refs"><h3>Referências</h3><ol class="ref-list">
    <li>OMS/PAHO. <em>World Health Day 2026 — Together for Science.</em> who.int. 2026.</li>
    <li>DGS. <em>Programa Nacional de Saúde 2030.</em> dgs.pt.</li>
    <li>Decreto-Lei n.º 2/2024, de 5 de janeiro. <em>Certificado de Incapacidade Temporária por teleconsulta.</em> Ministério da Saúde.</li>
    <li>ECDC. <em>Antimicrobial Resistance in Europe.</em> 2025.</li>
  </ol></div>
  `
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
:root{--navy:#0b1d35;--teal:#0d7377;--slate:#4a5568;--muted:#8a9bb0;--border:#dde6f0;--surface:#f4f7fb;--red:#e53e3e;--amber:#d69e2e}
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
.ibox{border-left:3px solid #0d7377;border-radius:0 10px 10px 0;padding:16px 20px;margin:22px 0;background:rgba(13,115,119,.05)}
.ibox.warn{border-color:#d69e2e;background:rgba(214,158,46,.05)}
.ibox.danger{border-color:#e53e3e;background:rgba(229,62,62,.05)}
.ibox-title{font-weight:700;font-size:13.5px;color:#0b1d35;margin-bottom:7px}
.ibox p{margin:0;font-size:13.5px;line-height:1.6}
.art-author{font-size:13px;color:#64748b;margin-bottom:24px}
.art-cta{background:linear-gradient(135deg,rgba(13,115,119,.08),rgba(23,196,168,.08));border:1px solid rgba(13,115,119,.2);border-radius:12px;padding:22px;margin:28px 0;text-align:center}
.art-cta h3{margin-top:0}
.art-cta a{display:inline-block;background:#0d7377;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:700;font-size:14px}
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
  <h1>${data.h1 || data.title.split('|')[0].trim()}</h1>
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
            console.log('InvoiceXpress: nome nao encontrado por email, a pesquisar por nome...');
            try {
              const searchByName = await axios.get(
                'https://' + account + '.app.invoicexpress.com/clients.json?api_key=' + apiKey + '&client_name=' + encodeURIComponent(safeName)
              );
              const clientsByName = searchByName.data && searchByName.data.clients;
              const matchedByName = clientsByName && clientsByName.find(c => c.name && c.name.toLowerCase() === safeName.toLowerCase());
              if (matchedByName) {
                clientId = matchedByName.id;
                console.log('InvoiceXpress cliente encontrado por nome:', clientId);
              } else {
                const uniqueCode = safeEmail.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40) + '_' + Date.now().toString().slice(-6);
                const retryRes = await axios.post(
                  'https://' + account + '.app.invoicexpress.com/clients.json?api_key=' + apiKey,
                  { client: {
                      name: safeName,
                      email: safeEmail,
                      code: uniqueCode,
                      country: 'Portugal',
                      ...(safeNif ? { fiscal_id: safeNif } : {})
                  }}
                );
                clientId = retryRes.data.client.id;
                console.log('InvoiceXpress cliente criado com codigo unico:', clientId);
              }
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
