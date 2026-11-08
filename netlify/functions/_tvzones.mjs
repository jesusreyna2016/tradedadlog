// Eventos en vivo del indicador "Mi Mesa · Zonas en vivo" de TradingView (tdl-indicators/mi_mesa_zonas.pine).
//
// El indicador recalcula las zonas en cada vela; cuando una zona cambia de estado manda por webhook
// (a /api/ind-ingest, con la misma clave que TDL Feed) una linea por evento:
//   MMZ1|src=mmzonas|sym=ETHUSDT|t=<ms>|ev=tocada|id=long:2223.00|side=long|lo=..|hi=..|grade=B|entry=..|stop=..|tp1=..|size=..|conf=..
// ev: nueva (solo A+), tocada, armada (gatillo: vela de 5 min cerro de vuelta), funciono, invalidada.
//
// Se guardan por simbolo y dia de Chicago en Blobs (store 'intraday', key 'tv:<SYM>:<YYYY-MM-DD>') y
// /api/intraday-plan los mezcla con el plan del servidor, asi Mi Mesa ve el estado del grafico al momento
// en vez de esperar la corrida de 15 min. Todo puro salvo load/record.
import { getStore } from '@netlify/blobs';

export const RANK = { nueva: 0, activa: 1, tocada: 2, armada: 3, funciono: 4, invalidada: 4 };
const chicagoDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const num = (v) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : null; };

// Contexto de la zona que manda el indicador (v3.4+). Solo numeros y etiquetas cortas.
const FEAT_NUM = ['score', 'scoreS', 'rr', 'dist', 'chop', 'str', 'mfe', 'mae', 'risk', 'tp2'];
const FEAT_TXT = ['gradeS', 'wv', 'wsv', 'al', 'reg', 'sess', 'keys', 'tf', 'bias'];
function pickFeatures(kv) {
  const f = {};
  for (const k of FEAT_NUM) { const x = num(kv[k]); if (x !== null) f[k] = x; }
  for (const k of FEAT_TXT) if (kv[k] != null && kv[k] !== '') f[k] = String(kv[k]).slice(0, 200);
  return f;
}

// Todas las lineas MMZ1| de un cuerpo de alerta (el mensaje puede traer texto para el telefono antes).
export function parseMmz(body) {
  const out = [];
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('MMZ1|')) continue;
    const kv = {};
    for (const part of line.split('|').slice(1)) {
      const i = part.indexOf('=');
      if (i > 0) kv[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    if (!kv.sym || !kv.ev || RANK[kv.ev] === undefined) continue;
    out.push({
      sym: kv.sym.toUpperCase(), ev: kv.ev, id: kv.id || '', side: kv.side === 'short' ? 'short' : 'long',
      lo: num(kv.lo), hi: num(kv.hi), grade: kv.grade || '', entry: num(kv.entry), stop: num(kv.stop), tp1: num(kv.tp1),
      size: kv.size || '', conf: kv.conf || '', t: Number(kv.t) || Date.now(),
      // contexto para el agente de aprendizaje (ver _zonelearn.mjs); campos opcionales
      f: pickFeatures(kv)
    });
  }
  return out;
}

// Une un evento al registro del dia: una entrada por zona, guarda el estado mas avanzado.
export function applyEvent(log, e) {
  const cur = log[e.id || e.side + ':' + e.lo];
  const key = e.id || e.side + ':' + e.lo;
  if (cur && (RANK[cur.status] > RANK[e.ev] || (RANK[cur.status] === RANK[e.ev] && cur.t >= e.t))) return false;
  log[key] = { ...cur, ...e, status: e.ev, ...(e.ev === 'armada' ? { armedAt: e.t } : {}), ...(e.ev === 'tocada' ? { touchedAt: e.t } : {}) };
  delete log[key].ev;
  return true;
}

export async function recordTvEvents(events) {
  const store = getStore('intraday');
  const bySym = {};
  for (const e of events) (bySym[e.sym + ':' + chicagoDay(e.t)] ||= []).push(e);
  const changed = [];
  for (const [k, list] of Object.entries(bySym)) {
    const key = 'tv:' + k;
    let log = {};
    try { log = (await store.get(key, { type: 'json' })) || {}; } catch (e) { log = {}; }
    let dirty = false;
    for (const e of list) if (applyEvent(log, e)) { dirty = true; changed.push(e); }
    if (dirty) await store.setJSON(key, log);
  }
  return changed;
}

export async function loadTv(syms, nowMs = Date.now()) {
  const store = getStore('intraday');
  const day = chicagoDay(nowMs);
  const out = {};
  await Promise.all(syms.map(async (s) => {
    try { out[s] = Object.values((await store.get('tv:' + s + ':' + day, { type: 'json' })) || {}); } catch (e) { out[s] = []; }
  }));
  return out;
}

// Mezcla: a cada zona del plan del servidor le pone el estado del grafico si es mas avanzado.
// Empareja por lado y rango que se cruza (los ids pueden diferir por redondeo).
export function mergeTv(plan, tvBySym) {
  if (!plan || !plan.symbols) return plan;
  for (const [sym, p] of Object.entries(plan.symbols)) {
    const evs = tvBySym?.[sym] || [];
    if (!evs.length || !p.zones) continue;
    for (const z of p.zones) {
      const hits = evs.filter((e) => e.side === z.side && e.lo != null && e.hi != null && e.lo <= z.hi && z.lo <= e.hi);
      if (!hits.length) continue;
      const best = hits.sort((a, b) => RANK[b.status] - RANK[a.status] || b.t - a.t)[0];
      if (RANK[best.status] > (RANK[z.status] ?? 0)) {
        z.status = best.status;
        z.live = { src: 'tradingview', status: best.status, at: new Date(best.t).toISOString(), entry: best.entry, size: best.size || null };
        if (best.touchedAt && !z.touchedAt) z.touchedAt = new Date(best.touchedAt).toISOString();
        if (best.armedAt) z.armedAt = new Date(best.armedAt).toISOString();
      }
    }
  }
  return plan;
}
