// Trader OS · lente Coach (Fase 2). La capa de conducta: no mira el mercado, te
// mira a TI operando. Lee los trades reales de MyFundedPerps (via _mfp.mjs, solo
// lectura) + las capturas manuales (razon/emocion, que la API no ve) y escribe la
// seccion trader del cerebro: live/trader.json en el bus trader-os-bus.
//
// Reglas duras que se miden de forma FIABLE desde posiciones/ordenes (sin falsos
// positivos): R1 pausa post-SL (revancha), posicion SIN STOP, tope de trades del
// dia, stop del dia. Las blandas (R2 "se me escapa", R3 promediar, R4 nivel
// invalidado, G1 parcial+BE, G2 R:R) se evaluan con la captura manual y la review
// reflexiva, no se marcan a ciegas aqui.
//
// _live.mjs ya hace los AVISOS en vivo (push) sobre los mismos datos; esto no los
// duplica: compone el estado estructurado del cerebro y es el sustrato de la review.
import { ghGet, ghPut } from './_gh-bus.mjs';
import { hasKey, listAccounts, openPositions, workingOrders, closedPositions, hasStop, familyOf } from './_mfp.mjs';

const OWNER = 'jesusreyna2016';
const REPO = 'trader-os-bus';
const BRANCH = 'main';

// Contrato por defecto (MFP 10k NDX, de memoria); configurable por env
const CFG = {
  maxTrades: +process.env.COACH_MAX_TRADES || 5,
  dayStop: +process.env.COACH_DAY_STOP || 100,      // USD
  riskPerTrade: +process.env.COACH_RISK || 50,      // USD, para la R proxy
  pauseMin: +process.env.COACH_PAUSE_MIN || 10,     // R1: pausa tras un SL
  lossStreakLock: +process.env.COACH_LOCK_STREAK || 3
};

const RULES_ACTIVE = [
  'R1 pausa post-SL', 'R2 se-me-escapa = STOP', 'R3 cortar sin promediar/reentrar',
  'R4 nivel invalidado no se reopera', 'G1 parcial + BE en TP1', 'G2 R:R >= 1'
];

// inicio del dia de trading en Chicago (ms)
function chiDayStartMs() {
  const now = new Date();
  const d = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  d.setHours(0, 0, 0, 0);
  // compensa el offset entre la hora local del server y Chicago
  const diff = now.getTime() - new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' })).getTime();
  return d.getTime() + diff;
}

