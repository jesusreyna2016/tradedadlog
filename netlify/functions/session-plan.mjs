// Devuelve el ultimo plan de sesion guardado por session-plan-ingest, en JSON,
// para que el Command Center lo pinte.
import { getStore } from '@netlify/blobs';

export default async () => {
  let plan = {};
  try {
    const store = getStore('cc');
    plan = (await store.get('sa:plan:latest', { type: 'json' })) || {};
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
