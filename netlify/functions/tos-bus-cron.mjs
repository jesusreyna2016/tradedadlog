// Cron del bus Trader OS: cada 15 min (1) espeja los blobs del store 'tos' (estado
// crudo + eventos) al repo git trader-os-bus, y (2) la lente Contexto compone
// live/market.json leyendo ese crudo. El orden importa: snapshot escribe el crudo,
// market lo lee del bus. La logica vive en tos-bus-snapshot.mjs y tos-market.mjs.
import { runSnapshot } from './tos-bus-snapshot.mjs';
import { runMarket } from './tos-market.mjs';
import { runCoach } from './tos-coach.mjs';
import { runEdge } from './tos-edge.mjs';
import { getStore } from '@netlify/blobs';
import { ghBatchStart, ghBatchCommit, ghBatchAbort } from './_gh-bus.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  // Netlify a veces dispara el mismo cron dos veces seguidas (visto 2026-11-27 22:45 CT): la segunda se salta
  try {
    const store = getStore('tos');
    const last = await store.get('cron:lastPass', { type: 'json' });
    if (last && Date.now() - last.t < 5 * 60 * 1000) {
      return new Response(JSON.stringify({ skipped: 'pasada repetida', lastAt: new Date(last.t).toISOString() }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    await store.setJSON('cron:lastPass', { t: Date.now() });
  } catch (e) { /* si el guardia falla, se corre igual */ }
  // todas las escrituras de esta pasada van en UN commit (ver _gh-bus.mjs, modo lote)
  ghBatchStart('jesusreyna2016', 'trader-os-bus', 'main');
  let commit;
  try {
    return await pass();
  } finally {
    try { commit = await ghBatchCommit({ message: `tos: snapshot ${new Date().toISOString()}`, token: process.env.TOS_BUS_TOKEN }); }
    catch (e) { console.error('tos-bus-cron commit', e); ghBatchAbort(); }
  }
};

async function pass() {
  const snapshot = await runSnapshot();
  let market = { skipped: 'snapshot fallo' };
  if (snapshot.ok !== false) {
    try { market = await runMarket(); } catch (e) { market = { ok: false, error: String(e) }; }
  }
  // El Coach lee MFP (API externa); aislado para que un fallo suyo no rompa el bus
  let coach;
  try { coach = await runCoach(); } catch (e) { coach = { ok: false, error: String(e) }; }
  // Lente Edge: lee scalp-cc-bus (solo lectura) + eventos tdl_rev; aislada igual
  let edge;
  try { edge = await runEdge(); } catch (e) { edge = { ok: false, error: String(e) }; }
  const ok = snapshot.ok !== false;
  return new Response(JSON.stringify({ snapshot, market, coach, edge }), {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' }
  });
}
