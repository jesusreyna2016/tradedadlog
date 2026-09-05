// Feed de lectura del store 'plan-coach' (ver plan-coach-ingest.mjs) para el
// Plan Coach: eventos recientes (evt=signal / evt=outcome / evt=or_signal) y
// conteos simples por tipo. Sin analisis pesado aqui todavia -- eso sigue
// corriendo como plan-agent/analysis/effectiveness.py sobre exports del
// journal; este endpoint es el primer paso para que ese motor eventualmente
// lea del feed en vivo en lugar de un export manual.
import { getStore } from '@netlify/blobs';

export default async () => {
  const store = getStore('plan-coach');
  const days = [0, 1, 2].map((n) => {
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
    counts,
    last,
    recentEvents: events.slice(0, 100),
  }), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
};
