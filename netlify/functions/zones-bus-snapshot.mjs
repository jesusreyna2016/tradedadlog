// Copia los datos del agente de aprendizaje de zonas de Netlify Blobs (store 'zonelearn') al bus
// jesusreyna2016/session-analyst-bus:
//   eventos del indicador (MMZ1) -> zones/events/<dia CT>.jsonl  (hoy y ayer; MERGE-ONLY por sym|id|ev)
//   trades de Mi Mesa (sin dinero) -> zones/trades.json         (merge por id)
// busPut no commitea si nada cambio. Invocable por HTTP para pruebas; el schedule vive en zones-bus-cron.mjs.
import { busGet, busPut } from './_sa-bus.mjs';
import { eventsFor, loadTrades } from './_zonelearn.mjs';

const chicagoDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const keyOf = (e) => e.sym + '|' + e.id + '|' + e.ev;

export async function runZonesSnapshot() {
  const token = process.env.SA_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta SA_BUS_TOKEN' };
  const now = Date.now();
  const days = [...new Set([chicagoDay(now - 24 * 3600e3), chicagoDay(now)])];
  const out = { ok: true, days: {} };
  for (const day of days) {
    const fresh = await eventsFor(day);
    const path = `zones/events/${day}.jsonl`;
    const cur = await busGet(path, { token }).catch(() => null);
    const map = new Map();
    for (const line of (cur?.content || '').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); map.set(keyOf(r), r); } catch (e) { /* linea corrupta */ }
    }
    for (const e of fresh) { const k = keyOf(e); if (!map.has(k) || (map.get(k).t || 0) < e.t) map.set(k, e); }
    if (!map.size) { out.days[day] = 0; continue; }
    const body = [...map.values()].sort((a, b) => a.t - b.t).map((r) => JSON.stringify(r)).join('\n') + '\n';
    const r = await busPut(path, body, `zones: events ${day} (${map.size})`, { token, known: cur });
    out.days[day] = r.skipped ? 'sin cambios' : map.size;
  }
  const trades = await loadTrades();
  if (trades.length) {
    const cur = await busGet('zones/trades.json', { token }).catch(() => null);
    let have = {};
    try { have = cur?.content ? JSON.parse(cur.content).trades || {} : {}; } catch (e) { have = {}; }
    for (const t of trades) have[t.id] = t;
    const body = JSON.stringify({ updatedAt: new Date(now).toISOString(), note: 'Trades de Mi Mesa sin dinero (R, lado, hora, precio, zona del plan)', trades: have }, null, 1) + '\n';
    const strip = (c) => { try { const j = JSON.parse(c); delete j.updatedAt; return JSON.stringify(j); } catch (e) { return null; } };
    if (cur && strip(cur.content) === strip(body)) out.trades = 'sin cambios';
    else { await busPut('zones/trades.json', body, `zones: trades (${Object.keys(have).length})`, { token, known: cur }); out.trades = Object.keys(have).length; }
  }
  return out;
}

export default async () => new Response(JSON.stringify(await runZonesSnapshot()), { headers: { 'content-type': 'application/json' } });
