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
const ALLOWED_ORIGINS = [
  'https://jbryan333.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:5500'
];

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
  'Access-Control-Allow-Origin': '*',
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
      // /extract — Extrai transações de extrato (agora sem chunking server-side)
      // O chunking e paralelização é feito pelo dashboard
      // =====================================================
      if (path === '/extract') {
        const { text } = body;
        if (!text || text.length < 10) return jsonRes({ error: 'Texto do extrato obrigatório' }, 400);

        // Chunking agora é feito pelo dashboard (client-side)
        // O worker recebe cada chunk individualmente
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
                  content: `Você é um extrator especializado de transações financeiras de extratos bancários brasileiros.

Analise o texto abaixo. Ele foi extraído de um extrato bancário via OCR — pode conter erros de leitura, palavras grudadas, números confundidos com letras.

Retorne APENAS um array JSON válido, sem markdown, sem texto adicional:
[{"date":"DD/MM/YYYY","description":"descrição","value":0.00,"type":"entrada","category":"Renda","bank":""}]

REGRAS CRÍTICAS (leia TUDO antes de extrair):

1. DATA (DD/MM/YYYY):
   - A data aparece uma vez e se aplica a TODAS as transações abaixo dela até a próxima data.
   - Se NÃO encontrar data nenhuma no texto, use null (deixe o campo date vazio). NUNCA invente 01/01/2026.
   - Se tiver ano parcial (ex: "08/07"), complete com 2026.
   - NUNCA use 01/01/2026 como fallback. Prefira data vazia.

2. DESCRIÇÃO:
   - Limpe descrições. SEMPRE remova trechos como "R$ 123,45", "R$123,45" — isso é SALDO, não parte da descrição.
   - Remova CPF, CNPJ, números de conta, "..." no final.
   - Máximo 200 chars.
   - Ex: "Transferencia PIX Recebimento PIX - FABIOLA DE SOUZA MOURA R$ 378,54" → desCRIÇÃO deve ser "Recebimento PIX - FABIOLA DE SOUZA MOURA" (o R$ 378,54 é saldo, remova)
   - Ex: "R$ 752,34 Transferencia PIX Recebimento PIX - Alexandro..." → descrição "Recebimento PIX - Alexandro" (R$ 752,34 é saldo)

3. VALOR:
   - Número POSITIVO com ponto decimal (ex: 9.00, não 9,00).
   - Se o texto diz "- R$ 50,00", o valor é 50.00 e o type é "saida".
   - Se o texto diz "R$ -70,00" ou "-70.00", o valor é 70.00 (sempre positivo) e type "saida".
   - NUNCA retorne valor negativo.

4. TIPO: "entrada" ou "saida".
   - Sinal + ou "recebida"/"Recebimento" → entrada
   - Sinal - ou "enviada"/"Envio"/"Débito"/"Pagamento"/"Tarifa" → saida

5. CATEGORIA: Alimentação, Transporte, Moradia, Saúde, Assinaturas, Lazer, Educação, Renda, Outros.
   - "iFood"/"Padaria"/"Pensão" → Alimentação
   - "Uber" → Transporte
   - "Farmácia"/"Drogaria" → Saúde
   - "Netflix"/"PlayFibra"/"Play Store" → Assinaturas
   - "INSS"/"salário"/"Benefício" → Renda
   - "PIX" sem ser compra → veja se é recebido (Renda) ou enviado (Outros)

6. IGNORE COMPLETAMENTE:
   - Linhas de saldo ("Saldo do dia R$", "R$ 123,45" solto)
   - Cabeçalhos, rodapés, "Extrato gerado no dia"
   - CNPJ, CPF, números de conta, "SAC", "Ouvidoria", endereços
   - Linhas que só contêm um valor em reais (é saldo, não transação)

7. IMPORTANTE: se no texto aparecer "R$" seguido de um valor sem descrição de transação, ignore — é saldo.
   Se aparecer 
                  },
                  { role: 'user', content: text }
                ]
              })
            })
          });

          if (!resp.ok) return jsonRes({ error: '9Router indisponível' }, 502);

          const rawText = await resp.text();
          const content = extractContent(rawText);
          if (!content) return jsonRes({ transactions: [] });

          const parsed = safeParseJSONArray(content);
          return jsonRes({
            transactions: parsed || [],
            rateLimit: { remaining: rl.remaining, limit: RATE_LIMIT }
          });
        } catch (e) {
          return jsonRes({ error: 'Erro ao processar: ' + e.message }, 500);
        }
      }

      // Rota não encontrada
      return jsonRes({ error: 'Rota não encontrada: ' + path }, 404);

    } catch (e) {
      return jsonRes({ error: 'Erro interno: ' + e.message }, 500);
    }
  }
};