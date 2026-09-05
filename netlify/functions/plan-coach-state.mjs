// Feed de lectura del store 'plan-coach' (ver plan-coach-ingest.mjs) para el
// Plan Coach: eventos recientes (evt=signal / evt=outcome / evt=or_signal) y
// conteos simples por tipo. Sin analisis pesado aqui -- eso corre en
// plan-agent/analysis/effectiveness.py, que llama a este mismo endpoint con
// ?days=30&limit=5000 (o lo que necesite) para jalar un rango mas amplio que
// el default liviano que usa el dashboard.
import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const daysBack = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '3', 10) || 3));
  const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));

  const store = getStore('plan-coach');
  const days = Array.from({ length: daysBack }, (_, n) => {
    const d = new Date(Date.now() - n * 864e5);
    return d.toISOString().slice(0, 10);
  });

  const events = [];
  for (const day of days) {
    let list;
    try {
      list = await store.list({ prefix: `ev/${day}/` });
    } catch {
      continue;
    }
    for (const { key } of list.blobs || []) {
      try {
        const rec = await store.get(key, { type: 'json' });
        if (rec) events.push(rec);
      } catch { /* clave corrupta o borrada entre list y get, se ignora */ }
    }
  }

  events.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));

  const counts = {};
  for (const e of events) counts[e.evt] = (counts[e.evt] || 0) + 1;

  let last = null;
  try { last = await store.get('last', { type: 'json' }); } catch { /* aun sin eventos */ }

  return new Response(JSON.stringify({
    generatedAt: new Date().toISOString(),
    daysBack,
    counts,
    last,
    recentEvents: events.slice(0, limit),
  }), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
};
