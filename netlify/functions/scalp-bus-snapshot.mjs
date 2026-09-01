// Espeja los logs de eventos de Scalp CC (Netlify Blobs store 'scalp', key
// log:<YYYY-MM-DD>) al repo git jesusreyna2016/scalp-cc-bus, separados por tipo:
//   evt=signal   -> signals/<fecha>.jsonl
//   evt=outcome  -> outcomes/<fecha>.jsonl
// Idempotente: reconstruye el archivo completo del dia desde el blob y hace
// busPut (que omite el commit si el contenido no cambio). Procesa hoy y ayer
// (para recoger outcomes tardios cerca de medianoche UTC).
//
// Invocable por HTTP para pruebas; el schedule vive en scalp-bus-cron.mjs.
import { getStore } from '@netlify/blobs';
import { busPut } from './_scalp-bus.mjs';

function daysToProcess() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const y = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  return [y, today];
}

function dedupeBySigIdEvt(records) {
  // ultimo gana: para outcomes reemitidos o signals repetidos por el mismo bar
  const m = new Map();
  for (const r of records) {
    const id = r?.sigId || r?.raw?.sigId;
    const evt = r?.evt || r?.raw?.evt || 'signal';
    if (!id) continue;
    m.set(`${id}::${evt}`, r);
  }
  return [...m.values()];
}

export async function runSnapshot() {
  const token = process.env.SCALP_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta SCALP_BUS_TOKEN' };

  const store = getStore('scalp');
  const out = [];

  for (const day of daysToProcess()) {
    const blob = (await store.get(`log:${day}`)) || '';
    if (!blob.trim()) continue;

    const recs = blob
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const signals = dedupeBySigIdEvt(recs.filter((r) => (r.evt || r.raw?.evt) === 'signal'));
    const outcomes = dedupeBySigIdEvt(recs.filter((r) => (r.evt || r.raw?.evt) === 'outcome'));

    if (signals.length) {
      const body = signals.map((r) => JSON.stringify(r)).join('\n') + '\n';
      out.push(await busPut(`signals/${day}.jsonl`, body, `scalp-bus: signals ${day} (${signals.length})`, { token }));
    }
    if (outcomes.length) {
      const body = outcomes.map((r) => JSON.stringify(r)).join('\n') + '\n';
      out.push(await busPut(`outcomes/${day}.jsonl`, body, `scalp-bus: outcomes ${day} (${outcomes.length})`, { token }));
    }
  }

  return { ok: true, wrote: out };
}
