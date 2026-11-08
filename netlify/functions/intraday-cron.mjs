// Cron del Plan Intradia: cada 15 min recalcula las zonas de entrada de NQ, ES, GC,
// ETH y BTC y las publica en Blobs + bus (live/intraday.json). La logica esta en
// intraday-plan.mjs (runIntraday) para que /api/intraday-plan?fresh=1 sirva de prueba.
import { runIntraday } from './intraday-plan.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const r = await runIntraday();
  delete r.plan;
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
};
