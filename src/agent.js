const path = require('path');
const fs = require('fs');

const MIME_VISION = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

const KNOWLEDGE_DIR = path.resolve('knowledge');
const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const conversationHistory = new Map();
const MAX_HISTORY = 16;

function leerConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function cargarTextoDocumento(filepath) {
  const ext = path.extname(filepath).toLowerCase();

  // Texto plano
  if (['.txt', '.md', '.sql', '.csv'].includes(ext)) return fs.readFileSync(filepath, 'utf8');

  // PDF
  if (ext === '.pdf') {
    try {
      const data = await require('pdf-parse')(fs.readFileSync(filepath));
      return data.text;
    } catch (_) { return ''; }
  }

  // Word (.docx, .doc)
  if (ext === '.docx' || ext === '.doc') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filepath });
      return result.value;
    } catch (_) { return ''; }
  }

  // Excel (.xlsx, .xls)
  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(filepath);
      return wb.SheetNames.map(name => {
        const ws = wb.Sheets[name];
        return `=== Hoja: ${name} ===\n${XLSX.utils.sheet_to_csv(ws)}`;
      }).join('\n\n');
    } catch (_) { return ''; }
  }

  // PowerPoint (.pptx, .ppt)
  if (ext === '.pptx' || ext === '.ppt') {
    try {
      const officeParser = require('officeparser');
      const text = await officeParser.parseOfficeAsync(filepath);
      return text || '';
    } catch (_) { return ''; }
  }

  // Imágenes — se incluye referencia por nombre
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
    return `[Imagen adjunta: ${path.basename(filepath)}]`;
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

async function llamarAnthropic(agente, systemPrompt, history, imagenPath = null) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: agente.apiKey });

  let messages = [...history];

  // Visión: si el último mensaje lleva imagen, enriquecerlo con contenido multimodal
  if (imagenPath && fs.existsSync(imagenPath)) {
    const ext = path.extname(imagenPath).slice(1).toLowerCase();
    const mimeType = MIME_VISION[ext] || 'image/jpeg';
    const imageData = fs.readFileSync(imagenPath).toString('base64');
    const lastUser = messages[messages.length - 1];
    messages = [
      ...messages.slice(0, -1),
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageData } },
          { type: 'text', text: lastUser.content || 'Describe esta imagen y responde según el contexto del negocio.' }
        ]
      }
    ];
  }

  const model = agente.modelo || 'claude-haiku-5-5';
  // Caché de prompts: las instrucciones y la Base de Conocimiento son iguales en cada mensaje,
  // así que se cachean (lecturas a ~0,1× del precio). TTL de 1 h porque en un chat los mensajes
  // suelen llegar con pausas de más de 5 min; por debajo del mínimo cacheable la API lo ignora sin costo.
  const system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  const params = { model, max_tokens: 4096, system, messages };
  // Esfuerzo bajo: para chat de atención al cliente rinde igual y gasta menos (no existe en Haiku/Sonnet 4.5 ni anteriores)
  if (!/claude-3|(haiku|sonnet)-4-5/.test(model)) params.output_config = { effort: 'low' };

  // Opus 5.5 y Sonnet 5.5: si el modelo declina por sus filtros de seguridad, la API reintenta con otro modelo
  const conRespaldo = /^claude-(opus|sonnet)-5-5$/.test(model);
  const response = conRespaldo
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);

  const u = response.usage || {};
  console.log(`[Agente] Tokens — entrada: ${u.input_tokens ?? 0}, leídos de caché: ${u.cache_read_input_tokens ?? 0}, escritos en caché: ${u.cache_creation_input_tokens ?? 0}, salida: ${u.output_tokens ?? 0}`);

  if (response.stop_reason === 'refusal') {
    console.warn(`[Agente] El modelo declinó responder (${response.stop_details?.category || 'sin categoría'}); no se envía respuesta`);
    return null;
  }
  // Los modelos actuales devuelven primero un bloque de razonamiento: tomar solo el texto
  const texto = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return texto || null;
}

