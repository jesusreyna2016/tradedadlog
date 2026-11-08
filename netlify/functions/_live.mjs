// Vigilante en vivo de Mi Mesa sobre la API de MyFundedPerps (solo lectura).
// live-cron lo corre cada minuto y manda avisos push en el momento:
//   · entraste SIN PLAN       (no habia un plan abierto en Mi Mesa para ese mercado y lado)
//   · REVANCHA                (abriste otra antes de que terminara la pausa tras una perdida)
//   · posicion SIN STOP       (60 s despues de abrir, no hay orden stop que la cierre)
//   · cerraste en PERDIDA     (empieza la pausa)
//   · te queda POCO           (el margen al limite diario o al de la cuenta ya no alcanza para un trade)
//   · se acabo tu HORARIO     (fin de cada ventana de trading)
//   · posicion DEMASIADO GRANDE (mueve mas de maxSizeX veces el tamaño de la cuenta)
//   · COMISIONES del dia pasaron tu limite (feeDayCap)
//   · INACTIVIDAD: a la cuenta le quedan 2 dias o menos antes de perderse por no operar
//   · PERDISTE UNA CUENTA: empieza una pausa (lostPauseH); abrir algo antes avisa
//   · FONDEADA: en cuentas fondeadas el tamaño maximo es fundedMaxSizeX
//   · RESUMEN SEMANAL: domingo 16:30 Chicago
// Ademas guarda un snapshot de tus cuentas (con su riesgo en vivo) que Mi Mesa lee.
//
// Store de Blobs 'live':
//   config     -> { windows, cooldownMin, matchWindowMin, riskPerTrade, feeDayCap, maxSizeX, lang }   (lo manda Mi Mesa)
//   plans      -> { plans:[{id,fam,side,ts,status,acct}] }                      (lo manda Mi Mesa)
//   snapshot   -> { updatedAt, accounts:[...], risk:{id:risk}, open:{id:[pos]} }
//   state      -> { positions:{posId:{acct,fam,side,openedAt,hasStop,stopWarned}}, lastLoss:{acct:ms}, lowWarned:{} }
//   stops      -> { posId: true }   (si la posicion tuvo stop, para importarlo)
import { getStore } from '@netlify/blobs';
import { listSubs, sendTo } from './_push.mjs';
import { hasKey, listAccounts, getAccount, openPositions, workingOrders, closedPositions, hasStop, familyOf, tradingPolicy, lastClosedAt, fillsSince } from './_mfp.mjs';

const chicago = (ms) => {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).forEach((x) => { if (x.type !== 'literal') p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, hm: `${p.hour}:${p.minute}` };
};
const $ = (v) => '$' + Math.abs(+v || 0).toFixed(0);

