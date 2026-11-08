// Plan Intradia · zonas de entrada recalculadas cada 15 min (NQ, ES, GC, ETH, BTC).
//   GET /api/intraday-plan            -> ultimo plan (lo guarda intraday-cron)
//   GET /api/intraday-plan?fresh=1    -> lo recalcula al momento (sin esperar al cron)
//   GET /api/intraday-plan?log=YYYY-MM-DD -> registro de zonas tocadas / invalidadas / que funcionaron ese dia
//   GET /api/intraday-plan?tv=1       -> linea de sync (texto) para pegar en el indicador "Mi Mesa · Zonas" de TradingView
//
// La logica vive en runIntraday(): lee el ultimo estado de los indicadores (session-feed),
// el calendario (cc-news) y los planes del Session Analyst (bus), arma el plan con
// _intraday.mjs, lo compara contra la corrida anterior para el estado vivo de cada zona,
// y lo guarda en Blobs (store 'intraday') y en el bus (live/intraday.json) para que las
// rutinas cloud y la app Mi Mesa lo lean.
import { getStore } from '@netlify/blobs';
import feedHandler from './session-feed.mjs';
import newsHandler from './cc-news.mjs';
import { busGet, busPut } from './_sa-bus.mjs';
import { buildSymbolPlan, trackZones, buildTvSync, IND_VERSION } from './_intraday.mjs';
import { loadTv, mergeTv, healthFrom } from './_tvzones.mjs';
import { notifyTvDead } from './_push.mjs';
import { loadWeights } from './_zonelearn.mjs';

export const INTRADAY_SYMS = ['NQ', 'ES', 'GC', 'ETHUSDT', 'BTCUSDT'];
const CRYPTO = new Set(['ETHUSDT', 'BTCUSDT']);

const readJson = async (handler) => {
  try {
    const res = await handler(new Request('https://tradedadlog.com/internal'));
    return await res.json();
  } catch (e) {
    return null;
  }
};

async function readPlan(path) {
  try {
    const f = await busGet(path);
    return f && f.content ? JSON.parse(f.content) : null;
  } catch (e) {
    return null;
  }
}

const chicagoDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));

