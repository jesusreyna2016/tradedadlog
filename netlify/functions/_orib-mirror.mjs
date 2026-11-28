// Copia las señales OR / IB del Plan Agent (store 'plan-coach', eventos or_signal,
// or_outcome, ib_signal, ib_outcome) al repo scalp-cc-bus en plan/<YYYY-MM-DD>.jsonl,
// para que el agente del Scalp CC las mida. Antes solo llegaban al repo las RETEST /
// INV y estas se quedaban en Blobs sin analizar.
// Hoy y ayer en cada corrida; además rellena días viejos (hasta BACK_DAYS) de
// pocos en pocos, y recuerda en 'meta:orib-done' los días ya copiados.
// MERGE-ONLY como el resto del snapshot: solo añade filas, nunca borra.
import { getStore } from '@netlify/blobs';
import { busGet, busPut } from './_scalp-bus.mjs';

const EVTS = new Set(['or_signal', 'or_outcome', 'ib_signal', 'ib_outcome']);
const BACK_DAYS = 35;
const BACKFILL_PER_RUN = 4;

const uidOf = (r) => {
  if (r.uid) return r.uid;
  const sym = String(r.sym || '').toUpperCase();
  const sig = String(r.sigId || '');
  return sig.toUpperCase().startsWith(sym) ? sig : `${sym}-${r.tf}-${sig}`;
};
const rowKey = (r) => `${uidOf(r)}__${r.evt}`;

async function mirrorDay(store, day, token, deadline) {
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ prefix: `ev/${day}/`, cursor });
    for (const b of page?.blobs || []) {
      const evt = b.key.slice(b.key.lastIndexOf('__') + 2);
      if (EVTS.has(evt)) keys.push(b.key);
    }
    cursor = page?.cursor;
  } while (cursor);
  const path = `plan/${day}.jsonl`;
  const cur = await busGet(path, { token });
  const map = new Map();
  for (const line of String(cur?.content || '').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); map.set(rowKey(r), r); } catch { /* linea rota */ }
  }
  const before = map.size;
  let next = 0, complete = true;
  const worker = async () => {
    while (next < keys.length) {
      if (Date.now() > deadline) { complete = false; return; }
      const r = await store.get(keys[next++], { type: 'json' }).catch(() => null);
      if (r && !map.has(rowKey(r))) map.set(rowKey(r), r);
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  if (!keys.length) return { day, empty: true, complete };
  if (map.size === before) return { day, skipped: true, rows: map.size, complete };
  if (cur?.sha && (!cur.content || !cur.content.trim())) return { day, skipped: true, guard: 'noshrink', complete: false };
  const rows = [...map.values()].sort((a, b) => String(a.receivedAt || '').localeCompare(String(b.receivedAt || '')));
  const res = await busPut(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    `scalp-bus: plan ${day} (${rows.length} OR/IB)`, { token, known: cur });
  return { day, rows: rows.length, complete, ...res };
}

export async function mirrorOrIb({ token, deadline }) {
  const store = getStore('plan-coach');
  const dayOf = (k) => new Date(Date.now() - k * 864e5).toISOString().slice(0, 10);
  let done = [];
  try { done = (await store.get('meta:orib-done', { type: 'json' })) || []; } catch { done = []; }
  const doneSet = new Set(done);
  const days = [dayOf(1), dayOf(0)];
  for (let k = 2; k <= BACK_DAYS && days.length < 2 + BACKFILL_PER_RUN; k++) {
    if (!doneSet.has(dayOf(k))) days.push(dayOf(k));
  }
  const out = [];
  for (const day of days) {
    if (Date.now() > deadline) break;
    const r = await mirrorDay(store, day, token, deadline);
    out.push(r);
    // un día anterior a ayer ya no recibe eventos nuevos: si se copió entero, no se repite
    if (r.complete && day < dayOf(1)) doneSet.add(day);
  }
  const keep = [...doneSet].filter((d) => d >= dayOf(BACK_DAYS + 5)).sort();
  try { await store.setJSON('meta:orib-done', keep); } catch { /* best effort */ }
  return out;
}
