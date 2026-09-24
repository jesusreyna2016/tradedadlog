// Market Regime feed for the Command Center (and the journal cross-check).
//   GET /api/cc-regime                        -> latest state per symbol (ind:regime:<SYM>)
//   GET /api/cc-regime?log=YYYY-MM-DD&sym=NQ  -> that day's log of regime changes and events
// Written by ind-ingest from the RGM1 alert of market_regime.pine.
import { getStore } from '@netlify/blobs';

const SYMBOLS = ['NQ', 'ES', 'GC', 'YM', 'CL'];
const HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store'
};

export default async (req) => {
  const url = new URL(req.url);
  const store = getStore('cc');
  const day = url.searchParams.get('log');

  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return new Response('bad date', { status: 400 });
    const sym = (url.searchParams.get('sym') || 'NQ').toUpperCase();
    let log = [];
    try { log = (await store.get(`rlog:${sym}:${day}`, { type: 'json' })) || []; } catch (e) { log = []; }
    return new Response(JSON.stringify({ sym, day, log }), { headers: HEADERS });
  }

  const symbols = {};
  await Promise.all(SYMBOLS.map(async (sym) => {
    try {
      const rec = await store.get(`ind:regime:${sym}`, { type: 'json' });
      if (rec) symbols[sym] = { ...rec.raw, receivedAt: rec.receivedAt };
    } catch (e) { /* no regime feed for that symbol yet */ }
  }));
  return new Response(JSON.stringify({ symbols, generatedAt: new Date().toISOString() }), { headers: HEADERS });
};
