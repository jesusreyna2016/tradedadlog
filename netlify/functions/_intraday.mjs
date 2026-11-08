// Motor del Plan Intradia (zonas de entrada que se recalculan cada 15 min).
// Puro y determinista: no lee red ni Blobs, solo transforma el ultimo estado de los
// indicadores (lo que ya guarda ind-ingest) en un plan de zonas por simbolo.
//
// Entradas por simbolo:
//   feed     -> raw de TDL Feed (FEED1, una vela de 5m): niveles, FVG, ATR, chop, sweep...
//   trendcl  -> raw de Trend Checklist (TCL1): d / h4 / h1 en -1/0/1, flip
//   regime   -> raw de Market Regime (RGM1): CHOP / BULL / BEAR
//   plan     -> instrumento del plan del Session Analyst (biasDay, biasSession, conviction)
//
// Salida: { sym, price, verdict, bias, warnings[], zones[] } donde cada zona trae
// lado, rango, gatillo, stop, objetivos, R y una calificacion A+/A/B segun confluencia
// y alineacion con los marcos. La rutina intraday-cron le suma el estado vivo
// (nueva / tocada / invalidada / funciono) comparando contra la corrida anterior.

const n = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : null;
};

export const TICK = { NQ: 0.25, ES: 0.25, GC: 0.1, YM: 1, CL: 0.01, ETHUSDT: 0.01, BTCUSDT: 0.1 };
const decs = (step) => { const t = String(step); return t.includes('.') ? t.split('.')[1].length : 0; };
const roundTo = (x, step) => +(Math.round(x / step) * step).toFixed(decs(step));

// Peso de cada nivel: cuanto aporta a la confluencia de una zona.
const LEVEL_W = {
  pdh: 2.5, pdl: 2.5, pwh: 2.5, pwl: 2.5, pmh: 2, pml: 2,
  onh: 2, onl: 2, asH: 1.5, asL: 1.5, loH: 1.5, loL: 1.5, ibh: 1.5, ibl: 1.5,
  vah: 2, val: 2, poc: 2, dvah: 1.5, dval: 1.5, dpoc: 1.5,
  pdc: 1, pdMid: 1, do: 1.5, tdo: 1.5, wo: 1.5, mOpen: 1,
  sh1h: 2, sl1h: 2, sh4h: 2.5, sl4h: 2.5, sh5: 0.5, sl5: 0.5,
  ema200: 1, ema50h: 1, vwapUp: 1, vwapDn: 1, vwap: 1
};
const LEVEL_NAME = {
  pdh: 'PDH', pdl: 'PDL', pwh: 'PWH', pwl: 'PWL', pmh: 'PMH', pml: 'PML', onh: 'ONH', onl: 'ONL',
  asH: 'Asia H', asL: 'Asia L', loH: 'Londres H', loL: 'Londres L', ibh: 'IBH', ibl: 'IBL',
  vah: 'VAH', val: 'VAL', poc: 'POC', dvah: 'VAH dia', dval: 'VAL dia', dpoc: 'POC dia',
  pdc: 'Cierre previo', pdMid: 'Mitad dia previo', do: 'Apertura dia', tdo: 'Apertura real (TDO)',
  wo: 'Apertura semana', mOpen: 'Apertura mes', sh1h: 'Swing H 1h', sl1h: 'Swing L 1h',
  sh4h: 'Swing H 4h', sl4h: 'Swing L 4h', sh5: 'Swing H 5m', sl5: 'Swing L 5m',
  ema200: 'EMA200 5m', ema50h: 'EMA50 1h', vwapUp: 'VWAP +1σ', vwapDn: 'VWAP -1σ', vwap: 'VWAP'
};
const FVG_W = { '5m': 1, '15m': 1.5, '1h': 2.5, '4h': 3 };

