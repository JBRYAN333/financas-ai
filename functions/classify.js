/*
 * Integração 9Router — classificação de transações
 * Fluxo: texto → 9Router → JSON estruturado
 */

const NINJA_URL = 'https://protagrouter.squareweb.app/api/classify';
const NINJA_KEY = 'clawsec_ninja_2026';

async function classifyTransaction(text, plan = 'free') {
  const model = plan === 'pro' ? 'opencode' : 'protagnix';
  
  const resp = await fetch(NINJA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${NINJA_KEY}`
    },
    body: JSON.stringify({ text, model })
  });

  if (!resp.ok) throw new Error('Falha na classificação');
  
  const data = await resp.json();
  return {
    description: data.descricao || text,
    value: data.valor || extractValue(text),
    type: data.tipo || 'saida',
    category: data.categoria || 'outros',
    confidence: data.confianca || 0
  };
}

function extractValue(text) {
  const match = text.match(/(\d+[.,]\d+)/);
  return match ? parseFloat(match[1].replace(',', '.')) : 0;
}

// Fallback simples (sem IA)
function classifyLocal(text) {
  const t = text.toLowerCase();
  let category = 'outros';
  if (t.includes('mercad') || t.includes('feira') || t.includes('compr')) category = 'alimentacao';
  else if (t.includes('uber') || t.includes('transp') || t.includes('gas')) category = 'transporte';
  else if (t.includes('alug') || t.includes('cond')) category = 'moradia';
  else if (t.includes('salario') || t.includes('freela') || t.includes('receb')) category = 'renda';
  
  return { description: text, value: extractValue(text), type: 'saida', category };
}

module.exports = { classifyTransaction, classifyLocal };
