const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, jidNormalizedUser, proto } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const P = require('pino');
const { execFile } = require('child_process');
const { procesarMensaje } = require('./agent');

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
function leerConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }

let socket = null;
let listo = false;
let ultimoQR = null;
let _reconectarIntentos = 0;

// ── Directorio de nombres ────────────────────────────────────────────────────
// Prioridad: 3 = nombre guardado en la agenda, 2 = nombre verificado/empresa, 1 = pushName
const contactosCache = new Map(); // jid → nombre
const contactosPrio = new Map();  // jid → prioridad del nombre guardado
const lidToJid = new Map();       // xxx@lid → número@s.whatsapp.net
const jidToLid = new Map();       // número@s.whatsapp.net → xxx@lid
const gruposNombres = new Map();  // xxx@g.us → asunto del grupo

const mensajesStore = new Map(); // chatId -> Message[]
const chatsRecientes = new Map(); // chatId -> {chatId, ultimo, ts, esGrupo, pushName, mediaTipo, fromMe}
const handoffChats = new Set(); // chatIds bajo control humano (bot pausado)
const MAX_MSGS_POR_CHAT = 500;
let _sseBroadcast = null;
function setSseBroadcast(fn) { _sseBroadcast = fn; }
function emitir(data) { if (_sseBroadcast) _sseBroadcast(data); }

function setHandoff(chatId, activo) {
  if (activo) handoffChats.add(chatId);
  else handoffChats.delete(chatId);
  emitir({ tipo: 'handoff', chatId, activo });
}
function isHandoff(chatId) { return handoffChats.has(chatId); }

const AUTH_DIR = path.resolve('.baileys_auth');
const CONTACTS_FILE = path.resolve('.baileys_auth', 'contacts-cache.json');
const MESSAGES_CACHE_FILE = path.resolve('.baileys_auth', 'messages-cache.json');
const AVATAR_DIR = path.resolve('.baileys_auth', 'avatars');
const CHAT_MEDIA_DIR = path.resolve(__dirname, '../public/chat-media');

function log(msg) {
  console.log('[WhatsApp]', msg);
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

function normJid(jid) {
  if (!jid) return jid;
  try { return jidNormalizedUser(jid) || jid; } catch (_) { return jid; }
}

function esContactoPrivado(id) {
  return !!id && (id.endsWith('@s.whatsapp.net') || id.endsWith('@lid'));
}

function esBroadcast(id) {
  return !id || id.endsWith('@broadcast') || id.endsWith('@newsletter');
}

// ── Estado de sincronización (indicador de progreso en la UI) ───────────────

let syncEstado = { fase: 'conectando', texto: 'Conectando con WhatsApp…', procesados: 0, total: 0, pct: null };
let _syncTimer = null;
let _syncPendiente = false;
function setSync(patch) {
  syncEstado = { ...syncEstado, ...patch };
  if (_syncTimer) { _syncPendiente = true; return; }
  emitir({ tipo: 'sync', ...syncEstado });
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    if (_syncPendiente) { _syncPendiente = false; emitir({ tipo: 'sync', ...syncEstado }); }
  }, 250);
}
function getSyncEstado() { return syncEstado; }

// Avisar a la UI que hay nombres/fotos nuevos (agrupado para no saturar)
let _nombresTimer = null;
function avisarNombres() {
  if (_nombresTimer) return;
  _nombresTimer = setTimeout(() => { _nombresTimer = null; emitir({ tipo: 'nombres' }); }, 1200);
}

// ── Persistencia de mensajes ─────────────────────────────────────────────────

