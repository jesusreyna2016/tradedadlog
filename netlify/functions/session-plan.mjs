// Devuelve el ultimo plan de sesion para que el Command Center lo pinte.
// Fuente primaria: el bus GitHub (plans/latest.json), que es donde escribe la
// rutina cloud. Fallback: el Blob sa:plan:latest (por si se uso session-plan-ingest
// a mano o el bus no responde).
import { getStore } from '@netlify/blobs';
import { busGet } from './_sa-bus.mjs';

export default async () => {
  let plan = null;
  let source = null;

  try {
    const f = await busGet('plans/latest.json');
    if (f && f.content) { plan = JSON.parse(f.content); source = 'bus'; }
  } catch (e) { /* sigue al fallback */ }

  if (!plan) {
    try {
      const store = getStore('cc');
      plan = (await store.get('sa:plan:latest', { type: 'json' })) || null;
      if (plan) source = 'blob';
    } catch (e) { /* nada */ }
  }

  return new Response(JSON.stringify(plan || {}), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'x-sa-source': source || 'none'
    }
  });
};
