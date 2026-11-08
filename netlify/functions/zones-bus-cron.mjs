// Cron del agente de aprendizaje de zonas: cada 30 min copia eventos y trades al bus (ver zones-bus-snapshot.mjs).
import { runZonesSnapshot } from './zones-bus-snapshot.mjs';

export const config = { schedule: '7,37 * * * *' };

export default async () => new Response(JSON.stringify(await runZonesSnapshot()), { headers: { 'content-type': 'application/json' } });
