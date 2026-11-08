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
  for (const raw of list || []) { const t = cleanTrade(raw); if (t) { cur[t.id] = t; n2++; } }
  const keys = Object.keys(cur);
  if (keys.length > 3000) keys.sort((a, b) => (cur[a].topen || 0) - (cur[b].topen || 0)).slice(0, keys.length - 3000).forEach((k) => delete cur[k]);
  await s.setJSON('trades', cur);
  return { saved: n2, total: Object.keys(cur).length };
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
