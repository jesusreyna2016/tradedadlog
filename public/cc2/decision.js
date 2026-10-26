// The decision engine: folds the confirmed Trend Checklist verdict, Market Regime, the AI coach plan
// and the gatekeeper into one plain-language answer to "can I trade this symbol right now?".
import { T, L } from './i18n.js';
import { store, tickOf, symName, isCrypto } from './api.js';
import { gateState, MAX_TRADES } from './gate.js';

const TREND_STALE_MIN = 75, REGIME_STALE_MIN = 40, PLAN_STALE_MIN = 360;
const ACTIONABLE = ['A_FAVOR_BORDE', 'REVERSAL', 'REVERSAL_IFVG'];
export const NEAR_TICKS = 20;   // "you're close to a level" radius
const FAR_TICKS = 100;          // no level within this = "in the air"

const ageMin = iso => (iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity);
const sgn = d => (d === 'LONG' || d === 'BULL' ? 1 : d === 'SHORT' || d === 'BEAR' ? -1 : 0);

export function fmt(n, sym) {
  if (n == null || !isFinite(n)) return '-';
  const dec = sym === 'YM' ? 0 : 2;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
const fmtRange = (a, b, sym) => fmt(Math.min(a, b), sym) + T(' a ', ' to ') + fmt(Math.max(a, b), sym);
const clip = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n)) + '…');
const pts = (n, sym) => (sym === 'YM' ? Math.round(n) : Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2));

export const LEVEL_NAMES = {
  pdh: ['Máximo de ayer', "Yesterday's high"], pdl: ['Mínimo de ayer', "Yesterday's low"],
  vah: ['Parte alta del valor', 'Value area high'], val: ['Parte baja del valor', 'Value area low'],
  poc: ['Precio más negociado', 'Most traded price'], vwap: ['VWAP', 'VWAP'],
  dayOpen: ['Apertura del día', "Today's open"], tdo: ['Apertura de medianoche', 'Midnight open'],
  orH: ['Máximo del rango inicial', 'Opening range high'], orL: ['Mínimo del rango inicial', 'Opening range low'],
  pwh: ['Máximo de la semana pasada', "Last week's high"], pwl: ['Mínimo de la semana pasada', "Last week's low"],
  edge: ['Línea de stop de la tendencia', 'Trend stop line'], flip: ['Línea de cambio de tendencia', 'Trend flip line'],
};
const lname = k => T(LEVEL_NAMES[k][0], LEVEL_NAMES[k][1]);

// the coach's instrument for this symbol (crypto comes from the weekend plan)
export function coachFor(sym) {
  if (isCrypto(sym)) {
    const ins = store.saCrypto && store.saCrypto.instruments;
    return ins ? ins[sym] || ins[symName(sym)] || null : null;
  }
  return store.sa && store.sa.instruments ? store.sa.instruments[sym] || null : null;
}

export function newsLock(now = Date.now()) {
  const ev = (store.news || []).find(e => e.impact === 'high' && e.currency === 'USD' && Math.abs(e.ts - now) <= 15 * 60000);
  return ev || null;
}

export function levelList(sym, p, tr) {
  const out = [];
  const Lv = (p && p.levels) || {};
  ['pwh', 'pdh', 'vah', 'poc', 'val', 'pdl', 'pwl', 'vwap', 'dayOpen', 'tdo', 'orH', 'orL'].forEach(k => {
    if (Lv[k] != null && isFinite(Lv[k])) out.push({ k, name: lname(k), px: +Lv[k] });
  });
  if (tr) {
    if (isFinite(parseFloat(tr.edge))) out.push({ k: 'edge', name: lname('edge'), px: parseFloat(tr.edge) });
    if (isFinite(parseFloat(tr.flip))) out.push({ k: 'flip', name: lname('flip'), px: parseFloat(tr.flip) });
  }
  return out;
}

