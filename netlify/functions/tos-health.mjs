// tos-health.mjs - Watchdog del trader-os-bus.
// Lee los "latidos" del bus (heartbeats y archivos live), aplica el contrato de salud
// (trader-os-bus/method/health.md) y escribe live/health.json cada 15 min. Asi una falla
// silenciosa (un plan que no se publico, un feed caido) se ve en segundos, no tres semanas
// despues. Lo lee la pagina de salud y La Mesa.
import { ghGet, ghPut } from './_gh-bus.mjs';

export const config = { schedule: '*/15 * * * *' };

const OWNER = 'jesusreyna2016';
const REPO = 'trader-os-bus';
const BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;

// El contrato: cada pieza, quien la escribe, cada cuanto, y cuando se considera vieja/caida.
// kind: "live" (continuo en mercado abierto) · "hourly" · "daily" · "passive" (puede estar quieto).
// warnMin / badMin en minutos. Las "live"/"hourly" respetan el horario de futuros (fin de semana
// y el break 16-17 CT no cuentan como caida: salen "cerrado").
const CONTRACT = [
  { key: 'feeds',     path: 'live/feeds.json',          label: 'Datos crudos (feeds)',   writer: 'TradingView -> tos-bus-snapshot', kind: 'live',   warnMin: 45,   badMin: 150,  market: true },
  { key: 'market',    path: 'live/market.json',         label: 'Estado del mercado',     writer: 'tos-market',                      kind: 'live',   warnMin: 45,   badMin: 150,  market: true },
  { key: 'edge',      path: 'live/edge.json',           label: 'Edge medido',            writer: 'lente Edge',                      kind: 'live',   warnMin: 90,   badMin: 300,  market: true },
  { key: 'bars',      path: 'bars/__TODAY__.json',      label: 'Velas 5m del dia',       writer: 'tos-bus-bars (cada hora)',        kind: 'hourly', warnMin: 120,  badMin: 240,  market: true },
  { key: 'trader',    path: 'live/trader.json',         label: 'Estado del trader (Coach)', writer: 'tos-coach',                    kind: 'passive',warnMin: 4320, badMin: 10080, market: false },
  { key: 'plan',      path: 'live/plan-heartbeat.json', label: 'Plan de futuros (pre-asia)', writer: 'lente Contexto (17:20 CT)',   kind: 'daily',  badMin: 3000, dueH: 17.5,  dueTZ: 'CT',  market: false },
  { key: 'crypto',    path: 'live/crypto-heartbeat.json', label: 'Plan de cripto',       writer: 'lente Contexto (00:15Z)',         kind: 'daily',  badMin: 3000, dueH: 0.75,  dueTZ: 'UTC', market: false },
  { key: 'parity',    path: 'live/parity.json',         label: 'Paridad (Paso 4)',       writer: 'parity.py en pre-asia',           kind: 'daily',  badMin: 3600, dueH: 17.7,  dueTZ: 'CT',  market: false },
];

// Varios archivos guardan la hora en campos distintos; probamos los habituales.
function stampOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const f of ['_updatedAt', 'lastRun', 'builtAt', 'asOf', 'checkedAt', 'updatedAt', 'generatedAt']) {
    if (obj[f]) { const t = Date.parse(obj[f]); if (!Number.isNaN(t)) return t; }
  }
  return null;
}

// Futuros cerrados? (aprox CST = UTC-6; es noviembre). Evita falsas alarmas el fin de semana.
function futuresClosed(now) {
  const ct = new Date(now.getTime() - 6 * 3600 * 1000);
  const day = ct.getUTCDay(); // 0 dom .. 6 sab
  const h = ct.getUTCHours();
  if (day === 6) return true;                       // sabado
  if (day === 0 && h < 17) return true;             // domingo antes de 17:00 CT
  if (day === 5 && h >= 16) return true;            // viernes tras 16:00 CT
  if (day >= 1 && day <= 5 && h === 16) return true; // break diario 16-17 CT
  return false;
}

async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'tos-health' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function rank(s) { return { ok: 0, off: 0, warn: 1, bad: 2 }[s] ?? 0; }

