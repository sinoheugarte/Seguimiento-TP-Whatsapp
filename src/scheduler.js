const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { enviarMensaje, estaListo } = require('./whatsapp');
const { enviarCorreo } = require('./email');

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
function leerConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }

const trabajos = new Map();

function resolverFecha() {
  return new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function resolverChatId(valor, config) {
  if (!valor) return null;
  if (valor.includes('@')) return valor;
  const grupo = config.whatsapp.grupos.find(g => g.id === valor);
  return grupo ? grupo.chatId : null;
}

function resolverEmailDestinatarios(idDest, config) {
  if (idDest.includes('@')) return [idDest];
  const dest = config.email.destinatarios.find(d => d.id === idDest);
  return dest ? dest.direcciones : [];
}

async function ejecutarProgramacion(prog) {
  const config = leerConfig();

  // Verificar fechas específicas si están configuradas
  if (prog.fechasEspecificas && prog.fechasEspecificas.length > 0) {
    const hoy = new Date();
    const mesHoy = hoy.getMonth() + 1;
    const diaHoy = hoy.getDate();
    const entrada = prog.fechasEspecificas.find(e => e.mes === mesHoy);
    if (!entrada || !entrada.dias.includes(diaHoy)) {
      console.log(`[cron] Omitido (fecha no coincide hoy): ${prog.descripcion}`);
      return [];
    }
  }

  const texto = prog.mensaje.replace('{{fecha}}', resolverFecha());
  const asunto = (prog.asuntoEmail || '').replace('{{fecha}}', resolverFecha());
  const archivos = prog.archivos?.length ? prog.archivos : (prog.foto ? [prog.foto] : []);
  const errores = [];

  if (prog.destinatariosWhatsapp?.length > 0) {
    if (!estaListo()) {
      errores.push('WhatsApp no conectado al momento de ejecutar');
    } else {
      for (const dest of prog.destinatariosWhatsapp) {
        const chatId = resolverChatId(dest, config);
        if (!chatId) { errores.push(`Grupo/contacto no encontrado: ${dest}`); continue; }
        try {
          await enviarMensaje(chatId, texto, archivos);
          console.log(`[cron] WhatsApp enviado → ${dest}`);
        } catch (err) {
          errores.push(`WhatsApp ${dest}: ${err.message}`);
        }
      }
    }
  }

  if (prog.destinatariosEmail?.length > 0) {
    for (const idDest of prog.destinatariosEmail) {
      const direcciones = resolverEmailDestinatarios(idDest, config);
      if (!direcciones.length) { errores.push(`Destinatario email no encontrado: ${idDest}`); continue; }
      try {
        await enviarCorreo({ para: direcciones, asunto: asunto || texto.slice(0, 60), cuerpo: texto, archivos });
        console.log(`[cron] Email enviado → ${idDest}`);
      } catch (err) {
        errores.push(`Email ${idDest}: ${err.message}`);
      }
    }
  }

  if (errores.length > 0) console.error('[cron] Errores:', errores);
  return errores;
}

function iniciarProgramaciones() {
  const config = leerConfig();
  const activas = config.programaciones.filter(p => p.activo);
  for (const prog of activas) {
    if (!cron.validate(prog.cron)) {
      console.warn(`[cron] Expresion invalida para "${prog.id}": ${prog.cron}`);
      continue;
    }
    const trabajo = cron.schedule(prog.cron, () => {
      console.log(`[cron] Ejecutando: ${prog.descripcion}`);
      ejecutarProgramacion(prog);
    });
    trabajos.set(prog.id, trabajo);
    console.log(`✓ Programacion activa: "${prog.descripcion}" (${prog.cron})`);
  }
}

function detenerTodo() {
  for (const [id, trabajo] of trabajos) {
    trabajo.stop();
    console.log(`[cron] Detenido: ${id}`);
  }
  trabajos.clear();
}

module.exports = { iniciarProgramaciones, detenerTodo, ejecutarProgramacion };
