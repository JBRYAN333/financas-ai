/**
 * Financas AI — Cloud Functions
 * Proxy do 9Router com autenticação Firebase
 * A NINJA_KEY nunca é exposta ao cliente
 */

const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

// === CONFIG (servidor only — nunca exposto ao cliente) ===
const NINJA_API = 'https://protagrouter.squareweb.app';
const NINJA_KEY = 'clawsec_ninja_2026';
const MODEL = 'protagnix';

// === Rate limiting em memória (por UID) ===
// Em produção, usar Firestore. Pra beta, em memória basta.
const rateLimit = new Map(); // uid → { count, resetAt }
const RATE_LIMIT_FREE = 50;      // 50 req/dia
const RATE_LIMIT_PRO = 500;      // 500 req/dia
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

function checkRateLimit(uid, plan) {
  const limit = plan === 'pro' ? RATE_LIMIT_PRO : RATE_LIMIT_FREE;
  const now = Date.now();
  const entry = rateLimit.get(uid);

  if (!entry || entry.resetAt < now) {
    rateLimit.set(uid, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: limit - 1, limit };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, limit };
  }

  entry.count++;
  return { allowed: true, remaining: limit - entry.count, limit };
}

// === Verificar ID token do Firebase Auth ===
async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  const token = auth.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded;
  } catch (e) {
    logger.warn('Token inválido', { error: e.message });
    return null;
  }
}

// === Verificar plano do usuário no Firestore ===
async function getUserPlan(uid) {
  try {
    const doc = await admin.firestore().collection('users').doc(uid).get();
    if (doc.exists) {
      return doc.data().plan || 'free';
    }
    return 'free';
  } catch (e) {
    logger.warn('Erro ao verificar plano', { error: e.message });
    return 'free';
  }
}

// === Parser JSON robusto (copia do dashboard) ===
function safeParseJSONArray(text) {
  if (!text) return [];
  let clean = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { const d = JSON.parse(clean); return Array.isArray(d) ? d : []; } catch (e) {}
  const start = clean.indexOf('[');
  if (start === -1) return [];
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < clean.length; i++) {
    const c = clean[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (depth === 0 && i > start) {
      const jsonStr = clean.substring(start, i + 1);
      try { const p = JSON.parse(jsonStr); return Array.isArray(p) ? p : []; } catch (e) {
        const cleaned = jsonStr.replace(/,\s*\]/g, ']').replace(/'/g, '"');
        try { const p2 = JSON.parse(cleaned); return Array.isArray(p2) ? p2 : []; } catch (e2) {}
      }
      break;
    }
  }
  return [];
}

// === Extrair content de resposta do 9Router (handle GLM-5 bug) ===
function extractContent(rawText) {
  let content = '';
  try {
    const data = JSON.parse(rawText);
    content = data.choices?.[0]?.message?.content || '';
  } catch (e) {
    const contentMatch = rawText.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (contentMatch) {
      content = contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return content;
}

// === CORS headers ===
function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// =====================================================
// /api/classify — Classifica uma transação manual
// =====================================================
exports.classify = onRequest(
  { cors: true, maxInstances: 10 },
  async (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') { res.status(204).send(); return; }
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    // 1. Verificar auth
    const user = await verifyToken(req);
    if (!user) {
      res.status(401).json({ error: 'Não autenticado' });
      return;
    }

    // 2. Verificar plano e rate limit
    const plan = await getUserPlan(user.uid);
    const rl = checkRateLimit(user.uid, plan);
    if (!rl.allowed) {
      res.status(429).json({ error: `Limite diário atingido (${rl.limit} requisições/dia). Faça upgrade para o Pro.` });
      return;
    }

    // 3. Chamar 9Router
    try {
      const { description } = req.body;
      if (!description) {
        res.status(400).json({ error: 'Descrição obrigatória' });
        return;
      }

      const resp = await fetch(NINJA_API + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + NINJA_KEY
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: 'Classifique a transacao financeira. Retorne APENAS JSON valido com: descricao, valor (numero sem R$), tipo (entrada/saida), categoria, confianca. Categorias: Alimentacao, Transporte, Moradia, Saude, Assinaturas, Lazer, Educacao, Renda, Outros.'
            },
            { role: 'user', content: description }
          ]
        })
      });

      if (!resp.ok) {
        res.status(502).json({ error: '9Router indisponível' });
        return;
      }

      const rawText = await resp.text();
      const content = extractContent(rawText);

      let result = null;
      const jsonMatch = content.match(/{[\s\S]*?}/);
      if (jsonMatch) {
        try { result = JSON.parse(jsonMatch[0]); } catch (e) {}
      }

      res.json({
        result: result || null,
        rateLimit: { remaining: rl.remaining, limit: rl.limit, plan }
      });

    } catch (e) {
      logger.error('Erro classify', { error: e.message });
      res.status(500).json({ error: 'Erro interno' });
    }
  }
);

