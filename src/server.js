const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { enviarMensaje, listarGrupos, listarContactos, estaListo, getUltimoQR, cerrarSesion } = require('./whatsapp');
const qrcode = require('qrcode');
const { enviarCorreo } = require('./email');
const { ejecutarProgramacion, iniciarProgramaciones, detenerTodo } = require('./scheduler');
const { limpiarHistorial } = require('./agent');

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const KNOWLEDGE_DIR = path.resolve(__dirname, '../knowledge');

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
    const nombreSeguro = path.basename(f.originalname).replace(/[^\w.\-áéíóúüñÁÉÍÓÚÜÑ ]/g, '_');
    let destino = path.join('media', nombreSeguro);
    if (fs.existsSync(destino)) {
      const ext = path.extname(nombreSeguro);
      const base = nombreSeguro.slice(0, -ext.length || undefined);
      destino = path.join('media', `${base}_${Date.now()}${ext}`);
    }
    fs.renameSync(f.path, destino);
    return path.basename(destino);
  });
}

// ── WhatsApp logout ───────────────────────────────────────────────────────────
app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    await cerrarSesion();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ── Media upload ─────────────────────────────────────────────────────────────
app.post('/api/media/upload', upload.array('archivos', 20), (req, res) => {
  try {
    const archivos = procesarArchivos(req.files);
    res.json({ ok: true, archivos });
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

// ── Agente IA ─────────────────────────────────────────────────────────────────
const uploadKnowledge = multer({ dest: 'knowledge/' });

function listarDocumentosKnowledge() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  return fs.readdirSync(KNOWLEDGE_DIR)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const stat = fs.statSync(path.join(KNOWLEDGE_DIR, f));
      return { nombre: f, tamaño: stat.size, fecha: stat.mtime };
    });
}

app.get('/api/agente', (req, res) => {
  try {
    const config = leerConfig();
    const agente = config.agente || {};
    const documentos = listarDocumentosKnowledge();
    res.json({ ...agente, documentos });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/agente/config', (req, res) => {
  try {
    const config = leerConfig();
    if (!config.agente) config.agente = {};
    const { activo, apiKey, modelo, instruccionesExtra, filtro, chatsFiltros } = req.body;
    if (activo !== undefined) config.agente.activo = activo;
    if (apiKey !== undefined) config.agente.apiKey = apiKey;
    if (modelo !== undefined) config.agente.modelo = modelo;
    if (instruccionesExtra !== undefined) config.agente.instruccionesExtra = instruccionesExtra;
    if (filtro !== undefined) config.agente.filtro = filtro;
    if (chatsFiltros !== undefined) config.agente.chatsFiltros = chatsFiltros;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agente/respuestas-rapidas', (req, res) => {
  try {
    const config = leerConfig();
    if (!config.agente) config.agente = {};
    if (!config.agente.respuestasRapidas) config.agente.respuestasRapidas = [];
    const nueva = { id: 'rr-' + Date.now(), activa: true, ...req.body };
    config.agente.respuestasRapidas.push(nueva);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true, respuestaRapida: nueva });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/agente/respuestas-rapidas/:id', (req, res) => {
  try {
    const config = leerConfig();
    const lista = config.agente?.respuestasRapidas || [];
    const idx = lista.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
    lista[idx] = { ...lista[idx], ...req.body };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/agente/respuestas-rapidas/:id', (req, res) => {
  try {
    const config = leerConfig();
    if (config.agente?.respuestasRapidas) {
      config.agente.respuestasRapidas = config.agente.respuestasRapidas.filter(r => r.id !== req.params.id);
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agente/documentos', uploadKnowledge.array('documentos', 10), (req, res) => {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    const guardados = [];
    for (const f of (req.files || [])) {
      const nombreSeguro = path.basename(f.originalname).replace(/[^\w.\-áéíóúüñÁÉÍÓÚÜÑ ]/g, '_');
      let destino = path.join(KNOWLEDGE_DIR, nombreSeguro);
      if (fs.existsSync(destino)) {
        const ext = path.extname(nombreSeguro);
        const base = nombreSeguro.slice(0, -ext.length || undefined);
        destino = path.join(KNOWLEDGE_DIR, `${base}_${Date.now()}${ext}`);
      }
      fs.renameSync(f.path, destino);
      guardados.push(path.basename(destino));
    }
    res.json({ ok: true, documentos: guardados });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/agente/documentos/:nombre', (req, res) => {
  try {
    const filepath = path.join(KNOWLEDGE_DIR, path.basename(req.params.nombre));
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agente/limpiar-historial', (req, res) => {
  try {
    limpiarHistorial(req.body?.chatId || null);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function iniciar(puerto) {
  app.listen(puerto, () => console.log(`✓ Panel web disponible en http://localhost:${puerto}`));
}

module.exports = { iniciar };