// "5m ibull:26962.50:26979.75;1h bear:27425.00:27457.50" -> [{tf,type,lo,hi}]
export function parseFvg(str) {
  if (!str) return [];
  return String(str).split(';').map((s) => {
    const m = s.trim().match(/^(\S+)\s+(i?bull|i?bear):([\d.]+):([\d.]+)/);
    if (!m) return null;
    const a = n(m[3]), b = n(m[4]);
    if (a === null || b === null) return null;
    // iFVG = gap invertido: un ibull era bajista y ahora soporta, un ibear resiste
    return { tf: m[1], type: m[2], lo: Math.min(a, b), hi: Math.max(a, b) };
  }).filter(Boolean);
}

function frameVote(trendcl, plan) {
  // -3..+3 de marcos (D/4H/1H del Trend Checklist) + el sesgo de sesion del Session Analyst.
  let v = 0, parts = [];
  if (trendcl) {
    const d = n(trendcl.d), h4 = n(trendcl.h4), h1 = n(trendcl.h1);
    if (d) { v += d; parts.push('D ' + (d > 0 ? '▲' : '▼')); }
    if (h4) { v += h4; parts.push('4H ' + (h4 > 0 ? '▲' : '▼')); }
    if (h1) { v += h1 * 0.5; parts.push('1H ' + (h1 > 0 ? '▲' : '▼')); }
  }
  let sa = 0;
  if (plan) {
    const b = String(plan.biasSession || plan.biasDay || '').toUpperCase();
    sa = b === 'LONG' ? 1 : b === 'SHORT' ? -1 : 0;
    const w = String(plan.conviction || '').toLowerCase() === 'alta' ? 1.5 : 1;
    v += sa * w;
    if (sa) parts.push('Plan ' + (sa > 0 ? 'LONG' : 'SHORT') + (plan.conviction ? ' (' + plan.conviction + ')' : ''));
  }
  const dir = v >= 1.5 ? 1 : v <= -1.5 ? -1 : 0;
  return { score: +v.toFixed(2), dir, label: dir > 0 ? 'ALCISTA' : dir < 0 ? 'BAJISTA' : 'NEUTRAL', parts, sa };
}

/**
 * Construye el plan de zonas de un simbolo.
 * @param {string} sym
 * @param {{feed:object, trendcl?:object, regime?:object, plan?:object, news?:Array, now?:number, feedAt?:string}} src
 */
