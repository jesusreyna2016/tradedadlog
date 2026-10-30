// Cron del vigilante de shock: cada 10 min. La logica esta en cc-shock.mjs (runShock).
import { runShock } from './cc-shock.mjs';

export const config = { schedule: '*/10 * * * *' };

export default async () => {
  const r = await runShock();
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
};
