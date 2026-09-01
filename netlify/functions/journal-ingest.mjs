// Recibe un digest DE-IDENTIFICADO de disciplina desde el Trading Journal
// (mywhyjournal.com, POST JSON + ?key=) y lo escribe en el bus del Session Analyst
// como live/journal.json, para que el agente cloud aprenda el patron de ejecucion
// de Jesus a lo largo de semanas (fase 5b de #3 en mejoras-roadmap).
//
// NO se guardan importes: la whitelist de abajo deja pasar SOLO campos de
// disciplina (conteos y flags), nunca $ / P&L / balance / nombre de cuenta.
// Aunque el cliente mande de mas, el bus solo recibe la forma limpia.
//
// El journal es un sitio publico, asi que la clave (?key=CC_INGEST_SECRET) no va
// en el codigo del journal: Jesus la guarda una vez en los ajustes del journal
// (privados por RLS). CORS abierto porque el POST viene del navegador cross-origin.
import { busPut } from './_sa-bus.mjs';

const cors = (origin) => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'vary': 'origin'
});

const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
const int = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v) : null;
const bool = (v) => v === true;

// whitelist estricta por dia: solo disciplina, nada de dinero
function cleanDay(d) {
  if (!d || typeof d !== 'object') return null;
  const date = typeof d.date === 'string' ? d.date.slice(0, 10) : null;
  if (!date) return null;
  return {
    date,
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
    outsideEdge: int(d.outsideEdge)
  };
}

function cleanRollup(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    days: int(r.days),
    disciplinedPct: int(r.disciplinedPct),
    avgTradesPerDay: num(r.avgTradesPerDay),
    gradedTrades: int(r.gradedTrades),
    againstBiasRate: num(r.againstBiasRate),
    outsideEdgeRate: num(r.outsideEdgeRate),
    overtradeDays: int(r.overtradeDays),
    revengeDays: int(r.revengeDays)
  };
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

  const now = new Date().toISOString();
  const byDay = b.byDay.slice(-120).map(cleanDay).filter(Boolean);
  if (!byDay.length) return new Response('no valid days', { status: 400, headers: cors(origin) });

  const token = process.env.SA_BUS_TOKEN;
  if (!token) return new Response('SA_BUS_TOKEN missing', { status: 503, headers: cors(origin) });

  const clean = {
    schema: 'journal-digest-1',
    note: 'De-identified discipline digest from the trader journal. No P&L, no balances. Counts and flags only.',
    updatedAt: now,
    window: { days: byDay.length },
    rollup: cleanRollup(b.rollup),
    byDay
  };
  const body = JSON.stringify(clean, null, 2) + '\n';

  try {
    const r = await busPut('live/journal.json', body, `sa-bus: journal digest ${now}`, { token });
    return new Response(JSON.stringify({ ok: true, ...r, days: byDay.length }), {
      status: 200, headers: { ...cors(origin), 'content-type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), {
      status: 502, headers: { ...cors(origin), 'content-type': 'application/json' }
    });
  }
};
