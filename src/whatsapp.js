const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const P = require('pino');

let socket = null;
let listo = false;
let ultimoQR = null;
let gruposCache = [];

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

  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (listo) { clearInterval(check); resolve(socket); }
    }, 500);
  });
}

async function enviarMensaje(chatId, texto, rutaFoto = null) {
  if (!listo) throw new Error('WhatsApp no esta conectado');

  if (rutaFoto) {
    const rutaCompleta = path.resolve('media', rutaFoto);
    if (!fs.existsSync(rutaCompleta)) throw new Error(`Foto no encontrada: ${rutaCompleta}`);
    const buffer = fs.readFileSync(rutaCompleta);
    const ext = path.extname(rutaFoto).slice(1).toLowerCase();
    const mimetype = ext === 'png' ? 'image/png' : 'image/jpeg';
    await socket.sendMessage(chatId, { image: buffer, caption: texto, mimetype });
  } else {
    await socket.sendMessage(chatId, { text: texto });
  }
}

async function listarGrupos() {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  try {
    const chats = await socket.groupFetchAllParticipating();
    gruposCache = Object.values(chats).map((g) => ({ nombre: g.subject, chatId: g.id }));
  } catch (_) {}
  return gruposCache;
}

function getUltimoQR() { return ultimoQR; }
function estaListo() { return listo; }

module.exports = { inicializar, enviarMensaje, listarGrupos, estaListo, getUltimoQR };
