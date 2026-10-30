// Contexto macro para el Session Analyst: lo que el grafico de cada simbolo no muestra.
//   intermarket -> dolar (DXY), bonos (10Y y futuro ZN), VIX y su curva (9D/3M), BTC como
//                  termometro de riesgo. Cambio del dia, ruptura del rango de ayer, tendencia 5d.
//   reactions   -> como reacciono el mercado a cada dato USD de alto impacto de las ultimas
//                  24 h (NQ/ES/GC/ZN a +15 y +60 min). ForexFactory no trae el "actual",
//                  y la lectura del mercado es lo que importa para operar.
//   cot         -> posicionamiento semanal de los especuladores (CFTC legacy, no comerciales):
//                  neto, cambio semanal y percentil de 3 anos.
//   flows       -> calendario de flujos: OpEx mensual / triple witching, vencimiento VIX,
//                  fin de mes y de trimestre.
//   crypto      -> contexto de ETH/BTC para la rutina crypto-weekend: funding, OI, long/short
//                  (OKX), DVOL (Deribit), gap del CME, ETH/BTC, Fear & Greed.
// Fuentes publicas sin clave (Yahoo chart API, CFTC Socrata, OKX, Deribit, alternative.me).
// Cache en Netlify Blobs.
import { getStore } from '@netlify/blobs';
import newsHandler from './cc-news.mjs';

const IM_TTL = 10 * 60 * 1000;
const COT_TTL = 12 * 3600 * 1000;
const UA = { 'user-agent': 'Mozilla/5.0 (TradeDadLog Command Center)', accept: 'application/json' };

const IM = { DXY: 'DX-Y.NYB', US10Y: '^TNX', ZN: 'ZN=F', VIX: '^VIX', VIX9D: '^VIX9D', VIX3M: '^VIX3M', BTC: 'BTC-USD' };
const REACT = { NQ: 'NQ=F', ES: 'ES=F', GC: 'GC=F', ZN: 'ZN=F' };
const COT_CODES = { NQ: '209742', ES: '13874A', YM: '124603', GC: '088691', CL: '067651' };

const r2 = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

async function chart(sym, interval, range){
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=' + interval + '&range=' + range;
  const r = await fetch(u, { headers: UA });
  if(!r.ok) throw new Error('yahoo ' + sym + ' ' + r.status);
  const res = (await r.json())?.chart?.result?.[0];
  if(!res || !res.timestamp) throw new Error('yahoo ' + sym + ' empty');
  const q = res.indicators.quote[0];
  const bars = res.timestamp.map((t, i) => ({ t: t * 1000, h: q.high[i], l: q.low[i], c: q.close[i] })).filter((b) => b.c != null);
  return { meta: res.meta, bars };
}

async function intermarket(){
  const out = {};
  await Promise.all(Object.entries(IM).map(async ([k, sym]) => {
    try {
      const { meta, bars } = await chart(sym, '1d', '10d');
      const last = meta.regularMarketPrice ?? bars[bars.length - 1].c;
      // la ultima barra diaria es la de hoy si el mercado ya abrio; ayer es la anterior
      const today = new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);
      const done = bars.filter((b) => new Date(b.t).toISOString().slice(0, 10) < today);
      const prev = done[done.length - 1];
      const wk = done[done.length - 5];
      out[k] = {
        last: r2(last, 3),
        chgPct: prev ? r2((last / prev.c - 1) * 100) : null,
        prevHigh: prev ? r2(prev.h, 3) : null,
        prevLow: prev ? r2(prev.l, 3) : null,
        brokePrevHigh: prev ? last > prev.h : null,
        brokePrevLow: prev ? last < prev.l : null,
        chg5dPct: wk ? r2((last / wk.c - 1) * 100) : null,
        asOf: new Date(meta.regularMarketTime * 1000).toISOString()
      };
    } catch(e){ out[k] = { error: String(e.message || e) }; }
  }));
  // curva del VIX: 9D > VIX = miedo de corto plazo; VIX > 3M (backwardation) = estres real
  const v = out.VIX?.last, v9 = out.VIX9D?.last, v3 = out.VIX3M?.last;
  out.vixCurve = (v && v3) ? {
    vix9dOverVix: v9 ? r2(v9 / v, 3) : null,
    vixOverVix3m: r2(v / v3, 3),
    state: v / v3 >= 1 ? 'backwardation' : (v9 && v9 / v > 1.05 ? 'short-term-stress' : 'contango')
  } : null;
  return out;
}

