// Cron: every 15 min log the Command Center v2 decision-card answer for NQ / ETH / BTC.
// The logic lives in _cc-decision.mjs; /api/cc-decisions reads and grades the log.
import { runDecisionLog } from './_cc-decision.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  const r = await runDecisionLog();
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
};