// Mensajes en lenguaje simple
const M = {
  noPlan: (l, acc, fam, side, hm) => l === 'en'
    ? { title: `${fam}: you entered without a plan`, body: `${acc}: ${side} at ${hm}. Write in Mi Mesa why you entered. Did you place the stop?` }
    : { title: `${fam}: entraste sin plan`, body: `${acc}: ${side === 'long' ? 'compra' : 'venta'} a las ${hm}. Escribe en Mi Mesa por qué entraste. ¿Pusiste el stop?` },
  revenge: (l, acc, fam, mins) => l === 'en'
    ? { title: `${fam}: this looks like revenge`, body: `${acc}: you entered ${mins} min after a loss, before your break ended. Protect it or close it, and step away.` }
    : { title: `${fam}: esto parece revancha`, body: `${acc}: entraste ${mins} min después de perder, antes de que terminara tu pausa. Protégelo o ciérralo, y aléjate.` },
  noStop: (l, acc, fam, room) => l === 'en'
    ? { title: `${fam}: open trade WITHOUT a stop`, body: `${acc}: place your stop now.${room != null ? ` You have ${$(room)} left before losing the account.` : ''}` }
    : { title: `${fam}: trade abierto SIN stop`, body: `${acc}: pon tu stop ya.${room != null ? ` Te quedan ${$(room)} antes de perder la cuenta.` : ''}` },
  loss: (l, acc, fam, pnl, until) => l === 'en'
    ? { title: `Loss of ${$(pnl)}: break until ${until}`, body: `${acc} · ${fam}. Get up from the chair and use the break to review the trade in Mi Mesa.` }
    : { title: `Pérdida de ${$(pnl)}: pausa hasta las ${until}`, body: `${acc} · ${fam}. Levántate de la silla y usa la pausa para revisar el trade en Mi Mesa.` },
  low: (l, acc, kind, room) => l === 'en'
    ? { title: `${acc}: only ${$(room)} left`, body: kind === 'daily' ? 'Your daily loss limit is close. One more loss could end the day for this account.' : 'You are close to losing this account. Trade small or stop.' }
    : { title: `${acc}: solo te quedan ${$(room)}`, body: kind === 'daily' ? 'Estás cerca del límite de pérdida del día. Una pérdida más puede cerrar el día en esta cuenta.' : 'Estás cerca de perder esta cuenta. Opera muy pequeño o detente.' },
  bigSize: (l, acc, fam, x, move) => l === 'en'
    ? { title: `${fam}: position too big (${x}x your account)`, body: `${acc}: ${move != null ? `a ${move}% move against you loses the account. ` : ''}Reduce it now.` }
    : { title: `${fam}: posición demasiado grande (${x} veces tu cuenta)`, body: `${acc}: ${move != null ? `un movimiento de ${move}% en contra y pierdes la cuenta. ` : ''}Redúcela ya.` },
  fees: (l, total, cap) => l === 'en'
    ? { title: `You paid ${$(total)} in fees today`, body: `That is past your ${$(cap)} limit. Every extra trade starts in the red: stop for today.` }
    : { title: `Hoy llevas ${$(total)} en comisiones`, body: `Pasaste tu límite de ${$(cap)}. Cada trade extra empieza perdiendo: para por hoy.` },
  inactive: (l, acc, days) => l === 'en'
    ? { title: `${acc}: ${days <= 0 ? 'inactivity limit today' : `${days} day(s) before inactivity`}`, body: 'MyFundedPerps closes accounts that do not trade for too long. If you want to keep it, place one small trade with a plan.' }
    : { title: `${acc}: ${days <= 0 ? 'hoy vence por inactividad' : `${days} día(s) para perderla por inactividad`}`, body: 'MyFundedPerps cierra las cuentas que pasan mucho tiempo sin operar. Si quieres conservarla, haz un trade pequeño y con plan.' },
  lost: (l, acc, h) => l === 'en'
    ? { title: `You lost ${acc}`, body: `Take a ${h} h break before trading again. Go to Mi Mesa and write what killed it.` }
    : { title: `Perdiste ${acc}`, body: `Toma una pausa de ${h} h antes de volver a operar. Entra a Mi Mesa y escribe qué la mató.` },
  afterLost: (l, acc, fam, h) => l === 'en'
    ? { title: `${fam}: you are trading right after losing an account`, body: `${acc}: your ${h} h break is not over. This is how accounts die one after another. Close it or protect it.` }
    : { title: `${fam}: estás operando justo después de perder una cuenta`, body: `${acc}: tu pausa de ${h} h no ha terminado. Así se pierden las cuentas una tras otra. Ciérralo o protégelo.` },
  week: (l, w) => l === 'en'
    ? { title: `Your week: ${w.net < 0 ? '-' : '+'}${$(w.net)} after fees`, body: `${w.n} trades · fees ${$(w.fees)} · ${w.noPlan} without a plan · ${w.big} too big · ${w.lost} account(s) lost. Next week, only one goal: ${w.goal.en}.` }
    : { title: `Tu semana: ${w.net < 0 ? '-' : '+'}${$(w.net)} después de comisiones`, body: `${w.n} trades · comisiones ${$(w.fees)} · ${w.noPlan} sin plan · ${w.big} muy grandes · ${w.lost} cuenta(s) perdida(s). La próxima semana, una sola meta: ${w.goal.es}.` },
  test: (l) => l === 'en'
    ? { title: 'Mi Mesa: test alert', body: 'If you can read this, alerts reach your phone.' }
    : { title: 'Mi Mesa: aviso de prueba', body: 'Si lees esto, los avisos llegan a tu teléfono.' },
  windowEnd: (l, open) => l === 'en'
    ? { title: 'Your trading hours are over', body: open ? 'You still have an open trade: manage it with your plan and close the platform.' : 'Close the platform and go to the Mi Mesa journal.' }
    : { title: 'Se acabó tu horario de trading', body: open ? 'Todavía tienes un trade abierto: manéjalo con tu plan y cierra la plataforma.' : 'Cierra la plataforma y ve al journal de Mi Mesa.' }
};

export async function notify(msg, tag) {
  const subs = await listSubs();
  for (const s of subs) await sendTo(s, { ...msg, tag, url: '/#hoy' });
}

