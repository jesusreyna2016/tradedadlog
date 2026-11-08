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
const FEAT_TXT = ['v', 'gradeS', 'wv', 'wsv', 'al', 'reg', 'sess', 'keys', 'tf', 'bias'];
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
    for (const e of list) {
      const prevStatus = log[e.id || e.side + ':' + e.lo]?.status || null;
      if (applyEvent(log, e)) { dirty = true; changed.push({ ...e, prevStatus }); }
    }
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

// ---------------- Senal de vida del indicador (v3.5+) ----------------
// Con webhook, cada grafico manda cada 15 min: MMZ1|src=mmzonas|v=3.5|sym=ETHUSDT|t=<ms>|ev=hb|tf=5|px=..|wv=v1|sync=<ms>
// Se guarda el ultimo por simbolo (store 'intraday', key 'hb'); Mi Mesa muestra si cada grafico esta vivo y
// intraday-cron avisa por push si uno deja de reportar con el mercado abierto.
export function parseHb(body) {
  const out = [];
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('MMZ1|') || !/\|ev=hb(\||$)/.test(line)) continue;
    const kv = {};
    for (const part of line.split('|').slice(1)) { const i = part.indexOf('='); if (i > 0) kv[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    if (!kv.sym) continue;
    out.push({ sym: kv.sym.toUpperCase(), v: String(kv.v || '').slice(0, 10), tf: String(kv.tf || '').slice(0, 6), px: num(kv.px), wv: String(kv.wv || '').slice(0, 20), sync: Number(kv.sync) || null, t: Number(kv.t) || Date.now() });
  }
  return out;
}

// Cada simbolo en su propia clave (hb:<SYM>): las alertas de los 5 graficos llegan casi juntas y,
// con una sola clave compartida, una escritura borraba a la otra.
export async function recordHb(list, nowMs = Date.now()) {
  if (!list.length) return 0;
  const store = getStore('intraday');
  for (const h of list) {
    let cur = {};
    try { cur = (await store.get('hb:' + h.sym, { type: 'json' })) || {}; } catch (e) { cur = {}; }
    // si el simbolo estaba caido y vuelve, se borra el aviso enviado
    await store.setJSON('hb:' + h.sym, { ...h, at: nowMs, firstAt: cur.firstAt || nowMs, deadNotified: null });
  }
  return list.length;
}

// Todas las senales de vida: claves hb:<SYM> (y la clave vieja 'hb' de la v3.5 inicial, como respaldo).
export async function loadHbRaw(store = getStore('intraday')) {
  let out = {};
  try { out = { ...((await store.get('hb', { type: 'json' })) || {}) }; } catch (e) { out = {}; }
  try {
    const { blobs } = await store.list({ prefix: 'hb:' });
    const rows = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' }).catch(() => null)));
    blobs.forEach((b, i) => { if (rows[i]) out[b.key.slice(3)] = rows[i]; });
  } catch (e) { /* respaldo: clave vieja */ }
  return out;
}

export async function markHbDead(syms, nowMs = Date.now(), store = getStore('intraday')) {
  for (const s of syms) {
    try { const cur = await store.get('hb:' + s, { type: 'json' }); if (cur) await store.setJSON('hb:' + s, { ...cur, deadNotified: nowMs }); } catch (e) { /* siguiente */ }
  }
}

// CME (NQ, ES, GC, YM, CL): domingo 17:00 a viernes 16:00 CT, con pausa diaria 16:00-17:00 CT. Cripto: siempre.
export function marketOpen(sym, ms = Date.now()) {
  if (/USDT$|^ETH|^BTC/.test(sym)) return true;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const m = Number(p.hour) * 60 + Number(p.minute);
  const d = p.weekday;
  if (d === 'Sat') return false;
  if (d === 'Sun') return m >= 17 * 60;
  if (d === 'Fri') return m < 16 * 60;
  return m < 16 * 60 || m >= 17 * 60;
}

const versionLt = (a, b) => { const x = parseFloat(a), y = parseFloat(b); return Number.isFinite(x) && Number.isFinite(y) && x < y; };

// Estado de cada grafico: vivo / caido / mercado cerrado, y si tiene una version vieja del indicador.
export function healthFrom(hb, nowMs, latest) {
  const out = {};
  for (const [sym, h] of Object.entries(hb || {})) {
    const ageMin = Math.round((nowMs - (h.at || h.t)) / 60e3);
    // con 40 min de gracia despues de que abre el mercado (domingo 17:00, o despues de la pausa diaria)
    const open = marketOpen(sym, nowMs) && marketOpen(sym, nowMs - 40 * 60e3);
    out[sym] = {
      state: ageMin <= 35 ? 'vivo' : !open ? 'cerrado' : 'caido',
      ageMin, lastAt: new Date(h.at || h.t).toISOString(), v: h.v || null, tf: h.tf || null, wv: h.wv || null,
      outdated: !!(latest && h.v && versionLt(h.v, latest)),
      syncAgeH: h.sync ? Math.round((nowMs - h.sync) / 360e3) / 10 : null
    };
  }
  return out;
}

export async function loadHealth(nowMs = Date.now(), latest = null) {
  try { return healthFrom(await loadHbRaw(), nowMs, latest); } catch (e) { return {}; }
}
