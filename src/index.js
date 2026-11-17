require('dotenv').config();
const fs = require('fs');
const path = require('path');

// config.json es local (no está en git): si falta, se crea desde la plantilla
const CONFIG = path.resolve(__dirname, '../config.json');
if (!fs.existsSync(CONFIG)) {
  fs.copyFileSync(path.resolve(__dirname, '../config.example.json'), CONFIG);
  console.log('✓ config.json creado desde config.example.json');
}
const { inicializar: iniciarWhatsapp } = require('./whatsapp');
const { inicializar: iniciarEmail } = require('./email');
const { iniciarProgramaciones } = require('./scheduler');
const { iniciar: iniciarServidor } = require('./server');

const PUERTO = process.env.PORT || 3000;

(async () => {
  console.log('\n=== Seguimiento TP — WhatsApp + Email ===\n');

  // Email
  try {
    await iniciarEmail();
  } catch (err) {
    console.error('✗ Error al conectar correo:', err.message);
    console.warn('  Verifica EMAIL_USER y EMAIL_PASS en el archivo .env');
  }

  // Panel web primero: si el puerto está ocupado es que la app ya está abierta,
  // y una segunda conexión a WhatsApp con la misma sesión desconectaría a la primera.
  try {
    await iniciarServidor(PUERTO);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✗ Seguimiento TP ya está en ejecución (el puerto ${PUERTO} está ocupado).`);
      console.error(`  Abre http://localhost:${PUERTO} o ciérrala con Detener-TP.vbs antes de iniciarla de nuevo.\n`);
    } else {
      console.error('✗ No se pudo iniciar el panel web:', err.message);
    }
    process.exit(1);
  }

  // Programaciones cron
  iniciarProgramaciones();

  // WhatsApp (puede tardar hasta que escanees el QR)
  try {
    await iniciarWhatsapp();
    console.log('\n✓ Sistema listo. Abre http://localhost:' + PUERTO + ' para el panel web.\n');
  } catch (err) {
    console.error('✗ Error al conectar WhatsApp:', err.message);
  }
})();