// =====================================================
// /api/extract — Extrai transações de extrato (importador)
// =====================================================
exports.extract = onRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 120 },
  async (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') { res.status(204).send(); return; }
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    // 1. Verificar auth
    const user = await verifyToken(req);
    if (!user) {
      res.status(401).json({ error: 'Não autenticado' });
      return;
    }

    // 2. Verificar plano e rate limit
    const plan = await getUserPlan(user.uid);
    const rl = checkRateLimit(user.uid, plan);
    if (!rl.allowed) {
      res.status(429).json({ error: `Limite diário atingido (${rl.limit} requisições/dia). Faça upgrade para o Pro.` });
      return;
    }

    // 3. Chamar 9Router com o texto do extrato
    try {
      const { text } = req.body;
      if (!text || text.length < 10) {
        res.status(400).json({ error: 'Texto do extrato obrigatório' });
        return;
      }

      // Processa em chunks de 4000 chars
      const allTransactions = [];
      const chunkSize = 4000;
      const chunks = [];
      for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.substring(i, i + chunkSize));
      }

      for (let i = 0; i < chunks.length; i++) {
        try {
          const resp = await fetch(NINJA_API + '/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + NINJA_KEY
            },
            body: JSON.stringify({
              model: MODEL,
              messages: [
                {
                  role: 'system',
                  content: 'Você é um extrator de transações financeiras. Analise o texto (pode ser extrato bancário de qualquer banco brasileiro, em qualquer formato). Extraia TODAS as transações encontradas. Retorne APENAS um array JSON válido, sem markdown, sem explicação:\n[{"date":"DD/MM/YYYY","description":"descrição limpa da transação","value":0.00,"type":"entrada ou saida","category":"categoria"}]\n\nRegras:\n- date: data da transação no formato DD/MM/YYYY. Se não tiver ano, use 2026.\n- description: descrição limpa (sem CPF, CNPJ, números de conta, códigos). Máximo 200 chars.\n- value: valor numérico com ponto decimal (ex: 69.90, nao 69,90).\n- type: "entrada" se for recebimento/crédito, "saida" se for pagamento/débito.\n- category: uma destas: Alimentação, Transporte, Moradia, Saúde, Assinaturas, Lazer, Educação, Renda, Outros.\n- Ignore linhas de saldo, cabeçalho, rodapé, totais.\n- Se não encontrar nenhuma transação, retorne [].\n- Se o texto mencionar o nome do banco, inclua como campo opcional "bank".'
                },
                { role: 'user', content: chunks[i] }
              ]
            })
          });

          if (!resp.ok) continue;

          const rawText = await resp.text();
          const content = extractContent(rawText);
          if (!content) continue;

          const parsed = safeParseJSONArray(content);
          if (parsed && parsed.length > 0) allTransactions.push(...parsed);

        } catch (e) {
          logger.warn('Chunk failed', { chunk: i, error: e.message });
        }
      }

      // Dedup
      const seen = new Set();
      const deduped = allTransactions.filter(t => {
        const key = `${t.date}|${t.value}|${(t.description || '').substring(0, 30).toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      res.json({
        transactions: deduped,
        rateLimit: { remaining: rl.remaining, limit: rl.limit, plan }
      });

    } catch (e) {
      logger.error('Erro extract', { error: e.message });
      res.status(500).json({ error: 'Erro interno' });
    }
  }
);

// =====================================================
// /api/health — Health check simples
// =====================================================
exports.health = onRequest(
  { cors: true, maxInstances: 1 },
  async (req, res) => {
    setCors(res);
    res.json({ status: 'ok', timestamp: Date.now() });
  }
);