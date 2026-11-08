// Vigilante en vivo de Mi Mesa sobre la API de MyFundedPerps (solo lectura).
// live-cron lo corre cada minuto y manda avisos push en el momento:
//   · entraste SIN PLAN       (no habia un plan abierto en Mi Mesa para ese mercado y lado)
//   · REVANCHA                (abriste otra antes de que terminara la pausa tras una perdida)
//   · posicion SIN STOP       (60 s despues de abrir, no hay orden stop que la cierre)
//   · cerraste en PERDIDA     (empieza la pausa)
//   · te queda POCO           (el margen al limite diario o al de la cuenta ya no alcanza para un trade)
//   · se acabo tu HORARIO     (fin de cada ventana de trading)
// Ademas guarda un snapshot de tus cuentas (con su riesgo en vivo) que Mi Mesa lee.
//
// Store de Blobs 'live':
//   config     -> { windows, cooldownMin, matchWindowMin, riskPerTrade, lang }   (lo manda Mi Mesa)
//   plans      -> { plans:[{id,fam,side,ts,status,acct}] }                      (lo manda Mi Mesa)
//   snapshot   -> { updatedAt, accounts:[...], risk:{id:risk}, open:{id:[pos]} }
//   state      -> { positions:{posId:{acct,fam,side,openedAt,hasStop,stopWarned}}, lastLoss:{acct:ms}, lowWarned:{} }
//   stops      -> { posId: true }   (si la posicion tuvo stop, para importarlo)
import { getStore } from '@netlify/blobs';
import { listSubs, sendTo } from './_push.mjs';
import { hasKey, listAccounts, getAccount, openPositions, workingOrders, closedPositions, hasStop, familyOf } from './_mfp.mjs';

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
  windowEnd: (l, open) => l === 'en'
    ? { title: 'Your trading hours are over', body: open ? 'You still have an open trade: manage it with your plan and close the platform.' : 'Close the platform and go to the Mi Mesa journal.' }
    : { title: 'Se acabó tu horario de trading', body: open ? 'Todavía tienes un trade abierto: manéjalo con tu plan y cierra la plataforma.' : 'Cierra la plataforma y ve al journal de Mi Mesa.' }
};

async function notify(msg, tag) {
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
  const st = (await store.get('state', { type: 'json' }).catch(() => null)) || { positions: {}, lastLoss: {}, lowWarned: {}, firstRun: true };
  const stops = (await store.get('stops', { type: 'json' }).catch(() => null)) || {};
  const log = [];
  const today = chicago(nowMs).date;

  const accounts = await listAccounts();
  const active = accounts.filter((a) => a.status === 'active');
  const risk = {}, open = {};
  const seenPos = new Set();

  for (const a of active) {
    const name = shortName(a);
    let detail, pos, orders;
    try { [detail, pos, orders] = await Promise.all([getAccount(a.id), openPositions(a.id), workingOrders(a.id)]); }
    catch (e) { log.push(a.account_number + ': ' + e.message); continue; }
    risk[a.id] = detail.risk || null;
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
          if (sinceLoss >= 0 && sinceLoss < cooldown) { await notify(M.revenge(lang, name, fam, Math.round(sinceLoss / 60e3)), 'rev-' + p.id); log.push(name + ' revancha'); }
          const plan = plans.find((x) => x.fam === fam && x.side === p.side && x.status !== 'cancelada' && (!x.acct || x.acct === a.id || x.acct === a.account_number) &&
            p.opened_at >= x.ts - 3 * 60e3 && p.opened_at <= x.ts + matchWin);
          if (!plan) { await notify(M.noPlan(lang, name, fam, p.side, chicago(p.opened_at).hm), 'noplan-' + p.id); log.push(name + ' sin plan ' + fam); }
        }
      }
      if (!stopNow && !k.stopWarned && nowMs - p.opened_at > 60e3) {
        k.stopWarned = true;
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
        if (net < 0) {
          st.lastLoss[acct] = c.closed_at;
          if (nowMs - c.closed_at < 30 * 60e3) { await notify(M.loss(lang, k.name, k.fam, net, chicago(c.closed_at + cooldown).hm), 'loss-' + acct); log.push(k.name + ' perdida'); }
        }
      }
      delete st.positions[id];
    }
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

  // limpieza de marcas viejas
  for (const k of Object.keys(st.lowWarned)) if (!k.includes(today)) delete st.lowWarned[k];
  st.firstRun = false;
  await store.setJSON('state', st);
  await store.setJSON('stops', stops);
  await store.setJSON('snapshot', {
    updatedAt: nowMs,
    accounts: accounts.map((a) => ({ id: a.id, number: a.account_number, name: a.name, stage: a.stage, status: a.status, startingBalance: a.starting_balance, balance: a.balance, createdAt: Math.round(a.created_at) })),
    risk, open
  });
  return { ok: true, active: active.length, log };
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