async function llamarGemini(agente, systemPrompt, history) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(agente.apiKey);
  const model = genAI.getGenerativeModel({
    model: agente.modelo || 'gemini-2.5-flash-lite',
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

// Devuelve true si el chatId es @lid y los filtros solo tienen contactos en formato
// @s.whatsapp.net (guardados antes de que WhatsApp introdujera @lid).
// En ese caso no podemos verificar exactamente, así que lo dejamos pasar.
function permitirLidSinMapeo(chatId, filtros) {
  if (!chatId.endsWith('@lid')) return false;
  const hayLidsEnFiltros = filtros.some(f => f.endsWith('@lid'));
  if (hayLidsEnFiltros) return false; // filtros tienen @lid → debe coincidir exacto
  const hayPrivadosAntiguos = filtros.some(f => f.endsWith('@s.whatsapp.net'));
  if (hayPrivadosAntiguos) {
    console.log(`[Agente] @lid aceptado (filtros en formato @s.whatsapp.net anterior — abrí Agente IA y vuelve a guardar para precisión exacta) → ${chatId}`);
    return true;
  }
  return false;
}

async function procesarMensaje(chatId, texto, imagenPath = null) {
  const config = leerConfig();
  const agente = config.agente;
  if (!agente?.activo) return null;

  const esGrupo = chatId.endsWith('@g.us');
  const esPrivado = chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid');
  const filtro = agente.filtro || 'todos';
  const filtros = agente.chatsFiltros || [];

  console.log(`[Agente] Mensaje de ${chatId} | filtro=${filtro} | esGrupo=${esGrupo} | esPrivado=${esPrivado} | chatsFiltros=[${filtros.join(', ')}]`);

  if (filtro === 'grupos') {
    if (!esGrupo) { console.log(`[Agente] Bloqueado: filtro=grupos pero el mensaje es de un chat privado (${chatId})`); return null; }
    if (filtros.length > 0 && !filtros.includes(chatId)) {
      console.log(`[Agente] Bloqueado: grupo ${chatId} no está en la lista seleccionada: [${filtros.join(', ')}]`);
      return null;
    }
  } else if (filtro === 'privados') {
    if (!esPrivado) { console.log(`[Agente] Bloqueado: filtro=privados pero el mensaje es de un grupo (${chatId})`); return null; }
    if (filtros.length > 0 && !filtros.includes(chatId)) {
      if (!permitirLidSinMapeo(chatId, filtros)) {
        console.log(`[Agente] Bloqueado: contacto ${chatId} no está en la lista seleccionada: [${filtros.join(', ')}]`);
        return null;
      }
    }
  } else if (filtro === 'ambos') {
    if (!esGrupo && !esPrivado) { console.log(`[Agente] Bloqueado: tipo de chat desconocido (${chatId})`); return null; }
    if (filtros.length > 0 && !filtros.includes(chatId)) {
      if (esPrivado && permitirLidSinMapeo(chatId, filtros)) {
        // @lid permitido — re-guarda la config del Agente IA para que quede preciso
      } else if (!esGrupo) {
        console.log(`[Agente] Bloqueado: chat ${chatId} no está en la lista combinada: [${filtros.join(', ')}]`);
        return null;
      } else {
        console.log(`[Agente] Bloqueado: chat ${chatId} no está en la lista combinada: [${filtros.join(', ')}]`);
        return null;
      }
    }
  }

  console.log(`[Agente] Filtro OK → procesando mensaje de ${chatId}`);

  // Respuestas rápidas tienen prioridad (sin costo de API)
  const textoLower = texto.toLowerCase().trim();
  for (const rr of agente.respuestasRapidas || []) {
    if (!rr.activa) continue;
    if ((rr.palabrasClave || []).some(p => p && textoLower.includes(p.toLowerCase()))) {
      console.log(`[Agente] Respuesta rápida → ${chatId}`);
      return rr.respuesta;
    }
  }

  const proveedor = agente.proveedor || 'anthropic';
  const apiKey = agente.apiKeys?.[proveedor] || agente.apiKey || '';
  if (!apiKey) {
    console.log(`[Agente] Sin API key para proveedor "${proveedor}" — configura la API key en Ajustes del Agente`);
    return null;
  }

  const agenteConKey = { ...agente, apiKey };
  const systemPrompt = await buildSystemPrompt(agente);
  if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
  const history = conversationHistory.get(chatId);
  history.push({ role: 'user', content: texto });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  try {
    let respuesta;
    if (proveedor === 'gemini') respuesta = await llamarGemini(agenteConKey, systemPrompt, history);
    else if (proveedor === 'groq') respuesta = await llamarGroq(agenteConKey, systemPrompt, history);
    else respuesta = await llamarAnthropic(agenteConKey, systemPrompt, history, imagenPath);
    if (!respuesta) { history.pop(); return null; }
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