export function buildSymbolPlan(sym, src) {
  const f = src.feed || {};
  const price = n(f.close);
  const atr5 = n(f.atr5), atrD = n(f.atrD);
  const tick = TICK[sym] || 0.01;
  if (price === null || !atr5 || !atrD) {
    return { sym, price, verdict: 'SIN DATOS', warnings: ['El TDL Feed no tiene datos de este simbolo'], zones: [] };
  }
  const now = src.now || Date.now();
  const tol = Math.max(atr5 * 0.5, tick * 4);
  const maxW = atr5 * 2.2;
  const reach = atrD * 0.9; // mas lejos que esto no es intradia

  // 1) Elementos candidatos (niveles puntuales y rangos)
  const els = [];
  for (const k of Object.keys(LEVEL_W)) {
    const px = n(f[k]);
    if (px === null) continue;
    els.push({ lo: px, hi: px, w: LEVEL_W[k], name: LEVEL_NAME[k] || k });
  }
  for (const g of parseFvg(f.fvg)) {
    const w = FVG_W[g.tf] || 1;
    const label = g.tf + (g.type.startsWith('i') ? ' iFVG' : ' FVG') + (g.type.endsWith('bull') ? ' alcista' : ' bajista');
    if (g.hi - g.lo > maxW) {
      // FVG enorme: solo su borde cercano al precio y su CE sirven como niveles operables
      const near = Math.abs(g.hi - price) < Math.abs(g.lo - price) ? g.hi : g.lo;
      els.push({ lo: near, hi: near, w, name: label + ' (borde)' });
      els.push({ lo: (g.lo + g.hi) / 2, hi: (g.lo + g.hi) / 2, w: w * 0.6, name: label + ' (CE)' });
    } else {
      els.push({ lo: g.lo, hi: g.hi, w, name: label });
    }
  }
  for (const [k, nm] of [['gzLong', 'Golden zone long'], ['gzShort', 'Golden zone short']]) {
    const m = String(f[k] || '').split(':').map(n);
    if (m.length === 2 && m[0] !== null && m[1] !== null && Math.abs(m[1] - m[0]) <= maxW * 1.5) {
      els.push({ lo: Math.min(m[0], m[1]), hi: Math.max(m[0], m[1]), w: 1.5, name: nm });
    }
  }
  const near = els.filter((e) => Math.abs((e.lo + e.hi) / 2 - price) <= reach);

  // 2) Agrupar por cercania (clustering 1D)
  near.sort((a, b) => a.lo - b.lo);
  const clusters = [];
  for (const e of near) {
    const c = clusters[clusters.length - 1];
    if (c && e.lo <= c.hi + tol && Math.max(c.hi, e.hi) - c.lo <= maxW) {
      c.hi = Math.max(c.hi, e.hi); c.members.push(e);
    } else {
      clusters.push({ lo: e.lo, hi: e.hi, members: [e] });
    }
  }

  const fv = frameVote(src.trendcl, src.plan);
  const regime = String(src.regime?.regime || '').toUpperCase();
  const chop = n(f.chopIdx);
  const stretch = n(f.stretchAtr);
  const rangePct = n(f.rangePct);

  // 3) Puntuar cada cluster como zona long (debajo) o short (arriba)
  const zones = [];
  for (const c of clusters) {
    let lo = c.lo, hi = c.hi;
    if (hi - lo < atr5 * 0.4) { const mid = (lo + hi) / 2; lo = mid - atr5 * 0.2; hi = mid + atr5 * 0.2; }
    const mid = (lo + hi) / 2;
    const inside = price >= lo && price <= hi;
    const side = inside ? (fv.dir >= 0 ? 'long' : 'short') : mid < price ? 'long' : 'short';
    const sgn = side === 'long' ? 1 : -1;

    // confluencia con rendimientos decrecientes (5 niveles iguales no valen 5 veces)
    const ws = c.members.map((m) => m.w).sort((a, b) => b - a);
    let conf = 0; ws.forEach((w, i) => { conf += w * Math.pow(0.7, i); });
    let score = conf;
    const why = [];
    if (fv.dir === sgn) { score += 1.5; why.push('a favor de ' + fv.label.toLowerCase()); }
    else if (fv.dir === -sgn) { score -= 1.5; why.push('contra los marcos (' + fv.label.toLowerCase() + ')'); }
    if (regime === 'CHOP') score -= 0.5;
    if (regime === 'BULL' && side === 'long') score += 0.5;
    if (regime === 'BEAR' && side === 'short') score += 0.5;
    // zona muy pegada al precio = ya estas dentro, no es una entrada planeada
    const distPts = inside ? 0 : side === 'long' ? price - hi : lo - price;
    const distAtr = distPts / atr5;
    if (distAtr > 12) score -= 1; // lejos para hoy

    // 4) Stop, gatillo y objetivos
    const buf = Math.max(atr5 * 0.3, tick * 4);
    const entry = roundTo(side === 'long' ? hi - (hi - lo) * 0.25 : lo + (hi - lo) * 0.25, tick);
    // stop fuera de la zona + colchon, y nunca mas cerca que 0.75 ATR de 5m (el ruido normal te saca)
    let stopRaw = side === 'long' ? lo - buf : hi + buf;
    if (Math.abs(entry - stopRaw) < atr5 * 0.75) stopRaw = entry - sgn * atr5 * 0.75;
    const stop = roundTo(stopRaw, tick);
    const risk = Math.abs(entry - stop);
    // objetivos: los siguientes clusters en la direccion del trade
    const ahead = clusters
      .map((o) => (o.lo + o.hi) / 2)
      .filter((m) => (side === 'long' ? m > entry + risk * 0.8 : m < entry - risk * 0.8))
      .sort((a, b) => (side === 'long' ? a - b : b - a));
    // tp1 = el siguiente nivel, pero sin pasar de 3R (si no hay nada antes, se cobra a 3R);
    // tp2 = el siguiente nivel despues de tp1
    const cap = entry + sgn * risk * 3;
    const lvl1 = ahead[0];
    const tp1 = roundTo(lvl1 !== undefined && (side === 'long' ? lvl1 < cap : lvl1 > cap) ? lvl1 : cap, tick);
    const next = ahead.find((m) => (side === 'long' ? m > tp1 + risk * 0.5 : m < tp1 - risk * 0.5));
    const tp2 = roundTo(next !== undefined ? next : tp1 + sgn * risk * 2, tick);
    const rr1 = risk > 0 ? +(Math.abs(tp1 - entry) / risk).toFixed(2) : null;
    if (rr1 !== null && rr1 < 1.2) { score -= 1; why.push('poco recorrido hasta el objetivo (' + rr1 + 'R)'); }

    const aligned = fv.dir === sgn;
    let grade = score >= 7 && aligned ? 'A+' : score >= 5 ? 'A' : score >= 3.5 ? 'B' : 'C';
    if (!aligned && grade === 'A+') grade = 'A';
    if (fv.dir === -sgn && grade === 'A') grade = 'B'; // contra-tendencia nunca pasa de B

    const names = [...new Set(c.members.map((m) => m.name))];
    zones.push({
      id: side + ':' + roundTo(mid, tick * 4).toFixed(2),
      side, lo: roundTo(lo, tick), hi: roundTo(hi, tick), mid: roundTo(mid, tick),
      entry, stop, tp1, tp2, rr1, riskPts: +risk.toFixed(4),
      distPts: +distPts.toFixed(2), distAtr5: +distAtr.toFixed(1), inside,
      score: +score.toFixed(2), grade, aligned, confluence: names,
      trigger: side === 'long'
        ? 'Barrida o toque de ' + roundTo(lo, tick) + '–' + roundTo(hi, tick) + ' y cierre de 5m de vuelta arriba (reclamo). Sin cierre de vuelta, no hay trade.'
        : 'Barrida o toque de ' + roundTo(lo, tick) + '–' + roundTo(hi, tick) + ' y cierre de 5m de vuelta abajo (rechazo). Sin cierre de vuelta, no hay trade.',
      invalid: 'Cierre de 5m ' + (side === 'long' ? 'bajo ' : 'sobre ') + stop,
      why
    });
  }

  const usable = zones.filter((z) => z.grade !== 'C').sort((a, b) => b.score - a.score);
  const longs = usable.filter((z) => z.side === 'long').slice(0, 3);
  const shorts = usable.filter((z) => z.side === 'short').slice(0, 3);

  // 5) Avisos y veredicto
  const warnings = [];
  if (chop !== null && chop >= 61.8) warnings.push('Chop alto (' + chop + '): rango sucio, solo extremos A+ o no operar');
  if (stretch !== null && Math.abs(stretch) >= 2) warnings.push('Precio estirado ' + stretch + '× ATR 5m: no persigas, espera la zona');
  if (rangePct !== null && rangePct >= 100) warnings.push('El dia ya hizo ' + rangePct + '% de su ATR (' + (f.emRegime || 'agotado') + '): objetivos cortos');
  if (f.sweep && n(f.sweepAgo) !== null && n(f.sweepAgo) <= 6) warnings.push('Barrida reciente ' + f.sweep + ' hace ' + f.sweepAgo + ' velas');
  if (f.smt && f.smt !== 'none') warnings.push('SMT ' + (f.smt === 'bull' ? 'alcista' : 'bajista') + ' activa');
  const vix = n(f.vix);
  if (vix !== null && vix >= 25) warnings.push('VIX ' + vix + ': stops mas anchos, baja el tamaño');

  // calendario de cc-news (forexfactory): solo USD de impacto alto mueve estos simbolos
  const upcoming = (src.news || []).filter((e) => {
    const t = typeof e.ts === 'number' ? e.ts : Date.parse(e.time || e.date || '');
    return Number.isFinite(t) && String(e.impact || '').toLowerCase() === 'high' &&
      (!e.currency || e.currency === 'USD') && t > now - 10 * 60e3 && t < now + 45 * 60e3;
  });
  if (upcoming.length) warnings.push('Noticia USD de alto impacto en la ventana de -10/+45 min: ' + upcoming.map((e) => e.title || e.event).join(', '));

  let feedAgeMin = null;
  if (src.feedAt) feedAgeMin = Math.round((now - Date.parse(src.feedAt)) / 60e3);
  const stale = feedAgeMin !== null && feedAgeMin > 25;

  let verdict = 'OPERABLE';
  if (stale) verdict = 'SIN DATOS';
  else if (upcoming.length) verdict = 'NO OPERAR';
  else if (chop !== null && chop >= 61.8 && !usable.some((z) => z.grade === 'A+')) verdict = 'ESPERAR';
  else if (!usable.length) verdict = 'ESPERAR';

  const best = usable.find((z) => z.aligned) || usable[0] || null;

  return {
    sym, price, atr5, atrD, verdict, feedAgeMin,
    bias: { dir: fv.label, score: fv.score, parts: fv.parts },
    regime: regime || null, chop, stretch, rangePct,
    focus: best ? best.id : null,
    zones: [...longs, ...shorts].sort((a, b) => b.score - a.score),
    warnings
  };
}

