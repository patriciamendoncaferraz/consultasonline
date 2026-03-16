#!/usr/bin/env python3
import sys, json, base64, io, os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader

# Args: tipo dados_json output_path sig_path
tipo = sys.argv[1]
dados = json.loads(sys.argv[2])
output = sys.argv[3]
sig_path = sys.argv[4]

with open(sig_path, 'r') as f:
    sig_b64 = f.read().strip()

def mes_pt(n):
    meses = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']
    try: return meses[int(n)-1]
    except: return n

def format_date_pt(d):
    try:
        p = d.split('/')
        return str(int(p[0])) + ' de ' + mes_pt(p[1]) + ' de ' + p[2]
    except: return d

def justified_lines(c, text, x, y, max_width, font, size, lh):
    words = text.split()
    if not words: return y
    lines = []
    current = []
    for word in words:
        test = ' '.join(current + [word])
        if c.stringWidth(test, font, size) <= max_width:
            current.append(word)
        else:
            if current: lines.append(current)
            current = [word]
    if current: lines.append(current)
    for i, lw in enumerate(lines):
        is_last = (i == len(lines) - 1)
        if is_last or len(lw) == 1:
            c.setFont(font, size)
            c.drawString(x, y, ' '.join(lw))
        else:
            total = sum(c.stringWidth(w, font, size) for w in lw)
            sp = (max_width - total) / (len(lw) - 1)
            cx = x
            for w in lw:
                c.setFont(font, size)
                c.drawString(cx, y, w)
                cx += c.stringWidth(w, font, size) + sp
        y -= lh
    return y

buf = io.BytesIO()
w, h = A4
cv = canvas.Canvas(buf, pagesize=A4)
margin = 2.5 * cm
text_w = w - 2 * margin
y = h - 2.5*cm
lh = 0.58*cm

cv.setStrokeColor(colors.HexColor('#0b1d35'))
cv.setLineWidth(3)
cv.line(margin, y, w - margin, y)

y -= 1.3*cm
cv.setFont('Helvetica-Bold', 18)
cv.setFillColor(colors.HexColor('#0b1d35'))
cv.drawCentredString(w/2, y, 'ATESTADO MEDICO')

y -= 0.4*cm
cv.setLineWidth(0.8)
cv.setStrokeColor(colors.HexColor('#0d7377'))
cv.line(margin + 3*cm, y, w - margin - 3*cm, y)
y -= 1.0*cm

def jwrite(text, bold=False, before=0, after=0):
    global y
    y -= before
    font = 'Helvetica-Bold' if bold else 'Helvetica'
    cv.setFillColor(colors.black)
    y = justified_lines(cv, text, margin, y, text_w, font, 11, lh)
    y -= after

def write_name(value):
    global y
    cv.setFont('Helvetica-Bold', 11)
    cv.setFillColor(colors.HexColor('#0b1d35'))
    cv.drawString(margin, y, value)
    cv.setStrokeColor(colors.HexColor('#94a3b8'))
    cv.setLineWidth(0.5)
    cv.line(margin, y - 0.1*cm, w - margin, y - 0.1*cm)
    y -= lh + 0.1*cm

jwrite('Eu, Dra. Patricia Mendonca Ferraz, medica inscrita na Ordem dos Medicos com a cedula profissional n. 57713, atesto que:')
y -= 0.4*cm

if tipo == 'amamentacao':
    jwrite('A utente')
    write_name(dados.get('nome_utente',''))
    jwrite('nascida em ' + dados.get('data_nasc_utente','') + ', portadora do Cartao de Cidadao n. ' + dados.get('cc_utente','') + ', encontra-se atualmente em periodo de amamentacao do(a) seu(sua) filho(a)')
    write_name(dados.get('nome_filho',''))
    jwrite('nascido(a) em ' + dados.get('data_nasc_filho','') + '.')
    y -= 0.6*cm
    jwrite('Este atestado e passado a pedido da interessada para os devidos efeitos legais.')
else:
    jwrite('O(a) utente')
    write_name(dados.get('nome_utente',''))
    jwrite('nascido(a) em ' + dados.get('data_nasc_utente','') + ', portador(a) do Cartao de Cidadao n. ' + dados.get('cc_utente','') + ', necessita de afastamento das atividades escolares no periodo compreendido entre ' + dados.get('data_inicio','') + ' e ' + dados.get('data_fim','') + ' por motivos de doenca.')
    y -= 0.6*cm
    jwrite('Este atestado e passado a pedido do(a) interessado(a) para os devidos efeitos legais.')

y -= 1.0*cm
data_fmt = format_date_pt(dados.get('data_consulta',''))
cv.setFont('Helvetica', 11)
cv.setFillColor(colors.black)
cv.drawString(margin, y, 'Viseu, ' + data_fmt)

y -= 1.6*cm
line_y = y
cv.setStrokeColor(colors.HexColor('#0b1d35'))
cv.setLineWidth(0.8)
cv.line(margin, line_y, margin + 9*cm, line_y)

sig_h = 1.6*cm
sig_w = sig_h * (2033/530)
sig_reader = ImageReader(io.BytesIO(base64.b64decode(sig_b64)))
cv.drawImage(sig_reader, margin, line_y, width=sig_w, height=sig_h, preserveAspectRatio=True, mask='auto')

y = line_y - 0.4*cm
cv.setFont('Helvetica', 9)
cv.setFillColor(colors.HexColor('#64748b'))
cv.drawString(margin, y, 'Dra. Patricia Mendonca Ferraz  |  Cedula n. 57713')

cv.setStrokeColor(colors.HexColor('#0b1d35'))
cv.setLineWidth(1.5)
cv.line(margin, 1.8*cm, w - margin, 1.8*cm)
cv.setFont('Helvetica', 8)
cv.setFillColor(colors.HexColor('#94a3b8'))
cv.drawCentredString(w/2, 1.2*cm, 'ConsultasOnline  |  www.consultas-online.pt  |  geral@consultas-online.pt')

cv.save()
buf.seek(0)
with open(output, 'wb') as f:
    f.write(buf.read())
print('OK')
