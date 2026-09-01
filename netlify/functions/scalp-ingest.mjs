// Recibe los webhooks del parche STATE EXPORT de "TDL · Scalp CC" (prefijo SCC1|).
// Dos tipos de evento: evt=signal (al disparo) y evt=outcome (al resolverse).
// Guarda:
//   - ultimo evento por señal:      scalp store, key  evt:<sym>:<tf>:<sigId>:<evt>
//   - log diario append (JSONL):    scalp store, key  log:<YYYY-MM-DD>
//   - puntero al ultimo recibido:    scalp store, key  last
// El cron scalp-bus-cron.mjs (F3) espeja el log diario al repo git scalp-cc-bus.
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
  await store.setJSON(`evt:${sym}:${tf}:${sigId}:${evt}`, record);
  await store.setJSON('last', record);

  // append al log diario (JSONL). Carga baja: ~1 evento por cierre de vela por grafico.
  const logKey = `log:${day}`;
  const prev = (await store.get(logKey)) || '';
  await store.set(logKey, prev + JSON.stringify(record) + '\n');

  return new Response(`ok · ${evt} · ${sym} ${tf} · ${sigId}`, { status: 200 });
};
