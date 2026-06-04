const cron = require('node-cron');
const { enviarMensaje, estaListo } = require('./whatsapp');
const { enviarCorreo } = require('./email');
const config = require('../config.json');

const trabajos = new Map();

function resolverFecha() {
  return new Date().toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

function resolverGrupoChatId(idGrupo) {
  const grupo = config.whatsapp.grupos.find((g) => g.id === idGrupo);
  return grupo ? grupo.chatId : null;
}

function resolverEmailDestinatarios(idDestinatario) {
  const dest = config.email.destinatarios.find((d) => d.id === idDestinatario);
  return dest ? dest.direcciones : [];
}

async function ejecutarProgramacion(prog) {
  const texto = prog.mensaje.replace('{{fecha}}', resolverFecha());
  const asunto = prog.asuntoEmail.replace('{{fecha}}', resolverFecha());
  const errores = [];

  // WhatsApp
  if (prog.destinatariosWhatsapp?.length > 0) {
    if (!estaListo()) {
      errores.push('WhatsApp no conectado al momento de ejecutar');
    } else {
      for (const idGrupo of prog.destinatariosWhatsapp) {
        const chatId = resolverGrupoChatId(idGrupo);
        if (!chatId) { errores.push(`Grupo no encontrado: ${idGrupo}`); continue; }
        try {
          await enviarMensaje(chatId, texto, prog.foto || null);
          console.log(`[cron] WhatsApp enviado → ${idGrupo}`);
        } catch (err) {
          errores.push(`WhatsApp ${idGrupo}: ${err.message}`);
        }
      }
    }
  }

  // Email
  if (prog.destinatariosEmail?.length > 0) {
    for (const idDest of prog.destinatariosEmail) {
      const direcciones = resolverEmailDestinatarios(idDest);
      if (!direcciones.length) { errores.push(`Destinatario email no encontrado: ${idDest}`); continue; }
      try {
        await enviarCorreo({ para: direcciones, asunto, cuerpo: texto, rutaFoto: prog.foto || null });
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
  const activas = config.programaciones.filter((p) => p.activo);

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