async function reactions(){
  const news = await (await newsHandler()).json().catch(() => null);
  const now = Date.now();
  const evs = ((news && news.events) || []).filter((e) => e.impact === 'high' && e.currency === 'USD' && e.ts <= now - 15 * 60e3 && e.ts >= now - 24 * 3600e3);
  if(!evs.length) return [];
  const series = {};
  await Promise.all(Object.entries(REACT).map(async ([k, sym]) => {
    try { series[k] = (await chart(sym, '5m', '2d')).bars; } catch(e){ series[k] = null; }
  }));
  // un titular que cite el dato con "mejor/peor de lo esperado" da el signo de la sorpresa
  const heads = (news.headlines || []);
  const SURPRISE = /(better|worse|hotter|cooler|softer|stronger|weaker)[- ]than[- ]expected|\b(beat|beats|miss|misses|tops|surges?|plunges?|jumps?|slows?|accelerates?)\b/i;
  return evs.map((e) => {
    const out = { title: e.title, ts: e.ts, forecast: e.forecast, previous: e.previous, moves: {} };
    for(const [k, bars] of Object.entries(series)){
      if(!bars) continue;
      const before = [...bars].reverse().find((b) => b.t < e.ts);
      const at = (m) => [...bars].reverse().find((b) => b.t <= e.ts + m * 60e3);
      const a15 = at(15), a60 = now >= e.ts + 60 * 60e3 ? at(60) : null;
      if(!before || !a15) continue;
      out.moves[k] = {
        pct15: r2((a15.c / before.c - 1) * 100, 3),
        pct60: a60 ? r2((a60.c / before.c - 1) * 100, 3) : null
      };
    }
    // solo palabras que identifican el dato (gdp, pce, payrolls...), no genericas como "price"
    const GENERIC = /^(price|prices|index|change|rate|core|sales|final|flash|advance|prelim|month|level|data|report|employment|claims|annual|weekly)$/;
    const key = e.title.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !GENERIC.test(w));
    const h = heads.find((x) => x.ts >= e.ts - 30 * 60e3 && x.ts <= e.ts + 6 * 3600e3 && SURPRISE.test(x.title) &&
      key.some((w) => new RegExp('\\b' + w + '\\b', 'i').test(x.title)));
    if(h) out.headline = { title: h.title, source: h.source };
    return out;
  });
}

async function cot(){
  const codes = Object.values(COT_CODES).map((c) => "'" + c + "'").join(',');
  const u = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=' + encodeURIComponent('cftc_contract_market_code in(' + codes + ')') +
    '&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=1000&$select=report_date_as_yyyy_mm_dd,cftc_contract_market_code,noncomm_positions_long_all,noncomm_positions_short_all,open_interest_all';
  const r = await fetch(u, { headers: UA });
  if(!r.ok) throw new Error('cftc ' + r.status);
  const rows = await r.json();
  const out = {};
  for(const [sym, code] of Object.entries(COT_CODES)){
    const s = rows.filter((x) => x.cftc_contract_market_code === code).slice(0, 156)
      .map((x) => ({ date: x.report_date_as_yyyy_mm_dd.slice(0, 10), net: +x.noncomm_positions_long_all - +x.noncomm_positions_short_all, oi: +x.open_interest_all }));
    if(!s.length) continue;
    const cur = s[0], prev = s[1];
    const pct = Math.round(s.filter((x) => x.net <= cur.net).length / s.length * 100);
    out[sym] = {
      date: cur.date,
      net: cur.net,
      netPctOi: r2(cur.net / cur.oi * 100, 1),
      chgWeek: prev ? cur.net - prev.net : null,
      pct3y: pct,
      // extremos de posicionamiento: el especulador lleno de un lado es combustible de giro
      extreme: pct >= 90 ? 'crowded-long' : pct <= 10 ? 'crowded-short' : null
    };
  }
  return out;
}

