// Trader OS · lente Edge (Fase 1b, composer determinista).
// Destila el edge MEDIDO (no lo copia entero) desde dos fuentes y escribe
// live/edge.json en el bus trader-os-bus:
//
//   1. scalp-cc-bus (report.json / state.json, via el espejo Blobs 'scalp' o raw):
//      metricas netas por setup tf/kind/side, el gate/peldaño, el cruce con el
//      Session Analyst, el post-mortem de SL y el shadow. Todo NETO de costes.
//   2. trader-os-bus events/<dia>.jsonl (src=tdl_rev con resolucion TARGET_HIT /
//      INVALIDATED + R): mide el Reversal Model EN VIVO conforme el indicador
//      emite resoluciones. Ventana movil reciente.
//
// El Coach lee edge.json para no recomendar operar setups sin edge probado, y
// para fechar la fuga: revAfterSL dice cada cuanto el mercado vuelve tras un SL
// (perseguir se SIENTE justificado porque pasa ~1 de cada 3, pero no es edge).
import { getStore } from '@netlify/blobs';
import { ghGet, ghPut } from './_gh-bus.mjs';

const OWNER = 'jesusreyna2016';
const REPO = 'trader-os-bus';
const BRANCH = 'main';
const SCALP_RAW = 'https://raw.githubusercontent.com/jesusreyna2016/scalp-cc-bus/main';
const REV_LOOKBACK_DAYS = 7;          // ventana movil para el Reversal medido en vivo
const MIN_N_SETUP = 50;               // por debajo es ruido, no se publica como setup

// edge "probado" (misma definicion que el gate del scalp: readyForLive)
const hasEdge = (m) => m && m.n >= 100 && m.expRnet > 0 && m.pfNet >= 1.3 && m.wrTP1 >= 50;

const round = (v, d = 3) => (typeof v === 'number' && isFinite(v) ? Number(v.toFixed(d)) : null);
const numR = (v) => { const x = typeof v === 'string' ? Number(v) : v; return typeof x === 'number' && isFinite(x) ? x : null; };

// lee un JSON del scalp-cc-bus: primero el espejo Blobs (mismo sitio, sin lag de
// cache de raw.githubusercontent), si no hay espejo cae a raw.
async function scalpJson(store, name, file) {
  try { const s = await store.get(`mirror:${name}`); if (s) return JSON.parse(s); } catch { /* sin espejo */ }
  try {
    const r = await fetch(`${SCALP_RAW}/${file}`, { headers: { 'user-agent': 'tdl-edge-lens' }, cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch { /* sin red */ }
  return null;
}

// metrica del scalp -> forma lente (net de costes como headline)
function slim(m) {
  if (!m) return null;
  return { n: m.n, wr: round(m.wrTP1, 1), expRnet: round(m.expRnet), pfNet: round(m.pfNet, 2),
           expR: round(m.expR), revAfterSL: round(m.revAfterSL_rate, 1) };
}

// ---- Reversal Model medido en vivo desde los eventos del bus ----
async function reversalFromEvents(token) {
  const days = [];
  for (let i = 0; i < REV_LOOKBACK_DAYS; i++) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));

  const rows = [];
  for (const day of days) {
    const cur = await ghGet(OWNER, REPO, BRANCH, `events/${day}.jsonl`, { token });
    if (!cur?.content) continue;
    for (const line of cur.content.split('\n')) {
      const t = line.trim(); if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (e.src !== 'tdl_rev') continue;
        const ev = (e.event || '').toUpperCase();
        if (ev !== 'TARGET_HIT' && ev !== 'INVALIDATED') continue;
        const R = numR(e.data?.R ?? e.data?.r);
        if (R === null) continue;
        rows.push({ win: ev === 'TARGET_HIT', R, sym: e.sym,
                    session: (e.data?.session || e.data?.kz || e.data?.killzone || null) });
      } catch { /* corrupta */ }
    }
  }
  if (!rows.length) return { n: 0, window: `${REV_LOOKBACK_DAYS}d`, note: 'sin resoluciones aun; se mide conforme TDL_REV las emita' };

  const sumR = rows.reduce((a, r) => a + r.R, 0);
  const wins = rows.filter((r) => r.win).length;
  const bySession = {};
  for (const r of rows) {
    const k = r.session || 'NA';
    (bySession[k] ||= { n: 0, sumR: 0 });
    bySession[k].n++; bySession[k].sumR += r.R;
  }
  for (const k of Object.keys(bySession)) bySession[k] = { n: bySession[k].n, expR: round(bySession[k].sumR / bySession[k].n) };

  return { n: rows.length, window: `${REV_LOOKBACK_DAYS}d`, expR: round(sumR / rows.length),
           wr: round((wins / rows.length) * 100, 1), bySession };
}

