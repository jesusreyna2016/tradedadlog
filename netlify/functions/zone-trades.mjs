// Mi Mesa -> agente de aprendizaje de zonas: resumen de tus trades SIN dinero (solo el dueño, con su sesion
// de Supabase). Lo usa el agente para cruzar las zonas con lo que de verdad operaste: si entraste en zona,
// que R sacaste contra lo que daba la zona, si seguiste el plan.
//   POST /api/zone-trades  { trades:[{id, day, fam, side, topen, tclose, entry, exit, R, session, hasPlan,
//                                     zoneId, zoneLo, zoneHi, zoneGrade, zoneManual, plannedR, planStop,
//                                     planTarget, setup, againstBias, followed, emotion}] }
// La whitelist (cleanTrade) descarta todo lo demas: pnl, comision, riesgo en $, cuenta, notas.
import { ownerFromToken } from './_push.mjs';
import { saveTrades } from './_zonelearn.mjs';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'content-type': 'application/json',
  'cache-control': 'no-store'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: cors });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await ownerFromToken(token))) return json({ error: 'unauthorized' }, 401);
  let body = null;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
  const list = Array.isArray(body?.trades) ? body.trades.slice(0, 2000) : [];
  try { return json({ ok: true, ...(await saveTrades(list)) }); }
  catch (e) { return json({ error: String(e.message || e) }, 500); }
};
