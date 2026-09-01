// Recibe los webhooks del parche STATE EXPORT de "TDL · Scalp CC" (prefijo SCC1|).
// Dos tipos de evento: evt=signal (al disparo) y evt=outcome (al resolverse).
// Guarda cada evento con clave UNICA e inmutable (sin read-modify-write, sin
// carrera entre los 9 graficos que postean en el cierre de vela):
//   scalp store, key  ev/<YYYY-MM-DD>/<sigId>__<evt>
//   scalp store, key  last                          (puntero de depuracion)
// El cron scalp-bus-cron.mjs enumera esas claves y espeja a signals/ y outcomes/
// del repo git scalp-cc-bus.
import { getStore } from '@netlify/blobs';

function parsePipe(text) {
  if (!text) return null;
  const parts = String(text).trim().split('|');
  if (parts.length < 2) return null;
  const kv = {};
  for (let i = 1; i < parts.length; i++) {
    const idx = parts[i].indexOf('=');
    if (idx > 0) kv[parts[i].slice(0, idx).trim()] = parts[i].slice(idx + 1).trim();
  }
  return { prefix: parts[0].trim(), kv };
}

const safeKey = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.SCALP_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if (!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  const body = await req.text();
  const parsed = parsePipe(body);
  if (!parsed || parsed.prefix !== 'SCC1') {
    return new Response('bad payload (esperaba SCC1|k=v|...)', { status: 400 });
  }

  const { kv } = parsed;
  const evt = (kv.evt || 'signal').toLowerCase();
  const sym = (kv.sym || 'NQ').toUpperCase();
  const tf = kv.tf || '?';
  const sigId = kv.sigId || `${sym}-${tf}-${Date.now()}`;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);

  const record = {
    evt, sym, tf, sigId,
    ver: kv.ver || null,
    ts: kv.ts || null,
    raw: kv,
    receivedAt: now.toISOString(),
  };

  const store = getStore('scalp');
  await store.setJSON(`ev/${day}/${safeKey(sigId)}__${evt}`, record);
  await store.setJSON('last', record);

  return new Response(`ok · ${evt} · ${sym} ${tf} · ${sigId}`, { status: 200 });
};
