/**
 * Financas AI — Cloudflare Worker
 * Proxy do 9Router: esconde a NINJA_KEY do navegador
 * Free tier: 100k req/dia, sem cartão, sem pré-pagamento
 *
 * Endpoints:
 *   POST /classify  — classifica uma transação manual
 *   POST /extract   — extrai transações de extrato (importador)
 *   GET  /health    — health check
 */

// ===== Config =====
const NINJA_API = 'https://protagrouter.squareweb.app';
const MODEL = 'protagnix';
const ALLOWED_ORIGIN = 'https://jbryan333.github.io';

// NINJA_KEY vem de Cloudflare Secret (não fica no código)
// Pra setar: wrangler secret put NINJA_KEY

// ===== Rate limit em memória (por IP) =====
const rateLimit = new Map();
const RATE_LIMIT = 100; // 100 req/dia por IP
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || entry.resetAt < now) {
    rateLimit.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

// ===== CORS =====
const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ===== Firebase Auth JWT verification (simples, sem admin SDK) =====
async function verifyFirebaseToken(token) {
  if (!token || !token.startsWith('Bearer ')) return null;
  const jwt = token.split('Bearer ')[1];

  try {
    // Decodifica payload (sem verificar assinatura por enquanto — beta)
    // Em produção, usar Google JWKS para verificar assinatura
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    // Verifica se não expirou
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ===== Parser JSON robusto =====
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

// ===== Main handler =====
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health' && request.method === 'GET') {
      return jsonRes({ status: 'ok', timestamp: Date.now() });
    }

    // Todas as outras rotas precisam de auth
    if (request.method !== 'POST') {
      return jsonRes({ error: 'Method not allowed' }, 405);
    }

    // Verificar auth
    const user = await verifyFirebaseToken(request.headers.get('Authorization'));
    if (!user) {
      return jsonRes({ error: 'Não autenticado' }, 401);
    }

    // Rate limit por IP
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = checkRateLimit(clientIP);
    if (!rl.allowed) {
      return jsonRes({ error: 'Limite diário atingido. Tente amanhã ou faça upgrade para o Pro.' }, 429);
    }

    const NINJA_KEY = env.NINJA_KEY;
    if (!NINJA_KEY) {
      return jsonRes({ error: 'Servidor mal configurado — NINJA_KEY ausente' }, 500);
    }

    try {
      const body = await request.json();

      // =====================================================
      // /classify — Classifica transação manual
      // =====================================================
      if (path === '/classify') {
        const { description } = body;
        if (!description) return jsonRes({ error: 'Descrição obrigatória' }, 400);

        const resp = await fetch(NINJA_API + '/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': '***' + NINJA_KEY,
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

        if (!resp.ok) return jsonRes({ error: '9Router indisponível' }, 502);

        const rawText = await resp.text();
        const content = extractContent(rawText);

        let result = null;
        const jsonMatch = content.match(/{[\s\S]*?}/);
        if (jsonMatch) {
          try { result = JSON.parse(jsonMatch[0]); } catch (e) {}
        }

        return jsonRes({
          result,
          rateLimit: { remaining: rl.remaining, limit: RATE_LIMIT }
        });
      }

      // =====================================================
      // /extract — Extrai transações de extrato
      // =====================================================
      if (path === '/extract') {
        const { text } = body;
        if (!text || text.length < 10) return jsonRes({ error: 'Texto do extrato obrigatório' }, 400);

        const chunkSize = 4000;
        const allTransactions = [];

        for (let i = 0; i < text.length; i += chunkSize) {
          const chunk = text.substring(i, i + chunkSize);
          try {
            const resp = await fetch(NINJA_API + '/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': '***' + NINJA_KEY,
              },
              body: JSON.stringify({
                model: MODEL,
                messages: [
                  {
                    role: 'system',
                    content: 'Você é um extrator de transações financeiras. Analise o texto (pode ser extrato bancário de qualquer banco brasileiro, em qualquer formato). Extraia TODAS as transações encontradas. Retorne APENAS um array JSON válido, sem markdown, sem explicação:\n[{"date":"DD/MM/YYYY","description":"descrição limpa da transação","value":0.00,"type":"entrada ou saida","category":"categoria"}]\n\nRegras:\n- date: data da transação no formato DD/MM/YYYY. Se não tiver ano, use 2026.\n- description: descrição limpa (sem CPF, CNPJ, números de conta, códigos). Máximo 200 chars.\n- value: valor numérico com ponto decimal (ex: 69.90, nao 69,90).\n- type: "entrada" se for recebimento/crédito, "saida" se for pagamento/débito.\n- category: uma destas: Alimentação, Transporte, Moradia, Saúde, Assinaturas, Lazer, Educação, Renda, Outros.\n- Ignore linhas de saldo, cabeçalho, rodapé, totais.\n- Se não encontrar nenhuma transação, retorne [].\n- Se o texto mencionar o nome do banco, inclua como campo opcional "bank".'
                  },
                  { role: 'user', content: chunk }
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
            // chunk failed, continue
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

        return jsonRes({
          transactions: deduped,
          rateLimit: { remaining: rl.remaining, limit: RATE_LIMIT }
        });
      }

      // Rota não encontrada
      return jsonRes({ error: 'Rota não encontrada: ' + path }, 404);

    } catch (e) {
      return jsonRes({ error: 'Erro interno: ' + e.message }, 500);
    }
  }
};