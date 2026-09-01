// Cron del bus de Scalp CC: cada 10 min espeja los logs de eventos de Netlify
// Blobs al repo scalp-cc-bus. La logica esta en scalp-bus-snapshot.mjs
// (runSnapshot); aqui solo va el schedule.
import { runSnapshot } from './scalp-bus-snapshot.mjs';

export const config = { schedule: '*/10 * * * *' };

export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