export function decide(sym) {
  const p0 = store.plan[sym];
  const p = p0 && ageMin(p0.updatedAt) < PLAN_STALE_MIN ? p0 : null;
  const tr0 = store.trend && store.trend[sym];
  const tr = tr0 && ageMin(tr0.receivedAt) < TREND_STALE_MIN ? tr0 : null;
  const rg0 = store.regime && store.regime[sym];
  const rg = rg0 && ageMin(rg0.receivedAt) < REGIME_STALE_MIN ? rg0 : null;
  const co = coachFor(sym);
  const gate = gateState();
  const price = p ? +p.price : rg ? parseFloat(rg.close) : tr ? parseFloat(tr.px) : null;
  const tick = tickOf(sym);
  const name = symName(sym);

  // ---- direction
  const tv = tr ? Number(tr.v) : null;
  const trendDir = tv == null ? 0 : Math.sign(tv);
  const regimeDir = rg ? sgn(rg.regime) : 0;
  const coachDir = co ? sgn(String(co.biasSession || co.biasDay || '').toUpperCase()) : 0;
  const coachSig = co && co.verdict ? String(co.verdict.signal || '').toUpperCase() : '';
  const planDir = p ? sgn(p.biasDir) : 0;
  const structUp = p && /choch up/i.test(p.struct || ''), structDn = p && /choch down/i.test(p.struct || '');
  let dir = 0, conflict = '';
  if (tr) {
    dir = trendDir;
    if (dir && coachDir === -dir) { dir = 0; conflict = T('La tendencia y el coach apuntan a lados opuestos.', 'The trend and the coach point opposite ways.'); }
  } else if (coachDir) {
    dir = coachDir;
    if (planDir === -coachDir) { dir = 0; conflict = T('El coach y el indicador no coinciden en la dirección.', "The coach and the indicator don't agree on direction."); }
  } else if (planDir) {
    dir = planDir;
    if ((dir < 0 && structUp) || (dir > 0 && structDn)) {
      const leanDown = dir < 0;
      dir = 0;
      conflict = leanDown
        ? T('A corto plazo giró hacia arriba, pero el día sigue inclinado a la baja.', 'Short-term it turned up, but the day still leans down.')
        : T('A corto plazo giró hacia abajo, pero el día sigue inclinado al alza.', 'Short-term it turned down, but the day still leans up.');
    }
  }
  const dirWord = dir > 0 ? T('Arriba (largo)', 'Up (long)') : dir < 0 ? T('Abajo (corto)', 'Down (short)') : T('No está claro', 'Not clear');
  const onlyWord = dir > 0 ? T('Solo largos.', 'Longs only.') : T('Solo cortos.', 'Shorts only.');

  // ---- the four inputs
  const inputs = [];
  if (tr) {
    const tf = x => (Number(x) > 0 ? T('arriba', 'up') : Number(x) < 0 ? T('abajo', 'down') : T('sin lado', 'no side'));
    const v = tv > 0 ? T('Apunta hacia arriba', 'Pointing up') : tv < 0 ? T('Apunta hacia abajo', 'Pointing down') : T('Sin dirección clara', 'No clear direction');
    const live = Number(tr.vl) !== tv ? T(' La vela abierta ya marca otra cosa, pero solo cuenta al cerrar.', ' The open candle says otherwise, but it only counts once it closes.') : '';
    inputs.push({ key: 'trend', k: T('Panorama general', 'Big picture'), src: 'Trend Checklist', v,
      s: T('Diario ', 'Daily ') + tf(tr.d) + ' · 4H ' + tf(tr.h4) + ' · 1H ' + tf(tr.h1) + '.' + live,
      tone: tv > 0 ? 'pos' : tv < 0 ? 'neg' : 'wait', agrees: dir !== 0 && trendDir === dir });
  } else {
    inputs.push({ key: 'trend', k: T('Panorama general', 'Big picture'), src: 'Trend Checklist',
      v: tr0 ? T('Datos viejos', 'Data is stale') : T('Sin datos para ', 'No data for ') + name,
      s: tr0 ? T('La última lectura tiene más de una hora. Revisa la alerta en TradingView.', 'The last reading is over an hour old. Check the alert in TradingView.')
             : T('Agrega la alerta del Trend Checklist en tu gráfico de ' + name + ' para activarlo.', 'Add the Trend Checklist alert on your ' + name + ' chart to turn this on.'),
      tone: 'muted', agrees: false });
  }
  if (rg) {
    const r = rg.regime;
    const v = r === 'CHOP' ? T('Picado, de lado', 'Choppy, moving sideways') : r === 'BULL' ? T('Tendencia hacia arriba', 'Trending up') : r === 'BEAR' ? T('Tendencia hacia abajo', 'Trending down') : T('Cambiando, sin ánimo claro', 'Changing, no clear mood');
    let s = '';
    if (r === 'CHOP' && rg.top && rg.bot) {
      const out = price != null && (price > +rg.top || price < +rg.bot);
      s = out ? T('Estaba encerrado entre ' + fmt(+rg.bot, sym) + ' y ' + fmt(+rg.top, sym) + ' y acaba de salir.', 'It was stuck between ' + fmt(+rg.bot, sym) + ' and ' + fmt(+rg.top, sym) + ' and just broke out.')
              : T('Atrapado entre ' + fmt(+rg.bot, sym) + ' y ' + fmt(+rg.top, sym) + '. Todavía no rompe.', 'Stuck between ' + fmt(+rg.bot, sym) + ' and ' + fmt(+rg.top, sym) + '. No breakout yet.');
    } else if (r === 'BULL' || r === 'BEAR') s = T('Entra a favor, no contra el movimiento.', 'Trade with the move, not against it.');
    else s = T('Sin rango ni ruptura con qué trabajar.', 'No range and no breakout to work with.');
    inputs.push({ key: 'regime', k: T('Ánimo del mercado', 'Market mood'), src: 'Market Regime', v, s,
      tone: r === 'CHOP' ? 'wait' : r === 'BULL' ? 'pos' : r === 'BEAR' ? 'neg' : 'muted', agrees: dir !== 0 && regimeDir === dir });
  } else {
    inputs.push({ key: 'regime', k: T('Ánimo del mercado', 'Market mood'), src: 'Market Regime',
      v: T('Sin datos recientes', 'No recent data'), s: T('El Market Regime no ha mandado nada en los últimos 40 min.', "Market Regime hasn't sent anything in the last 40 min."), tone: 'muted', agrees: false });
  }
  if (co) {
    const v = coachSig === 'GO' ? T('Hay oportunidad', 'There is a chance') : coachSig === 'AVOID' ? T('Mejor no operarlo', 'Better to skip it') : T('Espera un setup limpio', 'Wait for a clean setup');
    inputs.push({ key: 'coach', k: T('Plan del coach IA', 'AI coach plan'), src: 'Session Analyst', v,
      s: clip(L(co.verdict && co.verdict.reason).split(/ -- |\. /)[0], 170),
      tone: coachSig === 'GO' ? 'pos' : coachSig === 'AVOID' ? 'neg' : 'wait',
      agrees: dir !== 0 && coachDir === dir && coachSig !== 'AVOID' });
  } else {
    inputs.push({ key: 'coach', k: T('Plan del coach IA', 'AI coach plan'), src: 'Session Analyst',
      v: isCrypto(sym) ? T('Hoy no hay plan cripto', 'No crypto plan today') : T('Todavía sin plan', 'No plan yet'),
      s: isCrypto(sym) ? T('El coach escribe el plan cripto los fines de semana.', 'The coach writes a crypto plan on weekends.') : T('El coach publica antes de cada sesión.', 'The coach publishes before each session.'),
      tone: 'muted', agrees: false });
  }
  const used = gate.used || 0;
  const gv = { open: T('Puedes operar', "You're clear to trade"), inTrade: T('Estás dentro de un trade', "You're in a trade"),
    pause: T('Pausa corriendo', 'Pause running'), cap: T('Ya terminaste por hoy', "You're done for today"), ritual: T('Falta tu rutina', 'Routine not done') }[gate.kind];
  inputs.push({ key: 'gate', k: T('Tu portero', 'Your gatekeeper'), src: T('tus reglas', 'your rules'), v: gv,
    s: T(used + ' de ' + MAX_TRADES + ' trades usados', used + ' of ' + MAX_TRADES + ' trades used') + (gate.kind === 'ritual' ? T(', rutina pendiente.', ', routine still to do.') : gate.kind === 'pause' ? '.' : T(', sin pausa activa.', ', no pause running.')),
    tone: gate.ok ? 'pos' : gate.kind === 'cap' ? 'neg' : 'wait', agrees: gate.ok });
  const agree = inputs.filter(i => i.agrees).length;

  // ---- where: the coach's zones first, then the plan levels in the trade's direction
  let where = null, whereSub = '', trigger = '', zoneHit = null;
  if (price != null) {
    const zones = ((co && co.zones) || [])
      .filter(z => Array.isArray(z.range) && z.range.length === 2 && (!dir || sgn(z.dir) === dir) && (z.confluence == null || z.confluence >= 3))
      .map(z => ({ z, lo: Math.min(...z.range), hi: Math.max(...z.range) }))
      .map(o => ({ ...o, dist: price >= o.lo && price <= o.hi ? 0 : Math.min(Math.abs(price - o.lo), Math.abs(price - o.hi)) }))
      .sort((a, b) => a.dist - b.dist);
    if (zones.length) {
      const a = zones[0];
      where = fmtRange(a.lo, a.hi, sym); zoneHit = a;
      whereSub = a.dist === 0 ? T('El precio está ahí ahora.', 'Price is right there now.')
        : T('A ' + pts(a.dist, sym) + ' pts ' + (price > a.hi ? 'abajo' : 'arriba') + ' del precio.', pts(a.dist, sym) + ' pts ' + (price > a.hi ? 'below' : 'above') + ' price.');
      if (zones[1]) whereSub += T(' Zona de respaldo: ', ' Backup spot: ') + fmtRange(zones[1].lo, zones[1].hi, sym) + '.';
      trigger = L(a.z.play && a.z.play.trigger);
    } else {
      const lv = levelList(sym, p, tr).filter(l => (dir > 0 ? l.px <= price : dir < 0 ? l.px >= price : true))
        .map(l => ({ ...l, dist: Math.abs(l.px - price) })).sort((a, b) => a.dist - b.dist);
      if (lv.length) {
        const a = lv[0];
        where = fmt(a.px, sym);
        whereSub = a.name + ', ' + (a.dist < tick * 4 ? T('justo en el precio.', 'right at price.') : T(pts(a.dist, sym) + ' pts ' + (a.px < price ? 'abajo' : 'arriba') + ' del precio.', pts(a.dist, sym) + ' pts ' + (a.px < price ? 'below' : 'above') + ' price.'));
        zoneHit = { lo: a.px, hi: a.px, dist: a.dist };
      }
    }
  }
  if (!trigger && store.sa && store.sa.focus && store.sa.focus.sym === sym) trigger = L(store.sa.focus.trigger);
  if (!trigger) trigger = dir < 0 ? T('El precio entra a la zona, falla, y una vela de 5 min cierra de vuelta abajo.', 'Price pushes into the zone, fails, and a 5 min candle closes back below it.')
    : dir > 0 ? T('El precio baja a la zona, aguanta, y una vela de 5 min cierra de vuelta arriba.', 'Price dips into the zone, holds, and a 5 min candle closes back above it.')
    : T('El precio llega al nivel y reacciona claro hacia un lado.', 'Price reaches the level and reacts clearly one way.');

  // nearest level of any kind, for "in the air" detection
  const nearestAny = price == null ? null : levelList(sym, p, tr).map(l => Math.abs(l.px - price)).sort((a, b) => a - b)[0];
  const inAir = nearestAny != null && nearestAny > FAR_TICKS * tick;

  // ---- verdict
  let verdict, why, tone, agreeSub;
  const nl = newsLock();
  const sig = p ? p.signal : null;
  if (gate.kind === 'pause') {
    verdict = T('En pausa. Planea tu siguiente movimiento.', 'Paused. Plan your next move.'); tone = 'muted';
    why = T('El trading queda bloqueado hasta que acabe el tiempo y escribas tu siguiente trade. Todo lo de abajo se sigue actualizando: usa el tiempo para planear.',
      'Trading is locked until the timer ends and your next trade is written down. Everything below keeps updating, so use the time to plan.');
  } else if (nl) {
    verdict = T('Noticia fuerte ahora. Manos fuera.', 'Big news now. Hands off.'); tone = 'neg';
    why = T('"' + nl.title + '" sale cerca de ahora. El precio puede saltar sin aviso. Espera 15 minutos después de la noticia.', '"' + nl.title + '" is out around now. Price can jump without warning. Wait 15 minutes after the release.');
  } else if (gate.kind === 'cap') {
    verdict = T('Terminaste por hoy.', "You're done for today."); tone = 'muted';
    why = T('Usaste tus ' + MAX_TRADES + ' trades. El sexto no existe: cierra la plataforma y vuelve mañana.', 'You used all ' + MAX_TRADES + ' trades. There is no sixth one: close the platform and come back tomorrow.');
  } else if (gate.kind === 'ritual') {
    verdict = T('Primero tu rutina.', 'Routine first.'); tone = 'wait';
    why = T('Antes de abrir el gráfico, dos minutos en frío: tu plan, tu límite diario y tu tope de trades. Luego te digo si hay trade.', 'Before you open the chart, two cold minutes: your plan, your daily limit and your trade cap. Then I tell you if there is a trade.');
  } else if (gate.kind === 'inTrade') {
    const o = gate.open;
    verdict = T('Estás dentro de un trade.', "You're in a trade."); tone = 'calm';
    why = T('Entraste ' + (o.dir === 'LONG' ? 'en largo' : 'en corto') + ' a las ' + o.t + '. Maneja el trade con tu plan, no con la emoción, y marca cómo terminó.',
      'You went ' + (o.dir === 'LONG' ? 'long' : 'short') + ' at ' + o.t + '. Manage it with your plan, not your feelings, and mark how it ended.');
  } else if (!p && !tr && !rg) {
    verdict = T('Todavía sin datos.', 'No data yet.'); tone = 'muted';
    why = T('Ningún indicador de ' + name + ' ha mandado datos recientes. Revisa que las alertas de TradingView estén corriendo.', 'None of the ' + name + ' indicators has sent fresh data. Check that the TradingView alerts are running.');
  } else if (!dir) {
    verdict = T('No hay trade claro. Quédate fuera.', 'No clear trade. Sit out.'); tone = 'muted';
    why = conflict
      ? conflict + ' ' + T('Cuando las señales discuten entre sí, lo mejor es esperar a que gane un lado.', 'When the signals argue with each other, the best move is to wait until one side wins.')
      : T('Ninguna señal apunta a un lado todavía. Espera a que el precio elija uno en un nivel.', "None of the signals points to a side yet. Wait for price to pick one at a level.");
  } else if (coachSig === 'AVOID') {
    verdict = T('Sáltalo hoy.', 'Skip it today.'); tone = 'neg';
    why = T('El coach marcó ' + name + ' para evitar hoy. ', 'The coach flagged ' + name + ' to avoid today. ') + L(co.verdict.reason).split(/ -- |\. /)[0];
  } else if (sig === 'NOTRADE' && inAir) {
    verdict = T('Nada cerca. Manos fuera.', 'Nothing nearby. Hands off.'); tone = 'muted';
    why = T('El precio está en medio de la nada, lejos de cualquier nivel. Entrar aquí es adivinar. Espera a que llegue a un nivel.', 'Price is in the middle of nowhere, far from any level. Entering here is guessing. Wait for it to reach a level.');
  } else if (ACTIONABLE.includes(sig) && planDir === dir && agree >= 3) {
    verdict = T('Adelante. Busca tu entrada.', 'Go. Look for your entry.'); tone = 'pos';
    why = T('El precio está en un nivel a favor de la tendencia y casi todo coincide. Entra solo cuando veas tu gatillo, no antes.', 'Price is at a level with the trend and almost everything agrees. Enter only when you see your trigger, not before.');
  } else {
    verdict = T('Espera. ', 'Wait. ') + onlyWord; tone = 'wait';
    const big = dir < 0 ? T('El panorama apunta hacia abajo', 'The bigger picture is pointing down') : T('El panorama apunta hacia arriba', 'The bigger picture is pointing up');
    const mid = rg && rg.regime === 'CHOP' ? T(', pero el precio sigue rebotando dentro de un rango.', ', but price is still bouncing inside a range.') : '.';
    const go = where ? T(' No lo persigas. Deja que llegue a la zona de ' + where + ' y te muestre la reacción.', " Don't chase it. Let it come to the " + where + ' area and show you the reaction.') : T(' No lo persigas: espera a que llegue a un nivel.', " Don't chase it: wait for it to reach a level.");
    why = big + mid + go;
  }
  if (gate.kind === 'pause') agreeSub = T('En pausa, las señales no cuentan.', 'Paused, signals not counted.');
  else {
    const yes = inputs.filter(i => i.agrees).map(i => i.k.toLowerCase());
    agreeSub = !dir ? T('Sin dirección clara, solo cuenta tu portero.', 'No clear direction, only your gatekeeper counts.')
      : yes.length ? T('Dicen que sí: ', 'Saying yes: ') + yes.join(', ') + '.' : T('Nada coincide todavía.', 'Nothing agrees yet.');
  }

  return { sym, name, price, dir, dirWord, dirSub: conflict || (dir ? T('Ir al otro lado hoy es pelear contra la tendencia.', 'Going the other way today means fighting the trend.') : T('Espera a que un lado gane.', 'Wait for one side to win.')),
    where: where || '-', whereSub: whereSub || T('Todavía sin precio.', 'No price yet.'), trigger, verdict, why, tone, agree, agreeSub, inputs, gate, zoneHit, plan: p, trend: tr, regime: rg, coach: co, newsLock: nl };
}
