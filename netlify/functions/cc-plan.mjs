// Devuelve el ultimo plan guardado por cc-ingest, en JSON, para el Command Center.
//   GET /api/cc-plan            -> plan de NQ ('latest', como siempre)
//   GET /api/cc-plan?sym=ETHUSDT -> plan de ese simbolo ('sym:<SYM>')
import { getStore } from '@netlify/blobs';

export default async (req) => {
  let plan = {};
  try {
    const store = getStore('cc');
    const sym = (new URL(req.url).searchParams.get('sym') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    plan = (await store.get(sym && sym !== 'NQ' ? 'sym:' + sym : 'latest', { type: 'json' })) || {};
  } catch (e) {
    plan = {};
  }
  return new Response(JSON.stringify(plan), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
};