// --- cripto (ETH es lo que Jesus opera el fin de semana) ---
//   derivatives -> OKX perps: funding actual, open interest y su cambio 24 h, ratio de cuentas long/short
//   dvol        -> Deribit DVOL (volatilidad implicita de ETH a 30 d) y su cambio 24 h
//   cmeGap      -> cierre del futuro CME de ETH del viernes vs spot: el gap del fin de semana es iman
//   ethBtc      -> fuerza relativa ETH contra BTC
//   fearGreed   -> sentimiento (alternative.me), hoy vs ayer
async function getJson(u){
  const r = await fetch(u, { headers: UA });
  if(!r.ok) throw new Error(new URL(u).hostname + ' ' + r.status);
  return r.json();
}

async function okxDeriv(ccy){
  const inst = ccy + '-USDT-SWAP';
  const [fr, oi, oiHist, lsr] = await Promise.all([
    getJson('https://www.okx.com/api/v5/public/funding-rate?instId=' + inst),
    getJson('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=' + inst),
    getJson('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=' + ccy + '&period=1H').catch(() => null),
    getJson('https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=' + ccy + '&period=1H').catch(() => null)
  ]);
  const f = fr?.data?.[0], o = oi?.data?.[0];
  // open-interest-volume: [ts, oiUsd, volUsd], el mas reciente primero
  const h = oiHist?.data || [];
  const oi24 = h[24] ? +h[24][1] : null, oiNow = h[0] ? +h[0][1] : (o ? +o.oiUsd : null);
  const l = lsr?.data || [];
  const fundPct = f ? +f.fundingRate * 100 : null;
  return {
    fundingPct: r2(fundPct, 4),
    // funding por 8 h: >= 0.03 % = largos pagando caro (apalancados de un lado), <= -0.01 % = cortos pagando
    fundingState: fundPct == null ? null : fundPct >= 0.03 ? 'longs-crowded' : fundPct <= -0.01 ? 'shorts-crowded' : 'neutral',
    oiUsd: oiNow ? Math.round(oiNow) : null,
    oiChg24hPct: oiNow && oi24 ? r2((oiNow / oi24 - 1) * 100) : null,
    longShortAccounts: l[0] ? +l[0][1] : null,
    longShortChg24h: l[0] && l[24] ? r2(+l[0][1] - +l[24][1]) : null
  };
}

async function cryptoBlock(){
  const out = {};
  const now = Date.now();
  await Promise.all([
    okxDeriv('ETH').then((d) => { out.ethDeriv = d; }, (e) => { out.ethDeriv = { error: String(e.message || e) }; }),
    okxDeriv('BTC').then((d) => { out.btcDeriv = d; }, (e) => { out.btcDeriv = { error: String(e.message || e) }; }),
    getJson('https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=ETH&resolution=3600&start_timestamp=' + (now - 26 * 3600e3) + '&end_timestamp=' + now)
      .then((j) => {
        const d = j?.result?.data || [];
        const last = d[d.length - 1]?.[4], ago = d.find((x) => x[0] >= now - 24 * 3600e3)?.[4];
        out.dvol = { last: r2(last), chg24h: last && ago ? r2(last - ago) : null };
      }, (e) => { out.dvol = { error: String(e.message || e) }; }),
    chart('ETH=F', '1d', '10d').then(({ bars }) => {
      // ultimo cierre diario CME completo antes de hoy; en fin de semana = el del viernes
      const today = new Date(now).toISOString().slice(0, 10);
      const done = bars.filter((b) => new Date(b.t).toISOString().slice(0, 10) < today);
      const b = done[done.length - 1];
      out.cmeGap = b ? { cmeClose: r2(b.c), cmeCloseDate: new Date(b.t).toISOString().slice(0, 10) } : null;
    }, (e) => { out.cmeGap = { error: String(e.message || e) }; }),
    Promise.all([chart('ETH-USD', '1d', '10d'), chart('ETH-BTC', '1d', '10d')]).then(([eth, eb]) => {
      const spot = eth.meta.regularMarketPrice;
      out.ethSpot = r2(spot);
      const ebNow = eb.meta.regularMarketPrice, eb1 = eb.bars[eb.bars.length - 2]?.c, eb7 = eb.bars[eb.bars.length - 8]?.c;
      out.ethBtc = { last: r2(ebNow, 5), chg24hPct: eb1 ? r2((ebNow / eb1 - 1) * 100) : null, chg7dPct: eb7 ? r2((ebNow / eb7 - 1) * 100) : null };
    }, (e) => { out.ethBtc = { error: String(e.message || e) }; }),
    getJson('https://api.alternative.me/fng/?limit=2').then((j) => {
      const d = j?.data || [];
      out.fearGreed = d[0] ? { value: +d[0].value, label: d[0].value_classification, prev: d[1] ? +d[1].value : null } : null;
    }, (e) => { out.fearGreed = { error: String(e.message || e) }; })
  ]);
  if(out.cmeGap && out.cmeGap.cmeClose && out.ethSpot){
    out.cmeGap.gapPct = r2((out.ethSpot / out.cmeGap.cmeClose - 1) * 100);
  }
  return out;
}

