// Recorrido del precio de cada posicion abierta: el mejor y el peor precio que tuvo mientras estuvo abierta.
// Sirve para saber cuanto quedo sobre la mesa (mejor precio vs salida) en cada trade de MyFundedPerps.
//
// La API de MFP no da precio de mercado ni velas, y las posiciones se ejecutan en el mercado de su proveedor
// (casi todas en Ostium: XYZ100 = NDX, que va 10-45 puntos por encima del XYZ100 de Hyperliquid). Por eso se
// muestrea el precio del propio proveedor una vez por minuto, en cada vuelta del vigilante (live-cron).
// Limites: una muestra por minuto no ve las mechas dentro del minuto (la cifra queda corta, nunca larga), y
// solo cubre posiciones abiertas desde que esto esta desplegado.

const OSTIUM = 'https://metadata-backend.ostium.io/PricePublish/latest-prices';
const HYPER = 'https://api.hyperliquid.xyz/info';
const OSTIUM_ALIAS = { SP500: 'SPX' };   // moneda en MFP -> "from" en Ostium, cuando no coinciden
const KEEP_MS = 14 * 86400e3;

const timed = (url, init = {}, ms = 3500) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

// Precio actual por market_id ("ostium|NDX") de los mercados con posicion abierta. Lo que falle queda fuera.
export async function latestPrices(positions, fetchImpl = timed) {
  const out = {};
  const need = (prov) => [...new Set(positions.filter((p) => p.provider === prov && p.coin).map((p) => p.coin))];
  const ost = need('ostium');
  if (ost.length) {
    try {
      const list = await (await fetchImpl(OSTIUM)).json();
      for (const coin of ost) {
        const from = OSTIUM_ALIAS[coin] || coin;
        const q = (Array.isArray(list) ? list : []).find((x) => x.from === from && x.to === 'USD');
        if (q && +q.mid > 0) out['ostium|' + coin] = +q.mid;
      }
    } catch (e) { /* sin precio esta vuelta */ }
  }
  for (const coin of need('hyperliquid')) {
    try {
      const now = Date.now();
      const body = JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1m', startTime: now - 120e3, endTime: now } });
      const c = await (await fetchImpl(HYPER, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json();
      const last = Array.isArray(c) && c.length ? +c[c.length - 1].c : 0;
      if (last > 0) out['hyperliquid|' + coin] = last;
    } catch (e) { /* sin precio esta vuelta */ }
  }
  return out;
}

// Actualiza el registro { [positionId]: { hi, lo, n, at } } con el precio de esta vuelta y borra lo viejo.
export function trackExcursions(exc, positions, prices, nowMs) {
  for (const p of positions) {
    const px = prices[p.provider + '|' + p.coin];
    if (!(px > 0)) continue;
    const e = exc[p.id];
    exc[p.id] = e ? { hi: Math.max(e.hi, px), lo: Math.min(e.lo, px), n: e.n + 1, at: nowMs } : { hi: px, lo: px, n: 1, at: nowMs };
  }
  for (const id of Object.keys(exc)) if (nowMs - (exc[id].at || 0) > KEEP_MS) delete exc[id];
  return exc;
}

// Mejor y peor precio de una posicion cerrada: las muestras mas su propia entrada y salida.
// Sin muestras devuelve null (no se sabe), para no confundirlo con "no dejo nada".
export function excursionOf(p, e) {
  if (!e || !(e.n > 0)) return null;
  const entry = +p.entry_price, exit = +p.exit_price;
  const hi = Math.max(e.hi, entry, exit || entry), lo = Math.min(e.lo, entry, exit || entry);
  return p.side === 'short' ? { best_price: lo, worst_price: hi, exc_samples: e.n } : { best_price: hi, worst_price: lo, exc_samples: e.n };
}
