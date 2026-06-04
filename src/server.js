const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { enviarMensaje, listarGrupos, estaListo, getUltimoQR } = require('./whatsapp');
const qrcode = require('qrcode');
const { enviarCorreo } = require('./email');
const { ejecutarProgramacion } = require('./scheduler');
const config = require('../config.json');

const app = express();
const upload = multer({ dest: 'media/' });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// QR como imagen PNG para mostrar en el panel web
app.get('/api/qr', async (req, res) => {
  const qr = getUltimoQR();
  if (!qr) return res.status(404).json({ error: estaListo() ? 'ya_conectado' : 'sin_qr' });
  const buffer = await qrcode.toBuffer(qr);
  res.set('Content-Type', 'image/png');
  res.send(buffer);
});

// Estado del sistema
app.get('/api/estado', async (req, res) => {
  const grupos = estaListo() ? await listarGrupos() : [];
  res.json({
    whatsapp: estaListo(),
    grupos,
    gruposConfig: config.whatsapp.grupos,
    destinatariosEmail: config.email.destinatarios,
    programaciones: config.programaciones
  });
});

// Envio manual de WhatsApp
app.post('/api/whatsapp/enviar', upload.single('foto'), async (req, res) => {
  const { chatId, mensaje } = req.body;
  if (!chatId || !mensaje) return res.status(400).json({ error: 'chatId y mensaje son requeridos' });

  try {
    const nombreFoto = req.file ? path.basename(req.file.path) : null;
    // Renombrar con extension original si hay archivo
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.jpg';
      const nuevoNombre = req.file.filename + ext;
      fs.renameSync(req.file.path, path.join('media', nuevoNombre));
      await enviarMensaje(chatId, mensaje, nuevoNombre);
    } else {
      await enviarMensaje(chatId, mensaje, null);
    }
    res.json({ ok: true, mensaje: 'Mensaje enviado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envio manual de email
app.post('/api/email/enviar', upload.single('foto'), async (req, res) => {
  const { para, asunto, cuerpo } = req.body;
  if (!para || !asunto || !cuerpo) return res.status(400).json({ error: 'para, asunto y cuerpo son requeridos' });

  try {
    let nombreFoto = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.jpg';
      nombreFoto = req.file.filename + ext;
      fs.renameSync(req.file.path, path.join('media', nombreFoto));
    }
    const destinatarios = para.split(',').map((d) => d.trim());
    await enviarCorreo({ para: destinatarios, asunto, cuerpo, rutaFoto: nombreFoto });
    res.json({ ok: true, mensaje: 'Correo enviado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envio combinado (WhatsApp + Email a la vez)
app.post('/api/enviar-todo', upload.single('foto'), async (req, res) => {
  const { chatsIds, emailsPara, asunto, mensaje } = req.body;
  const resultados = { whatsapp: [], email: [], errores: [] };

  let nombreFoto = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname) || '.jpg';
    nombreFoto = req.file.filename + ext;
    fs.renameSync(req.file.path, path.join('media', nombreFoto));
  }

  // WhatsApp
  const ids = chatsIds ? JSON.parse(chatsIds) : [];
  for (const chatId of ids) {
    try {
      await enviarMensaje(chatId, mensaje, nombreFoto);
      resultados.whatsapp.push({ chatId, ok: true });
    } catch (err) {
      resultados.errores.push({ canal: 'whatsapp', chatId, error: err.message });
    }
  }

  // Email
  const emailsDest = emailsPara ? JSON.parse(emailsPara) : [];
  if (emailsDest.length > 0) {
    try {
      await enviarCorreo({ para: emailsDest, asunto: asunto || mensaje.slice(0, 60), cuerpo: mensaje, rutaFoto: nombreFoto });
      resultados.email.push({ para: emailsDest, ok: true });
    } catch (err) {
      resultados.errores.push({ canal: 'email', error: err.message });
    }
  }

  res.json(resultados);
});

// Disparar una programacion manualmente
app.post('/api/programaciones/:id/ejecutar', async (req, res) => {
  const prog = config.programaciones.find((p) => p.id === req.params.id);
  if (!prog) return res.status(404).json({ error: 'Programacion no encontrada' });
  const errores = await ejecutarProgramacion(prog);
  res.json({ ok: errores.length === 0, errores });
});

function iniciar(puerto) {
  app.listen(puerto, () => {
    console.log(`✓ Panel web disponible en http://localhost:${puerto}`);
  });
}

module.exports = { iniciar };
