// Calculadora de IMC dos artigos (formulários <form class="imc-calc">).
// Usa delegação de eventos, por isso funciona também nos artigos carregados
// depois de a página abrir.
(function () {
  var CATS = [
    { max: 18.5, nome: 'Baixo peso', cor: '#3182ce', msg: 'O seu IMC está abaixo do recomendado. Se perdeu peso sem razão aparente, fale com um médico.' },
    { max: 25, nome: 'Peso normal', cor: '#38a169', msg: 'O seu IMC está dentro do intervalo recomendado. Mantenha uma alimentação equilibrada e atividade física regular.' },
    { max: 30, nome: 'Excesso de peso', cor: '#d69e2e', msg: 'O seu IMC indica excesso de peso (pré-obesidade). Uma avaliação médica ajuda a perceber o risco para a saúde e a definir um plano realista.' },
    { max: 35, nome: 'Obesidade grau I', cor: '#dd6b20', msg: 'O seu IMC indica obesidade grau I. Recomenda-se uma avaliação médica para definir um plano de tratamento.' },
    { max: 40, nome: 'Obesidade grau II', cor: '#e53e3e', msg: 'O seu IMC indica obesidade grau II. Recomenda-se uma avaliação médica para definir um plano de tratamento.' },
    { max: Infinity, nome: 'Obesidade grau III', cor: '#9b2c2c', msg: 'O seu IMC indica obesidade grau III. Recomenda-se uma avaliação médica para definir um plano de tratamento.' }
  ];
  function num(v) { return parseFloat(String(v || '').replace(',', '.').trim()); }
  function fmt(n) { return n.toFixed(1).replace('.', ','); }

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.classList || !f.classList.contains('imc-calc')) return;
    e.preventDefault();
    var out = f.querySelector('.imc-result');
    var peso = num(f.elements.peso.value);
    var alt = num(f.elements.altura.value);
    if (alt > 0 && alt < 3) alt = alt * 100; // aceita altura em metros (ex.: 1,68)
    if (!(peso >= 20 && peso <= 400) || !(alt >= 100 && alt <= 250)) {
      out.innerHTML = '<p class="imc-err">Indique um peso entre 20 e 400 kg e uma altura entre 100 e 250 cm.</p>';
      return;
    }
    var imc = peso / Math.pow(alt / 100, 2);
    var idx = 0;
    while (imc >= CATS[idx].max) idx++;
    var c = CATS[idx];
    var scale = CATS.map(function (k, i) {
      return '<span style="background:' + k.cor + '"' + (i === idx ? ' class="on"' : '') + ' title="' + k.nome + '"></span>';
    }).join('');
    var cta = imc >= 25
      ? ' <a href="/consulta-obesidade-emagrecimento-online" style="color:var(--teal,#0d7377);font-weight:600">Saiba como funciona a consulta de obesidade.</a>'
      : '';
    out.innerHTML =
      '<div class="imc-val">IMC ' + fmt(imc) + ' <small style="font-size:14px;font-weight:500;color:var(--muted,#8a9bb0)">kg/m²</small></div>' +
      '<span class="imc-cat" style="background:' + c.cor + '">' + c.nome + '</span>' +
      '<div class="imc-scale" aria-hidden="true">' + scale + '</div>' +
      '<p class="imc-msg">' + c.msg + cta + '</p>';
  });
})();
