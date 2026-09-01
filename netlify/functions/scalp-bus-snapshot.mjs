// Enumera los eventos de Scalp CC guardados por scalp-ingest.mjs (Netlify Blobs
// store 'scalp', claves ev/<YYYY-MM-DD>/<sigId>__<evt>) y los FUSIONA con lo que
// ya hay en el repo git jesusreyna2016/scalp-cc-bus:
//   evt=signal   -> signals/<fecha>.jsonl
//   evt=outcome  -> outcomes/<fecha>.jsonl
//
// MERGE-ONLY: lee el .jsonl existente + los blobs que devuelva store.list(),
// dedup por sigId (gana el receivedAt mas nuevo) y escribe la union ordenada.
// Asi, como store.list() es de consistencia eventual y puede no devolver todas
// las claves, un rebuild solo puede AÑADIR filas, nunca borrar una ya guardada.
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

async function listAllKeys(store, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ prefix, cursor });
    for (const b of page?.blobs || []) keys.push(b.key);
    cursor = page?.cursor;
  } while (cursor);
  return keys;
}

function idOf(r) {
  return r?.sigId || r?.raw?.sigId || null;
}
function evtOf(r) {
  return r?.evt || r?.raw?.evt || 'signal';
}

export async function runSnapshot() {
  const token = process.env.SCALP_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta SCALP_BUS_TOKEN' };

  const store = getStore('scalp');
  const out = [];

  for (const day of daysToProcess()) {
    const keys = await listAllKeys(store, `ev/${day}/`);
    const fresh = [];
    for (const k of keys) {
      const r = await store.get(k, { type: 'json' });
      if (r) fresh.push(r);
    }

    for (const evt of ['signal', 'outcome']) {
      const path = `${evt === 'signal' ? 'signals' : 'outcomes'}/${day}.jsonl`;
      const existing = await busGet(path, { token });

      const merged = new Map();
      if (existing?.content) {
        for (const line of existing.content.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try {
            const r = JSON.parse(t);
            const id = idOf(r);
            if (id) merged.set(id, r);
          } catch { /* linea corrupta: se ignora */ }
        }
      }
      for (const r of fresh) {
        if (evtOf(r) !== evt) continue;
        const id = idOf(r);
        if (!id) continue;
        const prev = merged.get(id);
        if (!prev || String(r.receivedAt || '') >= String(prev.receivedAt || '')) merged.set(id, r);
      }

      if (merged.size === 0) continue;
      const rows = [...merged.values()].sort((a, b) =>
        String(a.receivedAt || '').localeCompare(String(b.receivedAt || ''))
      );
      const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      out.push(
        await busPut(path, body, `scalp-bus: ${evt}s ${day} (${rows.length})`, { token, known: existing })
      );
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
