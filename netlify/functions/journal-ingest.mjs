// Recibe un digest DE-IDENTIFICADO de disciplina desde el Trading Journal
// (mywhyjournal.com, POST JSON + ?key=) y lo escribe en el bus del Session Analyst
// como live/journal.json, para que el agente cloud aprenda el patron de ejecucion
// de Jesus a lo largo de semanas (fase 5b de #3 en mejoras-roadmap).
//
// NO se guardan importes: la whitelist de abajo deja pasar SOLO campos de
// disciplina (conteos y flags), nunca $ / P&L / balance / nombre de cuenta.
// Aunque el cliente mande de mas, el bus solo recibe la forma limpia.
//
// MERGE: el digest entrante se fusiona con live/journal.json existente por fecha.
// Un sync parcial (1 dia / filtro de cuenta) NO debe borrar el historico rodante
// (~45 dias) que espera scorecard.execution. Incoming gana en fechas coincidentes.
//
// El journal es un sitio publico, asi que la clave (?key=CC_INGEST_SECRET) no va
// en el codigo del journal: Jesus la guarda una vez en los ajustes del journal
// (privados por RLS). CORS abierto porque el POST viene del navegador cross-origin.
import { busGet, busPut } from './_sa-bus.mjs';

const cors = (origin) => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'vary': 'origin'
});

/** Rolling window kept on the bus (method scorecard.execution expects ~45d). */
const ROLLING_DAYS = 45;
/** Hard cap vs abuse / oversized payloads. */
const HARD_CAP = 120;

const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
const int = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v) : null;
const bool = (v) => v === true;

// whitelist estricta por dia: solo disciplina, nada de dinero
function cleanDay(d) {
  if (!d || typeof d !== 'object') return null;
  const date = typeof d.date === 'string' ? d.date.slice(0, 10) : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    date,
    // origen del dia: 'mfp' = digest del servidor (solo fills de MFP, sin fichas); sin campo = Mi Mesa / journal
    ...(d.src === 'mfp' ? { src: 'mfp' } : {}),
    trades: int(d.trades),
    disciplined: bool(d.disciplined),
    maxLossStreak: int(d.maxLossStreak),
    overtrade: bool(d.overtrade),
    revenge: bool(d.revenge),
    roundTrip: bool(d.roundTrip),
    graded: int(d.graded),
    withBias: int(d.withBias),
    againstBias: int(d.againstBias),
    validEdge: int(d.validEdge),
    outsideEdge: int(d.outsideEdge),
    // exit quality: counts + a unitless pts ratio (avg win pts / avg loss pts), never money
    positions: int(d.positions),
    partials: int(d.partials),
    scratches: int(d.scratches),
    fullStops: int(d.fullStops),
    wlPtsRatio: num(d.wlPtsRatio),
    // per-position prices in points (plan vs execution); still no money and no size
    fills: cleanFills(d.fills)
  };
}

function cleanFills(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 80).map((f) => {
    if (!f || typeof f !== 'object' || typeof f.t !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(f.t)) return null;
    const side = f.side === 'long' || f.side === 'short' ? f.side : null;
    const sym = typeof f.sym === 'string' ? f.sym.replace(/[^A-Za-z0-9!._-]/g, '').slice(0, 16) : null;
    if (!side || !sym) return null;
    return { t: f.t.slice(0, 25), sym, side, entry: num(f.entry), exit: num(f.exit), pts: num(f.pts), durMin: int(f.durMin) };
  }).filter(Boolean);
}

function recomputeRollup(byDay) {
  const n = byDay.length;
  if (!n) return null;
  const sum = (f) => byDay.reduce((s, r) => s + (f(r) || 0), 0);
  const gtot = sum((r) => r.graded);
  const ptot = sum((r) => r.positions); // old days carry null exit fields and count as 0
  return {
    days: n,
    disciplinedPct: Math.round(sum((r) => (r.disciplined ? 1 : 0)) / n * 100),
    avgTradesPerDay: +(sum((r) => r.trades) / n).toFixed(1),
    gradedTrades: gtot,
    againstBiasRate: gtot ? +(sum((r) => r.againstBias) / gtot).toFixed(2) : null,
    outsideEdgeRate: gtot ? +(sum((r) => r.outsideEdge) / gtot).toFixed(2) : null,
    overtradeDays: sum((r) => (r.overtrade ? 1 : 0)),
    revengeDays: sum((r) => (r.revenge ? 1 : 0)),
    positions: ptot,
    partialRate: ptot ? +(sum((r) => r.partials) / ptot).toFixed(2) : null,
    scratchRate: ptot ? +(sum((r) => r.scratches) / ptot).toFixed(2) : null,
    fullStopRate: ptot ? +(sum((r) => r.fullStops) / ptot).toFixed(2) : null
  };
}

