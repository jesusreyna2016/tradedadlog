// Zone-watch: every 15 min, checks whether the A+ zones of the current Session Analyst
// plan were touched / invalidated / expired and publishes live/zone-status.json in the
// session-analyst-bus repo. Deterministic replacement for the local Claude scheduled
// task "sa-zone-watch" (same rules, same output schema, no LLM, runs 24/7).
//
// Inputs (bus): plans/latest.json, live/market.json (feed touchlog), live/zone-status.json.
// Prices: 5m bars from Yahoo since the plan's generatedAt (same source as sa-bus-bars).
// Day-level touchlog / hod / lod are NOT used to decide a touch: they include action
// from before the plan was written. The touchlog only enriches a touch the bars confirm.
//
// Rules per non-terminal zone (terminal = invalidated, expired):
//   touched     : a 5m bar since generatedAt (and up to the window end) traded into range
//   invalidated : a 5m CLOSE beyond the fast kill level of play.ifWrong ("5m close
//                 above/below X"), else invalidation.level, else structStop "= X",
//                 before the window end. Overrides touched. After the window a touched
//                 zone is final.
//   expired     : play.window (CT) closed and the zone is still pending.
// Writes only when the plan changed or at least one zone changed status.
//
// The 15-min schedule lives in zone-watch-cron.mjs (scheduled functions are not
// reachable by URL). This HTTP entry is ALWAYS a dry run: GET
// /.netlify/functions/zone-watch[?now=<ISO>] returns the computed file, writes nothing.
// Locally: runZoneWatch({ dryRun: true }); without SA_BUS_TOKEN it reads the bus raw.
import { busGet, busPut } from './_sa-bus.mjs';

const PATH = 'live/zone-status.json';
const YAHOO = { NQ: 'NQ=F', ES: 'ES=F', GC: 'GC=F', YM: 'YM=F', CL: 'CL=F', ETHUSDT: 'ETH-USD', BTCUSDT: 'BTC-USD' };
const TICK = { NQ: 0.25, ES: 0.25, YM: 1, GC: 0.1, CL: 0.01, ETHUSDT: 0.01, BTCUSDT: 0.01 };
// touchlog name -> feed.raw field with that level's price
const TL_FIELD = { VAH: 'vah', POC: 'poc', VAL: 'val', PDH: 'pdh', PDL: 'pdl', DO: 'do', TDO: 'tdo',
  ONH: 'onh', ONL: 'onl', IBH: 'ibh', IBL: 'ibl', ASH: 'asH', ASL: 'asL', LOH: 'loH', LOL: 'loL' };
const RANK = { invalidated: 0, expired: 1, touched: 2 };

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// --- time helpers (America/Chicago) ---
function ctParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
// UTC ms of a CT wall-clock time (date YYYY-MM-DD, h, m)
function ctToMs(date, h, m) {
  const guess = Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  let ms = guess;
  for (let i = 0; i < 2; i++) {
    const p = ctParts(ms);
    const shown = Date.parse(`${p.date}T${p.hm}:00Z`);
    ms += guess - shown;
  }
  return ms;
}
const addDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const fmtCT = (ms) => ctParts(ms).hm;

// The window occurrence that is still open (or the first one) at/after generatedAt.
function windowOf(zone, genMs) {
  const w = zone?.play?.window || '';
  const m = String(w).match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let date = ctParts(genMs).date;
  for (let i = 0; i < 3; i++) {
    const start = ctToMs(date, +m[1], +m[2]);
    let end = ctToMs(date, +m[3], +m[4]);
    if (end <= start) end = ctToMs(addDays(date, 1), +m[3], +m[4]);
    if (end > genMs) return { start, end };
    date = addDays(date, 1);
  }
  return null;
}