export default async function handler() {
  const now = new Date();
  const today = new Date(now.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10); // dia CT
  const closed = futuresClosed(now);
  const items = [];
  const issues = [];

  for (const c of CONTRACT) {
    const path = c.path.replace('__TODAY__', today);
    const data = await getJSON(`${RAW}/${path}`);
    let status, ageMin = null, at = null, note = '';

    if (!data) {
      // un diario ausente puede ser normal recien arrancada la lente; un live ausente es peor
      status = (c.kind === 'live' || c.kind === 'hourly') && !closed ? 'bad' : 'warn';
      note = 'sin archivo';
    } else {
      const t = stampOf(data);
      if (t == null) { status = 'warn'; note = 'sin marca de tiempo'; }
      else {
        at = new Date(t).toISOString();
        ageMin = Math.round((now.getTime() - t) / 60000);
        if (c.kind === 'daily') {
          // una corrida diaria: lo que importa no es la edad en minutos, sino si YA corrio HOY
          // CERCA de su hora (un latido de hoy pero de mucho antes de dueH no cuenta).
          const utc = c.dueTZ === 'UTC';
          const toRef = (ms) => new Date(utc ? ms : ms - 6 * 3600 * 1000);
          const sref = toRef(t), nref = toRef(now.getTime());
          const stampDay = sref.toISOString().slice(0, 10);
          const stampH = sref.getUTCHours() + sref.getUTCMinutes() / 60;
          const nowDay = nref.toISOString().slice(0, 10);
          const nowH = nref.getUTCHours() + nref.getUTCMinutes() / 60;
          const ranToday = stampDay === nowDay && stampH >= c.dueH - 1;
          if (ranToday) { status = 'ok'; note = 'al dia'; }
          else if (nowH >= c.dueH) { status = ageMin >= c.badMin ? 'bad' : 'warn'; note = `no corrio hoy (esperado ${c.dueH}${utc ? 'Z' : 'h CT'})`; }
          else { status = 'ok'; note = 'espera la corrida de hoy'; }
        }
        else if (c.market && closed) { status = 'off'; note = 'mercado cerrado'; }
        else if (ageMin >= c.badMin) { status = 'bad'; note = 'caido'; }
        else if (ageMin >= c.warnMin) { status = 'warn'; note = 'viejo'; }
        else { status = 'ok'; note = 'al dia'; }
      }
      // el heartbeat del plan puede traer ok:false (corrida con error) aunque sea reciente
      if ((c.key === 'plan' || c.key === 'crypto') && data.ok === false && status === 'ok') {
        status = 'warn'; note = 'ultima corrida con error';
      }
    }

    items.push({ key: c.key, label: c.label, writer: c.writer, status, ageMin, at, note });
    if (status === 'bad' || status === 'warn') {
      issues.push(`${c.label}: ${note}${ageMin != null ? ` (${ageMin >= 120 ? Math.round(ageMin / 60) + 'h' : ageMin + 'm'})` : ''}`);
    }
  }

  // ---- Velas del TDL Feed para el Lab (tvbars/<dia UTC>.json) ----
  // Por simbolo: ultima vela, y si trae o/h/l (FEED1 actualizado). Futuros respetan el
  // horario de mercado; ETH y BTC (crypto) se vigilan siempre.
  try {
    const EDG = ['NQ', 'ES', 'GC', 'CL', 'ETH', 'BTC'];
    const dayUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
    const files = await Promise.all([dayUTC(now.getTime() - 864e5), dayUTC(now.getTime())]
      .map((d) => getJSON(`${RAW}/tvbars/${d}.json`)));
    const last = {};
    for (const f of files) {
      if (!f || !Array.isArray(f.fields)) continue;
      const ix = Object.fromEntries(f.fields.map((k, i) => [k, i]));
      for (const [sym, rows] of Object.entries(f.symbols || {})) {
        for (const r of rows || []) {
          if (!last[sym] || r[ix.t] > last[sym].t) last[sym] = { t: r[ix.t], ohlc: r[ix.o] != null && r[ix.h] != null && r[ix.l] != null };
        }
      }
    }
    const probs = [];
    let worst = 'ok', oldest = null;
    for (const sym of EDG) {
      const crypto = sym === 'ETH' || sym === 'BTC';
      const L = last[sym];
      let st = 'ok', why = '';
      if (!crypto && closed) { st = 'off'; }
      else if (!L) { st = 'warn'; why = 'sin velas'; }
      else {
        const age = Math.round((now.getTime() - L.t) / 60000) - 5;   // t = apertura de la vela
        oldest = Math.max(oldest ?? 0, age);
        if (age >= 120) { st = 'bad'; why = `sin velas hace ${age >= 120 ? Math.round(age / 60) + 'h' : age + 'm'}`; }
        else if (age >= 45) { st = 'warn'; why = `vieja (${age}m)`; }
        else if (!L.ohlc) { st = 'warn'; why = 'FEED1 sin o/h/l: actualizar TDL Feed'; }
      }
      if (st === 'warn' || st === 'bad') probs.push(`${sym} ${why}`);
      if (rank(st) > rank(worst)) worst = st;
    }
    const note = probs.length ? probs.join(' · ') : (closed ? 'futuros cerrados · crypto al dia' : 'al dia');
    items.push({ key: 'tvbars', label: 'Velas para el Lab', writer: 'TDL Feed -> tos-ingest -> snapshot', status: worst, ageMin: oldest, at: null, note });
    if (worst === 'warn' || worst === 'bad') issues.push(`Velas para el Lab: ${note}`);
  } catch (e) {
    items.push({ key: 'tvbars', label: 'Velas para el Lab', writer: 'TDL Feed', status: 'warn', ageMin: null, at: null, note: `chequeo fallo: ${e.message}` });
  }

  const overall = items.reduce((w, it) => Math.max(w, rank(it.status)), 0);
  const status = ['ok', 'warn', 'bad'][overall];

  const health = {
    schema: 'health-1',
    checkedAt: now.toISOString(),
    status,
    marketOpen: !closed,
    issues,
    items,
  };

  const token = process.env.TOS_BUS_TOKEN;
  if (token) {
    try {
      const cur = await ghGet(OWNER, REPO, BRANCH, 'live/health.json', { token });
      // sin cambios de estado ni de avisos, se reescribe como mucho una vez por hora (antes: un commit cada 15 min)
      let prev = null;
      try { prev = cur && cur.content ? JSON.parse(cur.content) : null; } catch { prev = null; }
      const sig = (h) => JSON.stringify([h.status, h.marketOpen, h.issues, (h.items || []).map((it) => [it.key, it.status, it.note])]);
      if (prev && sig(prev) === sig(health) && now.getTime() - Date.parse(prev.checkedAt || 0) < 60 * 60 * 1000) {
        return new Response(JSON.stringify({ ...health, write: 'sin cambios' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      await ghPut(OWNER, REPO, BRANCH, 'live/health.json', JSON.stringify(health, null, 1),
        `tos: health ${status}`, { token, known: cur });
    } catch (e) {
      return new Response(`health computed but write failed: ${e.message}`, { status: 200 });
    }
  }
  return new Response(JSON.stringify(health), { status: 200, headers: { 'content-type': 'application/json' } });
}
