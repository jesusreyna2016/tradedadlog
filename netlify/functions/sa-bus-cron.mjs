// Cron del bus: cada 5 min empuja live/market.json al repo session-analyst-bus.
// La logica esta en sa-bus-snapshot.mjs (runSnapshot); aqui solo va el schedule
// para que la funcion de snapshot siga siendo invocable por HTTP para pruebas.
import { runSnapshot } from './sa-bus-snapshot.mjs';

export const config = { schedule: '*/5 * * * *' };

export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};