// --- calendario de flujos (calculado, sin fuente externa) ---
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'
]);
const ymd = (d) => d.toISOString().slice(0, 10);
const isBiz = (d) => d.getUTCDay() % 6 !== 0 && !HOLIDAYS.has(ymd(d));
function thirdFriday(y, m){
  const d = new Date(Date.UTC(y, m, 1));
  const first = (5 - d.getUTCDay() + 7) % 7 + 1;
  let f = new Date(Date.UTC(y, m, first + 14));
  while(!isBiz(f)) f = new Date(f.getTime() - 86400e3);   // feriado -> jueves
  return f;
}
function lastBizDay(y, m){
  let d = new Date(Date.UTC(y, m + 1, 0));
  while(!isBiz(d)) d = new Date(d.getTime() - 86400e3);
  return d;
}
function flows(){
  const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()) + 'T00:00:00Z');
  const days = (d) => Math.round((d - today) / 86400e3);
  const ev = [];
  for(let k = 0; k < 3; k++){
    const y = today.getUTCFullYear() + Math.floor((today.getUTCMonth() + k) / 12), m = (today.getUTCMonth() + k) % 12;
    const opex = thirdFriday(y, m);
    ev.push({ type: m % 3 === 2 ? 'triple-witching' : 'opex', date: ymd(opex) });
    // VIX vence el miercoles 30 dias antes del 3er viernes del mes siguiente
    const nf = thirdFriday(y + (m === 11 ? 1 : 0), (m + 1) % 12);
    ev.push({ type: 'vix-expiry', date: ymd(new Date(nf.getTime() - 30 * 86400e3)) });
    const me = lastBizDay(y, m);
    ev.push({ type: m % 3 === 2 ? 'quarter-end' : 'month-end', date: ymd(me) });
  }
  return ev.map((e) => ({ ...e, inDays: days(new Date(e.date + 'T00:00:00Z')) }))
    .filter((e) => e.inDays >= 0 && e.inDays <= 35)
    .sort((a, b) => a.inDays - b.inDays);
}

async function cached(store, key, ttl, fn){
  let prev = null;
  if(store){
    try { prev = await store.get(key, { type: 'json' }); } catch(e){ prev = null; }
    if(prev && prev.at && Date.now() - prev.at < ttl) return prev.data;
  }
  try {
    const data = await fn();
    if(store){ try { await store.setJSON(key, { at: Date.now(), data }); } catch(e){} }
    return data;
  } catch(e){
    return prev ? { ...prev.data, stale: true } : { error: String(e.message || e) };
  }
}

export default async () => {
  let store = null;
  try { store = getStore('cc'); } catch(e){ store = null; }
  const [im, react, cotData, cryptoData] = await Promise.all([
    cached(store, 'macro:im', IM_TTL, intermarket),
    cached(store, 'macro:react', IM_TTL, async () => ({ list: await reactions() })),
    cached(store, 'macro:cot', COT_TTL, cot),
    cached(store, 'macro:crypto', IM_TTL, cryptoBlock)
  ]);
  const payload = {
    generatedAt: new Date().toISOString(),
    intermarket: im,
    reactions: (react && react.list) || [],
    cot: cotData,
    crypto: cryptoData,
    flows: flows()
  };
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  });
};