export async function runEdge() {
  const token = process.env.TOS_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta TOS_BUS_TOKEN' };

  const store = getStore('scalp');
  const [report, state] = await Promise.all([
    scalpJson(store, 'report', 'report.json'),
    scalpJson(store, 'state', 'state.json'),
  ]);

  // --- setups: destila tf/kind/side con n suficiente, marca cuales tienen edge ---
  const src = report?.by_tf_kind_side || state?.metrics_by_tf_kind_side || {};
  const bySetup = {};
  const edged = [];
  for (const [seg, m] of Object.entries(src)) {
    if (!m || m.n < MIN_N_SETUP) continue;
    const s = slim(m); s.hasEdge = hasEdge(m);
    bySetup[seg] = s;
    if (s.hasEdge) edged.push({ seg, expRnet: s.expRnet, n: s.n, pfNet: s.pfNet, wr: s.wr });
  }
  edged.sort((a, b) => (b.expRnet ?? -9) - (a.expRnet ?? -9));

  // --- gate / peldaño ---
  const g = report?.gate || {};
  const eg = state?.executionGate || {};
  const phase = eg.phase || (g.readyForLive ? 'shadow' : 'advisor');
  const rung = phase === 'shadow' ? 1 : (phase === 'advisor' ? 0 : null);
  const gate = {
    phase, rung,
    readyForLive: !!g.fullyReady,                 // la luz verde REAL (no el flag intermedio)
    provisionalSegment: g.segment || eg.segment || null,
    weeklyStable3: !!g.weeklyStable3,
    weeklyDetail: Array.isArray(g.weeklyDetail) ? g.weeklyDetail.slice(-3) : null,
  };

  // --- cruce con Session Analyst (crossInsights) ---
  const crossInsights = [];
  const sac = report?.session_analyst_cross;
  if (sac?.available && sac.by_verdict) {
    const byV = {};
    for (const [v, m] of Object.entries(sac.by_verdict)) byV[v] = { n: m.n, expRnet: round(m.expRnet), pfNet: round(m.pfNet, 2), wr: round(m.wrTP1, 1) };
    // hallazgo: ordena los verdicts por expRnet, nombra el mejor y el peor
    const order = Object.entries(byV).filter(([, m]) => m.n >= 500).sort((a, b) => (b[1].expRnet ?? -9) - (a[1].expRnet ?? -9));
    let finding = null;
    if (order.length >= 2) {
      const [best] = order[0], [worst] = order[order.length - 1];
      finding = `señales con SA=${best} rinden mejor (expRnet ${byV[best].expRnet}) que con SA=${worst} (${byV[worst].expRnet})`;
    }
    crossInsights.push({ with: 'SA', nMatched: sac.n_matched, byVerdict: byV, finding });
  }

  // --- post-mortem de SL (para la fuga del Coach) ---
  let slInsight = null;
  const pm = report?.sl_post_mortem_this_week || report?.sl_post_mortem;
  const overall = report?.overall || null;
  if (pm?.causes) {
    const top = Object.entries(pm.causes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cause, n]) => ({ cause, n }));
    slInsight = {
      week: pm.week || null, nLosses: pm.n_losses || null, topCauses: top,
      revAfterSL: round(overall?.revAfterSL_rate, 1),
      coachNote: 'el mercado vuelve tras el SL ~1 de cada 3 veces (revAfterSL); por eso perseguir se siente justificado y no lo es',
    };
  }

  // --- shadow (peldaño 1): bate a la señal cruda? ---
  let shadow = null;
  const sw = report?.shadow_weekly;
  if (sw && typeof sw === 'object') {
    const weeks = Object.keys(sw).sort().slice(-4);
    const beats = weeks.map((w) => sw[w]?.shadow_beats_raw).filter((x) => x === true).length;
    shadow = { weeks, beatsRawOf4: beats, lastWeek: weeks.length ? { week: weeks[weeks.length - 1], ...sw[weeks[weeks.length - 1]] } : null };
  }

  // --- Reversal Model medido en vivo ---
  const reversalModel = await reversalFromEvents(token);

  const headline = overall
    ? `señal cruda scalp expRnet ${round(overall.expRnet)} (${overall.n}); edge solo en: ${edged.length ? edged.map((e) => e.seg).join(', ') : 'ninguno confirmado'}`
    : 'sin datos de scalp';

  const edge = {
    _writer: 'edge', _schema: 1, asOf: new Date().toISOString(),
    rung: gate.rung, readyForLive: gate.readyForLive,
    headline,
    overall: overall ? { n: overall.n, wr: round(overall.wrTP1, 1), expRnet: round(overall.expRnet), pfNet: round(overall.pfNet, 2), revAfterSL: round(overall.revAfterSL_rate, 1) } : null,
    topSetups: edged.slice(0, 6),
    bySetup,
    gate,
    crossInsights,
    slInsight,
    shadow,
    reversalModel,
    _sources: { scalp: !!report, scalpGeneratedAt: report?.generatedAt || null },
  };

  const res = await ghPut(OWNER, REPO, BRANCH, 'live/edge.json',
    JSON.stringify(edge, null, 2) + '\n', `tos: edge ${edge.asOf}`, { token });
  return { ok: true, topSetups: edged.length, setups: Object.keys(bySetup).length, rev: reversalModel.n, wrote: res };
}

// invocable por HTTP para pruebas: GET /api/tos-edge
export default async () => {
  const r = await runEdge();
  return new Response(JSON.stringify(r), {
    status: r.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json' }
  });
};
