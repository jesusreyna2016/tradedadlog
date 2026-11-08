// Agente de aprendizaje de zonas: datos crudos y pesos.
//
//  - Eventos: cada linea MMZ1 que manda el indicador (con su contexto: puntaje, puntaje con los pesos en
//    prueba, a favor/contra, regimen, chop, sesion, R, confluencias; y al resolverse MFE/MAE en R) se guarda
//    en Blobs (store 'zonelearn', key 'ev:<dia>:<SYM>'). zones-bus-cron los copia a
//    session-analyst-bus/zones/events/<dia>.jsonl, donde el agente los analiza.
//  - Trades: Mi Mesa manda un resumen SIN dinero de tus trades (lado, hora, precio de entrada, R, zona del
//    plan) a /api/zone-trades; se guarda en 'zonelearn'/'trades' y el cron lo copia a zones/trades.json.
//  - Pesos: los vigentes viven en session-analyst-bus/zones/weights.json ({version, active, shadow, ...}).
//    loadWeights() los lee (cache de 10 min) para el motor y la linea de sync.
import { getStore } from '@netlify/blobs';
import { busGet } from './_sa-bus.mjs';

const store = () => getStore('zonelearn');
const chicagoDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));

export async function appendZoneEvents(events) {
  const groups = {};
  for (const e of events || []) (groups[chicagoDay(e.t) + ':' + e.sym] ||= []).push(e);
  const s = store();
  let n = 0;
  for (const [k, list] of Object.entries(groups)) {
    const key = 'ev:' + k;
    let log = {};
    try { log = (await s.get(key, { type: 'json' })) || {}; } catch (e) { log = {}; }
    for (const e of list) {
      const id = e.sym + '|' + e.id + '|' + e.ev;
      if (log[id] && log[id].t >= e.t) continue; // la alerta se reintento
      log[id] = { ...e, receivedAt: new Date().toISOString() };
      n++;
    }
    await s.setJSON(key, log);
  }
  return n;
}

export async function eventsFor(day) {
  const s = store();
  const out = [];
  try {
    const { blobs } = await s.list({ prefix: 'ev:' + day + ':' });
    for (const b of blobs) {
      const log = await s.get(b.key, { type: 'json' }).catch(() => null);
      if (log) out.push(...Object.values(log));
    }
  } catch (e) { /* sin eventos */ }
  return out;
}

// Trades de Mi Mesa: whitelist estricta, nunca dinero (ni pnl, ni comision, ni riesgo en $, ni cuenta).
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 40) => (typeof v === 'string' && v ? v.slice(0, max) : null);
export function cleanTrade(t) {
  if (!t || typeof t !== 'object' || !str(t.id, 80)) return null;
  const side = t.side === 'short' ? 'short' : t.side === 'long' ? 'long' : null;
  if (!side || !n(t.topen)) return null;
  return {
    id: str(t.id, 80), day: str(t.day, 10), fam: str(t.fam, 12), side, topen: n(t.topen), tclose: n(t.tclose),
    entry: n(t.entry), exit: n(t.exit), R: n(t.R), session: str(t.session, 12),
    hasPlan: t.hasPlan === true, zoneId: str(t.zoneId, 40), zoneLo: n(t.zoneLo), zoneHi: n(t.zoneHi), zoneGrade: str(t.zoneGrade, 3),
    zoneManual: t.zoneManual === true, plannedR: n(t.plannedR), planStop: n(t.planStop), planTarget: n(t.planTarget),
    setup: str(t.setup, 40), againstBias: t.againstBias === true, followed: typeof t.followed === 'boolean' ? t.followed : null,
    emotion: str(t.emotion, 20)
  };
}
export async function saveTrades(list) {
  const s = store();
  let cur = {};
  try { cur = (await s.get('trades', { type: 'json' })) || {}; } catch (e) { cur = {}; }
  let n2 = 0;
  const clean = (list || []).map(cleanTrade).filter(Boolean);
  // cruce automatico con las zonas del dia (sin que tengas que llenar la ficha)
  let matches = {};
  try { matches = await autoMatch(clean); } catch (e) { matches = {}; }
  for (const t of clean) { if (matches[t.id]) t.auto = matches[t.id]; else if (cur[t.id]?.auto) t.auto = cur[t.id].auto; cur[t.id] = t; n2++; }
  const keys = Object.keys(cur);
  if (keys.length > 3000) keys.sort((a, b) => (cur[a].topen || 0) - (cur[b].topen || 0)).slice(0, keys.length - 3000).forEach((k) => delete cur[k]);
  await s.setJSON('trades', cur);
  const all = {};
  for (const t of Object.values(cur)) if (t.auto) all[t.id] = t.auto;
  return { saved: n2, total: Object.keys(cur).length, matches: all };
}
export async function loadTrades() {
  try { return Object.values((await store().get('trades', { type: 'json' })) || {}); } catch (e) { return []; }
}

