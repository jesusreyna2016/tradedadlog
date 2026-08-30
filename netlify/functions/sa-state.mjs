// Estado completo del Session Analyst para el agente en la nube (y el Command
// Center). Una sola llamada devuelve metodo + historial + ultimos planes.
import { getStore } from '@netlify/blobs';

const tailByKey = (keys, prefix, n) =>
  keys.filter(k => k.startsWith(prefix)).sort().slice(-n);

export default async () => {
  const store = getStore('cc');
  const out = {
    instructions: null,
    narrative: null,
    models: { NQ: null, ES: null, GC: null },
    zones: {},
    scorecard: {},
    reviews: {},
    dayThesis: {},
    plans: {},
    planLatest: null,
    generatedAt: new Date().toISOString()
  };

  const txt = async (k) => {
    try { const v = await store.get(k, { type: 'json' }); return v && v.content != null ? v.content : null; }
    catch (e) { return null; }
  };
  const obj = async (k) => {
    try { return (await store.get(k, { type: 'json' })) || null; } catch (e) { return null; }
  };

  out.instructions = await txt('sa:instructions');
  out.narrative = await txt('sa:narrative');
  for (const s of ['NQ', 'ES', 'GC']) out.models[s] = await txt('sa:model:' + s);
  out.zones = (await obj('sa:zones')) || {};
  out.scorecard = (await obj('sa:scorecard')) || {};
  out.planLatest = await obj('sa:plan:latest');

  let keys = [];
  try {
    const { blobs } = await store.list({ prefix: 'sa:' });
    keys = (blobs || []).map(x => x.key);
  } catch (e) { /* list no disponible */ }

  for (const k of tailByKey(keys, 'sa:review:', 7)) out.reviews[k.slice('sa:review:'.length)] = await txt(k);
  for (const k of tailByKey(keys, 'sa:day:', 3)) out.dayThesis[k.slice('sa:day:'.length)] = await txt(k);
  for (const k of keys.filter(k => k.startsWith('sa:plan:') && k !== 'sa:plan:latest').sort().slice(-8)) {
    out.plans[k.slice('sa:plan:'.length)] = await obj(k);
  }

  return new Response(JSON.stringify(out), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
};