// Estado vivo de cada zona comparando contra la corrida anterior.
// hod/lod del dia: si el minimo del dia baja hasta la zona long, se toco; si cierra
// mas alla del stop, se invalido; si despues del toque llega a tp1, funciono.
export function trackZones(prevPlan, plan, f) {
  const price = plan.price, hod = n(f?.hod), lod = n(f?.lod);
  const prev = new Map((prevPlan?.zones || []).map((z) => [z.id, z]));
  const now = new Date(plan.nowMs || Date.now()).toISOString();
  for (const z of plan.zones) {
    const p = prev.get(z.id);
    z.createdAt = p?.createdAt || now;
    z.status = p?.status || 'nueva';
    z.touchedAt = p?.touchedAt || null;
    z.lodAt0 = p?.lodAt0 ?? lod; z.hodAt0 = p?.hodAt0 ?? hod;
    if (p && z.status === 'nueva') z.status = 'activa';
    const touched = z.side === 'long'
      ? (lod !== null && z.lodAt0 !== null && lod < z.lodAt0 && lod <= z.hi) || z.inside
      : (hod !== null && z.hodAt0 !== null && hod > z.hodAt0 && hod >= z.lo) || z.inside;
    if (touched && !z.touchedAt && (z.status === 'nueva' || z.status === 'activa')) { z.status = 'tocada'; z.touchedAt = now; }
    if (z.status === 'tocada') {
      if ((z.side === 'long' && price < z.stop) || (z.side === 'short' && price > z.stop)) z.status = 'invalidada';
      else if ((z.side === 'long' && price >= z.tp1) || (z.side === 'short' && price <= z.tp1)) z.status = 'funciono';
    }
  }
  // zonas que salieron del plan pero se tocaron: se guardan para el registro del dia
  const gone = [];
  for (const [id, p] of prev) {
    if (!plan.zones.some((z) => z.id === id) && (p.status === 'tocada' || p.status === 'funciono' || p.status === 'invalidada')) gone.push(p);
  }
  return gone;
}