// Pesos vigentes del motor (cache 10 min). Si el bus no responde, null = los de siempre.
export async function loadWeights() {
  const s = store();
  try {
    const c = await s.get('weights-cache', { type: 'json' });
    if (c && Date.now() - c.at < 10 * 60e3) return c.data;
  } catch (e) { /* sin cache */ }
  let data = null;
  try {
    const f = await busGet('zones/weights.json');
    if (f && f.content) data = JSON.parse(f.content);
  } catch (e) { data = null; }
  try { await s.setJSON('weights-cache', { at: Date.now(), data }); } catch (e) { /* no importa */ }
  return data;
}

// ---------------- Cruce automatico trade <-> zona ----------------
// Cada trade se liga a la zona del mismo dia, simbolo y lado cuyo rango (con medio ancho de colchon) contiene tu
// precio de entrada y que ya existia cuando entraste (con 10 min de tolerancia, el toque se marca al cierre de la
// vela). Fuentes: el estado en vivo del indicador (store 'intraday', 'tv:<SYM>:<dia>') y el registro del plan del
// servidor ('log:<dia>'). Gana la del indicador, luego la de mejor calificacion. Puro salvo autoMatch.
const FAM_SYM = { NQ: 'NQ', MNQ: 'NQ', ES: 'ES', MES: 'ES', GC: 'GC', MGC: 'GC', ETH: 'ETHUSDT', BTC: 'BTCUSDT', ETHUSDT: 'ETHUSDT', BTCUSDT: 'BTCUSDT' };
const GR = { 'A+': 3, A: 2, B: 1 };
const ms = (v) => (typeof v === 'number' ? v : v ? Date.parse(v) : null);

export function matchTrade(t, zones) {
  if (t.entry == null || !t.topen) return null;
  const hits = (zones || []).filter((z) => {
    if (z.side !== t.side || z.lo == null || z.hi == null) return false;
    const pad = (z.hi - z.lo) * 0.5;
    if (t.entry < z.lo - pad || t.entry > z.hi + pad) return false;
    const born = Math.min(...[z.createdAt, z.touchedAt, z.armedAt, z.t].map(ms).filter((x) => Number.isFinite(x)));
    return !Number.isFinite(born) || born <= t.topen + 10 * 60e3;
  });
  if (!hits.length) return null;
  hits.sort((a, b) => (b.src === 'tv') - (a.src === 'tv') || (GR[b.grade] || 0) - (GR[a.grade] || 0));
  const z = hits[0];
  const armedAt = ms(z.armedAt);
  return {
    zoneId: z.id, grade: z.grade || null, lo: z.lo, hi: z.hi, status: z.status || null, src: z.src,
    inside: t.entry >= z.lo && t.entry <= z.hi, armedAt: armedAt || null, touchedAt: ms(z.touchedAt) || null,
    // entraste antes de que la vela de 5 min confirmara (gatillo); null = la zona nunca se armo
    beforeTrigger: armedAt ? t.topen < armedAt : null, armed: !!armedAt
  };
}

export async function autoMatch(trades, nowMs = Date.now()) {
  const since = nowMs - 21 * 86400e3;
  const need = new Map();
  for (const t of trades) {
    const sym = FAM_SYM[String(t.fam || '').toUpperCase()];
    if (!sym || !t.day || !t.topen || t.topen < since) continue;
    const k = t.day + '|' + sym;
    if (!need.has(k)) need.set(k, []);
    need.get(k).push(t);
  }
  const intr = getStore('intraday');
  const logs = {};
  const keys = [...need.keys()].slice(0, 60);
  await Promise.all(keys.map(async (k) => {
    const [day, sym] = k.split('|');
    const zs = [];
    try { Object.values((await intr.get('tv:' + sym + ':' + day, { type: 'json' })) || {}).forEach((z) => zs.push({ ...z, src: 'tv' })); } catch (e) { /* sin eventos */ }
    try {
      if (!logs[day]) logs[day] = (await intr.get('log:' + day, { type: 'json' })) || {};
      Object.values(logs[day]).filter((z) => z.sym === sym).forEach((z) => zs.push({ ...z, src: 'plan' }));
    } catch (e) { /* sin log */ }
    for (const t of need.get(k)) { const m = matchTrade(t, zs); if (m) t._m = m; }
  }));
  const out = {};
  for (const t of trades) if (t._m) { out[t.id] = t._m; delete t._m; }
  return out;
}
