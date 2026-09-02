// Espeja los eventos de Scalp CC (Netlify Blobs store 'scalp', claves
// ev/<YYYY-MM-DD>/<sigId>__<evt> que escribe scalp-ingest.mjs) al repo git
// jesusreyna2016/scalp-cc-bus: signals/<fecha>.jsonl y outcomes/<fecha>.jsonl.
//
// Robusto ante:
//  - consistencia eventual de store.list(): descubre sigIds por list + por los
//    .jsonl ya commiteados; luego hace store.get() DIRECTO por clave exacta.
//  - señal y outcome en dias UTC distintos (sesion Asia cruza medianoche): la
//    sonda por clave prueba TODOS los dias de la ventana, no solo el del outcome.
//  - MERGE-ONLY: un rebuild solo puede añadir filas, nunca borrar una guardada.
// Cada registro se escribe en el .jsonl del dia de SU receivedAt.
//
// Invocable por HTTP para pruebas (GET); el schedule vive en scalp-bus-cron.mjs.
import { getStore } from '@netlify/blobs';
import { busGet, busPut } from './_scalp-bus.mjs';

const WINDOW_DAYS = 4; // hoy + 3 atras: sonda de claves y ficheros

function windowDays() {
  const now = Date.now();
  return Array.from({ length: WINDOW_DAYS }, (_, k) =>
    new Date(now - k * 864e5).toISOString().slice(0, 10)
  );
}

const safeKey = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const idOf = (r) => r?.sigId || r?.raw?.sigId || null;
const evtOf = (r) => r?.evt || r?.raw?.evt || 'signal';
const dayOf = (r) => String(r?.receivedAt || '').slice(0, 10) || null;

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

function parseJsonl(content, into) {
  if (!content) return;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { into.push(JSON.parse(t)); } catch { /* linea corrupta */ }
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
  const days = windowDays();

  // 1. descubrir sigIds y cargar lo ya commiteado
  const known = new Set();
  const existing = {}; // "signals/<day>.jsonl" -> { content, sha }
  const existingRows = []; // todas las filas ya commiteadas en la ventana
  for (const day of days) {
    for (const s of await listSigIds(store, day)) known.add(s);
    for (const kind of ['signals', 'outcomes']) {
      const path = `${kind}/${day}.jsonl`;
      const cur = await busGet(path, { token });
      existing[path] = cur;
      const rows = [];
      parseJsonl(cur?.content, rows);
      for (const r of rows) { const id = idOf(r); if (id) known.add(id); }
      existingRows.push(...rows);
    }
  }
  if (known.size === 0) return { ok: true, wrote: [] };

  // 2. por cada sigId, sonda directa de __signal y __outcome en toda la ventana
  const fresh = [];
  for (const sig of known) {
    const sk = safeKey(sig);
    for (const evt of ['signal', 'outcome']) {
      let rec = null;
      for (const day of days) {
        const r = await store.get(`ev/${day}/${sk}__${evt}`, { type: 'json' });
        if (r && (!rec || String(r.receivedAt || '') > String(rec.receivedAt || ''))) rec = r;
      }
      if (rec) fresh.push(rec);
    }
  }

  // 3. fusion merge-only, agrupando por (kind, dia-de-receivedAt)
  const files = {}; // path -> Map(sigId -> record)
  const put = (r) => {
    const kind = evtOf(r) === 'outcome' ? 'outcomes' : 'signals';
    const day = dayOf(r);
    if (!day) return;
    const path = `${kind}/${day}.jsonl`;
    (files[path] ||= new Map());
    const id = idOf(r);
    if (!id) return;
    const prev = files[path].get(id);
    if (!prev || String(r.receivedAt || '') >= String(prev.receivedAt || '')) files[path].set(id, r);
  };
  for (const r of existingRows) put(r);
  for (const r of fresh) put(r);

  const out = [];
  for (const [path, map] of Object.entries(files)) {
    if (!map.size) continue;
    out.push(await busPut(path, serialize(map), `scalp-bus: ${path} (${map.size})`,
      { token, known: existing[path] }));
  }

  // espejo report/state a Blobs para el dashboard (sin lag de raw)
  const mirrored = [];
  for (const name of ['report', 'state']) {
    try {
      const cur = await busGet(`${name}.json`, { token });
      if (cur?.content) {
        await store.set(`mirror:${name}`, cur.content, { metadata: { at: new Date().toISOString() } });
        mirrored.push(name);
      }
    } catch { /* aun no existe */ }
  }

  return { ok: true, wrote: out, mirrored };
}

export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: r.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json' },
  });
};
