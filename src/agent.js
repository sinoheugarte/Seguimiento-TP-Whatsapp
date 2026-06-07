const path = require('path');
const fs = require('fs');

const KNOWLEDGE_DIR = path.resolve('knowledge');
const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const conversationHistory = new Map();
const MAX_HISTORY = 16;

function leerConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function cargarTextoDocumento(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (['.txt', '.md'].includes(ext)) return fs.readFileSync(filepath, 'utf8');
  if (ext === '.pdf') {
    try {
      const data = await require('pdf-parse')(fs.readFileSync(filepath));
      return data.text;
    } catch (_) { return ''; }
  }
  return '';
}

async function buildSystemPrompt(agente) {
  let docs = '';
  if (fs.existsSync(KNOWLEDGE_DIR)) {
    for (const f of fs.readdirSync(KNOWLEDGE_DIR).filter(f => !f.startsWith('.'))) {
      const texto = await cargarTextoDocumento(path.join(KNOWLEDGE_DIR, f));
      if (texto.trim()) docs += `\n\n=== ${f} ===\n${texto.trim()}`;
    }
  }
  return [
    'Eres un coordinador profesional de servicio de transporte de carga.',
    'Atiendes consultas de clientes y socios de manera profesional, clara y concisa.',
    'Eres amable, eficiente y orientado a resolver las necesidades del cliente.',
    'Cuando no tienes información suficiente, lo indicas amablemente.',
    'Responde siempre en el mismo idioma del usuario.',
    docs ? `\n\nBase de conocimiento de la empresa:${docs}` : '',
    agente.instruccionesExtra ? `\nInstrucciones adicionales:\n${agente.instruccionesExtra}` : ''
  ].filter(Boolean).join('\n');
}

async function llamarAnthropic(agente, systemPrompt, history) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: agente.apiKey });
  const response = await client.messages.create({
    model: agente.modelo || 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [...history]
  });
  return response.content[0].text;
}

async function llamarGemini(agente, systemPrompt, history) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(agente.apiKey);
  const model = genAI.getGenerativeModel({
    model: agente.modelo || 'gemini-2.0-flash',
    systemInstruction: systemPrompt
  });
  const geminiHistory = history.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const chat = model.startChat({ history: geminiHistory });
  const result = await chat.sendMessage(history[history.length - 1].content);
  return result.response.text();
}

async function llamarGroq(agente, systemPrompt, history) {
  const Groq = require('groq-sdk');
  const groq = new Groq({ apiKey: agente.apiKey });
  const response = await groq.chat.completions.create({
    model: agente.modelo || 'llama-3.1-8b-instant',
    max_tokens: 1024,
    messages: [{ role: 'system', content: systemPrompt }, ...history]
  });
  return response.choices[0].message.content;
}

async function procesarMensaje(chatId, texto) {
  const config = leerConfig();
  const agente = config.agente;
  if (!agente?.activo) return null;

  const esGrupo = chatId.endsWith('@g.us');
  const esPrivado = chatId.endsWith('@s.whatsapp.net');
  const filtros = agente.chatsFiltros || [];

  if (agente.filtro === 'grupos') {
    if (!esGrupo) return null;
    if (filtros.length > 0 && !filtros.includes(chatId)) return null;
  } else if (agente.filtro === 'privados') {
    if (!esPrivado) return null;
    if (filtros.length > 0 && !filtros.includes(chatId)) return null;
  }

  // Respuestas rápidas tienen prioridad (sin costo de API)
  const textoLower = texto.toLowerCase().trim();
  for (const rr of agente.respuestasRapidas || []) {
    if (!rr.activa) continue;
    if ((rr.palabrasClave || []).some(p => p && textoLower.includes(p.toLowerCase()))) {
      console.log(`[Agente] Respuesta rápida → ${chatId}`);
      return rr.respuesta;
    }
  }

  if (!agente.apiKey) return null;

  const systemPrompt = await buildSystemPrompt(agente);
  if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
  const history = conversationHistory.get(chatId);
  history.push({ role: 'user', content: texto });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  try {
    const proveedor = agente.proveedor || 'anthropic';
    let respuesta;
    if (proveedor === 'gemini') respuesta = await llamarGemini(agente, systemPrompt, history);
    else if (proveedor === 'groq') respuesta = await llamarGroq(agente, systemPrompt, history);
    else respuesta = await llamarAnthropic(agente, systemPrompt, history);
    history.push({ role: 'assistant', content: respuesta });
    console.log(`[Agente] Respondido (${proveedor}) → ${chatId}`);
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
