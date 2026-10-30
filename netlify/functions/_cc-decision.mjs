// Decision-card log + grading for the Command Center decision card.
// Every 15 min the cron runs the SAME engine the page uses (public/cc2/decision.js) on the stored
// feeds, market read only (gatekeeper treated as open), and appends the answer to dlog:<SYM>:<UTC day>.
// /api/cc-decisions grades each logged answer by where price was 60 min later.
import { getStore } from '@netlify/blobs';
import { decide } from '../../public/cc2/decision.js';

export const SYMS = ['NQ', 'ETHUSDT', 'BTCUSDT'];
const BUS = 'https://raw.githubusercontent.com/jesusreyna2016/session-analyst-bus/main';
export const HORIZON_MIN = 60, TOLERANCE_MIN = 30;
const OPEN_GATE = { ok: true, kind: 'open', used: 0 };

async function bus(path) {
  try { const r = await fetch(BUS + path + '?t=' + Date.now()); return r.ok ? await r.json() : null; } catch (e) { return null; }
}
async function rec(store, key) {
  try { const r = await store.get(key, { type: 'json' }); return r ? { ...r.raw, receivedAt: r.receivedAt } : null; } catch (e) { return null; }
}

export async function runDecisionLog() {
  const store = getStore('cc');
  const [sa, saCrypto, news] = await Promise.all([
    bus('/plans/latest.json'), bus('/plans/crypto-latest.json'),
    store.get('news', { type: 'json' }).catch(() => null),
  ]);
  const day = new Date().toISOString().slice(0, 10);
  const out = {};
  for (const sym of SYMS) {
    const [plan, trend, regime] = await Promise.all([
      store.get(sym === 'NQ' ? 'latest' : 'sym:' + sym, { type: 'json' }).catch(() => null),
      rec(store, 'ind:trendcl:' + sym), rec(store, 'ind:regime:' + sym),
    ]);
    const d = decide(sym, { plan, trend, regime, sa, saCrypto: saCrypto && saCrypto.instruments ? saCrypto : null, news: news && news.events }, OPEN_GATE, 5);
    if (d.code === 'nodata' || d.price == null || !plan || !plan.updatedAt) { out[sym] = 'skip: no fresh data'; continue; }
    const key = `dlog:${sym}:${day}`;
    let log = [];
    try { log = (await store.get(key, { type: 'json' })) || []; } catch (e) { log = []; }
    // the indicator hasn't sent a new bar since the last entry: same price, nothing to learn
    if (log.length && log[log.length - 1].pu === plan.updatedAt) { out[sym] = 'skip: plan not updated'; continue; }
    const z = d.zoneHit;
    log.push({ t: Date.now(), px: d.price, pu: plan.updatedAt, code: d.code, dir: d.dir, agree: d.agree,
      zlo: z ? z.lo : null, zhi: z ? z.hi : null });
    await store.setJSON(key, log);
    out[sym] = d.code + ' ' + (d.dir > 0 ? 'long' : d.dir < 0 ? 'short' : 'none') + ' @' + d.price;
  }
  return { at: new Date().toISOString(), out };
}

// grade: for each entry, the first later entry 60-90 min after it gives the forward move
export function grade(entries) {
  const e = entries.slice().sort((a, b) => a.t - b.t);
  const rows = [];
  for (let i = 0; i < e.length; i++) {
    const a = e[i], want = a.t + HORIZON_MIN * 60000;
    let b = null;
    for (let j = i + 1; j < e.length; j++) {
      if (e[j].t < want) continue;
      if (e[j].t <= want + TOLERANCE_MIN * 60000) b = e[j];
      break;
    }
    if (!b) continue;
    const move = b.px - a.px;
    rows.push({ code: a.code, dir: a.dir, signed: a.dir ? move * a.dir : null, abs: Math.abs(move) });
  }
  const by = {};
  rows.forEach(r => {
    const s = by[r.code] || (by[r.code] = { n: 0, withDir: 0, right: 0, sumSigned: 0, sumAbs: 0 });
    s.n++; s.sumAbs += r.abs;
    if (r.dir) { s.withDir++; s.sumSigned += r.signed; if (r.signed > 0) s.right++; }
  });
  const stats = {};
  Object.keys(by).forEach(k => {
    const s = by[k];
    stats[k] = { n: s.n, rightPct: s.withDir ? Math.round(s.right / s.withDir * 100) : null,
      avgPts: s.withDir ? +(s.sumSigned / s.withDir).toFixed(2) : null, avgAbsPts: +(s.sumAbs / s.n).toFixed(2) };
  });
  return { graded: rows.length, logged: e.length, stats };
}
