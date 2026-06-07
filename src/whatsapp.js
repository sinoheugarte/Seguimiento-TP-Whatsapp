const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const P = require('pino');
const { procesarMensaje } = require('./agent');

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
function leerConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }

let socket = null;
let listo = false;
let ultimoQR = null;
let gruposCache = [];
let contactosCache = new Map(); // chatId → nombre
const lidToJid = new Map(); // @lid → @s.whatsapp.net (mismo contacto, distinto formato)

const mensajesStore = new Map(); // chatId -> Message[]
const chatsRecientes = new Map(); // chatId -> {chatId, nombre, ultimo, ts, esGrupo}
const MAX_MSGS_POR_CHAT = 80;
let _sseBroadcast = null;
function setSseBroadcast(fn) { _sseBroadcast = fn; }

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

function esContactoPrivado(id) {
  return id.endsWith('@s.whatsapp.net') || id.endsWith('@lid');
}

// Intenta mapear un @lid al @s.whatsapp.net equivalente buscando por nombre en caché
function resolverLid(chatId) {
  if (!chatId.endsWith('@lid')) return chatId;
  // Primero intenta el mapa explícito (si Baileys proveyó c.lid)
  if (lidToJid.has(chatId)) return lidToJid.get(chatId);
  // Fallback: busca un @s.whatsapp.net con el mismo nombre en el caché
  const nombre = contactosCache.get(chatId);
  if (nombre) {
    for (const [id, n] of contactosCache) {
      if (id.endsWith('@s.whatsapp.net') && n === nombre) {
        lidToJid.set(chatId, id); // cachear para próximas veces
        return id;
      }
    }
  }
  return chatId;
}

function procesarContacto(c) {
  if (!c.id || !esContactoPrivado(c.id)) return;
  const nombre = c.name || c.notify || c.verifiedName || c.id.replace(/@s\.whatsapp\.net$|@lid$/, '');
  contactosCache.set(c.id, nombre);
  // Construir mapa @lid ↔ @s.whatsapp.net para el mismo contacto
  if (c.id.endsWith('@s.whatsapp.net') && c.lid) {
    const lid = c.lid.endsWith('@lid') ? c.lid : `${c.lid}@lid`;
    lidToJid.set(lid, c.id);
    contactosCache.set(lid, nombre);
  } else if (c.id.endsWith('@lid') && c.lid) {
    const jid = c.lid.endsWith('@s.whatsapp.net') ? c.lid : `${c.lid}@s.whatsapp.net`;
    lidToJid.set(c.id, jid);
    contactosCache.set(jid, nombre);
  }
  guardarContactosCache();
}

