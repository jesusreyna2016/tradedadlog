// Enumera los eventos de Scalp CC guardados por scalp-ingest.mjs (Netlify Blobs
// store 'scalp', claves ev/<YYYY-MM-DD>/<sigId>__<evt>) y los espeja al repo git
// jesusreyna2016/scalp-cc-bus, separados por tipo:
//   evt=signal   -> signals/<fecha>.jsonl
//   evt=outcome  -> outcomes/<fecha>.jsonl
// Idempotente: reconstruye el archivo completo del dia y hace busPut (que omite
// el commit si el contenido no cambio). Procesa hoy y ayer (para recoger
// outcomes tardios cerca de medianoche UTC).
//
// Invocable por HTTP para pruebas (GET); el schedule vive en scalp-bus-cron.mjs.
import { getStore } from '@netlify/blobs';
import { busPut } from './_scalp-bus.mjs';

function daysToProcess() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const y = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  return [y, today];
}

export async function runSnapshot() {
  const token = process.env.SCALP_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta SCALP_BUS_TOKEN' };

  const store = getStore('scalp');
  const out = [];

  for (const day of daysToProcess()) {
    const listed = await store.list({ prefix: `ev/${day}/` });
    const keys = (listed && listed.blobs ? listed.blobs : []).map((b) => b.key);
    if (!keys.length) continue;

    const recs = [];
    for (const k of keys) {
      const r = await store.get(k, { type: 'json' });
      if (r) recs.push(r);
    }

    const byType = (evt) => {
      const m = new Map();
      for (const r of recs) {
        if ((r.evt || r.raw?.evt) !== evt) continue;
        const id = r.sigId || r.raw?.sigId;
        if (!id) continue;
        m.set(id, r);
      }
      return [...m.values()].sort((a, b) =>
        String(a.receivedAt || '').localeCompare(String(b.receivedAt || ''))
      );
    };

    const signals = byType('signal');
    const outcomes = byType('outcome');

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

// invocable por HTTP para pruebas: GET /api/scalp-bus-snapshot
export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: r.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json' },
  });
};