function mergeByDay(existing, incoming) {
  const map = new Map();
  for (const d of existing || []) {
    const c = cleanDay(d);
    if (c) map.set(c.date, c);
  }
  for (const d of incoming || []) {
    const c = cleanDay(d);
    if (!c) continue;
    // incoming gana en la misma fecha, salvo que el entrante sea del servidor ('mfp') y el que hay venga de
    // Mi Mesa: Mi Mesa tiene las fichas (sesgo, zona, fugas) y el servidor no, asi que no la pisa
    const cur = map.get(c.date);
    if (c.src === 'mfp' && cur && cur.src !== 'mfp') continue;
    map.set(c.date, c);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Escribe live/journal.json en el bus: mezcla por fecha con lo que ya hay y recalcula el rollup.
// Lo usan este endpoint (Trading Journal, con ?key=) y /api/live?action=journal (Mi Mesa, con la sesion del dueño).
export async function writeJournalDigest(byDayIn, source) {
  const now = new Date().toISOString();
  const incoming = (Array.isArray(byDayIn) ? byDayIn : []).slice(-HARD_CAP).map(cleanDay).filter(Boolean);
  if (!incoming.length) return { ok: false, status: 400, error: 'no valid days' };
  const token = process.env.SA_BUS_TOKEN;
  if (!token) return { ok: false, status: 503, error: 'SA_BUS_TOKEN missing' };

  let existing = [];
  let prevSource = null;
  let known = undefined;
  try {
    known = await busGet('live/journal.json', { token });
    if (known && known.content) {
      const prev = JSON.parse(known.content);
      if (prev && Array.isArray(prev.byDay)) existing = prev.byDay;
      prevSource = prev && typeof prev.source === 'string' ? prev.source : null;
    }
  } catch (e) {
    known = undefined; // fall through: write as create/update without known
  }

  let byDay = mergeByDay(existing, incoming);
  if (byDay.length > ROLLING_DAYS) byDay = byDay.slice(-ROLLING_DAYS);

  const clean = {
    schema: 'journal-digest-1',
    note: 'De-identified discipline digest from the trader journal. No P&L, no balances. Counts and flags only.',
    // el relleno nocturno del servidor no cambia el origen principal (lo marca por dia con src 'mfp')
    source: source === 'mfp-server' ? (prevSource || 'mfp-server') : (source || 'trading-journal'),
    ...(source === 'mfp-server' ? { serverFillAt: now } : {}),
    updatedAt: now,
    window: { days: byDay.length },
    rollup: recomputeRollup(byDay),
    byDay
  };
  const body = JSON.stringify(clean, null, 2) + '\n';
  try {
    const r = await busPut('live/journal.json', body, `sa-bus: journal digest ${now}`, { token, known });
    return { ok: true, status: 200, ...r, days: byDay.length, merged: existing.length > 0, incoming: incoming.length };
  } catch (e) {
    return { ok: false, status: 502, error: String(e && e.message || e) };
  }
}

// El relleno nocturno sin trades no escribia nada y el watchdog marcaba el journal como rancio (> 72 h)
// aunque solo no se hubiera operado. Esto deja constancia de la revision: updatedAt y serverCheckedAt.
export async function touchJournalChecked(note) {
  const token = process.env.SA_BUS_TOKEN;
  if (!token) return { ok: false, status: 503, error: 'SA_BUS_TOKEN missing' };
  const now = new Date().toISOString();
  const known = await busGet('live/journal.json', { token });
  if (!known || !known.content) return { ok: false, error: 'sin live/journal.json' };
  const prev = JSON.parse(known.content);
  const next = { ...prev, updatedAt: now, serverCheckedAt: now, serverNote: note || null };
  const body = JSON.stringify(next, null, 2) + '\n';
  const r = await busPut('live/journal.json', body, `sa-bus: journal checked ${now}`, { token, known });
  return { ok: true, touched: true, ...r };
}

export default async (req) => {
  const origin = req.headers.get('origin') || '*';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: cors(origin) });

  const secret = process.env.CC_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if (!secret || key !== secret) return new Response('unauthorized', { status: 401, headers: cors(origin) });

  let b;
  try { b = JSON.parse(await req.text()); }
  catch (e) { return new Response('bad JSON', { status: 400, headers: cors(origin) }); }
  if (!b || typeof b !== 'object' || Array.isArray(b) || !Array.isArray(b.byDay)) {
    return new Response('bad body (need {byDay:[...]})', { status: 400, headers: cors(origin) });
  }

  const r = await writeJournalDigest(b.byDay, 'trading-journal');
  if (!r.ok && r.status !== 502) return new Response(r.error, { status: r.status, headers: cors(origin) });
  const { status, ...out } = r;
  return new Response(JSON.stringify(out), { status, headers: { ...cors(origin), 'content-type': 'application/json' } });
};
