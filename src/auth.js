const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Credenciales y sesiones del panel. Fuera de git (ver .gitignore).
const AUTH_FILE = path.resolve(__dirname, '../panel-auth.json');
const COOKIE = 'tp_sesion';
const DURACION_SESION = 30 * 24 * 3600e3;
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 5 * 60e3;

// En la nube definir TP_MODO_NUBE=1: así nunca se omite la contraseña por venir de "localhost"
const MODO_NUBE = /^(1|true|si|sí)$/i.test(process.env.TP_MODO_NUBE || '');

let datos = { usuario: null, hash: null, sal: null, exigirEnLocal: false, sesiones: {} };
try { datos = { ...datos, ...JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) }; } catch (_) {}

function guardar() {
  const ahora = Date.now();
  for (const [t, s] of Object.entries(datos.sesiones)) if (s.expira < ahora) delete datos.sesiones[t];
  fs.writeFileSync(AUTH_FILE, JSON.stringify(datos, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function hashear(password, sal) {
  return crypto.scryptSync(String(password), sal, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function igualSeguro(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const tieneCredenciales = () => !!(datos.usuario && datos.hash);

// Petición hecha en esta misma PC, sin pasar por un proxy (nginx/Caddy agregan X-Forwarded-For)
function esLocal(req) {
  if (MODO_NUBE) return false;
  const ip = req.socket?.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loopback && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'] && !req.headers.forwarded;
}

function leerCookie(req, nombre) {
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

function sesionValida(req) {
  const token = leerCookie(req, COOKIE);
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const s = datos.sesiones[hash];
  if (!s || s.expira < Date.now()) return null;
  return { hash, ...s };
}

// 'sesion' | 'local' | null
function acceso(req) {
  if (sesionValida(req)) return 'sesion';
  if (esLocal(req) && (!tieneCredenciales() || !datos.exigirEnLocal)) return 'local';
  return null;
}

const esHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

function crearSesion(req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  datos.sesiones[hash] = { creada: Date.now(), expira: Date.now() + DURACION_SESION, agente: String(req.headers['user-agent'] || '').slice(0, 120) };
  guardar();
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACION_SESION / 1000}${esHttps(req) ? '; Secure' : ''}`);
}

function borrarCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${esHttps(req) ? '; Secure' : ''}`);
}

// Límite de intentos fallidos por IP
const intentos = new Map(); // ip → { fallos, hasta }
function ipDe(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(); }
function bloqueadoHasta(req) {
  const r = intentos.get(ipDe(req));
  return r && r.hasta > Date.now() ? r.hasta : 0;
}
function registrarFallo(req) {
  const ip = ipDe(req);
  const r = intentos.get(ip) || { fallos: 0, hasta: 0 };
  r.fallos++;
  if (r.fallos >= MAX_INTENTOS) { r.hasta = Date.now() + BLOQUEO_MS; r.fallos = 0; }
  intentos.set(ip, r);
}

function validarPassword(p) {
  if (typeof p !== 'string' || p.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  if (p.length > 200) return 'La contraseña es demasiado larga';
  return null;
}

// ── Rutas ──
const PUBLICAS = new Set(['/login', '/api/auth/login', '/api/auth/estado', '/pt-logo.jpg']);

function registrar(app) {
  app.get('/login', (req, res) => {
    if (acceso(req)) return res.redirect('/');
    res.sendFile(path.resolve(__dirname, '../public/login.html'));
  });

  app.get('/api/auth/estado', (req, res) => {
    const a = acceso(req);
    res.json({ autenticado: !!a, via: a, configurado: tieneCredenciales(), usuario: a ? datos.usuario : null,
      exigirEnLocal: !!datos.exigirEnLocal, esLocal: esLocal(req), modoNube: MODO_NUBE });
  });

  app.post('/api/auth/login', (req, res) => {
    const hasta = bloqueadoHasta(req);
    if (hasta) return res.status(429).json({ error: `Demasiados intentos. Vuelve a intentar en ${Math.ceil((hasta - Date.now()) / 60000)} min.` });
    if (!tieneCredenciales()) return res.status(400).json({ error: 'Aún no hay una contraseña configurada. Créala desde Ajustes en la PC donde corre la aplicación.' });
    const { usuario, password } = req.body || {};
    const ok = typeof usuario === 'string' && typeof password === 'string' &&
      usuario.trim().toLowerCase() === datos.usuario.toLowerCase() && igualSeguro(hashear(password, datos.sal), datos.hash);
    if (!ok) { registrarFallo(req); return res.status(401).json({ error: 'Usuario o contraseña incorrectos' }); }
    intentos.delete(ipDe(req));
    crearSesion(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const s = sesionValida(req);
    if (s) { delete datos.sesiones[s.hash]; guardar(); }
    borrarCookie(req, res);
    res.json({ ok: true });
  });

  // Crear o cambiar usuario/contraseña. La primera vez solo desde esta PC.
  app.post('/api/auth/configurar', (req, res) => {
    const a = acceso(req);
    if (!a) return res.status(401).json({ error: 'No autorizado' });
    const { usuario, password, passwordActual, exigirEnLocal } = req.body || {};
    if (!tieneCredenciales() && a !== 'local') return res.status(403).json({ error: 'La primera contraseña se crea desde la PC donde corre la aplicación' });
    if (tieneCredenciales() && password !== undefined && !igualSeguro(hashear(passwordActual || '', datos.sal), datos.hash)) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }
    if (password !== undefined) {
      const u = String(usuario || '').trim();
      if (!/^[\w.@-]{3,40}$/.test(u)) return res.status(400).json({ error: 'El usuario debe tener entre 3 y 40 letras, números o . _ - @' });
      const err = validarPassword(password);
      if (err) return res.status(400).json({ error: err });
      datos.usuario = u;
      datos.sal = crypto.randomBytes(16).toString('hex');
      datos.hash = hashear(password, datos.sal);
      datos.sesiones = {}; // cerrar las demás sesiones al cambiar la contraseña
    }
    if (exigirEnLocal !== undefined) {
      if (exigirEnLocal && !tieneCredenciales()) return res.status(400).json({ error: 'Primero crea un usuario y contraseña' });
      datos.exigirEnLocal = !!exigirEnLocal;
    }
    guardar();
    if (password !== undefined) crearSesion(req, res);
    res.json({ ok: true });
  });

  // Todo lo demás (panel, API, SSE, archivos del chat) requiere acceso
  app.use((req, res, next) => {
    if (PUBLICAS.has(req.path) || acceso(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sesión requerida', login: true });
    res.redirect('/login');
  });
}

module.exports = { registrar, esLocal };