function guardarMensaje(msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;
  const m = msg.message || {};
  const texto = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
    m.videoMessage?.caption || m.documentMessage?.caption ||
    (m.imageMessage ? '[Imagen]' : m.videoMessage ? '[Video]' :
    m.documentMessage ? `[Archivo: ${m.documentMessage.fileName || 'documento'}]` :
    m.stickerMessage ? '[Sticker]' : m.audioMessage ? '[Audio]' : '');
  const fromMe = !!msg.key.fromMe;
  const ts = Number(msg.messageTimestamp) * 1000 || Date.now();
  const pushName = msg.pushName || '';
  const nombre = chatId.endsWith('@g.us')
    ? (gruposCache.find(g => g.chatId === chatId)?.nombre || chatId.replace('@g.us', ''))
    : (contactosCache.get(chatId) || pushName || chatId.replace(/@[^@]+$/, ''));
  const msgObj = {
    id: msg.key.id,
    chatId,
    fromMe,
    texto: texto || '',
    ts,
    autor: fromMe ? 'Tú' : (pushName || contactosCache.get(chatId) || chatId.replace(/@[^@]+$/, ''))
  };
  if (!mensajesStore.has(chatId)) mensajesStore.set(chatId, []);
  const lista = mensajesStore.get(chatId);
  if (!lista.find(x => x.id === msgObj.id)) {
    lista.push(msgObj);
    if (lista.length > MAX_MSGS_POR_CHAT) lista.shift();
  }
  chatsRecientes.set(chatId, { chatId, nombre, ultimo: texto || '[Media]', ts, esGrupo: chatId.endsWith('@g.us') });
  if (_sseBroadcast) _sseBroadcast({ tipo: 'mensaje', ...msgObj, chatNombre: nombre });
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
      const nombre = g.subject || '';
      const existe = gruposCache.find((x) => x.chatId === g.id);
      if (existe) { existe.nombre = nombre; }
      else gruposCache.push({ nombre, chatId: g.id });
      // Actualizar nombre en chatsRecientes si ya tenía el grupo con ID crudo
      if (chatsRecientes.has(g.id) && nombre) chatsRecientes.get(g.id).nombre = nombre;
    }
  });

  // Carga masiva inicial: contactos + chats individuales
  socket.ev.on('messaging-history.set', ({ contacts = [], chats = [] }) => {
    for (const c of contacts) procesarContacto(c);
    for (const c of chats) {
      if (!c.id || !esContactoPrivado(c.id)) continue;
      if (contactosCache.has(c.id)) continue;
      const nombre = c.name || c.id.replace(/@s\.whatsapp\.net$|@lid$/, '');
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
      if (!c.id || !esContactoPrivado(c.id)) continue;
      if (contactosCache.has(c.id)) continue;
      const nombre = c.name || c.id.replace(/@s\.whatsapp\.net$|@lid$/, '');
      contactosCache.set(c.id, nombre);
    }
  });

  socket.ev.on('chats.update', (chats) => {
    for (const c of chats) {
      if (!c.id || !esContactoPrivado(c.id)) continue;
      if (!c.name) continue;
      contactosCache.set(c.id, c.name);
    }
  });

  // Agente IA: responder mensajes entrantes
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      guardarMensaje(msg);
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;
      const textoRaw = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption || '';
      if (!textoRaw.trim()) continue;

      let texto = textoRaw;

      if (msg.key.fromMe) {
        // Solo procesar mensajes propios si empiezan con el prefijo configurado
        const { agente } = leerConfig();
        const prefijo = agente?.prefijoActivacion?.trim();
        if (!prefijo || !textoRaw.trimStart().toLowerCase().startsWith(prefijo.toLowerCase())) continue;
        texto = textoRaw.trimStart().slice(prefijo.length).trim();
        if (!texto) continue;
        log(`Mensaje propio con prefijo "${prefijo}" detectado en ${chatId}`);
      } else {
        // Registrar @lid en caché usando pushName del mensaje (si aún no está)
        if (chatId.endsWith('@lid') && msg.pushName && !contactosCache.has(chatId)) {
          contactosCache.set(chatId, msg.pushName);
          guardarContactosCache();
          log(`Contacto @lid registrado: ${chatId} → ${msg.pushName}`);
        }
      }

      // Normalizar @lid → @s.whatsapp.net para que coincida con el filtro guardado
      const chatIdFiltro = resolverLid(chatId);
      try {
        const respuesta = await procesarMensaje(chatIdFiltro, texto);
        if (respuesta) await socket.sendMessage(chatId, { text: respuesta });
      } catch (err) {
        console.error('[Agente] Error procesando mensaje:', err.message);
      }
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

module.exports = { inicializar, enviarMensaje, listarGrupos, listarContactos, estaListo, getUltimoQR, cerrarSesion, getMensajesStore: () => mensajesStore, getChatsRecientes, setSseBroadcast };

function getChatsRecientes() {
  // Re-resolver nombres en cada consulta usando el cache actual (puede haber llegado después del primer mensaje)
  for (const [chatId, chat] of chatsRecientes) {
    if (chatId.endsWith('@g.us')) {
      const g = gruposCache.find(x => x.chatId === chatId);
      if (g?.nombre) chat.nombre = g.nombre;
    } else {
      const n = contactosCache.get(chatId);
      if (n) chat.nombre = n;
    }
  }
  return chatsRecientes;
}
