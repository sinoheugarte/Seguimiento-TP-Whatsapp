const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

let cliente = null;
let listo = false;

function inicializar() {
  return new Promise((resolve, reject) => {
    cliente = new Client({
      authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });

    cliente.on('qr', (qr) => {
      console.log('\n──────────────────────────────────────────');
      console.log('  Escanea este QR con tu celular de empresa');
      console.log('  WhatsApp > Dispositivos vinculados > Vincular dispositivo');
      console.log('──────────────────────────────────────────\n');
      qrcode.generate(qr, { small: true });
    });

    cliente.on('ready', () => {
      listo = true;
      console.log('✓ WhatsApp conectado correctamente');
      resolve(cliente);
    });

    cliente.on('auth_failure', (msg) => {
      console.error('✗ Error de autenticacion WhatsApp:', msg);
      reject(new Error(msg));
    });

    cliente.on('disconnected', (razon) => {
      listo = false;
      console.warn('⚠ WhatsApp desconectado:', razon);
    });

    cliente.initialize();
  });
}

async function enviarMensaje(chatId, texto, rutaFoto = null) {
  if (!listo) throw new Error('WhatsApp no esta conectado');

  const chat = await cliente.getChatById(chatId);

  if (rutaFoto) {
    const rutaCompleta = path.resolve('media', rutaFoto);
    if (!fs.existsSync(rutaCompleta)) {
      throw new Error(`Foto no encontrada: ${rutaCompleta}`);
    }
    const media = MessageMedia.fromFilePath(rutaCompleta);
    await chat.sendMessage(media, { caption: texto });
  } else {
    await chat.sendMessage(texto);
  }
}

// Devuelve todos los grupos a los que pertenece el numero conectado
async function listarGrupos() {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  const chats = await cliente.getChats();
  return chats
    .filter((c) => c.isGroup)
    .map((c) => ({ nombre: c.name, chatId: c.id._serialized }));
}

function estaListo() {
  return listo;
}

module.exports = { inicializar, enviarMensaje, listarGrupos, estaListo };