function cargarMensajesCache() {
  try {
    if (!fs.existsSync(MESSAGES_CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(MESSAGES_CACHE_FILE, 'utf8'));
    if (data.mensajes) {
      for (const [k, v] of Object.entries(data.mensajes)) {
        mensajesStore.set(k, Array.isArray(v) ? v : []);
      }
    }
    if (data.chats) {
      for (const [k, v] of Object.entries(data.chats)) {
        chatsRecientes.set(k, v);
      }
    }
    const totalMsgs = Array.from(mensajesStore.values()).reduce((s, a) => s + a.length, 0);
    log(`Mensajes cargados desde cache: ${totalMsgs} en ${mensajesStore.size} chats`);
  } catch (_) {}
}

let _saveMsgsTimer = null;
function guardarMensajesCache() {
  clearTimeout(_saveMsgsTimer);
  _saveMsgsTimer = setTimeout(() => {
    try {
      const obj = { mensajes: {}, chats: {} };
      for (const [k, v] of mensajesStore) obj.mensajes[k] = v;
      for (const [k, v] of chatsRecientes) obj.chats[k] = v;
      fs.writeFileSync(MESSAGES_CACHE_FILE, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }, 3000);
}

// ── Cache de contactos, grupos y LID ────────────────────────────────────────

const esSoloDigitos = (s) => /^\+?[\d\s\-()]+$/.test(String(s || '').trim());

function cargarContactosDescoCache() {
  try {
    if (!fs.existsSync(CONTACTS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    if (data && data.v === 2) {
      for (const [jid, [nombre, prio]] of Object.entries(data.nombres || {})) {
        contactosCache.set(jid, nombre); contactosPrio.set(jid, prio);
      }
      for (const [lid, pn] of Object.entries(data.lids || {})) { lidToJid.set(lid, pn); jidToLid.set(pn, lid); }
      for (const [g, n] of Object.entries(data.grupos || {})) gruposNombres.set(g, n);
    } else if (data) {
      // Formato anterior { jid: nombre }: descartar "nombres" que solo eran el número
      for (const [jid, nombre] of Object.entries(data)) {
        if (typeof nombre !== 'string' || !nombre.trim() || esSoloDigitos(nombre)) continue;
        contactosCache.set(jid, nombre.trim()); contactosPrio.set(jid, 2);
      }
    }
    log(`Directorio cargado: ${contactosCache.size} contactos, ${gruposNombres.size} grupos, ${lidToJid.size} LID`);
  } catch (_) {}
}

let _saveTimer = null;
function guardarContactosCache() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const nombres = {};
      for (const [jid, n] of contactosCache) nombres[jid] = [n, contactosPrio.get(jid) || 1];
      const obj = { v: 2, nombres, lids: Object.fromEntries(lidToJid), grupos: Object.fromEntries(gruposNombres) };
      fs.writeFileSync(CONTACTS_FILE, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }, 2000);
}

function setNombre(jid, nombre, prio) {
  jid = normJid(jid);
  if (!esContactoPrivado(jid) || !nombre) return false;
  nombre = String(nombre).trim();
  if (!nombre || esSoloDigitos(nombre)) return false;
  const prevPrio = contactosPrio.get(jid) || 0;
  if (prevPrio > prio) return false;
  if (contactosCache.get(jid) === nombre && prevPrio === prio) return false;
  contactosCache.set(jid, nombre);
  contactosPrio.set(jid, prio);
  guardarContactosCache();
  avisarNombres();
  return true;
}

function setGrupo(jid, nombre) {
  jid = normJid(jid);
  if (!jid?.endsWith('@g.us') || !nombre || !String(nombre).trim()) return;
  nombre = String(nombre).trim();
  if (gruposNombres.get(jid) === nombre) return;
  gruposNombres.set(jid, nombre);
  guardarContactosCache();
  avisarNombres();
}

function setLidPn(lid, pn) {
  lid = normJid(lid); pn = normJid(pn);
  if (!lid?.endsWith('@lid') || !pn?.endsWith('@s.whatsapp.net')) return;
  if (lidToJid.get(lid) === pn) return;
  lidToJid.set(lid, pn);
  jidToLid.set(pn, lid);
  guardarContactosCache();
  avisarNombres();
}

// Devuelve el @s.whatsapp.net equivalente de un @lid (o el mismo jid si no se conoce)
function resolverLid(chatId) {
  if (!chatId?.endsWith('@lid')) return chatId;
  return lidToJid.get(normJid(chatId)) || chatId;
}

// Mejor nombre conocido para un jid, combinando su forma @lid y @s.whatsapp.net
function nombreYPrio(jid) {
  jid = normJid(jid);
  if (!jid) return { nombre: '', prio: 0 };
  if (jid.endsWith('@g.us')) return { nombre: gruposNombres.get(jid) || '', prio: 3 };
  const pn = jid.endsWith('@lid') ? lidToJid.get(jid) : jid;
  const lid = jid.endsWith('@lid') ? jid : jidToLid.get(jid);
  let nombre = '', prio = 0;
  for (const j of [pn, lid]) {
    if (!j || !contactosCache.has(j)) continue;
    const p = contactosPrio.get(j) || 1;
    if (p > prio) { nombre = contactosCache.get(j); prio = p; }
  }
  return { nombre, prio };
}
function nombreDe(jid) { return nombreYPrio(jid).nombre; }

function formatearNumero(pnJid) {
  const d = String(pnJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (d.length <= 9) return d ? `+${d}` : '';
  const cc = d.slice(0, d.length - 9);
  const r = d.slice(-9);
  return `+${cc} ${r.slice(0, 3)} ${r.slice(3, 6)} ${r.slice(6)}`;
}

function numeroDe(jid) {
  const pn = jid?.endsWith('@lid') ? lidToJid.get(normJid(jid)) : jid;
  return pn?.endsWith('@s.whatsapp.net') ? formatearNumero(pn) : '';
}

// Etiqueta visible de un chat, igual que WhatsApp: nombre guardado → número → ~pushName
function etiquetaChat(chatId, pushName) {
  const n = nombreDe(chatId);
  if (n) return n;
  if (chatId.endsWith('@g.us')) return 'Grupo';
  if (chatId.endsWith('@newsletter')) return 'Canal';
  return numeroDe(chatId) || (pushName ? `~ ${pushName}` : chatId.split('@')[0]);
}

function esYo(jid) {
  const u = socket?.user;
  if (!u || !jid) return false;
  const j = normJid(jid);
  return j === normJid(u.id) || (!!u.lid && j === normJid(u.lid));
}

function autorInfo(jid, push = '') {
  const { nombre, prio } = nombreYPrio(jid);
  const numero = numeroDe(jid);
  const alias = push || (prio < 3 ? nombre : '');
  if (prio >= 2 && nombre) return { autor: nombre, autorAlias: '', autorFotoV: versionFoto(jid) };
  if (numero) return { autor: numero, autorAlias: alias && alias !== numero ? alias : '', autorFotoV: versionFoto(jid) };
  return { autor: `~ ${alias || String(jid || '').split('@')[0]}`, autorAlias: '', autorFotoV: versionFoto(jid) };
}

function procesarContacto(c) {
  if (!c?.id) return;
  const id = normJid(c.id);
  if (id.endsWith('@g.us')) { setGrupo(id, c.subject || c.name); return; }
  if (!esContactoPrivado(id)) return;
  if (c.lid && id.endsWith('@s.whatsapp.net')) setLidPn(c.lid, id);
  if (c.phoneNumber && id.endsWith('@lid')) setLidPn(id, c.phoneNumber);
  if (c.name) setNombre(id, c.name, 3);
  if (c.verifiedName) setNombre(id, c.verifiedName, 2);
  if (c.notify) setNombre(id, c.notify, 1);
}

// Aprende LID↔número y pushName a partir de la clave de un mensaje
function aprenderDeMensaje(msg) {
  const k = msg.key || {};
  if (k.remoteJidAlt) {
    if (k.remoteJid?.endsWith('@lid')) setLidPn(k.remoteJid, k.remoteJidAlt);
    else if (k.remoteJidAlt.endsWith('@lid')) setLidPn(k.remoteJidAlt, k.remoteJid);
  }
  if (k.participant && k.participantAlt) {
    if (k.participant.endsWith('@lid')) setLidPn(k.participant, k.participantAlt);
    else if (k.participantAlt.endsWith('@lid')) setLidPn(k.participantAlt, k.participant);
  }
  if (!k.fromMe && msg.pushName) {
    const autor = k.remoteJid?.endsWith('@g.us') ? k.participant : k.remoteJid;
    if (autor) setNombre(autor, msg.pushName, 1);
  }
}

// ── Fotos de perfil ──────────────────────────────────────────────────────────
// Se guardan en .baileys_auth/avatars; un archivo vacío marca "sin foto / privada".

const FOTO_TTL = 3 * 24 * 3600e3;
const FOTO_NEG_TTL = 12 * 3600e3;
const fotoEnCurso = new Map();

function archivoFoto(jid) {
  return path.join(AVATAR_DIR, `${normJid(jid).replace(/[^\w.@-]/g, '_')}.jpg`);
}

// 'fresca' | 'vieja' | 'sin' | 'desconocida'
function estadoFoto(jid) {
  try {
    const st = fs.statSync(archivoFoto(jid));
    const edad = Date.now() - st.mtimeMs;
    if (st.size === 0) return edad < FOTO_NEG_TTL ? 'sin' : 'desconocida';
    return edad < FOTO_TTL ? 'fresca' : 'vieja';
  } catch (_) { return 'desconocida'; }
}

function versionFoto(jid) {
  try { const st = fs.statSync(archivoFoto(jid)); return st.size > 0 ? Math.floor(st.mtimeMs) : 0; } catch (_) { return null; }
}

function esLimiteDeTasa(e) {
  return e?.output?.statusCode === 429 || /rate-overlimit|429/i.test(e?.message || '');
}

function descargarFoto(jid) {
  jid = normJid(jid);
  if (fotoEnCurso.has(jid)) return fotoEnCurso.get(jid);
  const p = (async () => {
    if (!listo || !socket) return;
    const candidatos = [jid];
    if (jid.endsWith('@lid') && lidToJid.get(jid)) candidatos.push(lidToJid.get(jid));
    let url = null;
    for (const c of candidatos) {
      try { url = await socket.profilePictureUrl(c, 'preview', 8000); }
      catch (e) { if (esLimiteDeTasa(e)) throw e; }
      if (url) break;
    }
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    if (!url) { fs.writeFileSync(archivoFoto(jid), ''); return; }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(archivoFoto(jid), Buffer.from(await r.arrayBuffer()));
  })().finally(() => fotoEnCurso.delete(jid));
  fotoEnCurso.set(jid, p);
  return p;
}

// Para el endpoint: devuelve la ruta del archivo o null si el chat no tiene foto
async function obtenerFotoPerfil(jid) {
  let est = estadoFoto(jid);
  if (est === 'desconocida') {
    try { await descargarFoto(jid); } catch (_) {}
    est = estadoFoto(jid);
  } else if (est === 'vieja') {
    descargarFoto(jid).catch(() => {});
  }
  return (est === 'fresca' || est === 'vieja') ? archivoFoto(jid) : null;
}

// ── Resolución en segundo plano de nombres, números y fotos ─────────────────

const gruposFallidos = new Set();
let _resolviendo = false;
let _resolverOtraVez = false;
let _gruposTs = 0;

async function refrescarGrupos(forzar = false) {
  if (!listo || !socket) return;
  if (!forzar && Date.now() - _gruposTs < 10 * 60e3) return;
  _gruposTs = Date.now();
  try {
    const grupos = await socket.groupFetchAllParticipating();
    for (const g of Object.values(grupos)) setGrupo(g.id, g.subject);
  } catch (e) { log(`No se pudo obtener la lista de grupos: ${e.message?.slice(0, 60)}`); }
}

async function resolverPendientes() {
  if (_resolviendo) { _resolverOtraVez = true; return; }
  _resolviendo = true;
  try {
    do {
      _resolverOtraVez = false;
      if (!listo || !socket) break;
      setSync({ fase: 'resolviendo', texto: 'Actualizando nombres de grupos…', procesados: 0, total: 0, pct: null });
      await refrescarGrupos();

      const chats = [...chatsRecientes.values()]
        .filter(c => !esBroadcast(c.chatId))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const total = chats.length;
      let procesados = 0;
      setSync({ fase: 'resolviendo', texto: 'Actualizando nombres y fotos', procesados, total, pct: null });

      let i = 0;
      const trabajador = async () => {
        while (i < chats.length && listo) {
          const { chatId } = chats[i++];
          try {
            if (chatId.endsWith('@g.us') && !gruposNombres.has(chatId) && !gruposFallidos.has(chatId)) {
              try {
                const meta = await socket.groupMetadata(chatId);
                if (meta?.subject) setGrupo(chatId, meta.subject);
                else gruposFallidos.add(chatId);
              } catch (e) { if (esLimiteDeTasa(e)) throw e; gruposFallidos.add(chatId); }
            }
            if (chatId.endsWith('@lid') && !lidToJid.has(chatId)) {
              const pn = await socket.signalRepository?.lidMapping?.getPNForLID(chatId).catch(() => null);
              if (pn) setLidPn(chatId, pn);
            }
            const est = estadoFoto(chatId);
            if (est === 'desconocida' || est === 'vieja') {
              await descargarFoto(chatId);
              avisarNombres();
              await esperar(150);
            }
          } catch (e) {
            if (esLimiteDeTasa(e)) { log('WhatsApp pidió bajar el ritmo; pausa de 10s'); await esperar(10000); }
          }
          procesados++;
          setSync({ fase: 'resolviendo', texto: 'Actualizando nombres y fotos', procesados, total });
        }
      };
      await Promise.all([trabajador(), trabajador(), trabajador()]);
    } while (_resolverOtraVez && listo);
  } finally {
    _resolviendo = false;
    if (listo) setSync({ fase: 'listo', texto: 'Sincronizado', procesados: 0, total: 0, pct: null });
    emitir({ tipo: 'nombres' });
  }
}

let _resolverTimer = null;
function programarResolucion(ms = 2500) {
  clearTimeout(_resolverTimer);
  _resolverTimer = setTimeout(() => resolverPendientes().catch(() => {}), ms);
}

// ── Presencia (en línea / escribiendo) e integrantes de grupos ──────────────

const presencias = new Map(); // chatId → { participante: { estado, lastSeen, ts } }
const metaGrupos = new Map(); // chatId → { ts, participantes: [jid] }
const suscritos = new Map();  // chatId → ts de la última suscripción

function registrarPresencia(id, presences) {
  const chatId = normJid(id);
  const claves = [chatId];
  if (chatId.endsWith('@lid') && lidToJid.get(chatId)) claves.push(lidToJid.get(chatId));
  if (chatId.endsWith('@s.whatsapp.net') && jidToLid.get(chatId)) claves.push(jidToLid.get(chatId));
  for (const clave of claves) {
    const actual = presencias.get(clave) || {};
    for (const [p, d] of Object.entries(presences || {})) {
      const pj = normJid(p);
      if (esYo(pj)) continue;
      const previo = actual[pj] || {};
      actual[pj] = { estado: d.lastKnownPresence, lastSeen: d.lastSeen ? d.lastSeen * 1000 : (previo.lastSeen || null), ts: Date.now() };
    }
    presencias.set(clave, actual);
    emitir({ tipo: 'presencia', chatId: clave, presencia: resumenPresencia(clave) });
  }
}

function nombreCorto(jid) {
  const { nombre, prio } = nombreYPrio(jid);
  if (prio >= 2 && nombre) return nombre.split(/\s+/)[0];
  return numeroDe(jid) || (nombre ? `~${nombre}` : String(jid).split('@')[0]);
}

function resumenPresencia(chatId) {
  const datos = presencias.get(chatId) || {};
  if (chatId.endsWith('@g.us')) {
    const activos = Object.entries(datos)
      .filter(([, d]) => (d.estado === 'composing' || d.estado === 'recording') && Date.now() - d.ts < 25000)
      .map(([jid, d]) => ({ nombre: nombreCorto(jid), estado: d.estado, ts: d.ts }));
    return { activos };
  }
  let mejor = null;
  for (const d of Object.values(datos)) if (!mejor || d.ts > mejor.ts) mejor = d;
  return mejor ? { estado: mejor.estado, lastSeen: mejor.lastSeen, ts: mejor.ts } : null;
}

async function infoChat(chatId) {
  chatId = normJid(chatId);
  if (listo && socket && Date.now() - (suscritos.get(chatId) || 0) > 4 * 60e3) {
    suscritos.set(chatId, Date.now());
    socket.presenceSubscribe(chatId).catch(() => {});
  }
  const info = { chatId, presencia: resumenPresencia(chatId) };
  if (!chatId.endsWith('@g.us')) return info;
  info.recuperandoAutores = await recuperarAutores(chatId);
  let m = metaGrupos.get(chatId);
  if (listo && socket && (!m || Date.now() - m.ts > 10 * 60e3)) {
    try {
      const meta = await socket.groupMetadata(chatId);
      if (meta?.subject) setGrupo(chatId, meta.subject);
      for (const p of meta?.participants || []) {
        if (p.id?.endsWith('@lid') && p.phoneNumber) setLidPn(p.id, p.phoneNumber);
        if (p.lid && p.id?.endsWith('@s.whatsapp.net')) setLidPn(p.lid, p.id);
      }
      m = { ts: Date.now(), participantes: (meta?.participants || []).map(p => normJid(p.id)) };
      metaGrupos.set(chatId, m);
    } catch (_) {}
  }
  if (m) {
    const lista = m.participantes.map(jid => {
      const { nombre, prio } = nombreYPrio(jid);
      return { jid, yo: esYo(jid), corto: nombreCorto(jid), guardado: prio >= 2 && !!nombre };
    });
    // Orden como WhatsApp: contactos guardados (A-Z), luego números, y "Tú" al final
    lista.sort((a, b) => (a.yo - b.yo) || (b.guardado - a.guardado) || a.corto.localeCompare(b.corto, 'es', { sensitivity: 'base' }));
    info.participantes = lista.map(p => (p.yo ? 'Tú' : p.corto));
    info.totalParticipantes = lista.length;
  }
  return info;
}

// Mensajes de grupo guardados sin autor: pedir al celular que reenvíe ese tramo del historial
const chatsConAutorNuevo = new Set();
const historialPedido = new Set();
async function recuperarAutores(chatId) {
  if (!listo || !socket || !chatId.endsWith('@g.us') || historialPedido.has(chatId)) return false;
  const lista = mensajesStore.get(chatId) || [];
  const sinAutor = lista.filter(m => !m.fromMe && !m.autorId).length;
  if (!sinAutor) return false;
  const ancla = lista[lista.length - 1];
  historialPedido.add(chatId);
  try {
    await socket.fetchMessageHistory(Math.min(100, lista.length), { remoteJid: chatId, id: ancla.id, fromMe: !!ancla.fromMe }, ancla.ts);
    log(`Pedido historial de ${chatId} para recuperar autores de ${sinAutor} mensajes`);
    return true;
  } catch (e) {
    log(`No se pudo pedir historial de ${chatId}: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

function avisarAutoresNuevos() {
  for (const chatId of chatsConAutorNuevo) emitir({ tipo: 'mensajes_actualizados', chatId });
  chatsConAutorNuevo.clear();
}

// Mensajes con el autor resuelto en el momento de leerlos (los nombres pueden llegar después)
function mensajesDe(chatId) {
  const lista = mensajesStore.get(chatId) || [];
  if (!chatId.endsWith('@g.us')) return lista;
  const digitosGrupo = chatId.split('@')[0];
  return lista.map(m => {
    if (m.fromMe) return m;
    if (!m.autorId) return m.autor === digitosGrupo ? { ...m, autor: '' } : m;
    const push = m.autorPush ?? (m.autor && !/^[+\d\s~]/.test(m.autor) ? m.autor : '');
    return { ...m, ...autorInfo(m.autorId, push) };
  });
}

// ── Guardado de mensajes ─────────────────────────────────────────────────────

async function guardarMensaje(msg, { descargarMedia = true, emitirSSE = true } = {}) {
  const chatId = normJid(msg.key?.remoteJid);
  if (!chatId || chatId === 'status@broadcast') return;
  const m = msg.message || {};

  // Ignorar mensajes no visibles: reacciones, eliminaciones, distribución de claves, etc.
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage ||
      m.retryRequestMessage || m.appStateSyncKeyShare) return;

  aprenderDeMensaje(msg);

  // Desenvolver mensajes "envoltorio" (efímeros, ver-una-vez, doc con caption, etc.)
  const mc = m.ephemeralMessage?.message ||
             m.viewOnceMessage?.message ||
             m.viewOnceMessageV2?.message?.message ||
             m.documentWithCaptionMessage?.message ||
             m;

  let texto = mc.conversation || mc.extendedTextMessage?.text ||
    mc.imageMessage?.caption || mc.videoMessage?.caption ||
    mc.documentMessage?.caption || '';

  if (!texto) {
    if (mc.stickerMessage)             texto = '[Sticker]';
    else if (mc.locationMessage)       texto = '📍 Ubicación compartida';
    else if (mc.liveLocationMessage)   texto = '📍 Ubicación en vivo';
    else if (mc.contactMessage)        texto = `👤 ${mc.contactMessage.displayName || 'Contacto'}`;
    else if (mc.contactsArrayMessage)  texto = '👥 Contactos compartidos';
    else if (mc.pollCreationMessage)   texto = `📊 Encuesta: ${mc.pollCreationMessage.name || ''}`;
    else if (mc.pollCreationMessageV3) texto = `📊 Encuesta: ${mc.pollCreationMessageV3.name || ''}`;
    else if (mc.eventMessage)          texto = `📅 Evento: ${mc.eventMessage.name || ''}`;
    else if (mc.pollCreationMessageV2) texto = `📊 Encuesta: ${mc.pollCreationMessageV2.name || ''}`;
    else if (mc.groupInviteMessage)    texto = `👥 Invitación al grupo: ${mc.groupInviteMessage.groupName || 'grupo'}`;
    else if (mc.buttonsMessage)        texto = mc.buttonsMessage.contentText || mc.buttonsMessage.headerText || '[Mensaje con botones]';
    else if (mc.listMessage)           texto = mc.listMessage.description || mc.listMessage.title || '[Lista]';
    else if (mc.interactiveMessage)    texto = mc.interactiveMessage.body?.text || '[Mensaje interactivo]';
    else if (mc.templateMessage)       texto = mc.templateMessage.hydratedTemplate?.hydratedContentText || '[Plantilla]';
    else if (m.viewOnceMessage || m.viewOnceMessageV2) texto = '[Mensaje de ver una vez]';
  }

  let mediaTipo = null;
  let mediaPath = null;
  const tieneImagen = !!(mc.imageMessage || mc.stickerMessage);
  const tieneVideo  = !!mc.videoMessage;
  const tieneAudio  = !!mc.audioMessage;
  const tieneDoc    = !!mc.documentMessage;
  if (tieneImagen || tieneVideo || tieneAudio || tieneDoc) {
    mediaTipo = tieneImagen ? 'imagen' : tieneVideo ? 'video' : tieneAudio ? 'audio' : 'documento';
  }

  if (descargarMedia && mediaTipo) {
    try {
      if (!fs.existsSync(CHAT_MEDIA_DIR)) fs.mkdirSync(CHAT_MEDIA_DIR, { recursive: true });
      const msgDownload = (mc !== m) ? { ...msg, message: mc } : msg;
      const buf = await downloadMediaMessage(msgDownload, 'buffer', {}, { reuploadRequest: socket?.updateMediaMessage });
      let ext = '.bin';
      if (tieneImagen)     ext = mc.stickerMessage ? '.webp' : '.jpg';
      else if (tieneVideo) ext = '.mp4';
      else if (tieneAudio) ext = '.ogg';
      else if (tieneDoc)   ext = path.extname(mc.documentMessage.fileName || '') || '.bin';
      const fname = `${msg.key.id || Date.now()}${ext}`.replace(/[^\w.\-]/g, '_');
      fs.writeFileSync(path.join(CHAT_MEDIA_DIR, fname), buf);
      mediaPath = `/chat-media/${fname}`;
    } catch (e) {
      log(`[ChatMedia] no se pudo descargar (${e.message?.slice(0, 60)})`);
    }
  }

  const fromMe = !!msg.key.fromMe;
  const ts = Number(msg.messageTimestamp) * 1000 || Date.now();
  const pushName = fromMe ? '' : (msg.pushName || '');
  const esGrupo = chatId.endsWith('@g.us');
  const autorJid = esGrupo ? normJid(msg.key.participant) : chatId;

  const msgObj = {
    id: msg.key.id,
    chatId,
    fromMe,
    texto: texto || '',
    ts,
    autor: fromMe ? 'Tú' : (nombreDe(autorJid) || numeroDe(autorJid) || pushName || (autorJid || '').split('@')[0]),
    autorId: fromMe ? null : autorJid,
    autorPush: pushName,
    mediaTipo,
    mediaPath,
    docNombre: mc.documentMessage?.fileName || null
  };

  if (!mensajesStore.has(chatId)) mensajesStore.set(chatId, []);
  const lista = mensajesStore.get(chatId);
  const existente = lista.find(x => x.id === msgObj.id);
  if (!existente) {
    const ultimo = lista[lista.length - 1];
    lista.push(msgObj);
    if (ultimo && msgObj.ts < ultimo.ts) lista.sort((a, b) => a.ts - b.ts);
    if (lista.length > MAX_MSGS_POR_CHAT) lista.shift();
  } else if (!existente.fromMe && !existente.autorId && msgObj.autorId) {
    // Copia guardada por una versión anterior sin autor: completarla con lo que trae WhatsApp
    Object.assign(existente, { autorId: msgObj.autorId, autorPush: msgObj.autorPush, autor: msgObj.autor });
    if (!existente.mediaTipo && msgObj.mediaTipo) existente.mediaTipo = msgObj.mediaTipo;
    chatsConAutorNuevo.add(chatId);
  }

  const ultimoTexto = texto || (
    mediaTipo === 'imagen'    ? '📷 Foto' :
    mediaTipo === 'video'     ? '🎥 Video' :
    mediaTipo === 'audio'     ? '🎤 Audio' :
    mediaTipo === 'documento' ? `📄 ${mc.documentMessage?.fileName || 'Documento'}` :
    '[Mensaje]'
  );
  const previo = chatsRecientes.get(chatId);
  if (!previo || ts >= (previo.ts || 0)) {
    chatsRecientes.set(chatId, {
      chatId,
      ultimo: ultimoTexto,
      ts,
      esGrupo,
      fromMe,
      autorUltimo: esGrupo && !fromMe ? msgObj.autor : '',
      pushName: (!esGrupo && pushName) ? pushName : (previo?.pushName || '')
    });
  }
  if (emitirSSE) {
    const extra = esGrupo && !fromMe && autorJid ? autorInfo(autorJid, pushName) : {};
    emitir({ tipo: 'mensaje', ...msgObj, ...extra, chatNombre: etiquetaChat(chatId, pushName) });
  }
  guardarMensajesCache();
  return msgObj;
}

// ── Conexión ────────────────────────────────────────────────────────────────

function limpiarCredenciales(conservar) {
  try {
    for (const f of fs.readdirSync(AUTH_DIR)) {
      const ruta = path.join(AUTH_DIR, f);
      if (conservar.includes(f) || fs.statSync(ruta).isDirectory()) continue;
      fs.unlinkSync(ruta);
    }
  } catch (_) {}
}

let _directorioCargado = false;

async function inicializar() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (!_directorioCargado) {
    cargarContactosDescoCache();
    cargarMensajesCache();
    _directorioCargado = true;
  }
  setSync({ fase: 'conectando', texto: 'Conectando con WhatsApp…', procesados: 0, total: 0, pct: null });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['TP-Whatsapp', 'Chrome', '1.0'],
    syncFullHistory: true
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      ultimoQR = qr;
      setSync({ fase: 'qr', texto: 'Escanea el código QR para vincular WhatsApp', pct: null, procesados: 0, total: 0 });
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
      _reconectarIntentos = 0;
      log('Conectado correctamente ✓');
      setSync({ fase: 'resolviendo', texto: 'Sincronizando chats…', procesados: 0, total: 0, pct: null });
      refrescarGrupos(true).finally(() => programarResolucion(3000));
    }

    if (connection === 'close') {
      listo = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || '';
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isRestartRequired = statusCode === 515;
      const delay = isRestartRequired ? 2000 : Math.min(5000 * Math.pow(2, _reconectarIntentos), 60000);

      log(`Desconectado. Código=${statusCode} Razón="${reason}" Reintento=${_reconectarIntentos}`);

      if (isLoggedOut) {
        _reconectarIntentos = 0;
        log('Sesión cerrada (loggedOut). Limpiando credenciales...');
        limpiarCredenciales(['contacts-cache.json', 'messages-cache.json']);
        setSync({ fase: 'conectando', texto: 'Sesión cerrada — generando nuevo QR…', pct: null });
        setTimeout(inicializar, 3000);
      } else {
        _reconectarIntentos++;
        log(`Reconectando en ${delay / 1000}s (intento ${_reconectarIntentos})...`);
        setSync({ fase: 'conectando', texto: `Reconectando en ${Math.round(delay / 1000)} s…`, pct: null, procesados: 0, total: 0 });
        setTimeout(inicializar, delay);
      }
    }
  });

  socket.ev.on('groups.upsert', (grupos) => { for (const g of grupos) setGrupo(g.id, g.subject); });
  socket.ev.on('groups.update', (grupos) => { for (const g of grupos) if (g.subject) setGrupo(g.id, g.subject); });
  socket.ev.on('lid-mapping.update', ({ lid, pn }) => setLidPn(lid, pn));
  socket.ev.on('presence.update', ({ id, presences }) => registrarPresencia(id, presences));
  socket.ev.on('group-participants.update', ({ id }) => metaGrupos.delete(normJid(id)));

  // Carga masiva: contactos + chats + mensajes históricos (llega en varios lotes)
  socket.ev.on('messaging-history.set', async ({ contacts = [], chats = [], messages = [], lidPnMappings = [], progress, syncType }) => {
    const bajoDemanda = syncType === proto.HistorySync.HistorySyncType.ON_DEMAND;
    for (const mp of lidPnMappings) setLidPn(mp.lid, mp.pn);
    for (const c of contacts) procesarContacto(c);
    for (const c of chats) {
      procesarContacto({ id: c.id, name: c.displayName || c.name, lid: c.lidJid, phoneNumber: c.pnJid });
    }

    const total = messages.length;
    const pctWA = typeof progress === 'number' ? Math.min(100, Math.max(0, Math.round(progress))) : null;
    log(`Historial recibido: ${total} mensajes, ${contacts.length} contactos (progreso WhatsApp: ${pctWA ?? '—'}%)`);
    if (!bajoDemanda) setSync({ fase: 'historial', texto: 'Sincronizando historial de chats', procesados: 0, total, pct: pctWA });

    for (let i = 0; i < total; i++) {
      try { await guardarMensaje(messages[i], { descargarMedia: false, emitirSSE: false }); } catch (_) {}
      if ((i + 1) % 100 === 0) {
        if (!bajoDemanda) setSync({ procesados: i + 1 });
        await esperar(0); // ceder el event loop para no congelar la conexión
      }
    }
    avisarAutoresNuevos();
    emitir({ tipo: 'nombres' });
    if (!bajoDemanda) programarResolucion();
  });

  socket.ev.on('contacts.upsert', (contacts) => { for (const c of contacts) procesarContacto(c); });
  socket.ev.on('contacts.update', (updates) => {
    for (const c of updates) {
      procesarContacto(c);
      if (c.id && c.imgUrl !== undefined) {
        try { fs.unlinkSync(archivoFoto(c.id)); } catch (_) {}
        avisarNombres();
      }
    }
  });

  socket.ev.on('chats.upsert', (chats) => {
    for (const c of chats) procesarContacto({ id: c.id, name: c.displayName || c.name, lid: c.lidJid, phoneNumber: c.pnJid });
  });
  socket.ev.on('chats.update', (chats) => {
    for (const c of chats) if (c.name || c.displayName) procesarContacto({ id: c.id, name: c.displayName || c.name });
  });

  // Palabras clave que activan el handoff humano
  const PALABRAS_HANDOFF = ['hablar con humano', 'hablar con una persona', 'quiero hablar con alguien',
    'necesito hablar con alguien', 'asesor', 'agente humano', 'persona real'];

  // Agente IA: responder mensajes entrantes
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      let msgObj = null;
      try { msgObj = await guardarMensaje(msg); } catch (e) { log(`[guardarMensaje] error: ${e.message?.slice(0, 80)}`); }

      if (type !== 'notify') continue; // El agente IA solo procesa mensajes en tiempo real
      if (msg.key.fromMe) {
        // Solo procesar mensajes propios si empiezan con el prefijo configurado
        const chatId = msg.key.remoteJid;
        const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const { agente } = leerConfig();
        const prefijo = agente?.prefijoActivacion?.trim();
        if (!prefijo || !textoRaw.trimStart().toLowerCase().startsWith(prefijo.toLowerCase())) continue;
        const texto = textoRaw.trimStart().slice(prefijo.length).trim();
        if (!texto || !chatId) continue;
        log(`Mensaje propio con prefijo "${prefijo}" detectado en ${chatId}`);
        try {
          const respuesta = await procesarMensaje(resolverLid(chatId), texto);
          if (respuesta) await socket.sendMessage(chatId, { text: respuesta });
        } catch (err) { console.error('[Agente] Error procesando mensaje propio:', err.message); }
        continue;
      }

      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      const textoRaw = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption || '';

      // Detectar solicitud de handoff humano
      const textoLower = textoRaw.toLowerCase();
      if (PALABRAS_HANDOFF.some(p => textoLower.includes(p))) {
        setHandoff(chatId, true);
        await socket.sendMessage(chatId, { text: 'En un momento un asesor se comunicará con usted. Por favor espere.' });
        log(`[Handoff] Chat ${chatId} transferido a atención humana por solicitud del cliente`);
        continue;
      }

      if (isHandoff(chatId)) {
        log(`[Handoff] Mensaje ignorado por bot en ${chatId} (atención humana activa)`);
        continue;
      }

      // Normalizar @lid → @s.whatsapp.net para que coincida con el filtro guardado
      const chatIdFiltro = resolverLid(chatId);

      let imagenPath = null;
      if (msgObj?.mediaTipo === 'imagen' && msgObj?.mediaPath) {
        imagenPath = path.resolve(__dirname, '..', 'public', msgObj.mediaPath.replace(/^\//, ''));
      }

      if (!textoRaw.trim() && !imagenPath) continue;

      try {
        const respuesta = await procesarMensaje(chatIdFiltro, textoRaw || '[imagen]', imagenPath);
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
function esVideo(nombre) {
  return ['mp4','mov','avi','3gp','mkv','webm'].includes(path.extname(nombre).slice(1).toLowerCase());
}
function esAudio(nombre) {
  return ['mp3','ogg','aac','wav','opus','m4a','flac'].includes(path.extname(nombre).slice(1).toLowerCase());
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
    } else if (esVideo(nombreArchivo)) {
      await socket.sendMessage(chatId, { video: buffer, caption, mimetype: mime });
    } else if (esAudio(nombreArchivo)) {
      await socket.sendMessage(chatId, { audio: buffer, mimetype: mime, ptt: false });
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

// ── Envíos desde el chat en vivo ────────────────────────────────────────────

let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch (_) {}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('Falta ffmpeg: ejecuta "npm install" en la carpeta del proyecto'));
    execFile(FFMPEG, ['-loglevel', 'error', '-y', ...args], { timeout: 60000, windowsHide: true },
      (err) => err ? reject(new Error('No se pudo convertir el archivo: ' + err.message.slice(0, 120))) : resolve());
  });
}

function borrarSilencioso(ruta) { try { fs.unlinkSync(ruta); } catch (_) {} }

// tipo: 'auto' (según extensión) | 'documento' | 'ptt' (nota de voz) | 'sticker'
async function enviarChat(chatId, { texto = '', ruta = null, nombre = '', tipo = 'auto', verUnaVez = false } = {}) {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  if (!ruta) { await socket.sendMessage(chatId, { text: texto }); return; }

  if (tipo === 'ptt') {
    const salida = `${ruta}.ogg`;
    try {
      await ffmpeg(['-i', ruta, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', salida]);
      await socket.sendMessage(chatId, { audio: fs.readFileSync(salida), mimetype: 'audio/ogg; codecs=opus', ptt: true, ...(verUnaVez ? { viewOnce: true } : {}) });
    } finally { borrarSilencioso(salida); }
    return;
  }

  if (tipo === 'sticker') {
    const salida = `${ruta}.webp`;
    try {
      await ffmpeg(['-i', ruta, '-frames:v', '1', '-vf',
        'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
        '-c:v', 'libwebp', '-q:v', '80', salida]);
      await socket.sendMessage(chatId, { sticker: fs.readFileSync(salida) });
    } finally { borrarSilencioso(salida); }
    return;
  }

  const buffer = fs.readFileSync(ruta);
  const nombreArchivo = nombre || path.basename(ruta);
  const mime = getMime(nombreArchivo);
  if (tipo === 'documento') {
    await socket.sendMessage(chatId, { document: buffer, mimetype: mime, fileName: nombreArchivo, caption: texto });
  } else if (esImagen(nombreArchivo)) {
    await socket.sendMessage(chatId, { image: buffer, caption: texto, mimetype: mime });
  } else if (esVideo(nombreArchivo)) {
    await socket.sendMessage(chatId, { video: buffer, caption: texto, mimetype: mime });
  } else if (esAudio(nombreArchivo)) {
    await socket.sendMessage(chatId, { audio: buffer, mimetype: mime, ptt: false });
    if (texto) await socket.sendMessage(chatId, { text: texto });
  } else {
    await socket.sendMessage(chatId, { document: buffer, mimetype: mime, fileName: nombreArchivo, caption: texto });
  }
}

async function enviarContacto(chatId, nombre, numero) {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  const d = String(numero || '').replace(/\D/g, '');
  if (d.length < 6) throw new Error('Número de contacto inválido');
  const n = String(nombre || `+${d}`).replace(/[\r\n;]/g, ' ').trim();
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${n}\nTEL;type=CELL;type=VOICE;waid=${d}:+${d}\nEND:VCARD`;
  await socket.sendMessage(chatId, { contacts: { displayName: n, contacts: [{ vcard }] } });
}

async function enviarEncuesta(chatId, pregunta, opciones, multiple) {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  const values = [...new Set((opciones || []).map(o => String(o).trim()).filter(Boolean))].slice(0, 12);
  if (!String(pregunta || '').trim() || values.length < 2) throw new Error('La encuesta necesita una pregunta y al menos 2 opciones');
  await socket.sendMessage(chatId, { poll: { name: String(pregunta).trim(), values, selectableCount: multiple ? 0 : 1 } });
}

async function enviarEvento(chatId, { nombre, descripcion, inicio, fin, ubicacion }) {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  const startDate = new Date(inicio);
  if (!String(nombre || '').trim() || isNaN(startDate)) throw new Error('El evento necesita nombre y fecha de inicio');
  const endDate = fin ? new Date(fin) : undefined;
  await socket.sendMessage(chatId, { event: {
    name: String(nombre).trim(),
    description: String(descripcion || '').trim() || undefined,
    startDate,
    endDate: endDate && !isNaN(endDate) ? endDate : undefined,
    location: ubicacion ? { name: String(ubicacion).trim() } : undefined,
    extraGuestsAllowed: false
  } });
}

function ordenarAlf(arr) {
  return arr.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es', { sensitivity: 'base' }));
}

// La UI consulta el estado cada 15 s: se usa la caché y solo se refresca cada 10 min
async function listarGrupos() {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  await refrescarGrupos();
  return ordenarAlf([...gruposNombres].map(([chatId, nombre]) => ({ nombre, chatId })));
}

function listarContactos() {
  if (!listo) throw new Error('WhatsApp no esta conectado');
  const vistos = new Set();
  const lista = [];
  for (const [chatId, nombre] of contactosCache) {
    // Evitar duplicados @lid/@s.whatsapp.net del mismo contacto: preferir el número
    const pn = chatId.endsWith('@lid') ? lidToJid.get(chatId) : chatId;
    const clave = pn || chatId;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    lista.push({ nombre: nombreDe(clave) || nombre, chatId: clave, numero: numeroDe(clave) });
  }
  return ordenarAlf(lista);
}

// Lista para la columna de chats, con nombre y foto ya resueltos
function listarChats(limite = 1000) {
  return [...chatsRecientes.values()]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limite)
    .map(c => ({
      chatId: c.chatId,
      nombre: etiquetaChat(c.chatId, c.pushName),
      numero: c.esGrupo ? '' : numeroDe(c.chatId),
      ultimo: c.ultimo,
      autorUltimo: c.autorUltimo || '',
      fromMe: !!c.fromMe,
      ts: c.ts,
      esGrupo: !!c.esGrupo,
      fotoV: versionFoto(c.chatId)
    }));
}

function getChatsRecientes() { return chatsRecientes; }

function getUltimoQR() { return ultimoQR; }
function estaListo() { return listo; }

async function cerrarSesion() {
  listo = false;
  ultimoQR = null;
  try { if (socket) await socket.logout(); } catch (_) {}
  socket = null;
  limpiarCredenciales(['contacts-cache.json']);
  log('Sesión cerrada manualmente. Generando nuevo QR...');
  setTimeout(inicializar, 1500);
}

module.exports = {
  inicializar, enviarMensaje, listarGrupos, listarContactos, estaListo, getUltimoQR, cerrarSesion,
  getMensajesStore: () => mensajesStore, getChatsRecientes, listarChats, setSseBroadcast,
  setHandoff, isHandoff, getSyncEstado, obtenerFotoPerfil,
  enviarChat, enviarContacto, enviarEncuesta, enviarEvento, infoChat, mensajesDe
};
