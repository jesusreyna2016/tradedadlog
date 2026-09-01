// Espeja los eventos de Scalp CC (Netlify Blobs store 'scalp', claves
// ev/<YYYY-MM-DD>/<sigId>__<evt> que escribe scalp-ingest.mjs) al repo git
// jesusreyna2016/scalp-cc-bus:
//   evt=signal   -> signals/<fecha>.jsonl
//   evt=outcome  -> outcomes/<fecha>.jsonl
//
// Diseño a prueba de la consistencia eventual de store.list():
//  1. descubre sigIds del dia por store.list() (best-effort) + por los .jsonl ya
//     commiteados en el repo.
//  2. por cada sigId conocido hace store.get() DIRECTO por clave exacta de
//     __signal y __outcome (store.get es fuertemente consistente), asi se rellena
//     la mitad que list() todavia no devuelve.
//  3. MERGE-ONLY: fusiona con lo que ya hay en el .jsonl (dedup por sigId, gana el
//     receivedAt mas nuevo). Un rebuild solo puede añadir filas, nunca borrar.
// busPut omite el commit si el contenido no cambio. Procesa hoy y ayer.
//
// Invocable por HTTP para pruebas (GET); el schedule vive en scalp-bus-cron.mjs.
import { getStore } from '@netlify/blobs';
import { busGet, busPut } from './_scalp-bus.mjs';

function daysToProcess() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const y = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  return [y, today];
}

const safeKey = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const idOf = (r) => r?.sigId || r?.raw?.sigId || null;

async function listSigIds(store, day) {
  const ids = new Set();
  let cursor;
  do {
    const page = await store.list({ prefix: `ev/${day}/`, cursor });
    for (const b of page?.blobs || []) {
      const m = b.key.match(/\/([^/]+)__(signal|outcome)$/);
      if (m) ids.add(m[1]);
    }
    cursor = page?.cursor;
  } while (cursor);
  return ids;
}

function collectIds(content, into) {
  if (!content) return;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const id = idOf(JSON.parse(t));
      if (id) into.add(id);
    } catch { /* linea corrupta */ }
  }
}

function mergeExisting(content, map) {
  if (!content) return;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      const id = idOf(r);
      if (id) map.set(id, r);
    } catch { /* linea corrupta */ }
  }
}

function serialize(map) {
  const rows = [...map.values()].sort((a, b) =>
    String(a.receivedAt || '').localeCompare(String(b.receivedAt || ''))
  );
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export async function runSnapshot() {
  const token = process.env.SCALP_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta SCALP_BUS_TOKEN' };

  const store = getStore('scalp');
  const out = [];

  for (const day of daysToProcess()) {
    const known = await listSigIds(store, day);

    const existingSig = await busGet(`signals/${day}.jsonl`, { token });
    const existingOut = await busGet(`outcomes/${day}.jsonl`, { token });
    collectIds(existingSig?.content, known);
    collectIds(existingOut?.content, known);
    if (known.size === 0) continue;

    const sigMap = new Map();
    const outMap = new Map();
    mergeExisting(existingSig?.content, sigMap);
    mergeExisting(existingOut?.content, outMap);

    for (const sig of known) {
      const base = `ev/${day}/${safeKey(sig)}`;
      const s = await store.get(`${base}__signal`, { type: 'json' });
      if (s) {
        const id = idOf(s) || sig;
        const prev = sigMap.get(id);
        if (!prev || String(s.receivedAt || '') >= String(prev.receivedAt || '')) sigMap.set(id, s);
      }
      const o = await store.get(`${base}__outcome`, { type: 'json' });
      if (o) {
        const id = idOf(o) || sig;
        const prev = outMap.get(id);
        if (!prev || String(o.receivedAt || '') >= String(prev.receivedAt || '')) outMap.set(id, o);
      }
    }

    if (sigMap.size) {
      out.push(await busPut(`signals/${day}.jsonl`, serialize(sigMap),
        `scalp-bus: signals ${day} (${sigMap.size})`, { token, known: existingSig }));
    }
    if (outMap.size) {
      out.push(await busPut(`outcomes/${day}.jsonl`, serialize(outMap),
        `scalp-bus: outcomes ${day} (${outMap.size})`, { token, known: existingOut }));
    }
  }

  return { ok: true, wrote: out };
}

// invocable por HTTP para pruebas: GET /api/scalp-bus-snapshot
export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: r.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json' },
  });
};
