// Retiros (payouts) de las cuentas fondeadas de MyFundedPerps.
// La API no tiene historial de retiros: solo dice si hay uno pedido (trading-policy.payout_pending) y da el saldo.
// Pero el saldo realizado es exacto: saldo = saldo inicial + suma de las posiciones cerradas (pnl + funding - fees)
// hasta que MFP paga un retiro y lo descuenta. Esa diferencia es lo retirado.
// Se registra un retiro solo si sube lo retirado Y hubo un pago pedido en los ultimos 7 dias, para no confundir
// con un descuadre de otro tipo. Lo que se registra es lo DESCONTADO de la cuenta (antes del reparto).
import { closedPositions } from './_mfp.mjs';

const CHECK_MS = 60 * 60e3;          // repaso normal: una vez por hora por cuenta
const PENDING_WINDOW = 7 * 86400e3;  // el retiro tiene que llegar hasta 7 dias despues de verlo pedido
const MIN_USD = 25;
const KEEP_MS = 120 * 86400e3;
const r2 = (v) => Math.round(v * 100) / 100;

export const withdrawnOf = (acct, positions) => {
  const net = positions.reduce((s, p) => s + (+p.realized_pnl || 0) - (+p.fees || 0) + (+p.funding || 0), 0);
  return Math.max(0, r2((+acct.starting_balance || 0) + net - (+acct.balance || 0)));
};

// st.payout = { [accountId]: { withdrawn, checkedAt, pendingAt } }, st.payouts = [eventos]
export async function trackPayouts(st, accounts, policyById, nowMs, closedFn = closedPositions) {
  st.payout = st.payout || {};
  st.payouts = (st.payouts || []).filter((e) => nowMs - e.at < KEEP_MS);
  const fresh = [];
  for (const a of accounts.filter((x) => x.stage === 'funded' && x.status === 'active')) {
    const s = st.payout[a.id] = st.payout[a.id] || { withdrawn: null, checkedAt: -Infinity, pendingAt: 0 };
    const pending = !!policyById[a.id]?.payout_pending;
    const flipped = s.wasPending && !pending;          // estaba pedido y ya no: probablemente se pago
    if (pending) s.pendingAt = nowMs;
    s.wasPending = pending;
    if (!flipped && nowMs - s.checkedAt < CHECK_MS) continue;
    let w;
    try { w = withdrawnOf(a, await closedFn(a.id, { since: 0, maxPages: 30 })); } catch (e) { continue; }
    s.checkedAt = nowMs;
    if (s.withdrawn == null) { s.withdrawn = w; continue; }   // primera vez: punto de partida, sin evento
    const diff = r2(w - s.withdrawn);
    if (diff >= MIN_USD && nowMs - (s.pendingAt || 0) < PENDING_WINDOW) {
      const ev = { id: a.id + ':' + nowMs, accountId: a.id, number: a.account_number, amount: diff, at: nowMs };
      st.payouts.push(ev); fresh.push(ev);
    }
    s.withdrawn = w;
  }
  return fresh;
}
