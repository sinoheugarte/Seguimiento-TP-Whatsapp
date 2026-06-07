const path = require('path');
const fs = require('fs');

const KNOWLEDGE_DIR = path.resolve('knowledge');
const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const conversationHistory = new Map(); // chatId → [{role, content}]
const MAX_HISTORY = 16;

function leerConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function cargarTextoDocumento(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (['.txt', '.md'].includes(ext)) {
    return fs.readFileSync(filepath, 'utf8');
  }
  if (ext === '.pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(filepath));
      return data.text;
    } catch (_) { return ''; }
  }
  return '';
}

async function buildSystemPrompt(agente) {
  let docs = '';
  if (fs.existsSync(KNOWLEDGE_DIR)) {
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => !f.startsWith('.'));
    for (const f of files) {
      const texto = await cargarTextoDocumento(path.join(KNOWLEDGE_DIR, f));
      if (texto.trim()) docs += `\n\n=== ${f} ===\n${texto.trim()}`;
    }
  }
  return [
    'Eres un coordinador profesional de servicio de transporte de carga.',
    'Atiendes consultas de clientes y socios de manera profesional, clara y concisa.',
    'Eres amable, eficiente y orientado a resolver las necesidades del cliente.',
    'Cuando no tienes información suficiente para responder, lo indicas amablemente.',
    'Responde siempre en el mismo idioma del usuario.',
    docs ? `\n\nBase de conocimiento de la empresa:${docs}` : '',
    agente.instruccionesExtra ? `\nInstrucciones adicionales:\n${agente.instruccionesExtra}` : ''
  ].filter(Boolean).join('\n');
}

async function procesarMensaje(chatId, texto) {
  const config = leerConfig();
  const agente = config.agente;
  if (!agente?.activo) return null;

  const esGrupo = chatId.endsWith('@g.us');
  const esPrivado = chatId.endsWith('@s.whatsapp.net');

  if (agente.filtro === 'grupos' && !esGrupo) return null;
  if (agente.filtro === 'privados' && !esPrivado) return null;
  if (agente.filtro === 'especificos' && !(agente.chatsFiltros || []).includes(chatId)) return null;

  // Respuestas rápidas tienen prioridad
  const textoLower = texto.toLowerCase().trim();
  for (const rr of agente.respuestasRapidas || []) {
    if (!rr.activa) continue;
    if ((rr.palabrasClave || []).some(p => p && textoLower.includes(p.toLowerCase()))) {
      console.log(`[Agente] Respuesta rápida → ${chatId}`);
      return rr.respuesta;
    }
  }

  if (!agente.apiKey) return null;

  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch (_) { console.error('[Agente] @anthropic-ai/sdk no instalado'); return null; }

  const client = new Anthropic({ apiKey: agente.apiKey });
  const systemPrompt = await buildSystemPrompt(agente);

  if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
  const history = conversationHistory.get(chatId);
  history.push({ role: 'user', content: texto });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  try {
    const response = await client.messages.create({
      model: agente.modelo || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [...history]
    });
    const respuesta = response.content[0].text;
    history.push({ role: 'assistant', content: respuesta });
    console.log(`[Agente] Respondido → ${chatId}`);
    return respuesta;
  } catch (err) {
    console.error('[Agente] Error API:', err.message);
    return null;
  }
}

function limpiarHistorial(chatId) {
  if (chatId) conversationHistory.delete(chatId);
  else conversationHistory.clear();
}

module.exports = { procesarMensaje, limpiarHistorial };
