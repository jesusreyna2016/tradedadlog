// Cron del vigilante en vivo de Mi Mesa (MyFundedPerps): cada minuto.
// La logica esta en _live.mjs.
import { runLive } from './_live.mjs';

export const config = { schedule: '* * * * *' };

export default async () => {
  let r;
  try { r = await runLive(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
};