// Fast kill level: { level, side: 'above'|'below' }
function killOf(zone) {
  const dir = String(zone.dir || '').toUpperCase();
  const side = dir === 'SHORT' ? 'above' : 'below';
  const txt = [zone?.play?.ifWrong?.en, zone?.play?.ifWrong?.es].filter(Boolean).join(' | ');
  let m = txt.match(/close\s+(above|below)\s+(-?\d+(?:\.\d+)?)/i) || txt.match(/cierre\s+\S+\s+(sobre|bajo)\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { level: +m[2], side: /above|sobre/i.test(m[1]) ? 'above' : 'below' };
  const inv = zone?.invalidation?.level ?? (typeof zone?.invalidation === 'number' ? zone.invalidation : null);
  if (Number.isFinite(+inv) && inv !== null) return { level: +inv, side };
  m = String(zone?.play?.structStop?.en || zone?.play?.structStop?.es || '').match(/=\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { level: +m[1], side };
  return null;
}

// Plan ranges keep their source spelling in the key ("7572.0-7581.0", "51955-51985"):
// tag every "range": [a, b] in the raw text with its raw form before parsing.
function parsePlan(text) {
  const tagged = text.replace(/"range"\s*:\s*\[\s*(-?[\d.eE+]+)\s*,\s*(-?[\d.eE+]+)\s*\]/g,
    (all, a, b) => `${all}, "__rangeRaw": "${a}-${b}"`);
  try { return JSON.parse(tagged); } catch { return JSON.parse(text); }
}

async function yahooBars(sym, fromMs, toMs) {
  const y = YAHOO[sym];
  if (!y) return null;
  const p1 = Math.floor(fromMs / 1000) - 600, p2 = Math.ceil(toMs / 1000) + 600;
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=5m&period1=${p1}&period2=${p2}`;
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (TradeDadLog zone-watch)', accept: 'application/json' } });
  if (!r.ok) throw new Error(`yahoo ${y} ${r.status}`);
  const res = (await r.json())?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q) return [];
  const tk = TICK[sym] || 0.01, dec = (String(tk).split('.')[1] || '').length;
  const rd = (x) => +(Math.round(x / tk) * tk).toFixed(dec);
  const out = [];
  res.timestamp.forEach((t, i) => {
    // skip gaps and Yahoo's off-grid settlement point (e.g. 21:59:59), which is not a bar
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || t % 300 !== 0) return;
    out.push({ t: t * 1000, h: rd(q.high[i]), l: rd(q.low[i]), c: rd(q.close[i]) });
  });
  return out;
}

function touchlogFor(sym, zone, raw, tick) {
  if (!raw || !raw.touchlog) return null;
  const [lo, hi] = [Math.min(...zone.range), Math.max(...zone.range)];
  let best = null;
  for (const g of String(raw.touchlog).split('~')) {
    const [name, n, wick, rec] = g.split(':');
    const f = TL_FIELD[name];
    const px = f ? parseFloat(raw[f]) : NaN;
    if (!Number.isFinite(px) || px < lo - tick || px > hi + tick) continue;
    const e = { name, nToques: +n || 0, maxWickTicks: +wick || 0, reclaim: rec === '1' };
    if (e.nToques >= 1 && (!best || e.nToques > best.nToques)) best = e;
  }
  return best;
}

const blank = (sym, zone) => ({
  sym, type: zone.type, range: zone.range, dir: zone.dir,
  status: 'pending', firstTouchedAt: null, touchSource: null,
  nToques: null, maxWickTicks: null, reclaim: null, invalidatedAt: null, expiredAt: null
});

export async function runZoneWatch({ dryRun = false, now = Date.now() } = {}) {
  const token = process.env.SA_BUS_TOKEN || null;
  if (!dryRun && !token) return { ok: false, reason: 'SA_BUS_TOKEN no configurado' };

  const [planF, marketF, prevF] = await Promise.all([
    busGet('plans/latest.json', { token }), busGet('live/market.json', { token }), busGet(PATH, { token })
  ]);
  let prev = null;
  try { prev = prevF && prevF.content ? JSON.parse(prevF.content) : null; } catch { prev = null; }
  const plan = planF && planF.content ? parsePlan(planF.content) : null;
  const instruments = plan?.instruments || {};
  const hasZones = Object.values(instruments).some((v) => Array.isArray(v?.zones) && v.zones.length);
  const nowIso = iso(now);
  const stamp = `${ctParts(now).date} ${fmtCT(now)} CT`;

  // No plan / no zones
  if (!plan || !hasZones) {
    const doc = { checkedAt: nowIso, planDate: null, zones: {}, issues: [] };
    const same = prev && prev.planDate === null && prev.zones && !Object.keys(prev.zones).length;
    if (same) return { ok: true, unchanged: true, summary: 'zone-watch: sin plan activo' };
    return write(doc, prevF, { token, dryRun, stamp, summary: 'zone-watch: sin plan activo' });
  }

  const genMs = Date.parse(plan.generatedAt);
  const samePlan = prev && prev.planDate === plan.date && prev.planGeneratedAt === plan.generatedAt;
  const prevZones = samePlan ? (prev.zones || {}) : {};
  const feed = marketF && marketF.content ? (() => { try { return JSON.parse(marketF.content).feed; } catch { return null; } })() : null;

  const zones = {};
  const changed = [];
  const errors = {};
  const barCache = {};

  for (const [sym, inst] of Object.entries(instruments)) {
    for (const zone of inst?.zones || []) {
      if (!Array.isArray(zone.range) || zone.range.length < 2) continue;
      const key = `${sym}|${zone.type}|${zone.__rangeRaw || `${zone.range[0]}-${zone.range[1]}`}`;
      const { __rangeRaw, ...z } = zone;
      const old = prevZones[key];
      if (old && (old.status === 'invalidated' || old.status === 'expired')) { zones[key] = old; continue; }

      const e = old ? { ...old } : blank(sym, z);
      const lo = Math.min(...z.range), hi = Math.max(...z.range);
      const win = windowOf(z, genMs);
      const kill = killOf(z);

      if (!(sym in barCache)) {
        try { barCache[sym] = await yahooBars(sym, genMs, now); }
        catch (err) { barCache[sym] = null; errors[sym] = String(err.message || err); }
      }
      const bars = barCache[sym];
      if (bars === null) { zones[key] = old || e; continue; } // no prices: leave as is

      const after = bars.filter((b) => b.t >= genMs - 5 * 60e3 && b.t + 5 * 60e3 > genMs && b.t <= now);
      const closed = after.filter((b) => b.t + 5 * 60e3 <= now);
      const touchEnd = win ? win.end : Infinity;

      // 1-2. touch
      let detail = '';
      if (e.status === 'pending') {
        const hit = after.find((b) => b.t < touchEnd && b.h >= lo && b.l <= hi);
        if (hit) {
          e.status = 'touched';
          e.firstTouchedAt = iso(Math.max(hit.t, genMs));
          const tl = touchlogFor(sym, z, feed?.symbols?.[sym]?.feed?.raw, TICK[sym] || 0.01);
          if (tl) {
            e.touchSource = 'touchlog';
            e.nToques = tl.nToques; e.maxWickTicks = tl.maxWickTicks; e.reclaim = tl.reclaim;
          } else e.touchSource = 'price-range';
          e.note = {
            es: `Zona tocada a las ${fmtCT(Date.parse(e.firstTouchedAt))} CT (rango ${lo}-${hi}${tl ? `, ${tl.name} ${tl.nToques} toques` : ''}).`,
            en: `Zone touched at ${fmtCT(Date.parse(e.firstTouchedAt))} CT (range ${lo}-${hi}${tl ? `, ${tl.name} ${tl.nToques} touches` : ''}).`
          };
          detail = `tocada a las ${fmtCT(Date.parse(e.firstTouchedAt))} CT`;
        }
      }

      // 3. invalidation (5m close beyond the fast kill level), overrides touched
      if (kill) {
        const bad = closed.find((b) => b.t < touchEnd && (kill.side === 'above' ? b.c > kill.level : b.c < kill.level));
        if (bad) {
          const at = bad.t + 5 * 60e3;
          e.status = 'invalidated';
          e.invalidatedAt = iso(at);
          const word = kill.side === 'above' ? ['sobre', 'above'] : ['bajo', 'below'];
          e.note = {
            es: `Invalidada a las ${fmtCT(at)} CT: cierre 5m ${word[0]} ${kill.level} (${bad.c}).`,
            en: `Invalidated at ${fmtCT(at)} CT: 5m close ${word[1]} ${kill.level} (${bad.c}).`
          };
          detail = `invalidada a las ${fmtCT(at)} CT, cierre ${word[0]} ${kill.level}`;
        }
      }

      // 4. expiry
      if (e.status === 'pending' && win && now >= win.end) {
        const hh = after.length ? Math.max(...after.filter((b) => b.t < win.end).map((b) => b.h)) : null;
        const ll = after.length ? Math.min(...after.filter((b) => b.t < win.end).map((b) => b.l)) : null;
        const w = z.play.window;
        const seen = Number.isFinite(hh) && Number.isFinite(ll) ? ` (${ll}-${hh})` : ' (sin velas)';
        const seenEn = Number.isFinite(hh) && Number.isFinite(ll) ? ` (${ll}-${hh})` : ' (no bars)';
        e.status = 'expired';
        e.expiredAt = iso(win.end);
        e.note = {
          es: `La ventana ${w} cerró sin tocar ${lo}-${hi}; rango desde el plan${seen}.`,
          en: `The ${w} window closed without a touch of ${lo}-${hi}; range since the plan${seenEn}.`
        };
        detail = `vencida a las ${fmtCT(win.end)} CT sin toque`;
      }

      if (!old || old.status !== e.status) {
        if (e.status !== 'pending') changed.push({ rank: RANK[e.status], text: `${key} ${detail}` });
        zones[key] = e;
      } else zones[key] = old; // unchanged: identical entry
    }
  }

  const issues = changed.sort((a, b) => a.rank - b.rank).map((c) => c.text);
  const pending = Object.values(zones).filter((z) => z.status === 'pending').length;
  const keysSame = samePlan && Object.keys(zones).length === Object.keys(prevZones).length;
  if (keysSame && !issues.length) {
    return { ok: true, unchanged: true, summary: `zone-watch: sin cambios (${pending} zonas pendientes)`, errors };
  }
  const doc = { checkedAt: nowIso, planDate: plan.date, planGeneratedAt: plan.generatedAt, zones, issues };
  return write(doc, prevF, { token, dryRun, stamp, errors,
    summary: issues.length ? issues.join('\n') : `zone-watch: plan nuevo (${pending} zonas pendientes)` });
}

async function write(doc, prevF, { token, dryRun, stamp, summary, errors }) {
  const body = JSON.stringify(doc, null, 2) + '\n';
  if (dryRun) return { ok: true, dryRun: true, summary, errors, doc };
  const r = await busPut(PATH, body, `zone-watch ${stamp}`, { token, known: prevF || null });
  return { ok: true, ...r, summary, errors };
}

export default async (req) => {
  let now = Date.now();
  try {
    const n = new URL(req.url).searchParams.get('now');
    if (n && Number.isFinite(Date.parse(n))) now = Date.parse(n);
  } catch { /* no query */ }
  let r;
  try { r = await runZoneWatch({ dryRun: true, now }); }
  catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  return new Response(JSON.stringify(r, null, 2), {
    status: r.ok ? 200 : 502,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
};
