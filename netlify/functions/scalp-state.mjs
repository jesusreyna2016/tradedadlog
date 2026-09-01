// Feed para el dashboard del agente Scalp CC (public/scalp.html).
// report.json / state.json: primero de Netlify Blobs (los espeja scalp-bus-cron
// cada 10 min, sin el retraso de cache de raw.githubusercontent); si no hay
// espejo todavia, cae a raw. Señales/outcomes recientes: siempre de raw.
import { getStore } from '@netlify/blobs';

const RAW = 'https://raw.githubusercontent.com/jesusreyna2016/scalp-cc-bus/main';

async function rawJson(path) {
  try {
    const r = await fetch(`${RAW}/${path}`, { headers: { 'user-agent': 'tdl-scalp-dash' }, cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function rawJsonl(path, limit = 40) {
  try {
    const r = await fetch(`${RAW}/${path}`, { headers: { 'user-agent': 'tdl-scalp-dash' }, cache: 'no-store' });
    if (!r.ok) return [];
    const t = await r.text();
    return t.split('\n').map(s => s.trim()).filter(Boolean)
      .map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean)
      .slice(-limit);
  } catch { return []; }
}

export default async () => {
  const store = getStore('scalp');
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

  const mirror = async (name) => {
    try {
      const s = await store.get(`mirror:${name}`);
      if (s) return JSON.parse(s);
    } catch { /* sin espejo */ }
    return null;
  };

  const [report, state, sigT, outT, sigY, outY] = await Promise.all([
    mirror('report').then(m => m || rawJson('report.json')),
    mirror('state').then(m => m || rawJson('state.json')),
    rawJsonl(`signals/${today}.jsonl`), rawJsonl(`outcomes/${today}.jsonl`),
    rawJsonl(`signals/${y}.jsonl`), rawJsonl(`outcomes/${y}.jsonl`),
  ]);

  return new Response(JSON.stringify({
    generatedAt: new Date().toISOString(),
    report: report || null,
    state: state || null,
    recentSignals: [...sigY, ...sigT].slice(-30).reverse(),
    recentOutcomes: [...outY, ...outT].slice(-30).reverse(),
  }), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
};
