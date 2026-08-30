// Recibe el plan de sesion generado por el agente local (POST JSON con ?key=).
// Guarda 'sa:plan:latest' (lo lee el Command Center via /api/session-plan) y
// una copia versionada 'sa:plan:<fecha>:<sesion>' para el historial/calificacion.
import { getStore } from '@netlify/blobs';

export default async (req) => {
  if(req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.CC_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if(!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  let plan;
  try { plan = JSON.parse(await req.text()); }
  catch (e) { return new Response('bad JSON', { status: 400 }); }
  if(!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return new Response('bad plan (esperaba objeto JSON)', { status: 400 });
  }

  plan.receivedAt = new Date().toISOString();
  const date = String(plan.date || new Date().toISOString().slice(0,10)).slice(0,10);
  const session = String(plan.session || 'run').toLowerCase().replace(/[^a-z0-9_-]/g, '');

  const store = getStore('cc');
  await store.setJSON('sa:plan:latest', plan);
  await store.setJSON(`sa:plan:${date}:${session}`, plan);
  return new Response(`ok · plan ${date} · ${session}`, { status: 200 });
};
