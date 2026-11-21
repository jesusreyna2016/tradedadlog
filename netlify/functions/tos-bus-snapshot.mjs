// Trader OS · snapshot cron. Espeja el store de Netlify Blobs 'tos' (lo que
// escribe tos-ingest.mjs) al repo git jesusreyna2016/trader-os-bus:
//
//   state:<src>:<SYM>   -> live/feeds.json   (mapa crudo del ultimo estado por fuente+simbolo)
//   events:<YYYY-MM-DD> -> events/<fecha>.jsonl  (log append-only de eventos semanticos Tier B)
//
// El snapshot es un ESPEJO FIEL, no compone: la lente Contexto es quien leera
// live/feeds.json + events/ y escribira el live/market.json del esquema. Aqui
// solo garantizamos que el dato llega al bus, merge-only (nunca encoge) y sin
// commit si no cambio (lo maneja ghPut). Procesa hoy y ayer para los eventos.
//
// Invocable por HTTP para pruebas (GET); el schedule vive en tos-bus-cron.mjs.
import { getStore } from '@netlify/blobs';
import { ghGet, ghPut } from './_gh-bus.mjs';

const OWNER = 'jesusreyna2016';
const REPO = 'trader-os-bus';
const BRANCH = 'main';
const EVENTS_MAX = 5000;   // tope por archivo de dia

const evKey = (e) => `${e.t}|${e.src}|${e.sym}|${e.event || ''}`;

function daysToProcess() {
  const now = Date.now();
  return [new Date(now - 864e5).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)];
}

function parseJsonl(content) {
  const map = new Map();
  if (!content) return map;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const e = JSON.parse(t); map.set(evKey(e), e); } catch { /* linea corrupta */ }
  }
  return map;
}

function serializeEvents(map) {
  const rows = [...map.values()].sort((a, b) => (a.t || 0) - (b.t || 0));
  return rows.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

export async function runSnapshot() {
  const token = process.env.TOS_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta TOS_BUS_TOKEN' };

  const store = getStore('tos');
  const out = [];
  const deadline = Date.now() + 18000;

  // ---- 1. Estado crudo -> live/feeds.json (merge-only: nunca se pierde una clave) ----
  const feedsCur = await ghGet(OWNER, REPO, BRANCH, 'live/feeds.json', { token });
  let feeds = {};
  try { feeds = feedsCur?.content ? JSON.parse(feedsCur.content) : {}; } catch { feeds = {}; }

  const stateKeys = new Set(Object.keys(feeds).map((k) => `state:${k}`));
  let cursor;
  do {
    const page = await store.list({ prefix: 'state:', cursor });
    for (const b of page?.blobs || []) stateKeys.add(b.key);
    cursor = page?.cursor;
  } while (cursor && Date.now() < deadline);

  for (const key of stateKeys) {
    const rec = await store.get(key, { type: 'json' });   // get es fuertemente consistente
    if (rec) feeds[key.slice('state:'.length)] = rec;     // si get devuelve null, se conserva el valor previo
  }
  feeds._updatedAt = new Date().toISOString();
  if (Object.keys(feeds).length > 1) {
    out.push(await ghPut(OWNER, REPO, BRANCH, 'live/feeds.json',
      JSON.stringify(feeds, null, 2) + '\n', `tos: feeds ${feeds._updatedAt}`, { token, known: feedsCur }));
  }

  // ---- 2. Eventos semanticos -> events/<dia>.jsonl (merge-only + guard anti-borrado) ----
  for (const day of daysToProcess()) {
    const blob = await store.get(`events:${day}`, { type: 'json' });
    if (!Array.isArray(blob) || !blob.length) continue;

    const cur = await ghGet(OWNER, REPO, BRANCH, `events/${day}.jsonl`, { token });
    const map = parseJsonl(cur?.content);
    const before = map.size;
    for (const e of blob) map.set(evKey(e), e);
    if (map.size > EVENTS_MAX) {
      const rows = [...map.values()].sort((a, b) => (a.t || 0) - (b.t || 0)).slice(-EVENTS_MAX);
      map.clear();
      for (const e of rows) map.set(evKey(e), e);
    }

    // Guard: si el archivo ya existe (sha) y no ganamos filas o el contents API
    // devolvio vacio/parcial, no pisamos (mismo fallo que el heal del scalp-bus).
    const hadSha = !!(cur && cur.sha);
    const contentEmpty = !cur?.content || !cur.content.trim();
    if (hadSha && (map.size <= before || contentEmpty)) {
      out.push({ skipped: true, path: `events/${day}.jsonl`, guard: 'noshrink', before, wouldWrite: map.size });
      continue;
    }
    out.push(await ghPut(OWNER, REPO, BRANCH, `events/${day}.jsonl`, serializeEvents(map),
      `tos: events ${day} (${map.size})`, { token, known: cur }));
  }

  // marcador de frescura (lo lee el watchdog unificado mas adelante)
  try { await store.setJSON('meta:lastSnapshot', { at: new Date().toISOString(), wrote: out.filter((w) => !w.skipped).length }); } catch { /* best effort */ }

  return { ok: true, wrote: out };
}

// invocable por HTTP para pruebas: GET /api/tos-bus-snapshot
export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: r.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json' }
  });
};
