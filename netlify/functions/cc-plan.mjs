// Devuelve el ultimo plan guardado por cc-ingest, en JSON, para el Command Center.
import { getStore } from '@netlify/blobs';

export default async () => {
  let plan = {};
  try {
    const store = getStore('cc');
    plan = (await store.get('latest', { type: 'json' })) || {};
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
