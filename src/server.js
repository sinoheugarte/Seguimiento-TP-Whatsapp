const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { enviarMensaje, listarGrupos, listarContactos, estaListo, getUltimoQR } = require('./whatsapp');
const qrcode = require('qrcode');
const { enviarCorreo } = require('./email');
const { ejecutarProgramacion, iniciarProgramaciones, detenerTodo } = require('./scheduler');

const CONFIG_PATH = path.resolve(__dirname, '../config.json');

function leerConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
function guardarConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  detenerTodo();
  iniciarProgramaciones();
}

const app = express();
const upload = multer({ dest: 'media/' });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Helpers ─────────────────────────────────────────────────────────────────

function procesarArchivos(files) {
  if (!files || files.length === 0) return [];
  return files.map(f => {
    const ext = path.extname(f.originalname) || '';
    const nuevoNombre = f.filename + ext;
    fs.renameSync(f.path, path.join('media', nuevoNombre));
    return nuevoNombre;
  });
}

// ── QR ───────────────────────────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const qr = getUltimoQR();
  if (!qr) return res.status(404).json({ error: estaListo() ? 'ya_conectado' : 'sin_qr' });
  const buffer = await qrcode.toBuffer(qr);
  res.set('Content-Type', 'image/png');
  res.send(buffer);
});

// ── Estado ───────────────────────────────────────────────────────────────────
app.get('/api/estado', async (req, res) => {
  const config = leerConfig();
  const conectado = estaListo();
  const grupos = conectado ? await listarGrupos() : [];
  const contactos = conectado ? listarContactos() : [];
  res.json({
    whatsapp: conectado,
    grupos,
    contactos,
    gruposConfig: config.whatsapp.grupos,
    destinatariosEmail: config.email.destinatarios,
    programaciones: config.programaciones
  });
});

// ── WhatsApp ─────────────────────────────────────────────────────────────────
app.post('/api/whatsapp/enviar', upload.array('archivos', 20), async (req, res) => {
  const { chatId, mensaje } = req.body;
  if (!chatId || !mensaje) return res.status(400).json({ error: 'chatId y mensaje son requeridos' });
  try {
    const archivos = procesarArchivos(req.files);
    await enviarMensaje(chatId, mensaje, archivos);
    res.json({ ok: true, mensaje: 'Mensaje enviado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Email ────────────────────────────────────────────────────────────────────
app.post('/api/email/enviar', upload.array('archivos', 20), async (req, res) => {
  const { para, asunto, cuerpo } = req.body;
  if (!para || !asunto || !cuerpo) return res.status(400).json({ error: 'para, asunto y cuerpo son requeridos' });
  try {
    const archivos = procesarArchivos(req.files);
    const destinatarios = para.split(',').map(d => d.trim());
    await enviarCorreo({ para: destinatarios, asunto, cuerpo, archivos });
    res.json({ ok: true, mensaje: 'Correo enviado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Envio combinado ──────────────────────────────────────────────────────────
app.post('/api/enviar-todo', upload.array('archivos', 20), async (req, res) => {
  const { chatsIds, emailsPara, asunto, mensaje } = req.body;
  const resultados = { whatsapp: [], email: [], errores: [] };

  const archivos = procesarArchivos(req.files);

  const ids = chatsIds ? JSON.parse(chatsIds) : [];
  for (const chatId of ids) {
    try {
      await enviarMensaje(chatId, mensaje, archivos);
      resultados.whatsapp.push({ chatId, ok: true });
    } catch (err) {
      resultados.errores.push({ canal: 'whatsapp', chatId, error: err.message });
    }
  }

  const emailsDest = emailsPara ? JSON.parse(emailsPara) : [];
  if (emailsDest.length > 0) {
    try {
      await enviarCorreo({ para: emailsDest, asunto: asunto || mensaje.slice(0, 60), cuerpo: mensaje, archivos });
      resultados.email.push({ para: emailsDest, ok: true });
    } catch (err) {
      resultados.errores.push({ canal: 'email', error: err.message });
    }
  }

  res.json(resultados);
});

// ── Programaciones ───────────────────────────────────────────────────────────
app.post('/api/programaciones/:id/ejecutar', async (req, res) => {
  const config = leerConfig();
  const prog = config.programaciones.find(p => p.id === req.params.id);
  if (!prog) return res.status(404).json({ error: 'No encontrada' });
  const errores = await ejecutarProgramacion(prog);
  res.json({ ok: errores.length === 0, errores });
});

app.post('/api/programaciones', (req, res) => {
  try {
    const config = leerConfig();
    const nueva = { ...req.body, id: 'prog-' + Date.now() };
    config.programaciones.push(nueva);
    guardarConfig(config);
    res.json({ ok: true, programacion: nueva });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/programaciones/:id', (req, res) => {
  try {
    const config = leerConfig();
    const idx = config.programaciones.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
    config.programaciones[idx] = { ...config.programaciones[idx], ...req.body };
    guardarConfig(config);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/programaciones/:id', (req, res) => {
  try {
    const config = leerConfig();
    config.programaciones = config.programaciones.filter(p => p.id !== req.params.id);
    guardarConfig(config);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Ajustes: Grupos de correo ─────────────────────────────────────────────────
app.post('/api/ajustes/grupos-email', (req, res) => {
  try {
    const config = leerConfig();
    const { nombre, direcciones } = req.body;
    const nuevo = { id: 'ge-' + Date.now(), nombre, direcciones };
    config.email.destinatarios.push(nuevo);
    guardarConfig(config);
    res.json({ ok: true, grupo: nuevo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/ajustes/grupos-email/:id', (req, res) => {
  try {
    const config = leerConfig();
    const idx = config.email.destinatarios.findIndex(g => g.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
    config.email.destinatarios[idx] = { ...config.email.destinatarios[idx], ...req.body };
    guardarConfig(config);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ajustes/grupos-email/:id', (req, res) => {
  try {
    const config = leerConfig();
    config.email.destinatarios = config.email.destinatarios.filter(g => g.id !== req.params.id);
    guardarConfig(config);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function iniciar(puerto) {
  app.listen(puerto, () => console.log(`✓ Panel web disponible en http://localhost:${puerto}`));
}

module.exports = { iniciar };
