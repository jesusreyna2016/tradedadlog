// Cron del bus Trader OS: cada 15 min (1) espeja los blobs del store 'tos' (estado
// crudo + eventos) al repo git trader-os-bus, y (2) la lente Contexto compone
// live/market.json leyendo ese crudo. El orden importa: snapshot escribe el crudo,
// market lo lee del bus. La logica vive en tos-bus-snapshot.mjs y tos-market.mjs.
import { runSnapshot } from './tos-bus-snapshot.mjs';
import { runMarket } from './tos-market.mjs';
import { runCoach } from './tos-coach.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const snapshot = await runSnapshot();
  let market = { skipped: 'snapshot fallo' };
  if (snapshot.ok !== false) {
    try { market = await runMarket(); } catch (e) { market = { ok: false, error: String(e) }; }
  }
  // El Coach lee MFP (API externa); aislado para que un fallo suyo no rompa el bus
  let coach;
  try { coach = await runCoach(); } catch (e) { coach = { ok: false, error: String(e) }; }
  const ok = snapshot.ok !== false;
  return new Response(JSON.stringify({ snapshot, market, coach }), {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' }
  });
};
