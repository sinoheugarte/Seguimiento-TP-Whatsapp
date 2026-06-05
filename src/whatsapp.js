const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const P = require('pino');

let socket = null;
let listo = false;
let ultimoQR = null;
let gruposCache = [];
let contactosCache = new Map(); // chatId → nombre

const AUTH_DIR = path.resolve('.baileys_auth');

function log(msg) {
  console.log('[WhatsApp]', msg);
}

async function inicializar() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['TP-Whatsapp', 'Chrome', '1.0']
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      ultimoQR = qr;
      qrcode.toString(qr, { type: 'terminal', small: true }, (err, str) => {
        console.log('\n──────────────────────────────────────────');
        console.log('  Escanea este QR con tu celular de empresa');
        console.log('  WhatsApp > Dispositivos vinculados > Vincular dispositivo');
        console.log('──────────────────────────────────────────\n');
        if (!err) console.log(str);
      });
    }

    if (connection === 'open') {
      listo = true;
      ultimoQR = null;
      log('Conectado correctamente ✓');
    }

    if (connection === 'close') {
      listo = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      log('Desconectado. Reconectar: ' + shouldReconnect);
      if (shouldReconnect) setTimeout(inicializar, 5000);
    }
  });

  socket.ev.on('groups.upsert', (grupos) => {
    for (const g of grupos) {
      const existe = gruposCache.find((x) => x.chatId === g.id);
      if (!existe) gruposCache.push({ nombre: g.subject, chatId: g.id });
    }
  });

  // Cachea contactos individuales a medida que llegan
  socket.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      if (!c.id.endsWith('@s.whatsapp.net')) continue;
      const nombre = c.name || c.notify || c.verifiedName || c.id.replace('@s.whatsapp.net', '');
      contactosCache.set(c.id, nombre);
    }
  });

  socket.ev.on('contacts.update', (updates) => {
    for (const c of updates) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
      const nombre = c.name || c.notify || c.verifiedName || contactosCache.get(c.id) || c.id.replace('@s.whatsapp.net', '');
      contactosCache.set(c.id, nombre);
    }
  });

  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (listo) { clearInterval(check); resolve(socket); }
    }, 500);
  });
}

const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip', rar: 'application/x-rar-compressed',
  txt: 'text/plain', csv: 'text/csv'
};

function getMime(nombre) {
  const ext = path.extname(nombre).slice(1).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function esImagen(nombre) {
  return ['jpg','jpeg','png','gif','webp'].includes(path.extname(nombre).slice(1).toLowerCase());
}

async function enviarMensaje(chatId, texto, archivos = []) {
  if (!listo) throw new Error('WhatsApp no esta conectado');

  if (!archivos || archivos.length === 0) {
    await socket.sendMessage(chatId, { text: texto });
    return;
  }

  for (let i = 0; i < archivos.length; i++) {
    const nombreArchivo = archivos[i];
    const rutaCompleta = path.resolve('media', nombreArchivo);
    if (!fs.existsSync(rutaCompleta)) throw new Error(`Archivo no encontrado: ${rutaCompleta}`);
    const buffer = fs.readFileSync(rutaCompleta);
    const mime = getMime(nombreArchivo);
    const caption = i === 0 ? texto : '';

    if (esImagen(nombreArchivo)) {
      await socket.sendMessage(chatId, { image: buffer, caption, mimetype: mime });
    } else {
      await socket.sendMessage(chatId, {
        document: buffer,
        mimetype: mime,
        fileName: nombreArchivo,
        caption
      });
    }
  }
}

function ordenarAlf(arr) {
  return arr.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
}

async function listarGrupos() {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  try {
    const chats = await socket.groupFetchAllParticipating();
    gruposCache = Object.values(chats).map((g) => ({ nombre: g.subject, chatId: g.id }));
  } catch (_) {}
  return ordenarAlf([...gruposCache]);
}

function listarContactos() {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  const lista = [];
  for (const [chatId, nombre] of contactosCache) {
    lista.push({ nombre, chatId });
  }
  return ordenarAlf(lista);
}

function getUltimoQR() { return ultimoQR; }
function estaListo() { return listo; }

module.exports = { inicializar, enviarMensaje, listarGrupos, listarContactos, estaListo, getUltimoQR };
