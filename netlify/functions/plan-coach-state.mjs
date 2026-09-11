// Feed de lectura del store 'plan-coach' (ver plan-coach-ingest.mjs) para el
// Plan Coach: eventos recientes (evt=signal / outcome / or_signal / ib_signal /
// or_outcome / ib_outcome) y conteos por tipo. Sin analisis pesado aqui -- eso
// corre en plan-agent/analysis/effectiveness.py, que llama a este mismo endpoint
// con ?days=30&limit=5000 (o lo que necesite) para un rango mas amplio que el
// default liviano del dashboard.
//
// Rendimiento: las claves son  ev/<YYYY-MM-DD>/<sigId>__<evt>  (ver ingest), asi
// que el TIPO de evento sale del nombre de la clave. Aprovechamos eso:
//   - counts se calcula SOLO de los nombres de clave (cero store.get).
//   - recentEvents solo baja hasta `limit` blobs, de los dias mas nuevos primero,
//     y esos gets van en PARALELO con concurrencia acotada.
// Antes se hacia un store.get SECUENCIAL por cada blob del rango entero (patron
// N+1) ignorando `limit` -> ~30s y 502 con queries pesadas (days=2&limit=5000).
import { getStore } from '@netlify/blobs';

const GET_CONCURRENCY = 32;

// evt = ultimo segmento tras '__' del nombre de clave (sigId nunca contiene '__'
// porque el ingest lo pasa por safeKey, que solo deja [A-Za-z0-9._-]).
const evtFromKey = (key) => {
  const i = key.lastIndexOf('__');
  return i >= 0 ? key.slice(i + 2) : 'unknown';
};

// Baja `keys` en lotes de tamano `conc` (no todos a la vez, para no reventar el
// numero de conexiones abiertas de la funcion).
async function getMany(store, keys, conc) {
  const out = [];
  for (let i = 0; i < keys.length; i += conc) {
    const batch = keys.slice(i, i + conc);
    const recs = await Promise.all(
      batch.map((k) => store.get(k, { type: 'json' }).catch(() => null))
    );
    for (const r of recs) if (r) out.push(r);
  }
  return out;
}

export default async (req) => {
  const url = new URL(req.url);
  const daysBack = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '3', 10) || 3));
  const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));

  const store = getStore('plan-coach');
  const days = Array.from({ length: daysBack }, (_, n) => {
    const d = new Date(Date.now() - n * 864e5);
    return d.toISOString().slice(0, 10);
  }); // ya vienen del mas nuevo al mas viejo

  // 1) Listar todas las claves del rango (paginando; antes solo se leia la 1a
  //    pagina de <=1000 y se truncaba en silencio). Barato: sin store.get.
  const keysByDay = []; // [{ day, keys: [...] }] en orden nuevo->viejo
  const counts = {};
  for (const day of days) {
    const keys = [];
    let cursor;
    do {
      let page;
      try {
        page = await store.list({ prefix: `ev/${day}/`, cursor });
      } catch {
        break;
      }
      for (const { key } of page.blobs || []) {
        keys.push(key);
        const evt = evtFromKey(key);
        counts[evt] = (counts[evt] || 0) + 1;
      }
      cursor = page.cursor;
    } while (cursor);
    keysByDay.push({ day, keys });
  }

  // 2) recentEvents: recolectar claves de los dias mas nuevos hasta cubrir el
  //    limit (incluimos el dia entero que cruza el umbral para no cortar antes de
  //    ordenar por receivedAt), luego bajar SOLO esas en paralelo.
  const wanted = [];
  for (const { keys } of keysByDay) {
    for (const k of keys) wanted.push(k);
    if (wanted.length >= limit) break;
  }
  const fetched = await getMany(store, wanted, GET_CONCURRENCY);
  fetched.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  const recentEvents = fetched.slice(0, limit);

  let last = null;
  try { last = await store.get('last', { type: 'json' }); } catch { /* aun sin eventos */ }

  return new Response(JSON.stringify({
    generatedAt: new Date().toISOString(),
    daysBack,
    counts,
    last,
    recentEvents,
  }), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
};