export async function runCoach() {
  const token = process.env.TOS_BUS_TOKEN;
  if (!token) return { ok: false, error: 'falta TOS_BUS_TOKEN' };
  if (!hasKey()) {
    // sin API MFP: no sobreescribimos trader.json, solo reportamos
    return { ok: true, note: 'sin MFP_API_KEY: el Coach queda a la espera de fills (o de captura manual)' };
  }

  const since = chiDayStartMs();
  const now = Date.now();

  // 1. recoger trades reales de todas las cuentas
  const trades = [];
  const openRows = [];
  let accounts = [];
  try { accounts = await listAccounts(); } catch (e) { return { ok: false, error: 'mfp: ' + e.message }; }

  for (const a of accounts) {
    let closed = [], open = [], orders = [];
    try {
      [closed, open, orders] = await Promise.all([
        closedPositions(a.id, { since, maxPages: 5 }),
        openPositions(a.id),
        workingOrders(a.id)
      ]);
    } catch (e) { continue; }

    for (const p of closed) {
      const pnl = (+p.realized_pnl || 0) - (+p.fees || 0) + (+p.funding || 0);
      trades.push({
        acct: a.id, name: a.name || a.id, sym: familyOf(p.symbol), side: p.side,
        size: +p.size || null, entry: +p.entry_price || null, exit: +p.exit_price || null,
        pnl: Math.round(pnl * 100) / 100, r: CFG.riskPerTrade ? Math.round(pnl / CFG.riskPerTrade * 100) / 100 : null,
        openedAt: p.opened_at || null, closedAt: p.closed_at || null, flags: []
      });
    }
    for (const p of open) {
      openRows.push({
        acct: a.id, name: a.name || a.id, sym: familyOf(p.symbol), side: p.side,
        size: +p.size || null, entry: +p.entry_price || null, openedAt: p.opened_at || null,
        hadStop: hasStop(p, orders), flags: hasStop(p, orders) ? [] : ['NO_STOP']
      });
    }
  }

  trades.sort((x, y) => (x.openedAt || 0) - (y.openedAt || 0));

  // 2. reglas fiables + racha de perdidas
  let dayPnl = 0, lossStreak = 0, maxLossStreak = 0, lastLossAt = null, violations = 0;
  trades.forEach((t, i) => {
    dayPnl += t.pnl;
    // R1: entrada dentro de la pausa tras una perdida (revancha)
    if (lastLossAt && t.openedAt && (t.openedAt - lastLossAt) < CFG.pauseMin * 60e3) {
      t.flags.push('R1_REVENGE'); violations++;
    }
    if (i + 1 > CFG.maxTrades) { t.flags.push('OVER_MAX_TRADES'); violations++; }
    if (dayPnl <= -CFG.dayStop) t.flags.push('DAY_STOP_HIT');
    const loss = (t.r != null ? t.r < 0 : t.pnl < 0);
    if (loss) { lossStreak++; maxLossStreak = Math.max(maxLossStreak, lossStreak); lastLossAt = t.closedAt || t.openedAt; }
    else lossStreak = 0;
  });
  const noStopNow = openRows.filter((o) => !o.hadStop).length;
  if (noStopNow) violations += noStopNow;

  // 2b. entradas en TIERRA DE NADIE (fuera de zona / sin punto de interes):
  //     cruza el precio de entrada con el mapa de niveles del feed por simbolo.
  //     Es MEDICION (marca y cuenta), no toca el estado de bloqueo.
  const token2 = token;
  let levelsBySym = {};
  try {
    const feedsCur = await ghGet(OWNER, REPO, BRANCH, 'live/feeds.json', { token: token2 });
    const feeds = feedsCur?.content ? JSON.parse(feedsCur.content) : {};
    const num = (v) => { const f = parseFloat(v); return isNaN(f) ? null : f; };
    const PTS = ['pdh','pdl','pdc','pdMid','vah','poc','val','dvah','dpoc','dval','onh','onl','ibh','ibl','asH','asL','loH','loL','hod','lod','eq','ema20','ema50'];
    for (const k of Object.keys(feeds)) {
      const m = k.match(/^feed:(.+)$/); if (!m) continue;
      const r = (feeds[k] && feeds[k].raw) || feeds[k] || {};
      const levels = [];
      for (const f of PTS) { const v = num(r[f]); if (v != null) levels.push({ name: f, lo: v, hi: v }); }
      for (const gz of ['gzLong','gzShort']) { const s = r[gz]; if (typeof s === 'string' && s.includes(':')) { const [a,b] = s.split(':').map(num); if (a != null && b != null) levels.push({ name: gz, lo: Math.min(a,b), hi: Math.max(a,b) }); } }
      const atrD = num(r.atrD); const tol = Math.max(atrD != null ? atrD * 0.02 : 0, 15);
      if (levels.length) levelsBySym[m[1]] = { levels, tol };
    }
  } catch { levelsBySym = {}; }
  const nearestDist = (entry, levels) => { let best = Infinity; for (const L of levels) { const d = (entry >= L.lo && entry <= L.hi) ? 0 : Math.min(Math.abs(entry - L.lo), Math.abs(entry - L.hi)); if (d < best) best = d; } return best; };
  let offZoneCount = 0, offZonePnl = 0;
  for (const t of trades) { const lv = levelsBySym[t.sym]; if (lv && t.entry != null) { const d = nearestDist(t.entry, lv.levels); t.distZone = Math.round(d); if (d > lv.tol) { t.flags.push('NO_ZONE'); offZoneCount++; offZonePnl += t.pnl; } } }
  for (const o of openRows) { const lv = levelsBySym[o.sym]; if (lv && o.entry != null) { const d = nearestDist(o.entry, lv.levels); o.distZone = Math.round(d); if (d > lv.tol) o.flags.push('NO_ZONE'); } }

  // 3. estado del dia
  let state = 'OK';
  if (dayPnl <= -CFG.dayStop || lossStreak >= CFG.lossStreakLock) state = 'LOCKOUT';
  else if (trades.some((t) => t.flags.includes('R1_REVENGE')) || lossStreak >= 2 || noStopNow) state = 'TILT';

  // 4. racha de disciplina (se arrastra; la review diaria la ajusta en el rollover)
  const prevCur = await ghGet(OWNER, REPO, BRANCH, 'live/trader.json', { token });
  let prev = {};
  try { prev = prevCur?.content ? JSON.parse(prevCur.content) : {}; } catch { prev = {}; }
  const today = new Date(now).toISOString().slice(0, 10);
  let streak = prev.disciplineStreak || 0;
  if (prev._day && prev._day !== today) streak = (prev.todayViolations === 0) ? streak + 1 : 0;

  // 5. capturas manuales del dia (razon/emocion); las poblo yo desde el chat
  let captures = [];
  const capCur = await ghGet(OWNER, REPO, BRANCH, `trader/manual/${today}.jsonl`, { token });
  if (capCur?.content) {
    for (const line of capCur.content.split('\n')) { const s = line.trim(); if (s) { try { captures.push(JSON.parse(s)); } catch { /* */ } } }
  }

  const openFlags = [];
  for (const t of trades) for (const f of t.flags) if (f.startsWith('R1')) openFlags.push({ rule: 'R1', at: t.openedAt, sym: t.sym, note: 'entrada dentro de la pausa tras un SL' });
  for (const o of openRows) if (!o.hadStop) openFlags.push({ rule: 'stop', at: o.openedAt, sym: o.sym, note: 'posicion abierta sin stop' });
  for (const t of trades) if (t.flags.includes('NO_ZONE')) openFlags.push({ rule: 'zona', at: t.openedAt, sym: t.sym, note: `entrada en tierra de nadie (${t.distZone} pts al nivel mas cercano)` });

  const trader = {
    _writer: 'coach', _schema: 1, _day: today, asOf: new Date(now).toISOString(),
    state, disciplineStreak: streak, todayViolations: violations,
    rulesActive: RULES_ACTIVE,
    sessionBudget: {
      maxTrades: CFG.maxTrades, used: trades.length, riskPerTrade: CFG.riskPerTrade,
      dayStop: CFG.dayStop, pnl: Math.round(dayPnl * 100) / 100,
      pnlR: CFG.riskPerTrade ? Math.round(dayPnl / CFG.riskPerTrade * 100) / 100 : null,
      maxLossStreak
    },
    offZone: { count: offZoneCount, pnl: Math.round(offZonePnl * 100) / 100, ofTrades: trades.length },
    openFlags,
    todayTrades: trades,
    openPositions: openRows,
    captures,
    lastReview: prev.lastReview || null
  };

  const res = await ghPut(OWNER, REPO, BRANCH, 'live/trader.json',
    JSON.stringify(trader, null, 2) + '\n', `tos: trader ${trader.asOf} (${trades.length} trades, ${state})`, { token, known: prevCur });
  return { ok: true, state, trades: trades.length, violations, wrote: res };
}

// invocable por HTTP para pruebas: GET /api/tos-coach
export default async () => {
  const r = await runCoach();
  return new Response(JSON.stringify(r), {
    status: r.ok === false ? 500 : 200,
    headers: { 'content-type': 'application/json' }
  });
};
