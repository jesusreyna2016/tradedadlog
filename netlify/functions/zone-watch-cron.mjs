// Cron of zone-watch: every 15 min refreshes live/zone-status.json in the
// session-analyst-bus repo. Logic in zone-watch.mjs (runZoneWatch); that file's
// HTTP entry stays a dry run for manual checks.
import { runZoneWatch } from './zone-watch.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  let r;
  try { r = await runZoneWatch(); }
  catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  console.log('zone-watch', JSON.stringify(r));
  return new Response(JSON.stringify(r), {
    status: r.ok ? 200 : 502,
    headers: { 'content-type': 'application/json' }
  });
};
