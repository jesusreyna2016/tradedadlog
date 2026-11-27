// Digest de disciplina desde el servidor (MFP, solo lectura), cada noche. Antes live/journal.json solo se
// actualizaba con Mi Mesa abierta, y con la app cerrada el Session Analyst se quedaba sin ejecucion (journal
// rancio 100 h, nov 2026). Esto rellena los ultimos dias con lo que se ve desde MFP: trades, racha de
// perdidas, revancha (entrada dentro de la pausa tras perder), sobre-operar (mas trades que el tope del Coach),
// salidas en puntos y fills. NO califica (graded, sesgo, zona quedan en 0: sin ficha no hay plan declarado);
// eso lo hace el analista con los fills (method/plan_vs_exec.py). Los dias con src 'mfp' nunca pisan un dia
// que ya mando Mi Mesa (writeJournalDigest), y Mi Mesa si los pisa cuando se abre.
import { getStore } from '@netlify/blobs';
import { writeJournalDigest } from './journal-ingest.mjs';
import { hasKey, listAccounts, closedPositions } from './_mfp.mjs';

export const config = { schedule: '40 4 * * *' };   // 04:40 UTC = 22:40 / 23:40 Chicago, tras el cierre de NY

const DAYS = 4;
const nyDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));   // dia de MFP, como Mi Mesa

export function digestFromPositions(list, { cooldownMin = 15, maxTrades = 5 } = {}) {
  const byDay = {};
  for (const p of list) if (p.opened_at) (byDay[nyDay(p.opened_at)] = byDay[nyDay(p.opened_at)] || []).push(p);
  return Object.keys(byDay).sort().map((date) => {
    const T = byDay[date].slice().sort((a, b) => a.opened_at - b.opened_at);
    const net = (p) => (+p.realized_pnl || 0) - (+p.fees || 0) + (+p.funding || 0);
    let run = 0, maxLossStreak = 0, revenge = false;
    const lastLoss = {};
    for (const p of T) {
      const ll = lastLoss[p.account_id];
      if (ll != null && p.opened_at >= ll && p.opened_at - ll < cooldownMin * 60e3) revenge = true;
      if (net(p) < 0) { run++; lastLoss[p.account_id] = p.closed_at || p.opened_at; } else run = 0;
      maxLossStreak = Math.max(maxLossStreak, run);
    }
    const pts = T.map((p) => (p.side === 'short' ? -1 : 1) * ((+p.exit_price || 0) - (+p.entry_price || 0)));
    const W = pts.filter((x) => x > 0), L = pts.filter((x) => x < 0);
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const overtrade = T.length > maxTrades;
    return {
      date, src: 'mfp', trades: T.length, disciplined: !revenge && !overtrade, maxLossStreak, overtrade, revenge, roundTrip: false,
      graded: 0, withBias: 0, againstBias: 0, validEdge: 0, outsideEdge: 0,
      positions: T.length, partials: null,
      // scratch ~ 4 ticks de NQ: 0.005 % del precio (XYZ100 y BTC no tienen el mismo tick)
      scratches: T.filter((p, i) => +p.entry_price > 0 && Math.abs(pts[i]) <= +p.entry_price * 5e-5).length,
      fullStops: T.filter((p) => p.close_reason === 'stop_loss' && net(p) < 0).length,
      wlPtsRatio: W.length && L.length ? +(avg(W) / -avg(L)).toFixed(2) : null,
      fills: T.slice(-80).map((p, i, arr) => ({
        t: new Date(p.opened_at).toISOString().slice(0, 19) + 'Z', sym: String(p.symbol || ''), side: p.side,
        entry: +p.entry_price || null, exit: +p.exit_price || null,
        pts: +pts[T.length - arr.length + i].toFixed(2),
        durMin: p.closed_at ? Math.round((p.closed_at - p.opened_at) / 60000) : null
      }))
    };
  });
}

export async function runJournalServer(nowMs = Date.now()) {
  if (!hasKey()) return { ok: false, skipped: 'sin MFP_API_KEY' };
  const cfg = (await getStore('live').get('config', { type: 'json' }).catch(() => null)) || {};
  const since = nowMs - DAYS * 86400e3;
  const accounts = (await listAccounts()).filter((a) => a.status === 'active' || (+a.updated_at || 0) > since);
  const all = [], errs = [];
  for (const a of accounts) {
    try { all.push(...(await closedPositions(a.id, { since, maxPages: 3 }))); } catch (e) { errs.push(a.account_number + ': ' + e.message); }
  }
  const byDay = digestFromPositions(all, { cooldownMin: +cfg.cooldownMin || 15, maxTrades: 5 });
  if (!byDay.length) return { ok: true, note: 'sin trades en ' + DAYS + ' dias', accounts: accounts.length, errs };
  const r = await writeJournalDigest(byDay, 'mfp-server');
  return { ...r, accounts: accounts.length, days: byDay.map((d) => d.date), errs };
}

export default async () => {
  let r;
  try { r = await runJournalServer(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
};
