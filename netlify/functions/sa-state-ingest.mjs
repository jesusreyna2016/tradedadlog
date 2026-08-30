// Recibe actualizaciones del historial/aprendizaje del Session Analyst (POST JSON
// con ?key=). Escribe solo los campos presentes. Claves en Blobs (store 'cc'):
//   sa:instructions        · metodo del agente (md)
//   sa:narrative           · tesis multi-dia (md)
//   sa:model:NQ|ES|GC      · conocimiento por instrumento (md)
//   sa:zones               · playbook de zonas (objeto)
//   sa:scorecard           · precision rodante (objeto)
//   sa:review:<fecha>      · scorecard del dia (md)
//   sa:day:<fecha>         · tesis del dia (md)
// El plan de sesion sigue entrando por /api/session-plan-ingest.
import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.CC_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if (!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  let b;
  try { b = JSON.parse(await req.text()); }
  catch (e) { return new Response('bad JSON', { status: 400 }); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return new Response('bad body', { status: 400 });

  const store = getStore('cc');
  const now = new Date().toISOString();
  const wrote = [];
  const putText = async (k, v) => { await store.setJSON(k, { content: String(v), updatedAt: now }); wrote.push(k); };

  if (typeof b.instructions === 'string') await putText('sa:instructions', b.instructions);
  if (typeof b.narrative === 'string') await putText('sa:narrative', b.narrative);

  if (b.models && typeof b.models === 'object') {
    for (const s of ['NQ', 'ES', 'GC']) {
      if (typeof b.models[s] === 'string') await putText('sa:model:' + s, b.models[s]);
    }
  }
  if (b.zones && typeof b.zones === 'object') { await store.setJSON('sa:zones', b.zones); wrote.push('sa:zones'); }
  if (b.scorecard && typeof b.scorecard === 'object') { await store.setJSON('sa:scorecard', b.scorecard); wrote.push('sa:scorecard'); }

  if (b.review && b.review.date && typeof b.review.md === 'string') {
    await putText('sa:review:' + String(b.review.date).slice(0, 10), b.review.md);
  }
  if (b.dayThesis && b.dayThesis.date && typeof b.dayThesis.md === 'string') {
    await putText('sa:day:' + String(b.dayThesis.date).slice(0, 10), b.dayThesis.md);
  }

  if (!wrote.length) return new Response('nada que escribir (campos vacios o mal formados)', { status: 400 });
  return new Response('ok · ' + wrote.join(', '), { status: 200 });
};
