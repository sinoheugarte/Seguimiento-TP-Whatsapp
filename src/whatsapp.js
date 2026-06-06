const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
const CONTACTS_FILE = path.resolve('.baileys_auth', 'contacts-cache.json');

function log(msg) {
  console.log('[WhatsApp]', msg);
}

// Carga el cache de contactos desde disco al iniciar
function cargarContactosDescoCache() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
      contactosCache = new Map(Object.entries(data));
      log(`Contactos cargados desde cache: ${contactosCache.size}`);
    }
  } catch (_) {}
}

// Guarda el cache en disco cuando se actualiza
let _saveTimer = null;
function guardarContactosCache() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const obj = Object.fromEntries(contactosCache);
      fs.writeFileSync(CONTACTS_FILE, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }, 2000); // debounce 2s para no escribir en cada evento
}

function procesarContacto(c) {
  if (!c.id || !c.id.endsWith('@s.whatsapp.net')) return;
  const nombre = c.name || c.notify || c.verifiedName || c.id.replace('@s.whatsapp.net', '');
  contactosCache.set(c.id, nombre);
  guardarContactosCache();
}

async function inicializar() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  cargarContactosDescoCache();

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
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      log('Desconectado. Reconectar: ' + shouldReconnect);
      if (shouldReconnect) {
        setTimeout(inicializar, 5000);
      } else {
        // Sesión cerrada — limpiar credenciales y reiniciar para obtener QR nuevo
        log('Sesión cerrada (loggedOut). Limpiando credenciales...');
        try {
          const files = fs.readdirSync(AUTH_DIR);
          for (const f of files) {
            if (f !== 'contacts-cache.json') {
              fs.unlinkSync(path.join(AUTH_DIR, f));
            }
          }
        } catch (_) {}
        setTimeout(inicializar, 3000);
      }
    }
  });

  socket.ev.on('groups.upsert', (grupos) => {
    for (const g of grupos) {
      const existe = gruposCache.find((x) => x.chatId === g.id);
      if (!existe) gruposCache.push({ nombre: g.subject || '', chatId: g.id });
    }
  });

  // Carga masiva inicial: contactos + chats individuales
  socket.ev.on('messaging-history.set', ({ contacts = [], chats = [] }) => {
    for (const c of contacts) procesarContacto(c);
    for (const c of chats) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
      if (contactosCache.has(c.id)) continue;
      const nombre = c.name || c.id.replace('@s.whatsapp.net', '');
      contactosCache.set(c.id, nombre);
    }
    guardarContactosCache();
    log(`Contactos tras historial: ${contactosCache.size}`);
  });

  // Actualizaciones en tiempo real
  socket.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) procesarContacto(c);
  });

  socket.ev.on('contacts.update', (updates) => {
    for (const c of updates) procesarContacto(c);
  });

  // Chats nuevos/actualizados: extraer contactos individuales
  socket.ev.on('chats.upsert', (chats) => {
    for (const c of chats) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
      if (contactosCache.has(c.id)) continue;
      const nombre = c.name || c.id.replace('@s.whatsapp.net', '');
      contactosCache.set(c.id, nombre);
    }
  });

  socket.ev.on('chats.update', (chats) => {
    for (const c of chats) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
      if (!c.name) continue;
      contactosCache.set(c.id, c.name);
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
  return arr.sort((a, b) => (a.nombre||'').localeCompare(b.nombre||'', 'es', { sensitivity: 'base' }));
}

async function listarGrupos() {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  try {
    const chats = await socket.groupFetchAllParticipating();
    gruposCache = Object.values(chats).map((g) => ({ nombre: g.subject || '', chatId: g.id }));
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

async function cerrarSesion() {
  listo = false;
  ultimoQR = null;
  try { if (socket) await socket.logout(); } catch (_) {}
  socket = null;
  // Eliminar archivos de autenticación preservando el cache de contactos
  try {
    const files = fs.readdirSync(AUTH_DIR);
    for (const f of files) {
      if (f !== 'contacts-cache.json') fs.unlinkSync(path.join(AUTH_DIR, f));
    }
  } catch (_) {}
  log('Sesión cerrada manualmente. Generando nuevo QR...');
  setTimeout(inicializar, 1500);
}

module.exports = { inicializar, enviarMensaje, listarGrupos, listarContactos, estaListo, getUltimoQR, cerrarSesion };
