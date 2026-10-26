// Inventory of every symbol the ingests have stored, whatever the readers show.
//   GET /api/cc-symbols -> { symbols: { <SYM>: { <src>: { receivedAt, ver } } }, generatedAt }
// The readers (session-feed, cc-regime, cc-trend, Command Center) only list a fixed set of
// symbols, so a new alert (e.g. ETHUSDT / BTCUSDT) can be landing without showing anywhere.
import { getStore } from '@netlify/blobs';

const HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store'
};

export default async () => {
  const store = getStore('cc');
  const symbols = {};
  const add = (sym, src, rec) => {
    (symbols[sym] = symbols[sym] || {})[src] = {
      receivedAt: rec && (rec.receivedAt || rec.updatedAt) || null,
      ver: rec && (rec.ver || (rec.raw && rec.raw.ver)) || null
    };
  };

  const [ind, orb] = await Promise.all([
    store.list({ prefix: 'ind:' }).catch(() => ({ blobs: [] })),
    store.list({ prefix: 'sym:' }).catch(() => ({ blobs: [] }))
  ]);

  await Promise.all([
    ...ind.blobs.map(async ({ key }) => {
      const [, src, sym] = key.split(':');
      if (!src || !sym) return;
      try { add(sym, src, await store.get(key, { type: 'json' })); } catch (e) { add(sym, src, null); }
    }),
    ...orb.blobs.map(async ({ key }) => {
      const sym = key.slice(4);
      try { add(sym, 'orb', await store.get(key, { type: 'json' })); } catch (e) { add(sym, 'orb', null); }
    })
  ]);

  return new Response(JSON.stringify({ symbols, generatedAt: new Date().toISOString() }), { headers: HEADERS });
};
