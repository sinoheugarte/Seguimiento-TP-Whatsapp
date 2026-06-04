require('dotenv').config();
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

  // Panel web (arranca aunque WhatsApp no este listo aun)
  iniciarServidor(PUERTO);

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
