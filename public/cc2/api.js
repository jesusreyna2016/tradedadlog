// Data layer: the same feeds the classic Command Center reads, polled at the same cadence
// (every Netlify call counts, so nothing faster than v1) and paused while the tab is hidden.

export const CC_API = /(^|\.)tradedadlog\.com$/i.test(location.hostname) ? '' : 'https://tradedadlog.com';
const BUS = 'https://raw.githubusercontent.com/jesusreyna2016/session-analyst-bus/main';

export const SYMS = [['NQ', 'NQ'], ['ETHUSDT', 'ETH'], ['BTCUSDT', 'BTC']];
export const symName = s => String(s || '').replace(/USDT$/, '');
export const isCrypto = s => /USDT$/.test(s);

// tick size per symbol (same table as v1)
export const tickOf = s => ({ GC: .1, CL: .01, SI: .005, YM: 1, ETHUSDT: .02, BTCUSDT: 1 }[s] || .25);

export function ctParts(d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { wd: p.weekday, h: +p.hour, m: +p.minute, s: +p.second };
}
export function futuresClosed() {
  const { wd, h } = ctParts();
  return wd === 'Sat' || (wd === 'Fri' && h >= 16) || (wd === 'Sun' && h < 17);
}
export const localDay = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const utcDay = () => new Date().toISOString().slice(0, 10);

// active symbol: same rule and storage as v1 (NQ on weekdays, ETH while CME is closed, unless picked today)
export function getSym() {
  try { const s = JSON.parse(localStorage.getItem('cc_sym') || 'null'); if (s && s.day === utcDay()) return s.sym; } catch (e) {}
  return futuresClosed() ? 'ETHUSDT' : 'NQ';
}
export function setSym(sym) {
  try { localStorage.setItem('cc_sym', JSON.stringify({ sym, day: utcDay() })); } catch (e) {}
}

export const store = {
  plan: {},       // per symbol, /api/cc-plan
  scan: null,     // /api/cc-scan symbols{}
  regime: null,   // /api/cc-regime symbols{}
  trend: null,    // /api/cc-trend symbols{}
  news: null,     // /api/cc-news events[]
  sa: null,       // bus plans/latest.json
  saCrypto: null, // bus plans/crypto-latest.json (weekends only, 404 otherwise)
  health: null,   // bus live/health.json
  weekly: null,   // bus reviews/weekly-latest.md
  at: {},         // last successful fetch per feed (ms)
};

async function get(url, kind = 'json') {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return kind === 'text' ? await r.text() : await r.json();
  } catch (e) { return null; }
}
const bust = u => u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();

const LOADERS = {
  async plan() {
    const sym = getSym();
    const p = await get(CC_API + '/api/cc-plan' + (sym !== 'NQ' ? '?sym=' + sym : ''));
    if (p && p.date) { store.plan[sym] = p; return true; }
  },
  async scan() { const d = await get(CC_API + '/api/cc-scan'); if (d) { store.scan = d.symbols || {}; return true; } },
  async regime() { const d = await get(CC_API + '/api/cc-regime'); if (d) { store.regime = d.symbols || {}; return true; } },
  async trend() { const d = await get(CC_API + '/api/cc-trend'); if (d) { store.trend = d.symbols || {}; return true; } },
  async news() { const d = await get(CC_API + '/api/cc-news'); if (d) { store.news = d.events || []; return true; } },
  async sa() {
    const [p, cp, h, w] = await Promise.all([
      get(bust(BUS + '/plans/latest.json')),
      get(bust(BUS + '/plans/crypto-latest.json')),
      get(bust(BUS + '/live/health.json')),
      get(bust(BUS + '/reviews/weekly-latest.md'), 'text'),
    ]);
    if (p) store.sa = p;
    store.saCrypto = cp && cp.instruments ? cp : null;
    if (h) store.health = h;
    if (w) store.weekly = w;
    return !!p;
  },
};

// seconds between polls, matching v1
const EVERY = { plan: 240, scan: 240, regime: 120, trend: 120, news: 900, sa: 300 };

export function startPolling(onData) {
  const run = async key => {
    if (document.hidden) return;
    if (await LOADERS[key]()) store.at[key] = Date.now();
    onData(key);
  };
  Object.keys(LOADERS).forEach(k => { run(k); setInterval(() => run(k), EVERY[k] * 1000); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Object.keys(LOADERS).forEach(run); });
  return { refreshSym: () => run('plan') };
}