export async function runIntraday({ write = true } = {}) {
  const nowMs = Date.now();
  const [feed, news, saPlan, saCrypto, weights] = await Promise.all([
    readJson(feedHandler), readJson(newsHandler), readPlan('plans/latest.json'), readPlan('plans/crypto-latest.json'), loadWeights().catch(() => null)
  ]);
  if (!feed || (!feed.symbols && !feed.crypto)) return { ok: false, error: 'session-feed sin datos' };

  const store = getStore('intraday');
  let prev = null;
  try { prev = await store.get('latest', { type: 'json' }); } catch (e) { prev = null; }

  const out = { schema: 'intraday-1', builtAt: new Date(nowMs).toISOString(), everyMin: 15, weightsVersion: weights?.version || 'default', symbols: {} };
  const day = chicagoDate(nowMs);
  const finished = [];

  for (const sym of INTRADAY_SYMS) {
    const entry = (CRYPTO.has(sym) ? feed.crypto : feed.symbols)?.[sym] || {};
    const planSrc = CRYPTO.has(sym) ? saCrypto : saPlan;
    const instr = planSrc?.instruments?.[sym] || planSrc?.instruments?.[sym.replace('USDT', '')] || null;
    const plan = buildSymbolPlan(sym, {
      feed: entry.feed?.raw, trendcl: entry.trendcl?.raw, regime: entry.regime?.raw,
      plan: instr, news: news?.events || [], now: nowMs, feedAt: entry.feed?.receivedAt, weights: weights?.active || null
    });
    plan.nowMs = nowMs;
    // un plan del dia anterior no arrastra estado: las zonas se reinician cada dia de Chicago
    const prevSym = prev && chicagoDate(Date.parse(prev.builtAt)) === day ? prev.symbols?.[sym] : null;
    const gone = trackZones(prevSym, plan, entry.feed?.raw);
    delete plan.nowMs;
    if (instr) plan.saPlan = { biasDay: instr.biasDay || null, biasSession: instr.biasSession || null, conviction: instr.conviction || null, session: planSrc.session || null, date: planSrc.date || null };
    out.symbols[sym] = plan;
    gone.forEach((z) => finished.push({ sym, ...z }));
    plan.zones.filter((z) => z.status !== 'nueva' && z.status !== 'activa').forEach((z) => finished.push({ sym, ...z }));
  }

  // estado en vivo del grafico: entra al plan guardado, asi la siguiente corrida lo arrastra y el registro del dia lo ve
  try { mergeTv(out, await loadTv(INTRADAY_SYMS, nowMs)); } catch (e) { /* sin eventos del grafico */ }
  // las zonas que el grafico adelanto entran al registro con su estado nuevo (el log va por id: el ultimo gana)
  for (const sym of INTRADAY_SYMS) (out.symbols[sym]?.zones || []).filter((z) => z.live).forEach((z) => finished.push({ sym, ...z }));

  if (!write) return { ok: true, plan: out };

  // graficos que dejaron de mandar su senal de vida con el mercado abierto: un push por caida
  try {
    const hbRaw = (await store.get('hb', { type: 'json' })) || {};
    const r = await notifyTvDead(healthFrom(hbRaw, nowMs, IND_VERSION), hbRaw);
    if (r.dead?.length) { for (const s of r.dead) hbRaw[s].deadNotified = nowMs; await store.setJSON('hb', hbRaw); }
  } catch (e) { /* los avisos son secundarios */ }

  await store.setJSON('latest', out);
  // registro del dia: la ultima version de cada zona que se toco, por id
  try {
    const key = 'log:' + day;
    const log = (await store.get(key, { type: 'json' })) || {};
    for (const z of finished) log[z.sym + '|' + z.id] = { sym: z.sym, id: z.id, side: z.side, lo: z.lo, hi: z.hi, stop: z.stop, tp1: z.tp1, grade: z.grade, status: z.status, createdAt: z.createdAt, touchedAt: z.touchedAt };
    await store.setJSON(key, log);
  } catch (e) { /* el log es secundario */ }

  let bus = null;
  const token = process.env.SA_BUS_TOKEN;
  if (token) {
    try {
      // solo commitea si cambio algo que importa (no el builtAt): menos ruido en el bus
      const body = JSON.stringify(out, null, 2) + '\n';
      const cur = await busGet('live/intraday.json', { token }).catch(() => undefined);
      const strip = (s) => { try { const j = JSON.parse(s); delete j.builtAt; for (const k in j.symbols || {}) delete j.symbols[k].feedAgeMin; return JSON.stringify(j); } catch (e) { return null; } };
      if (cur && cur.content && strip(cur.content) === strip(body)) bus = { unchanged: true };
      else bus = await busPut('live/intraday.json', body, `sa-bus: intraday plan ${out.builtAt}`, { token, known: cur });
    } catch (e) { bus = { error: String(e.message || e) }; }
  }
  return { ok: true, builtAt: out.builtAt, bus, plan: out };
}

export default async (req) => {
  const url = new URL(req.url);
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  try {
    const store = getStore('intraday');
    const log = url.searchParams.get('log');
    if (log && /^\d{4}-\d{2}-\d{2}$/.test(log)) {
      const j = (await store.get('log:' + log, { type: 'json' })) || {};
      return new Response(JSON.stringify({ date: log, zones: Object.values(j) }), { headers });
    }
    if (url.searchParams.get('tv') === '1') {
      const [j, news, weights] = await Promise.all([store.get('latest', { type: 'json' }).catch(() => null), readJson(newsHandler), loadWeights().catch(() => null)]);
      return new Response(buildTvSync(j || {}, news?.events || [], Date.now(), weights) + '\n', { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (url.searchParams.get('fresh') === '1') {
      const r = await runIntraday({ write: false });
      return new Response(JSON.stringify(r.plan || r), { headers });
    }
    const j = (await store.get('latest', { type: 'json' })) || {};
    // estado en vivo del grafico (indicador Mi Mesa · Zonas): si va mas adelantado que la corrida de 15 min, gana
    try { if (j.symbols) mergeTv(j, await loadTv(Object.keys(j.symbols))); } catch (e) { /* sin eventos del grafico */ }
    // estado de cada grafico de TradingView (senal de vida del indicador) y la version vigente
    try { j.tvHealth = healthFrom((await store.get('hb', { type: 'json' })) || {}, Date.now(), IND_VERSION); j.indVersion = IND_VERSION; } catch (e) { /* opcional */ }
    return new Response(JSON.stringify(j), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers });
  }
};
