// Alertas push de Mi Mesa.
//   GET    /api/push-subscribe              -> { publicKey } (clave VAPID publica)
//   POST   /api/push-subscribe              -> guarda la suscripcion + preferencias (solo el dueño)
//          body: { subscription, prefs: { syms, minGrade, near, lang } }
//   POST   /api/push-subscribe?test=1       -> igual, y manda una notificacion de prueba
//   DELETE /api/push-subscribe              -> body { endpoint }: borra la suscripcion
// Autenticacion: header Authorization: Bearer <access token de Supabase> del dueño.
import { getStore } from '@netlify/blobs';
import { getVapid, ownerFromToken, subId, sendTo, testMessage } from './_push.mjs';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'content-type': 'application/json',
  'cache-control': 'no-store'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: cors });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  if (req.method === 'GET') {
    const v = await getVapid();
    return json({ publicKey: v.publicKey });
  }
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const email = await ownerFromToken(token);
  if (!email) return json({ error: 'unauthorized' }, 401);

  let body = {};
  try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
  const store = getStore('push');

  if (req.method === 'DELETE') {
    if (!body.endpoint) return json({ error: 'endpoint requerido' }, 400);
    await store.delete(subId(body.endpoint));
    return json({ ok: true });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const sub = body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: 'subscription invalida' }, 400);
  const p = body.prefs || {};
  const prefs = {
    syms: Array.isArray(p.syms) ? p.syms.filter((x) => ['NQ', 'ES', 'GC', 'ETH', 'BTC'].includes(x)) : ['NQ', 'ES', 'GC', 'ETH', 'BTC'],
    minGrade: p.minGrade === 'A+' ? 'A+' : 'A',
    near: p.near !== false,
    lang: p.lang === 'en' ? 'en' : 'es'
  };
  const key = subId(sub.endpoint);
  const rec = { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs, savedAt: new Date().toISOString() };
  await store.setJSON(key, rec);

  let test = null;
  if (new URL(req.url).searchParams.get('test') === '1') test = await sendTo({ key, ...rec }, testMessage(prefs.lang));
  return json({ ok: true, prefs, test });
};
