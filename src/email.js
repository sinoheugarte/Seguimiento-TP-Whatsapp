const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

let transporter = null;

function inicializar() {
  transporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false, // STARTTLS
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    tls: {
      ciphers: 'SSLv3'
    }
  });

  const verificar = transporter.verify();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout al conectar SMTP')), 8000)
  );
  return Promise.race([verificar, timeout]).then(() => {
    console.log('✓ Correo Outlook 365 conectado correctamente');
  });
}

async function enviarCorreo({ para, asunto, cuerpo, archivos = [] }) {
  if (!transporter) throw new Error('Correo no inicializado');

  const adjuntos = (archivos || []).map(nombre => {
    const rutaCompleta = path.resolve('media', nombre);
    return fs.existsSync(rutaCompleta)
      ? { path: rutaCompleta, filename: nombre }
      : null;
  }).filter(Boolean);

  const opciones = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: Array.isArray(para) ? para.join(', ') : para,
    subject: asunto,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${cuerpo.replace(/\n/g, '<br>')}</div>`,
    text: cuerpo,
    attachments: adjuntos
  };

  const info = await transporter.sendMail(opciones);
  return info.messageId;
}

module.exports = { inicializar, enviarCorreo };