const shortName = (a) => (a.name || '').replace(/ Challenge$/, '') + ' · ' + (a.account_number || a.id);

export async function runLive(nowMs = Date.now()) {
  if (!hasKey()) return { skipped: 'sin MFP_API_KEY' };
  const store = getStore('live');
  const cfg = (await store.get('config', { type: 'json' }).catch(() => null)) || {};
  const lang = cfg.lang === 'en' ? 'en' : 'es';
  const plans = ((await store.get('plans', { type: 'json' }).catch(() => null)) || {}).plans || [];
  const cooldown = (+cfg.cooldownMin || 15) * 60e3;
  const matchWin = (+cfg.matchWindowMin || 20) * 60e3;
  const riskPerTrade = +cfg.riskPerTrade || 200;
  const maxSizeX = +cfg.maxSizeX || 0;
  const feeDayCap = +cfg.feeDayCap || 0;
  const lostPause = (+cfg.lostPauseH || 0) * 3600e3;
  const fundedMaxX = +cfg.fundedMaxSizeX || 0;
  const st = (await store.get('state', { type: 'json' }).catch(() => null)) || { positions: {}, lastLoss: {}, lowWarned: {}, firstRun: true };
  const stops = (await store.get('stops', { type: 'json' }).catch(() => null)) || {};
  const log = [];
  // el dia de MFP (limite diario y comisiones del dia) cambia a medianoche de Nueva York
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));

  const accounts = await listAccounts();
  const active = accounts.filter((a) => a.status === 'active');
  const risk = {}, open = {}, inactivity = {};
  const seenPos = new Set();
  // semana (se reinicia con el resumen del domingo) y estado de cada cuenta para ver cuando se pierde
  if (!st.week) st.week = { n: 0, net: 0, fees: 0, noPlan: 0, big: 0, revenge: 0, noStop: 0, lost: 0 };
  if (!st.acctStatus) st.acctStatus = {};
  for (const a of accounts) {
    const prev = st.acctStatus[a.id];
    if (prev === 'active' && a.status === 'failed') {
      st.lostAt = nowMs; st.week.lost++;
      if (!st.firstRun) { await notify(M.lost(lang, shortName(a), +cfg.lostPauseH || 0), 'lost-' + a.id); log.push(shortName(a) + ' perdida de cuenta'); }
    }
    st.acctStatus[a.id] = a.status;
  }

  for (const a of active) {
    const name = shortName(a);
    let detail, pos, orders;
    try { [detail, pos, orders] = await Promise.all([getAccount(a.id), openPositions(a.id), workingOrders(a.id)]); }
    catch (e) { log.push(a.account_number + ': ' + e.message); continue; }
    risk[a.id] = detail.risk || null;

    // inactividad: dias de la regla de la firma desde tu ultima operacion
    try {
      const [pol, lastAt] = await Promise.all([tradingPolicy(a.id), lastClosedAt(a.id)]);
      const rule = (pol.account_rules || []).find((x) => x.id === (a.stage === 'funded' ? 'funded-inactivity' : 'evaluation-inactivity'));
      const limitDays = rule?.parameters?.days || null;
      const last = Math.max(lastAt || 0, ...pos.map((p) => p.opened_at || 0), a.created_at || 0);
      if (limitDays) {
        const left = Math.floor((last + limitDays * 86400e3 - nowMs) / 86400e3);
        inactivity[a.id] = { limitDays, lastAt: last, daysLeft: left, payoutPending: !!pol.payout_pending };
        const key = `${a.id}:inact:${today}`;
        if (!pos.length && left <= 2 && !st.lowWarned[key]) {
          st.lowWarned[key] = true;
          if (!st.firstRun) { await notify(M.inactive(lang, name, left), 'inact-' + a.id); log.push(name + ' inactividad ' + left); }
        }
      }
    } catch (e) { log.push(a.account_number + ' politica: ' + e.message); }
    open[a.id] = pos.map((p) => ({ id: p.id, symbol: p.symbol, side: p.side, size: p.size, entry: p.entry_price, openedAt: p.opened_at, stop: hasStop(p, orders) }));

    for (const p of pos) {
      seenPos.add(p.id);
      const fam = familyOf(p.symbol);
      const stopNow = hasStop(p, orders);
      if (stopNow) stops[p.id] = true;
      let k = st.positions[p.id];
      if (!k) {
        k = st.positions[p.id] = { acct: a.id, name, fam, side: p.side, openedAt: p.opened_at, stopWarned: false };
        // posicion nueva: ¿habia plan? ¿es revancha?
        if (!st.firstRun && nowMs - p.opened_at < 30 * 60e3) {
          const sinceLoss = st.lastLoss[a.id] ? p.opened_at - st.lastLoss[a.id] : Infinity;
          if (sinceLoss >= 0 && sinceLoss < cooldown) { st.week.revenge++; await notify(M.revenge(lang, name, fam, Math.round(sinceLoss / 60e3)), 'rev-' + p.id); log.push(name + ' revancha'); }
          if (lostPause && st.lostAt && p.opened_at - st.lostAt < lostPause && p.opened_at > st.lostAt) { await notify(M.afterLost(lang, name, fam, +cfg.lostPauseH), 'afterlost-' + p.id); log.push(name + ' tras perder cuenta'); }
          const plan = plans.find((x) => x.fam === fam && x.side === p.side && x.status !== 'cancelada' && (!x.acct || x.acct === a.id || x.acct === a.account_number) &&
            p.opened_at >= x.ts - 3 * 60e3 && p.opened_at <= x.ts + matchWin);
          if (!plan) { st.week.noPlan++; await notify(M.noPlan(lang, name, fam, p.side, chicago(p.opened_at).hm), 'noplan-' + p.id); log.push(name + ' sin plan ' + fam); }
          // tamaño: cuanto mueve la posicion contra el tamaño de la cuenta
          const notional = Math.abs((+p.size || 0) * (+p.entry_price || 0));
          const x = a.starting_balance ? notional / a.starting_balance : 0;
          const capX = a.stage === 'funded' && fundedMaxX > 0 ? fundedMaxX : maxSizeX;
          if (capX > 0 && x > capX) {
            st.week.big++;
            const room = detail.risk?.max_drawdown_room;
            const move = room != null && notional ? +(room / notional * 100).toFixed(2) : null;
            await notify(M.bigSize(lang, name, fam, x.toFixed(1), move), 'size-' + p.id); log.push(name + ' muy grande ' + x.toFixed(1) + 'x');
          }
        }
      }
      if (!stopNow && !k.stopWarned && nowMs - p.opened_at > 60e3) {
        k.stopWarned = true;
        st.week.noStop++;
        if (!st.firstRun) { await notify(M.noStop(lang, name, fam, detail.risk?.max_drawdown_room), 'nostop-' + p.id); log.push(name + ' sin stop ' + fam); }
      }
    }

    // poco margen: avisa una vez por dia y por tipo
    const r = detail.risk || {};
    for (const [kind, room] of [['daily', r.daily_loss_room], ['max', r.max_drawdown_room]]) {
      const key = `${a.id}:${kind}:${today}`;
      if (room != null && room < riskPerTrade && !st.lowWarned[key]) {
        st.lowWarned[key] = true;
        if (!st.firstRun) { await notify(M.low(lang, name, kind, room), `low-${kind}-${a.id}`); log.push(name + ' poco margen ' + kind); }
      }
    }
  }

  // posiciones que se cerraron desde la ultima corrida: ¿fue perdida?
  const closedIds = Object.keys(st.positions).filter((id) => !seenPos.has(id));
  const byAcct = {};
  closedIds.forEach((id) => { (byAcct[st.positions[id].acct] = byAcct[st.positions[id].acct] || []).push(id); });
  for (const [acct, ids] of Object.entries(byAcct)) {
    let closed = [];
    try { closed = await closedPositions(acct, { since: nowMs - 6 * 3600e3, maxPages: 1 }); } catch (e) { log.push('cerradas: ' + e.message); continue; }
    for (const id of ids) {
      const k = st.positions[id];
      const c = closed.find((x) => x.id === id);
      if (c) {
        const net = (+c.realized_pnl || 0) - (+c.fees || 0) + (+c.funding || 0);
        // comisiones del dia (hora de Chicago)
        if (!st.fees || st.fees.date !== today) st.fees = { date: today, total: 0, warned: false };
        st.fees.total += +c.fees || 0;
        st.week.n++; st.week.net += net; st.week.fees += +c.fees || 0;
        if (net < 0) {
          st.lastLoss[acct] = c.closed_at;
          if (nowMs - c.closed_at < 30 * 60e3) { await notify(M.loss(lang, k.name, k.fam, net, chicago(c.closed_at + cooldown).hm), 'loss-' + acct); log.push(k.name + ' perdida'); }
        }
      }
      delete st.positions[id];
    }
  }

  if (feeDayCap > 0 && st.fees?.date === today && st.fees.total >= feeDayCap && !st.fees.warned) {
    st.fees.warned = true;
    await notify(M.fees(lang, st.fees.total, feeDayCap), 'fees-' + today); log.push('comisiones ' + st.fees.total.toFixed(0));
  }

  // fin del horario: una vez en el minuto en que termina cada ventana
  const c = chicago(nowMs);
  const anyOpen = Object.values(open).some((l) => l.length);
  for (const w of cfg.windows || []) {
    const m = String(w).match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!m) continue;
    const end = +m[3] * 60 + +m[4];
    const key = `winend:${c.date}:${w}`;
    if (c.min >= end && c.min < end + 2 && !st.lowWarned[key]) {
      st.lowWarned[key] = true;
      await notify(M.windowEnd(lang, anyOpen), 'window-end');
      log.push('fin de horario ' + w);
    }
  }

  // resumen semanal: domingo 16:30-16:31 Chicago
  const dow = new Date(c.date + 'T12:00:00Z').getUTCDay();
  const wkKey = 'week:' + c.date;
  if (dow === 0 && c.min >= 16 * 60 + 30 && c.min < 16 * 60 + 32 && !st.lowWarned[wkKey]) {
    st.lowWarned[wkKey] = true;
    const w = st.week;
    const goals = [
      [w.lost * 3, { es: 'no perder ninguna cuenta (respeta tu pausa)', en: 'lose no account (respect your break)' }],
      [w.big * 2, { es: `ninguna posición de más de ${maxSizeX || 3} veces la cuenta`, en: `no position over ${maxSizeX || 3}x the account` }],
      [w.noPlan, { es: 'cero trades sin plan', en: 'zero trades without a plan' }],
      [w.revenge * 2, { es: 'respetar la pausa después de cada pérdida', en: 'respect the break after each loss' }],
      [feeDayCap && w.fees > feeDayCap * 5 ? 3 : 0, { es: 'menos trades: las comisiones se comen todo', en: 'fewer trades: fees eat everything' }]
    ].sort((a, b) => b[0] - a[0]);
    const goal = goals[0][0] > 0 ? goals[0][1] : { es: 'repetir esta disciplina', en: 'repeat this discipline' };
    if (w.n || w.lost) { await notify(M.week(lang, { ...w, goal }), 'week'); log.push('resumen semanal'); }
    st.lastWeek = { ...w, at: nowMs };
    st.week = { n: 0, net: 0, fees: 0, noPlan: 0, big: 0, revenge: 0, noStop: 0, lost: 0 };
  }

  // limpieza de marcas viejas
  for (const k of Object.keys(st.lowWarned)) if (!k.includes(today)) delete st.lowWarned[k];
  st.firstRun = false;
  await store.setJSON('state', st);
  await store.setJSON('stops', stops);
  await store.setJSON('snapshot', {
    updatedAt: nowMs,
    accounts: accounts.map((a) => ({ id: a.id, number: a.account_number, name: a.name, stage: a.stage, status: a.status, startingBalance: a.starting_balance, balance: a.balance, createdAt: Math.round(a.created_at) })),
    risk, open, inactivity, week: st.week, lastWeek: st.lastWeek || null, lostAt: st.lostAt || null
  });
  return { ok: true, active: active.length, log };
}

// Ejecuciones para el analisis de Mi Mesa (campos minimos)
export async function fillsForImport(acctIds, since) {
  const out = [];
  for (const id of acctIds) {
    const list = await fillsSince(id, { since, maxPages: since ? 3 : 15 });
    for (const f of list) out.push({ account_id: f.account_id, symbol: f.symbol, side: f.side, type: f.type, role: f.liquidity_role || null, reduce_only: !!f.reduce_only,
      fee: +f.fee || 0, notional: +f.notional || 0, size: +f.size || 0, fill_price: +f.fill_price || 0, expected_price: f.expected_price != null ? +f.expected_price : null, at: f.settled_at });
  }
  return out;
}

// Posiciones cerradas para importar en Mi Mesa (con la marca de stop si el vigilante la vio)
export async function closedForImport(acctIds, since) {
  const store = getStore('live');
  const stops = (await store.get('stops', { type: 'json' }).catch(() => null)) || {};
  const out = [];
  for (const id of acctIds) {
    const list = await closedPositions(id, { since, maxPages: since ? 3 : 20 });
    for (const p of list) out.push({ ...p, had_stop: stops[p.id] ? true : p.close_reason === 'stop_loss' ? true : undefined });
  }
  return out;
}
